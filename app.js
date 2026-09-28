/* Wallet Report Card — static build.
 * Ported 1:1 from the original app's server actions (fetch + scoring) and
 * client UI. No wallet connection, no signing, no persistence: every scan is
 * a fresh live fetch of public chain data.
 */
"use strict";

const CHAINS = {
  base: { label: "Base", note: "Blockscout", blockscout: "https://base.blockscout.com" },
  ethereum: { label: "Ethereum", note: "Blockscout", blockscout: "https://eth.blockscout.com" },
  robinhood: { label: "Robinhood Chain", note: "Explorer + RPC fallback", blockscout: "https://robinhoodchain.blockscout.com" },
};

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
const MAX_TRANSFERS = 1000;
const MAX_BLOCKSCOUT_PAGES = 20;
const RH_CHUNK_SIZE = 29900;      // RH RPC rejects eth_getLogs spans above ~30k blocks
const RH_BATCH_SIZE = 12;         // JSON-RPC batch calls per POST (small bursts avoid 429s)
const RH_INTER_BATCH_MS = 400;    // pacing between batches
const RH_MAX_CHUNKS = 6000;       // safety ceiling on full-history chunk count

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SourceFailure extends Error {
  constructor(message, code = "SOURCE_UNAVAILABLE", status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const normalizeAddress = (value) => value.toLowerCase();
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(value);
const round = (value, digits = 1) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const shortAddress = (value) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const esc = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function formatDuration(days) {
  if (days === null) return "No exits yet";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hr`;
  if (days < 60) return `${days.toLocaleString(undefined, { maximumFractionDigits: 1 })} days`;
  if (days < 730) return `${(days / 30.4375).toLocaleString(undefined, { maximumFractionDigits: 1 })} months`;
  return `${(days / 365.25).toLocaleString(undefined, { maximumFractionDigits: 1 })} years`;
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

async function fetchJson(url, init = {}, timeoutMs = 12000) {
  // Transient 5xx / 429 / network blips from public explorers are retried with
  // backoff; anything else fails fast so error states stay honest.
  const MAX_ATTEMPTS = 3;
  let delay = 1000;
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response = null;
    let networkError = null;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      networkError = error;
    } finally {
      clearTimeout(timer);
    }
    const retryable = networkError !== null
      || response.status === 429
      || (response.status >= 500 && response.status < 600);
    if (retryable && attempt < MAX_ATTEMPTS) {
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
      continue;
    }
    if (networkError) {
      throw new SourceFailure("The chain data source did not respond in time.");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      throw new SourceFailure(`The chain data source returned HTTP ${response.status}.`, "SOURCE_UNAVAILABLE", response.status);
    }
    if (!contentType.toLowerCase().includes("json")) {
      throw new SourceFailure("The chain data source returned a non-data response.", "INVALID_RESPONSE");
    }
    try {
      return await response.json();
    } catch {
      throw new SourceFailure("The chain data source returned unreadable data.", "INVALID_RESPONSE");
    }
  }
}

function asRecord(value) {
  return typeof value === "object" && value !== null ? value : null;
}

function readAddress(value) {
  const record = asRecord(value);
  const hash = record?.hash;
  return typeof hash === "string" && isAddress(hash) ? normalizeAddress(hash) : null;
}

function parseBlockscoutTransfer(value) {
  const item = asRecord(value);
  if (!item) throw new SourceFailure("A transfer row was malformed.", "INVALID_RESPONSE");
  const token = asRecord(item.token);
  const total = asRecord(item.total);
  const from = readAddress(item.from);
  const to = readAddress(item.to);
  const contract = typeof token?.address_hash === "string" ? normalizeAddress(token.address_hash) : "";
  const tokenIdValue = total?.token_id ?? item.token_id;
  const tokenId = typeof tokenIdValue === "string" || typeof tokenIdValue === "number" ? String(tokenIdValue) : "";
  const timestampMs = typeof item.timestamp === "string" ? Date.parse(item.timestamp) : Number.NaN;
  const blockNumber = typeof item.block_number === "number" ? item.block_number : Number(item.block_number);
  const logIndex = typeof item.log_index === "number" ? item.log_index : Number(item.log_index ?? 0);
  const tokenType = typeof token?.type === "string" ? token.type : "";
  // Blockscout's type=ERC-721 filter can leak ERC-404 hybrid rows (they emit
  // ERC-721-shaped Transfer events). Skip them; this is an ERC-721 analysis.
  if (tokenType !== "ERC-721") return null;
  if (!from || !to || !isAddress(contract) || !tokenId || !Number.isFinite(timestampMs) || !Number.isFinite(blockNumber) || !Number.isFinite(logIndex)) {
    throw new SourceFailure("A transfer row was missing required ERC-721 fields.", "INVALID_RESPONSE");
  }
  return {
    blockNumber, logIndex, timestampMs, from, to, contract, tokenId,
    collectionName: typeof token?.name === "string" && token.name.trim() ? token.name.trim() : null,
  };
}

async function loadBlockscoutTransfers(chain, address) {
  const base = `${CHAINS[chain].blockscout}/api/v2/addresses/${address}/token-transfers`;
  let next = null;
  const rows = [];
  const seen = new Set();

  for (let page = 0; page < MAX_BLOCKSCOUT_PAGES; page += 1) {
    const url = new URL(base);
    url.searchParams.set("type", "ERC-721");
    if (next) {
      for (const [key, value] of Object.entries(next)) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const payload = asRecord(await fetchJson(url.toString()));
    if (!payload || !Array.isArray(payload.items)) {
      throw new SourceFailure("The explorer returned an unexpected response.", "INVALID_RESPONSE");
    }
    for (const raw of payload.items) {
      const transfer = parseBlockscoutTransfer(raw);
      if (!transfer) continue;
      const key = `${transfer.blockNumber}:${transfer.logIndex}:${transfer.contract}:${transfer.tokenId}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(transfer);
      }
    }
    next = payload.next_page_params && typeof payload.next_page_params === "object" ? payload.next_page_params : null;
    if (!next) return rows;
    if (rows.length >= MAX_TRANSFERS) {
      throw new SourceFailure("This wallet has more than 1,000 NFT transfers, so a complete score would be unsafe.", "HISTORY_TOO_LARGE");
    }
  }
  throw new SourceFailure("This wallet has more history than can be scored safely in one scan.", "HISTORY_TOO_LARGE");
}

/* ---- Robinhood Chain: public JSON-RPC fallback ---- */

function hexNumber(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function topicAddress(topic) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

async function rpcBatch(calls, timeoutMs = 60000) {
  const payload = calls.map((call, index) => ({ jsonrpc: "2.0", id: index, ...call }));
  const body = await fetchJson(ROBINHOOD_RPC, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  }, timeoutMs);
  const results = new Array(calls.length).fill(null);
  if (!Array.isArray(body)) {
    throw new SourceFailure("Robinhood Chain returned an unexpected response.", "INVALID_RESPONSE");
  }
  for (const entry of body) {
    const record = asRecord(entry);
    if (record && typeof record.id === "number" && record.id >= 0 && record.id < results.length) {
      results[record.id] = record;
    }
  }
  return results;
}

async function rpcBatchWithRetry(calls, attempts = 8) {
  let delay = 1000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await rpcBatch(calls);
    } catch (error) {
      if (attempt === attempts) throw error;
      // HTTP 429 (rate limit) needs much longer backoff than a transient blip.
      const cap = error instanceof SourceFailure && error.status === 429 ? 45000 : 15000;
      await sleep(delay);
      delay = Math.min(delay * 2, cap);
    }
  }
  throw new SourceFailure("Robinhood Chain data is unavailable right now.");
}

async function fetchRpcBatch(slice, attempts = 6) {
  // Retries one JSON-RPC batch slice. Per-entry "timed out" errors are
  // transient on the RH public RPC and retried; a range-limit error is a
  // hard stop; anything else aborts the scan.
  let delay = 1500;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const entries = await rpcBatchWithRetry(slice);
    if (entries.every((entry) => entry === null)) {
      throw new SourceFailure("Robinhood Chain returned an empty batch response.", "INVALID_RESPONSE");
    }
    let timedOut = false;
    for (const entry of entries) {
      const record = asRecord(entry);
      const message = typeof record?.error?.message === "string" ? record.error.message : null;
      if (!message) continue;
      if (/limit|too many|range|exceed/i.test(message)) {
        throw new SourceFailure(message, "HISTORY_TOO_LARGE");
      }
      if (/timed out/i.test(message)) {
        timedOut = true;
        break;
      }
      throw new SourceFailure(message, "SOURCE_UNAVAILABLE");
    }
    if (!timedOut) return entries;
    if (attempt === attempts) {
      throw new SourceFailure("Robinhood Chain log queries kept timing out.", "SOURCE_UNAVAILABLE");
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 20000);
  }
  throw new SourceFailure("Robinhood Chain data is unavailable right now.");
}

async function loadRobinhoodRpcTransfers(address, onProgress) {
  const [chainIdEntry, latestEntry] = await rpcBatchWithRetry([
    { method: "eth_chainId", params: [] },
    { method: "eth_blockNumber", params: [] },
  ]);
  if (asRecord(chainIdEntry)?.result !== "0x1237") {
    throw new SourceFailure("The Robinhood RPC reported the wrong chain.", "INVALID_RESPONSE");
  }
  const latest = hexNumber(asRecord(latestEntry)?.result);
  if (latest === null) throw new SourceFailure("Robinhood Chain returned an invalid block number.", "INVALID_RESPONSE");

  const chunks = [];
  for (let from = 0; from <= latest; from += RH_CHUNK_SIZE) {
    chunks.push([from, Math.min(from + RH_CHUNK_SIZE - 1, latest)]);
  }
  if (chunks.length > RH_MAX_CHUNKS) {
    throw new SourceFailure("Robinhood Chain history exceeded the safe live-query budget.", "HISTORY_TOO_LARGE");
  }

  const padded = `0x${address.slice(2).padStart(64, "0")}`;
  const jobs = [];
  for (const [from, to] of chunks) {
    const params = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
    jobs.push({ method: "eth_getLogs", params: [{ ...params, topics: [TRANSFER_TOPIC, null, padded] }] });
    jobs.push({ method: "eth_getLogs", params: [{ ...params, topics: [TRANSFER_TOPIC, padded] }] });
  }

  const unique = new Map();
  let done = 0;
  for (let index = 0; index < jobs.length; index += RH_BATCH_SIZE) {
    const slice = jobs.slice(index, index + RH_BATCH_SIZE);
    const entries = await fetchRpcBatch(slice);
    if (index + RH_BATCH_SIZE < jobs.length) await sleep(RH_INTER_BATCH_MS);
    for (const entry of entries) {
      const record = asRecord(entry);
      if (!record) continue;
      const logs = Array.isArray(record.result) ? record.result : [];
      for (const log of logs) {
        const logRecord = asRecord(log);
        const topics = logRecord?.topics;
        if (!Array.isArray(topics) || topics.length !== 4 || !topics.every((topic) => typeof topic === "string")) continue;
        const key = `${String(logRecord?.transactionHash)}:${String(logRecord?.logIndex)}`;
        unique.set(key, log);
      }
    }
    done += slice.length;
    if (onProgress) onProgress(done, jobs.length);
    if (unique.size > MAX_TRANSFERS) {
      throw new SourceFailure("This wallet has more than 1,000 NFT transfers, so a complete score would be unsafe.", "HISTORY_TOO_LARGE");
    }
  }

  // Block timestamps, only for blocks that actually contain this wallet's transfers.
  const blockNumbers = new Set();
  for (const log of unique.values()) {
    const block = hexNumber(asRecord(log)?.blockNumber);
    if (block === null) throw new SourceFailure("Robinhood Chain returned a malformed log.", "INVALID_RESPONSE");
    blockNumbers.add(block);
  }
  const timestamps = new Map();
  const blocks = [...blockNumbers];
  const BLOCK_BATCH = 200;
  for (let index = 0; index < blocks.length; index += BLOCK_BATCH) {
    const slice = blocks.slice(index, index + BLOCK_BATCH).map((block) => ({
      method: "eth_getBlockByNumber",
      params: [`0x${block.toString(16)}`, false],
    }));
    const entries = await fetchRpcBatch(slice);
    for (let j = 0; j < entries.length; j += 1) {
      const result = asRecord(asRecord(entries[j])?.result);
      const seconds = hexNumber(result?.timestamp);
      if (seconds === null) throw new SourceFailure("Robinhood Chain omitted a block timestamp.", "INVALID_RESPONSE");
      timestamps.set(blocks[index + j], seconds * 1000);
    }
  }

  const transfers = [];
  for (const log of unique.values()) {
    const record = asRecord(log);
    const topics = Array.isArray(record?.topics) ? record.topics : [];
    const from = typeof topics[1] === "string" ? topicAddress(topics[1]) : null;
    const to = typeof topics[2] === "string" ? topicAddress(topics[2]) : null;
    const tokenIdRaw = typeof topics[3] === "string" ? topics[3] : "";
    const blockNumber = hexNumber(record?.blockNumber);
    const logIndex = hexNumber(record?.logIndex);
    const contract = typeof record?.address === "string" ? normalizeAddress(record.address) : "";
    if (!from || !to || blockNumber === null || logIndex === null || !isAddress(contract) || !/^0x[0-9a-fA-F]{64}$/.test(tokenIdRaw)) {
      throw new SourceFailure("Robinhood Chain returned a malformed NFT transfer.", "INVALID_RESPONSE");
    }
    const timestampMs = timestamps.get(blockNumber);
    if (timestampMs === undefined) throw new SourceFailure("Robinhood Chain omitted transfer timing.", "INVALID_RESPONSE");
    transfers.push({ blockNumber, logIndex, timestampMs, from, to, contract, tokenId: BigInt(tokenIdRaw).toString(), collectionName: null });
  }
  return transfers;
}

/* ---- Scoring (identical math to the original) ---- */

function ratingFor(score) {
  if (score >= 80) return "Diamond Hands";
  if (score >= 60) return "Steady Holder";
  if (score >= 35) return "Active Flipper";
  return "Paper Hands";
}

function durationText(days) {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 60) return `${round(days, 1)}d`;
  if (days < 730) return `${round(days / 30.4375, 1)}mo`;
  return `${round(days / 365.25, 1)}y`;
}

function computeReport(chain, address, source, transfers, analyzedAt) {
  const wallet = normalizeAddress(address);
  const sorted = [...transfers].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const open = new Map();
  const cycles = [];
  const distinct = new Set();

  for (const event of sorted) {
    const inbound = event.to === wallet && event.from !== wallet;
    const outbound = event.from === wallet && event.to !== wallet;
    if (!inbound && !outbound) continue;
    const key = `${event.contract}:${event.tokenId}`;
    if (inbound) {
      if (!open.has(key)) {
        const cycle = { contract: event.contract, tokenId: event.tokenId, collectionName: event.collectionName, startedAt: event.timestampMs, endedAt: null };
        open.set(key, cycle);
        cycles.push(cycle);
        distinct.add(key);
      }
    } else {
      const cycle = open.get(key);
      if (cycle) {
        cycle.endedAt = Math.max(event.timestampMs, cycle.startedAt);
        open.delete(key);
      }
    }
  }

  const chainLabel = CHAINS[chain].label;
  if (cycles.length === 0) {
    return {
      status: "no_history", chain, chainLabel, address, analyzedAt, source,
      message: "No complete ERC-721 acquisition history was found for this wallet on this chain.",
    };
  }

  const now = Date.parse(analyzedAt);
  const DAY = 86400000;
  const durations = cycles.map((cycle) => ({ cycle, days: Math.max(0, ((cycle.endedAt ?? now) - cycle.startedAt) / DAY) }));
  const sold = durations.filter(({ cycle }) => cycle.endedAt !== null);
  const observedAges = cycles.map((cycle) => Math.max(0, (now - cycle.startedAt) / DAY));
  const sevenDayEligible = durations.filter((item) => item.cycle.endedAt !== null || (now - item.cycle.startedAt) / DAY >= 7);
  const thirtyDayEligible = durations.filter((item) => item.cycle.endedAt !== null || (now - item.cycle.startedAt) / DAY >= 30);
  if (thirtyDayEligible.length === 0) {
    const oldestHoldDays = Math.max(...observedAges);
    return {
      status: "insufficient_history", chain, chainLabel, address, analyzedAt, source,
      message: "This wallet has NFT activity, but none of its acquisitions has completed a 30-day observation window or exited yet. A score now would overstate its holding behavior.",
      currentHoldings: open.size,
      acquisitionCycles: cycles.length,
      oldestHoldDays: round(oldestHoldDays, 1),
      daysUntilEligible: Math.max(0, Math.ceil(30 - oldestHoldDays)),
    };
  }
  const averageHoldDays = durations.reduce((sum, item) => sum + item.days, 0) / durations.length;
  const averageTimeToSellDays = sold.length ? sold.reduce((sum, item) => sum + item.days, 0) / sold.length : null;
  const flip7Percent = (sevenDayEligible.filter((item) => item.cycle.endedAt !== null && item.days <= 7).length / sevenDayEligible.length) * 100;
  const flip30Percent = (thirtyDayEligible.filter((item) => item.cycle.endedAt !== null && item.days <= 30).length / thirtyDayEligible.length) * 100;
  const longest = durations.reduce((best, item) => (item.days > best.days ? item : best), durations[0]);
  const holdPoints = 50 * Math.min(averageHoldDays / 365, 1);
  const sevenDayPoints = 30 * (1 - flip7Percent / 100);
  const thirtyDayPoints = 20 * (1 - flip30Percent / 100);
  const score = Math.max(0, Math.min(100, Math.round(holdPoints + sevenDayPoints + thirtyDayPoints)));
  const rating = ratingFor(score);
  const metrics = {
    averageHoldDays: round(averageHoldDays, 1),
    flip7Percent: round(flip7Percent, 1),
    flip30Percent: round(flip30Percent, 1),
    flip7EligibleCycles: sevenDayEligible.length,
    flip30EligibleCycles: thirtyDayEligible.length,
    averageTimeToSellDays: averageTimeToSellDays === null ? null : round(averageTimeToSellDays, 1),
    totalDistinctNfts: distinct.size,
    currentHoldings: open.size,
    acquisitionCycles: cycles.length,
    soldCycles: sold.length,
    longestHeld: {
      contract: longest.cycle.contract,
      tokenId: longest.cycle.tokenId,
      collectionName: longest.cycle.collectionName,
      durationDays: round(longest.days, 1),
      ongoing: longest.cycle.endedAt === null,
    },
  };
  const receipt = [
    `WALLET REPORT CARD — ${chainLabel.toUpperCase()}`,
    shortAddress(address),
    `${score}/100 · ${rating.toUpperCase()}`,
    `Avg hold ${durationText(metrics.averageHoldDays)} · 7d flips ${metrics.flip7Percent}% · 30d flips ${metrics.flip30Percent}%`,
    `${metrics.totalDistinctNfts} NFTs ever · ${metrics.currentHoldings} held now`,
    `Checked ${analyzedAt.slice(0, 10)} · ${source}`,
  ].join("\n");

  return {
    status: "ok", chain, chainLabel, address, analyzedAt, source, score, rating, metrics,
    formula: {
      holdPoints: round(holdPoints, 1),
      sevenDayPoints: round(sevenDayPoints, 1),
      thirtyDayPoints: round(thirtyDayPoints, 1),
      explanation: "50 × min(avg hold days ÷ 365, 1) + 30 × (1 − 7d flip rate) + 20 × (1 − 30d flip rate)",
    },
    receipt,
  };
}

async function analyzeWallet(address, chain, onProgress) {
  const analyzedAt = new Date().toISOString();
  const chainLabel = CHAINS[chain].label;
  try {
    if (chain === "robinhood") {
      try {
        const transfers = await loadBlockscoutTransfers(chain, address);
        return computeReport(chain, address, "Robinhood Blockscout", transfers, analyzedAt);
      } catch (blockscoutError) {
        try {
          const transfers = await loadRobinhoodRpcTransfers(normalizeAddress(address), onProgress);
          return computeReport(chain, address, "Robinhood public RPC", transfers, analyzedAt);
        } catch (rpcError) {
          const failure = rpcError instanceof SourceFailure ? rpcError : new SourceFailure("Robinhood Chain data is unavailable right now.");
          return {
            status: "error", chain, chainLabel, address, analyzedAt,
            source: "Robinhood Blockscout + public RPC",
            code: failure.code,
            message: failure.code === "HISTORY_TOO_LARGE"
              ? failure.message
              : "Robinhood Chain history could not be completed from either public source. No score was calculated.",
          };
        }
      }
    }
    const transfers = await loadBlockscoutTransfers(chain, address);
    return computeReport(chain, address, `${chainLabel} Blockscout`, transfers, analyzedAt);
  } catch (error) {
    const failure = error instanceof SourceFailure ? error : new SourceFailure("The chain data source is unavailable right now.");
    return {
      status: "error", chain, chainLabel, address, analyzedAt,
      source: `${chainLabel} Blockscout`,
      code: failure.code,
      message: failure.message,
    };
  }
}

/* ---- UI ---- */

const $ = (id) => document.getElementById(id);
let scanToken = 0;

function metricRow(label, value, note) {
  return `<div class="metric-row"><div><p class="metric-label">${esc(label)}</p><p class="metric-note">${esc(note)}</p></div><strong class="metric-value">${esc(value)}</strong></div>`;
}

function formulaRow(label, value, max) {
  const width = Math.max(0, Math.min(100, (value / max) * 100));
  return `<div class="formula-row"><div class="formula-row-head"><span>${esc(label)}</span><strong>${value.toFixed(1)} / ${max}</strong></div><div class="formula-track" aria-hidden="true"><span style="width:${width}%"></span></div></div>`;
}

function renderReport(report) {
  const m = report.metrics;
  const longestName = m.longestHeld.collectionName ?? shortAddress(m.longestHeld.contract);
  $("result").innerHTML = `
  <section class="report-shell" aria-labelledby="report-rating">
    <div class="score-panel">
      <div class="score-stamp" style="--score-angle:${report.score * 3.6}deg" aria-label="Score ${report.score} out of 100">
        <div class="score-core"><strong>${report.score}</strong><span>/100</span></div>
      </div>
      <div class="score-copy">
        <p class="mono-kicker">${esc(report.chainLabel)} / ${esc(shortAddress(report.address))}</p>
        <h2 id="report-rating">${esc(report.rating)}</h2>
        <p>Scored from ${m.acquisitionCycles.toLocaleString()} acquisition cycles across ${m.totalDistinctNfts.toLocaleString()} distinct NFTs.</p>
      </div>
    </div>
    <div class="report-grid">
      <div class="metrics-sheet">
        <div class="section-heading"><span>Holding behavior</span><span>RESULT</span></div>
        ${metricRow("Average hold", formatDuration(m.averageHoldDays), "Includes NFTs still held")}
        ${metricRow("Flipped within 7 days", `${m.flip7Percent}%`, `${m.flip7EligibleCycles.toLocaleString()} cycles with a known 7-day outcome`)}
        ${metricRow("Flipped within 30 days", `${m.flip30Percent}%`, `${m.flip30EligibleCycles.toLocaleString()} cycles with a known 30-day outcome`)}
        ${metricRow("Average time to sell*", formatDuration(m.averageTimeToSellDays), `${m.soldCycles.toLocaleString()} matched outbound transfers`)}
        ${metricRow("NFTs ever held", m.totalDistinctNfts.toLocaleString(), "Distinct contract + token ID pairs")}
        ${metricRow("Current holdings", m.currentHoldings.toLocaleString(), "Open holding cycles")}
        <div class="longest-hold">
          <p class="metric-label">Longest hold</p>
          <strong>${esc(formatDuration(m.longestHeld.durationDays))}</strong>
          <p>${esc(longestName)} #${esc(m.longestHeld.tokenId)}${m.longestHeld.ongoing ? " · still held" : ""}</p>
        </div>
      </div>
      <div class="method-sheet">
        <div class="section-heading"><span>Score anatomy</span><span>${report.score} PTS</span></div>
        ${formulaRow("Hold duration", report.formula.holdPoints, 50)}
        ${formulaRow("7-day discipline", report.formula.sevenDayPoints, 30)}
        ${formulaRow("30-day discipline", report.formula.thirtyDayPoints, 20)}
        <details>
          <summary>Show the exact formula</summary>
          <code>${esc(report.formula.explanation)}</code>
          <p>80–100 Diamond Hands · 60–79 Steady Holder · 35–59 Active Flipper · 0–34 Paper Hands. A score waits until at least one acquisition has a known 30-day outcome.</p>
        </details>
        <p class="method-note">*A transfer feed cannot prove a sale. “Flip” and “time to sell” use the first outbound transfer after acquisition as a transparent proxy; gifts and wallet moves can affect the result.</p>
      </div>
    </div>
    <div class="receipt-block">
      <div class="section-heading"><span>X-ready receipt</span><span>PLAIN TEXT</span></div>
      <pre id="receipt-text">${esc(report.receipt)}</pre>
      <button class="copy-button" type="button" id="copy-button" aria-label="Copy X-ready receipt">Copy receipt</button>
    </div>
    <div class="report-footer">
      <span>Source: ${esc(report.source)}</span>
      <span>Checked ${esc(formatTimestamp(report.analyzedAt))}</span>
    </div>
  </section>`;
  $("copy-button").addEventListener("click", async () => {
    const button = $("copy-button");
    try {
      await navigator.clipboard.writeText(report.receipt);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = report.receipt;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy receipt"; }, 1800);
  });
}

function renderStatus(text, progress) {
  $("result").innerHTML = `
  <section class="status-panel" role="status" aria-live="polite">
    <span class="scan-pulse" aria-hidden="true"></span>
    <div style="flex:1">
      <strong>Building the full transfer timeline</strong>
      <p>${esc(text)}</p>
      ${progress ? `<div class="status-progress" aria-hidden="true"><span id="scan-progress-fill"></span></div>` : ""}
    </div>
  </section>`;
}

function updateProgress(done, total) {
  const fill = $("scan-progress-fill");
  if (fill && total > 0) fill.style.width = `${Math.min(100, (done / total) * 100).toFixed(1)}%`;
  const note = $("scan-progress-note");
  if (note) note.textContent = `${done.toLocaleString()} of ${total.toLocaleString()} scan batches complete`;
}

function renderFetchError(message) {
  $("result").innerHTML = `
  <section class="error-panel" role="alert">
    <p class="mono-kicker">SCAN FAILED</p>
    <h2>The report could not be calculated.</h2>
    <p>${esc(message)}</p>
    <button type="button" id="retry-button">Try again</button>
  </section>`;
  $("retry-button").addEventListener("click", () => $("scan-form").requestSubmit());
}

function renderSourceError(data) {
  const heading = data.code === "HISTORY_TOO_LARGE" ? "History exceeds the safe scan limit." : "Chain data is unavailable.";
  $("result").innerHTML = `
  <section class="error-panel" role="alert">
    <p class="mono-kicker">NO SCORE ISSUED</p>
    <h2>${esc(heading)}</h2>
    <p>${esc(data.message)}</p>
    <div class="error-meta">${esc(data.source)} · ${esc(formatTimestamp(data.analyzedAt))}</div>
    <button type="button" id="retry-button">Retry live scan</button>
  </section>`;
  $("retry-button").addEventListener("click", () => $("scan-form").requestSubmit());
}

function renderNoHistory(data) {
  $("result").innerHTML = `
  <section class="empty-panel" role="status">
    <div class="empty-mark">Ø</div>
    <div>
      <p class="mono-kicker">NO HISTORY</p>
      <h2>No grade to give.</h2>
      <p>${esc(data.message)}</p>
      <div class="error-meta">${esc(data.chainLabel)} · ${esc(shortAddress(data.address))} · ${esc(formatTimestamp(data.analyzedAt))}</div>
    </div>
  </section>`;
}

function renderInsufficient(data) {
  $("result").innerHTML = `
  <section class="empty-panel" role="status">
    <div class="empty-mark">…</div>
    <div>
      <p class="mono-kicker">EARLY READ</p>
      <h2>Not enough history to grade.</h2>
      <p>${esc(data.message)}</p>
      <div class="early-facts">
        <span>${data.acquisitionCycles.toLocaleString()} acquisition${data.acquisitionCycles === 1 ? "" : "s"}</span>
        <span>${data.currentHoldings.toLocaleString()} held now</span>
        <span>Oldest hold ${esc(formatDuration(data.oldestHoldDays))}</span>
      </div>
      <div class="error-meta">First possible 30-day read in about ${data.daysUntilEligible} day${data.daysUntilEligible === 1 ? "" : "s"} · ${esc(data.source)}</div>
    </div>
  </section>`;
}

function renderPrimer() {
  $("result").innerHTML = `
  <section class="primer" aria-label="How the rating works">
    <div><span class="primer-number">50</span><p>points for average hold duration</p></div>
    <div><span class="primer-number">30</span><p>points for avoiding 7-day flips</p></div>
    <div><span class="primer-number">20</span><p>points for avoiding 30-day flips</p></div>
  </section>`;
}

async function runScan() {
  const address = $("wallet-address").value.trim();
  const chain = $("chain-select").value;
  if (!isAddress(address)) return;
  const token = ++scanToken;
  $("scan-button").disabled = true;
  $("scan-button").textContent = "Reading chain…";
  const isRobinhood = chain === "robinhood";
  renderStatus(
    isRobinhood
      ? "Robinhood Chain is scanned directly from its public RPC in small history chunks. This can take several minutes for the full timeline — every chunk must be complete before a score is issued."
      : "Older wallets can take longer because every page must be complete before a score is issued.",
    isRobinhood,
  );
  try {
    const data = await analyzeWallet(address, chain, (done, total) => {
      if (token !== scanToken) return;
      updateProgress(done, total);
      const note = $("scan-progress-note");
      if (!note) {
        const panel = document.querySelector(".status-panel div");
        if (panel) {
          const p = document.createElement("p");
          p.id = "scan-progress-note";
          panel.appendChild(p);
        }
      }
      updateProgress(done, total);
    });
    if (token !== scanToken) return;
    if (data.status === "ok") renderReport(data);
    else if (data.status === "no_history") renderNoHistory(data);
    else if (data.status === "insufficient_history") renderInsufficient(data);
    else renderSourceError(data);
  } catch (error) {
    if (token !== scanToken) return;
    renderFetchError(error instanceof Error ? error.message : "The request did not complete.");
  } finally {
    if (token === scanToken) {
      $("scan-button").disabled = false;
      $("scan-button").textContent = "Grade this wallet";
    }
  }
}

function wireForm() {
  const input = $("wallet-address");
  const form = $("scan-form");
  const button = $("scan-button");
  const hint = $("wallet-hint");
  const validate = () => {
    const value = input.value.trim();
    if (!value) { hint.textContent = "Any public EVM wallet. Nothing is connected or signed."; hint.className = "field-hint"; input.setAttribute("aria-invalid", "false"); return true; }
    const ok = isAddress(value);
    hint.textContent = ok ? "Any public EVM wallet. Nothing is connected or signed." : "Use a 42-character 0x wallet address.";
    hint.className = ok ? "field-hint" : "field-error";
    input.setAttribute("aria-invalid", ok ? "false" : "true");
    return ok;
  };
  input.addEventListener("input", () => { validate(); button.disabled = !input.value.trim() || !isAddress(input.value.trim()); });
  button.disabled = true;
  form.addEventListener("submit", (event) => { event.preventDefault(); if (validate() && isAddress(input.value.trim())) runScan(); });
}

document.addEventListener("DOMContentLoaded", () => {
  wireForm();
  renderPrimer();
});
