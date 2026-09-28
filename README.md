# Wallet Report Card

A read-only NFT wallet grading dashboard. Paste any public EVM wallet address,
pick a chain, and it scans the wallet's full ERC-721 transfer history, pairs
acquisitions to exits into holding cycles, and turns the result into one
inspectable score.

**Live demo:** (URL goes here after the GitHub Pages deploy)

## How the score works

- Every inbound ERC-721 transfer opens a holding cycle; the next outbound
  transfer for the same contract + token ID closes it. Self-transfers are
  ignored. NFTs still held count up to "now".
- `score = round(50 × min(avgHoldDays/365, 1) + 30 × (1 − 7d flip rate) + 20 × (1 − 30d flip rate))`
- Labels: **Diamond Hands** 80+ · **Steady Holder** 60–79 · **Active Flipper**
  35–59 · **Paper Hands** <35.
- A score is only issued when at least one acquisition has a known 30-day
  outcome (exited or observed for 30+ days); otherwise you get an "early read".

## Data sources

- **Base / Ethereum:** Blockscout v2 REST API
  (`/api/v2/addresses/<addr>/token-transfers?type=ERC-721`, paginated, 1,000-transfer cap).
- **Robinhood Chain:** Robinhood Blockscout first; if that fails, the public
  JSON-RPC endpoint (`https://rpc.mainnet.chain.robinhood.com`) with
  batched `eth_getLogs` Transfer-topic scans over the full history in
  ~28k-block chunks (the RPC caps each query at ~30k blocks), plus
  `eth_getBlockByNumber` for the timestamps of blocks containing the wallet's
  transfers. The footer of every report shows which source was actually used.

Wallets with more than 1,000 ERC-721 transfers are refused a score rather than
a partial one. Rows Blockscout mislabels under the ERC-721 filter (e.g. ERC-404
hybrids, which emit ERC-721-shaped Transfer events) are skipped — this is an
ERC-721 holding analysis.

## Honest caveats (also shown in the app)

- A transfer feed cannot prove a sale. "Flip" and "time to sell" use the first
  outbound transfer after acquisition as a transparent proxy; gifts and plain
  wallet moves can affect the result.
- Nothing connects, nothing is signed, nothing is stored. Each visit runs a
  fresh live fetch of public chain data.

## Tech

Pure static site — `index.html` + `styles.css` + `app.js`, no build step, no
dependencies. Deploy anywhere static (this repo is set up for GitHub Pages).

## Local dev

```sh
python3 -m http.server -d . 8080
# open http://localhost:8080
```
