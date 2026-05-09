const IID_SETTINGS_KEY = "iidSettings";

const DEFAULT_SETTINGS = {
  instantEnabled: false,
  leftEnabled: false,
  leftLimit: 0,
  leftRemaining: null,
  lastStatus: ""
};

const instantEnabled = document.getElementById("instantEnabled");
const leftEnabled = document.getElementById("leftEnabled");
const leftLimit = document.getElementById("leftLimit");
const startLeft = document.getElementById("startLeft");
const stopLeft = document.getElementById("stopLeft");
const downloadZip = document.getElementById("downloadZip");
const downloadNow = document.getElementById("downloadNow");
const pickImage = document.getElementById("pickImage");
const statusEl = document.getElementById("status");

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

async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await storageSet({ [IID_SETTINGS_KEY]: next });
  render(next);
  await notifyActiveTab();
  return next;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function notifyActiveTab() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "IID_APPLY_SETTINGS" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["contentScript.js"]
    });
    await chrome.tabs.sendMessage(tab.id, { type: "IID_APPLY_SETTINGS" });
  }
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    return { ok: false, error: "No active tab found." };
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["contentScript.js"]
    });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

function render(settings) {
  instantEnabled.checked = Boolean(settings.instantEnabled);
  leftEnabled.checked = Boolean(settings.leftEnabled);
  leftLimit.value = Number(settings.leftLimit) > 0 ? String(settings.leftLimit) : "";

  const pieces = [];
  if (settings.instantEnabled) pieces.push("Instant on");
  if (settings.leftEnabled) {
    const remaining = Number(settings.leftRemaining) > 0 ? `, ${settings.leftRemaining} left` : "";
    pieces.push(`Left Arrow running${remaining}`);
  }

  statusEl.textContent = settings.lastStatus || pieces.join(" | ") || "Ready.";
}

function readLimit() {
  const value = Number.parseInt(leftLimit.value, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

instantEnabled.addEventListener("change", async () => {
  await setSettings({
    instantEnabled: instantEnabled.checked,
    leftEnabled: instantEnabled.checked ? false : (await getSettings()).leftEnabled,
    lastStatus: instantEnabled.checked ? "Instant download enabled." : "Instant download disabled."
  });
});

leftEnabled.addEventListener("change", async () => {
  const enabled = leftEnabled.checked;
  const limit = readLimit();

  await setSettings({
    instantEnabled: enabled ? false : (await getSettings()).instantEnabled,
    leftEnabled: enabled,
    leftLimit: limit,
    leftRemaining: enabled && limit > 0 ? limit : null,
    lastStatus: enabled ? "Left Arrow run started." : "Left Arrow run stopped."
  });
});

leftLimit.addEventListener("change", async () => {
  const limit = readLimit();
  const settings = await getSettings();

  await setSettings({
    leftLimit: limit,
    leftRemaining: settings.leftEnabled && limit > 0 ? limit : null,
    lastStatus: limit > 0 ? `Limit set to ${limit}.` : "Limit cleared."
  });
});

startLeft.addEventListener("click", async () => {
  const limit = readLimit();
  await setSettings({
    instantEnabled: false,
    leftEnabled: true,
    leftLimit: limit,
    leftRemaining: limit > 0 ? limit : null,
    lastStatus: "Left Arrow run started."
  });
});

stopLeft.addEventListener("click", async () => {
  await setSettings({
    leftEnabled: false,
    leftRemaining: null,
    lastStatus: "Left Arrow run stopped."
  });
});

downloadZip.addEventListener("click", async () => {
  statusEl.textContent = "Finding post images...";
  const collected = await sendToActiveTab({ type: "IID_COLLECT_BATCH_IMAGES" });

  if (!collected || !collected.ok || !collected.images || !collected.images.length) {
    const settings = await getSettings();
    render({ ...settings, lastStatus: (collected && collected.error) || "No batch images found." });
    return;
  }

  statusEl.textContent = `Creating ZIP from ${collected.images.length} images...`;

  const result = await chrome.runtime.sendMessage({
    type: "IID_DOWNLOAD_ZIP",
    payload: {
      images: collected.images,
      pageUrl: collected.pageUrl,
      pageTitle: collected.pageTitle
    }
  });
  const settings = await getSettings();

  if (result && result.ok) {
    const failed = Number(result.failed) > 0 ? ` (${result.failed} failed)` : "";
    render({ ...settings, lastStatus: `ZIP download started: ${result.downloaded} images${failed}.` });
  } else {
    render({ ...settings, lastStatus: (result && result.error) || "ZIP download failed." });
  }
});

downloadNow.addEventListener("click", async () => {
  statusEl.textContent = "Finding image on this page...";
  const result = await sendToActiveTab({ type: "IID_DOWNLOAD_PRIMARY" });
  const settings = await getSettings();

  if (result && result.ok) {
    render({ ...settings, lastStatus: result.skipped ? "Already downloaded recently." : "Manual download started." });
  } else {
    render({ ...settings, lastStatus: (result && result.error) || "No downloadable image found." });
  }
});

pickImage.addEventListener("click", async () => {
  await sendToActiveTab({ type: "IID_START_PICKER" });
  await setSettings({ lastStatus: "Click an image on the page." });
  window.close();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[IID_SETTINGS_KEY]) {
    render({ ...DEFAULT_SETTINGS, ...changes[IID_SETTINGS_KEY].newValue });
  }
});

getSettings().then(render);
