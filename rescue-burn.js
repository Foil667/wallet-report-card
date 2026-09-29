/* rescue-burn.js — shared $RESCUE burn-status module for all Foil builds.
 *
 * Reads REAL onchain $RESCUE Transfer events to the dead address on Base.
 * No wallet, no signatures, no fund movements — pure reads.
 *
 * Usage (external file): include via a script tag whose src is
 * "rescue-burn.js", then:
 *   RescueBurn.getStatus().then(function (s) { console.log(s.total); });
 *   RescueBurn.renderWidget(document.getElementById('burn-widget'));
 * (The tag itself is described, not written, so this file never contains a
 * literal closing script tag and stays safe to inline in single-file pages.)
 *
 * Caching: totals + aggregates persist in localStorage; each call only scans
 * new blocks. If the RPC is unreachable, the last cached snapshot is returned
 * with stale:true — numbers are NEVER invented.
 */
(function (global) {
  'use strict';

  var RESCUE = '0x8201132Bc218dbD81305Ff5605F44aE4804D4BA3';
  var DEAD = '0x000000000000000000000000000000000000dEaD';
  var TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  var DEAD_TOPIC = '0x000000000000000000000000000000000000000000000000000000000000dead';
  var START_BLOCK = 51910000; // $RESCUE first had code at 51910062 (2026-09-28); rounded down
  var CACHE_KEY = 'foil-rescue-burn-v1';
  var RPC_URL = 'https://mainnet.base.org';
  var CHUNK = 2000;            // blocks per eth_getLogs call (mainnet.base.org 413s wider filtered ranges)
  var MIN_RANGE = 400;        // adaptive-split floor: never split below this
  var RPC_TIMEOUT_MS = 25000;
  var MAX_RETRIES = 3;
  var RECENT_KEEP = 25;

  function fmtWei(weiStr) {
    try {
      var w = BigInt(weiStr);
      var whole = w / 1000000000000000000n;
      var frac = (w % 1000000000000000000n).toString().padStart(18, '0').slice(0, 2);
      var s = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return s + '.' + frac;
    } catch (e) { return '0.00'; }
  }

  function fmtAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; }
  function timeAgo(ts) {
    var d = Date.now() - ts;
    if (d < 60000) return Math.max(1, Math.round(d / 1000)) + 's ago';
    if (d < 3600000) return Math.round(d / 60000) + 'm ago';
    if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
    return Math.round(d / 86400000) + 'd ago';
  }

  function loadCache() {
    try {
      var c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c && typeof c.totalWei === 'string') return c;
    } catch (e) {}
    return { totalWei: '0', txCount: 0, lastBlock: START_BLOCK - 1, updatedAt: 0, recent: [], byBurner: {} };
  }
  function saveCache(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {}
  }

  function rpc(method, params, attempt) {
    attempt = attempt || 0;
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, RPC_TIMEOUT_MS);
    return fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error('rpc http ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.error) throw new Error('rpc: ' + JSON.stringify(j.error).slice(0, 120));
      return j.result;
    }).catch(function (e) {
      clearTimeout(t);
      if (attempt < MAX_RETRIES) return rpc(method, params, attempt + 1);
      throw e;
    });
  }

  function decodeTransfer(log) {
    // topics: [Transfer, from, to]; amount in data
    var from = '0x' + log.topics[1].slice(26);
    var amount = BigInt(log.data).toString();
    return { from: from, amount: amount, txHash: log.transactionHash, blockNumber: parseInt(log.blockNumber, 16) };
  }

  function getBlockTimestamp(bn) {
    return rpc('eth_getBlockByNumber', ['0x' + bn.toString(16), false]).then(function (b) {
      return parseInt(b.timestamp, 16) * 1000;
    });
  }

  function getLogsRange(rg) {
    // mainnet.base.org rejects wide topic-filtered ranges (HTTP 413 or a
    // dropped connection). On a range-limit signal, halve the range and
    // retry; give up only below MIN_RANGE.
    return rpc('eth_getLogs', [{
      address: RESCUE,
      fromBlock: '0x' + rg[0].toString(16),
      toBlock: '0x' + rg[1].toString(16),
      topics: [TRANSFER_TOPIC, null, DEAD_TOPIC]
    }]).catch(function (e) {
      var msg = String(e && e.message || '');
      var rangeLimit = /413|Payload Too Large|closed connection|RemoteDisconnected|empty reply|socket hang up/i.test(msg);
      if (rangeLimit && (rg[1] - rg[0] + 1) > MIN_RANGE) {
        var mid = Math.floor((rg[0] + rg[1]) / 2);
        return getLogsRange([rg[0], mid]).then(function (a) {
          return getLogsRange([mid + 1, rg[1]]).then(function (b) { return a.concat(b); });
        });
      }
      throw e;
    });
  }

  function scanNew(cache) {
    return rpc('eth_blockNumber', []).then(function (tipHex) {
      var tip = parseInt(tipHex, 16);
      var from = cache.lastBlock + 1;
      if (from > tip) return { cache: cache, tip: tip, fresh: [] };
      var ranges = [];
      for (var s = from; s <= tip; s += CHUNK) ranges.push([s, Math.min(s + CHUNK - 1, tip)]);
      var chain = Promise.resolve();
      var fresh = [];
      ranges.forEach(function (rg) {
        chain = chain.then(function () {
          return getLogsRange(rg).then(function (logs) {
            (logs || []).forEach(function (l) { fresh.push(decodeTransfer(l)); });
          });
        });
      });
      return chain.then(function () { return { cache: cache, tip: tip, fresh: fresh }; });
    });
  }

  function getStatus(opts) {
    opts = opts || {};
    var cache = loadCache();
    var startedStale = (Date.now() - cache.updatedAt) > 5 * 60 * 1000;
    return scanNew(cache).then(function (r) {
      var c = r.cache, fresh = r.fresh;
      // merge
      fresh.forEach(function (b) {
        c.totalWei = (BigInt(c.totalWei) + BigInt(b.amount)).toString();
        c.txCount += 1;
        c.byBurner[b.from] = (BigInt(c.byBurner[b.from] || '0') + BigInt(b.amount)).toString();
        c.recent.unshift({ from: b.from, amount: b.amount, txHash: b.txHash, blockNumber: b.blockNumber });
      });
      c.recent = c.recent.slice(0, RECENT_KEEP);
      c.lastBlock = r.tip;
      // timestamps for recent burns missing them (cap concurrency)
      var need = c.recent.filter(function (x) { return !x.ts; }).slice(0, RECENT_KEEP);
      var tc = Promise.resolve();
      need.forEach(function (x) {
        tc = tc.then(function () {
          return getBlockTimestamp(x.blockNumber).then(function (ts) { x.ts = ts; }).catch(function () { x.ts = 0; });
        });
      });
      return tc.then(function () {
        c.updatedAt = Date.now();
        saveCache(c);
        return buildStatus(c, false);
      });
    }).catch(function (e) {
      // RPC failed: serve cache, honestly labeled stale
      if (cache.updatedAt) return buildStatus(cache, true, String(e && e.message || e).slice(0, 100));
      return { ok: false, error: 'burn RPC unreachable and no cached snapshot', detail: String(e && e.message || e).slice(0, 120) };
    });
  }

  function buildStatus(c, stale, errDetail) {
    var top = Object.keys(c.byBurner).map(function (a) {
      return { address: a, amountWei: c.byBurner[a], amount: fmtWei(c.byBurner[a]) };
    }).sort(function (x, y) { return (BigInt(y.amountWei) > BigInt(x.amountWei)) ? 1 : -1; }).slice(0, 10);
    var dayAgo = Date.now() - 86400000;
    var burn24h = '0';
    c.recent.forEach(function (x) { if (x.ts && x.ts >= dayAgo) burn24h = (BigInt(burn24h) + BigInt(x.amount)).toString(); });
    return {
      ok: true,
      stale: !!stale,
      error: errDetail || null,
      totalWei: c.totalWei,
      total: fmtWei(c.totalWei),
      txCount: c.txCount,
      burn24h: fmtWei(burn24h),
      lastSyncedAt: c.updatedAt,
      lastSyncedAgo: c.updatedAt ? timeAgo(c.updatedAt) : 'never',
      lastBlock: c.lastBlock,
      contract: RESCUE,
      dead: DEAD,
      recent: c.recent.map(function (x) {
        return { from: x.from, fromShort: fmtAddr(x.from), amount: fmtWei(x.amount), txHash: x.txHash, when: x.ts ? timeAgo(x.ts) : '…' };
      }),
      topBurners: top.map(function (t) { return { address: t.address, short: fmtAddr(t.address), amount: t.amount }; })
    };
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }

  function renderWidget(mount, opts) {
    opts = opts || {};
    var title = opts.title || '🔥 $RESCUE Burn Furnace';
    mount.innerHTML = '<div class="rbw"><div class="rbw-title">' + esc(title) + '</div>' +
      '<div class="rbw-status">syncing with Base…</div></div>';
    getStatus().then(function (s) {
      if (!s.ok) {
        mount.querySelector('.rbw-status').innerHTML =
          '<span class="rbw-err">Burn data unavailable: ' + esc(s.error) + '</span>';
        return;
      }
      var rows = s.recent.slice(0, 5).map(function (r) {
        return '<li><span class="rbw-amt">' + esc(r.amount) + '</span> <span class="rbw-from">' +
          esc(r.fromShort) + '</span> <span class="rbw-when">' + esc(r.when) + '</span></li>';
      }).join('');
      var tops = s.topBurners.slice(0, 5).map(function (t, i) {
        return '<li><span class="rbw-rank">#' + (i + 1) + '</span> <span class="rbw-from">' +
          esc(t.short) + '</span> <span class="rbw-amt">' + esc(t.amount) + '</span></li>';
      }).join('');
      mount.innerHTML =
        '<div class="rbw">' +
        '<div class="rbw-title">' + esc(title) + '</div>' +
        '<div class="rbw-total">' + esc(s.total) + ' <span>$RESCUE burnt</span></div>' +
        '<div class="rbw-meta">' + s.txCount + ' burns • ' + esc(s.burn24h) + ' last 24h • ' +
        'synced ' + esc(s.lastSyncedAgo) + (s.stale ? ' <span class="rbw-stale">(stale — RPC unreachable)</span>' : '') + '</div>' +
        '<div class="rbw-cols"><div><div class="rbw-h">Recent burns</div><ul>' + (rows || '<li>none yet</li>') + '</ul></div>' +
        '<div><div class="rbw-h">Top burners</div><ul>' + (tops || '<li>none yet</li>') + '</ul></div></div>' +
        '<div class="rbw-foot">live from Base • <span class="rbw-mono">' + esc(DEAD.slice(0, 10)) + '…dEaD</span></div>' +
        '</div>';
    }).catch(function (e) {
      var st = mount.querySelector('.rbw-status');
      if (st) st.innerHTML = '<span class="rbw-err">Burn widget failed: ' + esc(String(e).slice(0, 80)) + '</span>';
    });
    return mount;
  }

  global.RescueBurn = {
    getStatus: getStatus,
    renderWidget: renderWidget,
    fmtWei: fmtWei,
    RESCUE: RESCUE,
    DEAD: DEAD,
    CACHE_KEY: CACHE_KEY
  };
})(typeof window !== 'undefined' ? window : globalThis);
