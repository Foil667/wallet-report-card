# Wallet Report Card — verification addendum (2026-09-28)

Static build: `index.html` + `styles.css` + `app.js`. No build step, no
dependencies, no wallet connection, no signing, no storage.

## Flywheel pass — 2026-09-28 ~16:30 CDT (persistence + share + $RESCUE flywheel)

New files: `flywheel.js` (history/share/ledger/pro-grade/board/tiers),
`rescue-burn.js` + `rescue-burn.css` (copied from `~/workspace/shared/`).
Modified: `index.html` (new sections: history, Top Wallets, burn furnace;
script/link wiring), `app.js` (persistence + share + pro wiring),
`styles.css` (new components), `README.md`.

### What was verified with real data

**Full test suite: 54/54 PASS** (`/tmp/test-flywheel.mjs`, loads the real
site JS in a vm sandbox with a fake DOM):

- **History persistence (9 checks):** record → visits=2 keeps best=72;
  `no_history` doesn't clobber best; key case-insensitive; fresh-context
  "reload" with the same storage sees the entry; fresh device gets empty
  history and a seeded ledger.
- **Share state (7 checks):** `?address=&chain=` parse/build roundtrip;
  invalid address → null; invalid chain → defaults `base`; full URL includes
  origin; live end-to-end: after a real Base grade,
  `history.replaceState` wrote `?address=0x7249…&chain=base` and the
  clipboard-stub "Copy share link" produced the same URL.
- **Live Base grading:** wallet `0x72491ba4Ef67a46809C4E79126f4d2Ea2DdecE0A`
  graded end-to-end in-sandbox via `runScan()` — `report-shell` rendered,
  Paper Hands, history entry persisted with `bestScore: 0`.
  (Base Blockscout 500'd intermittently during testing; the app's retry
  surfaced the report on a later attempt, and sustained 500s produce the
  honest error panel — no partial scores, as before.)
- **Pro grade (demo fee):** charge deducts 1,000 demo → balance 19,000,
  burned +200, treasury +800, `proGradesRun` 1, tier → Analyst; tier
  progression verified to Oracle at 15; overdraft refused; demo furnace
  tally updated; pro metrics math verified on synthetic transfers
  (flows/counterparty/collection shares) and the rendered HTML escapes
  collection names (`Test <Collection>` → `Test &lt;Collection&gt;`).
- **Leaderboard:** 2 seeded demo entries; add valid / reject dup / reject
  bad address; grade + rank by score desc; remove works.
- **Burn degradation (bogus RPC):** pre-seeded cache → `ok:true,
  stale:true` with the real cached numbers; no cache → `ok:false` with no
  invented numbers; widget renders the stale state honestly.
- **Live burn read (real `mainnet.base.org`):** `getStatus()` → `ok:true,
  stale:false`, synced to block 51920234 in ~2s, `total: 0.00 $RESCUE`
  (the real onchain number — no burns yet), cached follow-up in 206ms.

### Fixes applied during this pass

- **Oracle tier was unreachable** (20,000-seed math: 15 pro grades cost
  15,000 — caught by the test, fixed by raising the demo seed from 10,000
  to 20,000).
- **Shared burn module hardened:** `mainnet.base.org` 413s / drops
  topic-filtered `eth_getLogs` wider than ~2k blocks (verified live:
  1,000 ok, 2,500 flaky, 5,000+ consistent 413). Added adaptive range
  halving (floor 400 blocks) + chunk 2,000 + 3 retries. The fix was mirrored
  back into `~/workspace/shared/rescue-burn.js` so other builds inherit it;
  the site copy and the shared copy are byte-identical. Before the fix, a
  fresh-device burn widget could only show "unavailable"; now it syncs live.
- **Base Blockscout flakiness** (see Known limitations) is unchanged.

### Static + layout checks

- `node --check` clean on `app.js`, `flywheel.js`, `rescue-burn.js`.
- All 6 assets serve 200 over a local `python3 -m http.server`.
- Narrow-layout review (no screenshots in sandbox): new sections use the
  same responsive pattern as the existing CSS — single-column under 760px,
  full-width buttons, `min-width: 320px` on root; the burn widget's own CSS
  collapses its two columns under 520px. No fixed-width or overflow-prone
  constructs added.

### Known limitations (disclosed, not hidden)

- History, demo ledger, and leaderboard live in `localStorage` — per device,
  per browser. No server, no sync.
- Demo $RESCUE is a client-side simulation, always badged DEMO; the only
  real onchain numbers on the page are the burn furnace figures.
- The burn furnace shows real zeros today ($RESCUE launched 2026-09-28; no
  burns to the dead address yet) — that is the live chain state, not a bug.
- Base Blockscout flakiness: the endpoint 500s intermittently; the retry
  covers transient blips, but a sustained outage surfaces "Chain data is
  unavailable" with a retry button. No score is ever issued from partial data.
- Robinhood full-history scans are slow (public RPC, ~28k-block chunks);
  wallets with >1,000 transfers are refused a score rather than scored
  partially.
- "Flip" is a proxy: the first outbound transfer after acquisition is
  treated as the exit; gifts and plain wallet moves count as exits.

## Push readiness

Committed to `gh-pages` (commit hash in parent report). Not pushed — no
remote configured and no stored credentials. After push: open the Pages URL,
grade one wallet, confirm history persists across reload, open a share link
in a fresh tab, run one demo pro grade, check the furnace syncs live.

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
