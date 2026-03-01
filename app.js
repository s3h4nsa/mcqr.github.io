/**
 * Event Check-In — Offline NIC Scanner
 * ─────────────────────────────────────────────────────
 * Flow:
 *   1. Upload CSV (exported from Google Sheets)
 *   2. App indexes tickets by NIC Number
 *   3. QR scan → reads NIC → looks up person → shows popup
 *   4. Tracks first-entry vs duplicate in session memory
 *   5. Export scan log as CSV at end
 *
 * CSV columns (from your sheet):
 *   Timestamp | Email address | Full Name | Contact number |
 *   Payment slip number | Payment Slip | NIC Number
 */

// ── State ──────────────────────────────────────────────
const S = {
  tickets:  new Map(),   // NIC (lowercase) → row object
  scanned:  new Map(),   // NIC → { time, gate }
  gate:     'Gate A',
  stats:    { valid:0, dupe:0, invalid:0 },
  log:      [],
  locked:   false,
  timer:    null,
  scanner:  null,
  audio:    null,
};

// ── CSV UPLOAD ─────────────────────────────────────────

document.getElementById('csvInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => loadCSV(e.target.result, file.name);
  reader.readAsText(file, 'UTF-8');
});

// Also support drag-and-drop on the zone
const dropZone = document.getElementById('dropZone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', ()=> dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) processFile(file);
});

function processFile(file) {
  const reader = new FileReader();
  reader.onload = e => loadCSV(e.target.result, file.name);
  reader.readAsText(file, 'UTF-8');
}

function loadCSV(text, filename) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) { alert('CSV appears empty.'); return; }

  // Parse headers — normalize to lowercase, strip BOM & quotes
  const headers = lines[0]
    .replace(/^\uFEFF/, '')          // strip BOM
    .split(',')
    .map(h => h.trim().toLowerCase().replace(/"/g, ''));

  // Find column indexes — flexible matching
  const col = {
    nic:     findCol(headers, ['nic number','nic','national id','nicnumber']),
    name:    findCol(headers, ['full name','name','fullname']),
    email:   findCol(headers, ['email address','email']),
    phone:   findCol(headers, ['contact number','phone','mobile','contact']),
    slip:    findCol(headers, ['payment slip number','slip number','payment slip no','slipnumber']),
    ts:      findCol(headers, ['timestamp','date']),
  };

  if (col.nic === -1) {
    alert('Could not find "NIC Number" column.\nMake sure the header row contains: NIC Number');
    return;
  }

  S.tickets.clear();
  let count = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const nic   = (cells[col.nic] || '').trim();
    if (!nic) continue;

    S.tickets.set(nic.toLowerCase(), {
      nic,
      name:  col.name  >= 0 ? (cells[col.name]  || '').trim() : '',
      email: col.email >= 0 ? (cells[col.email] || '').trim() : '',
      phone: col.phone >= 0 ? (cells[col.phone] || '').trim() : '',
      slip:  col.slip  >= 0 ? (cells[col.slip]  || '').trim() : '',
      ts:    col.ts    >= 0 ? (cells[col.ts]    || '').trim() : '',
    });
    count++;
  }

  if (count === 0) {
    alert('No valid rows found. Check your CSV has a "NIC Number" column with data.');
    return;
  }

  // Update UI
  dropZone.classList.add('loaded');
  document.getElementById('dropLabel').textContent = '✓ ' + filename;
  document.getElementById('dropHint').textContent  = `${count} tickets indexed by NIC`;

  document.getElementById('loadSuccess').classList.remove('hidden');
  document.getElementById('loadCount').textContent = `${count} ticket${count !== 1 ? 's' : ''} loaded`;
  document.getElementById('loadFile').textContent  = filename;

  document.getElementById('startBtn').disabled = false;
}

function findCol(headers, candidates) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h.includes(c));
    if (i !== -1) return i;
  }
  return -1;
}

// Handle quoted CSV fields properly
function splitLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { q = !q; continue; }
    if (line[i] === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  out.push(cur);
  return out;
}

// ── GATE SELECTION ─────────────────────────────────────

document.getElementById('gatePills').addEventListener('click', e => {
  const p = e.target.closest('.pill');
  if (!p) return;
  document.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
  p.classList.add('active');
  S.gate = p.dataset.gate;
});

// ── SCREEN TRANSITIONS ─────────────────────────────────

function startApp() {
  document.getElementById('headerGate').textContent = S.gate;
  document.getElementById('headerCount').textContent =
    `${S.tickets.size} ticket${S.tickets.size !== 1 ? 's' : ''}`;

  document.getElementById('setupScreen').classList.remove('active');
  document.getElementById('scanScreen').classList.add('active');

  startCamera();
}

function goBack() {
  stopCamera();
  document.getElementById('scanScreen').classList.remove('active');
  document.getElementById('setupScreen').classList.add('active');
}

// ── CAMERA ─────────────────────────────────────────────

async function startCamera() {
  S.scanner = new Html5Qrcode('qr-reader');
  try {
    const cams = await Html5Qrcode.getCameras();
    if (!cams?.length) throw new Error('No camera found');

    const cam = cams.find(c => /back|rear|environment/i.test(c.label)) || cams[0];

    await S.scanner.start(
      cam.id,
      { fps: 12, qrbox: { width: 220, height: 220 }, aspectRatio: 1.0 },
      onScan,
      () => {}
    );

    document.getElementById('camWrap').classList.add('scanning');

  } catch (err) {
    document.getElementById('camIdle').innerHTML =
      `<span style="color:var(--red-mid);font-size:.72rem;padding:20px;text-align:center;line-height:1.6;">
        Camera error:<br>${err.message}
       </span>`;
  }
}

async function stopCamera() {
  if (!S.scanner) return;
  try { await S.scanner.stop(); S.scanner.clear(); } catch (_) {}
  S.scanner = null;
  document.getElementById('camWrap').classList.remove('scanning');
}

// ── QR SCAN ────────────────────────────────────────────

function onScan(raw) {
  if (S.locked) return;
  S.locked = true;
  setTimeout(() => S.locked = false, 3000);

  const scannedNIC = raw.trim();
  verify(scannedNIC);
}

// ── VERIFICATION ───────────────────────────────────────

function verify(rawNIC) {
  const key    = rawNIC.toLowerCase();
  const person = S.tickets.get(key);
  const now    = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

  if (!person) {
    // NIC not in the ticket list
    S.stats.invalid++;
    updateStats();
    soundInvalid();
    addLog('invalid', 'Unknown NIC', rawNIC, timeStr);
    S.log.push({ type:'invalid', nic:rawNIC, name:'', gate:S.gate, time:now.toISOString() });

    showPopup({
      type:    'invalid',
      icon:    '✕',
      status:  'Not Registered',
      details: [
        { label:'NIC', value:rawNIC, mono:true },
        { label:'Status', value:'Not found in ticket list', extra:'not-found' },
      ]
    });
    return;
  }

  const prev = S.scanned.get(key);

  if (prev) {
    // Already scanned this session
    S.stats.dupe++;
    updateStats();
    soundDupe();
    addLog('dupe', person.name || rawNIC, rawNIC, timeStr);
    S.log.push({ type:'dupe', nic:rawNIC, name:person.name, gate:S.gate, time:now.toISOString() });

    showPopup({
      type:    'dupe',
      icon:    '⚠',
      status:  'Already Scanned',
      details: buildDetails(person, rawNIC, prev.gate, prev.time),
    });
    return;
  }

  // ✓ First scan — mark as entered
  S.scanned.set(key, { time: timeStr, gate: S.gate });
  S.stats.valid++;
  updateStats();
  soundValid();
  addLog('valid', person.name || rawNIC, rawNIC, timeStr);
  S.log.push({ type:'valid', nic:rawNIC, name:person.name, gate:S.gate, time:now.toISOString() });

  showPopup({
    type:    'valid',
    icon:    '✓',
    status:  'Admitted',
    details: buildDetails(person, rawNIC, S.gate, timeStr),
  });
}

// Build detail rows for the popup
function buildDetails(p, nic, gate, time) {
  const rows = [];
  if (p.name)  rows.push({ label:'Name',   value: p.name });
  rows.push(   { label:'NIC',    value: nic,     mono: true });
  if (p.phone) rows.push({ label:'Phone',  value: p.phone, mono:true });
  if (p.email) rows.push({ label:'Email',  value: p.email, mono:true });
  if (p.slip)  rows.push({ label:'Slip #', value: p.slip,  mono:true });
  rows.push(   { label:'Gate',   value: gate });
  rows.push(   { label:'Time',   value: time,    mono:true });
  return rows;
}

// ── POPUP ──────────────────────────────────────────────

function showPopup({ type, icon, status, details }) {
  clearTimeout(S.timer);

  const bg    = document.getElementById('popupBg');
  const sheet = document.getElementById('popupSheet');

  // Icon
  document.getElementById('sheetIcon').textContent   = icon;
  document.getElementById('sheetStatus').textContent = status;

  // Details card
  const det = document.getElementById('sheetDetails');
  det.innerHTML = details.map(r => `
    <div class="detail-row">
      <span class="detail-label">${esc(r.label)}</span>
      <span class="detail-value ${r.mono ? 'mono' : ''} ${r.extra || ''}">${esc(r.value)}</span>
    </div>
  `).join('');

  // Type class
  sheet.className = `popup-sheet ${type}`;

  // Show
  bg.classList.add('open');

  // Progress bar countdown
  const fill = document.getElementById('sheetBarFill');
  fill.classList.remove('animating');
  fill.style.width = '100%';
  void fill.offsetWidth;
  fill.classList.add('animating');

  S.timer = setTimeout(closePopup, 4000);
}

function closePopup() {
  clearTimeout(S.timer);
  document.getElementById('popupBg').classList.remove('open');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });

// ── SCAN LOG ───────────────────────────────────────────

function addLog(type, name, nic, time) {
  const ul    = document.getElementById('scanLog');
  const empty = ul.querySelector('.log-empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = `log-item ${type}`;
  li.innerHTML = `
    <div class="log-stripe"></div>
    <div class="log-info">
      <span class="log-name">${esc(name)}</span>
      <span class="log-nic">${esc(nic)}</span>
    </div>
    <span class="log-time">${time}</span>
  `;
  ul.insertBefore(li, ul.firstChild);

  // Keep max 60 in DOM
  const all = ul.querySelectorAll('.log-item');
  if (all.length > 60) all[all.length - 1].remove();
}

// ── STATS ──────────────────────────────────────────────

function updateStats() {
  const map = {
    valid:   ['bstatIn',   'hstatIn'],
    dupe:    ['bstatDupe', 'hstatDupe'],
    invalid: ['bstatBad',  'hstatBad'],
  };
  for (const [type, ids] of Object.entries(map)) {
    const val = S.stats[type];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = val;
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  }
}

// ── CSV EXPORT ─────────────────────────────────────────

function exportCSV() {
  if (!S.log.length) { alert('No scans to export yet.'); return; }

  const header = 'result,nic,name,gate,timestamp\n';
  const rows   = S.log.map(r =>
    [r.type, cf(r.nic), cf(r.name), cf(r.gate), r.time].join(',')
  ).join('\n');

  const blob = new Blob([header + rows], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const date = new Date().toISOString().slice(0,10);
  a.href     = url;
  a.download = `checkin-${S.gate.replace(' ','-').toLowerCase()}-${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function cf(v) {
  if (!v) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

// ── AUDIO ──────────────────────────────────────────────

function audio() {
  if (!S.audio)
    S.audio = new (window.AudioContext || window.webkitAudioContext)();
  return S.audio;
}

function beep(freqs, dur=0.11, wave='sine', vol=0.3) {
  try {
    const ctx = audio();
    freqs.forEach((f,i) => {
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type=wave; o.frequency.value=f;
      const t=ctx.currentTime+i*(dur+0.02);
      g.gain.setValueAtTime(vol,t);
      g.gain.exponentialRampToValueAtTime(0.001,t+dur);
      o.start(t); o.stop(t+dur+0.05);
    });
  } catch(_){}
}

function soundValid()   { beep([880,1100],0.11,'sine',0.28); }
function soundDupe()    { beep([440,330], 0.15,'triangle',0.25); }
function soundInvalid() { beep([220,180], 0.2, 'sawtooth',0.2); }

// ── UTILS ──────────────────────────────────────────────

function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
