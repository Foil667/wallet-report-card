# Wallet Report Card

A read-only NFT wallet grading dashboard. Paste any public EVM wallet address,
pick a chain, and it scans the wallet's full ERC-721 transfer history, pairs
acquisitions to exits into holding cycles, and turns the result into one
inspectable score.

**Live demo:** https://foil667.github.io/wallet-report-card/

## History & share links

- Every completed grade is persisted in `localStorage` (`wrc-history-v1`):
  first seen, visit count, best score/rating, last status — max 50 entries.
- After each grade the URL becomes `?address=0x…&chain=base` (via
  `history.replaceState`); opening such a link pre-fills the form and
  auto-runs the grade. A "Copy share link" button copies the full URL.

## $RESCUE flywheel (all demo, all labeled)

No wallet connection, no signatures, no fund movement anywhere on this page.

- **Pro grade:** deeper metrics from the scan's own transfer feed — token
  flows (in/out/mints/self-moves), counterparty risk (unique counterparties,
  top-counterparty share), whale signals (collection concentration, velocity,
  wash-trade heuristics). Unlock costs **1,000 demo $RESCUE** from a simulated
  per-device balance (starts at 20,000 demo $RESCUE; covers all tiers).
  Split shown on every unlock: **200 burned (demo) · 800 to Foil's treasury
  (demo)**. Demo burn tallies live next to the real furnace, always badged
  `DEMO`.
- **Grader tiers:** Analyst (1+ pro grades) → Sleuth (5+) → Oracle (15+),
  shown as a rank pill under the scan button.
- **Top Wallets leaderboard:** community-submitted wallets (per-device
  `localStorage`, nothing uploaded), graded live on demand, ranked by score.
  Seeded with two demo entries, marked as such.
- **Burn furnace:** the shared `RescueBurn` module reads REAL onchain $RESCUE
  `Transfer`→dead-address events on Base via chunked `eth_getLogs`, with
  honest stale-cache degradation. Adaptive range-splitting was added because
  `mainnet.base.org` 413s/drops wide topic-filtered ranges; fresh sync now
  completes (verified live: block 51920234, 0.00 $RESCUE burned so far —
  the real number, not a placeholder).

## Honest caveats (also shown in the app)

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
- Nothing connects, nothing is signed. Each visit runs a fresh live fetch of
  public chain data — but completed grades now persist locally (see History &
  share links above) instead of vanishing on reload.

## Tech

Pure static site — `index.html` + `styles.css` + `app.js` + `flywheel.js`
(persistence, share state, pro grade, leaderboard, tiers) + the shared
`rescue-burn.js`/`rescue-burn.css` burn widget. No build step, no
dependencies. Deploy anywhere static (this repo is set up for GitHub Pages).

## Local dev

```sh
python3 -m http.server -d . 8080
# open http://localhost:8080
```
