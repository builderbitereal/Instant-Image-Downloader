(() => {
if (window.__IID_CONTENT_SCRIPT_LOADED__) return;
window.__IID_CONTENT_SCRIPT_LOADED__ = true;

const IID_SETTINGS_KEY = "iidSettings";
const IID_LAST_LEFT_KEY = "iidLastLeftDownloadKey";
const IMAGE_MIN_AREA = 120 * 120;
const WAIT_FOR_IMAGE_MS = 12000;
const WAIT_FOR_CHANGE_MS = 9000;

const DEFAULT_SETTINGS = {
  instantEnabled: false,
  leftEnabled: false,
  leftLimit: 0,
  leftRemaining: null,
  lastStatus: ""
};

let instantObserver = null;
let instantDebounce = null;
let leftRunnerActive = false;
let pickerActive = false;
let pickerTarget = null;

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

async function getSettings() {
  const data = await storageGet({ [IID_SETTINGS_KEY]: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...data[IID_SETTINGS_KEY] };
}

async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await storageSet({ [IID_SETTINGS_KEY]: next });
  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisible(element) {
  if (!element || !element.isConnected) return false;

  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 20 && rect.height > 20 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
}

function absoluteUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl, location.href).href;
  } catch {
    return "";
  }
}

function getBackgroundImageUrl(element) {
  const bg = getComputedStyle(element).backgroundImage;
  if (!bg || bg === "none") return "";

  const match = bg.match(/url\((["']?)(.*?)\1\)/);
  return match ? absoluteUrl(match[2]) : "";
}

function imageFromElement(element) {
  if (!element || !isVisible(element)) return null;

  if (element.tagName === "IMG") {
    const url = absoluteUrl(element.currentSrc || element.src);
    if (!url) return null;

    const rect = element.getBoundingClientRect();
    return {
      url,
      element,
      width: rect.width,
      height: rect.height,
      area: rect.width * rect.height,
      source: "img"
    };
  }

  const bgUrl = getBackgroundImageUrl(element);
  if (!bgUrl) return null;

  const rect = element.getBoundingClientRect();
  return {
    url: bgUrl,
    element,
    width: rect.width,
    height: rect.height,
    area: rect.width * rect.height,
    source: "background"
  };
}

function collectImageCandidates(root = document) {
  const candidates = [];
  const seen = new Set();
  const imageElements = Array.from(root.querySelectorAll("img"));
  const backgroundElements = Array.from(root.querySelectorAll("html, body, [style], picture, div, section, article, a, button, figure, main"));

  for (const element of [...imageElements, ...backgroundElements]) {
    const candidate = imageFromElement(element);

    if (!candidate || candidate.area < IMAGE_MIN_AREA || seen.has(candidate.url)) {
      continue;
    }

    seen.add(candidate.url);
    candidates.push(candidate);
  }

  return candidates.sort((a, b) => scoreImage(b) - scoreImage(a));
}

function visualOrderScore(candidate) {
  const rect = candidate.element.getBoundingClientRect();

  return {
    top: Math.round(rect.top + scrollY),
    left: Math.round(rect.left + scrollX)
  };
}

function isLikelyBatchImage(candidate) {
  if (!candidate || !candidate.url) return false;

  const url = candidate.url.toLowerCase();
  if (url.startsWith("blob:")) return false;
  if (url.includes("emoji") || url.includes("static.xx.fbcdn.net")) return false;

  const element = candidate.element;
  const naturalWidth = element.naturalWidth || candidate.width;
  const naturalHeight = element.naturalHeight || candidate.height;
  const minSide = Math.min(candidate.width, candidate.height);
  const naturalArea = naturalWidth * naturalHeight;

  return minSide >= 90 && candidate.area >= 14000 && naturalArea >= 40000;
}

function collectBatchCandidates(root = document) {
  const candidates = [];
  const seen = new Set();
  const imageElements = Array.from(root.querySelectorAll("img"));
  const backgroundElements = Array.from(root.querySelectorAll("[style], picture, div, section, article, a, button, figure, main"));

  for (const element of [...imageElements, ...backgroundElements]) {
    const candidate = imageFromElement(element);

    if (!isLikelyBatchImage(candidate) || seen.has(candidate.url)) {
      continue;
    }

    const order = visualOrderScore(candidate);
    seen.add(candidate.url);
    candidates.push({
      url: candidate.url,
      width: Math.round(candidate.width),
      height: Math.round(candidate.height),
      top: order.top,
      left: order.left,
      source: candidate.source,
      element: candidate.element
    });
  }

  return candidates
    .sort((a, b) => (a.top - b.top) || (a.left - b.left))
    .map(({ element, ...item }) => item);
}

function findFacebookPostRoot() {
  if (!/(\.|^)facebook\.com$/i.test(location.hostname) && !/(\.|^)fb\.com$/i.test(location.hostname)) {
    return null;
  }

  const primary = getPrimaryImage();
  let element = primary && primary.element;

  while (element && element !== document.body) {
    const role = element.getAttribute("role");
    const dataPagelet = element.getAttribute("data-pagelet") || "";

    if (role === "article" || role === "dialog" || dataPagelet.includes("FeedUnit")) {
      const candidates = collectBatchCandidates(element);
      if (candidates.length >= 2) {
        return element;
      }
    }

    element = element.parentElement;
  }

  return null;
}

function collectBatchImageList() {
  const facebookRoot = findFacebookPostRoot();
  const rootCandidates = facebookRoot ? collectBatchCandidates(facebookRoot) : [];
  const documentCandidates = collectBatchCandidates(document);
  const candidates = rootCandidates.length >= 2 ? rootCandidates : documentCandidates;

  return candidates.slice(0, 80);
}

function scoreImage(candidate) {
  const rect = candidate.element.getBoundingClientRect();
  const viewportCenterX = innerWidth / 2;
  const viewportCenterY = innerHeight / 2;
  const imageCenterX = rect.left + rect.width / 2;
  const imageCenterY = rect.top + rect.height / 2;
  const distance = Math.hypot(viewportCenterX - imageCenterX, viewportCenterY - imageCenterY);
  const centerBonus = Math.max(0, 1200 - distance);
  const sourceBonus = candidate.source === "img" ? 4000 : 0;

  return candidate.area + centerBonus + sourceBonus;
}

function getPrimaryImage() {
  return collectImageCandidates()[0] || null;
}

async function waitForPrimaryImage(timeoutMs = WAIT_FOR_IMAGE_MS) {
  const startedAt = Date.now();
  let found = getPrimaryImage();

  if (found) return found;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(350);
    found = getPrimaryImage();
    if (found) return found;
  }

  return null;
}

async function requestDownload(image, source) {
  if (!image || !image.url) {
    await updateSettings({ lastStatus: "No downloadable image found on this page." });
    return { ok: false, error: "No image found" };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "IID_DOWNLOAD_IMAGE",
        payload: {
          url: image.url,
          pageUrl: location.href,
          pageTitle: document.title,
          source
        }
      },
      async (response) => {
        const result = response || { ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message };

        if (result.ok && result.skipped) {
          await updateSettings({ lastStatus: "Already downloaded this image recently." });
        } else if (result.ok) {
          await updateSettings({ lastStatus: "Image download started." });
        } else {
          await updateSettings({ lastStatus: result.error || "Download failed." });
        }

        resolve(result);
      }
    );
  });
}

function scheduleInstantDownload() {
  clearTimeout(instantDebounce);
  instantDebounce = setTimeout(async () => {
    const settings = await getSettings();
    if (!settings.instantEnabled || settings.leftEnabled) return;

    const image = await waitForPrimaryImage(1500);
    await requestDownload(image, "instant");
  }, 450);
}

async function applyInstantMode() {
  const settings = await getSettings();

  if (instantObserver) {
    instantObserver.disconnect();
    instantObserver = null;
  }

  clearTimeout(instantDebounce);

  if (!settings.instantEnabled || settings.leftEnabled) {
    return;
  }

  scheduleInstantDownload();

  instantObserver = new MutationObserver(scheduleInstantDownload);
  instantObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style", "class"]
  });
}

function visibleClickable(element) {
  if (!isVisible(element)) return false;
  const disabled = element.disabled || element.getAttribute("aria-disabled") === "true";
  return !disabled;
}

function findLeftArrowControl() {
  const controls = Array.from(document.querySelectorAll("button, a, [role='button'], [onclick], .prev, .previous, .swiper-button-prev"));
  const terms = ["left", "prev", "previous", "back", "arrow"];

  return controls
    .filter(visibleClickable)
    .map((element) => {
      const text = [
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("class"),
        element.id
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const rect = element.getBoundingClientRect();
      const symbolHit = /[\u2039\u2190\u25c0\u276e]/.test(text);
      const termHit = terms.some((term) => text.includes(term));
      const leftSideBonus = Math.max(0, innerWidth * 0.45 - rect.left);
      const centerPenalty = Math.abs(rect.top + rect.height / 2 - innerHeight / 2);

      return {
        element,
        score: (symbolHit ? 5000 : 0) + (termHit ? 3000 : 0) + leftSideBonus - centerPenalty
      };
    })
    .filter((item) => item.score > 500)
    .sort((a, b) => b.score - a.score)[0]?.element || null;
}

function triggerLeftAction() {
  const control = findLeftArrowControl();

  if (control) {
    control.click();
    return "click";
  }

  const options = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37, bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent("keydown", options));
  window.dispatchEvent(new KeyboardEvent("keydown", options));
  document.dispatchEvent(new KeyboardEvent("keyup", options));
  window.dispatchEvent(new KeyboardEvent("keyup", options));
  return "keyboard";
}

function pageImageKey(image) {
  return `${location.href}|${image ? image.url : ""}`;
}

async function waitForImageChange(previousKey, timeoutMs = WAIT_FOR_CHANGE_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(450);
    const image = getPrimaryImage();
    if (image && pageImageKey(image) !== previousKey) {
      return image;
    }
  }

  return null;
}

async function runLeftMode() {
  if (leftRunnerActive) return;
  leftRunnerActive = true;

  try {
    while (true) {
      let settings = await getSettings();
      if (!settings.leftEnabled) break;

      const hasLimit = Number(settings.leftLimit) > 0;
      if (hasLimit && Number(settings.leftRemaining) <= 0) {
        await updateSettings({ leftEnabled: false, lastStatus: "Left Arrow run finished." });
        break;
      }

      const image = await waitForPrimaryImage();
      if (!image) {
        await updateSettings({ leftEnabled: false, lastStatus: "Stopped: no image found." });
        break;
      }

      const key = pageImageKey(image);
      const stored = await storageGet({ [IID_LAST_LEFT_KEY]: "" });

      if (stored[IID_LAST_LEFT_KEY] !== key) {
        await requestDownload(image, "left-arrow");
        await storageSet({ [IID_LAST_LEFT_KEY]: key });
      }

      settings = await getSettings();

      if (hasLimit) {
        const nextRemaining = Math.max(0, Number(settings.leftRemaining) - 1);
        await updateSettings({ leftRemaining: nextRemaining });

        if (nextRemaining <= 0) {
          await updateSettings({ leftEnabled: false, lastStatus: "Left Arrow run finished." });
          break;
        }
      }

      await sleep(800);
      const action = triggerLeftAction();
      await updateSettings({ lastStatus: action === "click" ? "Clicked left arrow, waiting for next image." : "Pressed ArrowLeft, waiting for next image." });

      const changedImage = await waitForImageChange(key);
      if (!changedImage && location.href === key.split("|")[0]) {
        await updateSettings({ leftEnabled: false, lastStatus: "Stopped: left action did not reveal a new image." });
        break;
      }

      await sleep(600);
    }
  } finally {
    leftRunnerActive = false;
    applyInstantMode();
  }
}

function setPickerHighlight(element) {
  if (pickerTarget === element) return;
  clearPickerHighlight();

  pickerTarget = element;
  pickerTarget.dataset.iidPreviousOutline = pickerTarget.style.outline || "";
  pickerTarget.dataset.iidPreviousCursor = pickerTarget.style.cursor || "";
  pickerTarget.style.outline = "3px solid #22c55e";
  pickerTarget.style.cursor = "crosshair";
}

function clearPickerHighlight() {
  if (!pickerTarget) return;
  pickerTarget.style.outline = pickerTarget.dataset.iidPreviousOutline || "";
  pickerTarget.style.cursor = pickerTarget.dataset.iidPreviousCursor || "";
  delete pickerTarget.dataset.iidPreviousOutline;
  delete pickerTarget.dataset.iidPreviousCursor;
  pickerTarget = null;
}

function imageFromPointTarget(target) {
  let element = target;

  while (element && element !== document.documentElement) {
    const candidate = imageFromElement(element);
    if (candidate) return candidate;
    element = element.parentElement;
  }

  return null;
}

function pickerMouseOver(event) {
  const candidate = imageFromPointTarget(event.target);
  if (candidate) {
    setPickerHighlight(candidate.element);
  } else {
    clearPickerHighlight();
  }
}

async function pickerClick(event) {
  const candidate = imageFromPointTarget(event.target);
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  stopPicker();
  await requestDownload(candidate, "manual-pick");
}

function stopPicker() {
  if (!pickerActive) return;
  pickerActive = false;
  clearPickerHighlight();
  document.documentElement.style.cursor = "";
  document.removeEventListener("mouseover", pickerMouseOver, true);
  document.removeEventListener("click", pickerClick, true);
  document.removeEventListener("keydown", pickerKeyDown, true);
}

function pickerKeyDown(event) {
  if (event.key === "Escape") {
    stopPicker();
  }
}

function startPicker() {
  stopPicker();
  pickerActive = true;
  document.documentElement.style.cursor = "crosshair";
  document.addEventListener("mouseover", pickerMouseOver, true);
  document.addEventListener("click", pickerClick, true);
  document.addEventListener("keydown", pickerKeyDown, true);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) {
      sendResponse({ ok: false });
      return;
    }

    if (message.type === "IID_DOWNLOAD_PRIMARY") {
      const image = await waitForPrimaryImage();
      const result = await requestDownload(image, "manual-now");
      sendResponse(result);
      return;
    }

    if (message.type === "IID_START_PICKER") {
      startPicker();
      await updateSettings({ lastStatus: "Click an image on the page to download it." });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "IID_COLLECT_BATCH_IMAGES") {
      const images = collectBatchImageList();
      await updateSettings({
        lastStatus: images.length ? `Found ${images.length} images for ZIP.` : "No batch images found on this page."
      });
      sendResponse({
        ok: images.length > 0,
        images,
        pageUrl: location.href,
        pageTitle: document.title,
        error: images.length ? "" : "No batch images found on this page."
      });
      return;
    }

    if (message.type === "IID_APPLY_SETTINGS") {
      await applyInstantMode();
      const settings = await getSettings();
      if (settings.leftEnabled) {
        runLeftMode();
      }
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false });
  })();

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[IID_SETTINGS_KEY]) return;
  applyInstantMode();
  getSettings().then((settings) => {
    if (settings.leftEnabled) {
      runLeftMode();
    }
  });
});

applyInstantMode();
getSettings().then((settings) => {
  if (settings.leftEnabled) {
    runLeftMode();
  }
});
})();
