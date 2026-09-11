# Armazém — Warehouse Stock Manager

A PWA for scanning QR-coded panel/board items, checking specs, and updating
stock + price directly against your live "Etiquetas" Google Sheet.

## How it's wired

```
Phone (PWA)  →  Vercel serverless functions (/api/*)  →  Google Sheets API
                 (holds the secret key — phone never sees it)
```

- `public/` — the installable frontend (HTML/CSS/JS, no build step, no framework).
- `api/` — serverless functions (items, orders, clients, users, push,
  order PDFs, resources, price sync, door materials) that are the *only*
  code allowed to know the Google service account key. Several handle more
  than one concern per file (e.g. `clients.js` also serves the client
  import endpoint) to stay under Vercel's function-count limit on the
  Hobby plan.
- `lib/sheets.js` — all the Sheets API logic: reading rows, parsing PT-style
  numbers (`5,985`), writing STOCK/Preço, and appending to an audit log tab.

## One-time setup

### 1. Get your Sheet ID
From your sheet's URL: `https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit`
You already gave this: `1q_qZDzNvNvHhd7ZLsjfmrhc7wquZ0iFIu_TFWCya4T4`

### 2. Rotate your service account key (strongly recommended)
The key you shared earlier was pasted as plaintext in a chat conversation.
Before going live with this app:
1. Go to https://console.cloud.google.com/iam-admin/serviceaccounts
2. Open `wharehouse-bot@webiste-gmail-smtp.iam.gserviceaccount.com`
3. Keys tab → delete the existing key → "Add Key" → "Create new key" → JSON
4. Don't paste the new file's contents anywhere public — only into Vercel's
   environment variable settings (step 4 below), which is private to your account.

### 3. Install the Vercel CLI and log in
```bash
npm install -g vercel
vercel login
```

### 4. Set environment variables
From the project folder:
```bash
vercel env add GOOGLE_SERVICE_ACCOUNT_JSON
# paste the ENTIRE contents of your service account JSON file when prompted

vercel env add SHEET_ID
# paste: 1q_qZDzNvNvHhd7ZLsjfmrhc7wquZ0iFIu_TFWCya4T4

vercel env add SHEET_TAB
# paste: Folha1   (or whatever your tab is actually named — check the bottom
# tab of your sheet; your screenshot showed "Folha1")
```
Do this for both "Production" and "Preview" when prompted, so it works on
your test URL too.

### 5. Deploy
```bash
vercel --prod
```
This prints a live URL like `https://warehouse-app-yourname.vercel.app`.

### 6. Install on your phone
Open that URL in Safari (iOS) or Chrome (Android) → Share/menu → "Add to
Home Screen". It now opens full-screen like a native app.

## Using it

- **Digitalizar (Scan)** tab: tap "Iniciar câmara", point at a QR label.
  It looks up the SKU and shows the item.
- No camera handy, or a label is damaged? Type the SKU manually below the
  scanner.
- On the item screen, **Stock** and **Preço** each have a +/− stepper and a
  direct input. Editing enables "Guardar" (Save) for that field only — the
  other field is untouched unless you also change it.
- **Inventário (Browse)** tab: search by SKU, family, or description across
  the whole sheet.
- Every stock/price change is appended to a `StockLog` tab (created
  automatically) with timestamp, SKU, field, old value, new value — so
  mistakes are traceable.

## Automatic price sync from Google Drive (TABELA.xlsx)

If you maintain prices in a separate Excel file (e.g. exported from other
software) rather than editing the Google Sheet directly, this syncs that
file's prices into the Sheet automatically once a day.

### How it works
A scheduled job (`api/sync-prices.js`, run by Vercel Cron) downloads the
price list workbook from Google Drive — using the same Google service
account already set up for Sheets access, no separate credentials needed
— reads each product row, and updates the `Preço` (and `VALOR COMPRA`)
columns in the Google Sheet for any SKU whose value changed. It does
**not** touch stock, dimensions, or anything else. Every change is logged
to the same `StockLog` tab the app already writes to.

The parser specifically handles this file's real structure (verified
against an actual export): no header row, category section labels like
"AGLOMERADO" as merged rows that get skipped, and SKUs that are
zero-padded to 8 digits regardless of whether the cell stored them as text
or a number.

### Setup

**1. Share the file with the service account**
In Google Drive, right-click the price list file → Share → add
`wharehouse-bot@webiste-gmail-smtp.iam.gserviceaccount.com` as a Viewer
(the same account already used for Sheets access). If you're using a
different file than the one already hardcoded as the default, copy its ID
from the URL (`https://drive.google.com/file/d/FILE_ID_HERE/view`) and set
it as the `PRICE_LIST_DRIVE_FILE_ID` environment variable in Vercel.

**2. Set a cron secret (recommended)**
Add a `CRON_SECRET` environment variable with any long random string —
Vercel automatically sends this as a Bearer token when it triggers the
cron job, which stops anyone else from triggering price writes by hitting
the URL directly.

**3. Redeploy**
Push to GitHub (or redeploy in the Vercel dashboard) so the new
`vercel.json` cron configuration and dependencies take effect.

### Manually triggering a sync
Visit `https://your-app.vercel.app/api/sync-prices` directly in a browser
(or with the `secret` query param if you set `CRON_SECRET`) to run a sync
on demand and see a JSON summary: how many SKUs matched, how many prices
actually changed, and — importantly — any rows in the price list that
couldn't be matched to a SKU in the Sheet, so nothing fails silently.

### Schedule
Runs once daily at 6:00 UTC (`vercel.json`'s `crons` config). Vercel's
free plan only allows daily cron jobs; more frequent syncing requires a
paid plan.



- **QR scanning uses jsQR on all platforms.** Early versions tried to use
  the browser's native `BarcodeDetector` API on Android, but its actual
  availability varies a lot between Android OEM builds — some report it as
  supported but never detect anything. jsQR is a predictable, well-tested
  JS scanner that behaves the same on every device, so it's now the only
  scanner path, on both iOS and Android.
- **Offline support is shell-only.** The app interface loads even with a bad
  connection, but stock/price data is always live — by design, so you never
  see or save stale numbers. No connection means no scan lookups or saves
  until it's back.
- **Multi-user with roles**, not single-user — this section was written
  before per-user accounts existed. Users live in the `Utilizadores` sheet
  tab (name, role, notification/landing-page preferences) and pick
  themselves from a login screen; roles are `vendedor` (sales), `armazém`
  (warehouse), and `admin`, each seeing a different set of tabs and
  permissions.
- **Concurrent edits**: stock/reservation changes (`adjustStock`,
  `adjustReservado` in `lib/sheets.js`) and claiming a row for a new order
  (`writeOrderRows` in `lib/orders.js`) all read-verify-retry rather than
  blindly overwrite, so two people hitting the same item or creating an
  order at the same instant no longer silently clobber each other. Marking
  a line as picked (`updateLinePicked`) is still a direct write without
  that same retry — two warehouse staff confirming the exact same line at
  the exact same instant is still a last-write-wins edge case, just a
  narrow one.
