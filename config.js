/**
 * GATESCAN — Configuration
 * ─────────────────────────────────────────────────────────
 * IMPORTANT: Replace the API_URL value below with your
 * actual Google Apps Script Web App URL after deployment.
 *
 * Steps:
 *  1. Deploy your Google Apps Script as a Web App
 *  2. Copy the generated URL (ends with /exec)
 *  3. Paste it below, replacing the placeholder
 * ─────────────────────────────────────────────────────────
 */

const CONFIG = {
  // ▼ REPLACE THIS WITH YOUR GOOGLE APPS SCRIPT URL ▼
  API_URL: "https://script.google.com/macros/s/YOUR_SCRIPT_ID_HERE/exec",

  // Scan lockout duration in milliseconds (3 seconds)
  SCAN_LOCKOUT_MS: 3000,

  // Popup auto-dismiss duration in milliseconds (4 seconds)
  POPUP_TIMEOUT_MS: 4000,

  // Max entries shown in the recent scans log
  LOG_MAX_ENTRIES: 20,

  // Event name shown in UI (optional customization)
  EVENT_NAME: "EVENT 2025",
};
