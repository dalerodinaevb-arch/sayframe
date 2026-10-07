// Drives the real panel (index.html + panel.js) in Chromium, wired to the real host.jsx
// running in a Node vm against a mocked After Effects object model.
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/opt/node-tools/node_modules/playwright")); }

const crypto = require("crypto");
const EXT = process.env.SAYFRAME_EXT || path.join(__dirname, "..", "Sayframe");
const SHOTS = path.join(__dirname, ".tmp", "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const hostSrc = fs.readFileSync(path.join(EXT, "jsx/host.jsx"), "utf8");

function fakePng(i) {
  const n = 300 + i; const b = Buffer.alloc(n);
  for (let k = 0; k < n; k++) b[k] = (k * 37 + i * 11) & 255;
  b.write("\x89PNG", 0, "latin1");
  return b;
}
// A real 2x2 PNG, for the paste-event path that decodes the image in the browser.
const REAL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEImBigAMwAAA8HAQHt0bq5AAAAAElFTkSuQmCC", "base64");

// ------------------------------------------------------------ mocked After Effects
function CompItem() {} function TextLayer() {} function ShapeLayer() {} function CameraLayer() {} function LightLayer() {} function SolidSource() {}

// --- keyframes and transform properties, for the Animation tab
const KIT = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
const PROPERTY = 6212;
function KeyframeEase(speed, influence) {
  if (typeof speed !== "number" || !(influence >= 0.1 && influence <= 100)) throw new Error("KeyframeEase: influence must be between 0.1 and 100");
  this.speed = speed; this.influence = influence;
}
const cloneValue = (v) => (Array.isArray(v) || (v && typeof v === "object" && typeof v.length === "number") ? Array.prototype.slice.call(v) : v);
// A property with optional keyframes. clock.time is the composition's current time.
function Prop(value, clock, opts) {
  opts = opts || {};
  this._v = cloneValue(value); this.clock = clock; this.keys = []; this.propertyType = opts.group ? 6213 : PROPERTY;
  this.easeDims = opts.easeDims || 1; this.dimensionsSeparated = !!opts.separated; this.locked = !!opts.locked; this.calls = [];
  this._expression = ""; this.evalExpression = opts.evalExpression || null;
}
Prop.prototype = {
  get numKeys() { return this.keys.length; },
  get value() { return this.keys.length ? this.valueAtTime(this.clock.time, true) : cloneValue(this._v); },
  get expression() { return this._expression; },
  set expression(x) { this._expression = x; },
  get selectedKeys() { const r = []; this.keys.forEach((k, i) => { if (k.selected) r.push(i + 1); }); return r; },
  _check(v) {
    if (this.locked) throw new Error("After Effects error: layer is locked");
    const want = Array.isArray(this._v) ? this._v.length : 0, got = (v && typeof v === "object") ? v.length : 0;
    if (want !== got || (want === 0 && typeof v !== "number")) throw new Error("After Effects error: value has the wrong number of dimensions");
    if (got && Array.prototype.some.call(v, (x) => typeof x !== "number" || isNaN(x))) throw new Error("After Effects error: value is not a number");
  },
  valueAtTime(t, preExpression) {
    if (!preExpression && this._expression) { if (!this.evalExpression) throw new Error("expression error"); return this.evalExpression(this._expression, t); }
    if (!this.keys.length) return cloneValue(this._v);
    let k = this.keys[0]; for (const c of this.keys) if (c.time <= t + 1e-9) k = c;
    return cloneValue(k.value);
  },
  setValue(v) { this._check(v); if (this.keys.length) throw new Error("After Effects error: the property has keyframes, use setValueAtTime"); this.calls.push("setValue"); this._v = cloneValue(v); },
  setValueAtTime(t, v) {
    this._check(v); this.calls.push("setValueAtTime");
    const hit = this.keys.find((k) => Math.abs(k.time - t) < 1e-9);
    if (hit) { hit.value = cloneValue(v); return; }
    this.keys.push(this._key(t, v)); this.keys.sort((a, b) => a.time - b.time);
  },
  setValueAtKey(i, v) { this._check(v); this.calls.push("setValueAtKey"); this.keys[i - 1].value = cloneValue(v); },
  keyValue(i) { return cloneValue(this.keys[i - 1].value); },
  keyTime(i) { return this.keys[i - 1].time; },
  _ease(speed, influence) { const r = []; for (let i = 0; i < this.easeDims; i++) r.push(new KeyframeEase(speed, influence)); return r; },
  _key(t, v, o) { o = o || {}; return { time: t, value: cloneValue(v), selected: !!o.selected, inType: o.inType || KIT.LINEAR, outType: o.outType || KIT.LINEAR, inEase: this._ease(11, 16.67), outEase: this._ease(22, 16.67) }; },
  addKey(t, v, o) { this.keys.push(this._key(t, v, o)); this.keys.sort((a, b) => a.time - b.time); return this; },
  keyInTemporalEase(i) { return this.keys[i - 1].inEase.slice(); },
  keyOutTemporalEase(i) { return this.keys[i - 1].outEase.slice(); },
  keyInInterpolationType(i) { return this.keys[i - 1].inType; },
  keyOutInterpolationType(i) { return this.keys[i - 1].outType; },
  setInterpolationTypeAtKey(i, a, b) {
    if (this.locked) throw new Error("After Effects error: layer is locked");
    if (Object.values(KIT).indexOf(a) < 0 || Object.values(KIT).indexOf(b) < 0) throw new Error("bad interpolation type");
    this.keys[i - 1].inType = a; this.keys[i - 1].outType = b;
  },
  setTemporalEaseAtKey(i, a, b) {
    if (this.locked) throw new Error("After Effects error: layer is locked");
    for (const list of [a, b]) {
      if (!list || list.length !== this.easeDims) throw new Error("After Effects error: wrong number of KeyframeEase objects");
      for (let n = 0; n < list.length; n++) if (!(list[n] instanceof KeyframeEase)) throw new Error("After Effects error: not a KeyframeEase");
    }
    this.keys[i - 1].inEase = Array.prototype.slice.call(a); this.keys[i - 1].outEase = Array.prototype.slice.call(b);
  }
};
// A layer with a transform group. o: { rect, anchor, position, scale, rotation, threeD, kind, locked, separated }
function mkLayer(clock, o) {
  const proto = o.kind === "camera" ? CameraLayer.prototype : o.kind === "light" ? LightLayer.prototype : o.kind === "text" ? TextLayer.prototype : Object.prototype;
  const L = Object.create(proto);
  const lock = { locked: !!o.locked };
  const pos = o.position || [0, 0, 0];
  const props = {
    "ADBE Anchor Point": new Prop(o.anchor || [0, 0, 0], clock, lock),
    "ADBE Position": new Prop(pos, clock, Object.assign({ separated: !!o.separated }, lock)),
    "ADBE Position_0": new Prop(pos[0], clock, lock), "ADBE Position_1": new Prop(pos[1], clock, lock), "ADBE Position_2": new Prop(pos[2] || 0, clock, lock),
    "ADBE Scale": new Prop(o.scale || [100, 100, 100], clock, lock),
    "ADBE Rotate Z": new Prop(o.rotation || 0, clock, lock)
  };
  Object.assign(L, { name: o.name || "Слой", index: o.index || 1, selected: true, threeDLayer: !!o.threeD, props, rect: o.rect || { left: 0, top: 0, width: 100, height: 100 },
    property(n) { return n === "ADBE Transform Group" ? { property: (m) => props[m] || null } : null; },
    sourceRectAtTime() { return Object.assign({}, L.rect); },
    // where a point of the layer ends up in its parent's space, with the current transform
    world(pt) {
      const a = props["ADBE Anchor Point"].value, s = props["ADBE Scale"].value, r = props["ADBE Rotate Z"].value * Math.PI / 180;
      const p = o.separated ? [props["ADBE Position_0"].value, props["ADBE Position_1"].value, props["ADBE Position_2"].value] : props["ADBE Position"].value;
      const x = (pt[0] - a[0]) * s[0] / 100, y = (pt[1] - a[1]) * s[1] / 100;
      return [p[0] + x * Math.cos(r) - y * Math.sin(r), p[1] + x * Math.sin(r) + y * Math.cos(r), (p[2] || 0) + ((pt[2] || 0) - (a[2] || 0))];
    } });
  return L;
}
function makeAE(opts, tmpDir) {
  const log = { undo: [], removed: [], opened: 0, imports: [], layerAdds: [], precomposes: [], bins: [], ran: [], refComps: [], nullsAdded: 0, nullsRemoved: 0, nullSourcesRemoved: 0, nulls: [], nullExpressions: [] };
  function File(p) { this.fsName = p; this.name = encodeURI(path.basename(p)); }
  Object.defineProperty(File.prototype, "exists", { get() { return fs.existsSync(this.fsName); } });
  Object.defineProperty(File.prototype, "length", { get() { return fs.existsSync(this.fsName) ? fs.statSync(this.fsName).size : 0; } });
  function ImportOptions(f) { this.file = f; }
  const rootFolder = { name: "Root" };
  function FolderItem(name) { this.name = name; this.parentFolder = rootFolder; }
  const comp = Object.assign(new CompItem(), { name: "Тест", width: 1920, height: 1080, duration: 10, frameRate: 30, time: opts.compTime || 0, numLayers: 2, workAreaStart: 0, workAreaDuration: 5,
    openInViewer() { log.opened++; project.activeItem = comp; },
    selectedProperties: opts.selectedProperties || [], selectedLayers: opts.selectedLayers || [],
    layers: { add(item) { log.layerAdds.push(item); return { index: 1, property() { return { property() { return { setValue() {} }; } }; } }; },
      // A temporary null, as After Effects adds it: on top (other layers move down one index) and it becomes the only selected layer.
      addNull() {
        const all = comp.selectedLayers.slice();
        all.forEach((l) => { l.index += 1; l.selected = false; });
        const position = new Prop([0, 0, 0], comp, { evalExpression(expr) {
          log.nullExpressions.push(expr);
          if (opts.expressionsFail) throw new Error("expression disabled");
          const idx = Number(/thisComp\.layer\((\d+)\)/.exec(expr)[1]);
          const pt = /toWorld\(\[([^\]]+)\]\)/.exec(expr)[1].split(",").map(Number);
          const target = all.find((l) => l.index === idx);
          if (!target) throw new Error("expression: no layer " + idx);
          return target.world(pt);
        } });
        const nul = { index: 1, threeDLayer: false, selected: true, source: { remove() { log.nullSourcesRemoved++; } },
          property: (n) => (n === "ADBE Transform Group" ? { property: (m) => (m === "ADBE Position" ? position : null) } : null),
          remove() { log.nullsRemoved++; all.forEach((l) => { l.index -= 1; }); } };
        log.nullsAdded++; log.nulls.push(nul);
        return nul;
      },
      precompose(idx, name, moveAll) { log.precomposes.push({ idx: Array.prototype.slice.call(idx), name, moveAll }); return Object.assign(new CompItem(), { name }); } },
    layer(i) { const l = i === 1 ? new TextLayer() : {}; return Object.assign(l, { name: i === 1 ? "Заголовок" : "Фон", selected: i === 1, enabled: true, threeDLayer: false, parent: null, inPoint: 0, outPoint: 10, index: i, source: i === 2 ? { mainSource: new SolidSource() } : null }); } });
  const projItems = [comp];
  const project = { get numItems() { return projItems.length; }, activeItem: opts.noActiveComp ? null : comp, item(i) { return projItems[i - 1]; },
    file: opts.projectFile ? new File(opts.projectFile) : null, rootFolder,
    importFile(io) {
      if (opts.importThrows) throw new Error("unsupported file");
      log.imports.push(io.file.fsName);
      const it = Object.assign({ name: path.basename(io.file.fsName), parentFolder: rootFolder, remove() { log.removed.push("item"); } }, opts.footage);
      project.activeItem = it;
      return it;
    },
    items: { addFolder(name) { const f = new FolderItem(name); projItems.push(f); log.bins.push(name); return f; },
      addComp(name, w, h, par, dur, fps) {
        const c = Object.assign(new CompItem(), { name, width: w, height: h, duration: dur, frameRate: fps, saved: [], scaleSet: null,
          openInViewer() { log.opened++; project.activeItem = c; },
          layers: { add(it) { c.added = it; return { property() { return { property() { return { setValue(v) { c.scaleSet = v; } }; } }; } }; } },
          saveFrameToPng(t, file) { c.saved.push(t); fs.writeFileSync(file.fsName, fakePng(c.saved.length - 1)); },
          remove() { log.removed.push("comp"); } });
        log.refComps.push(c); return c;
      } } };
  const app = { version: "26.0", project,
    preferences: { getPrefAsLong: () => (opts.fileAccessOff ? 0 : 1) },
    beginUndoGroup: (n) => log.undo.push("begin:" + n), endUndoGroup: () => log.undo.push("end"), __ran: (x) => log.ran.push(x) };
  const ctx = vm.createContext({ app, File, FolderItem, ImportOptions, CompItem, TextLayer, ShapeLayer, CameraLayer, LightLayer, SolidSource, $: { sleep() {} },
    KeyframeEase, KeyframeInterpolationType: KIT, PropertyType: { PROPERTY, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 } });
  if (!opts.hostNotPreloaded) vm.runInContext(hostSrc, ctx);
  log.scripts = [];
  return { log, project, comp, projItems, ctx, evalScript(script) {
    log.lastScript = script; log.scripts.push(script);
    if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(script)) return "EvalScript error."; // the bridge must stay ASCII
    try {
      if (/^\$\.evalFile\(/.test(script)) { vm.runInContext(hostSrc, ctx); return vm.runInContext("typeof sayframeHost", ctx); }
      const r = vm.runInContext(script, ctx); return typeof r === "string" ? r : String(r);
    } catch (e) { return "EvalScript error."; }
  } };
}

const msg = (text, stop) => ({ type: "message", content: [{ type: "text", text }], stop_reason: stop || "end_turn" });
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + extra : "")); } }

(async () => {
  const browser = await chromium.launch();

  // One scenario = one fresh page with its own mocked AE, platform and scripted API replies.
  async function open(opts) {
    opts = opts || {};
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cep-"));
    const home = path.join(tmpDir, "home");
    fs.mkdirSync(home);
    const ae = makeAE(opts, tmpDir);
    const net = { requests: [], replies: (opts.replies || []).slice(), gets: [], downloads: [] };
    // Update scenarios run the panel from its own copy of the extension, so it can replace its files.
    const extDir = opts.ownExt ? path.join(tmpDir, "ext") : EXT;
    if (opts.ownExt) { fs.cpSync(EXT, extDir, { recursive: true }); if (opts.signedExt) { fs.mkdirSync(path.join(extDir, "META-INF")); fs.writeFileSync(path.join(extDir, "META-INF/signatures.xml"), "<signatures/>"); } }
    const remote = opts.remote || {};
    const bare = (u) => u.replace(/[?&](t|v)=[^&]*$/, "");
    const sys = { exec: [] };
    const page = await browser.newPage({ viewport: { width: opts.width || 380, height: opts.height || 760 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await page.exposeFunction("__hostEval", (script) => ae.evalScript(script));
    await page.exposeFunction("__plat", async (name, args) => {
      switch (name) {
        case "readBase64": return fs.readFileSync(args[0]).toString("base64");
        case "readText": return fs.readFileSync(args[0], "utf8");
        case "writeText": if (opts.readOnlyExt && args[0].indexOf(extDir) === 0) throw new Error("EACCES"); fs.writeFileSync(args[0], args[1], "utf8"); return null;
        case "writeBytes": fs.writeFileSync(args[0], Buffer.from(args[1])); return null;
        case "remove": try { fs.unlinkSync(args[0]); } catch (e) {} return null;
        case "exists": return fs.existsSync(args[0]);
        case "mkdirp": fs.mkdirSync(args[0], { recursive: true }); return null;
        case "move": if (opts.failMoveAt !== undefined && net.moves === undefined) net.moves = 0;
          if (opts.failMoveAt !== undefined && net.moves++ === opts.failMoveAt) throw new Error("EBUSY");
          fs.renameSync(args[0], args[1]); return null;
        case "getText": {
          net.gets.push(args[0]);
          if (opts.offlineUpdate) throw new Error("getaddrinfo ENOTFOUND");
          const r = remote[bare(args[0])];
          if (r === undefined) return { status: 404, text: "Not Found" };
          return { status: 200, text: typeof r === "string" ? r : JSON.stringify(r) };
        }
        case "download": {
          net.downloads.push(args[0]);
          const r = remote[bare(args[0])];
          if (r === undefined) return { status: 404, sha256: "", size: 0 };
          const body = Buffer.isBuffer(r) ? r : Buffer.from(String(r), "utf8");
          fs.writeFileSync(args[1], body);
          return { status: 200, sha256: crypto.createHash("sha256").update(body).digest("hex"), size: body.length };
        }
        case "reloaded": net.reloads = (net.reloads || 0) + 1; return null;
        case "pickFile": return opts.pickFile || null;
        case "imageSize": return opts.imageSize === undefined ? { width: 800, height: 600 } : opts.imageSize;
        case "exec": {
          sys.exec.push({ file: args[0], args: args[1] });
          if (args[0] !== "osascript") return { code: 1, stdout: "", stderr: "unknown command" };
          const [, , js, png, res] = args[1];
          sys.jxa = fs.readFileSync(js, "utf8");
          const clip = opts.clip || "none";
          if (clip === "png") { fs.writeFileSync(png, fakePng(0)); fs.writeFileSync(res, "OK"); return { code: 0, stdout: "OK\n", stderr: "" }; }
          if (clip === "error") return { code: 1, stdout: "", stderr: "execution error: Error: TypeError (-2700)" };
          if (clip && clip.file) { fs.writeFileSync(res, "FILE:" + clip.file); return { code: 0, stdout: "", stderr: "" }; }
          fs.writeFileSync(res, "NOIMAGE"); return { code: 0, stdout: "NOIMAGE\n", stderr: "" };
        }
        case "postJSON": {
          const [url, headers, body] = args;
          net.requests.push({ url, headers, body: JSON.parse(body), ascii: true });
          if (opts.offline) throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
          const r = net.replies.shift();
          if (r === undefined) return { status: 500, text: "" };
          return { status: r.type === "error" ? 400 : 200, text: JSON.stringify(r) };
        }
      }
      throw new Error("unknown platform call " + name);
    });

    const stored = opts.settings === null ? null : Object.assign({ apiKey: "sk-ant-test", selfCheck: false }, opts.settings || {});
    await page.addInitScript(({ stored, tmpDir, home, hostPath, withSystemPath, updateUrl, updateState }) => {
      window.__SAYFRAME_TEST_UPDATE_URL__ = updateUrl;
      window.__opened = [];
      // Seed saved state only when the page is first opened. Touching localStorage from this start-up
      // script on a reload makes Chromium occasionally hand the page an empty store (a test-browser quirk).
      const firstOpen = window.name !== "sayframe-test-seeded";
      window.name = "sayframe-test-seeded";
      if (firstOpen) { if (stored) localStorage.setItem("sayframe.settings.v1", JSON.stringify(stored)); else localStorage.removeItem("sayframe.settings.v1"); }
      if (updateState && firstOpen) localStorage.setItem("sayframe.update.v1", JSON.stringify(updateState));
      window.__adobe_cep__ = { evalScript(script, cb) { window.__hostEval(script).then(cb); },
        getSystemPath() { return withSystemPath ? "file://" + hostPath : ""; } };
      const call = (name) => function () { return window.__plat(name, Array.prototype.slice.call(arguments)); };
      window.__SAYFRAME_TEST_PLATFORM__ = {
        available: true,
        tmpdir: () => tmpDir, homedir: () => home, isWindows: () => false,
        join: function () { return Array.prototype.join.call(arguments, "/").replace(/\/+/g, "/"); },
        dirname: (p) => p.replace(/\/[^\/]*$/, ""), basename: (p) => p.replace(/^.*\//, ""),
        readBase64: call("readBase64"), readText: call("readText"), writeText: call("writeText"),
        writeBytes: (p, bytes) => window.__plat("writeBytes", [p, Array.from(bytes)]),
        remove: call("remove"), exists: call("exists"), mkdirp: call("mkdirp"), move: call("move"),
        exec: call("exec"), pickFile: call("pickFile"), imageSize: call("imageSize"), postJSON: call("postJSON"),
        getText: call("getText"), download: call("download"),
        openExternal: (u) => { window.__opened.push(u); return true; },
        reload: () => { window.__plat("reloaded", []).then(() => window.location.reload()); }
      };
    }, { stored, tmpDir, home, hostPath: extDir, withSystemPath: true, updateUrl: opts.updateUrl || "", updateState: opts.updateState || null });

    // The panel is served over http from its folder: with file:// pages Chromium starts a new process on
    // every reload and can hand the page an empty localStorage, which has nothing to do with the panel.
    const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]);
      const file = path.join(extDir, rel);
      if (rel.indexOf("..") >= 0 || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await page.goto("http://127.0.0.1:" + server.address().port + "/index.html");
    const h = {
      page, ae, net, sys, tmpDir, home, errors, extDir,
      status: () => page.locator("#status").innerText(),
      statusKind: async () => ((await page.locator("#statusBox").getAttribute("class")) || "").replace("status", "").trim(),
      // waits until the panel is idle again (Run button enabled) and no dialog is waiting
      async idle() { await page.waitForFunction(() => !document.getElementById("runBtn").disabled || !document.getElementById("modal").hidden, null, { timeout: 15000 }); },
      async run(text) { await page.fill("#prompt", text); await page.click("#runBtn"); await h.idle(); },
      // the panel script has finished starting up (it fills in the version last)
      async ready() { await page.waitForFunction(() => { const v = document.getElementById("versionText"); return !!v && v.textContent !== ""; }); },
      // Reopen the panel. The short pause lets the browser store what the panel has just saved:
      // a reload within a few milliseconds of a localStorage write can lose that write.
      async restart() { await page.waitForTimeout(400); await page.reload(); await h.ready(); },
      async tab(name) { await page.click(name === "tools" ? "#tabTools" : "#tabClaude"); },
      // the paste tool lives on the Tools tab
      async paste() { if (await page.locator("#viewTools").isHidden()) await page.click("#tabTools"); await page.click("#pasteBtn"); },
      async modalClick(label) { await page.locator("#modalButtons button", { hasText: label }).click(); await h.idle(); },
      tempLeft: () => fs.readdirSync(tmpDir).filter((f) => /sayframe_/.test(f)),
      async close() { await page.close(); server.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
    };
    return h;
  }
  const imgs = (m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "image").length : 0);
  const VIDEO = { width: 1920, height: 1080, duration: 4, frameRate: 25, mainSource: { isStill: false } };
  const IMG = { width: 800, height: 600, duration: 0, frameRate: 0, mainSource: { isStill: true } };
  let p, c, t, m;

  console.log("\n=== start-up ===");
  p = await open({ settings: null });
  check("S1 loads without script errors", p.errors.length === 0, p.errors.join(" | "));
  check("S1 first-run hint asks for the key", /вставьте ключ Anthropic API/.test(await p.status()));
  await p.page.screenshot({ path: path.join(SHOTS, "01-first-run.png") });
  await p.run("сделай заголовок");
  check("S1 no key -> settings open, nothing sent", !(await p.page.locator("#settingsSheet").isHidden()) && p.net.requests.length === 0 && /Нужен ключ/.test(await p.status()));
  await p.page.screenshot({ path: path.join(SHOTS, "02-settings.png"), fullPage: false });
  await p.close();

  p = await open({ hostNotPreloaded: true, replies: [msg("Ок.\n```javascript\napp.__ran('x');\n```")] });
  await p.run("задача");
  check("S2 host.jsx is loaded by the panel when AE did not preload it", p.ae.log.ran.join() === "x" && p.errors.length === 0, await p.status());
  await p.close();

  console.log("\n=== prompt -> script ===");
  p = await open({ replies: [msg("Создаю слой.\n```javascript\napp.__ran('one');\nvar a = 1;\n```\n")] });
  await p.run('  сделай текст «Привет» \\ с "кавычками"\nи второй строкой  ');
  c = p.net.requests[0];
  check("A1 one request with key, version and model", p.net.requests.length === 1 && c.url === "https://api.anthropic.com/v1/messages" && c.headers["x-api-key"] === "sk-ant-test" && c.headers["anthropic-version"] === "2023-06-01" && c.body.model === "claude-sonnet-5-5" && c.body.max_tokens === 8192 && c.body.system.length > 500);
  check("A1 prompt and snapshot reach Claude intact", /\[Request\]\nсделай текст «Привет» \\ с "кавычками"\nи второй строкой$/.test(c.body.messages[0].content) && /#1 \[text\] "Заголовок" SELECTED/.test(c.body.messages[0].content) && /#2 \[solid\] "Фон"/.test(c.body.messages[0].content));
  check("A1 script ran inside one undo group named after the request", p.ae.log.ran.join() === "one" && p.ae.log.undo.length === 2 && /^begin:Sayframe: сделай текст «Привет» \\ с "кавычками" и /.test(p.ae.log.undo[0]) && p.ae.log.undo[0].indexOf("\n") < 0);
  check("A1 status and reply card", (await p.status()) === "Готово: Создаю слой.\nОтменить всё: Cmd/Ctrl+Z." && (await p.statusKind()) === "done" && (await p.page.locator("#replyText").isHidden()) && (await p.page.locator("#fixBtn").isHidden()) && /app\.__ran\('one'\)/.test(await p.page.locator("#replyCode").textContent()));
  await p.page.screenshot({ path: path.join(SHOTS, "03-done.png") });
  check("A1 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  p = await open({ replies: [msg("x\n```javascript\nvar a = ;\n```"), msg("Исправил.\n```javascript\napp.__ran('good');\n```")] });
  await p.run("задача");
  check("A2 syntax error retried, only the good script ran", p.net.requests.length === 2 && /syntax error/.test(p.net.requests[1].body.messages[2].content) && p.ae.log.ran.join() === "good");
  await p.close();

  p = await open({ replies: [msg("x\n```javascript\nthrow new Error('Нет слоя');\n```"), msg("ok\n```javascript\napp.__ran('fixed');\n```")] });
  await p.run("задача");
  check("A3 runtime error shown, fix enabled", /^Ошибка при выполнении: Error: Нет слоя/.test(await p.status()) && (await p.statusKind()) === "error" && !(await p.page.locator("#fixBtn").isDisabled()) && (await p.page.locator("#fixBtn").isVisible()));
  await p.page.screenshot({ path: path.join(SHOTS, "04-error.png") });
  await p.page.click("#fixBtn"); await p.idle();
  check("A3 fix request carries the error; fixed script ran", /threw an error while running: Error: Нет слоя/.test(p.net.requests[1].body.messages[2].content) && p.ae.log.ran.join() === "fixed" && (await p.page.locator("#fixBtn").isDisabled()));
  await p.close();

  p = await open({ replies: [msg("Удаляю слой.\n```javascript\nvar f = new File('/tmp/a'); app.__ran('danger');\n```")] });
  await p.run("задача");
  check("A4 risky script opens a confirmation with the code", !(await p.page.locator("#modal").isHidden()) && /new File/.test(await p.page.locator("#modalCode").textContent()) && p.ae.log.ran.length === 0);
  await p.page.screenshot({ path: path.join(SHOTS, "05-confirm.png") });
  await p.modalClick("Не запускать");
  check("A4 declined -> not run", (await p.status()) === "Скрипт не запущен." && p.ae.log.ran.length === 0 && p.ae.log.undo.length === 0);
  await p.close();
  p = await open({ replies: [msg("x\n```javascript\napp.project.activeItem.layer(1).remove ( ); app.__ran('rm');\n```")] });
  await p.run("удали слой"); await p.modalClick("Запустить");
  check("A4 accepted -> run", p.ae.log.undo.length === 2 && /Готово|Ошибка при выполнении/.test(await p.status()));
  await p.close();
  p = await open({ replies: [msg("x\n```javascript\napp.__ran('e');\n```")] });
  await p.run("задача"); await p.page.fill("#prompt", "ещё");
  p.net.replies.push(msg("y\n```javascript\nvar f = new File('/x');\n```"));
  await p.page.click("#runBtn"); await p.idle(); await p.page.keyboard.press("Escape"); await p.idle();
  check("A4 Escape cancels the confirmation", (await p.status()) === "Скрипт не запущен." && (await p.page.locator("#modal").isHidden()));
  await p.close();

  p = await open({ replies: [{ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, msg("ok\n```javascript\napp.__ran('after');\n```")] });
  await p.run("задача");
  check("A5 API error shown", (await p.status()) === "Claude API: invalid x-api-key" && (await p.statusKind()) === "error");
  await p.run("ещё раз");
  check("A5 failed question dropped from history", p.net.requests[1].body.messages.length === 1 && p.ae.log.ran.join() === "after");
  await p.close();
  p = await open({ offline: true });
  await p.run("задача");
  check("A6 offline message", /^Нет связи с сервером: getaddrinfo ENOTFOUND/.test(await p.status()), await p.status());
  await p.close();
  p = await open({ replies: [msg('Это вопрос. "Кавычки", \\ слеш.')] });
  await p.run("что такое прекомпозиция?");
  check("A7 text answer, nothing run", (await p.status()) === "Claude ответил текстом, скрипт не запускался." && p.ae.log.undo.length === 0 && (await p.page.locator("#replyText").innerText()) === 'Это вопрос. "Кавычки", \\ слеш.' && (await p.page.locator("#codeBox").isHidden()));
  await p.close();
  p = await open({ settings: { alwaysAsk: true }, replies: [msg("Создаю.\n```javascript\napp.__ran('ask');\n```")] });
  await p.run("задача");
  check("A8 'always ask' shows the script first", !(await p.page.locator("#modal").isHidden()) && (await p.page.locator("#modalText").innerText()) === "Создаю." && p.ae.log.ran.length === 0);
  await p.modalClick("Запустить");
  check("A8 then runs", p.ae.log.ran.join() === "ask");
  await p.close();
  p = await open({ replies: [msg("A\n```javascript\napp.__ran(1);\n```"), msg("B\n```js\napp.__ran(2);\n```")] });
  await p.run("первое"); await p.run("второе");
  check("A9 history alternates; new dialog clears it", p.net.requests[1].body.messages.map((x) => x.role).join() === "user,assistant,user");
  await p.page.click("#newBtn");
  p.net.replies.push(msg("C\n```js\napp.__ran(3);\n```")); await p.run("третье");
  check("A9 after 'Новый диалог' history starts over", p.net.requests[2].body.messages.length === 1 && (await p.page.locator("#replyCard").isVisible()));
  await p.close();

  console.log("\n=== self-check ===");
  const first = (extra) => msg("Создаю заголовок.\n```javascript\napp.__ran('first');\n" + (extra || "") + "```");
  const fix = (n) => msg("Заголовок выходит за край, сдвигаю.\n```javascript\napp.__ran('fix" + n + "');\nvar SAYFRAME_CHECK_TIMES = [1];\n```");
  p = await open({ settings: { selfCheck: true }, replies: [first("var SAYFRAME_CHECK_TIMES = [0, 0.5, 2, 99, 'x'];\n"), msg("Всё на месте.")] });
  await p.run("сделай заголовок");
  c = p.net.requests; m = c[1] && c[1].body.messages[c[1].body.messages.length - 1];
  check("K1 two requests, one script", c.length === 2 && p.ae.log.ran.join() === "first");
  check("K1 frames taken at the script's clamped times from a 640px temp comp", p.ae.log.refComps.length === 1 && p.ae.log.refComps[0].width === 640 && p.ae.log.refComps[0].height === 360 && p.ae.log.refComps[0].saved.map((x) => x.toFixed(2)).join() === "0.00,0.50,2.00,9.97");
  check("K1 check message = 4 byte-exact PNGs + instructions + fresh snapshot", m && imgs(m) === 4 && m.content.slice(0, 4).every((b, i) => b.source.media_type === "image/png" && Buffer.from(b.source.data, "base64").equals(fakePng(i))) && /^\[Result check\] The 4 images above are frames of the composition "Тест" as it looks now, after your script ran, at these times in seconds: 0\.00, 0\.50, 2\.00, 9\.97\.\nCompare them with what the user asked for\.\n/.test(m.content[4].text) && /\n\n\[Project state\]\nAfter Effects version/.test(m.content[4].text));
  check("K1 one undo group for script + capture; temp comp removed; temp PNGs deleted", p.ae.log.undo.join("|") === "begin:Sayframe: сделай заголовок|end" && p.ae.log.removed.join() === "comp" && p.tempLeft().length === 0, p.tempLeft().join());
  check("K1 final status", (await p.status()) === "Готово: Создаю заголовок.\nClaude проверил результат: Всё на месте.\nОтменить всё: Cmd/Ctrl+Z.", JSON.stringify(await p.status()));
  await p.close();
  p = await open({ settings: { selfCheck: true }, replies: [first(), msg("Ок.")] });
  await p.run("задача");
  check("K2 default check times span the work area", p.ae.log.refComps[0].saved.map((x) => x.toFixed(2)).join() === "0.25,1.75,3.25,4.75");
  await p.close();
  p = await open({ settings: { selfCheck: true }, replies: [first(), fix(1), msg("Теперь хорошо.")] });
  await p.run("задача");
  c = p.net.requests; m = c[2].body.messages;
  check("K3 fix applied as its own undo step, then re-checked", c.length === 3 && p.ae.log.ran.join() === "first,fix1" && p.ae.log.undo.join("|") === "begin:Sayframe: задача|end|begin:Sayframe: правка 1|end" && p.ae.log.refComps[1].saved.join() === "1");
  check("K3 old check frames dropped from history, roles alternate", m.map((x) => x.role).join() === "user,assistant,user,assistant,user" && imgs(m[2]) === 0 && /^\[Frames of this earlier result check were removed/.test(m[2].content) && imgs(m[4]) === 1);
  check("K3 final status", (await p.status()) === "Готово: Создаю заголовок.\nClaude проверил результат: Теперь хорошо.\nОтменить: Cmd/Ctrl+Z, каждая правка — отдельный шаг.");
  await p.close();
  p = await open({ settings: { selfCheck: true }, replies: [first(), fix(1), fix(2), msg("лишний")] });
  await p.run("задача");
  check("K4 at most two check rounds", p.net.requests.length === 3 && p.ae.log.ran.join() === "first,fix1,fix2" && (await p.status()) === "Готово: Создаю заголовок.\nПравок после проверки: 2.\nОтменить: Cmd/Ctrl+Z, каждая правка — отдельный шаг.");
  await p.close();
  p = await open({ settings: { selfCheck: true }, replies: [first(), { type: "error", error: { message: "overloaded" } }, msg("ok\n```javascript\napp.__ran('next');\n```"), msg("Ок.")] });
  await p.run("задача");
  check("K5 failed check keeps the result", (await p.status()) === "Готово: Создаю заголовок.\nПроверить результат не удалось: Claude API: overloaded\nОтменить всё: Cmd/Ctrl+Z." && (await p.statusKind()) === "done");
  await p.run("дальше");
  check("K5 history still valid afterwards", p.net.requests[2].body.messages.map((x) => x.role).join() === "user,assistant,user" && p.ae.log.ran.join() === "first,next");
  await p.close();
  p = await open({ settings: { selfCheck: true }, fileAccessOff: true, replies: [first(), msg("лишний")] });
  await p.run("задача");
  check("K6 file access off -> runs without a check", p.net.requests.length === 1 && p.ae.log.refComps.length === 0 && /^Готово: Создаю заголовок\./.test(await p.status()));
  await p.close();
  p = await open({ settings: { selfCheck: true }, replies: [first(), msg("Чиню.\n```javascript\nthrow new Error('Слой не найден');\n```")] });
  await p.run("задача");
  check("K7 failing fix reported as a fix", /^Ошибка при выполнении правки: Error: Слой не найден/.test(await p.status()) && !(await p.page.locator("#fixBtn").isDisabled()));
  await p.close();
  p = await open({ settings: { selfCheck: true }, replies: [first(), msg("Удаляю лишний слой.\n```javascript\napp.project.activeItem.layer(2).remove();\n```")] });
  await p.run("задача"); await p.modalClick("Не запускать");
  check("K8 declined fix leaves the result", (await p.status()) === "Готово: Создаю заголовок.\nПравка не запущена, результат оставлен как есть.\nОтменить всё: Cmd/Ctrl+Z.");
  await p.close();

  console.log("\n=== reference ===");
  p = await open({ pickFile: "/Users/x/Movies/мой референс.mp4", footage: VIDEO, replies: [msg("Повторяю.\n```javascript\napp.__ran('ref');\n```"), msg("ok\n```javascript\napp.__ran('second');\n```")] });
  await p.page.click("#refBtn"); await p.idle();
  check("R1 8 frames from a 640x360 temp comp; project cleaned; comp restored", p.ae.log.refComps[0].width === 640 && p.ae.log.refComps[0].saved.map((x) => x.toFixed(2)).join() === "0.25,0.75,1.25,1.75,2.25,2.75,3.25,3.75" && p.ae.log.removed.join() === "comp,item" && p.ae.project.activeItem === p.ae.comp && p.ae.log.undo.join("|") === "begin:Sayframe: reference frames|end");
  check("R1 chip and status", (await p.page.locator("#refText").innerText()) === "мой референс.mp4 — 8 кадр. из 4.0 с" && /^Видео прикреплено: 8 кадров/.test(await p.status()) && p.tempLeft().length === 0);
  await p.page.screenshot({ path: path.join(SHOTS, "06-reference.png") });
  await p.run("сделай такую же анимацию");
  c = p.net.requests[0].body.messages[0].content;
  check("R1 request = 8 exact frames + note + state + request", Array.isArray(c) && c.length === 9 && c.slice(0, 8).every((b, i) => Buffer.from(b.source.data, "base64").equals(fakePng(i))) && /^\[Reference\] The 8 images above are frames sampled in chronological order from the user's reference video "мой референс\.mp4" \(1920x1080, duration 4\.00 s\)\. Frame times in seconds: 0\.25, 0\.75, 1\.25, 1\.75, 2\.25, 2\.75, 3\.25, 3\.75\.\n\n\[Project state\]/.test(c[8].text) && /\[Request\]\nсделай такую же анимацию$/.test(c[8].text));
  check("R1 chip turns into 'sent' note", (await p.page.locator("#refText").innerText()) === "Референс отправлен, Claude помнит его в этом диалоге" && (await p.page.locator("#refClear").isHidden()));
  await p.run("сделай быстрее");
  m = p.net.requests[1].body.messages;
  check("R1 follow-up keeps the frames in history and adds none", m.length === 3 && imgs(m[0]) === 8 && typeof m[2].content === "string");
  await p.close();
  p = await open({ pickFile: "/a/poster.png", footage: { width: 3000, height: 2000, duration: 0, frameRate: 0, mainSource: { isStill: true } } });
  await p.page.click("#refBtn"); await p.idle();
  check("R2 still image -> one frame", p.ae.log.refComps[0].saved.join() === "0" && p.ae.log.refComps[0].height === 427 && (await p.page.locator("#refText").innerText()) === "poster.png — картинка");
  await p.page.click("#refClear");
  check("R2 clear removes it", (await p.page.locator("#refChip").isHidden()) && (await p.status()) === "Референс убран.");
  await p.close();
  p = await open({ pickFile: "/a/x.mp4", footage: VIDEO, replies: [{ type: "error", error: { message: "overloaded" } }, msg("Повторяю.\n```javascript\napp.__ran('ref');\n```")] });
  await p.page.click("#refBtn"); await p.idle(); await p.run("сделай");
  check("R3 failed request gives the reference back", (await p.status()) === "Claude API: overloaded" && (await p.page.locator("#refText").innerText()) === "x.mp4 — 8 кадр. из 4.0 с" && (await p.page.locator("#refClear").isVisible()));
  await p.page.click("#runBtn"); await p.idle();
  check("R3 retry sends the frames once", p.net.requests[1].body.messages.length === 1 && imgs(p.net.requests[1].body.messages[0]) === 8 && p.ae.log.ran.join() === "ref");
  await p.close();
  p = await open({ pickFile: "/a/sound.wav", footage: { width: 0, height: 0, duration: 5, frameRate: 0, mainSource: { isStill: false } } });
  await p.page.click("#refBtn"); await p.idle();
  check("R4 audio-only file -> clear error, item removed", (await p.status()) === "Не удалось подготовить референс: В этом файле нет изображения — нужен ролик или картинка." && p.ae.log.removed.join() === "item" && (await p.page.locator("#refChip").isHidden()));
  await p.close();
  p = await open({ pickFile: "/a/x.mp4", footage: VIDEO, fileAccessOff: true });
  await p.page.click("#refBtn"); await p.idle();
  check("R5 file access off -> asks to enable it, nothing imported", /Allow Scripts to Write Files/.test(await p.status()) && p.ae.log.imports.length === 0);
  await p.close();
  p = await open({ pickFile: null });
  await p.page.click("#refBtn"); await p.page.waitForTimeout(150);
  check("R6 cancelled file dialog -> nothing happens", (await p.status()) === "Готов." && p.ae.log.undo.length === 0);
  await p.close();
  p = await open({ settings: { selfCheck: true }, pickFile: "/a/ref.mp4", footage: VIDEO, replies: [first(), msg("Похоже.")] });
  await p.page.click("#refBtn"); await p.idle(); await p.run("повтори");
  m = p.net.requests[1].body.messages;
  check("R7 with a reference, the check note points back to it", imgs(m[0]) === 8 && imgs(m[2]) === 4 && /and with the reference images earlier in this conversation\./.test(m[2].content[4].text));
  await p.close();

  console.log("\n=== clipboard paste ===");
  const docs = (h) => path.join(h.home, "Documents", "After Effects Clipboard Images");
  p = await open({ clip: "png", footage: IMG });
  await p.paste(); await p.idle();
  let saved = fs.existsSync(docs(p)) ? fs.readdirSync(docs(p)) : [];
  check("P1 dialog shows file, size and target comp", (await p.page.locator("#modalTitle").innerText()) === "Вставка картинки" && (await p.page.locator("#modalText").innerText()) === saved[0] + " — 800 × 600 пикс.\nКак вставить её в композицию «Тест»?", JSON.stringify(await p.page.locator("#modalText").innerText()));
  await p.page.screenshot({ path: path.join(SHOTS, "07-paste.png") });
  await p.modalClick("Прекомпозить");
  check("P1 PNG saved byte-exact with a dated name", saved.length === 1 && /^clipboard_\d{4}-\d{2}-\d{2}_\d{6}\.png$/.test(saved[0]) && fs.readFileSync(path.join(docs(p), saved[0])).equals(fakePng(0)));
  check("P1 imported into the bin, layer added, precomposed leaving attributes", p.ae.log.imports.join() === path.join(docs(p), saved[0]) && p.ae.log.bins.join() === "Из буфера" && p.ae.log.layerAdds[0].parentFolder === p.ae.projItems[1] && p.ae.log.precomposes.length === 1 && p.ae.log.precomposes[0].idx.join() === "1" && p.ae.log.precomposes[0].moveAll === false && p.ae.log.precomposes[0].name === saved[0].replace(".png", "") + " Comp");
  check("P1 one undo group; active comp kept; temp files gone", p.ae.log.undo.join("|") === "begin:Sayframe: paste image|end" && p.ae.project.activeItem === p.ae.comp && p.tempLeft().length === 0);
  check("P1 status", (await p.status()) === "Картинка вставлена в «Тест» прекомпозицией «" + saved[0].replace(".png", "") + " Comp».\nФайл сохранён: " + path.join(docs(p), saved[0]) + "\nОтменить: Cmd/Ctrl+Z.", JSON.stringify(await p.status()));
  check("P1 helper is the macOS script run through osascript", p.sys.exec[0].file === "osascript" && p.sys.exec[0].args.slice(0, 2).join(" ") === "-l JavaScript" && /NSPasteboard/.test(p.sys.jxa) && /^[\x09\x0a\x20-\x7e]*$/.test(p.sys.jxa));
  await p.close();
  p = await open({ clip: "png", footage: IMG });
  await p.paste(); await p.idle(); await p.modalClick("Оставить как есть");
  check("P2 plain layer, no precompose", p.ae.log.layerAdds.length === 1 && p.ae.log.precomposes.length === 0 && /^Картинка вставлена слоем в «Тест»\.\nФайл сохранён: /.test(await p.status()));
  await p.close();
  p = await open({ clip: "png", footage: IMG });
  await p.paste(); await p.idle(); await p.modalClick("Отмена");
  check("P3 cancel leaves no file and touches nothing in AE", (await p.status()) === "Вставка отменена." && fs.readdirSync(docs(p)).length === 0 && p.ae.log.imports.length === 0 && p.ae.log.undo.length === 0);
  await p.close();
  p = await open({ clip: "none", footage: IMG });
  await p.paste(); await p.idle();
  check("P4 empty clipboard -> message only", /^В буфере обмена нет картинки\./.test(await p.status()) && (await p.page.locator("#modal").isHidden()) && p.ae.log.imports.length === 0 && p.tempLeft().length === 0);
  await p.close();
  const userFile = path.join(os.tmpdir(), "мой логотип " + Date.now() + ".png"); fs.writeFileSync(userFile, fakePng(3));
  p = await open({ clip: { file: userFile }, footage: IMG });
  await p.paste(); await p.idle(); await p.modalClick("Оставить как есть");
  check("P5 copied Finder file imported from where it is", p.ae.log.imports.join() === userFile && !fs.existsSync(docs(p)) && (await p.status()) === "Картинка вставлена слоем в «Тест».\nОтменить: Cmd/Ctrl+Z.");
  await p.close();
  p = await open({ clip: { file: userFile }, footage: IMG });
  await p.paste(); await p.idle(); await p.modalClick("Отмена");
  check("P5 cancelling never deletes the user's own file", fs.existsSync(userFile));
  await p.close();
  p = await open({ clip: { file: userFile }, footage: { width: 0, height: 0, duration: 0, frameRate: 0, mainSource: { isStill: true } } });
  await p.paste(); await p.idle(); await p.modalClick("Оставить как есть");
  check("P5 non-image file -> error, item removed, user's file kept", (await p.status()) === "Не удалось вставить картинку: Скопированный файл не является изображением." && p.ae.log.removed.join() === "item" && fs.existsSync(userFile) && p.ae.log.undo.join("|") === "begin:Sayframe: paste image|end");
  await p.close();
  fs.unlinkSync(userFile);
  p = await open({ clip: { file: "/nope/нет.png" }, footage: IMG });
  await p.paste(); await p.idle();
  check("P5 missing copied file -> clear error", (await p.status()) === "Не удалось вставить картинку: Скопированный файл не найден: /nope/нет.png");
  await p.close();
  p = await open({ clip: "png", footage: IMG, noActiveComp: true });
  await p.paste(); await p.idle();
  t = await p.page.locator("#modalText").innerText();
  await p.modalClick("Прекомпозить");
  check("P6 no comp + precompose -> new comp at image size, opened", /Открытой композиции нет\./.test(t) && p.ae.log.refComps.length === 1 && p.ae.log.refComps[0].width === 800 && p.ae.log.refComps[0].height === 600 && p.ae.project.activeItem === p.ae.log.refComps[0] && /^Открытой композиции не было, поэтому создана новая «clipboard_.* Comp» с картинкой внутри\./.test(await p.status()));
  await p.close();
  p = await open({ clip: "png", footage: IMG, noActiveComp: true });
  await p.paste(); await p.idle(); await p.modalClick("Оставить как есть");
  check("P6 no comp + leave -> imported only", p.ae.log.refComps.length === 0 && p.ae.log.layerAdds.length === 0 && /^Картинка добавлена в проект, в папку «Из буфера»\./.test(await p.status()));
  await p.close();
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
  p = await open({ clip: "png", footage: IMG, projectFile: path.join(projDir, "ролик.aep") });
  await p.paste(); await p.idle(); await p.modalClick("Оставить как есть");
  saved = fs.existsSync(path.join(projDir, "Clipboard Images")) ? fs.readdirSync(path.join(projDir, "Clipboard Images")) : [];
  check("P7 saved project -> 'Clipboard Images' beside the .aep", saved.length === 1 && !fs.existsSync(docs(p)) && p.ae.log.imports[0] === path.join(projDir, "Clipboard Images", saved[0]));
  await p.close(); fs.rmSync(projDir, { recursive: true, force: true });
  p = await open({ clip: "error", footage: IMG });
  await p.paste(); await p.idle();
  check("P8 helper failure surfaced, nothing touched", /^Не удалось вставить картинку: Не удалось прочитать буфер обмена: execution error/.test(await p.status()) && p.ae.log.imports.length === 0 && p.tempLeft().length === 0 && !(await p.page.locator("#pasteBtn").isDisabled()), await p.status());
  await p.close();
  p = await open({ clip: "png", footage: IMG });
  await p.paste(); await p.idle(); await p.modalClick("Оставить как есть");
  await p.paste(); await p.idle(); await p.modalClick("Оставить как есть");
  check("P9 project bin reused on the second paste", p.ae.log.bins.length === 1 && p.ae.log.layerAdds.length === 2);
  await p.close();

  // Cmd+V inside the panel: the image comes from the paste event itself.
  p = await open({ clip: "none", footage: IMG, imageSize: { width: 2, height: 2 } });
  await p.page.evaluate((b64) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer(); dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, REAL_PNG.toString("base64"));
  await p.page.waitForFunction(() => !document.getElementById("modal").hidden, null, { timeout: 15000 });
  await p.modalClick("Оставить как есть");
  saved = fs.existsSync(docs(p)) ? fs.readdirSync(docs(p)) : [];
  const head = saved.length ? fs.readFileSync(path.join(docs(p), saved[0])).subarray(0, 8).toString("latin1") : "";
  check("P10 Cmd+V with an image: decoded in the panel, saved as a real PNG, placed", saved.length === 1 && head === "\x89PNG\r\n\x1a\n" && p.ae.log.layerAdds.length === 1 && p.sys.exec.length === 0 && /^Картинка вставлена слоем/.test(await p.status()), await p.status());
  await p.close();
  p = await open({ clip: "none", footage: IMG });
  await p.page.focus("#prompt");
  await p.page.evaluate(() => { const dt = new DataTransfer(); dt.setData("text/plain", "привет"); document.getElementById("prompt").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  await p.page.waitForTimeout(200);
  check("P11 pasting text into the prompt is left alone", p.sys.exec.length === 0 && (await p.status()) === "Готов.");
  await p.close();

  console.log("\n=== settings ===");
  p = await open({ settings: null });
  await p.page.click("#settingsBtn");
  await p.page.fill("#apiKey", "  sk-ant-abc  ");
  await p.page.locator("#models button", { hasText: "Opus 5.5" }).click();
  await p.page.locator("#accentSwatches button").nth(1).click();
  await p.page.locator("#frames button", { hasText: "16" }).click();
  await p.page.locator("label.switch", { hasText: "Спрашивать перед каждым запуском" }).click();
  await p.page.locator("label.switch", { hasText: "проверяет результат" }).click();
  t = await p.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  check("G1 accent previews live", t === "#62c8ff", t);
  await p.page.screenshot({ path: path.join(SHOTS, "08-settings-edited.png") });
  p.net.replies.push(msg("p"));
  await p.page.click("#testKey");
  await p.page.waitForFunction(() => /работает|API|связи/.test(document.getElementById("keyHint").textContent));
  check("G1 key test uses the typed key and chosen model with a 1-token request", (await p.page.locator("#keyHint").innerText()) === "Ключ работает." && p.net.requests[0].headers["x-api-key"] === "sk-ant-abc" && p.net.requests[0].body.model === "claude-opus-5-5" && p.net.requests[0].body.max_tokens === 1);
  await p.page.click("#saveSettings");
  t = JSON.parse(await p.page.evaluate(() => localStorage.getItem("sayframe.settings.v1")));
  check("G1 saved", t.apiKey === "sk-ant-abc" && t.model === "claude-opus-5-5" && t.accent === "#62c8ff" && t.refFrames === 16 && t.alwaysAsk === true && t.selfCheck === false && (await p.page.locator("#settingsSheet").isHidden()) && (await p.status()) === "Настройки сохранены.", JSON.stringify(t));
  await p.page.screenshot({ path: path.join(SHOTS, "09-accent-sky.png") });
  await p.page.click("#settingsBtn");
  await p.page.locator("#accentSwatches button").nth(2).click();
  await p.page.fill("#bgHex", "#101014");
  await p.page.click("#settingsClose");
  t = await p.page.evaluate(() => [getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), JSON.parse(localStorage.getItem("sayframe.settings.v1")).accent]);
  check("G2 closing without saving reverts the preview", t[0] === "#62c8ff" && t[1] === "#0b0c12" && t[2] === "#62c8ff", t.join());
  await p.page.click("#settingsBtn");
  await p.page.fill("#apiKey", "bad");
  p.net.replies.push({ type: "error", error: { message: "invalid x-api-key" } });
  await p.page.click("#testKey");
  await p.page.waitForFunction(() => /API/.test(document.getElementById("keyHint").textContent));
  check("G3 bad key reported in place", (await p.page.locator("#keyHint").innerText()) === "Claude API: invalid x-api-key");
  check("G3 no page errors in the whole settings run", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  // layout at other panel widths, for the visual check
  p = await open({ width: 300, height: 620, replies: [msg("Создаю заголовок и плавно проявляю его за секунду.\n```javascript\napp.__ran('one');\n```")] });
  await p.run("создай текст Привет и плавно прояви его");
  t = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("L1 no horizontal overflow at 300px", t <= 0, t);
  await p.page.screenshot({ path: path.join(SHOTS, "10-narrow.png") });
  await p.close();
  p = await open({ width: 560, height: 760 });
  await p.page.click("#settingsBtn");
  await p.page.screenshot({ path: path.join(SHOTS, "11-wide-settings.png") });
  await p.close();


  // --------------------------------------------------------------------- tabs
  // ---------------------------------------------------------------- fixed content width
  console.log("\n=== panel width ===");
  const box = (p, sel) => p.page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(); }, sel);
  // Every visible block of the page: left edge, right edge.
  const spans = (p) => p.page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("#app > *, #app .view:not([hidden]) > *, .sheet:not([hidden]) .sheet-card, .modal:not([hidden]) .modal-card")).filter((el) => el.offsetParent !== null || el.getClientRects().length).map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }).filter((x) => x[1] > x[0]));
  const within = (list, left, right) => list.length > 0 && list.every((x) => x[0] >= left && x[1] <= right);
  const overflow = (p) => p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const setWidth = (p, v) => p.page.evaluate((v) => { const el = document.getElementById("panelWidth"); el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);

  p = await open({ width: 380 });
  check("W1 at 380px the panel looks as before: content fills it", (await box(p, "#tabs")).split(",")[0] === "14" && (await box(p, "#tabs")).split(",")[2] === "352" && (await box(p, "#runBtn")).split(",")[2] === "326", await box(p, "#tabs") + " | " + await box(p, "#runBtn"));
  await p.close();

  p = await open({ width: 1000, replies: [msg("Создаю.\n```javascript\napp.__ran('ask');\n```")], settings: { alwaysAsk: true } });
  t = await spans(p);
  check("W2 in a wide panel nothing stretches: every block stays in the 380px column on the left", within(t, 14, 366) && (await box(p, "#tabs")).split(",")[2] === "352" && (await overflow(p)) <= 0, JSON.stringify(t));
  c = [await box(p, "#runBtn"), await box(p, "#prompt"), await box(p, "#settingsBtn"), await box(p, "#tabs")].join(" | ");
  await p.page.setViewportSize({ width: 1600, height: 900 });
  check("W2 stretching the panel further moves and resizes nothing", [await box(p, "#runBtn"), await box(p, "#prompt"), await box(p, "#settingsBtn"), await box(p, "#tabs")].join(" | ") === c, c);
  await p.page.setViewportSize({ width: 1000, height: 760 });
  await p.page.screenshot({ path: path.join(SHOTS, "09b-wide-panel.png") });
  await p.page.click("#tabTools");
  check("W2 Tools tab stays in the column", within(await spans(p), 14, 366), JSON.stringify(await spans(p)));
  await p.page.click("#tabMotion");
  check("W2 Animation tab stays in the column", within(await spans(p), 14, 366) && (await box(p, "#easeIn")).split(",")[2] === (await box(p, "#easeOut")).split(",")[2], JSON.stringify(await spans(p)));
  await p.page.click("#tabClaude");
  await p.page.fill("#prompt", "сделай слой"); await p.page.click("#runBtn");
  await p.page.waitForSelector("#modal:not([hidden])");
  check("W2 the confirmation dialog sits over the column, not in the middle of the wide panel", within(await spans(p), 14, 366), JSON.stringify(await spans(p)));
  await p.page.locator("#modalButtons button").last().click(); await p.idle();
  await p.page.click("#settingsBtn");
  check("W2 settings stay in the column", within(await spans(p), 14, 366) && (await p.page.inputValue("#panelWidth")) === "380" && (await p.page.locator("#panelWidthVal").innerText()) === "380 px", JSON.stringify(await spans(p)));

  await setWidth(p, 520);
  t = await spans(p);
  check("W3 the width slider previews live", within(t, 14, 506) && (await box(p, ".sheet-card")).split(",")[2] === "492" && (await p.page.locator("#panelWidthVal").innerText()) === "520 px" && (await box(p, "#tabs")).split(",")[2] === "492", JSON.stringify(t));
  await p.page.click("#settingsClose");
  check("W3 closing without saving puts the old width back", (await box(p, "#tabs")).split(",")[2] === "352" && (await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.settings.v1")).panelWidth)) !== 520);
  await p.page.click("#settingsBtn"); await setWidth(p, 520); await p.page.click("#saveSettings");
  check("W3 saved width applies to the whole panel", (await box(p, "#tabs")) .split(",")[2] === "492" && (await box(p, "#tabs")).split(",")[0] === "14" && (await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.settings.v1")).panelWidth)) === 520);
  await p.page.screenshot({ path: path.join(SHOTS, "09c-wide-panel-520.png") });
  await p.restart();
  check("W3 the width survives a restart", (await box(p, "#tabs")).split(",")[2] === "492" && p.errors.length === 0, p.errors.join(" | "));
  await p.page.click("#settingsBtn");
  check("W3 settings show the saved width", (await p.page.inputValue("#panelWidth")) === "520" && (await p.page.locator("#panelWidthVal").innerText()) === "520 px");
  await p.page.focus("#panelWidth"); await p.page.keyboard.press("ArrowRight");
  check("W3 the slider works from the keyboard in steps of 10", (await p.page.locator("#panelWidthVal").innerText()) === "530 px" && (await box(p, ".sheet-card")).split(",")[2] === "502");
  await setWidth(p, 280); await p.page.click("#saveSettings");
  t = await spans(p);
  check("W3 the narrowest width still fits everything", within(t, 14, 266) && (await overflow(p)) <= 0, JSON.stringify(t));
  await p.page.click("#tabMotion");
  t = await p.page.evaluate(() => { const g = document.getElementById("anchorGrid").getBoundingClientRect(), a = document.getElementById("easeIn").getBoundingClientRect(); return [Math.round(g.right), Math.round(a.width)]; });
  check("W3 Animation tools fit the narrowest width", within(await spans(p), 14, 266) && t[0] <= 266 && t[1] > 50, JSON.stringify(t));
  await p.page.screenshot({ path: path.join(SHOTS, "09d-wide-panel-280.png") });
  await p.close();

  p = await open({ width: 300, settings: { panelWidth: 520 } });
  t = await spans(p);
  check("W4 a panel narrower than the chosen width: content shrinks to fit, no sideways scroll", within(t, 14, 286) && (await box(p, "#tabs")).split(",")[2] === "272" && (await overflow(p)) <= 0, JSON.stringify(t));
  await p.close();
  for (const bad of [5000, 10, "wide", null, 383]) {
    p = await open({});
    await p.page.evaluate((v) => { const s = JSON.parse(localStorage.getItem("sayframe.settings.v1")); s.panelWidth = v; localStorage.setItem("sayframe.settings.v1", JSON.stringify(s)); }, bad);
    await p.restart();
    t = await p.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--panel-w").trim());
    check("W5 a broken saved width (" + JSON.stringify(bad) + ") is made safe", t === ({ 5000: "640px", 10: "280px", 383: "380px" }[bad] || "380px") && p.errors.length === 0, t);
    await p.close();
  }

  console.log("\n=== tabs ===");
  const vis = (p, sel) => p.page.locator(sel).isVisible();
  p = await open({ replies: [msg("Создаю слой.\n```javascript\napp.__ran('one');\n```")], clip: "png", footage: IMG });
  check("T1 opens on the Claude tab", (await vis(p, "#prompt")) && (await vis(p, "#runBtn")) && (await vis(p, "#refBtn")) && (await vis(p, "#newBtn")) && !(await vis(p, "#pasteBtn")) && (await p.page.locator("#tabClaude").getAttribute("aria-selected")) === "true");
  check("T1 status line is inside the Claude tab", (await p.page.locator("#viewClaude #statusBox").count()) === 1 && (await vis(p, "#status")));
  await p.page.screenshot({ path: path.join(SHOTS, "16-tab-claude.png") });
  await p.tab("tools");
  check("T2 Tools tab shows only the tools", (await vis(p, "#pasteBtn")) && !(await vis(p, "#prompt")) && !(await vis(p, "#runBtn")) && !(await vis(p, "#refBtn")) && !(await vis(p, "#newBtn")) && !(await vis(p, "#fixBtn")) && (await p.page.locator("#tabTools").getAttribute("aria-selected")) === "true" && (await p.page.locator("#tabClaude").getAttribute("aria-selected")) === "false");
  check("T2 status line moved to the Tools tab", (await p.page.locator("#viewTools #statusBox").count()) === 1 && (await p.page.locator("#statusBox").count()) === 1 && (await vis(p, "#status")));
  await p.page.screenshot({ path: path.join(SHOTS, "17-tab-tools.png") });
  await p.page.click("#pasteBtn"); await p.idle(); await p.modalClick("Оставить как есть");
  check("T3 a tool reports its result on the Tools tab", /^Картинка вставлена/.test(await p.status()) && (await vis(p, "#status")) && p.ae.log.imports.length === 1, await p.status());
  t = await p.status();
  await p.tab("claude");
  check("T3 the same status is shown after switching back", (await p.status()) === t && (await vis(p, "#status")) && (await vis(p, "#prompt")));
  await p.run("сделай слой");
  check("T4 Claude still works from its tab", p.ae.log.ran.join() === "one" && /^Готово: Создаю слой\./.test(await p.status()) && (await vis(p, "#replyCard")));
  await p.tab("tools");
  check("T4 the reply card stays on the Claude tab", !(await vis(p, "#replyCard")) && /^Готово: Создаю слой\./.test(await p.status()));
  await p.restart();
  check("T5 the open tab is remembered", (await vis(p, "#pasteBtn")) && !(await vis(p, "#prompt")) && (await p.page.locator("#viewTools #statusBox").count()) === 1);
  check("T5 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  p = await open({ width: 300, height: 620 });
  t = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await p.tab("tools");
  c = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("T6 tabs fit a 300px panel", t <= 0 && c <= 0, t + "," + c);
  await p.page.screenshot({ path: path.join(SHOTS, "18-tabs-narrow.png") });
  await p.close();
  p = await open({ settings: null });
  await p.tab("tools");
  check("T7 first-run hint about the key is visible on either tab", /вставьте ключ Anthropic API/.test(await p.status()) && (await vis(p, "#status")));
  await p.close();
  p = await open({ clip: "png" });
  await p.page.evaluate(() => { const dt = new DataTransfer(); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); });
  await p.page.waitForTimeout(300);
  check("T8 Cmd/Ctrl+V handling is unchanged on the Claude tab", p.errors.length === 0);
  await p.close();

  // ------------------------------------------------------------ tab reordering
  console.log("\n=== tab order ===");
  const order = (p) => p.page.evaluate(() => Array.from(document.querySelectorAll("#tabs .tab")).map((b) => b.getAttribute("data-tab")).join());
  const overflow0 = (p) => p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const savedOrder = (p) => p.page.evaluate(() => localStorage.getItem("sayframe.tabOrder.v1"));
  const center = async (p, sel) => { const b = await p.page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  async function dragTab(p, from, to, opts) {
    const a = await center(p, from), b = typeof to === "string" ? await center(p, to) : to;
    // Mouse events carry whole pixels, so stopping exactly on a neighbour's middle may fall half a pixel short of it:
    // go a couple of pixels past, as a hand does.
    if (typeof to === "string") b.x += b.x >= a.x ? 2 : -2;
    await p.page.mouse.move(a.x, a.y); await p.page.mouse.down();
    await p.page.mouse.move(b.x, b.y, { steps: 12 });
    if (opts && opts.beforeUp) await opts.beforeUp();
    await p.page.mouse.up();
  }
  const arrangingNow = (p) => p.page.evaluate(() => /(^|\s)arranging(\s|$)/.test(document.body.className) && !document.getElementById("arrangeBar").hidden);
  // Rearranging is switched on by a double click on a tab (the open one unless told otherwise).
  const arrange = async (p, sel) => { await p.page.dblclick(sel || '#tabs .tab[aria-selected="true"]'); await p.page.waitForFunction(() => /arranging/.test(document.body.className)); await p.page.waitForTimeout(350); };
  p = await open({ clip: "png", footage: IMG });
  check("O1 default order", (await order(p)) === "claude,tools,motion" && (await savedOrder(p)) === null);
  check("O1 rearranging is off at first, its bar is hidden", !(await arrangingNow(p)) && !(await vis(p, "#arrangeBar")));
  await dragTab(p, "#tabClaude", "#tabTools");
  check("O1 without a double click a drag moves nothing and marks nothing", (await order(p)) === "claude,tools,motion" && (await savedOrder(p)) === null && (await p.page.locator(".dragging, .reordering").count()) === 0);
  await p.page.waitForTimeout(350);
  await p.page.click("#tabTools");
  check("O1 a single click only switches the tab", (await vis(p, "#pasteBtn")) && !(await arrangingNow(p)));
  await p.page.click("#tabClaude");
  await p.page.waitForTimeout(350);
  await p.page.dblclick("#tabClaude");
  check("O1 a double click on a tab switches rearranging on and shows the bar", (await arrangingNow(p)) && (await vis(p, "#arrangeBar")) && (await vis(p, "#arrangeDone")) && (await vis(p, "#prompt")));
  t = await p.page.evaluate(() => { const b = document.getElementById("arrangeBar").getBoundingClientRect(), tb = document.getElementById("tabs").getBoundingClientRect(); return b.top >= tb.bottom && Math.round(b.left) === 14 && Math.round(b.width) === 352; });
  check("O1 the bar sits under the tabs, inside the column", t === true && (await overflow0(p)) <= 0);
  await p.page.screenshot({ path: path.join(SHOTS, "19a-arranging.png") });
  await p.page.waitForTimeout(350);
  await dragTab(p, "#tabClaude", "#tabTools", { beforeUp: async () => {
    check("O2 tab is marked while it is dragged", (await p.page.locator("#tabClaude.dragging").count()) === 1 && (await p.page.locator("#tabs.reordering").count()) === 1);
    await p.page.screenshot({ path: path.join(SHOTS, "19-tab-dragging.png") });
  } });
  check("O2 dragging Claude onto Tools swaps them", (await order(p)) === "tools,claude,motion", await order(p));
  check("O2 the new order is saved", (await savedOrder(p)) === '["tools","claude","motion"]', await savedOrder(p));
  check("O2 dragging does not switch tabs or leave marks, rearranging stays on", (await vis(p, "#prompt")) && !(await vis(p, "#pasteBtn")) && (await p.page.locator(".dragging, .reordering").count()) === 0 && (await arrangingNow(p)));
  t = await p.page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect().left; return r("tabTools") < r("tabClaude"); });
  check("O2 Tools is now drawn on the left", t === true);
  await p.page.screenshot({ path: path.join(SHOTS, "20-tabs-swapped.png") });
  await p.page.waitForTimeout(350);
  await p.tab("tools");
  check("O3 clicking still switches tabs after a drag, also while rearranging", (await vis(p, "#pasteBtn")) && !(await vis(p, "#prompt")) && (await arrangingNow(p)));
  await p.page.click("#arrangeDone");
  check("O3 'Done' switches rearranging off", !(await arrangingNow(p)) && !(await vis(p, "#arrangeBar")) && (await order(p)) === "tools,claude,motion");
  await p.page.waitForTimeout(350);
  await dragTab(p, "#tabTools", "#tabClaude");
  check("O3 after 'Done' tabs do not move any more", (await order(p)) === "tools,claude,motion");
  await p.page.waitForTimeout(350);
  await p.page.click("#pasteBtn"); await p.idle(); await p.modalClick("Оставить как есть");
  check("O3 tools still work in the new order", /^Картинка вставлена/.test(await p.status()), await p.status());
  await p.restart();
  check("O4 order and open tab survive a restart; rearranging does not", (await order(p)) === "tools,claude,motion" && (await vis(p, "#pasteBtn")) && (await p.page.locator("#tabTools").getAttribute("aria-selected")) === "true" && !(await arrangingNow(p)));
  await arrange(p);
  await dragTab(p, "#tabTools", "#tabClaude");
  check("O5 dragging back restores the order", (await order(p)) === "claude,tools,motion" && (await savedOrder(p)) === '["claude","tools","motion"]');
  await p.page.waitForTimeout(350);
  await dragTab(p, "#tabMotion", "#tabClaude");
  check("O5 the last tab can be dragged to the front, past the one in between", (await order(p)) === "motion,claude,tools", await order(p));
  await p.page.waitForTimeout(350);
  await dragTab(p, "#tabMotion", "#tabTools");
  check("O5 and back to the end", (await order(p)) === "claude,tools,motion", await order(p));
  await p.page.waitForTimeout(350);
  c = await center(p, "#tabClaude");
  await p.page.mouse.move(c.x, c.y); await p.page.mouse.down(); await p.page.mouse.move(c.x + 3, c.y + 1); await p.page.mouse.up();
  check("O6 a click with a tiny hand movement is still a click", (await order(p)) === "claude,tools,motion" && (await vis(p, "#prompt")));
  c = await center(p, "#tabTools");
  await dragTab(p, "#tabClaude", { x: c.x + 400, y: c.y + 200 });
  check("O7 releasing outside the tabs keeps a valid order", (await order(p)).split(",").sort().join() === "claude,motion,tools" && (await p.page.locator(".dragging, .reordering").count()) === 0, await order(p));
  await p.page.waitForTimeout(350);
  await p.page.keyboard.press("Escape");
  check("O7 Esc switches rearranging off", !(await arrangingNow(p)));
  await arrange(p);
  await p.page.dblclick('#tabs .tab[aria-selected="true"]');
  check("O7 a second double click switches it off too", !(await arrangingNow(p)));
  await arrange(p);
  await p.page.click("#settingsBtn"); await p.page.keyboard.press("Escape");
  check("O7 Esc inside settings leaves rearranging alone", await arrangingNow(p));
  await p.page.click("#settingsClose");
  await p.page.evaluate(() => localStorage.setItem("sayframe.tabOrder.v1", '["claude","tools","motion"]')); await p.restart();
  await p.page.waitForTimeout(350);
  await p.page.focus("#tabClaude"); await p.page.keyboard.press("Alt+ArrowRight");
  check("O8 Alt+Right moves the focused tab right and keeps focus (keyboard needs no double click)", !(await arrangingNow(p)) && (await order(p)) === "tools,claude,motion" && (await p.page.evaluate(() => document.activeElement.id)) === "tabClaude" && (await savedOrder(p)) === '["tools","claude","motion"]');
  await p.page.keyboard.press("Alt+ArrowRight");
  check("O8 Alt+Right again moves it to the end", (await order(p)) === "tools,motion,claude");
  await p.page.keyboard.press("Alt+ArrowRight");
  check("O8 at the edge nothing happens", (await order(p)) === "tools,motion,claude");
  await p.page.keyboard.press("ArrowLeft");
  check("O8 plain arrow moves focus, not the tab", (await order(p)) === "tools,motion,claude" && (await p.page.evaluate(() => document.activeElement.id)) === "tabMotion");
  await p.page.focus("#tabTools"); await p.page.keyboard.press("Alt+ArrowLeft");
  check("O8 Alt+Left at the left edge does nothing", (await order(p)) === "tools,motion,claude");
  await p.page.focus("#tabClaude"); await p.page.keyboard.press("Alt+ArrowLeft"); await p.page.keyboard.press("Alt+ArrowLeft");
  check("O8 Alt+Left twice moves the tab back to the front", (await order(p)) === "claude,tools,motion");
  check("O8 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  for (const [bad, want] of [['not json', "claude,tools,motion"], ['{"a":1}', "claude,tools,motion"], ['["tools"]', "tools,claude,motion"], ['["ghost","tools","tools","claude",5]', "tools,claude,motion"], ['[]', "claude,tools,motion"],
    ['["tools","claude"]', "tools,claude,motion"] /* order saved by 1.3, before the Animation tab existed */, ['["motion","claude"]', "motion,claude,tools"]]) {
    p = await open({});
    await p.page.evaluate((v) => localStorage.setItem("sayframe.tabOrder.v1", v), bad); await p.restart();
    check("O9 saved order " + bad + " -> " + want, (await order(p)) === want && p.errors.length === 0 && (await vis(p, "#prompt")), await order(p));
    await p.close();
  }
  p = await open({ width: 300, height: 620 });
  await arrange(p);
  t = await p.page.evaluate(() => { const b = document.getElementById("arrangeBar").getBoundingClientRect(), d = document.getElementById("arrangeDone").getBoundingClientRect(); return d.right <= b.right && d.left >= b.left && b.right <= 286; });
  check("O10 the bar and its button fit a 300px panel", t === true);
  await dragTab(p, "#tabTools", "#tabClaude");
  t = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("O10 reordering works in a 300px panel", (await order(p)) === "tools,claude,motion" && t <= 0);
  check("O10 dragging a tab that is not open does not open it", (await vis(p, "#prompt")) && !(await vis(p, "#pasteBtn")) && (await p.page.locator("#tabClaude").getAttribute("aria-selected")) === "true");
  await p.close();

  // ---------------------------------------------------------------- animation tab
  console.log("\n=== animation: easing ===");
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const sameVec = (a, b) => a.length === b.length && a.every((x, i) => near(x, b[i]));
  const eases = (list) => list.map((e) => e.speed + "/" + e.influence).join();
  const setSlider = (p, id, v) => p.page.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }, [id, v]);
  const motionTab = async (p) => { await p.page.click("#tabMotion"); };
  const typeNumber = async (p, id, text, key) => { await p.page.click("#" + id); await p.page.keyboard.type(text); await p.page.keyboard.press(key || "Enter"); };
  const hostCall = (p, script) => p.page.evaluate((script) => new Promise((done) => window.__adobe_cep__.evalScript(script, done)), script);
  const fillOf = (p, id) => p.page.locator("#" + id).evaluate((el) => el.style.getPropertyValue("--v"));
  let clock, prop1, prop2, grp, L, L2, before;

  p = await open({});
  check("M1 three tabs, Animation closed at first", (await order(p)) === "claude,tools,motion" && !(await vis(p, "#easeBothBtn")));
  await motionTab(p);
  check("M1 Animation tab shows both tools and nothing from the other tabs", (await vis(p, "#easeBothBtn")) && (await vis(p, "#anchorGrid")) && (await p.page.locator("#anchorGrid button").count()) === 9 && !(await vis(p, "#prompt")) && !(await vis(p, "#pasteBtn")) && (await p.page.locator("#viewMotion #statusBox").count()) === 1);
  t = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("M1 no horizontal overflow at 380px", t <= 0, t);
  await p.page.screenshot({ path: path.join(SHOTS, "21-tab-motion.png") });
  check("M2 sliders start linked at 60", (await p.page.inputValue("#easeIn")) === "60" && (await p.page.inputValue("#easeOut")) === "60" && (await p.page.isChecked("#easeLink")) && (await p.page.inputValue("#easeInVal")) === "60" && (await p.page.inputValue("#easeOutVal")) === "60");
  check("M2 the easing block: a title, the apply button, the curve toggle and the keyboard handle, no slider labels", (await p.page.locator("#viewMotion .ease-card button").count()) === 3 && (await p.page.locator("#easeInBtn, #easeOutBtn").count()) === 0 && (await p.page.locator(".ease-card label:not(.ease-link)").count()) === 0 && (await p.page.locator(".ease-card .tool-head b").innerText()) === "Плавность ключей" && (await p.page.locator("#showCurve").count()) === 0);
  t = await p.page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const a = r("easeIn"), b = r("easeBothBtn"), c = r("easeOut"), n1 = r("easeInVal"), l = document.querySelector(".ease-link").getBoundingClientRect(), n2 = r("easeOutVal"); return { row: a.right <= b.left && b.right <= c.left && Math.abs((a.top + a.bottom) - (c.top + c.bottom)) < 2, equal: Math.abs(a.width - c.width) < 2, nums: n1.right <= l.left && l.right <= n2.left && n1.top >= b.bottom - 1, centered: Math.abs((l.left + l.right) / 2 - (b.left + b.right) / 2) < 2, rtl: getComputedStyle(document.getElementById("easeIn")).direction }; });
  check("M2 layout: slider, button, slider in one row; numbers and link centred under the button", t.row && t.equal && t.nums && t.centered, JSON.stringify(t));
  check("M2 the left slider grows away from the button", t.rtl === "rtl" && (await fillOf(p, "easeIn")) === "0.6" && (await fillOf(p, "easeOut")) === "0.6", t.rtl);
  c = await p.page.getAttribute("#easeCurvePath", "d");
  await setSlider(p, "easeOut", 85);
  check("M2 linked: moving one slider moves the other, labels and curve follow", (await p.page.inputValue("#easeIn")) === "85" && (await p.page.inputValue("#easeInVal")) === "85" && (await p.page.inputValue("#easeOutVal")) === "85" && (await fillOf(p, "easeIn")) === "0.85" && (await p.page.getAttribute("#easeCurvePath", "d")) !== c);
  await p.page.locator("#easeLink").evaluate((el) => el.click());
  await setSlider(p, "easeIn", 20);
  check("M2 unlinked: sliders are independent", (await p.page.inputValue("#easeIn")) === "20" && (await p.page.inputValue("#easeOut")) === "85" && !(await p.page.isChecked("#easeLink")));
  check("M2 curve: left handle = start (85%), right handle = stop (20%)", (await p.page.getAttribute("#easeCurvePath", "d")) === "M12 72 C161.6 72 152.8 12 188 12", await p.page.getAttribute("#easeCurvePath", "d"));
  await typeNumber(p, "easeOutVal", "42");
  check("M2 a typed number moves its slider only (unlinked)", (await p.page.inputValue("#easeOut")) === "42" && (await p.page.inputValue("#easeIn")) === "20" && (await fillOf(p, "easeOut")) === "0.42");
  await typeNumber(p, "easeOutVal", "250");
  check("M2 a number above 100 is capped", (await p.page.inputValue("#easeOut")) === "100" && (await p.page.inputValue("#easeOutVal")) === "100");
  await typeNumber(p, "easeInVal", "abc");
  check("M2 text that is not a number is thrown away", (await p.page.inputValue("#easeIn")) === "20" && (await p.page.inputValue("#easeInVal")) === "20");
  await typeNumber(p, "easeInVal", "77", "Escape");
  check("M2 Escape cancels typing", (await p.page.inputValue("#easeIn")) === "20" && (await p.page.inputValue("#easeInVal")) === "20");
  await typeNumber(p, "easeOutVal", "85%");
  check("M2 a number typed with a percent sign is accepted", (await p.page.inputValue("#easeOut")) === "85" && (await p.page.inputValue("#easeIn")) === "20");
  await p.page.selectOption("#anchorKeys", "shift");
  await p.restart();
  check("M2 sliders, link and key option survive a restart, with the tab", (await p.page.inputValue("#easeIn")) === "20" && (await p.page.inputValue("#easeOut")) === "85" && !(await p.page.isChecked("#easeLink")) && (await p.page.inputValue("#anchorKeys")) === "shift" && (await vis(p, "#easeBothBtn")));
  await p.page.locator("#easeLink").evaluate((el) => el.click());
  check("M2 linking again copies the start value to the stop", (await p.page.inputValue("#easeIn")) === "85" && (await p.page.inputValue("#easeOut")) === "85");
  await p.page.click("#easeBothBtn"); await p.idle();
  check("M3 no keys selected -> a hint, not an error", (await p.status()) === "Выделите ключевые кадры на таймлайне и нажмите ещё раз." && (await p.statusKind()) === "" && !(await p.page.locator("#easeBothBtn").isDisabled()));
  check("M3 an empty run still closes its undo group", p.ae.log.undo.join() === "begin:Sayframe: ease keyframes,end");
  await p.close();
  p = await open({ noActiveComp: true });
  await motionTab(p); await p.page.click("#easeBothBtn"); await p.idle();
  t = await p.status();
  await p.page.locator("#anchorGrid button").nth(4).click(); await p.idle();
  check("M3 no open composition -> hint for both tools", /^Откройте композицию/.test(t) && /^Откройте композицию/.test(await p.status()) && (await p.statusKind()) === "" && p.ae.log.undo.length === 0);
  await p.close();
  for (const garbage of ["not json", '{"easeIn":"x","easeOut":900,"link":"yes","anchorKeys":"explode"}', "[]", "null"]) {
    p = await open({});
    await p.page.evaluate((v) => localStorage.setItem("sayframe.motion.v1", v), garbage); await p.restart(); await motionTab(p);
    t = [await p.page.inputValue("#easeIn"), await p.page.inputValue("#easeOut"), await p.page.inputValue("#anchorKeys")].join();
    check("M3 broken saved values (" + garbage.slice(0, 10) + ") fall back safely", (t === "60,60,key" || t === "60,100,key") && p.errors.length === 0, t);
    await p.close();
  }

  p = await open({});
  await motionTab(p);
  const toggle = async (p) => { const b = p.page.locator("#easeCurveToggle"); return [await b.getAttribute("aria-expanded"), await b.getAttribute("title"), (await p.page.locator("#easeCurveToggle .ease-toggle-plus").evaluate((el) => getComputedStyle(el).display)) !== "none" ? "+" : "-"].join("|"); };
  t = await p.page.evaluate(() => { const r = (el) => el.getBoundingClientRect(); const card = r(document.querySelector(".ease-card")), b = r(document.getElementById("easeCurveToggle")), c = r(document.getElementById("easeCurve")), s = r(document.getElementById("easeBothBtn")); return { corner: b.top >= card.top && b.right <= card.right && card.right - b.right < 16 && b.top - card.top < 8, clear: b.bottom <= c.top + 1, above: c.height > 40 && c.bottom <= s.top }; });
  check("M8 the curve is shown at first, with a minus in the card's top right corner", (await vis(p, "#easeCurve")) && (await toggle(p)) === "true|Скрыть кривую|-" && t.corner && t.clear && t.above, JSON.stringify(t) + " " + await toggle(p));
  await setSlider(p, "easeIn", 30);
  check("M8 the curve follows the sliders", (await p.page.getAttribute("#easeCurvePath", "d")) === "M12 72 C64.8 72 135.2 12 188 12", await p.page.getAttribute("#easeCurvePath", "d"));
  await p.page.screenshot({ path: path.join(SHOTS, "21b-tab-motion-curve.png") });
  c = await p.page.evaluate(() => document.querySelector(".ease-card").getBoundingClientRect().height);
  await p.page.click("#easeCurveToggle");
  t = await p.page.evaluate(() => { const r = (el) => el.getBoundingClientRect(); const b = r(document.getElementById("easeCurveToggle")), a = r(document.getElementById("easeOut")); return { h: document.querySelector(".ease-card").getBoundingClientRect().height, clear: b.bottom <= a.top + 1 }; });
  check("M8 minus hides the curve and turns into a plus; the card shrinks", !(await vis(p, "#easeCurve")) && (await toggle(p)) === "false|Показать кривую|+" && t.h < c - 60 && t.clear, JSON.stringify(t) + " " + c);
  check("M8 the sliders still work while the curve is hidden", (await vis(p, "#easeBothBtn")) && (await vis(p, "#easeIn")) && (await p.page.inputValue("#easeInVal")) === "30");
  await p.page.screenshot({ path: path.join(SHOTS, "21c-tab-motion-no-curve.png") });
  await p.restart();
  check("M8 hidden stays hidden after a restart", !(await vis(p, "#easeCurve")) && (await toggle(p)) === "false|Показать кривую|+");
  await p.page.focus("#easeCurveToggle"); await p.page.keyboard.press("Enter");
  check("M8 plus brings the curve back (keyboard too)", (await vis(p, "#easeCurve")) && (await toggle(p)) === "true|Скрыть кривую|-");
  await p.restart();
  check("M8 shown stays shown after a restart", (await vis(p, "#easeCurve")) && (await toggle(p)) === "true|Скрыть кривую|-" && p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  p = await open({});
  await p.page.evaluate(() => localStorage.setItem("sayframe.motion.v1", JSON.stringify({ easeIn: 40, easeOut: 40, link: true, anchorKeys: "key" }))); await p.restart(); await motionTab(p);
  check("M8 values saved by the previous version (no curve choice) show the curve", (await vis(p, "#easeCurve")) && (await p.page.inputValue("#easeIn")) === "40");
  await p.close();

  // ---------------------------------------------------------------- animation: two blocks side by side, swappable
  const toolOrder = (p) => p.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#motionTools .tool-card"), (c) => c.getAttribute("data-tool")).join());
  const savedTools = (p) => p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.motion.v1") || "{}").order || null);
  const toolRects = (p) => p.page.evaluate(() => { const o = {}; Array.prototype.forEach.call(document.querySelectorAll("#motionTools .tool-card"), (c) => { const r = c.getBoundingClientRect(); o[c.getAttribute("data-tool")] = { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width) }; }); return o; });
  const grip = (tool) => '#motionTools [data-tool="' + tool + '"] .tool-grip';
  async function dragFrom(p, from, to) {
    await p.page.mouse.move(from.x, from.y); await p.page.mouse.down();
    await p.page.mouse.move(to.x, to.y, { steps: 12 });
    await p.page.mouse.up();
  }
  const middle = (r) => ({ x: (r.l + r.r) / 2, y: (r.t + r.b) / 2 });

  p = await open({});
  await motionTab(p);
  t = await toolRects(p);
  check("R1 at 380px easing and anchor stand side by side, align takes the row below", (await toolOrder(p)) === "ease,anchor,align" && t.ease.t === t.anchor.t && t.ease.r < t.anchor.l && Math.abs(t.ease.w - t.anchor.w) <= 1 && t.ease.l === 14 && t.anchor.r === 366 && t.align.t >= Math.max(t.ease.b, t.anchor.b) && t.align.l === 14 && t.align.r === 366, JSON.stringify(t));
  t = await p.page.evaluate(() => { const inside = (card) => { const c = card.getBoundingClientRect(); return Array.prototype.every.call(card.querySelectorAll("input, button, select, svg, b, label"), (el) => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.left >= c.left - 0.5 && r.right <= c.right + 0.5); }); }; return Array.prototype.map.call(document.querySelectorAll("#motionTools .tool-card"), inside).join(); });
  check("R1 nothing sticks out of any block", t === "true,true,true" && (await overflow(p)) <= 0, t);
  t = await p.page.evaluate(() => [document.getElementById("easeIn").getBoundingClientRect().width, document.getElementById("easeOut").getBoundingClientRect().width, document.getElementById("anchorGrid").getBoundingClientRect().width].map(Math.round));
  check("R1 sliders stay usable and the arrow grid keeps its size", t[0] === t[1] && t[0] >= 40 && t[2] >= 118, t.join());
  await p.page.screenshot({ path: path.join(SHOTS, "21d-tools-side-by-side.png") });

  // Without the double click nothing can be dragged.
  t = await toolRects(p);
  await dragFrom(p, { x: t.ease.l + 6, y: t.ease.b - 5 }, { x: middle(t.anchor).x + 10, y: t.ease.b - 5 });
  check("R2 without a double click a block cannot be dragged", (await toolOrder(p)) === "ease,anchor,align" && (await savedTools(p)) !== "anchor,ease,align" && (await p.page.locator("#motionTools .dragging").count()) === 0);
  c = await center(p, "#easeOut");
  await dragFrom(p, c, { x: middle(t.anchor).x + 20, y: c.y });
  check("R2 the sliders work as usual", (await toolOrder(p)) === "ease,anchor,align" && (await p.page.inputValue("#easeOut")) === "100", await p.page.inputValue("#easeOut"));
  await setSlider(p, "easeOut", 60);
  await p.page.dblclick("#easeInVal");
  check("R2 a double click on a number does not start rearranging", !(await arrangingNow(p)));
  await p.page.keyboard.press("Escape");
  await p.page.dblclick("#easeIn");
  check("R2 nor does a double click on a slider", !(await arrangingNow(p)));
  await setSlider(p, "easeIn", 60);

  await p.page.dblclick("#motionTools .anchor-card .tool-head b");
  check("R3 a double click on a free part of a block switches rearranging on", (await arrangingNow(p)) && (await vis(p, "#arrangeBar")));
  check("R3 the double click does not select the block's title", (await p.page.evaluate(() => String(window.getSelection()))) === "");
  await p.page.waitForTimeout(350);
  await p.page.screenshot({ path: path.join(SHOTS, "21h-tools-arranging.png") });
  t = await toolRects(p);
  c = await center(p, "#easeOut");
  await dragFrom(p, c, { x: middle(t.anchor).x + 10, y: c.y + 4 });
  t = await toolRects(p);
  check("R3 now the block is dragged by any place, even over a slider, and swaps past the middle of the other", (await toolOrder(p)) === "anchor,ease,align" && t.anchor.r < t.ease.l && t.anchor.l === 14 && (await savedTools(p)) === "anchor,ease,align" && (await p.page.inputValue("#easeOut")) === "60", await toolOrder(p) + " " + await p.page.inputValue("#easeOut"));
  check("R3 no leftovers after the drop, rearranging stays on", (await p.page.locator("#motionTools .dragging").count()) === 0 && !(await p.page.locator("#motionTools").evaluate((el) => /reordering/.test(el.className))) && (await arrangingNow(p)));
  await p.page.screenshot({ path: path.join(SHOTS, "21e-tools-swapped.png") });
  await p.page.waitForTimeout(350);
  c = await center(p, "#anchorGrid button:nth-child(5)");
  await p.page.mouse.click(c.x, c.y); await p.idle();
  check("R3 while rearranging the buttons inside the blocks do nothing", (await p.status()) === "Готов." && p.ae.log.undo.length === 0, await p.status());
  t = await toolRects(p);
  c = middle(t.ease);
  await dragFrom(p, c, { x: c.x - 30, y: c.y });
  check("R3 a short drag that does not reach the middle changes nothing", (await toolOrder(p)) === "anchor,ease,align");
  await p.page.waitForTimeout(350);
  await p.page.mouse.dblclick(middle(t.ease).x, middle(t.ease).y);
  check("R3 a double click on a block switches rearranging off", !(await arrangingNow(p)) && (await toolOrder(p)) === "anchor,ease,align");
  await p.page.click("#easeBothBtn"); await p.idle();
  check("R3 the tools work again, in the new order", (await p.status()) === "Выделите ключевые кадры на таймлайне и нажмите ещё раз.");
  await p.restart();
  check("R3 the order survives a restart", (await toolOrder(p)) === "anchor,ease,align" && (await vis(p, "#easeBothBtn")) && !(await arrangingNow(p)));
  await arrange(p);
  t = await toolRects(p);
  await dragFrom(p, { x: t.ease.l + 6, y: t.ease.b - 5 }, { x: middle(t.anchor).x - 10, y: t.ease.b - 5 });
  check("R3 dragging back restores the order", (await toolOrder(p)) === "ease,anchor,align" && (await savedTools(p)) === "ease,anchor,align", await toolOrder(p));
  await p.page.waitForTimeout(350);
  await dragTab(p, "#tabMotion", "#tabClaude");
  check("R3 the same mode moves the tabs", (await order(p)) === "motion,claude,tools");
  await p.page.waitForTimeout(350);
  await p.page.keyboard.press("Escape");
  check("R3 Esc ends it", !(await arrangingNow(p)));

  await p.page.focus(grip("anchor")); await p.page.keyboard.press("ArrowLeft");
  check("R4 keyboard: arrow on the block's handle moves it and keeps focus (no double click needed)", !(await arrangingNow(p)) && (await toolOrder(p)) === "anchor,ease,align" && (await p.page.evaluate(() => document.activeElement.className)) === "tool-grip" && (await savedTools(p)) === "anchor,ease,align");
  await p.page.keyboard.press("ArrowLeft");
  check("R4 at the edge nothing happens", (await toolOrder(p)) === "anchor,ease,align");
  await p.page.keyboard.press("ArrowRight");
  check("R4 and back", (await toolOrder(p)) === "ease,anchor,align" && p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  p = await open({ width: 300 });
  await motionTab(p);
  t = await toolRects(p);
  check("R5 in a narrow panel the blocks stack, each full width", t.ease.b <= t.anchor.t && t.ease.l === 14 && t.ease.w === 272 && t.anchor.w === 272 && (await overflow(p)) <= 0, JSON.stringify(t));
  await arrange(p);
  t = await toolRects(p);
  c = middle(t.anchor);
  await dragFrom(p, c, { x: c.x + 3, y: middle(t.ease).y - 10 });
  t = await toolRects(p);
  check("R5 stacked blocks swap by dragging up or down", (await toolOrder(p)) === "anchor,ease,align" && t.anchor.b <= t.ease.t, await toolOrder(p));
  await p.page.screenshot({ path: path.join(SHOTS, "21f-tools-stacked.png") });
  await p.close();

  p = await open({ width: 900, settings: { panelWidth: 600 } });
  await motionTab(p);
  t = await toolRects(p);
  check("R6 with a wider panel setting all three blocks fit one row", t.ease.t === t.anchor.t && t.anchor.t === t.align.t && t.ease.l === 14 && t.align.r === 586 && t.ease.w >= 170 && Math.abs(t.ease.w - t.align.w) <= 1, JSON.stringify(t));
  await p.page.screenshot({ path: path.join(SHOTS, "21g-tools-wide.png") });
  await p.close();
  for (const [bad, want] of [['"anchor"', "anchor,ease,align"], ['"ease,ease"', "ease,anchor,align"], ["7", "ease,anchor,align"], ["null", "ease,anchor,align"], ['["anchor","ease"]', "ease,anchor,align"],
    ['"anchor,ease"', "anchor,ease,align"] /* an order saved before the Align block existed */, ['"align,ghost,ease"', "align,ease,anchor"]]) {
    p = await open({});
    await p.page.evaluate((v) => localStorage.setItem("sayframe.motion.v1", '{"order":' + v + "}"), bad); await p.restart(); await motionTab(p);
    check("R7 saved order " + bad + " -> " + want, (await toolOrder(p)) === want && (await p.page.locator("#motionTools .tool-card").count()) === 3 && p.errors.length === 0, await toolOrder(p));
    await p.close();
  }
  p = await open({});
  await motionTab(p); await arrange(p);
  t = await toolRects(p);
  await dragFrom(p, middle(t.align), { x: middle(t.ease).x - 20, y: middle(t.ease).y - 10 });
  check("R8 the block from the second row can be dragged up to the front", (await toolOrder(p)) === "align,ease,anchor" && (await savedTools(p)) === "align,ease,anchor", await toolOrder(p));
  await p.page.waitForTimeout(350);
  t = await toolRects(p);
  check("R8 then align and easing share the first row", t.align.t === t.ease.t && t.align.r < t.ease.l && t.anchor.t >= t.align.b, JSON.stringify(t));
  await dragFrom(p, middle(t.align), { x: middle(t.anchor).x, y: middle(t.anchor).y + 10 });
  check("R8 and down to the end again", (await toolOrder(p)) === "ease,anchor,align", await toolOrder(p));
  await p.close();

  function easeScene() {
    clock = { time: 1 };
    prop1 = new Prop(50, clock).addKey(0, 0).addKey(1, 50, { selected: true }).addKey(2, 100, { selected: true });          // opacity: 1 ease per side
    prop2 = new Prop([100, 100, 100], clock, { easeDims: 3 }).addKey(0, [0, 0, 100]).addKey(2, [100, 100, 100], { selected: true, inType: KIT.HOLD, outType: KIT.LINEAR }); // scale: 3 eases per side
    grp = { propertyType: 6213, numKeys: 0, selectedKeys: [1] };                                                              // a selected group must be ignored
    return { selectedProperties: [grp, prop1, prop2, new Prop(5, clock).addKey(0, 5)], compTime: 1 };
  }
  p = await open(easeScene());
  await motionTab(p);
  await p.page.locator("#easeLink").evaluate((el) => el.click());
  await setSlider(p, "easeOut", 75); await setSlider(p, "easeIn", 40);
  await p.page.click("#easeBothBtn"); await p.idle();
  check("M4 'apply' eases both sides of every selected key", [prop1.keys[1], prop1.keys[2]].every((k) => eases(k.inEase) === "0/40" && eases(k.outEase) === "0/75" && k.inType === KIT.BEZIER && k.outType === KIT.BEZIER), eases(prop1.keys[1].inEase) + " | " + eases(prop1.keys[1].outEase));
  check("M4 one ease per dimension (3 for scale)", eases(prop2.keys[1].inEase) === "0/40,0/40,0/40" && eases(prop2.keys[1].outEase) === "0/75,0/75,0/75" && prop2.keys[1].inType === KIT.BEZIER);
  check("M4 unselected keys and values are untouched", eases(prop1.keys[0].inEase) === "11/16.67" && eases(prop1.keys[0].outEase) === "22/16.67" && prop1.keys[0].inType === KIT.LINEAR && prop1.keys.map((k) => k.value).join() === "0,50,100" && eases(prop2.keys[0].outEase) === "22/16.67,22/16.67,22/16.67");
  check("M4 result reported, one undo step", (await p.status()) === "Плавность применена: 3 ключа.\nОтменить: Cmd/Ctrl+Z." && (await p.statusKind()) === "done" && p.ae.log.undo.join() === "begin:Sayframe: ease keyframes,end", await p.status());
  await p.close();

  p = await open(easeScene());
  await motionTab(p);
  t = JSON.parse(await hostCall(p, 'sayframeHost.ease(90,60,"in")'));
  check("M5 host 'in' mode changes the arriving side and keeps the leaving side", t.ok && eases(prop1.keys[1].inEase) === "0/90" && eases(prop1.keys[1].outEase) === "22/16.67" && prop1.keys[1].inType === KIT.BEZIER && prop1.keys[1].outType === KIT.LINEAR, eases(prop1.keys[1].outEase) + " " + prop1.keys[1].outType);
  check("M5 a linear leaving side stays linear on the 3D property too", eases(prop2.keys[1].inEase) === "0/90,0/90,0/90" && prop2.keys[1].outType === KIT.LINEAR && prop2.keys[1].inType === KIT.BEZIER);
  await p.close();
  p = await open(easeScene());
  await motionTab(p);
  t = JSON.parse(await hostCall(p, 'sayframeHost.ease(60,30,"out")'));
  check("M5 host 'out' mode changes the leaving side and keeps the arriving side", t.ok && eases(prop1.keys[2].outEase) === "0/30" && eases(prop1.keys[2].inEase) === "11/16.67" && prop1.keys[2].inType === KIT.LINEAR && prop1.keys[2].outType === KIT.BEZIER);
  check("M5 a hold on the arriving side stays a hold", prop2.keys[1].inType === KIT.HOLD && prop2.keys[1].outType === KIT.BEZIER && eases(prop2.keys[1].outEase) === "0/30,0/30,0/30");
  await p.close();
  p = await open(easeScene());
  await motionTab(p); await setSlider(p, "easeOut", 0);
  await p.page.click("#easeBothBtn"); await p.idle();
  check("M6 slider at 0 is sent as the smallest influence After Effects accepts", eases(prop1.keys[1].inEase) === "0/0.1" && eases(prop1.keys[1].outEase) === "0/0.1" && (await p.statusKind()) === "done", eases(prop1.keys[1].inEase));
  await setSlider(p, "easeOut", 100);
  await p.page.click("#easeBothBtn"); await p.idle();
  check("M6 slider at 100", eases(prop1.keys[2].inEase) === "0/100" && eases(prop1.keys[2].outEase) === "0/100");
  await p.close();
  p = await open(easeScene());
  prop1.locked = true;
  await motionTab(p); await p.page.click("#easeBothBtn"); await p.idle();
  check("M7 keys After Effects refuses are counted, the rest are done", /^Плавность применена: 1 ключ\. Не получилось для 2 ключей\./.test(await p.status()) && eases(prop2.keys[1].inEase) === "0/60,0/60,0/60", await p.status());
  prop2.locked = true;
  await p.page.click("#easeBothBtn"); await p.idle();
  check("M7 nothing could be changed -> error", (await p.statusKind()) === "error" && /Не удалось изменить выделенные ключи/.test(await p.status()));
  check("M7 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  console.log("\n=== animation: anchor point ===");
  const CELLS = [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]];
  const cell = async (p, i) => { await p.page.locator("#anchorGrid button").nth(i).click(); await p.idle(); };
  const A = (l) => l.props["ADBE Anchor Point"], P = (l) => l.props["ADBE Position"];
  const PROBE = [[7, 3, 0], [120, -40, 0], [0, 0, 0]];
  const worlds = (l) => PROBE.map((pt) => l.world(pt));
  const sameWorlds = (a, b) => a.every((w, i) => sameVec(w, b[i]));

  clock = { time: 0 };
  L = mkLayer(clock, { rect: { left: -20, top: 10, width: 200, height: 80 }, anchor: [0, 0, 0], position: [960, 540, 0], scale: [200, 50, 100], rotation: 90 });
  p = await open({ selectedLayers: [L] });
  await motionTab(p);
  before = worlds(L);
  await cell(p, 4);
  check("A1 centre: anchor moves to the middle of the layer's bounds", sameVec(A(L).value, [80, 50, 0]), A(L).value.join());
  check("A1 position compensates for scale and rotation exactly", sameVec(P(L).value, [960 - 25, 540 + 160, 0]), P(L).value.join());
  check("A1 the layer does not move on screen", sameWorlds(before, worlds(L)));
  check("A1 result reported, one undo step", (await p.status()) === "Точка привязки перенесена: 1 слой.\nОтменить: Cmd/Ctrl+Z." && (await p.statusKind()) === "done" && p.ae.log.undo.join() === "begin:Sayframe: move anchor point,end", await p.status());
  t = true; c = [];
  for (let i = 0; i < 9; i++) {
    await cell(p, i);
    const want = [-20 + 200 * CELLS[i][0], 10 + 80 * CELLS[i][1], 0];
    if (!sameVec(A(L).value, want) || !sameWorlds(before, worlds(L))) { t = false; c.push(i + ":" + A(L).value.join("/")); }
  }
  check("A2 all nine cells: right point, layer stays put every time", t, c.join(" "));
  await cell(p, 8);
  check("A3 already there -> says so, changes nothing", (await p.status()) === "Уже на месте: 1 слой." && (await p.statusKind()) === "" && sameVec(A(L).value, [180, 90, 0]));
  check("A3 labels for screen readers", (await p.page.locator("#anchorGrid button").nth(0).getAttribute("aria-label")) === "Левый верхний угол" && (await p.page.locator("#anchorGrid button").nth(4).getAttribute("aria-label")) === "Центр слоя" && (await p.page.locator("#anchorGrid button").nth(8).getAttribute("aria-label")) === "Правый нижний угол");
  await p.close();

  p = await open({ selectedLayers: [] });
  await motionTab(p); await cell(p, 4);
  check("A4 no layer selected -> hint", (await p.status()) === "Выделите слой в композиции и нажмите ещё раз." && (await p.statusKind()) === "" && p.ae.log.undo.length === 0);
  await p.close();

  // keyframes: three ways to treat an animated layer
  function keyedLayer() {
    clock = { time: 2 };
    const l = mkLayer(clock, { rect: { left: 0, top: 0, width: 100, height: 60 }, anchor: [0, 0, 0], position: [300, 200, 0], scale: [100, 100, 100], rotation: 0 });
    A(l).addKey(0, [0, 0, 0]).addKey(4, [10, 0, 0]);
    P(l).addKey(0, [300, 200, 0]).addKey(4, [500, 200, 0]);
    return l;
  }
  L = keyedLayer();
  p = await open({ selectedLayers: [L], compTime: 2 });
  await motionTab(p); await cell(p, 4);
  check("A5 'add a key': a key appears at the current time on both properties", A(L).numKeys === 3 && P(L).numKeys === 3 && A(L).keys[1].time === 2 && sameVec(A(L).keys[1].value, [50, 30, 0]) && sameVec(P(L).keys[1].value, [350, 230, 0]), JSON.stringify(A(L).keys.map((k) => [k.time, k.value])));
  check("A5 'add a key': the other keys are left alone", sameVec(A(L).keys[0].value, [0, 0, 0]) && sameVec(A(L).keys[2].value, [10, 0, 0]) && sameVec(P(L).keys[2].value, [500, 200, 0]) && A(L).calls.indexOf("setValue") < 0);
  await p.close();
  L = keyedLayer();
  p = await open({ selectedLayers: [L], compTime: 2 });
  await motionTab(p); await p.page.selectOption("#anchorKeys", "shift"); await cell(p, 4);
  check("A6 'shift all keys': every key moves by the same amount, none are added", A(L).numKeys === 2 && P(L).numKeys === 2 && sameVec(A(L).keys[0].value, [50, 30, 0]) && sameVec(A(L).keys[1].value, [60, 30, 0]) && sameVec(P(L).keys[0].value, [350, 230, 0]) && sameVec(P(L).keys[1].value, [550, 230, 0]), JSON.stringify(P(L).keys.map((k) => k.value)));
  await p.close();
  L = keyedLayer(); L2 = mkLayer(clock, { index: 2, rect: { left: 0, top: 0, width: 40, height: 40 }, position: [10, 10, 0] });
  p = await open({ selectedLayers: [L, L2], compTime: 2 });
  await motionTab(p); await p.page.selectOption("#anchorKeys", "skip"); await cell(p, 4);
  check("A7 'leave such a layer': the animated layer is untouched, the other one is moved", A(L).numKeys === 2 && sameVec(A(L).keys[0].value, [0, 0, 0]) && sameVec(P(L).keys[1].value, [500, 200, 0]) && sameVec(A(L2).value, [20, 20, 0]) && sameVec(P(L2).value, [30, 30, 0]));
  check("A7 both outcomes are reported", (await p.status()) === "Точка привязки перенесена: 1 слой. Пропущено: 1 слой (камера, свет или слой с ключами).\nОтменить: Cmd/Ctrl+Z.", await p.status());
  await p.close();

  // separated position dimensions, with a key on X only
  clock = { time: 1 };
  L = mkLayer(clock, { separated: true, rect: { left: 0, top: 0, width: 100, height: 100 }, position: [100, 200, 0], scale: [50, 50, 100], rotation: 180 });
  L.props["ADBE Position_0"].addKey(0, 100).addKey(3, 400);
  before = null;
  p = await open({ selectedLayers: [L], compTime: 1 });
  await motionTab(p); await cell(p, 8);
  t = [L.props["ADBE Position_0"], L.props["ADBE Position_1"]];
  check("A8 separated dimensions: X gets a key, Y is set directly, combined position untouched", t[0].numKeys === 3 && near(t[0].keys[1].value, 50) && t[0].keys[1].time === 1 && near(t[1].value, 150) && t[1].numKeys === 0 && P(L).calls.length === 0 && sameVec(A(L).value, [100, 100, 0]), t[0].keys.map((k) => k.time + ":" + k.value).join() + " y=" + t[1].value);
  await p.close();

  // cameras, lights, locked layers, several layers at once
  clock = { time: 0 };
  L = mkLayer(clock, { rect: { left: 0, top: 0, width: 10, height: 10 }, position: [5, 5, 0] });
  L2 = mkLayer(clock, { index: 2, locked: true, rect: { left: 0, top: 0, width: 10, height: 10 } });
  const cam = mkLayer(clock, { index: 3, kind: "camera" }), light = mkLayer(clock, { index: 4, kind: "light" });
  const text = mkLayer(clock, { index: 5, kind: "text", rect: { left: -30, top: -50, width: 60, height: 20 }, position: [100, 100, 0] });
  p = await open({ selectedLayers: [L, L2, cam, light, text] });
  await motionTab(p); await cell(p, 2);
  check("A9 mixed selection: movable layers moved, camera and light skipped, locked layer reported", sameVec(A(L).value, [10, 0, 0]) && sameVec(A(text).value, [30, -50, 0]) && sameVec(P(text).value, [130, 50, 0]) && sameVec(A(L2).value, [0, 0, 0]) && sameVec(A(cam).value, [0, 0, 0]));
  check("A9 status lists every outcome", (await p.status()) === "Точка привязки перенесена: 2 слоя. Пропущено: 2 слоя (камера, свет или слой с ключами). Не получилось: 1 слой (слой заблокирован?).\nОтменить: Cmd/Ctrl+Z." && (await p.statusKind()) === "done", await p.status());
  await p.close();
  p = await open({ selectedLayers: [mkLayer({ time: 0 }, { locked: true })] });
  await motionTab(p); await cell(p, 4);
  check("A9 only a locked layer -> error", (await p.statusKind()) === "error" && /^Не получилось: 1 слой/.test(await p.status()), await p.status());
  await p.close();

  // 3D layers: After Effects converts the point through a temporary null
  clock = { time: 0 };
  L = mkLayer(clock, { index: 1, rect: { left: 0, top: 0, width: 40, height: 40 }, position: [0, 0, 0] });
  L2 = mkLayer(clock, { index: 2, threeD: true, rect: { left: 0, top: 0, width: 100, height: 100 }, anchor: [0, 0, 25], position: [500, 500, -300], scale: [200, 200, 200], rotation: 0 });
  p = await open({ selectedLayers: [L, L2] });
  before = worlds(L2);
  await motionTab(p); await cell(p, 4);
  check("A10 3D layer: point is converted by an expression on a temporary null", p.ae.log.nullsAdded === 1 && p.ae.log.nulls[0].threeDLayer === true && /thisComp\.layer\(3\)/.test(p.ae.log.nullExpressions[0]) && /toWorld\(\[50,50,25\]\)/.test(p.ae.log.nullExpressions[0]) && /hasParent/.test(p.ae.log.nullExpressions[0]), p.ae.log.nullExpressions[0]);
  check("A10 3D layer: anchor keeps its depth, position follows, layer stays put", sameVec(A(L2).value, [50, 50, 25]) && sameVec(P(L2).value, [600, 600, -300]) && sameWorlds(before, worlds(L2)), A(L2).value.join() + " | " + P(L2).value.join());
  check("A10 the temporary null and its solid are removed", p.ae.log.nullsRemoved === 1 && p.ae.log.nullSourcesRemoved === 1 && L.index === 1 && L2.index === 2);
  check("A10 the user's selection is put back", L.selected === true && L2.selected === true && sameVec(A(L).value, [20, 20, 0]));
  await p.close();
  L2 = mkLayer(clock, { index: 1, threeD: true, rect: { left: 0, top: 0, width: 100, height: 100 }, position: [500, 500, 0] });
  p = await open({ selectedLayers: [L2], expressionsFail: true });
  await motionTab(p); await cell(p, 4);
  check("A11 3D layer when the expression cannot run: nothing is changed, null removed, error reported", sameVec(A(L2).value, [0, 0, 0]) && sameVec(P(L2).value, [500, 500, 0]) && p.ae.log.nullsRemoved === 1 && p.ae.log.nullSourcesRemoved === 1 && (await p.statusKind()) === "error" && L2.selected === true, await p.status());
  check("A11 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  p = await open({ width: 300, height: 760 });
  await motionTab(p);
  t = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("A12 Animation tab fits a 300px panel", t <= 0, t);
  await p.page.screenshot({ path: path.join(SHOTS, "22-tab-motion-narrow.png") });
  await p.close();

  // ------------------------------------------------------------------ updates
  // ---------------------------------------------------------------- animation: block width
  console.log("\n=== animation: block width ===");
  const edge = (tool) => '#motionTools [data-tool="' + tool + '"] .tool-resize';
  const savedSizes = (p) => p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.motion.v1") || "{}").sizes);
  // Is the list beside the buttons (a wide, horizontal block) or under them (a narrow, vertical one)?
  const shape = (p, tool) => p.page.evaluate((tool) => { const card = document.querySelector('#motionTools [data-tool="' + tool + '"]'); const g = card.querySelector(".anchor-grid").getBoundingClientRect(), s = card.querySelector(".anchor-side").getBoundingClientRect(); return s.left >= g.right ? "horizontal" : s.top >= g.bottom ? "vertical" : "overlap"; }, tool);
  const dragEdge = async (p, tool, dx) => { const c = await center(p, edge(tool)); await dragFrom(p, c, { x: c.x + dx, y: c.y + 3 }); };

  p = await open({ width: 700, settings: { panelWidth: 640 } });   // content column: 612px
  await motionTab(p);
  t = await toolRects(p);
  check("S1 every block has an edge to pull, on its right side", (await p.page.locator("#motionTools .tool-resize").count()) === 3 && (await p.page.evaluate(() => Array.prototype.every.call(document.querySelectorAll("#motionTools .tool-card"), (c) => { const h = c.querySelector(".tool-resize").getBoundingClientRect(), r = c.getBoundingClientRect(); return h.width >= 8 && h.left < r.right && h.right > r.right && h.height > 30 && getComputedStyle(c.querySelector(".tool-resize")).cursor === "ew-resize"; }))));
  check("S1 (scene) three blocks in one row, lists under the buttons", t.ease.t === t.anchor.t && t.anchor.t === t.align.t && (await shape(p, "anchor")) === "vertical" && (await shape(p, "align")) === "vertical", JSON.stringify(t));
  await dragEdge(p, "anchor", 150);
  t = await toolRects(p);
  check("S2 pulling the edge right makes the block wider by that much", Math.abs(t.anchor.w - (196 + 150)) <= 2 && (await savedSizes(p)) === "anchor=" + t.anchor.w, t.anchor.w + " " + await savedSizes(p));
  check("S2 a wide block turns horizontal: the list stands beside the buttons", (await shape(p, "anchor")) === "horizontal", await shape(p, "anchor"));
  check("S2 nothing is left marked and nothing overflows", (await p.page.locator(".resizing").count()) === 0 && (await overflow(p)) <= 0 && within(await spans(p), 14, 626), JSON.stringify(await spans(p)));
  await p.page.screenshot({ path: path.join(SHOTS, "24-block-wide.png") });
  await dragEdge(p, "anchor", -150);
  check("S2 pulling it back makes it narrow and vertical again", (await shape(p, "anchor")) === "vertical" && Math.abs((await toolRects(p)).anchor.w - 196) <= 2);
  await dragEdge(p, "anchor", -400);
  t = await toolRects(p);
  check("S3 a block cannot be squeezed below the width of its three buttons", t.anchor.w === 152 && (await savedSizes(p)) === "anchor=152" && (await p.page.evaluate(() => { const c = document.querySelector('[data-tool="anchor"]').getBoundingClientRect(), g = document.getElementById("anchorGrid").getBoundingClientRect(); return g.left >= c.left && g.right <= c.right; })), JSON.stringify(t.anchor));
  await dragEdge(p, "ease", 600);
  t = await toolRects(p);
  check("S4 the easing block pulled to the edge takes the whole width", t.ease.l === 14 && t.ease.r === 626 && (await savedSizes(p)) === "ease=full;anchor=152", JSON.stringify(t.ease) + " " + await savedSizes(p));
  t = await p.page.evaluate(() => [document.getElementById("easeIn").getBoundingClientRect().width, document.getElementById("easeOut").getBoundingClientRect().width, document.getElementById("easeCurve").getBoundingClientRect().width].map(Math.round));
  check("S4 then its sliders and curve stretch with it", t[0] === t[1] && t[0] > 240 && t[2] > 560, t.join());
  await p.page.screenshot({ path: path.join(SHOTS, "25-ease-full-width.png") });
  await p.restart();
  t = await toolRects(p);
  check("S5 widths survive a restart", t.ease.r - t.ease.l === 612 && t.anchor.w === 152, JSON.stringify(t));
  await p.page.setViewportSize({ width: 420, height: 760 });
  t = await toolRects(p);
  check("S5 in a narrower panel a full-width block follows the panel, a fixed one keeps its width", t.ease.l === 14 && t.ease.r === 406 && t.anchor.w === 152 && (await overflow(p)) <= 0, JSON.stringify(t));
  await p.page.setViewportSize({ width: 700, height: 760 });
  await p.page.dblclick(edge("ease"));
  t = await toolRects(p);
  check("S6 a double click on the edge returns the usual width and does not start rearranging", (await savedSizes(p)) === "anchor=152" && t.ease.w < 400 && !(await arrangingNow(p)), JSON.stringify(t.ease) + " " + await savedSizes(p));
  await p.page.focus(edge("align")); await p.page.keyboard.press("ArrowRight");
  c = (await toolRects(p)).align.w;
  await p.page.keyboard.press("ArrowRight"); await p.page.keyboard.press("ArrowLeft"); await p.page.keyboard.press("ArrowRight");
  check("S6 keyboard: arrows on the edge change the width in steps of 10", (await toolRects(p)).align.w === c + 10 && (await savedSizes(p)) === "anchor=152;align=" + (c + 10), (await toolRects(p)).align.w + " vs " + c);
  await p.page.keyboard.press("End");
  check("S6 End takes the whole width, Home returns the usual one", (await savedSizes(p)) === "anchor=152;align=full" && (await toolRects(p)).align.w === 612);
  await p.page.keyboard.press("Home");
  check("S6 Home", (await savedSizes(p)) === "anchor=152");
  await arrange(p);
  c = await toolOrder(p);
  await dragEdge(p, "anchor", 200);
  t = await toolRects(p);
  check("S7 while rearranging, the edge still changes the width and does not move the block", t.anchor.w === 352 && (await toolOrder(p)) === c && (await arrangingNow(p)) && (await p.page.locator(".dragging, .reordering, .resizing").count()) === 0, JSON.stringify(t.anchor));
  await p.page.waitForTimeout(350);
  await p.page.keyboard.press("Escape");
  await p.page.click('#anchorGrid button:nth-child(5)'); await p.idle();
  check("S7 the tools keep working at any width", (await p.status()) === "Выделите слой в композиции и нажмите ещё раз." && p.errors.length === 0, await p.status());
  await p.close();
  p = await open({ width: 700, settings: { panelWidth: 640 } });
  await p.page.evaluate(() => { ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach((n) => window.addEventListener(n, (e) => e.stopImmediatePropagation(), true)); });
  await motionTab(p);
  await dragEdge(p, "align", 120);
  check("S8 resizing works with pointer events swallowed, as inside After Effects", Math.abs((await toolRects(p)).align.w - (196 + 120)) <= 2 && (await shape(p, "align")) === "horizontal", JSON.stringify((await toolRects(p)).align));
  await p.close();
  for (const [bad, want] of [['"ease=9999;anchor=10;ghost=300;align=full"', "ease=9999;align=full"], ['"anchor=abc;ease"', ""], ["42", ""], ['"anchor=300.5;align=-200"', ""], ['"align=200;ease=200"', "ease=200;align=200"]]) {
    p = await open({});
    await p.page.evaluate((v) => localStorage.setItem("sayframe.motion.v1", '{"sizes":' + v + "}"), bad); await p.restart(); await motionTab(p);
    t = await toolRects(p);
    await setSlider(p, "easeIn", 61);
    check("S9 saved widths " + bad + " -> " + JSON.stringify(want), (await savedSizes(p)) === want && Object.keys(t).every((k) => t[k].r <= 366 && t[k].l >= 14) && (await overflow(p)) <= 0 && p.errors.length === 0, (await savedSizes(p)) + " " + JSON.stringify(t));
    await p.close();
  }

  // ---------------------------------------------------------------- dragging must not depend on pointer events
  // In After Effects 1.5.0 could not be rearranged although every test above passed: dragging relied on pointer
  // events. Here they are swallowed before the panel sees them, and a native drag is refused, as a stand-in.
  console.log("\n=== dragging without pointer events ===");
  p = await open({});
  await p.page.evaluate(() => { ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"].forEach((n) => window.addEventListener(n, (e) => e.stopImmediatePropagation(), true)); window.__nativeDrags = 0; window.addEventListener("dragstart", (e) => { if (!e.defaultPrevented) window.__nativeDrags++; }); });
  await arrange(p);
  await dragTab(p, "#tabClaude", "#tabTools");
  check("X1 tabs can be dragged with pointer events swallowed", (await order(p)) === "tools,claude,motion" && (await savedOrder(p)) === '["tools","claude","motion"]', await order(p));
  await p.page.waitForTimeout(350);
  await p.page.click("#tabMotion");
  t = await toolRects(p);
  await dragFrom(p, { x: t.ease.l + 6, y: t.ease.b - 5 }, { x: middle(t.anchor).x + 10, y: t.ease.b - 5 });
  check("X1 blocks too", (await toolOrder(p)) === "anchor,ease,align" && (await savedTools(p)) === "anchor,ease,align", await toolOrder(p));
  check("X1 the press is cancelled, so the browser starts no drag or text selection of its own", (await p.page.evaluate(() => window.__nativeDrags)) === 0 && (await p.page.evaluate(() => String(window.getSelection()))) === "" && (await p.page.locator(".dragging, .reordering").count()) === 0);
  t = await p.page.evaluate(() => { const hit = []; ["tabs", "motionTools"].forEach((id) => { const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }); document.querySelector("#" + id + (id === "tabs" ? " .tab" : " .tool-card")).dispatchEvent(ev); hit.push(ev.defaultPrevented); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); }); return hit.join(); });
  check("X1 while rearranging, a press on a tab or block is cancelled", t === "true,true", t);
  await p.page.waitForTimeout(350);
  await p.page.click("#arrangeDone");
  t = await p.page.evaluate(() => { const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }); document.querySelector("#tabs .tab").dispatchEvent(ev); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return ev.defaultPrevented; });
  check("X1 outside the mode a press is left alone", t === false);
  await arrange(p);
  t = await toolRects(p);
  await p.page.mouse.move(middle(t.anchor).x, middle(t.anchor).y); await p.page.mouse.down(); await p.page.mouse.move(middle(t.anchor).x + 30, middle(t.anchor).y, { steps: 4 });
  check("X2 (scene) a block is being dragged", (await p.page.locator("#motionTools .dragging").count()) === 1);
  await p.page.evaluate(() => window.dispatchEvent(new Event("blur")));
  check("X2 losing the window mid-drag ends the drag cleanly", (await p.page.locator(".dragging, .reordering").count()) === 0);
  await p.page.mouse.up();
  check("X2 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  // ---------------------------------------------------------------- animation: align
  console.log("\n=== animation: align ===");
  const edgeBtn = async (p, edge) => { await p.page.click('#alignGrid button[data-edge="' + edge + '"]'); await p.idle(); };
  // Where a layer's bounds end up in the composition, worked out by the mock itself (through the parents).
  const compBox = (l) => {
    const r = l.rect, pts = [[r.left, r.top], [r.left + r.width, r.top], [r.left, r.top + r.height], [r.left + r.width, r.top + r.height]].map((pt) => { let q = [pt[0], pt[1], 0]; for (let x = l; x; x = x.parent) q = x.world(q); return q; });
    return { l: Math.min.apply(null, pts.map((q) => q[0])), r: Math.max.apply(null, pts.map((q) => q[0])), t: Math.min.apply(null, pts.map((q) => q[1])), b: Math.max.apply(null, pts.map((q) => q[1])) };
  };
  const close2 = (a, b) => Math.abs(a - b) < 1e-6;
  let L3, kid, bx;

  p = await open({});
  await motionTab(p);
  check("G1 the Align block: six buttons and a target list, composition first", (await p.page.locator("#alignGrid button").count()) === 6 && (await p.page.locator("#alignGrid button").evaluateAll((list) => list.map((b) => b.getAttribute("data-edge")).join())) === "left,hcenter,right,top,vcenter,bottom" && (await p.page.inputValue("#alignTo")) === "comp" && (await p.page.locator("#motionTools .align-card .tool-head b").innerText()) === "Выравнивание");
  t = await p.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#alignGrid button"), (b) => { const r = b.getBoundingClientRect(), s = b.querySelector("svg").getBoundingClientRect(); return r.width >= 36 && r.height >= 36 && s.width > 10 && !!b.title && b.title === b.getAttribute("aria-label"); }).join());
  check("G1 every button has a visible icon and a name", t === "true,true,true,true,true,true", t);
  await edgeBtn(p, "left");
  check("G1 nothing selected -> a hint, not an error", (await p.status()) === "Выделите слой в композиции и нажмите ещё раз." && (await p.statusKind()) === "" && p.ae.log.undo.length === 0);
  await p.page.selectOption("#alignTo", "selection");
  await p.restart();
  check("G1 the chosen target survives a restart", (await p.page.inputValue("#alignTo")) === "selection" && (await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.motion.v1")).alignTo)) === "selection");
  await p.close();
  p = await open({ noActiveComp: true });
  await motionTab(p); await edgeBtn(p, "left");
  check("G1 no open composition -> hint", /^Откройте композицию/.test(await p.status()) && (await p.statusKind()) === "");
  await p.close();

  // to the composition (1920x1080): a plain layer, 100x100 around its anchor
  clock = { time: 0 };
  L = mkLayer(clock, { rect: { left: 0, top: 0, width: 100, height: 100 }, anchor: [50, 50, 0], position: [300, 400, 0] });
  p = await open({ selectedLayers: [L] });
  await motionTab(p);
  await edgeBtn(p, "left");
  check("G2 left: the layer's left edge meets the composition's, height untouched", sameVec(P(L).value, [50, 400, 0]), P(L).value.join());
  check("G2 result reported, one undo step", (await p.status()) === "Выровнено: 1 слой.\nОтменить: Cmd/Ctrl+Z." && (await p.statusKind()) === "done" && p.ae.log.undo.join() === "begin:Sayframe: align layers,end", await p.status());
  await edgeBtn(p, "hcenter"); check("G2 horizontal centre", sameVec(P(L).value, [960, 400, 0]), P(L).value.join());
  await edgeBtn(p, "right"); check("G2 right", sameVec(P(L).value, [1870, 400, 0]), P(L).value.join());
  await edgeBtn(p, "top"); check("G2 top", sameVec(P(L).value, [1870, 50, 0]), P(L).value.join());
  await edgeBtn(p, "vcenter"); check("G2 vertical centre", sameVec(P(L).value, [1870, 540, 0]), P(L).value.join());
  await edgeBtn(p, "bottom"); check("G2 bottom", sameVec(P(L).value, [1870, 1030, 0]), P(L).value.join());
  await edgeBtn(p, "bottom");
  check("G2 already there -> says so, changes nothing", (await p.status()) === "Уже на месте: 1 слой." && (await p.statusKind()) === "" && sameVec(P(L).value, [1870, 1030, 0]));
  check("G2 anchor, scale and rotation are never touched", sameVec(A(L).value, [50, 50, 0]) && sameVec(L.props["ADBE Scale"].value, [100, 100, 100]) && L.props["ADBE Rotate Z"].value === 0 && p.ae.log.nullsAdded === 0);
  await p.close();

  // scaled, rotated, anchor off-centre: what is aligned is the box the layer really covers
  L = mkLayer(clock, { rect: { left: -20, top: 10, width: 200, height: 80 }, anchor: [0, 0, 0], position: [960, 540, 0], scale: [200, 50, 100], rotation: 90 });
  p = await open({ selectedLayers: [L] });
  await motionTab(p);
  bx = compBox(L);
  check("G3 (scene) the rotated layer covers 915..955 x 500..900", close2(bx.l, 915) && close2(bx.r, 955) && close2(bx.t, 500) && close2(bx.b, 900), JSON.stringify(bx));
  await edgeBtn(p, "left"); bx = compBox(L);
  check("G3 left with scale and rotation: visible left edge at 0, nothing moves vertically", close2(bx.l, 0) && close2(bx.t, 500) && sameVec(P(L).value, [45, 540, 0]), JSON.stringify(bx));
  await edgeBtn(p, "bottom"); bx = compBox(L);
  check("G3 bottom: visible bottom edge at 1080", close2(bx.b, 1080) && close2(bx.l, 0), JSON.stringify(bx));
  await edgeBtn(p, "hcenter"); await edgeBtn(p, "vcenter"); bx = compBox(L);
  check("G3 both centres: the covered box sits in the middle of the composition", close2((bx.l + bx.r) / 2, 960) && close2((bx.t + bx.b) / 2, 540), JSON.stringify(bx));
  await p.close();

  // to each other
  L = mkLayer(clock, { name: "a", rect: { left: 0, top: 0, width: 100, height: 100 }, position: [200, 100, 0] });               // 200..300 x 100..200
  L2 = mkLayer(clock, { name: "b", rect: { left: 0, top: 0, width: 300, height: 50 }, position: [500, 400, 0] });             // 500..800 x 400..450
  L3 = mkLayer(clock, { name: "c", rect: { left: 0, top: 0, width: 40, height: 40 }, anchor: [20, 20, 0], position: [1000, 800, 0] }); // 980..1020 x 780..820
  p = await open({ selectedLayers: [L, L2, L3] });
  await motionTab(p); await p.page.selectOption("#alignTo", "selection");
  await edgeBtn(p, "left");
  check("G4 to the selection, left: everything lines up on the leftmost layer, which stays", [L, L2, L3].every((l) => close2(compBox(l).l, 200)) && sameVec(P(L).value, [200, 100, 0]) && close2(compBox(L2).t, 400) && close2(compBox(L3).t, 780));
  check("G4 the report counts moved and untouched layers", (await p.status()) === "Выровнено: 2 слоя. Уже на месте: 1 слой.\nОтменить: Cmd/Ctrl+Z.", await p.status());
  await edgeBtn(p, "bottom");
  check("G4 bottom: everything lines up on the lowest edge", [L, L2, L3].every((l) => close2(compBox(l).b, 820)));
  P(L).setValue([200, 100, 0]); P(L2).setValue([500, 400, 0]); P(L3).setValue([1000, 800, 0]);
  await edgeBtn(p, "hcenter");
  check("G4 centre: the middle of the box around all of them (200..1020 -> 610)", [L, L2, L3].every((l) => close2((compBox(l).l + compBox(l).r) / 2, 610)), [L, L2, L3].map((l) => (compBox(l).l + compBox(l).r) / 2).join());
  await edgeBtn(p, "vcenter");
  check("G4 vertical centre: (100..820 -> 460)", [L, L2, L3].every((l) => close2((compBox(l).t + compBox(l).b) / 2, 460)));
  await p.close();
  L = mkLayer(clock, { rect: { left: 0, top: 0, width: 100, height: 100 }, position: [200, 100, 0] });
  p = await open({ selectedLayers: [L] });
  await motionTab(p); await p.page.selectOption("#alignTo", "selection"); await edgeBtn(p, "right");
  check("G4 one layer cannot be aligned to itself -> a hint, nothing moves", /выделите хотя бы два/.test(await p.status()) && (await p.statusKind()) === "" && sameVec(P(L).value, [200, 100, 0]), await p.status());
  await p.close();

  // a child of a scaled, rotated parent: the move is converted into the parent's space
  L2 = mkLayer(clock, { name: "parent", rect: { left: 0, top: 0, width: 10, height: 10 }, anchor: [0, 0, 0], position: [400, 300, 0], scale: [200, 200, 100], rotation: 90 });
  kid = mkLayer(clock, { name: "child", rect: { left: 0, top: 0, width: 50, height: 20 }, anchor: [0, 0, 0], position: [30, 10, 0] });
  kid.parent = L2;
  p = await open({ selectedLayers: [kid] });
  await motionTab(p);
  bx = compBox(kid);
  check("G5 (scene) the child covers 340..380 x 360..460", close2(bx.l, 340) && close2(bx.r, 380) && close2(bx.t, 360) && close2(bx.b, 460), JSON.stringify(bx));
  await edgeBtn(p, "left"); bx = compBox(kid);
  check("G5 child of a rotated, scaled parent: lands on the composition's left edge", close2(bx.l, 0) && close2(bx.t, 360), JSON.stringify(bx) + " " + P(kid).value.join());
  check("G5 the parent itself is not touched", sameVec(P(L2).value, [400, 300, 0]));
  await edgeBtn(p, "vcenter"); bx = compBox(kid);
  check("G5 and to the vertical centre", close2((bx.t + bx.b) / 2, 540) && close2(bx.l, 0), JSON.stringify(bx));
  await p.close();

  // layers that cannot be aligned this way, and ones After Effects refuses
  L = mkLayer(clock, { name: "3d", threeD: true, position: [300, 300, 50] });
  L2 = mkLayer(clock, { name: "cam", kind: "camera", position: [960, 540, -1000] });
  L3 = mkLayer(clock, { name: "flat", rect: { left: 0, top: 0, width: 100, height: 100 }, position: [300, 300, 0] });
  kid = mkLayer(clock, { name: "locked", locked: true, rect: { left: 0, top: 0, width: 100, height: 100 }, position: [700, 300, 0] });
  p = await open({ selectedLayers: [L, L2, L3, kid] });
  await motionTab(p); await edgeBtn(p, "left");
  check("G6 3D layers and cameras are skipped, a locked layer is reported, the rest is aligned", (await p.status()) === "Выровнено: 1 слой. Пропущено: 2 слоя (3D-слой, камера или свет). Не получилось: 1 слой (слой заблокирован?).\nОтменить: Cmd/Ctrl+Z." && sameVec(P(L3).value, [0, 300, 0]) && sameVec(P(L).value, [300, 300, 50]) && sameVec(P(L2).value, [960, 540, -1000]), await p.status());
  await p.close();
  L = mkLayer(clock, { name: "3d parent", threeD: true, position: [300, 300, 50] });
  kid = mkLayer(clock, { name: "kid", rect: { left: 0, top: 0, width: 100, height: 100 }, position: [10, 10, 0] }); kid.parent = L;
  p = await open({ selectedLayers: [kid] });
  await motionTab(p); await edgeBtn(p, "left");
  check("G6 a flat layer parented to a 3D layer is skipped too, with an explanation", (await p.status()) === "Пропущено: 1 слой (3D-слой, камера или свет)." && sameVec(P(kid).value, [10, 10, 0]) && (await p.statusKind()) === "", await p.status());
  await p.close();

  // animated position: a keyframe at the current time, like After Effects' own Align
  clock = { time: 2 };
  L = mkLayer(clock, { rect: { left: 0, top: 0, width: 100, height: 100 }, position: [300, 400, 0] });
  P(L).addKey(0, [300, 400, 0]).addKey(4, [900, 400, 0]);
  p = await open({ selectedLayers: [L], compTime: 2 });
  await motionTab(p); await edgeBtn(p, "left");
  check("G7 animated position: a key appears at the current time, the others stay", P(L).keys.length === 3 && sameVec(P(L).keys[1].value, [0, 400, 0]) && close2(P(L).keys[1].time, 2) && sameVec(P(L).keys[0].value, [300, 400, 0]) && sameVec(P(L).keys[2].value, [900, 400, 0]), JSON.stringify(P(L).keys.map((k) => [k.time, k.value])));
  await p.close();
  clock = { time: 0 };
  L = mkLayer(clock, { rect: { left: 0, top: 0, width: 100, height: 100 }, position: [300, 400, 0], separated: true });
  p = await open({ selectedLayers: [L] });
  await motionTab(p); await edgeBtn(p, "top");
  check("G7 separated X and Y: only the Y property is written", L.props["ADBE Position_1"].value === 0 && L.props["ADBE Position_0"].value === 300 && L.props["ADBE Position_0"].calls.length === 0 && L.props["ADBE Position"].calls.length === 0, L.props["ADBE Position_1"].value + " " + L.props["ADBE Position_0"].calls.length);
  await edgeBtn(p, "right");
  check("G7 and X for a horizontal move", L.props["ADBE Position_0"].value === 1820 && L.props["ADBE Position_1"].value === 0);
  check("G7 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.page.click("#tabMotion");
  await p.page.screenshot({ path: path.join(SHOTS, "23-tab-motion-align.png") });
  t = JSON.parse(await hostCall(p, 'sayframeHost.align("sideways","comp")'));
  check("G8 the host refuses an unknown edge", t.ok === false && t.error === "BAD_ALIGN_EDGE" && L.props["ADBE Position_0"].value === 1820, JSON.stringify(t));
  await p.close();

  console.log("\n=== updates ===");
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const U = "https://raw.example.com/acme/sayframe/main/version.json";
  const BASE = "https://raw.example.com/acme/sayframe/main/Sayframe/";
  const CUR = /var VERSION = "([0-9.]+)"/.exec(fs.readFileSync(path.join(EXT, "js/panel.js"), "utf8"))[1];
  const REL = ["CSXS/manifest.xml", "css/panel.css", "index.html", "js/panel.js", "jsx/host.jsx"];
  // A "next release": same files, version bumped, plus a brand-new file in a new folder.
  function nextRelease(ver) {
    const files = {};
    for (const r of REL) {
      let b = fs.readFileSync(path.join(EXT, r));
      if (r === "js/panel.js") b = Buffer.from(b.toString("utf8").replace('var VERSION = "' + CUR + '"', 'var VERSION = "' + ver + '"'), "utf8");
      if (r === "jsx/host.jsx") b = Buffer.concat([b, Buffer.from("\n// next\n")]);
      files[r] = b;
    }
    files["img/new.txt"] = Buffer.from("новый файл", "utf8");
    const remote = {};
    const list = Object.keys(files).map((r) => { remote[BASE + r] = files[r]; return { path: r, sha256: sha(files[r]), size: files[r].length }; });
    const info = { version: ver, notes: ["Новая функция", "<img src=x onerror=window.__xss=1>", "Исправления"], files: list, download: "downloads/Install-Sayframe-Mac.zip" };
    return { files, remote, info };
  }
  const barVisible = (p) => p.page.locator("#updateBar").isVisible();
  const waitBar = (p) => p.page.waitForSelector("#updateBar:not([hidden])", { timeout: 8000 });
  const settle = (p) => p.page.waitForTimeout(1700);
  const sameAsShipped = (p) => REL.every((r) => fs.readFileSync(path.join(p.extDir, r)).equals(fs.readFileSync(path.join(EXT, r))));
  const waitMsg = (p, re) => p.page.waitForFunction((src) => new RegExp(src).test(document.getElementById("updateStatus").textContent), re.source, { timeout: 8000 });
  let rel;

  p = await open({});
  await settle(p);
  check("U1 no update address -> no request, no banner", p.net.gets.length === 0 && !(await barVisible(p)));
  await p.page.click("#settingsBtn");
  check("U1 settings show the version", (await p.page.locator("#versionText").innerText()) === "Sayframe " + CUR);
  await p.page.click("#checkUpdate");
  check("U1 manual check says it is not configured", /не настроена/.test(await p.page.locator("#updateHint").innerText()));
  await p.close();

  p = await open({ updateUrl: U, remote: { [U]: { version: CUR, files: [] } } });
  await settle(p);
  check("U2 same version -> one request, no banner", p.net.gets.length === 1 && p.net.gets[0].indexOf(U + "?t=") === 0 && !(await barVisible(p)));
  await p.page.click("#settingsBtn"); await p.page.click("#checkUpdate");
  await p.page.waitForFunction(() => /последняя/.test(document.getElementById("updateHint").textContent));
  check("U2 manual check goes to the server again and reports up to date", p.net.gets.length === 2);
  await p.close();

  p = await open({ updateUrl: U, remote: { [U]: { version: "0.9.0" } } });
  await settle(p);
  check("U3 older version on server -> no banner", !(await barVisible(p)) && p.errors.length === 0);
  await p.close();
  for (const bad of ["not json", JSON.stringify({ version: "latest" }), "[]", "null"]) {
    p = await open({ updateUrl: U, remote: { [U]: bad } });
    await settle(p);
    check("U4 broken version file (" + bad.slice(0, 12) + ") -> silent", !(await barVisible(p)) && p.errors.length === 0 && !/обновл/i.test(await p.status()));
    await p.close();
  }
  p = await open({ updateUrl: U, offlineUpdate: true });
  await settle(p);
  check("U5 offline -> silent at start-up", !(await barVisible(p)) && p.errors.length === 0 && (await p.statusKind()) !== "error");
  await p.page.click("#settingsBtn"); await p.page.click("#checkUpdate");
  await p.page.waitForFunction(() => /Не удалось/.test(document.getElementById("updateHint").textContent));
  check("U5 offline -> manual check says so", (await p.page.locator("#updateHint").getAttribute("class")) === "hint bad");
  await p.close();

  rel = nextRelease("9.9.9");
  p = await open({ updateUrl: U, ownExt: true, remote: Object.assign({ [U]: rel.info }, rel.remote), replies: [msg("Ок.\n```javascript\napp.__ran('still works');\n```")] });
  await waitBar(p);
  check("U6 banner announces the version", (await p.page.locator("#updateTitle").innerText()) === "Доступна версия 9.9.9" && (await p.page.locator("#updateNow").innerText()) === "Обновить");
  t = await p.page.evaluate(() => [document.querySelectorAll("#updateNotes li").length, document.querySelectorAll("#updateNotes img").length, window.__xss]);
  check("U6 notes are shown as plain text", t[0] === 3 && t[1] === 0 && t[2] === undefined, t.join());
  t = await p.page.evaluate(() => { const rgb = (el, prop) => getComputedStyle(el)[prop].match(/\d+(\.\d+)?/g).slice(0, 3).map(Number); const green = (c) => c[1] > c[0] + 40 && c[1] > c[2] + 40; const bar = document.getElementById("updateBar"), btn = document.getElementById("updateNow");
    return { border: green(rgb(bar, "borderTopColor")), fill: green(rgb(bar, "backgroundColor")), button: /rgb\(70, 214, 132\)/.test(getComputedStyle(btn).backgroundImage), title: green(rgb(document.getElementById("updateTitle"), "color")), run: /rgb\(70, 214, 132\)/.test(getComputedStyle(document.getElementById("runBtn")).backgroundImage) }; });
  check("U6 update banner is green, the Run button keeps the accent colour", t.border && t.fill && t.button && t.title && !t.run, JSON.stringify(t));
  await p.page.screenshot({ path: path.join(SHOTS, "12-update-banner.png") });
  await p.tab("tools");
  await p.page.evaluate(() => { document.documentElement.style.setProperty("--accent", "#ff7ac3"); document.documentElement.style.setProperty("--accent-rgb", "255, 122, 195"); });
  t = await p.page.evaluate(() => getComputedStyle(document.getElementById("updateBar")).borderTopColor.match(/\d+/g).slice(0, 3).join());
  check("U6 banner stays green with another accent colour", t === "70,214,132", t);
  check("U6 banner stays visible on the Tools tab", (await barVisible(p)) && (await p.page.locator("#pasteBtn").isVisible()));
  await p.tab("claude");
  t = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("U6 banner does not overflow", t <= 0, t);
  await p.page.click("#updateLater");
  check("U6 'later' hides the banner", !(await barVisible(p)));
  await p.page.click("#settingsBtn"); await p.page.click("#checkUpdate");
  await p.page.waitForFunction(() => /Доступна версия 9\.9\.9/.test(document.getElementById("updateHint").textContent));
  await p.page.click("#settingsClose");
  check("U6 manual check brings the banner back", await barVisible(p));
  check("U6 nothing downloaded before the click", p.net.downloads.length === 0 && sameAsShipped(p));
  await p.page.click("#updateNow");
  await p.page.waitForFunction((v) => document.getElementById("versionText").textContent === "Sayframe " + v, "9.9.9", { timeout: 15000 });
  check("U7 panel restarted on the new version", p.net.reloads === 1 && (await p.page.locator("#versionText").innerText()) === "Sayframe 9.9.9");
  check("U7 every file replaced with the verified download", Object.keys(rel.files).every((r) => fs.readFileSync(path.join(p.extDir, r)).equals(rel.files[r])));
  check("U7 files fetched from the folder next to version.json", p.net.downloads.length === 6 && p.net.downloads.every((u) => u.indexOf(BASE) === 0 && /\?v=[0-9a-f]{12}$/.test(u)), p.net.downloads[0]);
  check("U7 host.jsx re-read by After Effects", p.ae.log.scripts.some((x) => x.indexOf("$.evalFile(") === 0 && x.indexOf("/jsx/host.jsx") > 0 && x.indexOf(p.extDir) > 0));
  check("U7 says it was updated, once", (await p.status()) === "Sayframe обновлён до версии 9.9.9." && (await p.statusKind()) === "done");
  await settle(p);
  check("U7 no banner after updating", !(await barVisible(p)));
  check("U7 no temp files left", fs.readdirSync(p.tmpDir).filter((f) => /^sayframe-update-/.test(f)).every((d) => fs.readdirSync(path.join(p.tmpDir, d)).length === 0) && !fs.existsSync(path.join(p.extDir, ".sayframe-write-test")));
  await p.run("задача");
  check("U7 updated panel still runs tasks", p.ae.log.ran.join() === "still works" && p.errors.length === 0, p.errors.join(" | "));
  await p.page.reload(); await settle(p);
  check("U7 'updated' message not repeated on next start", !/обновлён/.test(await p.status()));
  await p.close();

  rel = nextRelease("9.9.9");
  rel.remote[BASE + "js/panel.js"] = Buffer.from("alert('tampered')");
  p = await open({ updateUrl: U, ownExt: true, remote: Object.assign({ [U]: rel.info }, rel.remote) });
  await waitBar(p); await p.page.click("#updateNow"); await waitMsg(p, /ещё не обновились/);
  check("U8 checksum mismatch -> nothing installed", sameAsShipped(p) && !fs.existsSync(path.join(p.extDir, "img")) && p.net.reloads === undefined);
  check("U8 panel usable again, installer link offered", !(await p.page.locator("#runBtn").isDisabled()) && !(await p.page.locator("#updateNow").isDisabled()) && (await p.page.locator("#updateDownload").isVisible()));
  await p.page.screenshot({ path: path.join(SHOTS, "13-update-failed.png") });
  await p.page.click("#updateDownload");
  t = await p.page.evaluate(() => window.__opened);
  check("U8 installer link resolves next to version.json", t.length === 1 && t[0] === "https://raw.example.com/acme/sayframe/main/downloads/Install-Sayframe-Mac.zip", t.join());
  await p.close();

  rel = nextRelease("9.9.9"); delete rel.remote[BASE + "css/panel.css"];
  p = await open({ updateUrl: U, ownExt: true, remote: Object.assign({ [U]: rel.info }, rel.remote) });
  await waitBar(p); await p.page.click("#updateNow"); await waitMsg(p, /Не удалось скачать/);
  check("U9 missing file on server -> nothing installed", sameAsShipped(p));
  await p.close();

  rel = nextRelease("9.9.9");
  p = await open({ updateUrl: U, ownExt: true, signedExt: true, remote: Object.assign({ [U]: rel.info }, rel.remote) });
  await waitBar(p); await p.page.click("#updateNow"); await waitMsg(p, /подписанного пакета/);
  check("U10 signed copy is never modified", sameAsShipped(p) && p.net.downloads.length === 0);
  await p.close();

  p = await open({ updateUrl: U, ownExt: true, readOnlyExt: true, remote: Object.assign({ [U]: rel.info }, rel.remote) });
  await waitBar(p); await p.page.click("#updateNow"); await waitMsg(p, /Нет прав на запись/);
  check("U11 read-only folder -> stops before downloading", sameAsShipped(p) && p.net.downloads.length === 0);
  await p.close();

  p = await open({ updateUrl: U, ownExt: true, failMoveAt: 2, remote: Object.assign({ [U]: rel.info }, rel.remote) });
  await waitBar(p); await p.page.click("#updateNow"); await waitMsg(p, /не полностью/);
  check("U12 failure while replacing files is reported, installer offered", (await p.page.locator("#updateDownload").isVisible()) && p.net.reloads === undefined);
  await p.close();

  for (const evil of ["../evil.js", "/etc/evil", "js/../../evil.js", ".hidden", "js\\evil.js", "C:/evil.js", ""]) {
    rel = nextRelease("9.9.9");
    rel.info.files.push({ path: evil, sha256: sha(Buffer.from("x")) });
    p = await open({ updateUrl: U, ownExt: true, remote: Object.assign({ [U]: rel.info }, rel.remote) });
    await waitBar(p); await p.page.click("#updateNow"); await waitMsg(p, /повреждено/);
    check("U13 unsafe path " + JSON.stringify(evil) + " rejected before any download", sameAsShipped(p) && p.net.downloads.length === 0 && !fs.existsSync(path.join(p.tmpDir, "evil.js")));
    await p.close();
  }
  rel = nextRelease("9.9.9"); rel.info.files[0].sha256 = "zz";
  p = await open({ updateUrl: U, ownExt: true, remote: Object.assign({ [U]: rel.info }, rel.remote) });
  await waitBar(p); await p.page.click("#updateNow"); await waitMsg(p, /повреждено/);
  check("U13 bad checksum format rejected", sameAsShipped(p) && p.net.downloads.length === 0);
  await p.close();
  rel = nextRelease("9.9.9"); rel.info.base = "http://insecure.example.com/Sayframe/";
  p = await open({ updateUrl: U, ownExt: true, remote: Object.assign({ [U]: rel.info }, rel.remote) });
  await waitBar(p); await p.page.click("#updateNow"); await waitMsg(p, /повреждено/);
  check("U13 non-https file address rejected", sameAsShipped(p) && p.net.downloads.length === 0);
  await p.close();

  // moving to another server
  const NEW = "https://my-own-server.example.org/sayframe/version.json";
  rel = nextRelease("9.9.9");
  const moved = {}; for (const r of Object.keys(rel.files)) moved["https://my-own-server.example.org/sayframe/Sayframe/" + r] = rel.files[r];
  p = await open({ updateUrl: U, ownExt: true, remote: Object.assign({ [U]: { version: CUR, moved: NEW }, [NEW]: rel.info }, moved) });
  await waitBar(p);
  t = await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.update.v1")));
  check("U14 'moved' is followed and remembered", p.net.gets.length === 2 && p.net.gets[1].indexOf(NEW) === 0 && t.url === NEW && t.base === U, JSON.stringify(t).slice(0, 120));
  await p.page.click("#updateNow");
  await p.page.waitForFunction(() => document.getElementById("versionText").textContent === "Sayframe 9.9.9", null, { timeout: 15000 });
  check("U14 files come from the new server", p.net.downloads.length === 6 && p.net.downloads.every((u) => u.indexOf("https://my-own-server.example.org/sayframe/Sayframe/") === 0));
  await p.close();
  p = await open({ updateUrl: U, remote: { [U]: { version: "9.9.9", moved: "http://plain.example.com/version.json" } } });
  await waitBar(p);
  check("U14 non-https 'moved' is ignored", p.net.gets.length === 1);
  await p.close();
  p = await open({ updateUrl: U, remote: { [U]: { version: "9.9.9", moved: NEW }, [NEW]: { version: "9.9.9", moved: U } } });
  await settle(p);
  check("U14 a redirect loop ends", p.net.gets.length <= 4 && p.errors.length === 0, p.net.gets.length);
  await p.close();
  p = await open({ updateUrl: U, updateState: { base: U, url: NEW, lastCheck: 0 }, remote: { [U]: { version: "9.9.9" } } });
  await waitBar(p);
  check("U14 dead remembered address falls back to the built-in one", p.net.gets.length === 2 && p.net.gets[0].indexOf(NEW) === 0 && p.net.gets[1].indexOf(U) === 0);
  await p.close();
  p = await open({ updateUrl: U, updateState: { base: "https://old.example.com/version.json", url: NEW, lastCheck: Date.now(), latest: { info: { version: "9.9.9" }, url: NEW } }, remote: { [U]: { version: CUR } } });
  await settle(p);
  check("U14 state saved for another built-in address is discarded", p.net.gets.length === 1 && p.net.gets[0].indexOf(U) === 0 && !(await barVisible(p)));
  await p.close();

  // no file list: only a link to the installer
  p = await open({ updateUrl: U, remote: { [U]: { version: "9.9.9", notes: "Одна строка", download: "https://example.com/get/Install.zip" } } });
  await waitBar(p);
  check("U15 without a file list the button offers a download", (await p.page.locator("#updateNow").innerText()) === "Скачать обновление" && (await p.page.locator("#updateNotes li").count()) === 1);
  await p.page.click("#updateNow");
  t = await p.page.evaluate(() => window.__opened);
  check("U15 the installer page opens in the browser", t.join() === "https://example.com/get/Install.zip");
  await p.close();
  p = await open({ updateUrl: U, remote: { [U]: { version: "9.9.9", download: "javascript:alert(1)" } } });
  await waitBar(p); await p.page.click("#updateNow");
  t = await p.page.evaluate(() => window.__opened);
  check("U15 non-https download link is never opened", t.length === 0 && /недоступна/.test(await p.page.locator("#updateStatus").innerText()));
  await p.close();

  // throttling
  p = await open({ updateUrl: U, updateState: { base: U, lastCheck: Date.now() - 60000, latest: { info: { version: "9.9.9", notes: ["из кэша"] }, url: U } }, remote: { [U]: { version: CUR } } });
  await waitBar(p);
  check("U16 recent check -> no request, banner from the saved answer", p.net.gets.length === 0 && (await p.page.locator("#updateNotes li").innerText()) === "из кэша");
  await p.close();
  p = await open({ updateUrl: U, updateState: { base: U, lastCheck: Date.now() - 7 * 3600 * 1000, latest: { info: { version: "9.9.9" }, url: U } }, remote: { [U]: { version: CUR } } });
  await settle(p);
  check("U16 old check -> asks the server again", p.net.gets.length === 1 && !(await barVisible(p)));
  await p.close();
  p = await open({ updateUrl: U, width: 300, height: 620, remote: { [U]: { version: "9.9.9", notes: ["Длинное описание новой возможности, которое не помещается в одну строку узкой панели", "Второе"], files: [{ path: "index.html", sha256: sha(Buffer.from("x")) }] } } });
  await waitBar(p);
  t = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("U17 banner fits a 300px panel", t <= 0, t);
  await p.page.screenshot({ path: path.join(SHOTS, "14-update-narrow.png") });
  await p.close();
  // The real release tool: make the next release in a scratch copy of the project and let the panel install it.
  {
    const { spawnSync } = require("child_process");
    const repo = path.join(__dirname, "..");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sayframe-release-"));
    for (const d of ["Sayframe", "installer", "tools", "version.json"]) fs.cpSync(path.join(repo, d), path.join(scratch, d), { recursive: true });
    const made = spawnSync("python3", ["tools/release.py", "99.0.0", "Проверочный выпуск"], { cwd: scratch, encoding: "utf8" });
    check("U18 release tool builds the next version", made.status === 0 && fs.existsSync(path.join(scratch, "downloads/Install-Sayframe-Mac.zip")), made.stdout + made.stderr);
    const info = JSON.parse(fs.readFileSync(path.join(scratch, "version.json"), "utf8"));
    const built = { [U]: info };
    for (const f of info.files) built[BASE + f.path] = fs.readFileSync(path.join(scratch, "Sayframe", f.path));
    p = await open({ updateUrl: U, ownExt: true, remote: built });
    await waitBar(p);
    check("U18 its version.json is announced by the panel", (await p.page.locator("#updateTitle").innerText()) === "Доступна версия 99.0.0" && (await p.page.locator("#updateNotes li").innerText()) === "Проверочный выпуск" && (await p.page.locator("#updateNow").innerText()) === "Обновить");
    await p.page.click("#updateNow");
    await p.page.waitForFunction(() => document.getElementById("versionText").textContent === "Sayframe 99.0.0", null, { timeout: 15000 });
    check("U18 the panel installs exactly the released files", info.files.every((f) => fs.readFileSync(path.join(p.extDir, f.path)).equals(fs.readFileSync(path.join(scratch, "Sayframe", f.path)))) && /ExtensionBundleVersion="99\.0\.0"/.test(fs.readFileSync(path.join(p.extDir, "CSXS/manifest.xml"), "utf8")) && p.errors.length === 0, p.errors.join(" | "));
    await p.close();
    const again = spawnSync("python3", ["tools/release.py", "99.0.0", "x"], { cwd: scratch, encoding: "utf8" });
    check("U18 release tool refuses to reuse a version number", again.status === 1 && /должна быть больше/.test(again.stdout));
    fs.appendFileSync(path.join(scratch, "Sayframe/css/panel.css"), "\n/* edit */\n");
    const stale = spawnSync("python3", ["tools/release.py", "--check"], { cwd: scratch, encoding: "utf8" });
    check("U18 --check notices panel files edited after a release", stale.status === 1 && /css\/panel\.css/.test(stale.stdout), stale.stdout);
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  p = await open({ width: 380, height: 760 });
  await p.page.click("#settingsBtn");
  await p.page.evaluate(() => { const s = document.getElementById("settingsSheet"); s.scrollTop = s.scrollHeight; });
  await p.page.screenshot({ path: path.join(SHOTS, "15-settings-version.png") });
  await p.close();

  await browser.close();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS CRASH:", e); process.exit(2); });
