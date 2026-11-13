# Download Manager 1.1.4 source fixes

This source update addresses three download reliability problems:

1. The Chrome extension previously canceled Chrome's original download as soon as the local app acknowledged the request, before the app had tested the URL or received any file data. The extension now pauses Chrome's download and only cancels it after the manager receives the first data; if the manager cannot start, Chrome's copy resumes.
2. Large downloads use parallel HTTP Range requests. Some servers accept the initial one-byte range probe but reject later ranges (including with HTTP 416). The app now discards a failed segmented attempt and retries once with a single connection.
3. A transfer that stops making progress could previously remain active indefinitely. Requests now have a 30-second probe timeout and a 45-second no-progress timeout during transfers, with retries for stalled range requests.

## Build on Windows

1. Install Node.js (LTS).
2. Open a terminal in this folder.
3. Run `npm install`.
4. Run `npm run dist`.
5. Install the setup file from `dist`.
6. Open `chrome://extensions` and press Reload on **Download Manager Connector** after the app has copied the updated extension files.

The project source passed Node.js syntax checks. Regression checks verified both recovery from HTTP 416 range responses and aborting a request that never responds.
