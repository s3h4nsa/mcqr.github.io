/**
 * ═══════════════════════════════════════════════════════════
 *  GATESCAN — Google Apps Script Backend
 *  Handles QR ticket verification for 500-person events
 * ═══════════════════════════════════════════════════════════
 *
 *  Google Sheet: "TICKETS"
 *  Columns (A–G):
 *    A: ticket_id   — Unique ticket identifier (matches QR code value)
 *    B: name        — Ticket holder full name
 *    C: email       — Ticket holder email
 *    D: ticket_type — e.g. "General Admission", "VIP", "Staff"
 *    E: status      — "unused" or "used"
 *    F: entry_time  — ISO timestamp, set when ticket is scanned
 *    G: gate        — Gate name, set when ticket is scanned
 *
 *  DEPLOYMENT:
 *    1. Open Extensions → Apps Script in your Google Sheet
 *    2. Paste this entire file into Code.gs
 *    3. Deploy → New Deployment → Web App
 *       - Execute as: Me
 *       - Who has access: Anyone
 *    4. Copy the Web App URL and paste into js/config.js
 * ═══════════════════════════════════════════════════════════
 */

// ── Column index constants (1-based for Sheets API) ──────

const COL = {
  TICKET_ID:   1,  // A
  NAME:        2,  // B
  EMAIL:       3,  // C
  TICKET_TYPE: 4,  // D
  STATUS:      5,  // E
  ENTRY_TIME:  6,  // F
  GATE:        7,  // G
};

const SHEET_NAME = "TICKETS";

// ── CORS Headers ───────────────────────────────────────────

/**
 * Handle preflight OPTIONS requests (CORS).
 * Google Apps Script doesn't natively support OPTIONS,
 * but we include doGet as a fallback health check.
 */
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: "ok",
      message: "GATESCAN API is running.",
      timestamp: new Date().toISOString(),
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Main Handler ───────────────────────────────────────────

function doPost(e) {
  try {
    // Parse request body
    const body = JSON.parse(e.postData.contents);
    const ticketId = (body.ticket_id || "").toString().trim();
    const gate     = (body.gate     || "Unknown Gate").toString().trim();

    // Validate input
    if (!ticketId) {
      return jsonResponse({ status: "invalid", message: "No ticket_id provided." });
    }

    // Access the spreadsheet
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      return jsonResponse({ status: "error", message: `Sheet "${SHEET_NAME}" not found.` });
    }

    // Get all data (skip header row)
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return jsonResponse({ status: "invalid", message: "No tickets in database." });
    }

    const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();

    // Search for matching ticket_id
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowTicketId = row[COL.TICKET_ID - 1].toString().trim();

      if (rowTicketId === ticketId) {
        const status     = row[COL.STATUS - 1].toString().trim().toLowerCase();
        const name       = row[COL.NAME - 1].toString();
        const ticketType = row[COL.TICKET_TYPE - 1].toString();
        const entryTime  = row[COL.ENTRY_TIME - 1];

        const sheetRow = i + 2; // +2 because data starts at row 2

        if (status === "unused") {
          // ── VALID: Mark as used ────────────────────────

          const now = new Date();
          const nowISO = now.toISOString();

          // Update status, entry_time, gate in sheet
          sheet.getRange(sheetRow, COL.STATUS).setValue("used");
          sheet.getRange(sheetRow, COL.ENTRY_TIME).setValue(nowISO);
          sheet.getRange(sheetRow, COL.GATE).setValue(gate);

          // Force save
          SpreadsheetApp.flush();

          return jsonResponse({
            status:      "valid",
            name:        name,
            ticket_type: ticketType,
            entry_time:  nowISO,
            gate:        gate,
          });

        } else {
          // ── ALREADY USED ───────────────────────────────

          const previousEntry = entryTime
            ? (entryTime instanceof Date ? entryTime.toISOString() : entryTime.toString())
            : null;

          return jsonResponse({
            status:      "used",
            name:        name,
            ticket_type: ticketType,
            entry_time:  previousEntry,
            gate:        row[COL.GATE - 1].toString(),
          });
        }
      }
    }

    // ── NOT FOUND ─────────────────────────────────────────

    return jsonResponse({ status: "invalid" });

  } catch (err) {
    console.error("GATESCAN Error:", err);
    return jsonResponse({
      status:  "error",
      message: err.message || "An unknown error occurred.",
    });
  }
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Build a JSON ContentService response.
 * Google Apps Script Web Apps require ContentService for all responses.
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Optional: Utility to bulk-import tickets ─────────────

/**
 * Run this function manually in the Apps Script editor to
 * populate sample test data (50 tickets).
 *
 * HOW TO USE:
 *   1. Open Extensions → Apps Script
 *   2. Select populateSampleData from the function dropdown
 *   3. Click ▶ Run
 *   4. Check your TICKETS sheet
 */
function populateSampleData() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let sheet   = ss.getSheetByName(SHEET_NAME);

  // Create sheet if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  // Set headers
  sheet.getRange(1, 1, 1, 7).setValues([[
    "ticket_id", "name", "email", "ticket_type", "status", "entry_time", "gate"
  ]]);

  // Style header row
  const headerRange = sheet.getRange(1, 1, 1, 7);
  headerRange.setBackground("#1a1a2e");
  headerRange.setFontColor("#ffffff");
  headerRange.setFontWeight("bold");

  // Sample data
  const names = [
    "Alice Johnson", "Bob Williams", "Carol Brown", "David Miller",
    "Emma Wilson", "Frank Taylor", "Grace Anderson", "Henry Thomas",
    "Isabella Jackson", "James White", "Katherine Harris", "Liam Martin",
    "Mia Thompson", "Noah Garcia", "Olivia Martinez", "Peter Robinson",
    "Quinn Lewis", "Rachel Lee", "Samuel Walker", "Tara Hall",
    "Ulrich Allen", "Victoria Young", "William Hernandez", "Xena King",
    "Yusuf Wright", "Zoe Lopez", "Aaron Hill", "Bella Scott",
    "Carlos Green", "Diana Adams", "Edward Baker", "Fiona Nelson",
    "George Carter", "Hannah Mitchell", "Ivan Perez", "Julia Roberts",
    "Kevin Turner", "Laura Phillips", "Marcus Campbell", "Nina Parker",
    "Oscar Evans", "Patricia Edwards", "Quincy Collins", "Rosa Stewart",
    "Sebastian Morris", "Tina Rogers", "Ursula Reed", "Victor Cook",
    "Wendy Morgan", "Xavier Bell",
  ];

  const types = ["General Admission", "General Admission", "VIP", "General Admission", "Staff"];

  const rows = names.map((name, i) => {
    const id   = `TKT-${String(i + 1).padStart(4, "0")}`;
    const type = types[i % types.length];
    const email = name.toLowerCase().replace(/ /g, ".") + "@example.com";
    return [id, name, email, type, "unused", "", ""];
  });

  // Write data starting at row 2
  sheet.getRange(2, 1, rows.length, 7).setValues(rows);

  // Auto-resize columns
  sheet.autoResizeColumns(1, 7);

  SpreadsheetApp.getUi().alert(
    `✓ Success!\n\n${rows.length} sample tickets created in the TICKETS sheet.\n\nYou can now test scanning with IDs like:\nTKT-0001, TKT-0002, TKT-0003...`
  );
}
