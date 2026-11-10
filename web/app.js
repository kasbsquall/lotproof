// Lotproof customer view. Everything on screen comes from the Lotproof API.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const POLL_MS = 1000;
const STARTING_RETRY_MS = 3000;
const SOUND_KEY = 'lotproof-sound';

const S = {
  state: null,
  sel: null,
  job: null,
  muted: true,
  supplier: new Map(),
  shownDisclosed: new Map(), // lotId -> Set of disclosed indexes already animated
  chartSig: '',
  railEntered: false,
};

/* ---------- formatting ---------- */
const mm = (um) => (um / 1000).toFixed(3);
const short = (h, a = 8, b = 8) => (h && h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h ?? '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmtTime = (iso, withDate = true) => {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return withDate ? `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${t}` : t;
};
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};
const signUm = (d) => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0');
const netName = (n) => (n === 'preview' ? 'Midnight Preview testnet' : n === 'local' ? 'Local devnet' : n ? `Network ${n}` : 'Unknown network');
const tolText = (sp) => {
  const up = sp.upperUm - sp.nominalUm, lo = sp.nominalUm - sp.lowerUm;
  return up === lo ? `${mm(sp.nominalUm)} ± ${mm(up)} mm` : `${mm(sp.lowerUm)} to ${mm(sp.upperUm)} mm`;
};
const proven = (l) => l.status === 'accepted' || l.status === 'rejected';
const outOf = (l) => l.sampleSize - l.inTolerance;
const inBand = (sp, v) => v >= sp.lowerUm && v <= sp.upperUm;
const txOf = (l, step) => (l.txs || []).filter((t) => t.step === step);

/* ---------- API ---------- */
async function api(path, opt = {}) {
  let res;
  try {
    res = await fetch(path, { cache: 'no-store', ...opt });
  } catch {
    const e = new Error('Cannot reach the Lotproof service.');
    e.kind = 'network';
    throw e;
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const e = new Error(body?.error || `The service answered HTTP ${res.status}.`);
    e.status = res.status;
    e.kind = res.status === 503 ? 'starting' : res.status === 429 ? 'limit' : 'http';
    throw e;
  }
  return body;
}

/* ---------- sound ---------- */
const SND = {};
for (const k of ['click', 'accepted', 'rejected', 'disclosed']) {
  const a = new Audio(`sounds/${k}.ogg`);
  a.preload = 'auto';
  a.volume = 0.28;
  SND[k] = a;
}
function play(k) {
  if (S.muted || !SND[k]) return;
  try { SND[k].currentTime = 0; SND[k].play().catch(() => {}); } catch { /* ignore */ }
}
try { S.muted = localStorage.getItem(SOUND_KEY) !== 'on'; } catch { S.muted = true; }
function setMuteUI() {
  const b = $('#soundBtn');
  b.setAttribute('aria-pressed', String(!S.muted));
  b.setAttribute('aria-label', S.muted ? 'Turn sounds on' : 'Turn sounds off');
  b.title = S.muted ? 'Sounds off' : 'Sounds on';
  $('i', b).className = `ph-light ${S.muted ? 'ph-speaker-simple-slash' : 'ph-speaker-simple-high'}`;
}
$('#soundBtn').onclick = () => {
  S.muted = !S.muted;
  try { localStorage.setItem(SOUND_KEY, S.muted ? 'off' : 'on'); } catch { /* ignore */ }
  setMuteUI();
  play('click');
};
setMuteUI();

/* ---------- toast ---------- */
function toast(text, { icon = 'ph-info', retry = null, ms = 2600 } = {}) {
  const t = $('#toast');
  $('#toastTxt').textContent = text;
  $('i', t).className = `ph-light ${icon}`;
  const b = $('#toastBtn');
  b.hidden = !retry;
  b.onclick = retry ? () => { t.classList.remove('show'); retry(); } : null;
  t.classList.add('show');
  clearTimeout(toast.t);
  if (!retry) toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- network pill ---------- */
function setNet(kind, network) {
  const n = $('#net');
  n.className = `net ${kind}`;
  const full = kind === 'ok' ? netName(network) : kind === 'wait' ? 'Service starting' : 'Service unreachable';
  const short = kind === 'ok' ? (network === 'preview' ? 'Preview' : network === 'local' ? 'Local' : full) : kind === 'wait' ? 'Starting' : 'Offline';
  $('.lbl', n).innerHTML = `<span class="full">${esc(full)}</span><span class="short">${esc(short)}</span>`;
  n.title = kind === 'ok' ? `Reading the contract on ${netName(network)}` : '';
}

/* ---------- state ---------- */
async function loadState({ select = null, adoptNew = null } = {}) {
  try {
    const st = await api('/api/state');
    S.state = st;
    setNet('ok', st.network);
    if (adoptNew) {
      const fresh = st.lots.find((l) => !adoptNew.has(l.id));
      if (fresh) S.sel = fresh.id;
    }
    if (select) S.sel = select;
    if (!S.sel || !st.lots.some((l) => l.id === S.sel)) {
      const fromHash = new URLSearchParams(location.hash.slice(1)).get('lot');
      S.sel = st.lots.find((l) => l.label === fromHash)?.id ?? st.lots[0]?.id ?? null;
    }
    renderAll();
    return st;
  } catch (e) {
    if (e.kind === 'starting') {
      setNet('wait');
      if (!S.state) showNotice('wait');
      setTimeout(() => loadState({ select, adoptNew }), STARTING_RETRY_MS);
      return null;
    }
    setNet('err');
    if (!S.state) showNotice('error', e.message);
    else toast(`${e.message} Showing the last data read from the contract.`, { icon: 'ph-wifi-slash', retry: () => loadState({ select }) });
    return null;
  }
}

function currentLot() {
  return S.state?.lots.find((l) => l.id === S.sel) ?? null;
}

/* ---------- notices ---------- */
function showNotice(kind, msg = '') {
  const n = $('#notice');
  const busy = isBusy();
  const html = {
    wait: `<i class="ph-light ph-hourglass-medium spin"></i><h2>The Midnight service is starting</h2><p>It is connecting to the network and reading the contract. This page retries every ${STARTING_RETRY_MS / 1000} s.</p>`,
    error: `<i class="ph-light ph-wifi-slash"></i><h2>Cannot reach the Lotproof service</h2><p>${esc(msg)} Check that the service is running on this address, then retry.</p><div class="row"><button class="btn" type="button" id="retryBtn"><i class="ph-light ph-arrow-clockwise"></i>Retry</button></div>`,
    empty: `<i class="ph-light ph-ruler"></i><h2>No lots on the contract yet</h2><p>Measure a lot: the demo station measures 32 parts, commits their hash on ${esc(netName(S.state?.network))}, and the supplier proves how many are inside the band. Each transaction takes about 20 s.</p><div class="row"><button class="btn primary" type="button" id="emptyMeasure" ${busy ? 'disabled' : ''}><i class="ph-light ph-ruler"></i>Measure a new lot</button></div>`,
  }[kind];
  n.className = `notice ${kind === 'error' ? 'err' : kind}`;
  n.innerHTML = html;
  n.hidden = false;
  $('#lotView').hidden = true;
  $('#retryBtn')?.addEventListener('click', () => { n.hidden = true; $('#lotView').hidden = false; loadState(); });
  $('#emptyMeasure')?.addEventListener('click', startMeasure);
  if (kind !== 'empty') {
    $('#lotName').textContent = kind === 'wait' ? 'Starting' : 'Offline';
    $('#lotName').className = '';
    $('#crumb').innerHTML = '<span>Lotproof customer view</span>';
    $('#groups').innerHTML = `<p class="rail-foot" style="margin-top:22px">${kind === 'wait' ? 'Waiting for the contract.' : 'No data. The service did not answer.'}</p>`;
  }
}

/* ---------- index rail ---------- */
const STATUS = {
  accepted: { icon: 'ph-check-circle', cls: 'st-ok', badge: 'ok', text: 'Accepted' },
  rejected: { icon: 'ph-x-circle', cls: 'st-bad', badge: 'bad', text: 'Rejected' },
  refused: { icon: 'ph-prohibit', cls: 'st-bad', badge: 'bad', text: 'Proof refused' },
  committed: { icon: 'ph-circle-dashed', cls: 'st-pend spin', badge: 'pend', text: 'Proof pending' },
  measuring: { icon: 'ph-hourglass-medium', cls: 'st-pend spin', badge: 'pend', text: 'Measuring' },
};
const st = (l) => STATUS[l.status] ?? STATUS.measuring;
function subText(l) {
  if (l.status === 'accepted') return outOf(l) ? `Accepted, ${outOf(l)} out` : 'Accepted';
  if (l.status === 'rejected') return `Rejected, ${outOf(l)} out`;
  if (l.status === 'refused') return 'Proof refused';
  if (l.status === 'committed') return 'Committed, proof pending';
  return 'Measuring';
}

function renderIndex() {
  const { lots, spec } = S.state;
  const f = $('#q').value.trim().toLowerCase();
  const items = lots.filter((l) => !f || l.label.toLowerCase().includes(f));
  const g = $('#groups');
  if (!S.railEntered) {
    g.classList.add('enter');
    setTimeout(() => g.classList.remove('enter'), 700);
  }
  S.railEntered = true;
  g.innerHTML = `<div class="group"><h3>${esc(spec.id)} <span>${plural(lots.length, 'lot', 'lots')}</span></h3>${
    items.map((l, i) => {
      const s = st(l);
      const ct = proven(l) ? `${l.inTolerance}/${l.sampleSize}` : '';
      return `<button class="lot" type="button" style="--i:${Math.min(i, 7)}" data-id="${l.id}" aria-current="${l.id === S.sel}"><i class="ph-light ${s.icon} ${s.cls}" aria-hidden="true"></i><span><span class="nm">${esc(l.label)}</span><span class="sub">${esc(subText(l))}</span></span><span class="ct num">${ct}</span></button>`;
    }).join('') || `<p class="rail-foot" style="margin-top:8px">${lots.length ? `No lot matches "${esc(f)}".` : 'No lots yet.'}</p>`
  }</div>`;
  const sel = $('#lotSel');
  sel.disabled = !lots.length;
  sel.innerHTML = lots.length
    ? lots.map((l) => `<option value="${l.id}" ${l.id === S.sel ? 'selected' : ''}>${esc(l.label)}  ${proven(l) ? `${l.inTolerance}/${l.sampleSize}  ` : ''}${esc(subText(l))}</option>`).join('')
    : '<option>No lots yet</option>';
}
$('#groups').addEventListener('click', (e) => {
  const b = e.target.closest('.lot');
  if (b) selectLot(b.dataset.id);
});
$('#groups').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const bs = $$('.lot', $('#groups'));
  const i = bs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : Math.max(0, Math.min(bs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  bs[j].focus();
});
$('#q').oninput = () => S.state && renderIndex();
$('#lotSel').onchange = (e) => selectLot(e.target.value);

function selectLot(id) {
  if (id === S.sel) return;
  S.sel = id;
  play('click');
  renderAll();
}

/* ---------- lot view ---------- */
function renderAll() {
  if (!S.state) return;
  renderIndex();
  setButtons();
  const lot = currentLot();
  if (!lot) {
    $('#lotName').textContent = 'No lots yet';
    $('#lotName').className = '';
    $('#badge').hidden = true;
    $('#crumb').innerHTML = `<i class="ph-light ph-file-text"></i><span>Drawing ${esc(S.state.spec.id)}</span>`;
    showNotice('empty');
    return;
  }
  $('#notice').hidden = true;
  $('#lotView').hidden = false;
  try { history.replaceState(null, '', `#lot=${encodeURIComponent(lot.label)}`); } catch { /* ignore */ }
  renderLot(lot);
}

function summaryHTML(l, sp) {
  const lim = `the customer's limit of ${plural(sp.maxDefects, 'defect', 'defects')}`;
  if (l.status === 'accepted') return `<strong>${l.inTolerance} of ${l.sampleSize} parts</strong> inside ${tolText(sp)}. <strong class="in">Accepted</strong> under ${lim}.`;
  if (l.status === 'rejected') return `<strong>${l.inTolerance} of ${l.sampleSize} parts</strong> inside ${tolText(sp)}. <strong class="out">Rejected</strong>: ${plural(outOf(l), 'part', 'parts')} out, over ${lim}.`;
  if (l.status === 'refused') return `<strong class="out">${esc(l.refused || 'The contract refused the proof')}.</strong> The numbers changed after the station committed them, so the contract recorded no count.`;
  if (l.status === 'committed') return `The station committed <strong>${l.sampleSize} measurements</strong> on-chain. <strong class="pnd">Proof pending</strong>: no count yet.`;
  return `The station is measuring. Nothing is on-chain for this lot yet.`;
}

function sinceText(l) {
  const net = netName(S.state.network);
  const c = txOf(l, 'commitLot')[0], p = txOf(l, 'proveLot')[0];
  const cs = c ? `Station commitment at block ${c.blockHeight}, ${fmtTime(c.at)}.` : '';
  if (p) return `Proof recorded at block ${p.blockHeight} on ${net}, ${fmtTime(p.at)}. ${cs}`;
  if (l.status === 'refused') return `${cs} The proof attempt was refused by the contract and left no transaction.`;
  if (c) return `${cs} On ${net}.`;
  return `Lot created ${fmtTime(l.createdAt)}.`;
}

function renderLot(l) {
  const sp = S.state.spec;
  const s = st(l);
  $('#crumb').innerHTML = `<i class="ph-light ph-file-text"></i><span>Drawing ${esc(sp.id)}</span><i class="ph-light ph-caret-right"></i><span class="num">Lot created ${esc(fmtTime(l.createdAt))}</span>`;
  $('#lotName').textContent = l.label;
  $('#lotName').className = '';
  const b = $('#badge');
  b.hidden = false;
  b.className = `badge ${s.badge}`;
  b.innerHTML = `<i class="ph-light ${s.icon}"></i>${s.text}`;
  $('#summary').innerHTML = summaryHTML(l, sp);
  $('#since').textContent = sinceText(l);

  const h = $('#heroN');
  if (proven(l)) {
    h.className = `hero-n num${l.status === 'rejected' ? ' bad' : ''}`;
    h.innerHTML = `<span>${l.inTolerance}</span><small>/ ${l.sampleSize}</small><span class="u">parts</span>`;
  } else {
    h.className = 'hero-n none';
    h.innerHTML = l.status === 'refused'
      ? 'No count recorded<small>The contract refused the proof.</small>'
      : `No count yet<small>${l.status === 'committed' ? 'Waiting for the supplier proof.' : 'Waiting for the station commitment.'}</small>`;
  }
  $('#bandV').textContent = `${mm(sp.lowerUm)} to ${mm(sp.upperUm)} mm`;
  $('#bandN').textContent = `nominal ${mm(sp.nominalUm)}, ${tolText(sp).includes('±') ? `± ${mm(sp.upperUm - sp.nominalUm)} mm` : 'asymmetric band'}`;
  $('#accV').textContent = `at most ${plural(sp.maxDefects, 'part', 'parts')} out`;
  $('#accN').textContent = proven(l) ? `${outOf(l)} out of ${l.sampleSize} parts` : 'no count recorded';
  const reg = S.state.setupTxs.find((t) => t.step === 'registerStation');
  $('#stV').innerHTML = l.station ? `<span class="mono">key ${esc(short(l.station, 6, 4))}</span>` : '<span class="st-mute">not committed yet</span>';
  $('#stN').textContent = reg?.blockHeight ? `registered on-chain at block ${reg.blockHeight}` : 'registered on-chain';

  const sig = JSON.stringify([l.id, l.status, l.inTolerance, l.disclosed, sp, innerWidth < 600]);
  if (sig !== S.chartSig) {
    S.chartSig = sig;
    renderChart(l, sp);
  }
  const nd = (l.disclosed || []).length;
  $('#privTxt').textContent = nd
    ? `${l.sampleSize - nd} of ${l.sampleSize} measurements, and the positions of the parts outside the band. ${nd === 1 ? 'One part was' : `${nd} parts were`} disclosed by the supplier.`
    : 'Every measurement, and which parts are the ones outside the band. Marks sit flat because their height is not known to you.';
  renderTrail(l, sp);
  renderContract();
}

/* ---------- chart ---------- */
function renderChart(l, sp) {
  const narrow = innerWidth < 600;
  const W = narrow ? 360 : 1000, H = narrow ? 320 : 316;
  const X0 = narrow ? 48 : 74, X1 = W - (narrow ? 8 : 20);
  const Y_T = 26, Y_B = 240, OUT_Y = 282;
  const span = sp.upperUm - sp.lowerUm;
  const disc = l.disclosed || [];
  let top = sp.upperUm + span * 0.5, bot = sp.lowerUm - span * 0.5;
  for (const d of disc) { top = Math.max(top, d.valueUm + span * 0.15); bot = Math.min(bot, d.valueUm - span * 0.15); }
  const y = (um) => Y_T + ((top - um) / (top - bot)) * (Y_B - Y_T);
  const yU = y(sp.upperUm), yL = y(sp.lowerUm), yN = y(sp.nominalUm);
  const n = l.sampleSize || 32;
  const xIdx = (i) => X0 + ((i + 0.5) * (X1 - X0)) / n;
  const r = narrow ? 3.2 : 5;
  const discIn = disc.filter((d) => inBand(sp, d.valueUm)).length;
  const discOut = disc.length - discIn;

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chartLabel(l, sp))}">`;
  s += `<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="oklch(88% .01 250)" stroke-width="1"/></pattern></defs>`;
  s += `<rect x="${X0}" y="${Y_T}" width="${X1 - X0}" height="${yU - Y_T}" fill="url(#hatch)" opacity=".55"/>`;
  s += `<rect x="${X0}" y="${yL}" width="${X1 - X0}" height="${Y_B - yL}" fill="url(#hatch)" opacity=".55"/>`;
  s += `<rect class="band-fill" x="${X0}" y="${yU}" width="${X1 - X0}" height="${yL - yU}" fill="var(--banda)"/>`;
  for (const [um, strong] of [[top, false], [sp.upperUm, true], [sp.nominalUm, true], [sp.lowerUm, true], [bot, false]]) {
    s += `<text class="axis ${strong ? 'strong' : ''}" x="${X0 - 10}" y="${y(um) + 4}" text-anchor="end">${mm(Math.round(um))}</text>`;
  }
  s += `<line class="nom" x1="${X0}" x2="${X1}" y1="${yN}" y2="${yN}"/>`;
  s += `<line class="lim" pathLength="1" x1="${X0}" x2="${X1}" y1="${yU}" y2="${yU}"/>`;
  s += `<line class="lim" pathLength="1" x1="${X0}" x2="${X1}" y1="${yL}" y2="${yL}"/>`;
  s += `<line class="lane" x1="${X0}" x2="${X1}" y1="${OUT_Y - 18}" y2="${OUT_Y - 18}"/>`;
  s += `<text class="axis" x="${X0 - 10}" y="${OUT_Y + 4}" text-anchor="end">out</text>`;

  // Undisclosed marks: identical, evenly spaced on the nominal line. No index, no height.
  const flat = proven(l) ? l.inTolerance - discIn : (l.status === 'measuring' ? 0 : n);
  const cls = proven(l) ? 'in' : l.status === 'refused' ? 'refused' : 'hollow';
  const rowX = (j) => X0 + ((j + 0.5) * (X1 - X0)) / Math.max(flat, 1);
  s += `<g class="${l.status === 'committed' ? 'pending-row' : ''}">`;
  for (let j = 0; j < flat; j++) s += `<g class="mk mkin" style="--i:${Math.min(j, 7)}"><circle class="${cls}" cx="${rowX(j).toFixed(1)}" cy="${yN}" r="${r}"/></g>`;
  s += '</g>';

  // Out-of-band marks: a count only, stacked apart, no position.
  const outN = proven(l) ? Math.max(0, outOf(l) - discOut) : 0;
  const gap = narrow ? 11 : 15;
  for (let j = 0; j < outN; j++) s += `<g class="mk mkin" style="--i:${Math.min(j, 7)}"><circle class="out" cx="${X0 + 10 + j * gap}" cy="${OUT_Y}" r="${r}"/></g>`;
  const outCap = !proven(l) ? (l.status === 'refused' ? 'No count: the proof was refused' : 'No count yet')
    : outN ? `${plural(outN, 'part', 'parts')} out of band, ${outN === 1 ? 'position' : 'positions'} private`
    : outOf(l) ? 'Every part out of band was disclosed' : 'No parts out of band';
  s += `<text class="axis cap" x="${X0 + 10 + Math.max(outN, 0) * gap + (outN ? 6 : -10)}" y="${OUT_Y + 4}">${esc(outCap)}</text>`;

  // Disclosed parts: real index, real height, real value.
  const animate = [];
  const seen = S.shownDisclosed.get(l.id) ?? new Set();
  let outSlot = outN;
  const callouts = [];
  for (const d of disc) {
    const isIn = inBand(sp, d.valueUm);
    const cx = xIdx(d.index), cy = y(d.valueUm);
    const fromX = isIn ? rowX(Math.floor(flat / 2)) : X0 + 10 + (outSlot++) * gap;
    const fromY = isIn ? yN : OUT_Y;
    const dev = d.valueUm - sp.nominalUm;
    const lbl = `#${d.index + 1}  ${mm(d.valueUm)} mm  ${signUm(dev)} µm`;
    const w = lbl.length * 7.3 + 16;
    const bx = Math.max(X0, Math.min(cx + 12, X1 - w));
    const below = d.valueUm < sp.nominalUm ? cy + 34 <= OUT_Y - 20 : cy - 32 < 2;
    const by = below ? cy + 12 : cy - 32;
    const k = isIn ? 'in' : 'out';
    s += `<g class="mk dsc" data-idx="${d.index}" data-dx="${(fromX - cx).toFixed(1)}" data-dy="${(fromY - cy).toFixed(1)}">`;
    s += `<line class="lead" x1="${cx}" x2="${cx}" y1="${cy}" y2="${yN}" stroke="var(--${isIn ? 'dentro' : 'fuera'})"/>`;
    s += `<circle class="ring ${k}" cx="${cx}" cy="${cy}" r="${narrow ? 7 : 10}"/>`;
    s += `<circle class="dsc-${k}" cx="${cx}" cy="${cy}" r="${r + 0.6}"/>`;
    callouts.push({ x: bx, y: by, w, h: 22 });
    s += `<g class="callout"><rect x="${bx}" y="${by}" width="${w}" height="22" rx="4"/><text x="${bx + 8}" y="${by + 15}">${esc(lbl)}</text></g>`;
    s += `<text class="axis strong" x="${cx}" y="${H - 6}" text-anchor="middle">#${d.index + 1}</text>`;
    s += '</g>';
    if (!seen.has(d.index)) animate.push(d.index);
  }
  // Band labels sit at the right edge unless a disclosed part's callout covers them.
  for (const [txt, ly] of [[`upper ${mm(sp.upperUm)} mm`, yU - 6], [`lower ${mm(sp.lowerUm)} mm`, yL + 15]]) {
    const lw = txt.length * 6.6;
    const hit = callouts.some((c) => c.x < X1 && c.x + c.w > X1 - lw && c.y < ly + 3 && c.y + c.h > ly - 11);
    s += hit ? `<text class="axis" x="${X0 + 6}" y="${ly}">${txt}</text>` : `<text class="axis" x="${X1}" y="${ly}" text-anchor="end">${txt}</text>`;
  }
  if (!disc.length) s += `<text class="axis cap" x="${X0}" y="${H - 6}">${proven(l) ? 'Parts are not placed by position: the proof gives a count.' : ''}</text>`;
  s += '</svg>';

  const foot = l.status === 'committed' ? 'Station commitment is on-chain. Marks stay hollow until the supplier proves the count.'
    : l.status === 'refused' ? 'The contract refused the proof. No count was recorded for this lot.'
    : l.status === 'measuring' ? 'The station has not committed this lot yet.'
    : disc.length ? `Only ${disc.length === 1 ? 'the disclosed part sits' : 'disclosed parts sit'} at real height, at ${disc.length === 1 ? 'its' : 'their'} position in the lot. The other marks carry no value.`
    : 'Marks inside the band are identical and sit on the nominal line. Their values stay with the supplier.';
  const last = [...(l.txs || [])].sort((a, b) => b.at.localeCompare(a.at))[0];
  const c = $('#chart');
  c.innerHTML = s + `<div class="chart-foot"><span>${esc(foot)}</span><span class="num">${last ? `Last transaction ${esc(fmtTime(last.at))}` : ''}</span></div>`;
  c.classList.remove('draw');
  void c.offsetWidth;
  c.classList.add('draw');

  // Signature moment: a disclosed mark leaves the flat row (or the out pile) and rises to its real height.
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const g of $$('.dsc', c)) {
    const idx = Number(g.dataset.idx);
    if (!animate.includes(idx) || reduce) continue;
    g.style.transition = 'none';
    g.style.transform = `translate(${g.dataset.dx}px, ${g.dataset.dy}px)`;
    g.classList.add('from');
    void g.getBoundingClientRect();
    g.style.transition = '';
    setTimeout(() => { g.style.transform = ''; g.classList.remove('from'); }, 620);
  }
  disc.forEach((d) => seen.add(d.index));
  S.shownDisclosed.set(l.id, seen);
}

function chartLabel(l, sp) {
  const band = `band ${mm(sp.lowerUm)} to ${mm(sp.upperUm)} mm`;
  if (!proven(l)) return `Tolerance chart for ${l.label}, ${band}. ${l.status === 'refused' ? 'Proof refused, no count.' : 'No count yet.'}`;
  const d = (l.disclosed || []).map((x) => `part ${x.index + 1} disclosed at ${mm(x.valueUm)} mm`).join(', ');
  return `Tolerance chart for ${l.label}, ${band}. ${l.inTolerance} of ${l.sampleSize} parts inside, ${outOf(l)} outside.${d ? ` ${d}.` : ''}`;
}

let rz;
addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => { const l = currentLot(); if (l) renderLot(l); }, 150);
});

/* ---------- proof trail ---------- */
function hashCell(h) {
  if (!h) return '<span class="dim">no transaction</span>';
  // Explorer URL format for Preview could not be verified, so hashes are copy-only.
  return `<span class="hash"><span class="mono" title="${esc(h)}">${esc(short(h))}</span><button class="copy" type="button" aria-label="Copy transaction hash" data-copy="${esc(h)}"><i class="ph-light ph-copy"></i></button></span>`;
}
function renderTrail(l, sp) {
  const rows = [];
  const row = (icon, what, who, t, block, tx, status) => rows.push(
    `<tr style="--i:${rows.length}"><td><div class="what"><i class="ph-light ${icon}"></i>${what}</div><div class="who">${who}</div></td><td data-l="Time" class="num">${t}</td><td data-l="Block" class="r num">${block}</td><td data-l="Transaction">${tx}</td><td data-l="Status">${status}</td></tr>`);
  const ok = (t) => `<span class="chip st-ok"><i class="ph-light ph-check"></i>${t}</span>`;
  for (const c of txOf(l, 'commitLot')) {
    row('ph-fingerprint', 'Station commitment', `commitLot, hash ${esc(short(l.commitment, 6, 4))} of ${l.sampleSize ?? 32} salted values`, esc(fmtTime(c.at)), c.blockHeight ?? '–', hashCell(c.txHash), ok('On-chain'));
  }
  for (const p of txOf(l, 'proveLot')) {
    row('ph-seal-check', 'Supplier proof', proven(l) ? `proveLot, ${l.inTolerance} of ${l.sampleSize} inside` : 'proveLot', esc(fmtTime(p.at)), p.blockHeight ?? '–', hashCell(p.txHash), ok('Verified'));
  }
  if (l.status === 'refused') {
    row('ph-prohibit st-bad', 'Supplier proof attempt', `"${esc(l.refused)}"`, '<span class="dim">not recorded</span>', '<span class="dim">–</span>', '<span class="dim">no transaction</span>', '<span class="chip st-bad"><i class="ph-light ph-x"></i>Refused by the contract</span>');
  } else if (l.status === 'committed') {
    row('ph-hourglass-medium st-pend', 'Supplier proof', 'proveLot, count inside the band', '<span class="dim">waiting</span>', '<span class="dim">–</span>', '<span class="dim">–</span>', '<span class="chip st-pend"><i class="ph-light ph-circle-dashed"></i>Pending</span>');
  }
  const dtx = txOf(l, 'disclosePart'), disc = l.disclosed || [];
  dtx.forEach((d) => {
    // The API does not tie a disclosePart transaction to its part, so the part is named only when there is exactly one of each.
    const one = dtx.length === 1 && disc.length === 1 ? disc[0] : null;
    const who = one ? `disclosePart, #${one.index + 1} at ${mm(one.valueUm)} mm, ${inBand(sp, one.valueUm) ? 'inside' : 'outside'} the band` : 'disclosePart, value shown on the chart';
    row('ph-eye', one ? `Part #${one.index + 1} disclosed` : 'Part disclosed', who, esc(fmtTime(d.at)), d.blockHeight ?? '–', hashCell(d.txHash), ok('Matches commitment'));
  });
  if (!rows.length) row('ph-hourglass-medium st-pend', 'Station commitment', 'commitLot', '<span class="dim">waiting</span>', '–', '–', '<span class="chip st-pend">Pending</span>');
  $('#tbody').innerHTML = rows.join('');
}

function renderContract() {
  const { contractAddress: a, network, setupTxs } = S.state;
  const setup = (setupTxs || []).map((t) => `<span>${esc(t.step)}</span><span class="num">${t.blockHeight ? `block ${t.blockHeight}` : 'block not reported'}</span><span class="num">${esc(fmtTime(t.at))}</span>${hashCell(t.txHash)}`).join('');
  $('#contract').innerHTML = `<span class="it"><i class="ph-light ph-file-code"></i>Contract <span class="mono" title="${esc(a)}">${esc(short(a))}</span><button class="copy" type="button" aria-label="Copy contract address" data-copy="${esc(a)}"><i class="ph-light ph-copy"></i></button></span>`
    + `<span class="it"><i class="ph-light ph-globe-simple"></i>${esc(netName(network))}${network === 'local' ? ', no public explorer' : ''}</span>`
    + `<span class="it num"><i class="ph-light ph-seal-check"></i>${plural(S.state.provenLots, 'lot', 'lots')} proven on this contract</span>`
    + (setup ? `<details><summary><i class="ph-light ph-caret-right car"></i>Contract setup, ${plural(setupTxs.length, 'transaction', 'transactions')}</summary><div class="setup">${setup}</div></details>` : '');
}

document.addEventListener('click', async (e) => {
  const c = e.target.closest('.copy');
  if (!c) return;
  try {
    await navigator.clipboard.writeText(c.dataset.copy);
    c.innerHTML = '<i class="ph-light ph-check"></i>';
    play('click');
    toast('Copied to the clipboard', { icon: 'ph-copy', ms: 1400 });
    setTimeout(() => { c.innerHTML = '<i class="ph-light ph-copy"></i>'; }, 1200);
  } catch {
    toast('The browser blocked the clipboard. Select the hash from the tooltip instead.', { icon: 'ph-warning' });
  }
});

$('#verifyBtn').onclick = () => {
  play('click');
  const p = $('#proofs');
  p.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  $('#proofsH').focus({ preventScroll: true });
  const t = $('#tbl');
  t.classList.remove('flash');
  void t.offsetWidth;
  t.classList.add('flash');
};

/* ---------- jobs ---------- */
const FLOWS = {
  measure: [['queued', 'Queued', 'ph-queue'], ['measuring', 'Station measures 32 parts', 'ph-ruler'], ['committing', 'Station commits', 'ph-fingerprint'], ['proving', 'Supplier proves', 'ph-seal-check'], ['done', 'Contract verdict', 'ph-gavel']],
  tamper: [['queued', 'Queued', 'ph-queue'], ['measuring', 'Station measures', 'ph-ruler'], ['committing', 'Station commits', 'ph-fingerprint'], ['tampering', 'Numbers changed', 'ph-pencil-slash'], ['proving', 'Proof attempt', 'ph-seal-check'], ['done', 'Contract verdict', 'ph-gavel']],
  disclose: [['queued', 'Queued', 'ph-queue'], ['proving', 'Disclosure transaction', 'ph-eye'], ['done', 'Recorded', 'ph-check']],
};
const isBusy = () => !!S.job && !S.job.end;

function setButtons() {
  const busy = isBusy(), ready = !!S.state, lot = currentLot();
  for (const id of ['#measureBtn', '#tamperBtn']) {
    $(id).disabled = !ready || busy;
    $(id).setAttribute('aria-busy', String(busy));
  }
  $('#defects').disabled = !ready || busy;
  $('#verifyBtn').disabled = !lot;
  $('#consoleBtn').disabled = !lot;
  $('#consoleBtn2').disabled = !lot;
  const em = $('#emptyMeasure');
  if (em) em.disabled = busy;
}

function startMeasure() {
  const d = Number($('#defects').value);
  startJob('measure', '/api/demo/lots', { defects: d }, { defects: d });
}
$('#measureBtn').onclick = startMeasure;
$('#tamperBtn').onclick = () => startJob('tamper', '/api/demo/tamper', {});

async function startJob(kind, path, body, extra = {}) {
  if (isBusy() || !S.state) return;
  play('click');
  const prevIds = new Set(S.state.lots.map((l) => l.id));
  S.job = { kind, t0: Date.now(), step: 'queued', marks: { queued: Date.now() }, prevIds, ...extra };
  setButtons();
  renderRun();
  let r;
  try {
    r = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    S.job.end = Date.now();
    S.job.failed = true;
    S.job.error = e.kind === 'starting' ? 'The service is still starting. Try again in a moment.' : e.message;
    S.job.limit = e.kind === 'limit';
    play('rejected');
    setButtons();
    renderRun();
    return;
  }
  S.job.id = r.jobId;
  tick();
  poll();
}

async function poll() {
  const j = S.job;
  if (!j || j.end) return;
  try {
    const s = await api(`/api/jobs/${j.id}`);
    j.netErr = false;
    if (s.step && s.step !== j.step) {
      j.marks[s.step] = Date.now();
      j.step = s.step;
      if (j.kind !== 'disclose' && (s.step === 'proving' || s.step === 'tampering')) loadState({ adoptNew: j.prevIds });
    }
    if (s.status === 'done') return finishJob(s.result);
    if (s.status === 'failed') {
      j.end = Date.now();
      j.failed = true;
      j.error = s.error || 'The job failed.';
      play('rejected');
      setButtons();
      renderRun();
      loadState();
      return;
    }
  } catch (e) {
    j.netErr = e.message;
  }
  renderRun();
  setTimeout(poll, POLL_MS);
}

async function finishJob(result) {
  const j = S.job;
  j.end = Date.now();
  j.marks.done = j.marks.done ?? j.end;
  j.step = 'done';
  const lotId = j.kind === 'disclose' ? j.lotId : result?.id;
  await loadState({ select: lotId });
  j.lot = S.state?.lots.find((l) => l.id === lotId) ?? null;
  setButtons();
  renderRun();
  const l = j.lot;
  if (j.kind === 'disclose') play('disclosed');
  else if (l?.status === 'accepted') play('accepted');
  else play('rejected');
}

function tick() {
  if (!isBusy()) return;
  renderRun();
  setTimeout(tick, 1000);
}

function renderRun() {
  const j = S.job, el = $('#run');
  if (!j) { el.hidden = true; return; }
  const flow = FLOWS[j.kind];
  const keys = flow.map((f) => f[0]);
  const cur = keys.indexOf(j.step);
  const now = j.end ?? Date.now();
  const lot = j.lot;
  let title, msg = '', tone = '';
  const lbl = j.kind === 'disclose' ? `part #${j.index + 1} of ${esc(j.label)}` : '';
  if (j.failed) {
    tone = 'bad';
    title = j.limit ? 'The demo cannot take another run right now' : 'The run failed';
    msg = `<code>${esc(j.error)}</code>`;
  } else if (j.end && lot) {
    if (j.kind === 'disclose') {
      const d = (lot.disclosed || []).find((x) => x.index === j.index);
      tone = 'good';
      title = d ? `Part #${j.index + 1} disclosed: ${mm(d.valueUm)} mm, ${signUm(d.valueUm - S.state.spec.nominalUm)} µm from nominal` : `Disclosure of ${lbl} recorded`;
      msg = 'The contract checked the value against the station commitment. The other parts stay private.';
    } else if (lot.status === 'refused') {
      tone = 'bad';
      title = `${esc(lot.label)}: proof refused by the contract`;
      msg = `<code>${esc(lot.refused)}</code>. The numbers changed after the station committed them, so the contract recorded nothing.`;
    } else {
      tone = lot.status === 'accepted' ? 'good' : 'bad';
      title = proven(lot) ? `${esc(lot.label)}: ${lot.inTolerance} of ${lot.sampleSize} inside, ${lot.status}` : `${esc(lot.label)}: ${esc(lot.status)}`;
      msg = 'Both transactions are on-chain. The verdict comes from the contract.';
    }
  } else {
    title = j.kind === 'measure' ? `Measuring a new lot, ${plural(j.defects, 'part', 'parts')} planted out of band`
      : j.kind === 'tamper' ? 'Changing the numbers after the station committed them'
      : `Disclosing ${lbl}`;
    msg = j.kind === 'measure' ? 'Demo: the service plays the measuring station and the supplier. Each transaction takes about 20 s.'
      : j.kind === 'tamper' ? 'Demo: the station commits real readings, then better numbers are swapped in before the supplier proves.'
      : 'The supplier opens one measurement against the station commitment.';
    if (j.netErr) msg += ` <code>${esc(j.netErr)}</code> Retrying.`;
  }
  const steps = flow.map(([k, name, icon], i) => {
    let c = '';
    if (j.failed && !j.end) c = '';
    if (i < cur || (j.end && !j.failed)) c = 'done';
    else if (i === cur && !j.end) c = 'now';
    if (j.failed && i === Math.max(cur, 0)) c = 'fail';
    if (j.end && !j.failed && k === 'done' && lot && (lot.status === 'refused' || lot.status === 'rejected') && j.kind !== 'disclose') c = 'fail';
    const t0 = j.marks[k];
    const next = keys.slice(i + 1).map((x) => j.marks[x]).find(Boolean);
    const dur = t0 && k !== 'done' ? fmtDur((next ?? now) - t0) : '';
    const ic = c === 'now' ? 'ph-circle-notch' : icon;
    return `<li class="${c}"><span class="bar"></span><i class="ph-light ${ic}"></i><span class="nm">${name}</span><span class="t">${dur}</span></li>`;
  }).join('');
  el.className = `run ${tone}`;
  el.hidden = false;
  el.innerHTML = `<div class="run-h"><b>${title}</b><span class="eta num"><span><i class="ph-light ph-timer"></i> ${fmtDur(now - j.t0)}${j.end ? ' total' : ' elapsed'}</span>${j.end ? '<button class="iconbtn" type="button" id="runClose" aria-label="Dismiss"><i class="ph-light ph-x"></i></button>' : ''}</span></div><ol class="steps" style="--n:${flow.length}">${steps}</ol><div class="msg">${msg}</div>`;
  $('#runClose')?.addEventListener('click', () => { S.job = null; renderRun(); });
}

/* ---------- supplier console ---------- */
const dlg = $('#console');
async function openConsole() {
  const l = currentLot();
  if (!l) return;
  play('click');
  dlg.showModal();
  $('#conBody').innerHTML = `<div class="con-meta"><span><b>${esc(l.label)}</b></span><span>Loading values</span></div><ul class="con-list">${Array.from({ length: 8 }, () => '<li><span class="sk">#00</span><span class="sk">00.000 mm</span><span class="sk">+00</span><span></span></li>').join('')}</ul>`;
  try {
    const v = await api(`/api/supplier/lots/${l.id}`);
    S.supplier.set(l.id, v.valuesUm);
    renderConsole(l);
  } catch (e) {
    $('#conBody').innerHTML = `<div class="con-meta"><span><b>${esc(l.label)}</b></span></div><p class="con-note">${e.status === 404 ? 'This service holds no supplier values for this lot.' : esc(e.message)}</p>`;
  }
}
function renderConsole(l) {
  const sp = S.state.spec;
  const vals = S.supplier.get(l.id);
  if (!vals) return;
  const disc = new Set((l.disclosed || []).map((d) => d.index));
  const outs = vals.filter((v) => !inBand(sp, v)).length;
  const can = ['accepted', 'rejected', 'committed'].includes(l.status);
  const busy = isBusy();
  const items = vals.map((v, i) => {
    const out = !inBand(sp, v);
    const act = disc.has(i)
      ? '<span class="chip"><i class="ph-light ph-eye"></i>Disclosed</span>'
      : `<button class="btn" type="button" data-disclose="${i}" ${!can || busy ? 'disabled' : ''}><i class="ph-light ph-eye"></i>Disclose</button>`;
    return `<li class="${out ? 'out' : ''}"><span class="ix">#${i + 1}</span><span class="v">${mm(v)} mm${out ? '<span class="flag"><i class="ph-light ph-warning"></i>out</span>' : ''}</span><span class="d">${signUm(v - sp.nominalUm)} µm</span>${act}</li>`;
  }).join('');
  $('#conBody').innerHTML = `<div class="con-meta"><span><b>${esc(l.label)}</b>, ${vals.length} raw values</span><span class="num">${plural(outs, 'part', 'parts')} outside ${mm(sp.lowerUm)} to ${mm(sp.upperUm)} mm</span></div>`
    + `<ul class="con-list">${items}</ul>`
    + `<p class="con-note">${!can ? `Disclosure is off for a lot with status "${esc(l.status)}".` : busy ? 'A run is in progress. Disclose when it finishes.' : 'Disclose publishes one value on Midnight. The contract checks it against the station commitment; the customer sees only that part.'}</p>`;
}
$('#conBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-disclose]');
  if (!b) return;
  const l = currentLot();
  const index = Number(b.dataset.disclose);
  dlg.close();
  startJob('disclose', `/api/lots/${l.id}/disclose`, { index }, { lotId: l.id, index, label: l.label });
});
$('#consoleBtn').onclick = openConsole;
$('#consoleBtn2').onclick = openConsole;
$('#conClose').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

/* ---------- boot: skeleton until the contract answers, never zeros ---------- */
loadState();

// A lot can also be opened by editing the #lot= part of the address.
window.addEventListener('hashchange', () => {
  const label = new URLSearchParams(location.hash.slice(1)).get('lot');
  const lot = S.state?.lots.find((l) => l.label === label);
  if (lot && lot.id !== S.sel) { S.sel = lot.id; renderAll(); }
});
