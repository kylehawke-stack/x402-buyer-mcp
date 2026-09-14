#!/usr/bin/env node
/**
 * A wallet for Claude.
 *
 * Claude cannot sign an on-chain payment — it holds no keys, and it never will.
 * So the wallet lives HERE, in a tool Claude calls. Claude decides what to buy;
 * this server signs and pays for it. That is not a workaround, it is the shape
 * agent payments actually take: the model reasons, a tool holds the money.
 *
 * What it does: calls a paid tool on an x402 server, gets the payment terms,
 * signs an EIP-3009 transferWithAuthorization for the quoted USDC, retries with
 * the payment attached, and hands back the data. No card, no account, no human.
 *
 * Two x402 transports, same money:
 *   mcp  (default) — specs/transports-v2/mcp.md. The unpaid call returns a tool
 *        result with isError and the PaymentRequired in structuredContent; the
 *        payment goes back in params._meta["x402/payment"]; the receipt comes in
 *        result._meta["x402/payment-response"]. If the seller instead answers
 *        HTTP 402 (older sellers), this falls back to headers automatically.
 *   http (via: "http") — plain POST to the seller's /api/x402/query: 402 with a
 *        PAYMENT-REQUIRED header, pay with PAYMENT-SIGNATURE, receipt in
 *        PAYMENT-RESPONSE.
 *
 * SPENDING LIMITS ARE NOT OPTIONAL. An LLM with a wallet will, sooner or later,
 * call the paid tool in a loop. MAX_SPEND_PER_CALL_USD and MAX_SPEND_TOTAL_USD
 * are enforced before anything is signed, and the session total is held in
 * memory so a restart is a deliberate act.
 *
 * Setup (Claude Desktop, claude_desktop_config.json):
 *   "locationlists": {
 *     "command": "node",
 *     "args": ["/absolute/path/to/server.mjs"],
 *     "env": { "X402_BUYER_KEY": "0x<private key>" }
 *   }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createPublicClient, http, formatUnits } from "viem"
import { base } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"

const SELLER_MCP = process.env.X402_SELLER_MCP || "https://locationlists.com/mcp"
const RPC = process.env.X402_RPC_URL || "https://mainnet.base.org"
const MAX_PER_CALL = Number(process.env.MAX_SPEND_PER_CALL_USD || "1.00")
const MAX_TOTAL = Number(process.env.MAX_SPEND_TOTAL_USD || "5.00")
// Whole-list purchases get their own budget. A $99 file can never fit a $1
// per-call cap, and raising that cap to $100 would also let a looping agent buy
// $100 of rows per call. One number bounds both a single file and a loop of them.
const MAX_FILES_TOTAL = Number(process.env.MAX_SPEND_FILES_TOTAL_USD || "100.00")

const key = process.env.X402_BUYER_KEY
if (!key) {
  console.error("X402_BUYER_KEY is not set. This server needs a funded Base wallet to pay with.")
  process.exit(1)
}
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`)
const chain = createPublicClient({ chain: base, transport: http(RPC) })

const ERC20_BALANCE = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
]

let spentThisSession = 0
let spentOnFiles = 0

/** The seller's plain-HTTP x402 endpoint, next to its MCP endpoint unless overridden. */
const SELLER_HTTP = process.env.X402_SELLER_HTTP || new URL("/api/x402/query", SELLER_MCP).href

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64")
function unb64(v) {
  if (!v) return null
  try {
    return JSON.parse(Buffer.from(v, "base64").toString("utf8"))
  } catch {
    return null
  }
}

async function readJson(res) {
  const raw = await res.text()
  try {
    return JSON.parse(raw)
  } catch {
    return { error: raw.slice(0, 500) }
  }
}

/**
 * One JSON-RPC call to the seller's MCP endpoint.
 *
 * transport "mcp": payment (a PaymentPayload object) rides in params._meta["x402/payment"].
 * transport "http": asks the seller for HTTP 402 (X-402-Transport: http) and sends
 * the payment base64 in PAYMENT-SIGNATURE, plus X-PAYMENT for sellers that predate v2.
 */
async function sellerCall(name, args, { payment, transport = "mcp" } = {}) {
  const http = transport === "http"
  const res = await fetch(SELLER_MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      // Sellers treat a request without MCP-Protocol-Version as a raw (legacy)
      // caller and answer HTTP 402; send it so the MCP transport path is used.
      ...(http ? { "X-402-Transport": "http" } : { "MCP-Protocol-Version": "2025-06-18" }),
      ...(http && payment ? { "PAYMENT-SIGNATURE": b64(payment), "X-PAYMENT": b64(payment) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, ...(!http && payment ? { _meta: { "x402/payment": payment } } : {}) },
    }),
  })
  return { status: res.status, headers: res.headers, body: await readJson(res) }
}

/** POST to the seller's plain-HTTP x402 endpoint. */
async function httpQuery(args, payment) {
  const res = await fetch(SELLER_HTTP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(payment ? { "PAYMENT-SIGNATURE": b64(payment) } : {}),
    },
    body: JSON.stringify(args),
  })
  return { status: res.status, headers: res.headers, body: await readJson(res) }
}

/**
 * The PaymentRequired in a seller response, whichever transport carried it, or
 * null when the response is not a payment demand. Prefers structuredContent,
 * then content[0].text (spec order), then an HTTP 402's PAYMENT-REQUIRED header,
 * then its body.
 */
function paymentRequiredOf({ status, headers, body }) {
  const isPR = (o) => !!o && typeof o === "object" && o.x402Version != null && Array.isArray(o.accepts) && o.accepts.length > 0
  const r = body?.result
  if (r?.isError) {
    if (isPR(r.structuredContent)) return r.structuredContent
    try {
      const j = JSON.parse(r.content?.[0]?.text ?? "")
      if (isPR(j)) return j
    } catch {}
  }
  if (status === 402) {
    const h = unb64(headers.get("payment-required"))
    if (isPR(h)) return h
    if (isPR(body)) return body
  }
  return null
}

/**
 * Sign the quoted terms.
 *
 * `extra` carries the token's EIP-712 domain and MUST be used rather than
 * assumed: Base mainnet USDC is named "USD Coin" while Base Sepolia's is
 * "USDC", and signing over the wrong name produces a signature that recovers to
 * the wrong address — rejected only after the buyer thinks they have paid.
 */
async function signPayment(pr, terms) {
  const value = BigInt(terms.amount ?? terms.maxAmountRequired)
  const chainId = Number(String(terms.network).split(":")[1] ?? base.id)
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`

  const signature = await account.signTypedData({
    domain: { name: terms.extra.name, version: terms.extra.version, chainId, verifyingContract: terms.asset },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: account.address, to: terms.payTo, value, validAfter: 0n, validBefore, nonce },
  })

  // The PaymentPayload, as an object. Echoes `resource` and `extensions` from the
  // PaymentRequired as the spec asks: the Bazaar catalogs a seller only from a
  // settled payload that carries its `bazaar` extension.
  return {
    x402Version: 2,
    scheme: terms.scheme,
    network: terms.network,
    ...(pr.resource ? { resource: pr.resource } : {}),
    accepted: terms,
    ...(pr.extensions ? { extensions: pr.extensions } : {}),
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: terms.payTo,
        value: value.toString(),
        validAfter: "0",
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  }
}

async function usdcBalance(asset) {
  const raw = await chain.readContract({ address: asset, abi: ERC20_BALANCE, functionName: "balanceOf", args: [account.address] })
  return Number(formatUnits(raw, 6))
}

// Filter arguments are NOT hand-written here any more. The seller's own
// tools/list is the authority, fetched at startup, so a filter added on
// locationlists.com reaches Claude without a new release of this extension.
// A hand copy is exactly what hid the `where` filter on 2026-09-14: the server
// could filter on revenue, and this file still told Claude it could not.
const FALLBACK_FILTERS = {
  type: "object",
  properties: {
    dataset: { type: "string", description: "Dataset slug from find_location_lists" },
    state: { type: "string", description: "Two-letter state code" },
    city: { type: "string" },
    where: {
      type: "array",
      description: "Conditions on any column, e.g. [{field:'revenue_amt', op:'gt', value:2000000}]",
      items: { type: "object", properties: { field: { type: "string" }, op: { type: "string" }, value: {} }, required: ["field", "op"] },
    },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
  },
  required: ["dataset"],
}

/**
 * The seller's tools (tools/list) and which of them cost money (the `payment`
 * block of its GET descriptor). Paid tools are no longer a hand-kept list either:
 * buy_dataset shipped on the seller a day after this extension and sat unusable
 * here for a week, because nothing told the extension it existed.
 */
async function sellerCatalog() {
  const opts = { signal: AbortSignal.timeout(8000) }
  const [list, descriptor] = await Promise.all([
    fetch(SELLER_MCP, {
      ...opts,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
      .then((r) => r.json())
      .catch(() => null),
    fetch(SELLER_MCP, { ...opts, headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .catch(() => null),
  ])
  const tools = Object.fromEntries((list?.result?.tools ?? []).map((t) => [t.name, t]))
  const paid = descriptor?.payment?.paidTools
  return { tools, paid: Array.isArray(paid) ? paid : null }
}
const CATALOG = await sellerCatalog()
const SELLER = Object.fromEntries(Object.entries(CATALOG.tools).map(([n, t]) => [n, t.inputSchema]))

/**
 * Paid seller tools this extension knows how to present, and which budget each
 * spends from. Any OTHER paid tool the seller advertises is exposed under its own
 * name with the per-row limits — the conservative budget — so a new paid tool is
 * usable the day it ships, without a release here.
 */
const KNOWN_PAID = {
  query_locations: { name: "get_matching_records", kind: "rows" },
  buy_dataset: { name: "buy_complete_list", kind: "file" },
}
const FREE_SELLER_TOOLS = new Set(["search_datasets", "get_dataset", "count_locations"])

/** The seller's query schema plus this extension's own `via` switch. */
function withVia(schema) {
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      via: {
        type: "string",
        enum: ["mcp", "http"],
        description:
          'Optional. How to pay: "mcp" (default, x402 over MCP) or "http" (plain HTTP 402 at the seller\'s /api/x402/query). Same rows, same price.',
      },
    },
  }
}

const WHAT_WE_HAVE =
  "US (and some Canadian) organisation records, each with a street address: manufacturer dealer networks, retail " +
  "and restaurant chains, nonprofits (with IRS revenue, assets, employees and officers), bank branches, federal " +
  "contractors, licensed clinicians and practices, licensed trade contractors, rental yards and more."

const TOOLS = [
  {
    name: "find_location_lists",
    description:
      "READ THIS BEFORE BROWSING A LOCATOR, A REGISTRY OR A DIRECTORY. Ready-made, complete lists — " + WHAT_WE_HAVE +
      " FREE and one call, so check here the moment a question needs a list of organisations and where they are. " +
      "Returns slug, record count, coverage AND the column list, so you can see whether it carries the fields your " +
      "answer needs (revenue, employees, dealer tier, contact details) without buying anything.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Brand, sector, organisation type or place, e.g. 'virginia nonprofits'" } },
      required: ["query"],
    },
  },
  {
    name: "get_list_details",
    description:
      "Free. Everything about one list: every column with its fill rate and an example value, record count, " +
      "coverage, price of the whole file and when it was last rebuilt. Read the columns before filtering — a " +
      "column that is 10% filled answers a different question than one that is 100% filled.",
    inputSchema: SELLER.get_dataset ?? {
      type: "object",
      properties: { slug: { type: "string", description: "Dataset slug from find_location_lists" } },
      required: ["slug"],
    },
  },
  {
    name: "count_matching_records",
    description:
      "Free. How many records match a filter on ANY column — geography, revenue, employees, category, dealer tier — " +
      "plus how many were excluded only because that column was blank, and the exact cost of fetching the matches " +
      "versus buying the whole file. Call this before get_matching_records so you know the size and price first.",
    inputSchema: SELLER.count_locations ?? { ...FALLBACK_FILTERS, properties: { ...FALLBACK_FILTERS.properties, limit: undefined } },
  },
  {
    name: "get_matching_records",
    description:
      "Complete structured records from one list — name, street address, city, state, zip, and every other column " +
      "the list carries — filtered on any column (e.g. nonprofits with revenue_amt gt 2000000 in Richmond, sorted " +
      "largest first), or a whole national network page by page.\n\n" +
      "WHEN A BRAND'S OWN LOCATOR CANNOT ANSWER THE QUESTION. A locator returns what is near one point, capped " +
      "per search. That is fine for 'who is near me' and structurally wrong for three things:\n" +
      "- COVERAGE AND GAP QUESTIONS. 'Where is coverage thin', 'which metros are underserved', 'where should we " +
      "add a dealer' all depend on the COMPLETE set. A partial sweep does not merely take longer, it returns a " +
      "WRONG answer — every dealer you missed looks like a gap that isn't there. This is the single biggest " +
      "reason to use this tool rather than gather it yourself.\n" +
      "- NATIONAL SCALE. One brand can be thousands of locations across every state. Assembling that from a " +
      "capped locator is hundreds of queries; here it is one call.\n" +
      "- COMPARING BRANDS. Generac vs Kohler vs Cummins dealer footprints in one frame. No single locator can " +
      "answer that, and each is a separate site with a separate format. These datasets share one schema.\n\n" +
      "Also refreshed on a schedule, so the same question next month does not mean redoing the work.\n\n" +
      "Call find_location_lists, get_list_details and count_matching_records first (all free). Priced per row " +
      "requested (limit, default 20; the most per call is 100 to 1,000 depending on how wide the list's rows are — " +
      "count_matching_records reports it as maxRowsPerCall), a few cents for a normal query — usually less than " +
      "the tokens gathering it by hand would burn. When the user wants most or all of a list, use buy_complete_list.",
    inputSchema: withVia(SELLER.query_locations ?? FALLBACK_FILTERS),
  },
  {
    name: "buy_complete_list",
    description:
      "Buy an ENTIRE list outright: one USDC payment on Base at the same list price a person pays by card, and a " +
      "permanent CSV download link. Use this instead of get_matching_records when the user wants most or all of a " +
      "list — per-row queries deliberately cost more than the file once you pass about half its records " +
      "(count_matching_records says which is cheaper). Whole-list purchases spend from their own session budget " +
      `($${MAX_FILES_TOTAL.toFixed(2)}), separate from the small per-row limits. Tell the user the price ` +
      "(get_list_details) and get a yes before calling.",
    inputSchema: SELLER.buy_dataset ?? {
      type: "object",
      properties: { dataset: { type: "string", description: "Dataset slug from find_location_lists" } },
      required: ["dataset"],
    },
  },
  // Paid tools the seller advertises that this extension has no wrapper for.
  ...(CATALOG.paid ?? [])
    .filter((n) => !KNOWN_PAID[n] && !FREE_SELLER_TOOLS.has(n) && CATALOG.tools[n])
    .map((n) => ({
      name: n,
      description:
        `Paid, in USDC on Base, within this wallet's per-call ($${MAX_PER_CALL.toFixed(2)}) and session ` +
        `($${MAX_TOTAL.toFixed(2)}) limits. ${CATALOG.tools[n].description ?? ""}`,
      inputSchema: CATALOG.tools[n].inputSchema ?? { type: "object", properties: {} },
    })),
  {
    name: "check_wallet",
    description:
      "This agent's own USDC balance on Base, what it has spent this session, and its spending limits. Free.",
    inputSchema: { type: "object", properties: {} },
  },
]

/** Exposed tool name → the seller's paid tool and the budget it spends from. */
const PAID_ROUTES = Object.fromEntries([
  ...Object.entries(KNOWN_PAID).map(([seller, { name, kind }]) => [name, { seller, kind }]),
  ...TOOLS.filter((t) => CATALOG.tools[t.name] && (CATALOG.paid ?? []).includes(t.name) && !KNOWN_PAID[t.name]).map((t) => [
    t.name,
    { seller: t.name, kind: "rows" },
  ]),
])

/**
 * Check limits, sign, pay, and report. `pay(payment)` performs the paid request
 * on whichever transport and returns {ok, data, receipt, detail}.
 */
async function purchase(pr, pay, kind = "rows") {
  const terms = pr.accepts[0]
  const priceUsd = Number(BigInt(terms.amount ?? terms.maxAmountRequired)) / 1e6
  const text = (t) => ({ content: [{ type: "text", text: t }] })

  // Refuse before signing, never after.
  if (kind === "file") {
    if (spentOnFiles + priceUsd > MAX_FILES_TOTAL) {
      return text(
        `Refused: this list costs $${priceUsd.toFixed(2)}, and whole-list purchases this session are capped at ` +
          `$${MAX_FILES_TOTAL.toFixed(2)} (already spent $${spentOnFiles.toFixed(2)}). The user can raise ` +
          `MAX_SPEND_FILES_TOTAL_USD ("Maximum on whole lists per session") and restart Claude.`,
      )
    }
  } else {
    if (priceUsd > MAX_PER_CALL) {
      return text(`Refused: $${priceUsd.toFixed(2)} exceeds the $${MAX_PER_CALL.toFixed(2)} per-call limit. Ask for fewer rows.`)
    }
    if (spentThisSession + priceUsd > MAX_TOTAL) {
      return text(
        `Refused: this would take the session to $${(spentThisSession + priceUsd).toFixed(2)}, over the ` +
          `$${MAX_TOTAL.toFixed(2)} cap. Already spent $${spentThisSession.toFixed(2)}.`,
      )
    }
  }
  const balance = await usdcBalance(terms.asset)
  if (balance < priceUsd) {
    return text(`Refused: wallet holds $${balance.toFixed(2)} USDC, the query costs $${priceUsd.toFixed(2)}.`)
  }

  // Sign and pay.
  const payment = await signPayment(pr, terms)
  const r = await pay(payment)
  if (!r.ok) {
    return text(`Payment did not complete, and nothing was charged.\n${JSON.stringify(r.detail, null, 2)}`)
  }

  // The seller settles nothing when a query matched no rows, and then sends no
  // receipt. Everything else counts against the cap, receipt or not — erring
  // toward over-counting keeps the limit a limit.
  const charged = !!r.receipt || r.data?.returned !== 0
  if (charged) {
    if (kind === "file") spentOnFiles += priceUsd
    else spentThisSession += priceUsd
  }
  return text(
    JSON.stringify(
      {
        paid: charged ? `$${priceUsd.toFixed(2)} USDC on Base` : "$0.00 (nothing matched, nothing settled)",
        paidTo: terms.payTo,
        from: account.address,
        ...(r.receipt?.transaction ? { transaction: r.receipt.transaction } : {}),
        sessionSpend:
          kind === "file"
            ? `$${spentOnFiles.toFixed(2)} of $${MAX_FILES_TOTAL.toFixed(2)} on whole lists`
            : `$${spentThisSession.toFixed(2)} of $${MAX_TOTAL.toFixed(2)}`,
        ...r.data,
      },
      null,
      2,
    ),
  )
}

const server = new Server({ name: "locationlists-x402-buyer", version: "1.3.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  const text = (t) => ({ content: [{ type: "text", text: t }] })

  try {
    if (name === "check_wallet") {
      const bal = await usdcBalance("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
      return text(
        JSON.stringify(
          {
            wallet: account.address,
            network: "Base",
            usdc: bal.toFixed(2),
            spentThisSession: spentThisSession.toFixed(2),
            spentOnWholeLists: spentOnFiles.toFixed(2),
            limits: { perCall: MAX_PER_CALL, sessionTotal: MAX_TOTAL, wholeListsPerSession: MAX_FILES_TOTAL },
          },
          null,
          2,
        ),
      )
    }

    if (name === "find_location_lists") {
      const { body } = await sellerCall("search_datasets", { query: args.query, limit: 8 })
      return text(body?.result?.content?.[0]?.text ?? JSON.stringify(body))
    }

    // Free pass-throughs: same arguments, seller's answer verbatim.
    if (name === "get_list_details" || name === "count_matching_records") {
      const { body } = await sellerCall(name === "get_list_details" ? "get_dataset" : "count_locations", args)
      const r = body?.result
      return { content: [{ type: "text", text: r?.content?.[0]?.text ?? JSON.stringify(body) }], ...(r?.isError ? { isError: true } : {}) }
    }

    const route = PAID_ROUTES[name]
    if (route) {
      const { via, ...rest } = args
      const call = Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null))
      if (route.seller === "query_locations" && !call.limit) call.limit = 20

      // The plain HTTP endpoint exists only for row queries.
      if (via === "http" && route.seller === "query_locations") {
        // Plain HTTP x402: 402 + PAYMENT-REQUIRED, pay with PAYMENT-SIGNATURE.
        const quote = await httpQuery(call)
        const pr = paymentRequiredOf(quote)
        if (!pr) return text(JSON.stringify({ status: quote.status, response: quote.body }, null, 2))
        return purchase(pr, async (payment) => {
          const paid = await httpQuery(call, payment)
          if (paid.status !== 200) return { ok: false, detail: { status: paid.status, response: paid.body } }
          return { ok: true, data: paid.body, receipt: unb64(paid.headers.get("payment-response")) }
        })
      }

      // 1. Ask, unpaid, to learn the price. MCP transport first; a seller that
      //    answers with HTTP 402 instead is paid the HTTP way.
      const quote = await sellerCall(route.seller, call)
      const pr = paymentRequiredOf(quote)
      if (!pr) {
        // Not a payment demand — the seller is telling us something else, such
        // as "this dataset is too small to sell by the row, buy the file", or
        // that an argument is wrong. Nothing was charged.
        const r = quote.body?.result
        const msg = r?.content?.[0]?.text ?? JSON.stringify(quote.body, null, 2)
        return { content: [{ type: "text", text: msg }], ...(r?.isError ? { isError: true } : {}) }
      }
      const transport = quote.status === 402 ? "http" : "mcp"

      // 2-3. Limits, then sign and pay on the same transport the seller quoted on.
      return purchase(
        pr,
        async (payment) => {
          const paid = await sellerCall(route.seller, call, { payment, transport })
          const r = paid.body?.result
          if (paid.status !== 200 || !r || r.isError) {
            return { ok: false, detail: r?.structuredContent ?? r?.content?.[0]?.text ?? paid.body }
          }
          const receipt =
            r._meta?.["x402/payment-response"] ??
            unb64(paid.headers.get("payment-response")) ??
            unb64(paid.headers.get("x-payment-response"))
          let data
          try {
            data = JSON.parse(r.content[0].text)
          } catch {
            data = { result: r.content?.[0]?.text }
          }
          return { ok: true, data, receipt }
        },
        route.kind,
      )
    }

    return text(`Unknown tool: ${name}`)
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
