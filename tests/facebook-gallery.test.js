const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function loadContentScript() {
  const context = vm.createContext({
    URL, Set, console,
    window: {},
    location: { hostname: "www.facebook.com", pathname: "/posts/123", href: "https://www.facebook.com/posts/123" },
    document: { querySelectorAll: () => [], querySelector: () => null, title: "Post" },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { onChanged: { addListener() {} }, local: {
        get(defaults, callback) { callback(defaults); },
        set(values, callback) { callback(); }
      } }
    },
    setTimeout, clearTimeout
  });
  let source = fs.readFileSync(path.join(__dirname, "../contentScript.js"), "utf8");
  source = source.slice(0, source.lastIndexOf("\napplyInstantMode();")) + `
    globalThis.api = { expandFacebookGallery, waitForFbPhoto, findFbViewerControl,
      findFbPhotoViewerImage, facebookImageKey, facebookPhotoTiles, pressRightArrow, runBatchZip };
    globalThis.configure = (code) => eval(code);
  })();`;
  vm.runInContext(source, context);
  context.configure(`
    let clock = 0;
    Date.now = () => clock;
    sleep = async (ms) => { clock += ms; };
  `);
  return context;
}

function configureGallery(context, { total = 47, tiles = 5, hidden = 43, stopAt = total, wrap = false } = {}) {
  context.configure(`
    let index = -1;
    globalThis.closed = 0;
    globalThis.advances = 0;
    const photos = Array.from({ length: ${total} }, (_, i) => ({
      url: 'https://scontent.fbcdn.net/view/photo-' + i + '.jpg?size=large',
      element: { naturalWidth: 1000, naturalHeight: 1000 }
    }));
    const link = { closest() { return this; }, click() { index = 0; } };
    isFacebookSite = () => true;
    findFacebookPostRoot = () => ({});
    findPlusNOverlay = () => ({ count: ${hidden}, element: link });
    facebookPhotoTiles = () => Array.from({ length: ${tiles} }, () => link);
    collectBatchCandidates = () => [];
    findFbPhotoViewerImage = () => photos[index] || null;
    pressRightArrow = () => {
      globalThis.advances++;
      if (index + 1 < ${stopAt}) index++;
      else if (${wrap}) index = 0;
    };
    closeFbPhotoViewer = () => { globalThis.closed++; };
  `);
}

test("+43 with five preview tiles collects all 47 full-size photos in order", async () => {
  const context = loadContentScript();
  configureGallery(context);
  const progress = [];
  const photos = await context.api.expandFacebookGallery((status) => progress.push(status));
  assert.equal(photos.length, 47);
  assert.equal(new Set(photos.map((photo) => photo.url)).size, 47);
  assert.match(photos[0].url, /photo-0\.jpg/);
  assert.match(photos[46].url, /photo-46\.jpg/);
  assert.equal(context.advances, 46);
  assert.equal(context.closed, 1);
  assert.match(progress.at(-1), /47 of 47/);
});

test("expected count follows actual grid size rather than assuming five tiles", async () => {
  const context = loadContentScript();
  configureGallery(context, { total: 43, tiles: 3, hidden: 41 });
  assert.equal((await context.api.expandFacebookGallery()).length, 43);
  assert.equal(context.advances, 42);
});

test("slow navigation waits for the new loaded photo instead of counting the old one", async () => {
  const context = loadContentScript();
  context.configure(`
    const oldPhoto = { url: 'https://scontent.fbcdn.net/old.jpg' };
    const newPhoto = { url: 'https://scontent.fbcdn.net/new.jpg' };
    findFbPhotoViewerImage = () => Date.now() < 5000 ? oldPhoto : newPhoto;
  `);
  const photo = await context.api.waitForFbPhoto(new Set(), "old.jpg");
  assert.match(photo.url, /new.jpg/);
});

test("stalled and wrapped galleries report incomplete collection and close the viewer", async () => {
  for (const wrap of [false, true]) {
    const context = loadContentScript();
    configureGallery(context, { stopAt: 7, wrap });
    await assert.rejects(context.api.expandFacebookGallery(), /7 of 47|earlier photo after 7/);
    assert.equal(context.closed, 1);
  }
});

test("opening failure never returns a successful visible-only batch", async () => {
  const context = loadContentScript();
  configureGallery(context);
  context.configure("findFbPhotoViewerImage = () => null;");
  await assert.rejects(context.api.expandFacebookGallery(), /Could not open/);
  assert.equal(context.advances, 0);
});

test("posts beyond the ZIP limit are not silently truncated", async () => {
  const context = loadContentScript();
  configureGallery(context, { hidden: 201 });
  await assert.rejects(context.api.expandFacebookGallery(), /ZIP limit is 200/);
});

test("CDN resize and signed URL changes identify the same photo", () => {
  const { api } = loadContentScript();
  assert.equal(api.facebookImageKey("https://scontent-a.fbcdn.net/s200/123.jpg?token=one"),
    api.facebookImageKey("https://scontent-b.fbcdn.net/s1000/123.jpg?token=two"));
});

test("photo grid counting includes rendered tiles above the viewport", () => {
  const context = loadContentScript();
  const img = { getBoundingClientRect: () => ({ top: -500, bottom: -200, width: 300, height: 300 }) };
  const link = { href: "https://www.facebook.com/photo/?fbid=123",
    querySelector: () => img, querySelectorAll: () => [img] };
  context.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  assert.equal(context.api.facebookPhotoTiles({ querySelectorAll: () => [link] }).length, 1);
  context.getComputedStyle = () => ({ display: "none", visibility: "visible", opacity: "1" });
  assert.equal(context.api.facebookPhotoTiles({ querySelectorAll: () => [link] }).length, 0);
});

test("keyboard fallback dispatches one keydown instead of skipping two photos", () => {
  const context = loadContentScript();
  const events = [];
  const target = { dispatchEvent: (event) => events.push(event) };
  context.KeyboardEvent = class { constructor(type, options) { Object.assign(this, { type }, options); } };
  context.configure("findFbViewerControl = () => null;");
  context.api.pressRightArrow({ element: { closest: () => target } });
  assert.equal(events.filter((event) => event.type === "keydown").length, 1);
  assert.equal(events[0].key, "ArrowRight");
  assert.equal(events[0].bubbles, true);
});

test("viewer navigation chooses Next photo rather than Previous or unrelated controls", () => {
  const context = loadContentScript();
  const control = (label, left) => ({
    getAttribute(name) { return name === "aria-label" ? label : null; },
    getBoundingClientRect() { return { left, top: 100 }; }
  });
  const previous = control("Previous photo", 10);
  const unrelated = control("Like", 1000);
  const next = control("Next photo", 800);
  const root = { querySelectorAll: () => [previous, unrelated, next] };
  context.image = { element: { closest: () => root } };
  context.configure("visibleClickable = () => true;");
  assert.equal(context.api.findFbViewerControl(context.image, "next"), next);
});

test("an existing post dialog is not mistaken for the opened photo viewer", () => {
  const context = loadContentScript();
  const preview = {
    currentSrc: "https://scontent.fbcdn.net/preview.jpg",
    complete: true, naturalWidth: 1000,
    getBoundingClientRect: () => ({ width: 800, height: 800 })
  };
  const full = { ...preview, currentSrc: "https://scontent.fbcdn.net/full.jpg",
    getBoundingClientRect: () => ({ width: 500, height: 500 }) };
  context.document.querySelectorAll = () => [preview];
  context.configure("isVisible = () => true;");
  const initialImages = new Set([preview]);
  assert.equal(context.api.findFbPhotoViewerImage(initialImages), null);
  context.document.querySelectorAll = () => [preview, full];
  assert.equal(context.api.findFbPhotoViewerImage(initialImages).url, full.currentSrc);
  context.location.pathname = "/photo/123";
  assert.equal(context.api.findFbPhotoViewerImage(initialImages).url, full.currentSrc);
});

test("ZIP creation continues in the content script and sends all photos to the worker", async () => {
  const context = loadContentScript();
  configureGallery(context);
  let payload;
  const statuses = [];
  context.chrome.runtime.sendMessage = (message, callback) => {
    payload = message.payload;
    callback({ ok: true, downloaded: payload.images.length, failed: 0 });
  };
  context.chrome.storage.local.set = (values, callback) => {
    statuses.push(values.iidSettings.lastStatus);
    callback();
  };
  await context.api.runBatchZip();
  assert.equal(payload.images.length, 47);
  assert.equal(payload.pageUrl, "https://www.facebook.com/posts/123");
  assert.equal(statuses.at(-1), "ZIP download started: 47 images.");
});
