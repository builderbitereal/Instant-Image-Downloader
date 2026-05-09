# BuilderBite Instant Image Downloader

Fast Microsoft Edge image downloader extension by [BuilderBite](https://builderbite.com/). Detect the main image on a page, download gallery images as an ordered ZIP, manually click any image to save it, or auto-step through pages with the left-arrow workflow.

If this extension helps your workflow, please star the repository. It helps other users discover the project.

## Best For

- Downloading visible images from public web pages
- Saving public Facebook post or gallery images as one ordered ZIP
- Downloading batch images in order as `001.jpg`, `002.jpg`, `003.jpg`
- Manual image picking when a page has many photos
- Auto-downloading image slides with a left-arrow or previous button

## Features

- Instant Download: detects the main visible image on a page and starts a download automatically.
- Download All Post Images as ZIP: detects visible batch/gallery images, keeps their visual order, and downloads them in one ZIP file.
- Left Arrow Option Enabled: downloads the current image, performs the page's left-arrow action, then repeats.
- Limit support: set a maximum number of left-arrow download cycles, or leave it empty for unlimited until stopped.
- Manual Download Current Image: downloads the largest visible image on the current page.
- Manual Download By Image Click: lets you click a specific image or background image on the page to download it.
- Duplicate protection: avoids repeatedly downloading the same page image in a short window.

## Install in Microsoft Edge

1. Open `edge://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select the extension folder.

## Usage

Open a page with images, click the extension icon, and choose one of the available actions.

For Facebook batch posts, open the public post or gallery first, make sure the images are visible on the page, then click `Download All Post Images as ZIP`.

## Important Notes

- This extension only downloads images that are visible and accessible in your browser.
- It does not bypass Facebook privacy, login, permission, paywall, or site access restrictions.
- Browser download behavior still follows Edge download settings. If Edge asks where to save every file, the browser may show that prompt.
- Some sites block direct image downloads or use temporary `blob:` URLs. Those images may not be downloadable through the browser downloads API.

## Repository SEO

Recommended GitHub repository description:

```text
Microsoft Edge image downloader extension by BuilderBite. Download page images, public Facebook gallery images as ordered ZIP files, and auto-save slide images with left-arrow navigation.
```

Recommended GitHub topics:

```text
edge-extension, chrome-extension, image-downloader, facebook-image-downloader, gallery-downloader, zip-downloader, browser-extension, manifest-v3, builderbite
```

Website:

```text
https://builderbite.com/
```

## Deploy Landing Page

This repository includes a simple SEO landing page in `docs/` for GitHub Pages.

1. Push this repository to GitHub.
2. Go to repository `Settings` > `Pages`.
3. Set source to `GitHub Actions`.
4. Push to `main`; the included workflow publishes `docs/`.
5. Add the custom domain `builderbite.com` or a project subdomain if you want this page live there.

## Brand

Built by BuilderBite.

- Website: [https://builderbite.com/](https://builderbite.com/)

## License

MIT License. See [LICENSE](LICENSE).
