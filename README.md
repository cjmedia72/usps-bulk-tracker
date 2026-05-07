# USPS Bulk Tracker

Chrome extension for bulk-tracking USPS packages directly from the official `tools.usps.com` tracking page. Designed as a 17track replacement for sellers and ops teams that move volume.

## About

Lightweight Chrome extension that turns the official USPS tracking page into a bulk lookup tool. Paste a list of tracking numbers, click **Track All**, and copy a clean TSV or CSV straight into your spreadsheet — no third-party API, no per-request fees, no rate limits beyond what USPS itself enforces. Built for sellers and operations teams who move enough volume to outgrow 17track but don't want to wire up a paid tracking API.

Released under the [MIT License](LICENSE).

## What it does

- Tracks up to 35 packages per batch, runs multiple batches back-to-back automatically
- Reads live data straight from USPS — no third-party API keys, no per-request fees, no rate limits beyond what USPS itself enforces
- Status detection: In Transit, Out for Delivery, Delivered, Not Found, plus the latest event detail and transit-days estimate
- Lenient input parser — accepts plain lists, comma- or semicolon-separated, formatted TNs with spaces or dashes, and column-mixed pastes from spreadsheets
- Automatic de-duplication with a visible skip breakdown so you always know why the count differs from what you pasted
- Live stat box with counters: Total, In Transit, Out for Delivery, Delivered, Not Found
- One-click copy as TSV (for Google Sheets) or CSV
- Results persist for 24 hours so the popup keeps state across close and reopen

## Installation

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked** and select the extension folder
5. Pin the extension to your toolbar for one-click access

## Usage

1. Click the extension icon to open the popup
2. Paste tracking numbers — one per line, comma-separated, or copied directly from a spreadsheet column
3. Click **Track All**
4. Wait for batches to complete (≈10 seconds per 35 TNs)
5. Click **Copy as TSV** and paste at cell `A2` of your tracking sheet

## TSV format

Output columns, in order:

```
Tracking | Origin | Dest | Detail | Status | Transit
```

## Notes

- Each batch opens a hidden tab to `tools.usps.com`, scrapes the rendered DOM, and closes the tab automatically
- `Not found` means USPS has no tracking record yet (invalid TN, label not yet scanned, no record on file, etc.)
- The count label under the input shows duplicates and unrecognized lines as you paste — instant feedback if your source list has issues
- Hovering the count label reveals the exact list of duplicate TNs flagged by the parser

## Permissions

The extension requests:

- `activeTab`, `tabs`, `scripting` — to open the USPS tracking page in a background tab and read the rendered results
- `storage` — to remember your last-pasted list and last results across popup close/reopen
- `https://tools.usps.com/*` — host permission, scoped to USPS only

No analytics, no telemetry, no external services. Source is short enough to audit in five minutes.
