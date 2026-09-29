'use strict';
/* =====================================================================
 * LOOPER RESCUE — read-only stuck-asset scanner (Base chain)
 * ---------------------------------------------------------------------
 * SAFETY ARCHITECTURE (non-negotiable):
 * - This file is READ-ONLY. There is no code path that requests a
 *   wallet, an account, a signature, a private key, or a transaction.
 * - The scanned address comes from a plain text <input>, validated
 *   against /^0x[0-9a-fA-F]{40}$/ before any network call.
 * - No localStorage / sessionStorage / cookies. All state is in memory.
 * - Recovery is an allowlist of official external links only
 *   (target="_blank" rel="noopener"). This app never builds, signs,
 *   or submits any transaction.
 * - Outbound network is limited to: mainnet.base.org (Base RPC),
 *   ethereum.publicnode.com (L1 RPC, allowlisted), api.merkl.xyz,
 *   api.dexscreener.com, api.coinbase.com, base.blockscout.com
 *   (Blockscout v2 read-only REST API — token-transfer discovery).
 *   Nothing else is fetched.
 *
 * SCAN ARCHITECTURE (v2, 2026-09-28 — fixed the v1 hang):
 * - v1 scanned ~2M blocks with raw eth_getLogs in 2,000-block chunks:
 *   ~1,000 chunks for Transfer + ~1,000 each for TransferSingle and
 *   TransferBatch + ~1,000 for MessagePassed = ~4,000 heavy chunk
 *   requests, 20+ minutes of sustained network. Tabs died near
 *   completion (renderer retired at 853/1001 and 910/1001 chunks).
 * - v2 discovers token transfers via Blockscout's INDEXED
 *   /api/v2/addresses/{addr}/token-transfers endpoint (full history,
 *   paginated, ~1s for a normal wallet). Classification is unchanged:
 *   the same onchain balanceOf/decimals/supportsInterface/ownerOf
 *   checks run against the same discovered contracts — only the
 *   discovery source changed, from slow to indexed. Scope WIDENED, not
 *   narrowed (full history instead of last ~46 days).
 * - Bridge withdrawals still use raw eth_getLogs on the
 *   L2ToL1MessagePasser (address-filtered, 2,000-block chunks) because
 *   that path was verified onchain and its semantics are documented
 *   below. It is the only remaining chunked scan (~1,000 narrow
 *   chunks), with progress, cancel, and timeouts.
 * - Every network call has a timeout + retries with backoff; the whole
 *   scan has a cancel button and an overall timeout; sections render
 *   progressively as they complete instead of one big render at the end.
 * ===================================================================== */

/* ---------------------------------------------------------------------
 * SELECTOR / EVENT-HASH VERIFICATION (build time, 2026-09-28)
 * Computed locally with keccak256 (js-sha3) and cross-checked against
 * live Base chain data:
 * - 0x70a08231 balanceOf(address) ............ MATCH
 * - 0x313ce567 decimals() .................... MATCH
 * - 0x95d89b41 symbol() ...................... MATCH
 * - 0x6352211e ownerOf(uint256) ............... MATCH
 * - 0x00fdd58e balanceOf(address,uint256) ..... MATCH
 * - 0x01ffc9a7 supportsInterface(bytes4) ...... MATCH
 *   (spec draft listed 0x01ffc9d7 — that was a typo, corrected here)
 * - Bridge withdrawals: the spec draft assumed
 *   WithdrawalInitiated(address,address,address,address,uint256,bytes)
 *   (= 0x73d170910aba9e6d50b102db522b1dbcd796216f5128b445aa2135272886497e,
 *   computed as instructed) — but that event gets ZERO hits on the live
 *   Base L2ToL1MessagePasser. The contract actually emits
 *   MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)
 *   = 0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054
 *   (computed hash == topic0 observed onchain; 4 hits in 2,000 blocks).
 *   Layout: topics[1]=nonce, topics[2]=sender, topics[3]=target (all indexed);
 *   data = (value, gasLimit, bytes-offset, withdrawalHash, data...).
 *   HONESTY NOTE: this app does NOT check L1 finalization status. The
 *   "LIKELY STUCK" flag below is purely an age heuristic (>30 days old),
 *   not a finality verdict. Finalization must be verified/completed in the
 *   official bridge app (bridge.base.org).
 * ------------------------------------------------------------------- */

const BASE_RPC = 'https://mainnet.base.org';
const L1_RPC = 'https://ethereum.publicnode.com'; // allowlisted; intentionally unused — no L1 state is queried by design
const BASE_CHAIN_ID = 8453;
const BLOCKSCOUT_API = 'https://base.blockscout.com/api/v2';

const RESCUE_TOKEN = '0x8201132Bc218dbD81305Ff5605F44aE4804D4BA3';
const RESCUE_POOL_ID = '0x7d5e38d1a39566b688de2e126fbdfc93560abe20db8dd0447bf5a4386581ce0e';
const L2_TO_L1_PASSER = '0x4200000000000000000000000000000000000016';

// Function selectors (4 bytes, verified above)
const SEL_BALANCE_OF = '0x70a08231';        // balanceOf(address)
const SEL_DECIMALS = '0x313ce567';          // decimals()
const SEL_SYMBOL = '0x95d89b41';            // symbol()
const SEL_OWNER_OF = '0x6352211e';          // ownerOf(uint256)
const SEL_SUPPORTS_IFACE = '0x01ffc9a7';    // supportsInterface(bytes4)
const SEL_BALANCE_OF_1155 = '0x00fdd58e';   // balanceOf(address,uint256)

// Event topic0 hash (verified above)
const TOPIC_MESSAGE_PASSED = '0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054';

// ERC-165 interface id for the ERC-721 check
const IFACE_ERC721 = '0x80ac58cd';

// Curated Base ERC-20s checked directly via balanceOf (symbol/decimals known).
const CURATED_TOKENS = [
  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
  { address: '0x50c5725949A6F0c72E6C4a641F3187595fC917', symbol: 'DAI', decimals: 18 },
  { address: '0x2Ae3F1EC7D304cB47B4479C695df7Ac0e18Bef2', symbol: 'cbETH', decimals: 18 },
  { address: '0x4ed4E862860bed51a9570b96d89aF5E1fDeAa1', symbol: 'DEGEN', decimals: 18 },
  { address: '0x940181a94A35A4569E4529A3CDfB74e38FD9868c', symbol: 'AERO', decimals: 18 },
  { address: RESCUE_TOKEN, symbol: 'RESCUE', decimals: 18 }, // the project's own token
];

const MERKL_API = 'https://api.merkl.xyz/v4/users/{address}/rewards?chainId=8453';
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens/0x8201132Bc218dbD81305Ff5605F44aE4804D4BA3';
const COINBASE_ETH_USD = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';

// Scan tuning.
const SCAN_BLOCKS = 2000000;      // bridge-withdrawal depth (~46 days at ~2s/block)
const LOG_CHUNK = 2000;           // mainnet.base.org caps eth_getLogs at a 2,000-block range
const CONCURRENCY = 6;
const DUST_USD = 1.0;
const STUCK_DAYS = 30;
const FETCH_TIMEOUT_MS = 30000;   // per-request timeout
const FETCH_TRIES = 3;            // attempts per request (with backoff)
const SCAN_TIMEOUT_MS = 8 * 60 * 1000; // whole-scan ceiling -> honest timeout error
// Worst-case guards (burn address etc.): degrade honestly, never hang.
const DISCOVERY_PAGE_CAP = 20;    // Blockscout pages (50 transfers each)
const CLASSIFY_CONTRACT_CAP = 300;
const TOKEN_IDS_PER_CONTRACT_CAP = 500;

/* ============================ pure helpers ============================ */

function isValidAddress(s) {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function normAddr(a) {
  return a.toLowerCase();
}

// address -> 32-byte left-padded topic
function addrToTopic(addr) {
  return '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
}

// topic (32-byte hex) -> address (last 20 bytes)
function topicToAddr(topic) {
  return '0x' + topic.slice(-40).toLowerCase();
}

// uint256 -> 32-byte hex (no 0x)
function uintToHex(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

function encBalanceOf(addr) {
  return SEL_BALANCE_OF + addrToTopic(addr).slice(2);
}

function encBalanceOf1155(addr, id) {
  return SEL_BALANCE_OF_1155 + addrToTopic(addr).slice(2) + uintToHex(id);
}

function encOwnerOf(id) {
  return SEL_OWNER_OF + uintToHex(id);
}

function encSupportsInterface(ifaceId) {
  return SEL_SUPPORTS_IFACE + '0'.repeat(56) + ifaceId.slice(2).toLowerCase();
}
// decode first 32 bytes as uint256 -> BigInt, or null on empty/malformed
function decodeUint(data) {
  if (!data || data === '0x' || data.length < 66) return null;
  try {
    return BigInt('0x' + data.slice(2, 66));
  } catch (e) {
    return null;
  }
}

// decode ABI string OR legacy bytes32 string -> JS string, or null
function decodeString(data) {
  if (!data || data === '0x') return null;
  try {
    const hex = data.slice(2);
    if (hex.length === 64) {
      const bytes = [];
      for (let i = 0; i < 64; i += 2) {
        const b = parseInt(hex.slice(i, i + 2), 16);
        if (b === 0) break;
        bytes.push(b);
      }
      return new TextDecoder().decode(new Uint8Array(bytes)) || null;
    }
    if (hex.length < 128) return null;
    const len = parseInt(hex.slice(64, 128), 16);
    if (!Number.isSafeInteger(len) || len <= 0 || len > 200) return null;
    const strHex = hex.slice(128, 128 + len * 2);
    if (strHex.length !== len * 2) return null;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16);
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    return null;
  }
}

// BigInt token amount -> human string given decimals (trims trailing zeros)
function formatUnits(value, decimals) {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac.length > 6) frac = frac.slice(0, 6);
  const s = frac ? whole.toString() + '.' + frac : whole.toString();
  return (neg ? '-' : '') + s;
}

function formatUsd(n) {
  if (n == null || !isFinite(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortAddr(a) {
  return a.slice(0, 6) + '…' + a.slice(-4);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function abortError() {
  return new DOMException('scan cancelled', 'AbortError');
}

function checkAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/* ============================ network layer (read-only) ============================
 * Only JSON-RPC POSTs to mainnet.base.org (read-only methods: eth_chainId,
 * eth_blockNumber, eth_getBalance, eth_call, eth_getLogs)
 * and GETs to the allowlisted REST APIs. Every request has a timeout and
 * retries with backoff. Nothing here can write.
 */

async function fetchJson(url, { timeoutMs, tries, signal, method, body } = {}) {
  timeoutMs = timeoutMs == null ? FETCH_TIMEOUT_MS : timeoutMs;
  tries = tries == null ? FETCH_TRIES : tries;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    checkAborted(signal);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      const text = await res.text();
      if (!text) throw new Error('empty response');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (e && e.name === 'AbortError' && signal && signal.aborted) throw abortError();
      // Retry on 429 / 5xx / network failures / empty responses / timeouts.
      const s = e && e.status;
      const retryable = s === 429 || s === 0 || s == null || (s >= 500 && s < 600) || e.message === 'empty response';
      if (!retryable || i === tries - 1) throw e;
      await sleep(800 * (i + 1) + Math.random() * 500);
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

async function rpc(method, params, signal) {
  const body = await fetchJson(BASE_RPC, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (body.error) {
    const err = new Error('RPC error: ' + body.error.message);
    err.status = body.error.code;
    throw err;
  }
  return body.result;
}

function ethCall(to, data, block, signal) {
  return rpc('eth_call', [{ to, data }, block || 'latest'], signal);
}

function getBalance(addr, signal) {
  return rpc('eth_getBalance', [addr, 'latest'], signal);
}

function getBlockNumber(signal) {
  return rpc('eth_blockNumber', [], signal);
}

// Run tasks with at most `limit` concurrent workers. Aborts promptly when
// `signal` fires. Resolves to an array of {ok:true,value}/{ok:false,error}.
async function pool(tasks, limit, onProgress, signal) {
  const results = new Array(tasks.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < tasks.length) {
      checkAborted(signal);
      const idx = next++;
      try {
        results[idx] = { ok: true, value: await tasks[idx]() };
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        results[idx] = { ok: false, error: e };
      }
      done++;
      if (onProgress) onProgress(done, tasks.length);
      // Yield to the UI thread between tasks so the page stays responsive.
      await sleep(0);
    }
  }
  const n = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// Chunked eth_getLogs over [fromBlock, toBlock] (inclusive), chunk size LOG_CHUNK.
// Throws if any chunk fails (after retries) — the caller turns that into a
// "section unavailable" card, never a silent partial scan.
async function getLogsChunked(filterBase, fromBlock, toBlock, onProgress, signal) {
  const ranges = [];
  for (let s = fromBlock; s <= toBlock; s += LOG_CHUNK) {
    ranges.push([s, Math.min(s + LOG_CHUNK - 1, toBlock)]);
  }
  const tasks = ranges.map(([s, e]) => () =>
    rpc('eth_getLogs', [{
      address: filterBase.address,
      topics: filterBase.topics,
      fromBlock: '0x' + s.toString(16),
      toBlock: '0x' + e.toString(16),
    }], signal)
  );
  const results = await pool(tasks, CONCURRENCY, onProgress, signal);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new Error(failed.length + ' of ' + results.length + ' log chunks failed');
  }
  const logs = [];
  for (const r of results) logs.push(...r.value);
  return logs;
}

/* ============================ scan sections ============================
 * Each section is read-only and returns plain data (no DOM). Failures
 * throw; runScan() converts them into per-section "unavailable" cards.
 */

async function fetchEthUsd(signal) {
  const j = await fetchJson(COINBASE_ETH_USD, { signal });
  const v = parseFloat(j && j.data && j.data.amount);
  if (!isFinite(v)) throw new Error('bad price response');
  return v;
}

async function checkChainId(signal) {
  const id = await rpc('eth_chainId', [], signal);
  if (id !== '0x' + BASE_CHAIN_ID.toString(16)) throw new Error('unexpected chain id ' + id + ' (expected Base 8453)');
}

// 1. Native ETH
async function scanNative(addr, ethUsd, signal) {
  const balHex = await getBalance(addr, signal);
  const wei = BigInt(balHex);
  const usd = ethUsd != null ? Number(wei) / 1e18 * ethUsd : null;
  return { wei, usd, dust: usd != null && usd < DUST_USD };
}

// 2a. Curated ERC-20s via balanceOf
async function scanCurated(addr, signal) {
  const tasks = CURATED_TOKENS.map((t) => async () => {
    const raw = await ethCall(t.address, encBalanceOf(addr), 'latest', signal);
    const bal = decodeUint(raw);
    if (bal == null || bal === 0n) return null;
    return { contract: t.address, symbol: t.symbol, decimals: t.decimals, balance: bal, curated: true };
  });
  const results = await pool(tasks, CONCURRENCY, null, signal);
  return results.filter((r) => r.ok && r.value).map((r) => r.value);
}

// 2b/3/4. Token-transfer discovery via Blockscout's indexed API (full history,
// paginated). Returns Map contract -> { types:Set, tokenIds:Set, symbol, name, decimals }.
// Worst-case guard: stops after DISCOVERY_PAGE_CAP pages and reports truncation.
async function discoverViaBlockscout(addr, onProgress, signal) {
  const me = normAddr(addr);
  const contracts = new Map();
  let pageParams = null;
  let pages = 0;
  let totalSeen = 0;
  let truncated = false;
  let pageError = false;
  for (;;) {
    checkAborted(signal);
    let url = BLOCKSCOUT_API + '/addresses/' + addr + '/token-transfers';
    if (pageParams) url += '?' + new URLSearchParams(pageParams).toString();
    let j;
    try {
      j = await fetchJson(url, { signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      // Keep the pages already collected and degrade honestly instead of
      // failing the whole section (Blockscout 500s on some huge histories).
      pageError = true;
      truncated = true;
      break;
    }
    const items = Array.isArray(j.items) ? j.items : [];
    pages++;
    totalSeen += items.length;
    for (const it of items) {
      const to = it.to && it.to.hash ? normAddr(it.to.hash) : null;
      if (to !== me) continue; // inbound only
      const token = it.token || {};
      const contract = token.address_hash ? normAddr(token.address_hash) : null;
      if (!contract) continue;
      let e = contracts.get(contract);
      if (!e) {
        let dec = null;
        if (token.decimals != null && token.decimals !== '') {
          const d = parseInt(token.decimals, 10);
          if (Number.isSafeInteger(d) && d >= 0 && d <= 36) dec = d;
        }
        e = { types: new Set(), tokenIds: new Set(), symbol: token.symbol || null, name: token.name || null, decimals: dec };
        contracts.set(contract, e);
      }
      const ttype = it.token_type || token.type;
      if (ttype) e.types.add(ttype);
      const tid = it.total && it.total.token_id != null ? String(it.total.token_id) : null;
      if (tid != null && e.tokenIds.size < TOKEN_IDS_PER_CONTRACT_CAP) e.tokenIds.add(tid);
    }
    if (onProgress) onProgress(pages);
    const npp = j.next_page_params;
    if (!npp) break;
    if (pages >= DISCOVERY_PAGE_CAP) { truncated = true; break; }
    pageParams = npp;
  }
  return { contracts, pages, totalSeen, truncated, pageError };
}

// Classify each discovered contract with onchain calls:
// balanceOf > 0, then decimals() ok => ERC-20; else supportsInterface(721)
// => ERC-721 (tokenIds verified via ownerOf); ERC-1155 ids via balanceOf(id).
// Worst-case guard: CLASSIFY_CONTRACT_CAP contracts, then an honest note.
async function classifyTokens(addr, discovered, onProgress, signal) {
  const entries = [...discovered.contracts.entries()];
  const truncated = entries.length > CLASSIFY_CONTRACT_CAP;
  const work = truncated ? entries.slice(0, CLASSIFY_CONTRACT_CAP) : entries;
  const erc20 = [];
  const erc721 = [];
  const erc1155 = [];
  let done = 0;
  const tasks = work.map(([contract, info]) => async () => {
    try {
      const balRaw = await ethCall(contract, encBalanceOf(addr), 'latest', signal);
      const bal = decodeUint(balRaw);
      if (bal == null || bal === 0n) return; // not held now
      const decRaw = await ethCall(contract, SEL_DECIMALS, 'latest', signal);
      const dec = decodeUint(decRaw);
      if (dec != null && dec <= 36n) {
        let symbol = info.symbol;
        if (!symbol) {
          try {
            const symRaw = await ethCall(contract, SEL_SYMBOL, 'latest', signal);
            symbol = decodeString(symRaw);
          } catch (e) { /* leave null */ }
        }
        erc20.push({
          contract, symbol: symbol || shortAddr(contract), decimals: Number(dec),
          balance: bal, curated: false,
        });
        return;
      }
      const supRaw = await ethCall(contract, encSupportsInterface(IFACE_ERC721), 'latest', signal);
      if (decodeUint(supRaw) === 1n) {
        const ids = [...info.tokenIds];
        const held = [];
        const idsTruncated = ids.length >= TOKEN_IDS_PER_CONTRACT_CAP;
        for (const id of ids) {
          checkAborted(signal);
          try {
            const ownRaw = await ethCall(contract, encOwnerOf(id), 'latest', signal);
            const owner = decodeUint(ownRaw);
            if (owner != null && '0x' + owner.toString(16).padStart(40, '0') === normAddr(addr)) {
              held.push(id);
            }
          } catch (e) { /* skip unverifiable id */ }
        }
        if (held.length > 0) erc721.push({ contract, tokenIds: held, idsTruncated });
        return;
      }
      // ERC-1155 (or unknown): confirm per-id balances from discovery.
      const ids = [...info.tokenIds];
      const held = [];
      for (const id of ids) {
        checkAborted(signal);
        try {
          const raw = await ethCall(contract, encBalanceOf1155(addr, id), 'latest', signal);
          const bal1155 = decodeUint(raw);
          if (bal1155 != null && bal1155 > 0n) held.push({ id, balance: bal1155 });
        } catch (e) { /* skip */ }
      }
      if (held.length > 0) erc1155.push({ contract, holdings: held });
      // else: not a recognizable held token standard — skipped silently
    } finally {
      done++;
      if (onProgress) onProgress(done, work.length);
    }
  });
  await pool(tasks, CONCURRENCY, null, signal);
  erc20.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { erc20, erc721, erc1155, truncatedContracts: truncated, totalContracts: entries.length };
}

// 5. Bridge withdrawals: MessagePassed events from the L2ToL1MessagePasser
//    with sender == addr. Raw eth_getLogs (address-filtered chunks) — the
//    verified onchain path. See the honesty note in the header comment.
//    Age is estimated from block numbers (Base ~2s/block) — accurate enough
//    for the >30-day heuristic and avoids a per-log block-timestamp RPC,
//    which would serialize thousands of calls for busy senders.
const WITHDRAWAL_LIST_CAP = 200; // show most recent; note the rest honestly

async function scanWithdrawals(addr, fromBlock, toBlock, onProgress, signal) {
  const logs = await getLogsChunked(
    { address: L2_TO_L1_PASSER, topics: [TOPIC_MESSAGE_PASSED, null, addrToTopic(addr)] },
    fromBlock, toBlock, onProgress, signal
  );
  const nowS = Math.floor(Date.now() / 1000);
  const out = [];
  for (const l of logs) {
    checkAborted(signal);
    try {
      const blockNumber = parseInt(l.blockNumber, 16);
      const target = topicToAddr(l.topics[3]);
      const value = decodeUint(l.data);
      const dataHex = l.data.slice(2);
      const withdrawalHash = '0x' + dataHex.slice(96 * 2, 128 * 2);
      const ageDays = (toBlock - blockNumber) * 2 / 86400;
      out.push({
        txHash: l.transactionHash,
        blockNumber,
        target,
        valueWei: value,
        withdrawalHash,
        ageDays,
        stuck: ageDays > STUCK_DAYS,
      });
    } catch (e) { /* malformed log, skip */ }
  }
  out.sort((a, b) => b.blockNumber - a.blockNumber);
  const truncated = out.length > WITHDRAWAL_LIST_CAP;
  return {
    items: truncated ? out.slice(0, WITHDRAWAL_LIST_CAP) : out,
    total: out.length,
    truncated,
  };
}

// 6. Unclaimed Merkl rewards (public GET API)
function normalizeMerkl(json) {
  const out = [];
  const push = (r) => {
    if (!r || typeof r !== 'object') return;
    const token = r.token || r.rewardToken || {};
    let amount;
    try { amount = BigInt(r.amount || r.claimable || '0'); } catch (e) { return; }
    if (amount <= 0n) return;
    const dec = Number.isSafeInteger(token.decimals) ? token.decimals
      : (Number.isSafeInteger(r.decimals) ? r.decimals : 18);
    const usd = typeof r.usdValue === 'number' ? r.usdValue
      : (typeof r.valueUsd === 'number' ? r.valueUsd : null);
    out.push({
      symbol: token.symbol || r.symbol || 'UNKNOWN',
      decimals: dec, amount, usd,
      tokenAddress: token.address || r.tokenAddress || null,
    });
  };
  const arr = Array.isArray(json) ? json : (json && Array.isArray(json.rewards) ? json.rewards : []);
  for (const item of arr) {
    if (item && Array.isArray(item.rewards)) item.rewards.forEach(push);
    else push(item);
  }
  return out;
}

async function scanMerkl(addr, signal) {
  const url = MERKL_API.replace('{address}', addr);
  const j = await fetchJson(url, { signal });
  return normalizeMerkl(j);
}

// Orchestrator. onSection(result) fires after each section completes so the
// UI can render progressively. Throws AbortError on cancel/timeout.
async function runScan(addr, progress, onSection, signal) {
  const P = progress || (() => {});
  const S = onSection || (() => {});
  const result = { address: addr, sections: {}, failed: {}, notes: [] };

  P(2, 'checking chain…');
  await checkChainId(signal);
  const latest = await getBlockNumber(signal);
  const toBlock = parseInt(latest, 16);
  const fromBlock = Math.max(0, toBlock - SCAN_BLOCKS);
  result.scanRange = { fromBlock, toBlock };

  let ethUsd = null;
  try { ethUsd = await fetchEthUsd(signal); } catch (e) { /* USD context unavailable */ }
  result.ethUsd = ethUsd;

  P(4, 'reading native ETH balance…');
  try { result.sections.native = await scanNative(addr, ethUsd, signal); }
  catch (e) { failOrAbort(result, 'native', e); }
  S(result);

  P(8, 'checking curated tokens…');
  let curated = [];
  try { curated = await scanCurated(addr, signal); }
  catch (e) { failOrAbort(result, 'erc20curated', e); }
  S(result);

  P(12, 'discovering token transfers (indexed)…');
  let discovered = null;
  try {
    discovered = await discoverViaBlockscout(addr,
      (pages) => P(12 + Math.min(8, pages), 'discovering token transfers (' + pages + ' pages)…'), signal);
    if (discovered.truncated) {
      result.notes.push(discovered.pageError
        ? 'Token-transfer discovery hit an API error partway — showing the most recent ~' +
          discovered.totalSeen + ' transfers. Some holdings may be missed.'
        : 'Transfer history is very large — showing the most recent ~' +
          discovered.totalSeen + ' transfers. Some holdings may be missed.');
    }
  } catch (e) { failOrAbort(result, 'discovery', e); }
  S(result);

  if (discovered) {
    P(22, 'classifying token contracts…');
    try {
      const c = await classifyTokens(addr, discovered,
        (d, t) => P(22 + Math.round(20 * d / t), 'classifying token contracts (' + d + '/' + t + ')…'), signal);
      const seen = new Set(curated.map((x) => normAddr(x.contract)));
      result.sections.erc20 = [...curated, ...c.erc20.filter((x) => !seen.has(normAddr(x.contract)))];
      result.sections.erc721 = c.erc721;
      result.sections.erc1155 = c.erc1155;
      if (c.truncatedContracts) {
        result.notes.push('Too many token contracts to check in-browser (' +
          c.totalContracts + ' found) — showing the first ' + CLASSIFY_CONTRACT_CAP + '.');
      }
    } catch (e) { failOrAbort(result, 'classify', e); }
  } else {
    result.sections.erc20 = curated;
    result.sections.erc721 = null;
    result.sections.erc1155 = null;
  }
  S(result);


  P(44, 'scanning bridge withdrawals…');
  try {
    const w = await scanWithdrawals(addr, fromBlock, toBlock,
      (d, t) => P(44 + Math.round(44 * d / t), 'scanning bridge withdrawals (' + d + '/' + t + ' chunks)…'), signal);
    result.sections.withdrawals = w;
    if (w.truncated) {
      result.notes.push(w.total.toLocaleString('en-US') + ' bridge withdrawals found — showing the ' +
        WITHDRAWAL_LIST_CAP + ' most recent.');
    }
  } catch (e) { failOrAbort(result, 'withdrawals', e); }
  S(result);

  P(90, 'checking Merkl rewards…');
  try { result.sections.merkl = await scanMerkl(addr, signal); }
  catch (e) { failOrAbort(result, 'merkl', e); }
  S(result);

  P(100, 'done.');
  return result;
}

function failOrAbort(result, key, e) {
  if (e && e.name === 'AbortError') throw e;
  result.failed[key] = 'section unavailable — ' + e.message;
}

/* ============================ rendering (DOM) ============================ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function extLink(href, text, mono) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  if (mono) a.className = 'mono';
  return a;
}

function basescanAddr(a) { return 'https://basescan.org/address/' + a; }
function basescanTx(h) { return 'https://basescan.org/tx/' + h; }

function findingCard(sev, title) {
  const card = el('div', 'finding sev-' + sev);
  card.appendChild(el('h3', null, title));
  return card;
}

function errorCard(title, msg) {
  const card = findingCard('bad', title);
  card.appendChild(el('p', null, msg));
  return card;
}

function holdingRow(leftNode, amountText, usdText) {
  const row = el('div', 'holding');
  const left = el('div');
  left.appendChild(leftNode);
  row.appendChild(left);
  const right = el('div', 'amount', amountText);
  if (usdText) {
    right.appendChild(el('span', 'usd', '  ' + usdText));
  }
  row.appendChild(right);
  return row;
}

function renderNative(s, ethUsd) {
  const eth = Number(s.wei) / 1e18;
  let card;
  if (s.wei === 0n) {
    card = findingCard('info', 'Native ETH');
    card.appendChild(el('p', null, 'No native ETH at this address.'));
  } else if (s.dust) {
    card = findingCard('info', 'Native ETH — dust');
    card.appendChild(el('p', null,
      'Dust balance (under ~$1 at current prices). Probably not worth moving on its own, but it counts toward gas.'));
  } else {
    card = findingCard('ok', 'Native ETH');
  }
  if (s.wei > 0n) {
    const usd = s.usd != null ? formatUsd(s.usd) : 'price unavailable';
    card.appendChild(holdingRow(el('span', 'mono', 'ETH (native)'), eth.toFixed(6) + ' ETH', usd));
  }
  return card;
}

function renderErc20(list) {
  const card = findingCard(list.length ? 'ok' : 'info', 'ERC-20 tokens');
  if (!list.length) {
    card.appendChild(el('p', 'muted',
      'No ERC-20 balances found (curated list + full transfer history).'));
    return card;
  }
  for (const t of list) {
    const left = el('span');
    left.appendChild(el('strong', null, t.symbol + '  '));
    left.appendChild(extLink(basescanAddr(t.contract), shortAddr(t.contract), true));
    card.appendChild(holdingRow(left, formatUnits(t.balance, t.decimals) + ' ' + t.symbol, null));
  }
  return card;
}

function renderErc721(list) {
  const card = findingCard(list.length ? 'ok' : 'info', 'ERC-721 NFTs');
  if (!list.length) {
    card.appendChild(el('p', 'muted', 'No ERC-721 holdings verified in the transfer history.'));
    return card;
  }
  for (const n of list) {
    const p = el('p');
    p.appendChild(el('strong', null, 'Contract '));
    p.appendChild(extLink(basescanAddr(n.contract), shortAddr(n.contract), true));
    p.appendChild(el('span', null, ' — token IDs held: '));
    n.tokenIds.forEach((id, i) => {
      if (i > 0) p.appendChild(document.createTextNode(', '));
      p.appendChild(extLink('https://basescan.org/token/' + n.contract + '?a=' + id, '#' + id, true));
    });
    if (n.idsTruncated) p.appendChild(el('span', 'muted', ' (+more — capped in-browser)'));
    card.appendChild(p);
  }
  return card;
}

function render1155(list) {
  const card = findingCard(list.length ? 'ok' : 'info', 'ERC-1155 editions');
  if (!list.length) {
    card.appendChild(el('p', 'muted', 'No ERC-1155 balances confirmed in the transfer history.'));
    return card;
  }
  for (const h of list) {
    for (const item of h.holdings) {
      const left = el('span');
      left.appendChild(extLink(basescanAddr(h.contract), shortAddr(h.contract), true));
      left.appendChild(el('span', 'mono', '  id ' + item.id));
      card.appendChild(holdingRow(left, '× ' + item.balance.toString(), null));
    }
  }
  return card;
}

function renderWithdrawals(w) {
  const list = (w && w.items) || [];
  const card = findingCard(list.length ? 'warn' : 'info', 'Base → L1 withdrawals');
  const note = el('p', 'fineprint',
    'Detected from MessagePassed events on the L2ToL1MessagePasser. ' +
    'This app does NOT check L1 finalization status — a withdrawal is only complete after it is ' +
    'proven and finalized. "Likely stuck" below is purely an age heuristic (>30 days), not a finality verdict. ' +
    'Verify and complete every withdrawal in the official bridge app.');
  card.appendChild(note);
  if (w && w.truncated) {
    card.appendChild(el('p', 'scope-note warn-note',
      'Note: ' + w.total.toLocaleString('en-US') + ' withdrawals found — showing the ' +
      WITHDRAWAL_LIST_CAP + ' most recent.'));
  }
  if (!list.length) {
    card.appendChild(el('p', 'muted', 'No bridge withdrawals found in the scan window.'));
    return card;
  }
  for (const w of list) {
    const box = el('div', 'finding sev-' + (w.stuck ? 'bad' : 'warn'));
    box.style.margin = '10px 0';
    const title = w.stuck ? 'LIKELY STUCK — initiated ' : 'Withdrawal — initiated ';
    const age = w.ageDays != null ? Math.floor(w.ageDays) + ' days ago' : 'unknown time ago';
    box.appendChild(el('h3', null, title + age));
    const dl = el('dl', 'kv');
    const rows = [
      ['To (L1 target)', w.target, true],
      ['Value', w.valueWei != null ? formatUnits(w.valueWei, 18) + ' ETH' : 'unknown'],
      ['Withdrawal hash', w.withdrawalHash.slice(0, 18) + '…', true],
    ];
    for (const [k, v, mono] of rows) {
      const div = el('div');
      div.appendChild(el('dt', null, k));
      const dd = el('dd', mono ? 'mono small' : null, v);
      div.appendChild(dd);
      dl.appendChild(div);
    }
    box.appendChild(dl);
    const links = el('p');
    links.appendChild(extLink(basescanTx(w.txHash), 'View tx on Basescan', true));
    links.appendChild(document.createTextNode('  ·  '));
    links.appendChild(extLink('https://bridge.base.org', 'Complete / verify in the official bridge'));
    box.appendChild(links);
    card.appendChild(box);
  }
  return card;
}

function renderMerkl(list) {
  const card = findingCard(list.length ? 'ok' : 'info', 'Unclaimed Merkl rewards');
  if (!list.length) {
    card.appendChild(el('p', 'muted',
      'No unclaimed Merkl rewards found for this address. (Other distributors are roadmap.)'));
    return card;
  }
  for (const r of list) {
    const left = el('span');
    left.appendChild(el('strong', null, r.symbol + '  '));
    if (r.tokenAddress) left.appendChild(extLink(basescanAddr(r.tokenAddress), shortAddr(r.tokenAddress), true));
    card.appendChild(holdingRow(left,
      formatUnits(r.amount, r.decimals) + ' ' + r.symbol,
      r.usd != null ? formatUsd(r.usd) : null));
  }
  const p = el('p');
  p.appendChild(extLink('https://merkl.xyz', 'Claim on merkl.xyz'));
  card.appendChild(p);
  return card;
}

// Renders whatever sections have completed so far (progressive) or the full
// result at the end. Sections that haven't run yet are skipped, not faked.
function renderFindings(result, partial) {
  const host = document.getElementById('findings');
  host.textContent = '';
  const F = result.failed, S = result.sections;

  if (result.scanRange) {
    const range = result.scanRange;
    const scope = el('p', 'scope-note',
      'Token discovery: full transfer history via Blockscout\'s indexed API. ' +
      'Bridge-withdrawal scan: blocks ' + range.fromBlock.toLocaleString('en-US') + ' → ' +
      range.toBlock.toLocaleString('en-US') + ' on Base (~46 days).');
    host.appendChild(scope);
  }
  for (const n of result.notes || []) {
    host.appendChild(el('p', 'scope-note warn-note', 'Note: ' + n));
  }

  const has = (k) => (k in S) || (k in F);
  if (has('native')) host.appendChild(F.native ? errorCard('Native ETH', F.native) : renderNative(S.native, result.ethUsd));
  if (has('erc20') || has('erc20curated')) {
    if (F.erc20curated && !('erc20' in S)) host.appendChild(errorCard('ERC-20 tokens', F.erc20curated));
    else if ('erc20' in S) host.appendChild(renderErc20(S.erc20 || []));
  }
  if (F.discovery && !partial && !('erc20' in S)) host.appendChild(errorCard('Token discovery', F.discovery));
  if (has('classify') || has('erc721')) {
    if (F.classify) host.appendChild(errorCard('Token classification', F.classify));
    else if (F.discovery) host.appendChild(errorCard('ERC-721 / ERC-1155 discovery',
      F.discovery + ' — only the curated ERC-20 list could be checked.'));
    else {
      if ('erc721' in S && S.erc721) host.appendChild(renderErc721(S.erc721));
      if ('erc1155' in S && S.erc1155) host.appendChild(render1155(S.erc1155));
    }
  }
  if (has('withdrawals')) host.appendChild(F.withdrawals ? errorCard('Base → L1 withdrawals', F.withdrawals) : renderWithdrawals(S.withdrawals));
  if (has('merkl')) host.appendChild(F.merkl ? errorCard('Unclaimed Merkl rewards', F.merkl) : renderMerkl(S.merkl || []));
  if (partial) host.appendChild(el('p', 'muted', 'Scan in progress — more sections below as they complete…'));
}

/* ============================ $RESCUE price panel ============================ */

async function loadRescuePrice() {
  const box = document.getElementById('rescue-price');
  let j;
  try {
    const res = await fetch(DEXSCREENER_API);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    j = await res.json();
  } catch (e) {
    box.textContent = '';
    box.appendChild(el('p', 'muted', 'Market data unavailable right now.'));
    box.appendChild(extLink('https://basescan.org/token/' + RESCUE_TOKEN, 'View $RESCUE on Basescan', true));
    return;
  }
  const pairs = j && j.pairs;
  box.textContent = '';
  if (!pairs || pairs.length === 0) {
    box.appendChild(el('p', null, 'Not indexed by DEXScreener yet.'));
    box.appendChild(el('p', 'fineprint',
      'No price is shown because there is no market data — a missing price is not a $0 price.'));
    box.appendChild(extLink('https://basescan.org/token/' + RESCUE_TOKEN, 'View $RESCUE on Basescan', true));
    return;
  }
  const sorted = [...pairs].sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  const p = sorted[0];
  const price = parseFloat(p.priceUsd);
  box.appendChild(el('p', 'price-big', isFinite(price) ? '$' + price.toPrecision(4) : '—'));
  const row = el('div', 'price-row');
  if (p.priceChange && p.priceChange.h24 != null) {
    const chg = parseFloat(p.priceChange.h24);
    row.appendChild(el('span', chg >= 0 ? 'up' : 'down', '24h ' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%'));
  }
  if (p.liquidity && p.liquidity.usd != null) row.appendChild(el('span', 'muted', 'Liq ' + formatUsd(p.liquidity.usd)));
  if (p.fdv != null) row.appendChild(el('span', 'muted', 'FDV ' + formatUsd(p.fdv)));
  if (p.dexId) row.appendChild(el('span', 'muted', String(p.dexId)));
  box.appendChild(row);
  const lp = el('p', 'fineprint');
  lp.appendChild(extLink('https://basescan.org/token/' + RESCUE_TOKEN, 'View $RESCUE on Basescan', true));
  box.appendChild(lp);
}

/* ============================ form wiring ============================ */

function setProgress(pct, text) {
  const bar = document.getElementById('progress');
  bar.hidden = false;
  document.getElementById('progress-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  document.getElementById('progress-text').textContent = text;
}

function initApp() {
  loadRescuePrice();
  const form = document.getElementById('scan-form');
  const input = document.getElementById('addr-input');
  const btn = document.getElementById('scan-btn');
  const errBox = document.getElementById('addr-error');
  const progressBox = document.getElementById('progress');

  // Cancel button lives next to the progress bar.
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.id = 'scan-cancel';
  cancelBtn.textContent = 'Cancel scan';
  cancelBtn.hidden = true;
  progressBox.appendChild(cancelBtn);

  let scanCtrl = null;
  let scanTimer = null;
  let timedOut = false;

  cancelBtn.addEventListener('click', () => {
    if (scanCtrl) scanCtrl.abort();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const addr = input.value.trim();
    if (!isValidAddress(addr)) {
      errBox.hidden = false;
      errBox.textContent = 'Invalid address. Expected 0x followed by 40 hex characters — nothing was scanned.';
      input.focus();
      return;
    }
    errBox.hidden = true;
    btn.disabled = true;
    cancelBtn.hidden = false;
    document.getElementById('findings').textContent = '';
    scanCtrl = new AbortController();
    clearTimeout(scanTimer);
    timedOut = false;
    scanTimer = setTimeout(() => { timedOut = true; if (scanCtrl) scanCtrl.abort(); }, SCAN_TIMEOUT_MS);
    try {
      setProgress(1, 'starting scan…');
      const finalResult = await runScan(addr, setProgress,
        (r) => renderFindings(r, true), scanCtrl.signal);
      renderFindings(finalResult, false);
      setProgress(100, 'done.');
    } catch (e) {
      const host = document.getElementById('findings');
      if (e && e.name === 'AbortError') {
        host.textContent = '';
        host.appendChild(errorCard('Scan stopped',
          'The scan was stopped before it could finish (' +
          (timedOut ? 'it hit the 8-minute ceiling' : 'cancelled') +
          '). No results are shown because a partial scan would be misleading — try again, ' +
          'or check the address on basescan.org directly.'));
        setProgress(100, 'stopped.');
      } else {
        host.textContent = '';
        host.appendChild(errorCard('Scan failed', 'The scan could not start: ' + e.message));
        setProgress(100, 'failed.');
      }
    } finally {
      clearTimeout(scanTimer);
      scanCtrl = null;
      btn.disabled = false;
      cancelBtn.hidden = true;
    }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}
