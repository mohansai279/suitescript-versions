# SuiteScript Version Guard (Chrome extension)

Version history for SuiteScript files in NetSuite. Everything is stored locally in the browser, no server needed.

## Try it (load unpacked)

1. Chrome: open `chrome://extensions`, turn on **Developer mode**.
2. Click **Load unpacked** and choose this `extension` folder.
3. Sign in to NetSuite in a tab. Open a File Cabinet file page (`.../app/media/mediaitem.nl?id=NNN`). A "Version Guard" box appears bottom-right: click **Track this script**.
4. Or click the toolbar icon, enter the account URL and File ID, and click **Test read**, then **Track**.

If **Test read** fails, open Settings in the popup and adjust the URL templates (the default tries `/core/media/media.nl?id={id}`), or use the history page to paste versions manually.

## How it works

- Reads the file with your own signed-in NetSuite session (direct request, or through an open NetSuite tab).
- Compares a SHA-256 hash of the content (line endings normalised) with the latest saved version.
- On change: saves a new version automatically (can be turned off), shows a badge on the toolbar icon.
- No data leaves the browser. Permissions: `storage`, `unlimitedStorage`, `alarms`, and `https://*.app.netsuite.com/*` only.

## Tests

From the repo root: `npm install && npm run test:ext` (19 tests: background worker with fake IndexedDB and a mock NetSuite, plus popup and history pages in jsdom).

## Publish to the Chrome Web Store

See `STORE_LISTING.md` for all text. Upload `suitescript-version-guard-extension.zip` (the contents of this folder without `test/` and the `.md` files).
