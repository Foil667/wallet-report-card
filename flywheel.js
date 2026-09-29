/* =====================================================================
 * LOOPER RESCUE — $RESCUE flywheel (DEMO)
 * ---------------------------------------------------------------------
 * DEMO SAFETY: everything in this file is a LOCAL SIMULATION. Bounties,
 * escrow, tiers, priority-scan fees, and demo burns live in THIS browser's
 * localStorage only. No wallet is connected, no real $RESCUE moves, and no
 * onchain contract exists. Every UI surface built here is labeled "demo".
 *
 * Flywheel mechanics (demo):
 * - Priority scan: fixed 10 $RESCUE demo fee, split 9 -> bounty pool,
 *   1 -> furnace (recorded in the demo burn ledger).
 * - Proof-of-Rescue bounties: anyone posts a bounty (locks demo funds in
 *   escrow); a rescuer claims it with a plain-text handle; the poster
 *   confirms completion; the protocol burns a 10% cut (demo ledger) and
 *   credits 90% to the rescuer's demo balance. Every split is shown
 *   before confirmation.
 * - Rescuer tiers from completed rescues: Scout (>=1), Hunter (>=3),
 *   Legend (>=10). Per-handle, local demo only.
 *
 * Node-testable: the core store functions use an injectable storage
 * adapter and the module exports itself for require().
 * ===================================================================== */
(function (global) {
  'use strict';

  var LS_KEY = 'foil-rescue-flywheel-v1';
  var DEMO_GRANT = 1000;      // demo funds granted per refill
  var PRIORITY_FEE = 10;      // fixed priority-scan demo fee
  var PRIORITY_SPLIT = { pool: 9, furnace: 1 };
  var BOUNTY_CUT_BPS = 1000;  // 10% of a completed bounty is burned (demo)
  var MIN_BOUNTY = 10;
  var MAX_BOUNTY = 1000000;
  var MAX_TEXT = { title: 80, asset: 60, addrHint: 60, handle: 24, desc: 500 };

  var TIER_STEPS = [
    { min: 10, name: 'Legend' },
    { min: 3, name: 'Hunter' },
    { min: 1, name: 'Scout' },
  ];

  /* ------------------------------ store ------------------------------ */

  function blankState() {
    return {
      v: 1,
      funds: DEMO_GRANT,   // liquid demo $RESCUE
      pool: 0,             // demo bounty pool (from priority fees)
      bounties: [],        // {id,title,asset,addrHint,amount,desc,poster,status,claimedBy,rescuer,createdAt,split}
      rescuers: {},        // handle -> {completed, earned}
      burns: [],           // demo burn ledger {ts, kind, amount, detail}
    };
  }

  function adapter() {
    // Injectable: tests can replace global.__flywheelStorage before load.
    if (global.__flywheelStorage) return global.__flywheelStorage;
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { /* no storage */ }
    return null;
  }

  function loadState() {
    var st = null;
    var a = adapter();
    if (a) {
      try {
        var raw = a.getItem(LS_KEY);
        if (raw) st = JSON.parse(raw);
      } catch (e) { st = null; }
    }
    if (!st || typeof st !== 'object' || st.v !== 1) st = blankState();
    if (typeof st.funds !== 'number') st.funds = DEMO_GRANT;
    if (typeof st.pool !== 'number') st.pool = 0;
    if (!Array.isArray(st.bounties)) st.bounties = [];
    if (!st.rescuers || typeof st.rescuers !== 'object') st.rescuers = {};
    if (!Array.isArray(st.burns)) st.burns = [];
    return st;
  }

  function saveState(st) {
    var a = adapter();
    if (!a) return false;
    try {
      a.setItem(LS_KEY, JSON.stringify(st));
      return true;
    } catch (e) {
      return false;
    }
  }

  function nowMs() { return Date.now(); }

  function makeId() {
    return 'b' + nowMs().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function cleanText(s, max) {
    s = String(s == null ? '' : s).trim();
    if (s.length > max) s = s.slice(0, max);
    return s;
  }

  function escrowHeld(st) {
    var n = 0;
    for (var i = 0; i < st.bounties.length; i++) {
      var b = st.bounties[i];
      if (b.status === 'open' || b.status === 'claimed') n += b.amount;
    }
    return n;
  }

  function tierOf(completed) {
    for (var i = 0; i < TIER_STEPS.length; i++) {
      if (completed >= TIER_STEPS[i].min) return TIER_STEPS[i].name;
    }
    return null;
  }

  function splitBounty(amount) {
    var cut = Math.floor(amount * BOUNTY_CUT_BPS / 10000);
    return { rescuer: amount - cut, furnace: cut };
  }

  /* ---------------------------- operations --------------------------- */

  // Post a bounty: validates, locks the amount in demo escrow (funds -= amount).
  // Returns { ok:true, bounty } or { ok:false, error }.
  function postBounty(st, fields) {
    var title = cleanText(fields.title, MAX_TEXT.title);
    var asset = cleanText(fields.asset, MAX_TEXT.asset);
    var amount = Math.floor(Number(fields.amount));
    if (!title) return { ok: false, error: 'A title is required.' };
    if (!asset) return { ok: false, error: 'An asset type is required.' };
    if (!Number.isFinite(amount) || amount < MIN_BOUNTY || amount > MAX_BOUNTY) {
      return { ok: false, error: 'Bounty must be a whole number between ' + MIN_BOUNTY + ' and ' + MAX_BOUNTY.toLocaleString('en-US') + ' $RESCUE (demo).' };
    }
    if (st.funds < amount) {
      return { ok: false, error: 'Not enough demo funds (' + fmt(st.funds) + ' $RESCUE). Refill or post a smaller bounty.' };
    }
    var poster = cleanText(fields.poster, MAX_TEXT.handle) || 'anon';
    var b = {
      id: makeId(),
      title: title,
      asset: asset,
      addrHint: cleanText(fields.addrHint, MAX_TEXT.addrHint),
      amount: amount,
      desc: cleanText(fields.desc, MAX_TEXT.desc),
      poster: poster,
      status: 'open',
      claimedBy: null,
      rescuer: null,
      createdAt: nowMs(),
      split: null,
    };
    st.funds -= amount;
    st.bounties.unshift(b);
    saveState(st);
    return { ok: true, bounty: b };
  }

  function findBounty(st, id) {
    for (var i = 0; i < st.bounties.length; i++) {
      if (st.bounties[i].id === id) return st.bounties[i];
    }
    return null;
  }

  // Claim an open bounty with a plain-text rescuer handle.
  function claimBounty(st, id, handle) {
    var b = findBounty(st, id);
    if (!b) return { ok: false, error: 'Bounty not found.' };
    if (b.status !== 'open') return { ok: false, error: 'Only open bounties can be claimed.' };
    handle = cleanText(handle, MAX_TEXT.handle);
    if (!handle) return { ok: false, error: 'A rescuer handle is required to claim.' };
    b.status = 'claimed';
    b.claimedBy = handle;
    saveState(st);
    return { ok: true, bounty: b };
  }

  // Complete a claimed bounty: 10% cut burned (demo ledger), 90% credited.
  // Returns the split so the UI can show "90 -> rescuer, 10 -> furnace".
  function completeBounty(st, id) {
    var b = findBounty(st, id);
    if (!b) return { ok: false, error: 'Bounty not found.' };
    if (b.status !== 'claimed') return { ok: false, error: 'Only claimed bounties can be completed.' };
    var split = splitBounty(b.amount);
    b.status = 'completed';
    b.rescuer = b.claimedBy;
    b.split = split;
    st.burns.unshift({
      ts: nowMs(),
      kind: 'bounty-cut',
      amount: split.furnace,
      detail: '10% cut of bounty "' + b.title + '" (' + split.furnace + ' of ' + b.amount + ') -> furnace (demo)',
    });
    var r = st.rescuers[b.rescuer] || { completed: 0, earned: 0 };
    r.completed += 1;
    r.earned += split.rescuer;
    st.rescuers[b.rescuer] = r;
    saveState(st);
    return { ok: true, bounty: b, split: split };
  }

  // Cancel an open bounty: refund escrow to demo funds.
  function cancelBounty(st, id) {
    var b = findBounty(st, id);
    if (!b) return { ok: false, error: 'Bounty not found.' };
    if (b.status !== 'open') return { ok: false, error: 'Only open bounties can be cancelled.' };
    b.status = 'cancelled';
    st.funds += b.amount;
    saveState(st);
    return { ok: true, bounty: b };
  }

  // Priority-scan demo fee: 9 -> bounty pool, 1 -> furnace (demo ledger).
  function priorityScanFee(st) {
    if (st.funds < PRIORITY_FEE) {
      return { ok: false, error: 'Not enough demo funds for the ' + PRIORITY_FEE + ' $RESCUE priority fee.' };
    }
    st.funds -= PRIORITY_FEE;
    st.pool += PRIORITY_SPLIT.pool;
    st.burns.unshift({
      ts: nowMs(),
      kind: 'priority-fee',
      amount: PRIORITY_SPLIT.furnace,
      detail: 'priority-scan fee split ' + PRIORITY_SPLIT.pool + ' -> pool, ' + PRIORITY_SPLIT.furnace + ' -> furnace (demo)',
    });
    saveState(st);
    return { ok: true, split: PRIORITY_SPLIT };
  }

  function refill(st) {
    st.funds = DEMO_GRANT;
    saveState(st);
    return { ok: true, funds: st.funds };
  }

  function rankedRescuers(st) {
    var out = [];
    for (var h in st.rescuers) {
      if (Object.prototype.hasOwnProperty.call(st.rescuers, h)) {
        var r = st.rescuers[h];
        out.push({ handle: h, completed: r.completed, earned: r.earned, tier: tierOf(r.completed) });
      }
    }
    out.sort(function (a, b) { return b.completed - a.completed || b.earned - a.earned; });
    return out;
  }

  function fmt(n) {
    return Number(n).toLocaleString('en-US');
  }

  /* ------------------------------ DOM UI ----------------------------- */
  // All text from user input is inserted via textContent — never innerHTML.

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function timeAgo(ts) {
    var d = Date.now() - ts;
    if (d < 60000) return Math.max(1, Math.round(d / 1000)) + 's ago';
    if (d < 3600000) return Math.round(d / 60000) + 'm ago';
    if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
    return Math.round(d / 86400000) + 'd ago';
  }

  function renderWallet(st) {
    var host = document.getElementById('demo-wallet');
    if (!host) return;
    host.textContent = '';
    host.appendChild(el('span', null, 'Demo funds: '));
    host.appendChild(el('strong', 'mono', fmt(st.funds) + ' $RESCUE'));
    host.appendChild(document.createTextNode('  ·  bounty pool: '));
    host.appendChild(el('strong', 'mono', fmt(st.pool) + ' $RESCUE'));
    host.appendChild(document.createTextNode('  ·  escrow locked: '));
    host.appendChild(el('strong', 'mono', fmt(escrowHeld(st)) + ' $RESCUE'));
    host.appendChild(document.createTextNode('  '));
    var btn = el('button', 'btn-mini', 'Refill demo funds');
    btn.type = 'button';
    btn.title = 'Reset demo funds to ' + fmt(DEMO_GRANT) + ' $RESCUE (demo only)';
    btn.addEventListener('click', function () {
      refill(st);
      renderAll(st);
    });
    host.appendChild(btn);
    var note = el('span', 'fineprint', '  demo only — no real tokens');
    host.appendChild(note);
  }

  function renderBurns(st) {
    var host = document.getElementById('demo-burns');
    if (!host) return;
    host.textContent = '';
    if (!st.burns.length) {
      host.appendChild(el('p', 'muted', 'No demo burns yet on this browser.'));
      return;
    }
    var list = el('div', 'burn-ledger');
    st.burns.slice(0, 25).forEach(function (x) {
      var row = el('div', 'burn-row');
      row.appendChild(el('span', 'mono burn-amt', fmt(x.amount) + ' $RESCUE'));
      row.appendChild(el('span', 'burn-kind', x.kind === 'bounty-cut' ? 'bounty cut' : 'priority fee'));
      row.appendChild(el('span', 'muted', x.detail));
      row.appendChild(el('span', 'muted burn-when', timeAgo(x.ts)));
      list.appendChild(row);
    });
    host.appendChild(list);
  }

  function renderBounties(st) {
    var host = document.getElementById('bounty-list');
    if (!host) return;
    host.textContent = '';
    var live = st.bounties.filter(function (b) { return b.status === 'open' || b.status === 'claimed'; });
    if (!live.length) {
      host.appendChild(el('p', 'muted', 'No bounties yet. Post the first one above — it costs demo funds only.'));
      return;
    }
    live.forEach(function (b) {
      host.appendChild(bountyCard(st, b));
    });
  }

  function bountyCard(st, b) {
    var card = el('div', 'bounty-card bounty-' + b.status);
    var head = el('div', 'bounty-head');
    head.appendChild(el('strong', 'bounty-title', b.title));
    head.appendChild(el('span', 'pill pill-demo status-pill', b.status.toUpperCase() + ' · DEMO'));
    card.appendChild(head);

    var meta = el('p', 'bounty-meta');
    meta.appendChild(el('span', 'mono bounty-amount', fmt(b.amount) + ' $RESCUE'));
    meta.appendChild(document.createTextNode('  ·  asset: '));
    meta.appendChild(el('span', null, b.asset));
    meta.appendChild(document.createTextNode('  ·  posted by '));
    meta.appendChild(el('span', null, b.poster));
    meta.appendChild(document.createTextNode('  ·  ' + timeAgo(b.createdAt)));
    if (b.addrHint) {
      meta.appendChild(document.createTextNode('  ·  hint: '));
      meta.appendChild(el('span', 'mono small', b.addrHint));
    }
    card.appendChild(meta);
    if (b.desc) card.appendChild(el('p', 'bounty-desc', b.desc));

    if (b.status === 'open') {
      card.appendChild(el('p', 'split-line fineprint',
        'On completion: ' + fmt(splitBounty(b.amount).rescuer) + ' → rescuer · ' +
        fmt(splitBounty(b.amount).furnace) + ' → furnace (burned). All demo.'));
      var claimRow = el('div', 'claim-row');
      var handleIn = el('input', 'text-in claim-handle');
      handleIn.type = 'text';
      handleIn.maxLength = MAX_TEXT.handle;
      handleIn.placeholder = 'rescuer handle (plain text, demo)';
      handleIn.setAttribute('aria-label', 'Rescuer handle for bounty ' + b.title);
      var claimBtn = el('button', 'btn-mini', 'Claim');
      claimBtn.type = 'button';
      claimBtn.addEventListener('click', function () {
        var r = claimBounty(st, b.id, handleIn.value);
        if (!r.ok) {
          showBountyError(r.error);
          return;
        }
        clearBountyError();
        renderAll(st);
      });
      claimRow.appendChild(handleIn);
      claimRow.appendChild(claimBtn);
      card.appendChild(claimRow);

      var cancelBtn = el('button', 'btn-mini btn-ghost', 'Cancel & refund escrow');
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', function () {
        var r = cancelBounty(st, b.id);
        if (!r.ok) { showBountyError(r.error); return; }
        clearBountyError();
        renderAll(st);
      });
      card.appendChild(cancelBtn);
    }

    if (b.status === 'claimed') {
      card.appendChild(el('p', null, 'Claimed by '));
      card.lastChild.appendChild(el('strong', null, b.claimedBy));
      var sp = splitBounty(b.amount);
      var confirmBtn = el('button', 'btn-mini', 'Complete — ' + fmt(sp.rescuer) + ' → rescuer, ' + fmt(sp.furnace) + ' → furnace (burned)');
      confirmBtn.type = 'button';
      confirmBtn.title = 'Demo: credits the rescuer, burns the 10% cut in the demo ledger. Click again to confirm.';
      var armed = false;
      confirmBtn.addEventListener('click', function () {
        if (!armed) {
          armed = true;
          confirmBtn.textContent = 'Click again to confirm completion (demo)';
          confirmBtn.classList.add('armed');
          return;
        }
        var r = completeBounty(st, b.id);
        if (!r.ok) { showBountyError(r.error); return; }
        clearBountyError();
        renderAll(st);
      });
      card.appendChild(confirmBtn);
    }
    return card;
  }

  function renderTiers(st) {
    var host = document.getElementById('tier-board');
    if (!host) return;
    host.textContent = '';
    var rows = rankedRescuers(st);
    if (!rows.length) {
      host.appendChild(el('p', 'muted', 'No rescuers yet. Complete a bounty to earn a tier.'));
      return;
    }
    var table = el('table', 'tier-table');
    var thead = el('thead');
    var hr = el('tr');
    ['Rescuer', 'Tier', 'Completed', 'Earned (demo)'].forEach(function (h) {
      hr.appendChild(el('th', null, h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', null, r.handle));
      var tdTier = el('td');
      tdTier.appendChild(el('span', 'tier-pill tier-' + r.tier.toLowerCase(), r.tier));
      tr.appendChild(tdTier);
      tr.appendChild(el('td', 'mono', String(r.completed)));
      tr.appendChild(el('td', 'mono', fmt(r.earned) + ' $RESCUE'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }

  function renderAll(st) {
    renderWallet(st);
    renderBurns(st);
    renderBounties(st);
    renderTiers(st);
  }

  function showBountyError(msg) {
    var box = document.getElementById('bounty-error');
    if (!box) return;
    box.hidden = false;
    box.textContent = msg;
  }
  function clearBountyError() {
    var box = document.getElementById('bounty-error');
    if (!box) return;
    box.hidden = true;
    box.textContent = '';
  }

  function wireBountyForm(st) {
    var form = document.getElementById('bounty-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var r = postBounty(st, {
        title: document.getElementById('b-title').value,
        asset: document.getElementById('b-asset').value,
        addrHint: document.getElementById('b-addr').value,
        amount: document.getElementById('b-amount').value,
        desc: document.getElementById('b-desc').value,
        poster: document.getElementById('b-poster').value,
      });
      if (!r.ok) {
        showBountyError(r.error);
        return;
      }
      clearBountyError();
      form.reset();
      renderAll(st);
    });
  }

  // Priority scan hook: capture-phase listener runs BEFORE app.js's own
  // (bubble-phase) submit handler, so a failed demo fee can block the scan.
  function wirePriorityScan(st) {
    var form = document.getElementById('scan-form');
    var box = document.getElementById('priority-scan');
    var receipt = document.getElementById('priority-receipt');
    if (!form || !box) return;
    form.addEventListener('submit', function (ev) {
      if (!box.checked) return;
      var r = priorityScanFee(st);
      if (!r.ok) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        box.checked = false;
        if (receipt) {
          receipt.hidden = false;
          receipt.textContent = 'Priority fee failed: ' + r.error + ' — normal scan not started.';
        }
        return;
      }
      renderAll(st);
      if (receipt) {
        receipt.hidden = false;
        receipt.textContent = 'Priority (demo): paid ' + PRIORITY_FEE + ' $RESCUE — ' +
          r.split.pool + ' → bounty pool, ' + r.split.furnace + ' → furnace (burned). No real tokens moved.';
      }
    }, true);
  }

  function wireFurnace() {
    var mount = document.getElementById('burn-widget');
    if (!mount) return;
    if (typeof RescueBurn === 'undefined' || !RescueBurn.renderWidget) {
      mount.textContent = '';
      mount.appendChild(el('p', 'muted', 'Burn widget unavailable — the burn module failed to load.'));
      return;
    }
    RescueBurn.renderWidget(mount, { title: '🔥 $RESCUE Burn Furnace (live onchain)' });
  }

  function initUI() {
    var st = loadState();
    renderAll(st);
    wireBountyForm(st);
    wirePriorityScan(st);
    wireFurnace();
  }

  var Flywheel = {
    // store (testable)
    loadState: loadState,
    saveState: saveState,
    blankState: blankState,
    postBounty: postBounty,
    claimBounty: claimBounty,
    completeBounty: completeBounty,
    cancelBounty: cancelBounty,
    priorityScanFee: priorityScanFee,
    refill: refill,
    tierOf: tierOf,
    splitBounty: splitBounty,
    rankedRescuers: rankedRescuers,
    escrowHeld: escrowHeld,
    fmt: fmt,
    // constants
    LS_KEY: LS_KEY,
    DEMO_GRANT: DEMO_GRANT,
    PRIORITY_FEE: PRIORITY_FEE,
    PRIORITY_SPLIT: PRIORITY_SPLIT,
    BOUNTY_CUT_BPS: BOUNTY_CUT_BPS,
    MIN_BOUNTY: MIN_BOUNTY,
    MAX_BOUNTY: MAX_BOUNTY,
    // UI
    initUI: initUI,
  };

  global.Flywheel = Flywheel;
  if (typeof module !== 'undefined' && module.exports) module.exports = Flywheel;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUI);
    } else {
      initUI();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
