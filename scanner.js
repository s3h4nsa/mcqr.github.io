/**
 * GATESCAN — Scanner Logic
 * ─────────────────────────────────────────────────────────
 * Handles:
 *  - QR code camera scanning via html5-qrcode
 *  - API verification calls to Google Apps Script
 *  - Result popup display with color coding
 *  - Sound alerts for each result type
 *  - 3-second scan lockout to prevent duplicates
 *  - Statistics counters
 *  - Recent scan log
 * ─────────────────────────────────────────────────────────
 */

// ── State ─────────────────────────────────────────────────

let html5QrCode = null;
let isScanning = false;
let scanLocked = false;
let popupTimer = null;
let audioCtx = null;

const stats = { valid: 0, used: 0, invalid: 0 };

// ── Audio Context ──────────────────────────────────────────

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

/**
 * Play a beep tone using the Web Audio API.
 * @param {number[]} freqs     - Array of frequencies to play in sequence
 * @param {number}   duration  - Duration of each tone in seconds
 * @param {string}   type      - Oscillator type
 * @param {number}   volume    - Gain (0–1)
 */
function playBeep(freqs, duration = 0.12, type = 'sine', volume = 0.4) {
  try {
    const ctx = getAudioContext();
    freqs.forEach((freq, i) => {
      const osc   = ctx.createOscillator();
      const gain  = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, ctx.currentTime + i * (duration + 0.02));
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * (duration + 0.02) + duration);
      osc.start(ctx.currentTime + i * (duration + 0.02));
      osc.stop(ctx.currentTime  + i * (duration + 0.02) + duration + 0.05);
    });
  } catch (e) {
    // Audio unavailable — fail silently
  }
}

function soundValid()   { playBeep([880, 1100], 0.12, 'sine', 0.35); }
function soundUsed()    { playBeep([440, 330],  0.18, 'triangle', 0.3); }
function soundInvalid() { playBeep([220, 180],  0.22, 'sawtooth', 0.25); }
function soundError()   { playBeep([300],       0.2,  'square', 0.2); }

// ── Scanner Control ────────────────────────────────────────

async function startScanner() {
  if (isScanning) return;

  const startBtn = document.getElementById('startBtn');
  const stopBtn  = document.getElementById('stopBtn');
  const frame    = document.getElementById('cameraFrame');

  try {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';

    html5QrCode = new Html5Qrcode('qr-reader');

    const cameras = await Html5Qrcode.getCameras();
    if (!cameras || cameras.length === 0) {
      throw new Error('No camera found on this device.');
    }

    // Prefer back camera on mobile
    const cameraId = cameras.find(c =>
      c.label.toLowerCase().includes('back') ||
      c.label.toLowerCase().includes('rear') ||
      c.label.toLowerCase().includes('environment')
    )?.id || cameras[0].id;

    await html5QrCode.start(
      cameraId,
      {
        fps: 10,
        qrbox: { width: 240, height: 240 },
        aspectRatio: 1.0,
        disableFlip: false,
      },
      onQRCodeSuccess,
      onQRCodeError
    );

    isScanning = true;
    frame.classList.add('scanning');
    startBtn.style.display = 'none';
    stopBtn.style.display = 'flex';

    document.getElementById('cameraHint').style.display = 'none';

  } catch (err) {
    console.error('[Scanner] Start error:', err);
    startBtn.disabled = false;
    startBtn.textContent = 'Start Scanning';
    showErrorPopup(`Camera error: ${err.message || 'Could not access camera.'}`);
  }
}

async function stopScanner() {
  if (!isScanning || !html5QrCode) return;

  try {
    await html5QrCode.stop();
    html5QrCode.clear();
  } catch (e) {
    console.warn('[Scanner] Stop error:', e);
  }

  isScanning = false;
  scanLocked = false;
  html5QrCode = null;

  const frame   = document.getElementById('cameraFrame');
  const startBtn = document.getElementById('startBtn');
  const stopBtn  = document.getElementById('stopBtn');

  frame.classList.remove('scanning');
  startBtn.disabled = false;
  startBtn.textContent = 'Start Scanning';
  startBtn.style.display = 'flex';
  stopBtn.style.display = 'none';

  document.getElementById('cameraHint').style.display = '';
}

// ── QR Code Callbacks ─────────────────────────────────────

function onQRCodeSuccess(decodedText) {
  if (scanLocked) return;

  lockScanner();
  console.log('[Scanner] Decoded:', decodedText);
  verifyTicket(decodedText.trim());
}

function onQRCodeError(/* errorMessage */) {
  // Continuous scan errors — ignore silently
}

function lockScanner() {
  scanLocked = true;
  setTimeout(() => {
    scanLocked = false;
  }, CONFIG.SCAN_LOCKOUT_MS);
}

// ── API Verification ──────────────────────────────────────

async function verifyTicket(ticketId) {
  const gate = document.getElementById('gateSelect').value;

  showLoading(true);
  closePopup(false);

  try {
    const response = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: ticketId, gate }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    showLoading(false);
    handleVerificationResult(data, gate);

  } catch (err) {
    console.error('[API] Error:', err);
    showLoading(false);
    showErrorPopup(`Network error — check connection.\n${err.message}`);
    soundError();
  }
}

// ── Result Handler ─────────────────────────────────────────

function handleVerificationResult(data, gate) {
  const { status, name, ticket_type, entry_time } = data;

  switch (status) {
    case 'valid':
      soundValid();
      updateStats('valid');
      addLogEntry('valid', name || 'Unknown', ticket_type || '—', gate);
      showPopup({
        type: 'valid',
        icon: '✓',
        title: 'VALID TICKET',
        name: name || 'Guest',
        sub: ticket_type || 'General Admission',
        time: `Entry: ${formatTime(entry_time)}`,
        gate,
      });
      break;

    case 'used':
      soundUsed();
      updateStats('used');
      addLogEntry('used', name || 'Unknown', 'DUPLICATE', gate);
      showPopup({
        type: 'used',
        icon: '⚠',
        title: 'ALREADY USED',
        name: name || 'Guest',
        sub: ticket_type || 'General Admission',
        time: `First entry: ${formatTime(entry_time)}`,
        gate,
      });
      break;

    case 'invalid':
      soundInvalid();
      updateStats('invalid');
      addLogEntry('invalid', 'UNKNOWN TICKET', '—', gate);
      showPopup({
        type: 'invalid',
        icon: '✕',
        title: 'INVALID TICKET',
        name: 'Ticket not found',
        sub: 'This QR code is not registered',
        time: '',
        gate,
      });
      break;

    default:
      soundError();
      showErrorPopup(`Unexpected response from server:\n${JSON.stringify(data)}`);
  }
}

// ── Popup ─────────────────────────────────────────────────

function showPopup({ type, icon, title, name, sub, time, gate }) {
  clearTimeout(popupTimer);

  const overlay = document.getElementById('popupOverlay');
  const panel   = document.getElementById('popupPanel');

  document.getElementById('popupIcon').textContent    = icon;
  document.getElementById('popupStatus').textContent  = title;
  document.getElementById('popupName').textContent    = name;
  document.getElementById('popupType').textContent    = sub;
  document.getElementById('popupTime').textContent    = time;
  document.getElementById('popupGate').textContent    = `◈ ${gate}`;

  panel.className = `popup-card ${type}`;

  overlay.classList.add('active');

  // Start countdown timer bar
  const fill = document.getElementById('timerFill');
  fill.classList.remove('animating');
  fill.style.width = '100%';
  void fill.offsetWidth; // force reflow
  fill.classList.add('animating');

  popupTimer = setTimeout(() => {
    closePopup();
  }, CONFIG.POPUP_TIMEOUT_MS);
}

function showErrorPopup(message) {
  clearTimeout(popupTimer);

  const overlay = document.getElementById('popupOverlay');
  const panel   = document.getElementById('popupPanel');

  document.getElementById('popupIcon').textContent    = '!';
  document.getElementById('popupStatus').textContent  = 'ERROR';
  document.getElementById('popupName').textContent    = message;
  document.getElementById('popupType').textContent    = '';
  document.getElementById('popupTime').textContent    = '';
  document.getElementById('popupGate').textContent    = '';

  panel.className = 'popup-card error';
  overlay.classList.add('active');

  popupTimer = setTimeout(() => {
    closePopup();
  }, CONFIG.POPUP_TIMEOUT_MS);
}

function closePopup(resetScan = true) {
  clearTimeout(popupTimer);
  document.getElementById('popupOverlay').classList.remove('active');
}

// ── Loading Indicator ──────────────────────────────────────

function showLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('active', show);
}

// ── Stats ─────────────────────────────────────────────────

function updateStats(type) {
  stats[type]++;
  const el = document.getElementById(`stat${type.charAt(0).toUpperCase() + type.slice(1)}`);
  el.textContent = stats[type];
  el.classList.remove('stat-flash');
  void el.offsetWidth; // reflow
  el.classList.add('stat-flash');
}

// ── Scan Log ──────────────────────────────────────────────

function addLogEntry(type, name, subtext, gate) {
  const log = document.getElementById('scanLog');

  // Remove empty state
  const empty = log.querySelector('.log-empty');
  if (empty) empty.remove();

  const now  = new Date();
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const li = document.createElement('li');
  li.className = `log-item ${type}`;
  li.innerHTML = `
    <div class="log-stripe"></div>
    <div class="log-info">
      <span class="log-name">${escapeHtml(name)}</span>
      <span class="log-sub">${escapeHtml(subtext)} &middot; ${escapeHtml(gate)}</span>
    </div>
    <span class="log-time">${time}</span>
  `;

  log.insertBefore(li, log.firstChild);

  // Keep log trimmed
  const items = log.querySelectorAll('.log-item');
  if (items.length > CONFIG.LOG_MAX_ENTRIES) {
    items[items.length - 1].remove();
  }
}

// ── Helpers ────────────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch {
    return iso;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Keyboard shortcut: Escape to close popup ──────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePopup();
});

// ── Init: warn if API_URL not configured ──────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (CONFIG.API_URL.includes('YOUR_SCRIPT_ID_HERE')) {
    console.warn(
      '[GATESCAN] ⚠ API_URL is not configured.\n' +
      'Edit js/config.js and replace YOUR_SCRIPT_ID_HERE with your Apps Script URL.'
    );
  }
});
