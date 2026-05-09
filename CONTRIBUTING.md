# Contributing

Thanks for helping improve BuilderBite Instant Image Downloader.

## Local Setup

1. Clone the repository.
2. Open Microsoft Edge and visit `edge://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the repository folder.

## Development Checks

Run these before opening a pull request:

```powershell
node --check background.js
node --check contentScript.js
node --check popup.js
Get-Content -Raw manifest.json | ConvertFrom-Json | Out-Null
```

## Pull Request Guidelines

- Keep changes focused.
- Do not add remote hosted scripts to the extension.
- Do not add behavior that bypasses website privacy, login, or permission restrictions.
- Update `README.md` when changing user-facing behavior.
