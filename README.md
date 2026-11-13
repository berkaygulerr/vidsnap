# Vidsnap

Adds a **download button** to videos on any site: YouTube, X, Instagram, Reddit, forums and more. Download any available resolution as **MP4**, or just the audio as **MP3**. The button shows download progress, and you can pause, resume or cancel downloads.

## Install (Windows)

1. Download **`Vidsnap_x.y.z_x64-setup.exe`** from the [latest release](https://github.com/berkaygulerr/vidsnap/releases/latest) and run it.
2. On first launch, Vidsnap downloads the tools it needs (yt-dlp, ffmpeg).
3. Click **Install extension**. A wizard loads the extension into Chrome, Brave or Edge for you.

Both the app and the extension **update themselves automatically** when a new version is released.

## Project layout

```
extension/      Browser extension (button, menu, capturing video streams from network traffic)
desktop/host/   Native messaging host (Rust): runs downloads with yt-dlp + ffmpeg
desktop/app/    Desktop app (Tauri 2): tray, history, settings, extension wizard, auto-update
release.ps1     Builds, signs and publishes a new version to GitHub Releases
```

## How it works

1. The extension finds the video under the cursor, including inside Shadow DOM and iframes.
2. It works out the video's URL, checking these in order:
   - On known sites, the post's own link
   - A direct file in the `<video>` tag
   - `.m3u8`, `.mpd` or `.mp4` streams captured from network traffic
3. yt-dlp lists the available qualities. The chosen one is downloaded and merged into an MP4, preferring H.264 + AAC when available.
4. For sites that need a login, that site's cookies are passed only to the local host.

## Building

Requirements: Rust, Node.js, and the Tauri 2 prerequisites.

```
cd desktop/app
npm install
npm run tauri build
```

## Releasing

```
.\release.ps1 -Version 0.2.2 -Notes "What changed"
```

Use `-DryRun` to build and sign without uploading. The updater signing key lives in `%USERPROFILE%\.vidsnap\updater.key`. It is not in the repo, so keep a backup of it.

## Limitations

- DRM-protected platforms (Netflix, Disney+, Spotify, etc.) are not supported.
- For personal use.
