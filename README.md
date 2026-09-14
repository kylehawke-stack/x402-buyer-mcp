# LocationLists — Agent Wallet

Give Claude a wallet, and it can buy business location data on its own. No card, no
account, no checkout page.

Claude cannot sign an on-chain payment — it holds no keys, and it never will. So the
wallet lives in a tool Claude calls. Claude decides what to buy; this extension holds
the money and signs for it. That is not a workaround; it is the shape agent payments
actually take.

## What happens

You ask Claude a question it needs data to answer. Claude finds the right list with
`find_location_lists`, reads its columns with `get_list_details`, sizes and prices the
answer with `count_matching_records` (all free), then calls `get_matching_records`.
Filters reach every column a list carries — revenue, employees, category, dealer tier —
not just geography, and the filter arguments are read from locationlists.com at startup,
so new ones arrive without reinstalling.

The extension asks locationlists.com for the records, gets back an **x402 payment
demand** with a price, signs a **USDC payment on Base**, retries with the payment
attached, and hands Claude the rows. By default this speaks the x402 MCP transport
(the demand is a tool result, the payment rides in `_meta["x402/payment"]`); a seller
that answers with HTTP 402 is paid through headers instead, and `via: "http"` buys
through the plain HTTP endpoint `POST /api/x402/query`. Same rows, same price, same
limits. The whole thing takes a few seconds and settles on a public
blockchain you can check afterwards.

Pricing is per row, derived from each dataset — a slice of a large file costs cents.
When the user wants most or all of a list, `buy_complete_list` buys the whole file at
its list price and returns a permanent CSV download link. Datasets under 5,000 records
are only sold that way.

Paid tools are read from the seller at startup too: if locationlists.com adds a new
paid tool, it appears here under its own name, spending from the per-row limits. Free
seller tools pass straight through the same way — `request_a_new_list` when the list
you need does not exist yet, `send_feedback`, `get_sample` — with no wallet involved.

## Install

1. Download `locationlists-buyer.mcpb` from
   [Releases](https://github.com/kylehawke-stack/x402-buyer-mcp/releases).
2. Double-click it. Claude Desktop installs it and asks for four things:
   - **Wallet private key** — stored in your OS keychain, never in a config file
   - **Maximum per purchase** (default $1.00) — row purchases
   - **Maximum per session** (default $5.00) — row purchases
   - **Maximum on complete lists per session** (default $100.00) — whole-file purchases; 0 turns them off
3. Restart Claude Desktop.

## Funding the wallet

**Use a dedicated wallet holding only what you are willing to let an AI spend.** Not
your main one.

You need **USDC on Base**. From Coinbase: Send → USDC → paste the wallet address →
**Network: Base** → confirm. Picking Ethereum, Arbitrum, Polygon or Optimism instead
will accept the address happily and put the money somewhere this cannot spend it.

You do **not** need ETH. x402 uses gasless [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)
transfers — the facilitator broadcasts the transaction and pays the gas.

$5 is plenty to try it.

## Spending limits are not optional

An LLM with a wallet will, sooner or later, call a paid tool in a loop. Three checks
run **before anything is signed**, and a refusal costs nothing:

- per-call cap (row purchases)
- per-session running total (row purchases), held in memory so a restart is a deliberate act
- a separate per-session budget for complete lists, so a $99 file never needs a $99 per-call cap
- on-chain balance check

Ask Claude `what's in your wallet?` at any point and it will tell you the balance,
the session spend, and the limits.

## Try it

> I sell backup generator installation in Colorado. Find me the Generac dealers
> there so I know who I'm competing against.

Claude will search the catalog, see the rows cost money, buy the ones it needs, and
answer with real dealers — names, addresses, phone numbers.

> Which nonprofits in Richmond, Virginia have more than $2M in revenue?

Claude counts first (249, plus 2,114 with no revenue on file), sees the three pages
cost under a dollar, and buys them largest first. The tool response names
the amount paid and both wallet addresses, so you can verify the transaction on
[Basescan](https://basescan.org).

## Configuration

Everything is set through Claude Desktop's UI at install time. For other MCP clients,
the server reads:

| Variable | Default | Meaning |
|---|---|---|
| `X402_BUYER_KEY` | — | **required.** Private key of the funded Base wallet |
| `MAX_SPEND_PER_CALL_USD` | `1.00` | refuse any single purchase above this |
| `MAX_SPEND_TOTAL_USD` | `5.00` | refuse once the session total would exceed this |
| `MAX_SPEND_FILES_TOTAL_USD` | `100.00` | budget for complete-list purchases per session; `0` disables them |
| `X402_SELLER_MCP` | `https://locationlists.com/mcp` | the x402 seller to buy from |
| `X402_SELLER_HTTP` | `<seller origin>/api/x402/query` | plain-HTTP x402 endpoint used by `via: "http"` |
| `X402_RPC_URL` | `https://mainnet.base.org` | Base RPC for balance reads |

## Run from source

```bash
git clone https://github.com/kylehawke-stack/x402-buyer-mcp
cd x402-buyer-mcp && npm install
X402_BUYER_KEY=0x... node server.mjs
```

Then point any MCP client at it over stdio.

## One thing worth being precise about

Claude did not pay for anything. Claude *decided* to buy, and a tool it was given
signed the payment. The decision is the novel part; the signature is ordinary
software. Anyone describing this should say so.

## Licence

MIT
