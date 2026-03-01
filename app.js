/**
 * Event Check-In — Offline NIC Scanner
 * Lookup by NIC number from uploaded CSV
 */

// ── State ──────────────────────────────────────────────────
const S = {
  tickets: new Map(),  // nic_lowercase → { nic, name, email, phone, slip }
  scanned: new Map(),  // nic_lowercase → { time, gate }
  gate:    'Gate A',
  stats:   { valid: 0, dupe: 0, invalid: 0 },
  log:     [],
  locked:  false,
  timer:   null,
  scanner: null,
  audioCtx: null,
};

// ── CSV UPLOAD ──────────────────────────────────────────────

document.getElementById('csvInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => loadCSV(e.target.result, file.name);
  reader.readAsText(file, 'UTF-8');
});

function loadCSV(text, filename) {
  // Strip BOM if present
  text = text.replace(/^\uFEFF/, '');

  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    showAlert('CSV file appears empty or has only headers.');
    return;
  }

  // Normalize headers
  const headers = lines[0]
    .split(',')
    .map(h => h.trim().replace(/"/g, '').toLowerCase());

  console.log('CSV headers found:', headers);

  // Flexible column matching for your exact sheet columns
  const col = {
    nic:   findCol(headers, ['nic number', 'nic', 'national id']),
    name:  findCol(headers, ['full name', 'name']),
    email: findCol(headers, ['email address', 'email']),
    phone: findCol(headers, ['contact number', 'contact', 'phone', 'mobile']),
    slip:  findCol(headers, ['payment slip number', 'slip number', 'payment slip']),
    ts:    findCol(headers, ['timestamp', 'date']),
  };

  console.log('Column map:', col);

  if (col.nic === -1) {
    showAlert(
      'Cannot find "NIC Number" column.\n\n' +
      'Headers found: ' + headers.join(', ') + '\n\n' +
      'Make sure your sheet has a column named "NIC Number".'
    );
    return;
  }

  S.tickets.clear();
  let count = 0;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = parseCSVLine(lines[i]);
    const nic = (cells[col.nic] || '').trim();
    if (!nic) continue;

    S.tickets.set(nic.toLowerCase(), {
      nic,
      name:  col.name  >= 0 ? (cells[col.name]  || '').trim() : '',
      email: col.email >= 0 ? (cells[col.email] || '').trim() : '',
      phone: col.phone >= 0 ? (cells[col.phone] || '').trim() : '',
      slip:  col.slip  >= 0 ? (cells[col.slip]  || '').trim() : '',
    });
    count++;
  }

  if (count === 0) {
    showAlert('No valid tickets found in the CSV. Check that the NIC Number column has data.');
    return;
  }

  // ✓ Loaded — update UI
  const zone  = document.getElementById('dropZone');
  zone.classList.add('loaded');
  document.getElementById('dropLabel').textContent = '✓  ' + filename;
  document.getElementById('dropHint').textContent  = count + ' tickets ready';

  const successEl = document.getElementById('loadSuccess');
  successEl.classList.remove('hidden');
  document.getElementById('loadCount').textContent = count + ' ticket' + (count !== 1 ? 's' : '') + ' loaded';
  document.getElementById('loadFile').textContent  = filename;

  document.getElementById('startBtn').disabled = false;

  console.log('Loaded ' + count + ' tickets. Sample:', [...S.tickets.entries()].slice(0,3));
}

function findCol(headers, candidates) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h === c || h.includes(c));
    if (i !== -1) return i;
  }
  return -1;
}

// Robust CSV line parser — handles quoted fields with commas inside
function parseCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Handle escaped quote ""
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ── GATE PILLS ──────────────────────────────────────────────

document.getElementById('gatePills').addEventListener('click', function (e) {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  document.querySelectorAll('#gatePills .pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  S.gate = pill.dataset.gate;
});

// ── SCREEN TRANSITIONS ──────────────────────────────────────

function startApp() {
  document.getElementById('headerGate').textContent  = S.gate;
  document.getElementById('headerCount').textContent =
    S.tickets.size + ' ticket' + (S.tickets.size !== 1 ? 's' : '');

  document.getElementById('setupScreen').classList.remove('active');
  document.getElementById('scanScreen').classList.add('active');

  startCamera();
}

function goBack() {
  stopCamera();
  document.getElementById('scanScreen').classList.remove('active');
  document.getElementById('setupScreen').classList.add('active');
}

// ── CAMERA ──────────────────────────────────────────────────

async function startCamera() {
  // Clean init — plain constructor, no format flags that may not exist
  S.scanner = new Html5Qrcode('qr-reader');

  const onSuccess = () => {
    document.getElementById('camWrap').classList.add('scanning');
    document.getElementById('camIdle').style.opacity = '0';
  };

  const onError = (msg) => {
    document.getElementById('camIdle').innerHTML =
      '<div style="padding:20px;text-align:center;line-height:1.8;">' +
      '<div style="font-size:1.8rem;margin-bottom:8px;">📷</div>' +
      '<div style="color:#9b3a3a;font-size:.75rem;letter-spacing:.05em;">' + msg + '</div>' +
      '<div style="color:#b0aa9f;font-size:.65rem;margin-top:8px;">Allow camera access and reload</div>' +
      '</div>';
  };

  // Config: simple, compatible, no function-based qrbox
  const scanConfig = {
    fps: 25,
    qrbox: { width: 250, height: 250 },
    aspectRatio: 1.0,
    disableFlip: false,
  };

  // Strategy 1: facingMode environment (rear camera, best for phones)
  try {
    await S.scanner.start(
      { facingMode: 'environment' },
      scanConfig,
      onQRScan,
      () => {}  // ignore per-frame no-QR errors
    );
    onSuccess();
    return;
  } catch (err1) {
    console.warn('facingMode environment failed:', err1.message);
  }

  // Strategy 2: list cameras, pick rear, fallback to first
  try {
    const cameras = await Html5Qrcode.getCameras();
    if (!cameras || cameras.length === 0) throw new Error('No cameras found.');

    console.log('Available cameras:', cameras.map(c => c.label));

    const rear = cameras.find(c =>
      /back|rear|environment/i.test(c.label)
    ) || cameras[cameras.length - 1]; // last camera is usually rear on mobile

    await S.scanner.start(
      rear.id,
      scanConfig,
      onQRScan,
      () => {}
    );
    onSuccess();
    return;
  } catch (err2) {
    console.error('Camera start failed:', err2.message);
    onError(err2.message || 'Camera could not be started.');
  }
}

async function stopCamera() {
  if (!S.scanner) return;
  try {
    const state = S.scanner.getState();
    // State 2 = SCANNING, safe to stop
    if (state === 2) await S.scanner.stop();
    S.scanner.clear();
  } catch (e) {
    console.warn('stopCamera:', e.message);
  }
  S.scanner = null;
  document.getElementById('camWrap').classList.remove('scanning');
}

// ── QR SCAN CALLBACK ────────────────────────────────────────

function onQRScan(rawText) {
  if (S.locked) return;

  // Lock for 2.5s to prevent double-scanning same code
  S.locked = true;
  setTimeout(() => { S.locked = false; }, 2500);

  const nic = rawText.trim();
  console.log('Scanned:', nic);
  lookup(nic);
}

// ── LOOKUP & VERIFY ─────────────────────────────────────────

function lookup(rawNIC) {
  const key    = rawNIC.toLowerCase();
  const person = S.tickets.get(key);
  const now    = new Date();
  const time   = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  // ── NOT IN LIST ──────────────────────────────────────────
  if (!person) {
    S.stats.invalid++;
    updateStats();
    playBeep('invalid');
    addLogEntry('invalid', 'Not registered', rawNIC, time);
    S.log.push({ type: 'invalid', nic: rawNIC, name: '', gate: S.gate, time: now.toISOString() });

    showPopup({
      type:    'invalid',
      icon:    '✕',
      status:  'Not Registered',
      details: [
        { label: 'NIC Scanned', value: rawNIC, mono: true },
        { label: 'Status',      value: 'Not found in ticket list' },
      ],
    });
    return;
  }

  // ── ALREADY SCANNED ──────────────────────────────────────
  const prev = S.scanned.get(key);
  if (prev) {
    S.stats.dupe++;
    updateStats();
    playBeep('dupe');
    addLogEntry('dupe', person.name || rawNIC, rawNIC, time);
    S.log.push({ type: 'dupe', nic: rawNIC, name: person.name, gate: S.gate, time: now.toISOString() });

    showPopup({
      type:   'dupe',
      icon:   '⚠',
      status: 'Already Scanned',
      details: buildDetails(person, rawNIC, prev.gate, 'First entry: ' + prev.time),
    });
    return;
  }

  // ── VALID — first entry ───────────────────────────────────
  S.scanned.set(key, { time, gate: S.gate });
  S.stats.valid++;
  updateStats();
  playBeep('valid');
  addLogEntry('valid', person.name || rawNIC, rawNIC, time);
  S.log.push({ type: 'valid', nic: rawNIC, name: person.name, gate: S.gate, time: now.toISOString() });

  showPopup({
    type:    'valid',
    icon:    '✓',
    status:  'Admitted',
    details: buildDetails(person, rawNIC, S.gate, time),
  });
}

function buildDetails(p, nic, gate, time) {
  const rows = [];
  if (p.name)  rows.push({ label: 'Name',    value: p.name });
  rows.push(   { label: 'NIC',     value: nic,     mono: true });
  if (p.phone) rows.push({ label: 'Phone',   value: p.phone, mono: true });
  if (p.email) rows.push({ label: 'Email',   value: p.email, mono: true });
  if (p.slip)  rows.push({ label: 'Slip #',  value: p.slip,  mono: true });
  rows.push(   { label: 'Gate',    value: gate });
  rows.push(   { label: 'Time',    value: time,    mono: true });
  return rows;
}

// ── POPUP ───────────────────────────────────────────────────

function showPopup({ type, icon, status, details }) {
  clearTimeout(S.timer);

  const sheet = document.getElementById('popupSheet');
  const bg    = document.getElementById('popupBg');

  document.getElementById('sheetIcon').textContent   = icon;
  document.getElementById('sheetStatus').textContent = status;

  // Build details rows
  document.getElementById('sheetDetails').innerHTML = details.map(row =>
    '<div class="detail-row">' +
      '<span class="detail-label">'  + esc(row.label) + '</span>' +
      '<span class="detail-value '   + (row.mono  ? 'mono'      : '') +
                               ' '   + (row.extra ? row.extra   : '') + '">' +
        esc(row.value) +
      '</span>' +
    '</div>'
  ).join('');

  sheet.className = 'popup-sheet ' + type;
  bg.classList.add('open');

  // Countdown bar
  const fill = document.getElementById('sheetBarFill');
  fill.classList.remove('animating');
  fill.style.width = '100%';
  void fill.offsetWidth;  // force reflow
  fill.classList.add('animating');

  S.timer = setTimeout(closePopup, 4000);
}

function closePopup() {
  clearTimeout(S.timer);
  document.getElementById('popupBg').classList.remove('open');
}

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closePopup();
});

// ── SCAN LOG ────────────────────────────────────────────────

function addLogEntry(type, name, nic, time) {
  const list  = document.getElementById('scanLog');
  const empty = list.querySelector('.log-empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = 'log-item ' + type;
  li.innerHTML =
    '<div class="log-stripe"></div>' +
    '<div class="log-info">' +
      '<span class="log-name">' + esc(name) + '</span>' +
      '<span class="log-nic">'  + esc(nic)  + '</span>' +
    '</div>' +
    '<span class="log-time">' + time + '</span>';

  list.insertBefore(li, list.firstChild);

  // Keep DOM trim
  const all = list.querySelectorAll('.log-item');
  if (all.length > 60) all[all.length - 1].remove();
}

// ── STATS ───────────────────────────────────────────────────

function updateStats() {
  setAndFlash('bstatIn',   S.stats.valid);
  setAndFlash('hstatIn',   S.stats.valid);
  setAndFlash('bstatDupe', S.stats.dupe);
  setAndFlash('hstatDupe', S.stats.dupe);
  setAndFlash('bstatBad',  S.stats.invalid);
  setAndFlash('hstatBad',  S.stats.invalid);
}

function setAndFlash(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ── CSV EXPORT ──────────────────────────────────────────────

function exportCSV() {
  if (!S.log.length) {
    showAlert('No scans to export yet.');
    return;
  }
  const header = 'result,nic,name,gate,timestamp\n';
  const rows   = S.log.map(r =>
    [r.type, cf(r.nic), cf(r.name), cf(r.gate), r.time].join(',')
  ).join('\n');

  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'checkin-' + S.gate.replace(' ', '-').toLowerCase() +
               '-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function cf(v) {
  if (!v) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ── AUDIO ───────────────────────────────────────────────────

function getAudioCtx() {
  if (!S.audioCtx)
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return S.audioCtx;
}

function playBeep(type) {
  try {
    const ctx  = getAudioCtx();
    const map  = {
      valid:   { freqs: [880, 1100], dur: 0.10, wave: 'sine',     vol: 0.3 },
      dupe:    { freqs: [440, 330],  dur: 0.14, wave: 'triangle', vol: 0.25 },
      invalid: { freqs: [220, 180],  dur: 0.18, wave: 'sawtooth', vol: 0.2 },
    };
    const { freqs, dur, wave, vol } = map[type] || map.invalid;

    freqs.forEach(function (freq, i) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = wave;
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * (dur + 0.02);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    });
  } catch (e) { /* audio not available — silent fail */ }
}

// ── HELPERS ─────────────────────────────────────────────────

function esc(s) {
  return String(s || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

function showAlert(msg) {
  alert(msg);
}
