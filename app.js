/**
 * Event Check-In — Offline NIC Scanner
 *
 * Camera strategy (fastest first):
 *   1. BarcodeDetector API  — native OS decoder (same engine as iPhone/Android
 *                             camera app). Works on Chrome Android, Safari iOS 17+.
 *                             Sub-100ms detection.
 *   2. jsQR fallback        — canvas pixel decoder for older browsers.
 *                             Still fast; ~200-400ms per frame.
 */

// ── State ────────────────────────────────────────────────────
const S = {
  tickets:   new Map(),
  scanned:   new Map(),
  gate:      'Gate A',
  stats:     { valid:0, dupe:0, invalid:0 },
  log:       [],
  locked:    false,
  popTimer:  null,
  stream:    null,        // MediaStream
  rafId:     null,        // requestAnimationFrame handle
  detector:  null,        // BarcodeDetector instance (if supported)
  audioCtx:  null,
};

// ── CSV ──────────────────────────────────────────────────────

document.getElementById('csvInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload  = e => parseCSV(e.target.result, file.name);
  r.onerror = () => alert('Could not read the file. Please try again.');
  r.readAsText(file, 'UTF-8');
});

function parseCSV(raw, filename) {
  const text    = raw.replace(/^\uFEFF/, '');          // strip BOM
  const lines   = text.trim().split(/\r?\n/);
  if (lines.length < 2) { alert('CSV is empty.'); return; }

  const headers = lines[0].split(',')
    .map(h => h.replace(/"/g,'').trim().toLowerCase());

  const col = {
    nic:   findCol(headers, ['nic number','nic','national id']),
    name:  findCol(headers, ['full name','name']),
    email: findCol(headers, ['email address','email']),
    phone: findCol(headers, ['contact number','contact','phone','mobile']),
    slip:  findCol(headers, ['payment slip number','payment slip','slip number','slip']),
  };

  if (col.nic === -1) {
    alert('Cannot find "NIC Number" column.\nHeaders: ' + headers.join(', '));
    return;
  }

  S.tickets.clear();
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c   = csvSplit(lines[i]);
    const nic = (c[col.nic] || '').trim();
    if (!nic) continue;
    S.tickets.set(nic.toLowerCase(), {
      nic,
      name:  col.name  >= 0 ? (c[col.name]  || '').trim() : '',
      email: col.email >= 0 ? (c[col.email] || '').trim() : '',
      phone: col.phone >= 0 ? (c[col.phone] || '').trim() : '',
      slip:  col.slip  >= 0 ? (c[col.slip]  || '').trim() : '',
    });
    count++;
  }

  if (!count) { alert('No tickets found. Check NIC Number column has data.'); return; }

  // Update UI
  const btn = document.getElementById('uploadBtnText');
  btn.textContent = '✓  ' + filename;
  btn.parentElement.classList.add('done');

  document.getElementById('csvLoaded').classList.remove('hidden');
  document.getElementById('csvCountText').textContent = count + ' ticket' + (count !== 1 ? 's' : '') + ' loaded';
  document.getElementById('csvFileName').textContent  = filename;
  document.getElementById('startBtn').disabled = false;

  console.log('[CSV] Loaded', count, 'tickets');
}

function findCol(headers, names) {
  for (const n of names)
    for (let i = 0; i < headers.length; i++)
      if (headers[i] === n || headers[i].includes(n)) return i;
  return -1;
}

function csvSplit(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i+1]==='"'){cur+='"';i++;} else q=!q; }
    else if (c === ',' && !q) { out.push(cur.trim()); cur=''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// ── Gate pills ───────────────────────────────────────────────

document.getElementById('gatePills').addEventListener('click', e => {
  const p = e.target.closest('.gpill');
  if (!p) return;
  document.querySelectorAll('.gpill').forEach(x => x.classList.remove('active'));
  p.classList.add('active');
  S.gate = p.dataset.gate;
});

// ── Screen transitions ───────────────────────────────────────

function startApp() {
  document.getElementById('topGate').textContent    = S.gate;
  document.getElementById('topTickets').textContent =
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

// ── Camera ───────────────────────────────────────────────────

async function startCamera() {
  const video   = document.getElementById('camVideo');
  const overlay = document.getElementById('vfOverlay');
  const vf      = document.getElementById('viewfinder');

  setMsg('Starting camera…');

  // ── Request camera stream ─────────────────────────────────
  // Ask for the highest resolution the rear camera can provide.
  // Higher resolution = more pixels = QR codes decode faster & from farther.
  const constraints = {
    video: {
      facingMode:  { ideal: 'environment' },
      width:       { ideal: 1920 },
      height:      { ideal: 1080 },
    },
    audio: false,
  };

  try {
    S.stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Retry with minimal constraints (some browsers need it)
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (err2) {
      try {
        S.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (err3) {
        setMsg('📷 Camera blocked\n\nAllow camera access and reload.', true);
        return;
      }
    }
  }

  video.srcObject = S.stream;

  // Wait for video to actually be playing before we start decoding
  video.addEventListener('loadedmetadata', () => {
    video.play().then(() => {
      overlay.classList.add('hide');
      vf.classList.add('on');
      initDecoder();
    }).catch(err => setMsg('Video play failed: ' + err.message, true));
  });
}

function stopCamera() {
  cancelAnimationFrame(S.rafId);
  S.rafId = null;
  if (S.stream) {
    S.stream.getTracks().forEach(t => t.stop());
    S.stream = null;
  }
  const video = document.getElementById('camVideo');
  video.srcObject = null;
  document.getElementById('viewfinder').classList.remove('on');
  document.getElementById('vfOverlay').classList.remove('hide');
  setMsg('Starting camera…');
}

// ── Decoder init ─────────────────────────────────────────────

async function initDecoder() {
  // Try native BarcodeDetector first
  if ('BarcodeDetector' in window) {
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      if (supported.includes('qr_code')) {
        S.detector = new BarcodeDetector({ formats: ['qr_code'] });
        console.log('[SCAN] Using native BarcodeDetector ✓');
        nativeLoop();
        return;
      }
    } catch (e) {
      console.warn('[SCAN] BarcodeDetector init failed:', e.message);
    }
  }

  // Fallback: jsQR via canvas
  if (typeof jsQR === 'function') {
    console.log('[SCAN] BarcodeDetector not available — using jsQR fallback');
    jsqrLoop();
    return;
  }

  setMsg('No QR decoder available.\nTry Chrome or Safari 17+.', true);
}

// ── Native BarcodeDetector loop ───────────────────────────────
// BarcodeDetector.detect() is async. We use a flag so we never fire
// a second detect() call while one is already running — this was the
// main cause of slowness (calls piling up in a queue).

function nativeLoop() {
  const video = document.getElementById('camVideo');
  let detecting = false;

  function tick() {
    if (!S.stream) return;

    if (!detecting && video.readyState === video.HAVE_ENOUGH_DATA) {
      detecting = true;
      S.detector.detect(video)
        .then(codes => {
          if (codes.length > 0) onQRFound(codes[0].rawValue);
        })
        .catch(() => {})
        .finally(() => { detecting = false; });
    }

    S.rafId = requestAnimationFrame(tick);
  }

  S.rafId = requestAnimationFrame(tick);
}

// ── jsQR fallback loop ────────────────────────────────────────
// Scans at 50% of video resolution — 4x fewer pixels to process,
// still more than enough to decode a QR code held at normal distance.

function jsqrLoop() {
  const video  = document.getElementById('camVideo');
  const canvas = document.getElementById('camCanvas');
  const ctx    = canvas.getContext('2d', { willReadFrequently: true });

  // Target decode size — 400px is plenty for a QR held ~20cm from phone
  const TARGET = 400;

  function tick() {
    if (!S.stream) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw && vh) {
        // Scale down to TARGET along the shorter axis
        const scale = TARGET / Math.min(vw, vh);
        const w = Math.round(vw * scale);
        const h = Math.round(vh * scale);

        if (canvas.width !== w) { canvas.width = w; canvas.height = h; }

        ctx.drawImage(video, 0, 0, w, h);
        const img  = ctx.getImageData(0, 0, w, h);
        const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (code) onQRFound(code.data);
      }
    }

    S.rafId = requestAnimationFrame(tick);
  }

  S.rafId = requestAnimationFrame(tick);
}

// ── QR found ─────────────────────────────────────────────────

function onQRFound(raw) {
  if (S.locked) return;
  S.locked = true;
  setTimeout(() => S.locked = false, 2500);

  const nic = raw.trim();
  console.log('[SCAN] Found:', nic);
  verify(nic);
}

// ── Lookup & verify ───────────────────────────────────────────

function verify(rawNIC) {
  const key    = rawNIC.toLowerCase();
  const person = S.tickets.get(key);
  const now    = new Date();
  const time   = now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

  if (!person) {
    S.stats.invalid++;
    refreshStats();
    beep('invalid');
    flashVF('red');
    pushLog('invalid', 'Not registered', rawNIC, time);
    S.log.push({ type:'invalid', nic:rawNIC, name:'', gate:S.gate, ts:now.toISOString() });
    openPopup('invalid', '✕', 'Not Registered', [
      { l:'NIC Scanned', v:rawNIC, mono:true },
      { l:'Status', v:'Not found in ticket list', cls:'err' },
    ]);
    return;
  }

  const prev = S.scanned.get(key);
  if (prev) {
    S.stats.dupe++;
    refreshStats();
    beep('dupe');
    flashVF('amber');
    pushLog('dupe', person.name || rawNIC, rawNIC, time);
    S.log.push({ type:'dupe', nic:rawNIC, name:person.name, gate:S.gate, ts:now.toISOString() });
    openPopup('dupe', '⚠', 'Already Scanned', buildRows(person, rawNIC, prev.gate, 'First entry: ' + prev.time));
    return;
  }

  S.scanned.set(key, { time, gate: S.gate });
  S.stats.valid++;
  refreshStats();
  beep('valid');
  flashVF('green');
  pushLog('valid', person.name || rawNIC, rawNIC, time);
  S.log.push({ type:'valid', nic:rawNIC, name:person.name, gate:S.gate, ts:now.toISOString() });
  openPopup('valid', '✓', 'Admitted', buildRows(person, rawNIC, S.gate, time));
}

function buildRows(p, nic, gate, time) {
  const rows = [];
  if (p.name)  rows.push({ l:'Name',   v:p.name });
  rows.push(   { l:'NIC',    v:nic,    mono:true });
  if (p.phone) rows.push({ l:'Phone',  v:p.phone, mono:true });
  if (p.email) rows.push({ l:'Email',  v:p.email, mono:true });
  if (p.slip)  rows.push({ l:'Slip #', v:p.slip,  mono:true });
  rows.push(   { l:'Gate',   v:gate });
  rows.push(   { l:'Time',   v:time,   mono:true });
  return rows;
}

// ── Viewfinder flash ─────────────────────────────────────────

function flashVF(color) {
  const vf = document.getElementById('viewfinder');
  vf.classList.remove('flash-green','flash-amber','flash-red');
  void vf.offsetWidth;   // force reflow
  vf.classList.add('flash-' + color);
  setTimeout(() => vf.classList.remove('flash-' + color), 400);
}

// ── Popup ────────────────────────────────────────────────────

function openPopup(type, icon, status, rows) {
  clearTimeout(S.popTimer);

  document.getElementById('popupIcon').textContent   = icon;
  document.getElementById('popupStatus').textContent = status;
  document.getElementById('popupDetails').innerHTML  = rows.map(r =>
    `<div class="drow">
      <span class="dlabel">${esc(r.l)}</span>
      <span class="dvalue ${r.mono?'mono':''} ${r.cls||''}">${esc(r.v)}</span>
    </div>`
  ).join('');

  document.getElementById('popupBox').className = 'popup-box ' + type;
  document.getElementById('popupOverlay').classList.add('show');

  const fill = document.getElementById('popupFill');
  fill.classList.remove('running');
  fill.style.width = '100%';
  void fill.offsetWidth;
  fill.classList.add('running');

  S.popTimer = setTimeout(closePopup, 4000);
}

function closePopup() {
  clearTimeout(S.popTimer);
  document.getElementById('popupOverlay').classList.remove('show');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });

// ── Scan log ─────────────────────────────────────────────────

function pushLog(type, name, nic, time) {
  const list  = document.getElementById('scanLog');
  const empty = list.querySelector('.log-empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = 'log-row ' + type;
  li.innerHTML =
    `<div class="log-stripe"></div>
     <div class="log-text">
       <span class="log-name">${esc(name)}</span>
       <span class="log-nic">${esc(nic)}</span>
     </div>
     <span class="log-time">${esc(time)}</span>`;
  list.insertBefore(li, list.firstChild);

  const all = list.querySelectorAll('.log-row');
  if (all.length > 60) all[all.length - 1].remove();
}

// ── Stats ────────────────────────────────────────────────────

function refreshStats() {
  bump('ssIn',   S.stats.valid);   bump('tcIn',   S.stats.valid);
  bump('ssDupe', S.stats.dupe);    bump('tcDupe', S.stats.dupe);
  bump('ssBad',  S.stats.invalid); bump('tcBad',  S.stats.invalid);
}

function bump(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ── Export ───────────────────────────────────────────────────

function exportCSV() {
  if (!S.log.length) { alert('No scans to export yet.'); return; }
  const rows = S.log.map(r => [r.type, qf(r.nic), qf(r.name), qf(r.gate), r.ts].join(','));
  const blob = new Blob(['result,nic,name,gate,timestamp\n' + rows.join('\n')], { type:'text/csv' });
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(blob),
    download: `checkin-${S.gate.toLowerCase().replace(/\s+/g,'-')}-${new Date().toISOString().slice(0,10)}.csv`,
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function qf(v) {
  const s = String(v || '');
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

// ── Audio ────────────────────────────────────────────────────

function getAudio() {
  if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return S.audioCtx;
}

function beep(type) {
  const map = {
    valid:   { freqs:[880,1100], dur:.1,  wave:'sine',     vol:.28 },
    dupe:    { freqs:[440,330],  dur:.14, wave:'triangle', vol:.22 },
    invalid: { freqs:[220,180],  dur:.18, wave:'sawtooth', vol:.18 },
  };
  const { freqs, dur, wave, vol } = map[type] || map.invalid;
  try {
    const ctx = getAudio();
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = wave; o.frequency.value = f;
      const t = ctx.currentTime + i * (dur + .02);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(.001, t + dur);
      o.start(t); o.stop(t + dur + .05);
    });
  } catch (e) { /* silent */ }
}

// ── Helpers ───────────────────────────────────────────────────

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setMsg(text, isError) {
  const el = document.getElementById('vfMsg');
  el.textContent = text;
  if (isError) el.style.color = '#ff9999';
}
