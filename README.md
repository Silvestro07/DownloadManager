# Download Manager

Windows download manager. Each file type goes straight into its own folder. Nothing is moved after the download.

## Install
1. Open **Releases** and download the `.exe` setup file.
2. Run it. The app starts.
3. In the app, open **Settings > Browser extension** and follow the three steps.

The app updates itself from GitHub Releases.

## Publish a new version
1. Change `version` in `package.json` (example: `1.0.1`).
2. Commit, then run: `git tag v1.0.1` and `git push --tags`.
3. GitHub Actions builds the setup file and adds it to Releases.

One time only: GitHub > Settings > Actions > General > Workflow permissions > **Read and write**.
The repository must be public.
