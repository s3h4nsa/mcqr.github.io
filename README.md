# GATESCAN — QR Attendance Verification System
### Complete deployment guide for a 500-person event

---

## File Structure

```
qr-attendance/
├── index.html              ← Main app page
├── css/
│   └── style.css           ← All styles
├── js/
│   ├── config.js           ← API URL + settings ⚠ EDIT THIS
│   └── scanner.js          ← Core scanner logic
└── backend/
    └── Code.gs             ← Google Apps Script (paste into GAS editor)
```

---

## STEP 1 — Set Up the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a **new spreadsheet**.
2. Rename the first sheet tab to exactly: **`TICKETS`** (case-sensitive).
3. Add these headers in **Row 1** (columns A–G):

| A          | B     | C     | D           | E      | F          | G    |
|------------|-------|-------|-------------|--------|------------|------|
| ticket_id  | name  | email | ticket_type | status | entry_time | gate |

4. Add your ticket data starting from **Row 2**. Each row is one ticket.
   - `ticket_id` — Must exactly match the value encoded in each QR code
   - `name` — Attendee's full name
   - `email` — Attendee's email
   - `ticket_type` — e.g. "General Admission", "VIP", "Staff"
   - `status` — Set to `unused` for all new tickets
   - `entry_time` — Leave empty (auto-filled on scan)
   - `gate` — Leave empty (auto-filled on scan)

**Tip:** Use the sample data loader — see Step 2c.

---

## STEP 2 — Deploy the Google Apps Script Backend

### 2a. Open Apps Script

1. With your Google Sheet open, click **Extensions → Apps Script**.
2. The Apps Script editor will open in a new tab.
3. Delete any existing code in `Code.gs`.
4. Copy the entire contents of `backend/Code.gs` from this project and paste it in.
5. Click **Save** (💾 icon or Ctrl+S).

### 2b. (Optional) Load Sample Test Data

1. In the Apps Script editor, click the function dropdown (shows `doPost` or similar).
2. Select **`populateSampleData`** from the list.
3. Click ▶ **Run**.
4. Grant permissions when prompted.
5. Switch back to your Google Sheet — 50 test tickets will appear.
   - Test ticket IDs: `TKT-0001` through `TKT-0050`

### 2c. Deploy as Web App

1. In Apps Script, click **Deploy → New Deployment**.
2. Click ⚙ (gear) next to "Select type" → choose **Web App**.
3. Configure:
   - **Description**: `GATESCAN v1`
   - **Execute as**: `Me (your email)`
   - **Who has access**: `Anyone` ← **This is required for the scanner to work**
4. Click **Deploy**.
5. Click **Authorize access** and follow the Google OAuth prompts.
6. After deployment, copy the **Web App URL** (it ends with `/exec`).

> ⚠️ **Important:** Every time you edit Code.gs, you must create a **new deployment** (not update existing) to push changes live.

---

## STEP 3 — Configure the Frontend

1. Open **`js/config.js`** in a text editor.
2. Replace `YOUR_SCRIPT_ID_HERE` with your Web App URL from Step 2c:

```javascript
const CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycb...yourID.../exec",
  // ... rest of config
};
```

3. Save the file.

---

## STEP 4 — Host on GitHub Pages

### 4a. Create a GitHub Repository

1. Go to [github.com](https://github.com) and sign in.
2. Click **New repository**.
3. Name it: `gatescan` (or any name you prefer).
4. Set visibility to **Public**.
5. Click **Create repository**.

### 4b. Upload the Files

**Option A — GitHub Web Interface (Easiest):**
1. In your new repo, click **Add file → Upload files**.
2. Upload all project files maintaining the folder structure:
   - `index.html`
   - `css/style.css`
   - `js/config.js`
   - `js/scanner.js`
3. Commit the files.

**Option B — Git Command Line:**
```bash
git init
git add .
git commit -m "Initial GATESCAN deployment"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/gatescan.git
git push -u origin main
```

### 4c. Enable GitHub Pages

1. In your repo, go to **Settings → Pages**.
2. Under **Source**, select:
   - Branch: `main`
   - Folder: `/ (root)`
3. Click **Save**.
4. Wait ~1 minute, then your site will be live at:
   ```
   https://YOUR_USERNAME.github.io/gatescan/
   ```

---

## STEP 5 — Test the System

### Test with a real QR code
1. Open your GitHub Pages URL on a phone or tablet.
2. Select a gate from the dropdown.
3. Click **START SCANNER**.
4. Allow camera access when prompted.

### Generate test QR codes
- Use any free QR generator (e.g. [qr-code-generator.com](https://www.qr-code-generator.com))
- For text, enter a ticket_id from your sheet (e.g. `TKT-0001`)
- Scan it — you should see the green **VALID TICKET** popup

### Expected results:
| Scenario | Result |
|----------|--------|
| First scan of `TKT-0001` | 🟢 **VALID** — green popup, sheet updated |
| Scan same `TKT-0001` again | 🟠 **ALREADY USED** — orange popup |
| Scan `FAKE-999` | 🔴 **INVALID** — red popup |

---

## Generating QR Codes for All 500 Tickets

### Option A — Google Sheets Formula (quick)

Add this formula in a new column (e.g. column H) in your TICKETS sheet:
```
=IMAGE("https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" & A2)
```
This displays a QR image for each ticket ID using a free public API.

### Option B — Bulk Generator (recommended for print)
1. Export your ticket IDs as CSV.
2. Use [qrbatch.com](https://www.qrbatch.com) or similar to bulk-generate printable QR codes.
3. Each QR code must encode **only the ticket_id value** (e.g. `TKT-0001`).

---

## Troubleshooting

**"Camera not starting"**
- Make sure you're accessing the page over **HTTPS** (required for camera access).
- GitHub Pages uses HTTPS by default ✓
- Allow camera permissions in your browser settings.

**"Network error" on scan**
- Verify your `API_URL` in `config.js` is correct and ends with `/exec`.
- Open the URL directly in a browser — you should see `{"status":"ok","message":"GATESCAN API is running."}`.
- Make sure the Apps Script is deployed as **Anyone** can access.

**"Sheet not found" error**
- Confirm the sheet tab is named exactly `TICKETS` (capital letters, no spaces).

**Changes to Code.gs not working**
- You must create a **New Deployment** each time you change the script.
- "Manage Deployments" → create a new version — then update `config.js` with the new URL.

**Popup not showing**
- Check browser console (F12) for errors.
- The script may be hitting CORS issues — ensure Apps Script is deployed correctly.

---

## Security Notes

- The Google Apps Script URL is public — anyone who knows it can query your ticket database.
- For higher security, add a secret key check: send a `auth_key` in the POST body and validate it in the script.
- Never share your Apps Script edit URL.
- Google Sheets access is controlled by your Google account permissions — only you can see the data.

---

## Customization

**To add more gates:** Edit the `<select>` in `index.html`:
```html
<option value="Gate D">Gate D — South Exit</option>
```

**To change colors:** Edit CSS variables at the top of `css/style.css`.

**To change lockout or popup duration:** Edit `CONFIG` values in `js/config.js`.

**To add more ticket types:** Just add them to your TICKETS sheet — no code changes needed.

---

Built for real 500-person event deployment • GATESCAN v1.0
