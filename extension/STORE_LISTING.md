# Chrome Web Store listing (copy and paste)

## Name
SuiteScript Version Guard

## Summary (max 132 characters)
Version history for NetSuite SuiteScript files. See what changed, when, and get alerted when a script is edited.

## Category
Developer Tools

## Language
English

## Detailed description
SuiteScript Version Guard gives your NetSuite scripts the version history NetSuite does not have.

Track any JavaScript file from the NetSuite File Cabinet. The extension saves it, checks it in the background, and keeps every version. If someone edits a script directly in NetSuite, you see it: the toolbar icon shows a badge and the new version is saved automatically.

What you can do
- A "Version" dropdown right on the NetSuite file page, like the one on Advanced PDF/HTML templates: pick any saved version and see exactly what changed
- Restore an old version into the code editor with one click (you still press Save in NetSuite)
- A version is captured automatically every time you click Save on a script file
- Track a script from its Script record or File Cabinet page with one click, or by file ID
- Automatic checks (every 15 minutes to 24 hours) for edits made in NetSuite
- A new version is saved automatically when a script changes
- Side-by-side history with a clear line-by-line diff (what was added and removed)
- Download or copy any old version, so rolling back is easy
- Add versions manually by pasting code or choosing a .js file
- Export and import a backup of everything

Private by design
- Everything is stored in your own browser. No servers, no accounts, nothing is uploaded.
- Works with the NetSuite session you are already signed in to. It never sees your password.
- Only runs on NetSuite pages (*.app.netsuite.com).

Great for NetSuite developers, admins and consultants who want a safety net before and after deployments.

Not affiliated with or endorsed by Oracle or NetSuite.

## Single purpose (Privacy practices tab)
Track and compare versions of SuiteScript files stored in the user's NetSuite account.

## Permission justifications
- **storage**: saves the user's settings (check interval, auto-save option).
- **unlimitedStorage**: script versions are stored locally and can add up over time.
- **alarms**: runs the periodic background check for edited scripts.
- **Host permission https://\*.app.netsuite.com/\***: reads the script files the user chose to track from their own NetSuite account (using their existing signed-in session), and shows the small "Track this script" button on NetSuite file pages.
- **Remote code**: No, the extension does not use remote code.

## Data usage (Privacy practices tab)
Tick none of the data collection boxes: the extension does not collect user data. Tick all three certifications (no sale of data, no unrelated use, no creditworthiness use).

## Privacy policy URL
Public URL of PRIVACY.md (for example a public GitHub Gist).

## Assets needed
- Icon 128x128: icons/icon128.png (included)
- At least 1 screenshot, 1280x800 or 640x400 (take real ones: the popup, the history page with a diff)
- Small promo tile 440x280: promo-small.png (included)
