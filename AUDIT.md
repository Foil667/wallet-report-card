# Wallet Report Card — verification addendum (2026-09-28)

Static build: `index.html` + `styles.css` + `app.js`. No build step, no
dependencies, no wallet connection, no signing, no storage.

## What was verified with real data

**Scoring math (23 deterministic checks, all PASS)** — `wrc-scoring-test.mjs`
runs the app's own `computeReport` in a sandbox:
- Exact formula: 3-cycle wallet → score exactly 50, Active Flipper; formula
  parts hold 10.0 / 7d 30 / 30d 10 match hand computation.
- Cycle pairing: inbound opens a cycle, next outbound for the same
  contract+tokenId closes it; re-acquire after a sale opens a second cycle;
  duplicate inbound while open is ignored; orphan outbound is ignored.
- Self-transfers (W→W) are ignored in both directions.
- Label boundaries: 79 → Steady Holder, 80 → Diamond Hands, 100 → Diamond,
  quick flip → 0 Paper Hands.
- Guards: empty history → `no_history`; only a 5-day-old open hold →
  `insufficient_history` with `daysUntilEligible: 25`.
- Receipt is 6 lines, correct header/score formatting.

**Base (live, Base Blockscout)** — wallet
`0x72491ba4Ef67a46809C4E79126f4d2Ea2DdecE0A`:
`status: ok`, **score 0, Paper Hands**, 2 acquisition cycles, 2 distinct NFTs,
0 currently held, avg hold 3.5d, 7d flips 100%, 30d flips 100%. Longest hold:
Loopers #667 (`0x1649cd37f4748807b4882fc48765ba0b2affa94a`), 4.3 days, sold.
Score math hand-verified: round(50×3.5/365 + 0 + 0) = 0. ✓

**Ethereum (live, eth Blockscout)** — both
`0x6573682faee72a4a96e791ba262439f1df3a268d` and
`0x72491ba4Ef67a46809C4E79126f4d2Ea2DdecE0A` return honest `no_history`
(neither wallet has mainnet ERC-721 history). Scoring is chain-independent and
covered by the deterministic tests above.

**Robinhood Chain (live, public RPC)** — wallet
`0x6573682faee72a4a96e791ba262439f1df3a268d`, tail window (~280k blocks):
99 transfers assembled → 50 cycles → `status: ok`, **score 0, Paper Hands**
(avg hold 1h, 7d/30d flips 100%, 50 NFTs ever, 2 held now). Full-history scan
is the identical code path with more chunks; it was still running at
verification time (see limitations).

**DOM render (21 checks, all PASS)** — full report HTML renders: score stamp,
rating, metrics, formula bars with exact values, formula text, rating bands,
the "transfer feed cannot prove a sale" caveat, X-ready receipt, copy button,
source footer; XSS check: `Test <Collection>` renders escaped. All four states
render: ok / no_history / insufficient_history / source-error (incl.
HISTORY_TOO_LARGE copy).

**Static audit** — no `window.ethereum`/signing/requestAccounts code; no
localStorage/sessionStorage/cookies; all `innerHTML` interpolations of
user/chain strings go through `esc()` (only numbers and computed strings are
unescaped); external hosts are exactly `base.blockscout.com`,
`eth.blockscout.com`, `robinhoodchain.blockscout.com`,
`rpc.mainnet.chain.robinhood.com`. `node --check` clean.

## Fixes applied during verification

- `fetchJson` now retries transient failures (HTTP 429 / 5xx, network
  blips, timeouts): 3 attempts, 1s→8s backoff. 4xx still fails fast. This was
  needed because `base.blockscout.com`'s `token-transfers` endpoint 500s
  intermittently (~80% of requests during testing); without retries most Base
  scans would surface an honest-but-avoidable error.

## Known limitations (disclosed, not hidden)

- **Base Blockscout flakiness:** the endpoint 500s intermittently; the retry
  covers transient blips, but a sustained outage surfaces "Chain data is
  unavailable" with a retry button. No score is ever issued from partial data.
- **Robinhood full-history scans are slow:** the public RPC caps log queries
  at ~30k blocks, so a full history is thousands of chunked requests (~20+
  minutes for an old wallet). The UI shows per-batch progress and says so
  up front. Wallets with >1,000 transfers are refused a score
  (`HISTORY_TOO_LARGE`) rather than scored partially.
- **robinhoodchain.blockscout.com was unreachable** during verification
  (empty replies); the app falls back to the public RPC automatically and the
  report footer names the source actually used.
- **"Flip" is a proxy:** the first outbound transfer after acquisition is
  treated as the exit; gifts and plain wallet-to-wallet moves count as exits.
  The app states this caveat in the UI (e.g. the 0/100 Base score above is
  driven by wallet moves, including Loopers #667 leaving the wallet).
- **Shareability:** the X-ready receipt has a copy button; there is no
  localStorage persistence and no URL-encoded share state — each visit runs a
  fresh live scan. The README's demo-URL placeholder is filled in at deploy.

## Push readiness

Committed to `gh-pages` (commit hash in parent report). Not pushed — awaiting
the user's one-tap GitHub PAT. After push: open the Pages URL, run one real
scan per chain in a live browser, then promote.
