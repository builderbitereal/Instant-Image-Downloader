const RECENT_DOWNLOADS_KEY = "iidRecentDownloads";
const MAX_RECENT_DOWNLOADS = 250;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const ZIP_BATCH_LIMIT = 80;

const crcTable = (() => {
  const table = new Uint32Array(256);

  for (let i = 0; i < table.length; i += 1) {
    let value = i;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[i] = value >>> 0;
  }

  return table;
})();

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function now() {
  return Date.now();
}

function normalizeUrl(rawUrl) {
  try {
    return new URL(rawUrl).href;
  } catch {
    return "";
  }
}

function sanitizeFilenamePart(value) {
  return String(value || "facebook-images")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "facebook-images";
}

function padIndex(index) {
  return String(index).padStart(3, "0");
}

function getExtensionFromType(type) {
  const normalized = String(type || "").split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg"
  };

  return map[normalized] || "";
}

function getExtensionFromUrl(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/);
    const extension = match ? match[1] : "";
    return ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg"].includes(extension) ? extension.replace("jpeg", "jpg") : "";
  } catch {
    return "";
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;

  for (let i = 0; i < bytes.length; i += 1) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { dosTime, dosDate };
}

function concatUint8Arrays(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function createZip(files) {
  const encoder = new TextEncoder();
  const { dosTime, dosDate } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const bytes = file.bytes;
    const checksum = crc32(bytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);

    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, bytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + bytes.length;
  }

  const centralDirectory = concatUint8Arrays(centralParts);
  const endHeader = new Uint8Array(22);
  const endView = new DataView(endHeader.buffer);

  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return concatUint8Arrays([...localParts, centralDirectory, endHeader]);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

async function rememberDownload(key) {
  const data = await storageGet({ [RECENT_DOWNLOADS_KEY]: [] });
  const cutoff = now() - DUPLICATE_WINDOW_MS;
  const recent = data[RECENT_DOWNLOADS_KEY]
    .filter((entry) => entry.time > cutoff && entry.key !== key)
    .slice(0, MAX_RECENT_DOWNLOADS - 1);

  recent.unshift({ key, time: now() });
  await storageSet({ [RECENT_DOWNLOADS_KEY]: recent });
}

async function wasRecentlyDownloaded(key) {
  const data = await storageGet({ [RECENT_DOWNLOADS_KEY]: [] });
  const cutoff = now() - DUPLICATE_WINDOW_MS;
  return data[RECENT_DOWNLOADS_KEY].some((entry) => entry.key === key && entry.time > cutoff);
}

async function downloadImage(payload, sendResponse) {
  const url = normalizeUrl(payload && payload.url);

  if (!url || url.startsWith("blob:")) {
    sendResponse({ ok: false, error: "This image URL cannot be downloaded by the extension." });
    return;
  }

  const duplicateKey = `${payload.pageUrl || ""}|${url}`;

  if (await wasRecentlyDownloaded(duplicateKey)) {
    sendResponse({ ok: true, skipped: true, reason: "duplicate" });
    return;
  }

  chrome.downloads.download(
    {
      url,
      saveAs: false,
      conflictAction: "uniquify"
    },
    async (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      await rememberDownload(duplicateKey);
      sendResponse({ ok: true, downloadId });
    }
  );
}

async function fetchImageForZip(item, index) {
  const url = normalizeUrl(item && item.url);

  if (!url || url.startsWith("blob:")) {
    return { ok: false, error: "Unsupported image URL", url };
  }

  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}`, url };
  }

  const contentType = response.headers.get("content-type") || "";
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (!bytes.length) {
    return { ok: false, error: "Empty image", url };
  }

  const extension = getExtensionFromType(contentType) || getExtensionFromUrl(url) || "jpg";

  return {
    ok: true,
    file: {
      name: `${padIndex(index)}.${extension}`,
      bytes
    }
  };
}

async function downloadZip(payload, sendResponse) {
  const images = Array.isArray(payload && payload.images) ? payload.images.slice(0, ZIP_BATCH_LIMIT) : [];

  if (!images.length) {
    sendResponse({ ok: false, error: "No images found for ZIP download." });
    return;
  }

  const files = [];
  const failed = [];

  for (let index = 0; index < images.length; index += 1) {
    try {
      const result = await fetchImageForZip(images[index], index + 1);

      if (result.ok) {
        files.push(result.file);
      } else {
        failed.push(result);
      }
    } catch (error) {
      failed.push({
        ok: false,
        error: error && error.message ? error.message : "Fetch failed",
        url: images[index].url
      });
    }
  }

  if (!files.length) {
    sendResponse({ ok: false, error: "Images were detected, but none could be fetched for the ZIP." });
    return;
  }

  const zipBytes = createZip(files);
  const fallbackTitle = payload.pageUrl ? new URL(payload.pageUrl).hostname : "facebook-images";
  const pageTitle = sanitizeFilenamePart(payload.pageTitle || fallbackTitle);
  const filename = `${pageTitle}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.zip`;
  let downloadUrl = "";
  let objectUrl = "";

  try {
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      objectUrl = URL.createObjectURL(new Blob([zipBytes], { type: "application/zip" }));
      downloadUrl = objectUrl;
    }
  } catch {
    objectUrl = "";
  }

  if (!downloadUrl) {
    downloadUrl = `data:application/zip;base64,${bytesToBase64(zipBytes)}`;
  }

  chrome.downloads.download(
    {
      url: downloadUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    },
    (downloadId) => {
      if (objectUrl) {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
      }

      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      sendResponse({
        ok: true,
        downloadId,
        requested: images.length,
        downloaded: files.length,
        failed: failed.length
      });
    }
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "IID_DOWNLOAD_IMAGE") {
    downloadImage(message.payload || {}, sendResponse);
    return true;
  }

  if (message.type === "IID_DOWNLOAD_ZIP") {
    downloadZip(message.payload || {}, sendResponse);
    return true;
  }

  return false;
});
