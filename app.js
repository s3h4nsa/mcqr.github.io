/**
 * Event Check-In — Offline NIC Scanner
 * Reads NIC from QR → looks up in uploaded CSV → shows person details
 */

// ── State ───────────────────────────────────────────────────
const S = {
  tickets:  new Map(),   // nic_lowercase → { nic, name, email, phone, slip }
  scanned:  new Map(),   // nic_lowercase → { time, gate }
  gate:     'Gate A',
  stats:    { valid: 0, dupe: 0, invalid: 0 },
  log:      [],
  locked:   false,
  popTimer: null,
  scanner:  null,
  audioCtx: null,
};

// ── CSV UPLOAD ───────────────────────────────────────────────

document.getElementById('csvInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload  = function (e) { parseCSV(e.target.result, file.name); };
  reader.onerror = function ()  { alert('Could not read file. Try again.'); };
  reader.readAsText(file, 'UTF-8');
});

function parseCSV(text, filename) {
  // Remove BOM
  text = text.replace(/^\uFEFF/, '');

  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    alert('File looks empty — make sure it has a header row and at least one ticket.');
    return;
  }

  // Normalise headers
  const headers = lines[0]
    .split(',')
    .map(function (h) { return h.replace(/"/g, '').trim().toLowerCase(); });

  console.log('[CSV] Headers:', headers);

  // Find columns — works with your exact sheet column names
  var col = {
    nic:   col_find(headers, ['nic number', 'nic', 'national id']),
    name:  col_find(headers, ['full name', 'name']),
    email: col_find(headers, ['email address', 'email']),
    phone: col_find(headers, ['contact number', 'contact', 'phone', 'mobile']),
    slip:  col_find(headers, ['payment slip number', 'payment slip', 'slip number', 'slip']),
  };

  console.log('[CSV] Column map:', col);

  if (col.nic === -1) {
    alert(
      'Could not find the NIC Number column.\n\n' +
      'Columns found: ' + headers.join(', ') + '\n\n' +
      'Make sure the sheet has a column called "NIC Number".'
    );
    return;
  }

  S.tickets.clear();
  var count = 0;

  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var cells = csv_split(line);
    var nic   = col.nic >= 0 ? (cells[col.nic] || '').trim() : '';
    if (!nic) continue;

    S.tickets.set(nic.toLowerCase(), {
      nic:   nic,
      name:  col.name  >= 0 ? (cells[col.name]  || '').trim() : '',
      email: col.email >= 0 ? (cells[col.email] || '').trim() : '',
      phone: col.phone >= 0 ? (cells[col.phone] || '').trim() : '',
      slip:  col.slip  >= 0 ? (cells[col.slip]  || '').trim() : '',
    });
    count++;
  }

  console.log('[CSV] Loaded', count, 'tickets. Sample:', [...S.tickets.entries()].slice(0,2));

  if (count === 0) {
    alert('No tickets found. Check that the NIC Number column has values.');
    return;
  }

  // Update UI
  var btn = document.getElementById('uploadBtnText').parentElement;
  btn.classList.add('done');
  document.getElementById('uploadBtnText').textContent = '✓  ' + filename;

  var loaded = document.getElementById('csvLoaded');
  loaded.classList.remove('hidden');
  document.getElementById('csvCountText').textContent = count + ' ticket' + (count !== 1 ? 's' : '') + ' loaded';
  document.getElementById('csvFileName').textContent  = filename;

  document.getElementById('startBtn').disabled = false;
}

function col_find(headers, names) {
  for (var n = 0; n < names.length; n++) {
    for (var h = 0; h < headers.length; h++) {
      if (headers[h] === names[n] || headers[h].indexOf(names[n]) !== -1) return h;
    }
  }
  return -1;
}

// Proper CSV line parser — handles quoted fields
function csv_split(line) {
  var result = [], cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

// ── GATE PILLS ───────────────────────────────────────────────

document.getElementById('gatePills').addEventListener('click', function (e) {
  var pill = e.target.closest('.gpill');
  if (!pill) return;
  document.querySelectorAll('.gpill').forEach(function (p) { p.classList.remove('active'); });
  pill.classList.add('active');
  S.gate = pill.dataset.gate;
});

// ── SCREEN TRANSITIONS ───────────────────────────────────────

function startApp() {
  document.getElementById('topGate').textContent   = S.gate;
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

// ── CAMERA ───────────────────────────────────────────────────

async function startCamera() {
  var vf = document.getElementById('viewfinder');

  // Plain init — no format flags (they break in some versions of the lib)
  S.scanner = new Html5Qrcode('qr-reader');

  var config = {
    fps: 20,
    /*
      qrbox relative to the rendered video element.
      We do this after a tiny delay so the DOM has measured its real size.
    */
    qrbox: { width: 200, height: 200 },
    disableFlip: false,
  };

  // After element renders, update qrbox to be proportional
  setTimeout(function () {
    var w = vf.offsetWidth;
    var h = vf.offsetHeight;
    var size = Math.floor(Math.min(w, h) * 0.72);
    config.qrbox = { width: size, height: size };
    console.log('[CAM] viewfinder size:', w, 'x', h, '→ qrbox', size);
  }, 100);

  // Try 1: facingMode environment (rear camera — works on most Android/iOS)
  try {
    await S.scanner.start(
      { facingMode: 'environment' },
      config,
      onQRScan,
      function () {}
    );
    vf.classList.add('on');
    console.log('[CAM] Started with facingMode:environment');
    return;
  } catch (e1) {
    console.warn('[CAM] facingMode:environment failed:', e1.message);
  }

  // Try 2: list cameras, pick rear by label, fallback to last (usually rear)
  try {
    var cams = await Html5Qrcode.getCameras();
    console.log('[CAM] Available cameras:', cams.map(function(c){ return c.label; }));

    if (!cams || cams.length === 0) throw new Error('No cameras detected.');

    // Find rear camera by label; if not found use the last one (rear on phones)
    var chosen = cams[cams.length - 1];
    for (var i = 0; i < cams.length; i++) {
      if (/back|rear|environment/i.test(cams[i].label)) {
        chosen = cams[i];
        break;
      }
    }

    await S.scanner.start(chosen.id, config, onQRScan, function () {});
    vf.classList.add('on');
    console.log('[CAM] Started with camera:', chosen.label || chosen.id);
    return;
  } catch (e2) {
    console.error('[CAM] All start attempts failed:', e2.message);
    document.getElementById('vfIdle').innerHTML =
      '<div style="padding:16px;line-height:1.7;text-align:center;">' +
        '<div style="font-size:1.5rem;margin-bottom:6px;">📷</div>' +
        '<div style="color:#ff9999;font-size:.72rem;font-weight:300;">' + esc(e2.message) + '</div>' +
        '<div style="color:rgba(255,255,255,.4);font-size:.62rem;margin-top:6px;">' +
          'Allow camera access &amp; refresh' +
        '</div>' +
      '</div>';
  }
}

async function stopCamera() {
  if (!S.scanner) return;
  try {
    // getState: 0=UNKNOWN,1=NOT_STARTED,2=SCANNING,3=PAUSED
    if (S.scanner.getState() === 2) {
      await S.scanner.stop();
    }
    S.scanner.clear();
  } catch (e) {
    console.warn('[CAM] Stop error:', e.message);
  }
  S.scanner = null;
  document.getElementById('viewfinder').classList.remove('on');
}

// ── QR SCAN CALLBACK ─────────────────────────────────────────

function onQRScan(raw) {
  if (S.locked) return;

  S.locked = true;
  setTimeout(function () { S.locked = false; }, 2500);

  var nic = raw.trim();
  console.log('[SCAN] Raw value:', nic);
  verify(nic);
}

// ── LOOKUP & VERIFY ──────────────────────────────────────────

function verify(rawNIC) {
  var key    = rawNIC.toLowerCase();
  var person = S.tickets.get(key);
  var now    = new Date();
  var time   = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  // ── NOT IN LIST ──────────────────────────────────────────
  if (!person) {
    S.stats.invalid++;
    refreshStats();
    beep('invalid');
    pushLog('invalid', 'Not registered', rawNIC, time);
    S.log.push({ type:'invalid', nic:rawNIC, name:'', gate:S.gate, ts:now.toISOString() });

    openPopup('invalid', '✕', 'Not Registered', [
      { l: 'NIC Scanned', v: rawNIC, mono: true },
      { l: 'Status',      v: 'Not found in ticket list', cls: 'err' },
    ]);
    return;
  }

  // ── ALREADY SCANNED ──────────────────────────────────────
  var prev = S.scanned.get(key);
  if (prev) {
    S.stats.dupe++;
    refreshStats();
    beep('dupe');
    pushLog('dupe', person.name || rawNIC, rawNIC, time);
    S.log.push({ type:'dupe', nic:rawNIC, name:person.name, gate:S.gate, ts:now.toISOString() });

    openPopup('dupe', '⚠', 'Already Scanned',
      buildRows(person, rawNIC, prev.gate, 'First entry: ' + prev.time));
    return;
  }

  // ── VALID ────────────────────────────────────────────────
  S.scanned.set(key, { time: time, gate: S.gate });
  S.stats.valid++;
  refreshStats();
  beep('valid');
  pushLog('valid', person.name || rawNIC, rawNIC, time);
  S.log.push({ type:'valid', nic:rawNIC, name:person.name, gate:S.gate, ts:now.toISOString() });

  openPopup('valid', '✓', 'Admitted',
    buildRows(person, rawNIC, S.gate, time));
}

function buildRows(p, nic, gate, time) {
  var rows = [];
  if (p.name)  rows.push({ l:'Name',   v:p.name });
  rows.push(   { l:'NIC',    v:nic,    mono:true });
  if (p.phone) rows.push({ l:'Phone',  v:p.phone, mono:true });
  if (p.email) rows.push({ l:'Email',  v:p.email, mono:true });
  if (p.slip)  rows.push({ l:'Slip #', v:p.slip,  mono:true });
  rows.push(   { l:'Gate',   v:gate });
  rows.push(   { l:'Time',   v:time,   mono:true });
  return rows;
}

// ── POPUP ────────────────────────────────────────────────────

function openPopup(type, icon, status, rows) {
  clearTimeout(S.popTimer);

  var box = document.getElementById('popupBox');
  document.getElementById('popupIcon').textContent   = icon;
  document.getElementById('popupStatus').textContent = status;

  // Build detail rows
  document.getElementById('popupDetails').innerHTML = rows.map(function (r) {
    var cls = 'dvalue' + (r.mono ? ' mono' : '') + (r.cls ? ' ' + r.cls : '');
    return '<div class="drow">' +
      '<span class="dlabel">' + esc(r.l) + '</span>' +
      '<span class="' + cls + '">' + esc(r.v) + '</span>' +
    '</div>';
  }).join('');

  box.className = 'popup-box ' + type;
  document.getElementById('popupOverlay').classList.add('show');

  // Countdown bar
  var fill = document.getElementById('popupFill');
  fill.classList.remove('running');
  fill.style.width = '100%';
  void fill.offsetWidth;    // force reflow
  fill.classList.add('running');

  S.popTimer = setTimeout(closePopup, 4000);
}

function closePopup() {
  clearTimeout(S.popTimer);
  document.getElementById('popupOverlay').classList.remove('show');
}

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closePopup();
});

// ── SCAN LOG ─────────────────────────────────────────────────

function pushLog(type, name, nic, time) {
  var list  = document.getElementById('scanLog');
  var empty = list.querySelector('.log-empty');
  if (empty) empty.remove();

  var li = document.createElement('li');
  li.className = 'log-row ' + type;
  li.innerHTML =
    '<div class="log-stripe"></div>' +
    '<div class="log-text">' +
      '<span class="log-name">' + esc(name) + '</span>' +
      '<span class="log-nic">'  + esc(nic)  + '</span>' +
    '</div>' +
    '<span class="log-time">' + esc(time) + '</span>';

  list.insertBefore(li, list.firstChild);

  // Trim to 60 entries
  var all = list.querySelectorAll('.log-row');
  if (all.length > 60) all[all.length - 1].remove();
}

// ── STATS ────────────────────────────────────────────────────

function refreshStats() {
  bump('ssIn',   S.stats.valid);
  bump('tcIn',   S.stats.valid);
  bump('ssDupe', S.stats.dupe);
  bump('tcDupe', S.stats.dupe);
  bump('ssBad',  S.stats.invalid);
  bump('tcBad',  S.stats.invalid);
}

function bump(id, val) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ── EXPORT ───────────────────────────────────────────────────

function exportCSV() {
  if (!S.log.length) { alert('No scans to export yet.'); return; }

  var header = 'result,nic,name,gate,timestamp\n';
  var rows   = S.log.map(function (r) {
    return [r.type, qf(r.nic), qf(r.name), qf(r.gate), r.ts].join(',');
  }).join('\n');

  var blob = new Blob([header + rows], { type: 'text/csv' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href   = url;
  a.download = 'checkin-' +
    S.gate.toLowerCase().replace(/\s+/g, '-') + '-' +
    new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function qf(v) {
  if (!v) return '';
  var s = String(v);
  return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ── AUDIO ────────────────────────────────────────────────────

function getAudio() {
  if (!S.audioCtx)
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return S.audioCtx;
}

function beep(type) {
  var sounds = {
    valid:   { freqs:[880,1100], dur:.1,  wave:'sine',     vol:.28 },
    dupe:    { freqs:[440,330],  dur:.14, wave:'triangle', vol:.24 },
    invalid: { freqs:[220,180],  dur:.18, wave:'sawtooth', vol:.2  },
  };
  var s = sounds[type] || sounds.invalid;
  try {
    var ctx = getAudio();
    s.freqs.forEach(function (freq, i) {
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = s.wave; osc.frequency.value = freq;
      var t = ctx.currentTime + i * (s.dur + 0.02);
      g.gain.setValueAtTime(s.vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + s.dur);
      osc.start(t); osc.stop(t + s.dur + .05);
    });
  } catch (e) { /* no audio — ignore */ }
}

// ── UTILS ────────────────────────────────────────────────────

function esc(s) {
  return String(s || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}
