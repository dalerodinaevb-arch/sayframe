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
function FootageItem() {} function FileSource() {} function PlaceholderSource() {}
const FX_EFFECTS = [
  { displayName: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2", category: "Blur & Sharpen" },
  { displayName: "Fast Box Blur", matchName: "ADBE Box Blur2", category: "Blur & Sharpen" },
  { displayName: "Directional Blur", matchName: "ADBE Motion Blur", category: "Blur & Sharpen" },
  { displayName: "Glow", matchName: "ADBE Glo2", category: "Stylize" },
  { displayName: "Curves", matchName: "ADBE CurvesCustom", category: "Color Correction" },
  { displayName: "Fill", matchName: "ADBE Fill", category: "Generate" },
  { displayName: "Drop Shadow", matchName: "ADBE Drop Shadow", category: "Perspective" },
  { displayName: "", matchName: "ADBE Hidden", category: "" }
];
// A layer for FX Console: remembers the effects and presets put on it; cameras take no effects.
function mkFxLayer(name, kind) {
  const L = Object.assign(kind === "camera" ? new CameraLayer() : {}, { name, effects: [], presets: [] });
  L.property = (n) => (n === "ADBE Effect Parade" && kind !== "camera" ? { canAddProperty: (m) => m !== "ADBE Nope", addProperty: (m) => { L.effects.push(m); return {}; } } : null);
  L.applyPreset = (f) => { if (kind === "camera") throw new Error("cannot"); L.presets.push(f.fsName); };
  return L;
}

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
  this.marker = !!opts.marker; this.isSpatial = !!opts.spatial; this.sticky = !!opts.sticky;
}
Prop.prototype = {
  get numKeys() { return this.keys.length; },
  get value() { return this.keys.length ? this.valueAtTime(this.clock.time, true) : cloneValue(this._v); },
  get expression() { return this._expression; },
  set expression(x) { this._expression = x; },
  get selectedKeys() { const r = []; this.keys.forEach((k, i) => { if (k.selected) r.push(i + 1); }); return r; },
  _check(v) {
    if (this.locked) throw new Error("After Effects error: layer is locked");
    if (this.marker) return;
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
    if (this.sticky && this._gone && Math.abs(this._gone.time - t) > 1e-9) throw new Error("After Effects error: cannot add a keyframe here");
    const hit = this.keys.find((k) => Math.abs(k.time - t) < 1e-9);
    if (hit) { hit.value = cloneValue(v); return; }
    this.keys.push(this._key(t, v)); this.keys.sort((a, b) => a.time - b.time);
  },
  setSelectedAtKey(i, on) { this.keys[i - 1].selected = !!on; },
  keySelected(i) { return this.keys[i - 1].selected; },
  // A key removed from a "sticky" property cannot be created anywhere but at its old time (a property After Effects is picky about).
  removeKey(i) { if (this.locked) throw new Error("After Effects error: layer is locked"); if (!this.keys[i - 1]) throw new Error("no such key"); this.calls.push("removeKey"); this._gone = this.keys.splice(i - 1, 1)[0]; },
  nearestKeyIndex(t) { if (!this.keys.length) throw new Error("no keys"); let best = 0; this.keys.forEach((k, n) => { if (Math.abs(k.time - t) < Math.abs(this.keys[best].time - t)) best = n; }); return best + 1; },
  keyInSpatialTangent(i) { return cloneValue(this.keys[i - 1].inTan || [0, 0, 0]); },
  keyOutSpatialTangent(i) { return cloneValue(this.keys[i - 1].outTan || [0, 0, 0]); },
  keySpatialContinuous(i) { return !!this.keys[i - 1].sCont; }, keySpatialAutoBezier(i) { return !!this.keys[i - 1].sAuto; }, keyRoving(i) { return !!this.keys[i - 1].roving; },
  setSpatialTangentsAtKey(i, a, b) { this.keys[i - 1].inTan = cloneValue(a); this.keys[i - 1].outTan = cloneValue(b); },
  setSpatialContinuousAtKey(i, on) { this.keys[i - 1].sCont = !!on; }, setSpatialAutoBezierAtKey(i, on) { this.keys[i - 1].sAuto = !!on; }, setRovingAtKey(i, on) { this.keys[i - 1].roving = !!on; },
  keyLabel(i) { return this.keys[i - 1].label || 0; }, setLabelAtKey(i, n) { this.keys[i - 1].label = n; },
  setValueAtKey(i, v) { this._check(v); this.calls.push("setValueAtKey"); this.keys[i - 1].value = cloneValue(v); },
  keyValue(i) { return cloneValue(this.keys[i - 1].value); },
  keyTime(i) { return this.keys[i - 1].time; },
  _ease(speed, influence) { const r = []; for (let i = 0; i < this.easeDims; i++) r.push(new KeyframeEase(speed, influence)); return r; },
  _key(t, v, o) { o = o || {}; return { time: t, value: cloneValue(v), selected: !!o.selected, inType: o.inType || KIT.LINEAR, outType: o.outType || KIT.LINEAR, inEase: this._ease(11, 16.67), outEase: this._ease(22, 16.67) }; },
  addKey(t, v, o) { this.keys.push(this._key(t, v, o)); this.keys.sort((a, b) => a.time - b.time); return this; },
  keyInTemporalEase(i) { if (this.marker) throw new Error("After Effects error: markers have no easing"); return this.keys[i - 1].inEase.slice(); },
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
    if (this.marker) throw new Error("After Effects error: markers have no easing");
    for (const list of [a, b]) {
      if (!list || list.length !== this.easeDims) throw new Error("After Effects error: wrong number of KeyframeEase objects");
      for (let n = 0; n < list.length; n++) if (!(list[n] instanceof KeyframeEase)) throw new Error("After Effects error: not a KeyframeEase");
    }
    this.keys[i - 1].inEase = Array.prototype.slice.call(a); this.keys[i - 1].outEase = Array.prototype.slice.call(b);
    if (this.deselectsOnEase) this.keys[i - 1].selected = false;
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
  // Timing, for the "shift in time" tool: a marker track, an effect group with one more property, and the layer's edges.
  props["ADBE Marker"] = new Prop(0, clock, Object.assign({ marker: true }, lock));
  props["Slider"] = new Prop(0, clock, lock);
  const trNames = ["ADBE Anchor Point", "ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Position_2", "ADBE Scale", "ADBE Rotate Z"];
  const group = (names) => ({ propertyType: 6214, numProperties: names.length, property: (m) => (typeof m === "number" ? props[names[m - 1]] : props[m]) || null });
  const transform = group(trNames), effects = { propertyType: 6213, numProperties: 1, property: () => group(["Slider"]) };
  const time = { inPoint: o.inPoint || 0, outPoint: o.outPoint === undefined ? 10 : o.outPoint, startTime: o.startTime || 0 };
  const guard = () => { if (lock.locked) throw new Error("After Effects error: layer is locked"); };
  Object.defineProperties(L, {
    // As in After Effects: the layer keeps its duration when the in point is set, so the out point moves with it.
    inPoint: { enumerable: true, get: () => time.inPoint, set(v) { guard(); time.outPoint += v - time.inPoint; time.inPoint = v; L.edgeSets.push("in"); } },
    outPoint: { enumerable: true, get: () => time.outPoint, set(v) { guard(); time.outPoint = v; L.edgeSets.push("out"); } },
    startTime: { enumerable: true, get: () => time.startTime, set(v) { guard(); const d = v - time.startTime; time.startTime = v; time.inPoint += d; time.outPoint += d; Object.keys(props).forEach((n) => props[n].keys.forEach((k) => { k.time += d; })); } }
  });
  Object.assign(L, { name: o.name || "Слой", index: o.index || 1, selected: true, threeDLayer: !!o.threeD, props, rect: o.rect || { left: 0, top: 0, width: 100, height: 100 }, stretch: 100, edgeSets: [],
    numProperties: 3,
    property(n) { return n === 1 || n === "ADBE Marker" ? props["ADBE Marker"] : n === 2 || n === "ADBE Effect Parade" ? effects : n === 3 || n === "ADBE Transform Group" ? transform : null; },
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
// --- layers with expressions, for the expression helper: groups, properties, errors like After Effects gives
// An expression "fails" when it is not valid JavaScript or mentions BAD (the error text then names the line).
function exprError(expr) {
  if (/BAD/.test(expr)) return "Error: ReferenceError: BAD is not defined (line 1)";
  try { new Function(expr); return ""; } catch (e) { return "Error: SyntaxError: " + e.message; }
}
function mkEProp(name, matchName, value, o) {
  o = o || {};
  const p = { name, matchName, propertyType: 6212, canSetExpression: o.canSetExpression !== false, value, numKeys: o.keys || 0,
    expressionEnabled: true, expressionError: "", _expr: "", sets: [] };
  Object.defineProperty(p, "expression", { get: () => p._expr, set(v) { if (o.locked) throw new Error("After Effects error: layer is locked"); p._expr = v; p.sets.push(v); p.expressionError = v ? exprError(v) : ""; } });
  if (o.expression) { p._expr = o.expression; p.expressionError = exprError(o.expression); p.expressionEnabled = o.enabled !== false; }
  return p;
}
function mkEGroup(name, matchName, kids) {
  const g = { name, matchName, propertyType: 6214, numProperties: kids.length, property: (i) => (typeof i === "number" ? kids[i - 1] : kids.find((k) => k.name === i || k.matchName === i)) || null };
  kids.forEach((k, i) => { k.parentProperty = g; k.propertyIndex = i + 1; });
  return g;
}
function mkELayer(index, name, groups) {
  const L = { name, index, propertyDepth: 0, numProperties: groups.length, property: (i) => (typeof i === "number" ? groups[i - 1] : groups.find((k) => k.name === i)) || null };
  groups.forEach((g, i) => { g.parentProperty = L; g.propertyIndex = i + 1; });
  // depth: groups are 1 below the layer, their children 2
  const setDepth = (node, d) => { node.propertyDepth = d; if (node.numProperties && node !== L) for (let k = 1; k <= node.numProperties; k++) setDepth(node.property(k), d + 1); };
  groups.forEach((g) => setDepth(g, 1));
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
  const comp = Object.assign(new CompItem(), { name: "Тест", width: 1920, height: 1080, duration: 10, frameRate: 30, frameDuration: 1 / 30, time: opts.compTime || 0, numLayers: opts.exprLayers ? opts.exprLayers.length : 2, workAreaStart: 0, workAreaDuration: 5,
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
    layer(i) { if (opts.exprLayers) return opts.exprLayers[i - 1] || null; const l = i === 1 ? new TextLayer() : {}; return Object.assign(l, { name: i === 1 ? "Заголовок" : "Фон", selected: i === 1, enabled: true, threeDLayer: false, parent: null, inPoint: 0, outPoint: 10, index: i, source: i === 2 ? { mainSource: new SolidSource() } : null }); } });
  const projItems = [comp];
  log.moves = [];
  // opts.org: a messy project for "Organize". Folders are listed before what goes into them.
  if (opts.org) {
    const folders = {}; let id = 100;
    const track = (it, parent) => {
      it.id = ++id; let pf = parent ? folders[parent] : rootFolder;
      Object.defineProperty(it, "parentFolder", { configurable: true, get: () => pf, set(v) { pf = v; log.moves.push(it.name + " -> " + v.name); } });
      projItems.push(it); return it;
    };
    const byName = (n) => projItems.find((x) => x.name === n);
    opts.org.forEach((o) => {
      if (o.folder) { folders[o.folder] = track(new FolderItem(o.folder), o.in); return; }
      if (o.comp) {
        const c = Object.assign(new CompItem(), { name: o.comp, numLayers: (o.layers || []).length, layer: (i) => ({ index: i, source: o.layers[i - 1] ? byName(o.layers[i - 1]) || null : null }) });
        track(c, o.in); return;
      }
      const src = o.solid ? new SolidSource() : o.placeholder ? new PlaceholderSource()
        : Object.assign(new FileSource(), { file: o.missing ? null : new File("/media/" + o.file), missingFootagePath: o.missing ? "/media/" + o.file : "", isStill: !!o.still });
      if (o.solid || o.placeholder) src.isStill = true;
      track(Object.assign(new FootageItem(), { name: o.name, mainSource: src, hasVideo: o.video !== undefined ? o.video : !o.audio, hasAudio: !!o.audio, duration: o.still || o.solid ? 0 : (o.duration !== undefined ? o.duration : 5), footageMissing: !!o.missing }), o.in);
    });
  }
  const project = { get numItems() { return projItems.length; }, activeItem: opts.noActiveComp ? null : comp, item(i) { return projItems[i - 1]; },
    file: opts.projectFile ? new File(opts.projectFile) : null, rootFolder,
    importFile(io) {
      if (opts.importThrows) throw new Error("unsupported file");
      log.imports.push(io.file.fsName);
      const it = Object.assign({ name: path.basename(io.file.fsName), parentFolder: rootFolder, remove() { log.removed.push("item"); } }, opts.footage);
      project.activeItem = it;
      return it;
    },
    items: { addFolder(name) { const f = new FolderItem(name); f.id = 900 + log.bins.length; projItems.push(f); log.bins.push(name); return f; },
      addComp(name, w, h, par, dur, fps) {
        const c = Object.assign(new CompItem(), { name, width: w, height: h, duration: dur, frameRate: fps, saved: [], scaleSet: null,
          openInViewer() { log.opened++; project.activeItem = c; },
          layers: { add(it) { c.added = it; return { property() { return { property() { return { setValue(v) { c.scaleSet = v; } }; } }; } }; } },
          saveFrameToPng(t, file) { c.saved.push(t); fs.writeFileSync(file.fsName, fakePng(c.saved.length - 1)); },
          remove() { log.removed.push("comp"); } });
        log.refComps.push(c); return c;
      } } };
  // A small After Effects install on disk for FX Console: shipped presets beside the app, user presets in Documents.
  function Folder(p) { this.fsName = p; this.name = encodeURI(path.basename(p)); }
  Object.defineProperty(Folder.prototype, "exists", { get() { return fs.existsSync(this.fsName) && fs.statSync(this.fsName).isDirectory(); } });
  Object.defineProperty(Folder.prototype, "parent", { get() { return new Folder(path.dirname(this.fsName)); } });
  Folder.prototype.getFiles = function () { return fs.readdirSync(this.fsName).sort().map((n) => { const f = path.join(this.fsName, n); return fs.statSync(f).isDirectory() ? new Folder(f) : new File(f); }); };
  const aeRoot = path.join(tmpDir, "Applications", "Adobe After Effects 2026");
  const write = (base, files) => Object.keys(files || {}).forEach((rel) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, files[rel]); });
  fs.mkdirSync(path.join(aeRoot, "Adobe After Effects 2026.app"), { recursive: true });
  write(path.join(aeRoot, "Presets"), opts.presets);
  write(path.join(tmpDir, "Documents", "Adobe", "After Effects 2026", "User Presets"), opts.userPresets);
  Folder.appPackage = new Folder(path.join(aeRoot, "Adobe After Effects 2026.app"));
  Folder.myDocuments = new Folder(path.join(tmpDir, "Documents"));
  log.snaps = [];
  comp.saveFrameToPng = function (t, file) { log.snaps.push({ t, path: file.fsName }); if (!opts.snapFails) fs.writeFileSync(file.fsName, fakePng(0)); };
  const app = { version: "26.0", project, effects: opts.effects || FX_EFFECTS,
    preferences: { getPrefAsLong: () => (opts.fileAccessOff ? 0 : 1) },
    beginUndoGroup: (n) => log.undo.push("begin:" + n), endUndoGroup: () => log.undo.push("end"), __ran: (x) => log.ran.push(x) };
  const ctx = vm.createContext({ app, File, Folder, FolderItem, FootageItem, FileSource, PlaceholderSource, ImportOptions, CompItem, TextLayer, ShapeLayer, CameraLayer, LightLayer, SolidSource, $: { sleep() {} },
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

    await page.exposeFunction("__hostEval", (script) => opts.hostDelayMs ? new Promise((done) => setTimeout(() => done(ae.evalScript(script)), opts.hostDelayMs)) : ae.evalScript(script));
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
        case "fetchUrl": {
          // opts.web: { url: { type, body } | { status } | { error } } — what the internet answers.
          const [url, base] = args;
          net.fetches = net.fetches || [];
          net.fetches.push(url);
          const r = (opts.web || {})[url];
          if (!r) throw new Error("getaddrinfo ENOTFOUND " + url.replace(/^https?:\/\/([^\/]+).*$/, "$1"));
          if (r.error) throw new Error(r.error);
          if (r.status && r.status !== 200) return { status: r.status, contentType: "text/html", finalUrl: url };
          const type = r.type || "";
          if (/^text\/html/.test(type)) return { status: 200, contentType: type, finalUrl: r.finalUrl || url, text: r.body };
          const ext = { "image/png": ".png", "image/jpeg": ".jpg", "video/mp4": ".mp4", "image/gif": ".gif" }[type.split(";")[0]] || ((/\.(png|jpg|gif|mp4|mov)$/i.exec(new URL(url).pathname) || [""])[0]);
          if (!ext) return { status: 200, contentType: type, finalUrl: url };
          const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body || "x"));
          fs.writeFileSync(base + ext, body);
          net.saved = (net.saved || []).concat([base + ext]);
          return { status: 200, contentType: type, finalUrl: url, path: base + ext, size: body.length };
        }
        case "reloaded": net.reloads = (net.reloads || 0) + 1; return null;
        case "pickFile": return opts.pickFile || null;
        case "imageSize": return opts.imageSize === undefined ? { width: 800, height: 600 } : opts.imageSize;
        case "exec": {
          sys.exec.push({ file: args[0], args: args[1] });
          if (args[0] !== "osascript") return { code: 1, stdout: "", stderr: "unknown command" };
          if (args[1][0] === "-e") { sys.copied = (sys.copied || []).concat([args[1][1]]); return opts.copyFails ? { code: 1, stdout: "", stderr: "no" } : { code: 0, stdout: "", stderr: "" }; }
          const [, , js, png, res] = args[1];
          sys.jxa = fs.readFileSync(js, "utf8");
          // opts.clipEmptyReads: the system says "nothing there" this many times before it hands the picture over.
          if (sys.exec.filter((x) => x.file === "osascript").length <= (opts.clipEmptyReads || 0)) { fs.writeFileSync(res, "NOIMAGE"); return { code: 0, stdout: "NOIMAGE\n", stderr: "" }; }
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
    await page.addInitScript(({ stored, tmpDir, home, hostPath, withSystemPath, updateUrl, updateState, updateEveryMs }) => {
      window.__SAYFRAME_TEST_UPDATE_URL__ = updateUrl;
      window.__SAYFRAME_TEST_UPDATE_EVERY_MS__ = updateEveryMs || 0;
      window.__opened = [];
      // Seed saved state only when the page is first opened. Touching localStorage from this start-up
      // script on a reload makes Chromium occasionally hand the page an empty store (a test-browser quirk).
      const firstOpen = window.name !== "sayframe-test-seeded";
      window.name = "sayframe-test-seeded";
      if (firstOpen) { if (stored) localStorage.setItem("sayframe.settings.v1", JSON.stringify(stored)); else localStorage.removeItem("sayframe.settings.v1"); }
      if (updateState && firstOpen) localStorage.setItem("sayframe.update.v1", JSON.stringify(updateState));
      window.__keyInterest = [];
      window.__adobe_cep__ = { evalScript(script, cb) { window.__hostEval(script).then(cb); },
        registerKeyEventsInterest(json) { window.__keyInterest.push(json); },
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
        getText: call("getText"), download: call("download"), fetchUrl: call("fetchUrl"),
        openExternal: (u) => { window.__opened.push(u); return true; },
        reload: () => { window.__plat("reloaded", []).then(() => window.location.reload()); }
      };
    }, { stored, tmpDir, home, hostPath: extDir, withSystemPath: true, updateUrl: opts.updateUrl || "", updateState: opts.updateState || null, updateEveryMs: opts.updateEveryMs || 0 });

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
      async tab(name) { await page.click(name === "tools" ? "#tabTools" : name === "motion" ? "#tabMotion" : "#tabClaude"); },
      // the paste tool lives on the Tools tab
      async paste() { if (await page.locator("#viewMotion").isHidden()) await page.click("#tabMotion"); await page.click("#pasteBtn"); },
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

  console.log("\n=== my scripts ===");
  const savedScripts = (p) => p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.scripts.v1") || "null"));
  const scriptNames = (p) => p.page.locator("#scriptsList .script-run span").allInnerTexts();
  p = await open({ replies: [msg("Создаю титр.\n```javascript\napp.__ran('title');\n```"), msg("Просто текст, без скрипта."), msg("Ломаю.\n```javascript\nthrow new Error('boom');\n```")] });
  check("K1 no saved scripts yet: the list is not shown", (await p.page.locator("#scriptsCard").isHidden()) && (await p.page.locator("#saveRow").isHidden()));
  await p.run("сделай титр с названием канала");
  check("K1 after a script ran, the reply offers to save it", (await p.page.locator("#saveScriptBtn").isVisible()) && /Сохранить скрипт/.test(await p.page.locator("#saveScriptBtn").innerText()));
  await p.page.click("#saveScriptBtn");
  check("K2 saving asks for a name, the request is offered", (await p.page.locator("#saveForm").isVisible()) && (await p.page.inputValue("#saveName")) === "сделай титр с названием канала" && (await p.page.evaluate(() => document.activeElement.id)) === "saveName");
  await p.page.fill("#saveName", "  Титр   канала ");
  await p.page.keyboard.press("Enter");
  t = await savedScripts(p);
  check("K2 saved under the given name with its script; the list appears", t.items.length === 1 && t.items[0].name === "Титр канала" && t.items[0].codes.join("|").trim() === "app.__ran('title');" && (await scriptNames(p)).join() === "Титр канала" && (await p.page.locator("#scriptsCard").isVisible()) && (await p.page.locator("#scriptsCount").innerText()) === "1", JSON.stringify(t));
  check("K2 the offer disappears after saving, the status explains", (await p.page.locator("#saveRow").isHidden()) && (await p.page.locator("#saveForm").isHidden()) && /сохранён в «Мои скрипты»/.test(await p.status()));
  t = [p.net.requests.length, p.ae.log.ran.length];
  await p.page.click("#scriptsList .script-run"); await p.idle();
  check("K3 a saved script runs with one press: no request to the AI, one undo step named after it", p.net.requests.length === t[0] && p.ae.log.ran.length === t[1] + 1 && p.ae.log.ran[p.ae.log.ran.length - 1] === "title" && p.ae.log.undo.slice(-2).join() === "begin:Sayframe: Титр канала,end" && (await p.status()) === "Готово: «Титр канала».\nОтменить: Cmd/Ctrl+Z.", await p.status());
  await p.run("объясни");
  check("K4 a text-only answer offers nothing to save", (await p.page.locator("#saveRow").isHidden()));
  await p.run("сломай");
  check("K4 nor does a script that failed", (await p.page.locator("#saveRow").isHidden()) && /^Ошибка при выполнении/.test(await p.status()));
  await p.restart();
  check("K5 saved scripts survive a restart", (await scriptNames(p)).join() === "Титр канала" && (await p.page.locator("#saveRow").isHidden()));
  await p.page.click("#scriptsList [data-act=rename]");
  check("K5 rename: the name turns into a field", (await p.page.locator("#scriptsList .script-rename").count()) === 1 && (await p.page.evaluate(() => document.activeElement.className)).indexOf("script-rename") >= 0);
  await p.page.fill("#scriptsList .script-rename", "Титр");
  await p.page.keyboard.press("Enter");
  check("K5 Enter saves the new name", (await scriptNames(p)).join() === "Титр" && (await savedScripts(p)).items[0].name === "Титр");
  await p.page.click("#scriptsList [data-act=rename]"); await p.page.fill("#scriptsList .script-rename", "Другое"); await p.page.keyboard.press("Escape");
  check("K5 Escape keeps the old name", (await scriptNames(p)).join() === "Титр");
  await p.page.click("#scriptsToggle");
  check("K6 the list folds and stays folded after a restart", (await p.page.locator("#scriptsList").isHidden()) && (await p.page.getAttribute("#scriptsToggle", "aria-expanded")) === "false");
  await p.restart();
  check("K6 (after restart)", (await p.page.locator("#scriptsList").isHidden()) && (await p.page.locator("#scriptsCard").isVisible()));
  await p.page.click("#scriptsToggle");
  await p.page.click("#scriptsList [data-act=delete]");
  check("K7 delete asks first", (await p.page.locator("#modal").isVisible()) && /Удалить «Титр»\?/.test(await p.page.locator("#modalTitle").innerText()));
  await p.modalClick("Отмена");
  check("K7 cancel keeps it", (await scriptNames(p)).join() === "Титр");
  await p.page.click("#scriptsList [data-act=delete]"); await p.modalClick("Удалить");
  check("K7 confirmed: gone, and the empty list hides", (await savedScripts(p)).items.length === 0 && (await p.page.locator("#scriptsCard").isHidden()) && p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  // a script saved with its corrections runs them in order; a risky one asks first; a failing one stops
  p = await open({});
  await p.page.evaluate(() => localStorage.setItem("sayframe.scripts.v1", JSON.stringify({ open: true, items: [
    { id: "a", name: "Две части", codes: ["app.__ran('one');", "app.__ran('two');"] },
    { id: "b", name: "Опасный", codes: ["var f = new File('/tmp/x'); app.__ran('risky');"] },
    { id: "c", name: "Ломается", codes: ["app.__ran('first');", "throw new Error('нет слоя');", "app.__ran('never');"] },
    { id: "d", name: 42, codes: ["x"] }, { id: "e", name: "Пустой", codes: [] }, "мусор" ] })));
  await p.restart();
  check("K8 broken entries in the saved list are skipped", (await scriptNames(p)).join() === "Две части,Опасный,Ломается" && p.errors.length === 0, (await scriptNames(p)).join());
  await p.page.locator("#scriptsList .script-run").nth(0).click(); await p.idle();
  check("K8 several parts run in order, each its own undo step", p.ae.log.ran.join() === "one,two" && p.ae.log.undo.join() === "begin:Sayframe: Две части 1,end,begin:Sayframe: Две части 2,end" && /каждый шаг — отдельно/.test(await p.status()), p.ae.log.undo.join());
  await p.page.locator("#scriptsList .script-run").nth(1).click();
  check("K9 a script that touches files asks first, showing the code", (await p.page.locator("#modal").isVisible()) && /new File/.test(await p.page.locator("#modalCode").textContent()));
  await p.modalClick("Не запускать");
  check("K9 declined -> not run", p.ae.log.ran.join() === "one,two" && (await p.status()) === "Скрипт не запущен.");
  await p.page.locator("#scriptsList .script-run").nth(2).click(); await p.idle();
  check("K10 an error stops it at that step and says which", p.ae.log.ran.join() === "one,two,first" && /^Ошибка в «Ломается» \(шаг 2 из 3\): Error: нет слоя/.test(await p.status()) && (await p.statusKind()) === "error", await p.status());
  await p.close();
  p = await open({ hostDelayMs: 300 });
  await p.page.evaluate(() => localStorage.setItem("sayframe.scripts.v1", JSON.stringify({ open: true, items: [{ id: "a", name: "X", codes: ["app.__ran('x');"] }] })));
  await p.restart();
  await p.page.click("#scriptsList .script-run");
  t = [await p.page.locator("#scriptsList button").evaluateAll((l) => l.every((b) => b.disabled)), await p.page.locator("#runBtn").isDisabled()];
  await p.idle();
  check("K11 while a saved script runs, the panel is busy and the list cannot start another", t[0] && t[1] && !(await p.page.locator("#scriptsList .script-run").isDisabled()) && p.ae.log.ran.join() === "x", t.join());
  await p.close();

  console.log("\n=== expressions ===");
  const exprReply = (list, note) => msg("```json\n" + JSON.stringify({ note: note || "Готово.", expressions: list }) + "\n```");
  const exprScene = () => {
    const pos = mkEProp("Position", "ADBE Position", [960, 540], { keys: 2 });
    const rot = mkEProp("Rotation", "ADBE Rotate Z", 0);
    const op = mkEProp("Opacity", "ADBE Opacity", 100, { expression: "wiggle(2, BAD)" });
    const sc = mkEProp("Scale", "ADBE Scale", [100, 100], { expression: "[100, 100" });
    const off = mkEProp("Anchor Point", "ADBE Anchor Point", [0, 0], { expression: "BAD stuff", enabled: false });
    const L1 = mkELayer(1, "Logo", [mkEGroup("Transform", "ADBE Transform Group", [pos, rot, op])]);
    const L2 = mkELayer(2, "Title", [mkEGroup("Transform", "ADBE Transform Group", [sc, off])]);
    return { pos, rot, op, sc, off, layers: [L1, L2] };
  };
  let X = exprScene();
  p = await open({ exprLayers: X.layers, selectedProperties: [X.pos.parentProperty, X.pos, X.rot], replies: [exprReply([{ id: 1, expression: "var freq = 2;\nwiggle(freq, 30)" }, { id: 2, expression: "time * 90" }], "Позиция качается, поворот крутится.")] });
  check("E1 an 'Expressions' card on the AI tab: a field and two buttons", (await p.page.locator("#exprCard").isVisible()) && (await p.page.locator("#exprApplyBtn").innerText()) === "Поставить на выделенное" && (await p.page.locator("#exprFixBtn").innerText()) === "Починить ошибки");
  await p.page.click("#exprApplyBtn");
  check("E1 nothing written -> a hint, nothing sent", /Напишите, что должно делать/.test(await p.status()) && p.net.requests.length === 0);
  await p.page.fill("#exprWish", "пусть качается, а поворот крутится");
  await p.page.click("#exprApplyBtn"); await p.idle();
  c = p.net.requests[0].body;
  check("E2 the AI gets the wish and each selected property with its layer, path, value and keyframes (groups are skipped)", /\[Request\]\nпусть качается, а поворот крутится/.test(c.messages[0].content) && /1\. Layer 1 "Logo" > Transform > Position \(matchName ADBE Position\), value \[960, 540\], keyframes: 2, no expression yet/.test(c.messages[0].content) && /2\. Layer 1 "Logo" > Transform > Rotation/.test(c.messages[0].content) && !/3\./.test(c.messages[0].content), c.messages[0].content);
  check("E2 with its own instructions for expressions, not the script ones", /You write Adobe After Effects expressions/.test(c.system) && !/writing a script that the panel runs/.test(c.system));
  check("E3 the expressions are on the properties", X.pos.expression === "var freq = 2;\nwiggle(freq, 30)" && X.rot.expression === "time * 90" && X.op.sets.length === 0);
  check("E3 one undo step, the status lists what got an expression", p.ae.log.undo.join() === "begin:Sayframe: expression,end" && /^Выражение стоит: Transform > Position, Transform > Rotation\.\nПозиция качается, поворот крутится\.\nОтменить: Cmd\/Ctrl\+Z\.$/.test(await p.status()) && (await p.statusKind()) === "done", await p.status());
  check("E3 the expressions are shown in the reply card, nothing to save as a script", /\/\/ Transform > Position\nvar freq = 2;/.test(await p.page.locator("#replyCode").textContent()) && (await p.page.locator("#saveRow").isHidden()));
  await p.close();

  // After Effects does not accept the first answer: the AI is asked again with the error
  X = exprScene();
  p = await open({ exprLayers: X.layers, selectedProperties: [X.rot], replies: [exprReply([{ id: 1, expression: "time * BAD" }]), exprReply([{ id: 1, expression: "time * 45" }], "Исправил.")] });
  await p.page.fill("#exprWish", "крутись"); await p.page.click("#exprApplyBtn"); await p.idle();
  m = p.net.requests[1] && p.net.requests[1].body.messages;
  check("E4 an expression After Effects rejects goes back to the AI with the error, and the fix is applied", m && m.length === 3 && /After Effects reported errors for these expressions:\nid 1: Error: ReferenceError: BAD is not defined/.test(m[2].content) && X.rot.expression === "time * 45" && X.rot.sets.length === 2, JSON.stringify(m && m[2]));
  check("E4 two attempts, two undo steps, the status says so", /^Выражение стоит: Transform > Rotation\./.test(await p.status()) && /каждая попытка — отдельный шаг/.test(await p.status()), await p.status());
  await p.close();
  X = exprScene();
  p = await open({ exprLayers: X.layers, selectedProperties: [X.rot], replies: [exprReply([{ id: 1, expression: "BAD 1" }]), exprReply([{ id: 1, expression: "BAD 2" }]), exprReply([{ id: 1, expression: "BAD 3" }])] });
  await p.page.fill("#exprWish", "крутись"); await p.page.click("#exprApplyBtn"); await p.idle();
  check("E5 after three refused attempts it stops and reports the error", p.net.requests.length === 3 && /^Не получилось для: Transform > Rotation \(Error: ReferenceError/.test(await p.status()) && (await p.statusKind()) === "error", await p.status());
  await p.close();

  X = exprScene();
  p = await open({ exprLayers: X.layers, selectedProperties: [], replies: [] });
  await p.page.fill("#exprWish", "качайся"); await p.page.click("#exprApplyBtn"); await p.idle();
  check("E6 nothing selected -> a hint, nothing sent", /^Выделите свойство на таймлайне/.test(await p.status()) && p.net.requests.length === 0 && (await p.statusKind()) === "");
  await p.close();
  p = await open({ noActiveComp: true });
  await p.page.fill("#exprWish", "качайся"); await p.page.click("#exprApplyBtn"); await p.idle();
  check("E6 no composition open -> a hint", /^Откройте композицию/.test(await p.status()) && (await p.statusKind()) === "");
  await p.close();
  X = exprScene();
  p = await open({ exprLayers: X.layers, selectedProperties: [X.rot], replies: [msg("Не могу.")] });
  await p.page.fill("#exprWish", "качайся"); await p.page.click("#exprApplyBtn"); await p.idle();
  check("E6 an answer without the JSON is reported, nothing changes", /ответил не в том виде/.test(await p.status()) && X.rot.sets.length === 0 && (await p.statusKind()) === "error", await p.status());
  await p.close();
  X = exprScene();
  p = await open({ settings: { apiKey: "" }, exprLayers: X.layers, selectedProperties: [X.rot] });
  await p.page.fill("#exprWish", "качайся"); await p.page.click("#exprApplyBtn");
  check("E6 no key -> asks for it", /^Нужен ключ Anthropic API/.test(await p.status()) && (await p.page.locator("#settingsSheet").isVisible()));
  await p.close();

  // fixing broken expressions in the open composition
  X = exprScene();
  p = await open({ exprLayers: X.layers, replies: [exprReply([{ id: 1, expression: "wiggle(2, 20)" }, { id: 2, expression: "[100, 100]" }], "Починил обе.")] });
  await p.page.click("#exprFixBtn"); await p.idle();
  c = p.net.requests[0].body.messages[0].content;
  check("E7 'Fix errors' finds the broken expressions that are switched on (not the switched-off one) and sends them with their errors", /These expressions give errors/.test(c) && /1\. Layer 1 "Logo" > Transform > Opacity/.test(c) && /wiggle\(2, BAD\)/.test(c) && /error: Error: ReferenceError/.test(c) && /2\. Layer 2 "Title" > Transform > Scale/.test(c) && /error: Error: SyntaxError/.test(c) && !/Anchor Point/.test(c), c);
  check("E7 both fixed", X.op.expression === "wiggle(2, 20)" && X.sc.expression === "[100, 100]" && X.op.expressionError === "" && /^Выражение стоит: Transform > Opacity, Transform > Scale\.\nПочинил обе\./.test(await p.status()), await p.status());
  await p.page.click("#exprFixBtn"); await p.idle();
  check("E7 asked again: nothing left to fix, no request", /нет выражений с ошибкой/.test(await p.status()) && p.net.requests.length === 1 && (await p.statusKind()) === "done", await p.status());
  await p.page.click("#exprToggle");
  check("E8 the card folds and stays folded", (await p.page.locator("#exprBody").isHidden()));
  await p.restart();
  check("E8 (after restart)", (await p.page.locator("#exprBody").isHidden()) && p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  X = exprScene();
  p = await open({ settings: { provider: "openai", openaiKey: "sk-o" }, exprLayers: X.layers, selectedProperties: [X.rot], replies: [{ choices: [{ index: 0, message: { role: "assistant", content: "```json\n" + JSON.stringify({ note: "ok", expressions: [{ id: 1, expression: "time*10" }] }) + "\n```" }, finish_reason: "stop" }] }] });
  await p.page.fill("#exprWish", "крутись"); await p.page.click("#exprApplyBtn"); await p.idle();
  c = p.net.requests[0];
  check("E9 works with ChatGPT too: the expression instructions go as its system message", c.url === "https://api.openai.com/v1/chat/completions" && /You write Adobe After Effects expressions/.test(c.body.messages[0].content) && X.rot.expression === "time*10", JSON.stringify(c.body.messages[0]).slice(0, 100));
  await p.close();

  console.log("\n=== quick tasks ===");
  const chips = (p) => p.page.locator("#quickList .quick-chip span:first-child").allInnerTexts();
  const savedQuick = (p) => p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.quick.v1") || "null"));
  p = await open({ replies: [msg("Делаю подпись.\n```javascript\napp.__ran('lower');\n```")] });
  check("Q1 four ready tasks above the request field", (await chips(p)).join() === "Появление текста,Подпись внизу кадра,Логотип с отскоком,Упорядочить проект" && (await p.page.evaluate(() => { const q = document.getElementById("quickBox").getBoundingClientRect(), t = document.getElementById("prompt").getBoundingClientRect(); return q.bottom <= t.top; })));
  await p.page.locator("#quickList .quick-chip").nth(1).click();
  t = await p.page.inputValue("#prompt");
  check("Q2 a press puts the task into the field (not sent yet) with the cursor at the end", /^Сделай подпись внизу кадра/.test(t) && /«Имя Фамилия»/.test(t) && p.net.requests.length === 0 && (await p.page.evaluate(() => document.activeElement.id)) === "prompt" && (await p.page.evaluate(() => document.getElementById("prompt").selectionStart === document.getElementById("prompt").value.length)) && /в поле запроса/.test(await p.status()));
  await p.page.fill("#prompt", t.replace("«Имя Фамилия»", "«Далер»"));
  await p.page.click("#runBtn"); await p.idle();
  check("Q2 after a tweak it runs like any request", /«Далер»/.test(p.net.requests[0].body.messages[0].content) && p.ae.log.ran.join() === "lower");
  await p.page.fill("#prompt", "Сделай тряску камеры на 2 секунды с текущего времени");
  await p.page.click("#quickAdd");
  check("Q3 '+' offers to save the text from the field as a task", (await p.page.locator("#quickForm").isVisible()) && (await p.page.inputValue("#quickText")) === "Сделай тряску камеры на 2 секунды с текущего времени" && (await p.page.inputValue("#quickName")) === "Сделай тряску камеры на 2 секунды".slice(0, 30), await p.page.inputValue("#quickName"));
  await p.page.fill("#quickName", "Тряска");
  await p.page.click("#quickSave");
  check("Q3 saved: a new button at the end, remembered", (await chips(p)).slice(-1)[0] === "Тряска" && (await p.page.locator("#quickForm").isHidden()) && (await savedQuick(p)).items.slice(-1)[0].text === "Сделай тряску камеры на 2 секунды с текущего времени" && /сохранена/.test(await p.status()));
  await p.page.fill("#prompt", "");
  await p.page.click("#quickAdd");
  check("Q3 with an empty field the form is empty, the name gets the cursor", (await p.page.inputValue("#quickName")) === "" && (await p.page.inputValue("#quickText")) === "" && (await p.page.evaluate(() => document.activeElement.id)) === "quickName");
  await p.page.click("#quickSave");
  check("Q3 an empty task is not saved", (await p.page.locator("#quickForm").isVisible()) && (await chips(p)).length === 5);
  await p.page.keyboard.press("Escape");
  check("Q3 Escape closes the form", await p.page.locator("#quickForm").isHidden());
  await p.restart();
  check("Q4 own tasks survive a restart", (await chips(p)).join() === "Появление текста,Подпись внизу кадра,Логотип с отскоком,Упорядочить проект,Тряска");
  await p.page.click("#quickEdit");
  check("Q5 edit mode: every button gets a cross", (await p.page.getAttribute("#quickEdit", "aria-pressed")) === "true" && (await p.page.locator("#quickList .quick-del").count()) === 5);
  await p.page.locator("#quickList .quick-chip").nth(4).click();
  check("Q5 in edit mode a press opens the task for editing", (await p.page.locator("#quickForm").isVisible()) && (await p.page.inputValue("#quickName")) === "Тряска" && (await p.page.inputValue("#prompt")) === "");
  await p.page.fill("#quickName", "Тряска камеры"); await p.page.fill("#quickText", "Сделай сильную тряску камеры");
  await p.page.click("#quickSave");
  check("Q5 edited in place", (await chips(p)).slice(-1)[0] === "Тряска камеры" && (await savedQuick(p)).items.length === 5 && (await savedQuick(p)).items[4].text === "Сделай сильную тряску камеры");
  await p.page.locator("#quickList .quick-chip").nth(0).locator(".quick-del").click();
  check("Q6 delete asks first", (await p.page.locator("#modal").isVisible()) && /Удалить задачу «Появление текста»\?/.test(await p.page.locator("#modalTitle").innerText()) && /можно будет вернуть/.test(await p.page.locator("#modalText").innerText()));
  await p.modalClick("Удалить");
  check("Q6 gone; a 'bring back' link appears for the standard ones", !(await chips(p)).includes("Появление текста") && (await p.page.locator("#quickList [data-act=reset]").isVisible()));
  await p.page.click("#quickList [data-act=reset]");
  check("Q6 the standard task is back, own ones kept", (await chips(p)).includes("Появление текста") && (await chips(p)).includes("Тряска камеры") && (await p.page.locator("#quickList [data-act=reset]").count()) === 0);
  await p.page.click("#quickEdit");
  check("Q6 leaving edit mode removes the crosses", (await p.page.locator("#quickList .quick-del").count()) === 0);
  await p.page.click("#quickToggle");
  check("Q7 the row folds and stays folded after a restart", (await p.page.locator("#quickList").isHidden()) && (await p.page.getAttribute("#quickToggle", "aria-expanded")) === "false");
  await p.restart();
  check("Q7 (after restart)", (await p.page.locator("#quickList").isHidden()) && p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  for (const bad of ['"x"', "5", '{"items":[1,{"name":"","text":"a"},{"name":"Ок","text":"сделай"}]}']) {
    p = await open({});
    await p.page.evaluate((v) => localStorage.setItem("sayframe.quick.v1", v), bad); await p.restart();
    t = await chips(p);
    check("Q8 broken saved tasks " + bad + " -> safe", (bad.indexOf("Ок") >= 0 ? t.join() === "Ок" : t.length === 4) && p.errors.length === 0, t.join());
    await p.close();
  }
  p = await open({ hostDelayMs: 300 });
  await p.page.evaluate(() => localStorage.setItem("sayframe.scripts.v1", JSON.stringify({ open: true, items: [{ id: "a", name: "X", codes: ["app.__ran('x');"] }] })));
  await p.restart();
  await p.page.click("#scriptsList .script-run");
  t = await p.page.locator("#quickList .quick-chip").evaluateAll((l) => l.length === 4 && l.every((b) => b.disabled));
  await p.idle();
  check("Q9 while the panel is busy the buttons are off, and on again after", t && !(await p.page.locator("#quickList .quick-chip").first().isDisabled()));
  await p.close();

  console.log("\n=== reference by link ===");
  const addLink = async (p, url) => { if (await p.page.locator("#refLinkRow").isHidden()) await p.page.click("#refLinkBtn"); await p.page.fill("#refLink", url); await p.page.click("#refLinkAdd"); await p.idle(); };
  const PAGE = (head, body) => "<!doctype html><html><head>" + head + "</head><body>" + (body || "") + "</body></html>";
  p = await open({});
  check("L1 a '+ Link' button next to '+ Reference', the field is hidden at first", (await p.page.locator("#refLinkBtn").innerText()) === "+ Ссылка" && (await p.page.locator("#refLinkRow").isHidden()));
  await p.page.click("#refLinkBtn");
  check("L1 it opens a field for the link, with the cursor in it", (await p.page.locator("#refLinkRow").isVisible()) && (await p.page.evaluate(() => document.activeElement.id)) === "refLink" && (await p.page.getAttribute("#refLink", "placeholder")) === "https://…");
  await p.page.keyboard.press("Escape");
  check("L1 Escape closes it", await p.page.locator("#refLinkRow").isHidden());
  await p.page.click("#refLinkBtn"); await p.page.click("#refLinkCancel");
  check("L1 so does the cross", await p.page.locator("#refLinkRow").isHidden());
  await addLink(p, "   ");
  check("L1 an empty field -> a hint, nothing is downloaded", /^Вставьте ссылку/.test(await p.status()) && !(p.net.fetches || []).length);
  await addLink(p, "привет");
  check("L1 text that is not a link -> the same hint", /^Вставьте ссылку/.test(await p.status()) && !(p.net.fetches || []).length && p.errors.length === 0);
  await p.close();

  p = await open({ footage: IMG, web: { "https://example.com/art/poster.png": { type: "image/png" } }, replies: [msg("Повторяю.\n```javascript\napp.__ran('ref');\n```")] });
  await addLink(p, "example.com/art/poster.png");
  check("L2 a direct link to a picture (https:// added by itself): downloaded and attached like a file", p.net.fetches.join() === "https://example.com/art/poster.png" && (await p.page.locator("#refText").innerText()) === "poster.png — картинка" && /^Картинка прикреплена/.test(await p.status()) && (await p.statusKind()) === "done", await p.status());
  check("L2 After Effects opened the downloaded copy, the copy is deleted afterwards, the field closes", /sayframe_link_\d+\.png$/.test(p.ae.log.imports[0]) && p.tempLeft().length === 0 && !fs.existsSync(p.net.saved[0]) && (await p.page.locator("#refLinkRow").isHidden()) && (await p.page.inputValue("#refLink")) === "");
  await p.run("сделай такую же картинку");
  c = p.net.requests[0].body.messages[0].content;
  check("L2 Claude gets the picture with its name", Array.isArray(c) && c[0].type === "image" && /\("poster\.png", 800x600\)/.test(c[c.length - 1].text), c[c.length - 1].text.slice(0, 120));
  await p.close();

  p = await open({ footage: VIDEO, web: {
    "https://dribbble.com/shots/123-logo": { type: "text/html; charset=utf-8", body: PAGE('<title>Logo reveal by Ann</title><meta property="og:image" content="https://cdn.dribbble.com/still.png"><meta property="og:video" content="/media/shot.mp4">') },
    "https://dribbble.com/media/shot.mp4": { type: "video/mp4" } } });
  await addLink(p, "https://dribbble.com/shots/123-logo");
  check("L3 a page with a video: the video is taken (its address resolved), not the still", p.net.fetches.join() === "https://dribbble.com/shots/123-logo,https://dribbble.com/media/shot.mp4" && (await p.page.locator("#refText").innerText()) === "shot.mp4 — 8 кадр. из 4.0 с" && /^Видео прикреплено: 8 кадров/.test(await p.status()), (p.net.fetches || []).join() + " " + await p.status());
  await p.close();

  p = await open({ footage: IMG, web: {
    "https://www.pinterest.com/pin/42/": { type: "text/html", body: PAGE("<meta name='og:title' content='Neon &amp; glass'><meta property=\"og:image\" content=\"https://i.pinimg.com/736x/ab/cd.jpg?x=1&amp;y=2\"><meta property=\"og:video\" content=\"https://www.pinterest.com/embed/42\">") },
    "https://i.pinimg.com/736x/ab/cd.jpg?x=1&y=2": { type: "image/jpeg" } } });
  await addLink(p, "https://www.pinterest.com/pin/42/");
  check("L4 a page with a picture: the main picture is taken; an embed page that is not a video file is ignored; &amp; is decoded", p.net.fetches[1] === "https://i.pinimg.com/736x/ab/cd.jpg?x=1&y=2" && (await p.page.locator("#refText").innerText()) === "cd.jpg — картинка", (p.net.fetches || []).join() + " " + await p.status());
  await p.close();

  p = await open({ footage: IMG, web: {
    "https://www.youtube.com/watch?v=abc": { type: "text/html", body: PAGE('<meta property="og:title" content="Motion tutorial"><meta property="og:image" content="https://i.ytimg.com/vi/abc/maxresdefault.jpg"><meta property="og:video:url" content="https://www.youtube.com/embed/abc"><meta property="og:video:type" content="text/html">') },
    "https://i.ytimg.com/vi/abc/maxresdefault.jpg": { type: "image/jpeg" } } });
  await addLink(p, "https://www.youtube.com/watch?v=abc");
  check("L5 YouTube: only the cover picture, and the panel says so", p.net.fetches[1] === "https://i.ytimg.com/vi/abc/maxresdefault.jpg" && (await p.page.locator("#refText").innerText()) === "maxresdefault.jpg — картинка" && /С YouTube панель берёт только обложку ролика/.test(await p.status()), await p.status());
  await p.close();

  p = await open({ footage: IMG, web: {
    "https://example.com/empty": { type: "text/html", body: PAGE("<title>Nothing</title>", "<p>text</p>") },
    "https://example.com/private": { status: 403 },
    "https://example.com/gone.png": { status: 404 },
    "https://example.com/doc.pdf": { type: "application/pdf" },
    "https://example.com/slow": { error: "TIMEOUT" } } });
  await addLink(p, "https://example.com/empty");
  check("L6 a page without pictures or video -> says so", /^Не удалось взять референс по ссылке: на странице не нашлось картинки или видео/.test(await p.status()) && (await p.statusKind()) === "error" && (await p.page.locator("#refLinkRow").isVisible()) && (await p.page.inputValue("#refLink")) === "https://example.com/empty", await p.status());
  await addLink(p, "https://example.com/private");
  check("L6 a site that wants a login -> says so and suggests downloading the file", /не пускает без входа в аккаунт \(код 403\)/.test(await p.status()), await p.status());
  await addLink(p, "https://example.com/gone.png");
  check("L6 nothing at the address", /по ссылке ничего нет \(код 404\)/.test(await p.status()), await p.status());
  await addLink(p, "https://example.com/doc.pdf");
  check("L6 not a picture or a video", /по ссылке не картинка и не видео/.test(await p.status()), await p.status());
  await addLink(p, "https://example.com/slow");
  check("L6 no answer from the site", /нет связи с сайтом/.test(await p.status()), await p.status());
  await addLink(p, "https://nowhere.example/x.png");
  check("L6 no such site", /нет связи с сайтом/.test(await p.status()) && (await p.page.locator("#refChip").isHidden()) && p.tempLeft().length === 0 && p.errors.length === 0, await p.status());
  await p.close();

  console.log("\n=== ChatGPT ===");
  const gpt = (text, finish) => ({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish || "stop" }] });
  const providerNow = (p) => p.page.locator('#provider button[aria-pressed="true"]').getAttribute("data-value");
  const modelNames = (p) => p.page.locator("#models button b").allInnerTexts();
  p = await open({});
  await p.page.click("#settingsBtn");
  check("C1 settings: a choice between Claude and ChatGPT, Claude by default", (await p.page.locator("#provider button").allInnerTexts()).join() === "Claude,ChatGPT" && (await providerNow(p)) === "claude" && (await p.page.locator("#apiKeyLabel").innerText()) === "Ключ Anthropic API" && (await p.page.inputValue("#apiKey")) === "sk-ant-test" && (await modelNames(p)).join() === "Sonnet 5.5,Opus 5.5,Haiku 4.5");
  await p.page.click('#provider button[data-value="openai"]');
  check("C1 ChatGPT: its own key field, hint and models", (await providerNow(p)) === "openai" && (await p.page.locator("#apiKeyLabel").innerText()) === "Ключ OpenAI API" && (await p.page.inputValue("#apiKey")) === "" && (await p.page.getAttribute("#apiKey", "placeholder")) === "sk-…" && /platform\.openai\.com/.test(await p.page.locator("#keyHint").innerText()) && /ChatGPT Plus/.test(await p.page.locator("#keyHint").innerText()) && (await modelNames(p)).join() === "GPT-6.1 Sol,GPT-6 Astra,GPT-6 Luna" && (await p.page.getAttribute('#models button[data-value="gpt-6.1-sol"]', "aria-pressed")) === "true");
  await p.page.fill("#apiKey", " sk-openai-test ");
  await p.page.click('#provider button[data-value="claude"]');
  t = await p.page.inputValue("#apiKey");
  await p.page.click('#provider button[data-value="openai"]');
  check("C1 switching back and forth keeps both keys", t === "sk-ant-test" && (await p.page.inputValue("#apiKey")) === "sk-openai-test");
  await p.page.click('#models button[data-value="gpt-6-astra"]');
  await p.page.click("#saveSettings");
  t = await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.settings.v1")));
  check("C2 saved: ChatGPT, its key and model; the Claude key stays", t.provider === "openai" && t.openaiKey === "sk-openai-test" && t.openaiModel === "gpt-6-astra" && t.apiKey === "sk-ant-test" && t.model === "claude-sonnet-5-5", JSON.stringify(t));
  check("C2 the first tab is called AI whichever is chosen", (await p.page.locator("#tabClaude").innerText()) === "AI");
  await p.restart();
  check("C2 and ChatGPT stays chosen after a restart", (await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.settings.v1")).provider)) === "openai" && (await p.page.locator("#tabClaude").innerText()) === "AI");
  await p.close();

  p = await open({ settings: { provider: "openai", openaiKey: "sk-openai-test" }, replies: [gpt("Создаю слой.\n```javascript\napp.__ran('one');\n```")] });
  await p.run("сделай слой");
  c = p.net.requests[0];
  check("C3 the request goes to OpenAI with its key, not to Anthropic", c.url === "https://api.openai.com/v1/chat/completions" && c.headers.authorization === "Bearer sk-openai-test" && !c.headers["x-api-key"] && c.body.model === "gpt-6.1-sol" && c.body.max_completion_tokens === 32768 && c.body.max_tokens === undefined, JSON.stringify(c.headers));
  check("C3 the instructions go first as a system message, then the request", c.body.messages[0].role === "system" && /Adobe After Effects/.test(c.body.messages[0].content) && c.body.messages[1].role === "user" && /\[Request\]\nсделай слой$/.test(c.body.messages[1].content) && c.body.messages.length === 2);
  check("C3 the script runs, the status names ChatGPT's answer", p.ae.log.ran.join() === "one" && /^Готово: Создаю слой\./.test(await p.status()), await p.status());
  await p.close();

  p = await open({ settings: { provider: "openai", openaiKey: "sk-openai-test" }, pickFile: "/a/poster.png", footage: IMG, replies: [gpt("Повторяю.\n```javascript\napp.__ran('ref');\n```"), gpt("Готово, всё на месте.")] });
  await p.page.click("#refBtn"); await p.idle();
  check("C4 the reference status names ChatGPT", (await p.page.locator("#refText").innerText()) === "poster.png — картинка");
  await p.run("сделай такую же картинку");
  c = p.net.requests[0].body.messages[1].content;
  check("C4 reference frames go as pictures in ChatGPT's format", Array.isArray(c) && c.length === 2 && c[0].type === "image_url" && c[0].image_url.url.indexOf("data:image/png;base64,") === 0 && Buffer.from(c[0].image_url.url.split(",")[1], "base64").equals(fakePng(0)) && c[1].type === "text" && /^\[Reference\]/.test(c[1].text), JSON.stringify(c).slice(0, 200));
  check("C4 after sending: 'ChatGPT remembers it'", (await p.page.locator("#refText").innerText()) === "Референс отправлен, ChatGPT помнит его в этом диалоге");
  await p.run("ещё раз");
  m = p.net.requests[1].body.messages;
  check("C4 a follow-up keeps the whole dialog: system, user, assistant, user", m.map((x) => x.role).join() === "system,user,assistant,user" && /Повторяю/.test(m[2].content) && (await p.status()) === "ChatGPT ответил текстом, скрипт не запускался.", m.map((x) => x.role).join() + " " + await p.status());
  await p.close();

  p = await open({ settings: { provider: "openai", openaiKey: "sk-bad" }, replies: [{ error: { message: "Incorrect API key provided: sk-bad.", type: "invalid_request_error", code: "invalid_api_key" } }] });
  await p.run("сделай слой");
  check("C5 an OpenAI error is shown as it is", (await p.status()) === "ChatGPT API: Incorrect API key provided: sk-bad." && (await p.statusKind()) === "error" && p.ae.log.ran.length === 0, await p.status());
  await p.close();
  p = await open({ settings: { provider: "openai", openaiKey: "sk-openai-test" }, replies: [gpt("Начинаю длинный скрипт", "length")] });
  await p.run("сделай всё");
  check("C5 an answer cut by the length limit is reported", (await p.status()) === "Ответ оборвался по длине. Попробуйте разбить задачу на части.", await p.status());
  await p.close();
  p = await open({ settings: { provider: "openai", openaiKey: "" } });
  await p.run("сделай слой");
  check("C6 ChatGPT chosen but no OpenAI key -> asks for that key, not the Anthropic one", /^Нужен ключ OpenAI API\./.test(await p.status()) && p.net.requests.length === 0 && (await p.page.locator("#settingsSheet").isVisible()) && (await p.page.locator("#apiKeyLabel").innerText()) === "Ключ OpenAI API", await p.status());
  await p.close();
  p = await open({ settings: { provider: "openai", openaiKey: "sk-openai-test" }, replies: [gpt("pong")] });
  await p.page.click("#settingsBtn"); await p.page.click("#testKey");
  await p.page.waitForFunction(() => !document.getElementById("testKey").disabled);
  check("C7 'Check' tests the OpenAI key against OpenAI", p.net.requests[0].url === "https://api.openai.com/v1/chat/completions" && p.net.requests[0].headers.authorization === "Bearer sk-openai-test" && (await p.page.locator("#keyHint").innerText()) === "Ключ работает.");
  await p.page.click("#settingsClose");
  check("C7 the test does not change the saved settings", (await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.settings.v1")).provider)) === "openai" && p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  for (const bad of ["gemini", 5, null]) {
    p = await open({ settings: { provider: bad, openaiModel: "gpt-2" } });
    await p.page.click("#settingsBtn");
    check("C8 a broken saved choice (" + JSON.stringify(bad) + ") means Claude", (await providerNow(p)) === "claude" && (await p.page.locator("#apiKeyLabel").innerText()) === "Ключ Anthropic API" && p.errors.length === 0);
    await p.close();
  }
  p = await open({ settings: { provider: "openai", openaiKey: "k", openaiModel: "gpt-2" } });
  await p.page.click("#settingsBtn");
  check("C8 an unknown saved OpenAI model falls back to the first one", (await p.page.getAttribute('#models button[data-value="gpt-6.1-sol"]', "aria-pressed")) === "true");
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
  await p.tab("motion");
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

  // "I copied a picture and the first Cmd+V did nothing": the system may answer "nothing there" right after
  // a copy and hand the picture over a moment later, and Cmd+V used to be dropped while the cursor sat in a field.
  const reads = (p) => p.sys.exec.filter((x) => x.file === "osascript").length;
  p = await open({ clip: "png", clipEmptyReads: 1, footage: IMG });
  await p.paste(); await p.idle();
  await p.page.waitForFunction(() => !document.getElementById("modal").hidden, null, { timeout: 15000 });
  await p.modalClick("Оставить как есть");
  check("P12 the picture arrives a moment after the copy: the first press still pastes it", /^Картинка вставлена слоем/.test(await p.status()) && reads(p) === 2 && p.ae.log.layerAdds.length === 1, (await p.status()) + " reads=" + reads(p));
  await p.close();
  p = await open({ clip: "png", clipEmptyReads: 2, footage: IMG });
  await p.paste(); await p.idle();
  await p.page.waitForFunction(() => !document.getElementById("modal").hidden, null, { timeout: 15000 });
  await p.modalClick("Отмена");
  check("P12 even when it takes two more looks", reads(p) === 3 && (await p.status()) === "Вставка отменена." && p.tempLeft().length === 0, (await p.status()) + " reads=" + reads(p));
  await p.close();
  p = await open({ clip: "none", footage: IMG });
  t = Date.now();
  await p.paste(); await p.idle();
  check("P12 a clipboard that really has no picture is reported after three looks, within two seconds", /^В буфере обмена нет картинки/.test(await p.status()) && reads(p) === 3 && Date.now() - t < 2500 && p.tempLeft().length === 0 && !(await p.page.locator("#pasteBtn").isDisabled()), reads(p) + " " + (Date.now() - t));
  check("P12 the macOS helper also asks the system for any picture it can read, and stays plain ASCII", /initWithPasteboard/.test(p.sys.jxa) && /^[\x09\x0a\x20-\x7e]*$/.test(p.sys.jxa) && (() => { try { new Function(p.sys.jxa); return true; } catch (e) { return false; } })());
  await p.close();
  p = await open({ clip: "png", footage: IMG, replies: [msg("Повторяю.\n```javascript\napp.__ran('ref');\n```")] });
  await p.page.focus("#prompt");
  await p.page.evaluate(() => { const dt = new DataTransfer(); document.getElementById("prompt").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  await p.idle();
  for (let i = 0; i < 20 && p.tempLeft().length; i++) await p.page.waitForTimeout(50);
  check("P13 Cmd+V on the AI tab with the cursor in the prompt: the screenshot becomes the reference", (await p.page.locator("#refText").innerText()) === "Снимок из буфера — картинка" && /^Картинка прикреплена/.test(await p.status()) && reads(p) === 1 && (await p.page.inputValue("#prompt")) === "" && (await p.page.locator("#modal").isHidden()), await p.status());
  check("P13 nothing lands in the composition or the project, the temporary PNG is gone", p.ae.log.layerAdds.length === 0 && p.ae.log.bins.length === 0 && p.ae.log.imports.length === 1 && /sayframe_clip_\d+\.png$/.test(p.ae.log.imports[0]) && !fs.existsSync(p.ae.log.imports[0]) && p.tempLeft().length === 0 && !fs.existsSync(docs(p)));
  await p.run("сделай так же");
  c = p.net.requests[0].body.messages[0].content;
  check("P13 the AI gets the screenshot with the task", Array.isArray(c) && c[0].type === "image" && /Снимок из буфера/.test(c[c.length - 1].text) && p.ae.log.ran.join() === "ref", c[c.length - 1].text.slice(0, 120));
  await p.close();
  p = await open({ clip: "none", footage: IMG });
  await p.page.evaluate(() => { const dt = new DataTransfer(); document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  await p.idle();
  check("P14 Cmd+V on the AI tab with no picture -> a hint, no reference", /^В буфере обмена нет картинки/.test(await p.status()) && (await p.page.locator("#refChip").isHidden()) && p.ae.log.imports.length === 0 && p.tempLeft().length === 0, await p.status());
  await p.close();
  fs.writeFileSync(userFile, fakePng(3));
  p = await open({ clip: { file: userFile }, footage: IMG });
  await p.page.evaluate(() => { const dt = new DataTransfer(); document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  await p.idle();
  check("P14 a copied picture file becomes the reference under its own name and is left where it is", (await p.page.locator("#refText").innerText()) === path.basename(userFile) + " — картинка" && fs.existsSync(userFile) && p.ae.log.layerAdds.length === 0, await p.status());
  await p.close();
  p = await open({ clip: "png", footage: IMG });
  await p.tab("motion");
  await p.page.evaluate(() => { const dt = new DataTransfer(); document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  await p.page.waitForFunction(() => !document.getElementById("modal").hidden, null, { timeout: 15000 });
  await p.modalClick("Оставить как есть");
  check("P14 on the Tools tab Cmd+V still puts the picture into the composition", /^Картинка вставлена слоем/.test(await p.status()) && p.ae.log.layerAdds.length === 1 && (await p.page.locator("#refChip").isHidden()), await p.status());
  await p.close();
  p = await open({ clip: "none", footage: IMG, imageSize: { width: 2, height: 2 } });
  await p.page.evaluate((b64) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "image.png", { type: "image/png" });
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    ev.clipboardData = { items: [], files: [file], getData() { return ""; } };
    document.getElementById("prompt").dispatchEvent(ev);
  }, REAL_PNG.toString("base64"));
  await p.page.waitForFunction(() => !document.getElementById("refChip").hidden, null, { timeout: 15000 });
  await p.idle();
  for (let i = 0; i < 20 && p.tempLeft().length; i++) await p.page.waitForTimeout(50);
  check("P13 a picture listed only under the event's files is taken from there, even inside a field", (await p.page.locator("#refText").innerText()) === "Снимок из буфера — картинка" && reads(p) === 0 && p.errors.length === 0 && p.tempLeft().length === 0, await p.status());
  await p.close();

  console.log("\n=== organize project ===");
  const log0 = (x) => false;
  const where = (p) => p.ae.projItems.filter((x) => !(x instanceof p.ae.ctx.FolderItem) || true).map((x) => x.name + "@" + (x.parentFolder ? x.parentFolder.name : "-")).join(" | ");
  const folderOf = (p, n) => { const it = p.ae.projItems.find((x) => x.name === n); return it && it.parentFolder ? it.parentFolder.name : "?"; };
  const organize = async (p) => { await p.tab("motion"); await p.page.click("#organizeBtn"); await p.idle(); };
  const MESSY = [
    { folder: "Мои папки" }, { folder: "Solids" }, { folder: "Old stuff", in: "Мои папки" }, { folder: "images", in: "Мои папки" },
    { name: "intro.mp4", file: "intro.mp4" }, { name: "Clip 02", file: "clip.MOV" }, { name: "seq_[0001-0120].png", file: "seq_0001.png", video: true, duration: 4 },
    { name: "music.mp3", file: "music.mp3", audio: true }, { name: "voice.wav", file: "voice.wav", audio: true, in: "Old stuff" },
    { name: "logo.png", file: "logo.png", still: true }, { name: "photo.jpg", file: "photo.jpg", still: true, in: "images" }, { name: "art.ai", file: "art.ai", still: true },
    { name: "Black Solid 1", solid: true }, { name: "Null 1", solid: true, in: "Solids" },
    { name: "data.json", file: "data.json", video: false }, { name: "model.obj", file: "model.obj", video: false },
    { name: "Missing Footage", placeholder: true }, { name: "lost.xyz", file: "lost.xyz", missing: true, video: false },
    { comp: "Logo Anim", layers: ["logo.png"] }, { comp: "Main", layers: ["Logo Anim", "intro.mp4", "music.mp3"] }, { comp: "Unused idea", layers: [] }
  ];
  p = await open({ org: MESSY });
  check("J1 a 'Project order' block on the Tools tab with the button 'Organize After Effects Project'", (await p.page.locator("#viewMotion .organize-card #organizeBtn").count()) === 1 && (await p.page.locator("#organizeBtn").innerText()).trim() === "Organize After Effects Project");
  await organize(p);
  check("J1 short message: Project organized successfully", /^Project organized successfully\n/.test(await p.status()) && (await p.statusKind()) === "done", await p.status());
  const expect = { "intro.mp4": "Videos", "Clip 02": "Videos", "seq_[0001-0120].png": "Videos", "music.mp3": "Audio", "voice.wav": "Audio", "logo.png": "images", "photo.jpg": "images", "art.ai": "images",
    "Black Solid 1": "Solids", "Null 1": "Solids", "data.json": "Assets", "model.obj": "Assets", "Missing Footage": "Other", "lost.xyz": "Other",
    "Logo Anim": "Precomps", "Main": "Compositions", "Unused idea": "Compositions", "Тест": "Compositions" };
  t = Object.keys(expect).filter((n) => folderOf(p, n) !== expect[n]);
  check("J2 every item goes to its folder: comps, precomps (used inside another comp), videos incl. image sequences, audio, images, solids, assets, other", t.length === 0, t.map((n) => n + "@" + folderOf(p, n)).join(", "));
  check("J3 existing folders are reused (Solids at the top, 'images' even inside another folder), only missing ones are created, at the top level", p.ae.log.bins.slice().sort().join() === "Assets,Audio,Compositions,Other,Precomps,Videos" && p.ae.projItems.filter((x) => log0(x)).length === 0, p.ae.log.bins.join());
  check("J3 no duplicates: one folder per kind", ["solids", "images", "videos", "audio"].every((n) => p.ae.projItems.filter((x) => x instanceof p.ae.ctx.FolderItem && x.name.toLowerCase() === n).length === 1));
  check("J4 items already in the right folder are not touched (photo in 'images', Null in 'Solids')", !p.ae.log.moves.some((m) => /^(photo\.jpg|Null 1) /.test(m)));
  check("J4 user folders themselves stay where they were, nothing is removed or renamed", folderOf(p, "Old stuff") === "Мои папки" && folderOf(p, "images") === "Мои папки" && p.ae.log.removed.length === 0 && MESSY.every((o) => p.ae.projItems.some((x) => x.name === (o.folder || o.comp || o.name))));
  check("J5 links stay: Main still holds Logo Anim, the video and the music", p.ae.projItems.find((x) => x.name === "Main").layer(1).source.name === "Logo Anim" && p.ae.projItems.find((x) => x.name === "Main").layer(3).source.name === "music.mp3");
  check("J6 one undo step", p.ae.log.undo.join("|") === "begin:Sayframe: organize project|end");
  check("J6 the message says what moved and which folders are new", /Перемещено: композиции 3, прекомпозиции 1, видео 3, аудио 2, картинки 2, солиды 1, ресурсы 2, прочее 2\./.test(await p.status()) && /Новые папки: /.test(await p.status()) && /Cmd\/Ctrl\+Z/.test(await p.status()), await p.status());
  await p.page.evaluate(() => document.querySelector(".organize-card").scrollIntoView());
  await p.page.screenshot({ path: path.join(SHOTS, "21i-organize.png") });
  t = p.ae.log.moves.length; c = p.ae.log.bins.length;
  await p.page.click("#organizeBtn"); await p.idle();
  check("J7 a second press moves nothing and creates nothing", p.ae.log.moves.length === t && p.ae.log.bins.length === c && (await p.status()) === "Project organized successfully\nВсё уже лежало по своим папкам." && p.ae.log.undo.length === 2, await p.status());
  await p.close();

  p = await open({ org: [{ folder: "Precomps" }, { comp: "Parked", in: "Precomps" }, { folder: "COMPS" }, { comp: "Shot", layers: ["Inner"] }, { comp: "Inner", in: "COMPS" }, { name: "a.mp3", file: "a.mp3", audio: true }, { folder: "Audio / MP3" }] });
  await organize(p);
  check("J8 an unused comp parked in Precomps stays; a used comp leaves the comps folder for Precomps; folder names match regardless of case ('COMPS', 'Audio / MP3')", folderOf(p, "Parked") === "Precomps" && folderOf(p, "Inner") === "Precomps" && folderOf(p, "Shot") === "COMPS" && folderOf(p, "Тест") === "COMPS" && folderOf(p, "a.mp3") === "Audio / MP3" && p.ae.log.bins.length === 0, where(p));
  await p.close();

  p = await open({ org: [{ folder: "Compositions" }], noActiveComp: false });
  p.ae.projItems.splice(0, 1);
  await organize(p);
  check("J9 a project with nothing to sort: the same short message, nothing created", (await p.status()) === "Project organized successfully\nВ проекте пока нечего раскладывать." && p.ae.log.bins.length === 0 && p.ae.log.undo.length === 0, await p.status());
  await p.close();

  console.log("\n=== FX Console ===");
  const PRESETS = { "Blurs/Soft Blur.ffx": "x", "Transitions - Movement/Slide In.ffx": "x", "readme.txt": "x" };
  const fxNames = (p) => p.page.locator("#fxList .fx-item .fx-name").allInnerTexts();
  const fxType = async (p, text) => { await p.page.fill("#fxSearch", text); await p.page.waitForTimeout(30); };
  const fxReady = (p) => p.page.waitForFunction(() => !document.querySelector("#fxList .fx-note") || !/Загружаю/.test(document.querySelector("#fxList .fx-note").textContent));
  let FL1 = mkFxLayer("Фон"), FL2 = mkFxLayer("Текст"), FLc = mkFxLayer("Камера", "camera");
  p = await open({ presets: PRESETS, userPresets: { "Мой свет.ffx": "x" }, selectedLayers: [FL1, FL2, FLc] });
  check("FX1 a magnifier next to the gear opens the search, the cursor is in the field", (await p.page.locator(".top-actions #fxBtn + #settingsBtn").count()) === 1 && (await p.page.locator("#fxConsole").isHidden()));
  await p.page.click("#fxBtn"); await fxReady(p);
  check("FX1 the console is open and focused, an empty search explains what to type", (await p.page.locator("#fxConsole").isVisible()) && (await p.page.evaluate(() => document.activeElement.id)) === "fxSearch" && /Начните печатать/.test(await p.page.locator("#fxList").innerText()));
  await p.page.screenshot({ path: path.join(SHOTS, "23-fx-console-empty.png") });
  await fxType(p, "blur");
  t = await fxNames(p);
  check("FX2 'blur' finds the blur effects first, then the preset with that name; nameless effects and non-preset files are left out", t.join() === "Fast Box Blur,Gaussian Blur,Directional Blur,Soft Blur", t.join());
  check("FX2 every row shows the kind and the category", (await p.page.locator("#fxList .fx-item").first().locator(".fx-badge").innerText()).toLowerCase() === "fx" && (await p.page.locator("#fxList .fx-item").first().locator(".fx-cat").innerText()) === "Blur & Sharpen" && (await p.page.locator("#fxList .fx-item").last().locator(".fx-badge").innerText()).toLowerCase() === "пресет");
  await p.page.screenshot({ path: path.join(SHOTS, "24-fx-console-blur.png") });
  await fxType(p, "gaus");
  await p.page.keyboard.press("Enter"); await p.idle();
  check("FX3 Enter puts the effect on the selected layers, cameras are skipped; one undo step; the console closes", FL1.effects.join() === "ADBE Gaussian Blur 2" && FL2.effects.join() === "ADBE Gaussian Blur 2" && FLc.effects.length === 0 && p.ae.log.undo.join("|") === "begin:Sayframe: Gaussian Blur|end" && (await p.page.locator("#fxConsole").isHidden()));
  check("FX3 the status says what was added and where", (await p.status()) === "Эффект «Gaussian Blur» добавлен на 2 слоя. Пропущено: 1 слой (камера или свет). Отменить — Cmd/Ctrl+Z." && (await p.statusKind()) === "done", await p.status());
  await p.page.click("#fxBtn"); await fxReady(p);
  check("FX4 opened again with an empty field: the last used effect is under 'Recent'", (await p.page.locator("#fxList .fx-head").allTextContents()).join() === "Недавние" && (await fxNames(p)).join() === "Gaussian Blur");
  await fxType(p, "glow");
  await p.page.locator("#fxList .fx-item .fx-star").first().click();
  check("FX4 the star marks a favourite and keeps the cursor in the search", (await p.page.locator("#fxList .fx-star.on").count()) === 1 && (await p.page.evaluate(() => document.activeElement.id)) === "fxSearch");
  await fxType(p, "");
  check("FX4 favourites come first, then recent ones", (await p.page.locator("#fxList .fx-head").allTextContents()).join() === "Избранное,Недавние" && (await fxNames(p)).join() === "Glow,Gaussian Blur");
  await fxType(p, "c");
  t = await fxNames(p);
  await p.page.keyboard.press("ArrowDown"); await p.page.keyboard.press("ArrowDown"); await p.page.keyboard.press("ArrowUp");
  check("FX5 arrows move the highlight", (await p.page.locator("#fxList .fx-item.active .fx-name").innerText()) === t[1], t.join());
  await p.page.keyboard.press("Escape");
  check("FX5 Esc closes without adding anything", (await p.page.locator("#fxConsole").isHidden()) && FL1.effects.length === 1);
  await p.page.click("#fxBtn"); await fxReady(p);
  await fxType(p, "slide");
  await p.page.locator("#fxList .fx-item").first().click(); await p.idle();
  check("FX6 a preset is applied from its file to every layer that can take it", FL1.presets.length === 1 && /Presets\/Transitions - Movement\/Slide In\.ffx$/.test(FL1.presets[0]) && FL2.presets.length === 1 && (await p.status()) === "Пресет «Slide In» добавлен на 2 слоя. Пропущено: 1 слой (камера или свет). Отменить — Cmd/Ctrl+Z.", await p.status());
  await p.page.click("#fxBtn"); await fxReady(p);
  await fxType(p, "мой");
  check("FX6 user presets are found too, marked as 'My presets'", (await fxNames(p)).join() === "Мой свет" && (await p.page.locator("#fxList .fx-cat").innerText()) === "Мои пресеты");
  await fxType(p, "zzzz");
  check("FX6 nothing found -> a hint", /Ничего не нашлось/.test(await p.page.locator("#fxList").innerText()));
  await p.page.keyboard.press("Escape");
  await p.restart();
  await p.page.click("#fxBtn"); await fxReady(p);
  check("FX7 favourites and recent ones survive a restart", (await fxNames(p)).join() === "Glow,Slide In,Gaussian Blur", (await fxNames(p)).join());
  await p.page.click("#fxClose");
  check("FX7 the cross closes it", await p.page.locator("#fxConsole").isHidden());
  await p.close();

  p = await open({ selectedLayers: [] });
  await p.page.click("#fxBtn"); await fxReady(p); await fxType(p, "glow"); await p.page.keyboard.press("Enter"); await p.idle();
  check("FX8 no layer selected -> a hint, nothing added", /^Выделите слой/.test(await p.status()) && (await p.statusKind()) === "" && p.ae.log.undo.length === 0, await p.status());
  await p.close();
  p = await open({ selectedLayers: [mkFxLayer("A")], noActiveComp: true });
  await p.page.click("#fxBtn"); await fxReady(p); await fxType(p, "glow"); await p.page.keyboard.press("Enter"); await p.idle();
  check("FX8 no comp open -> a hint", /^Откройте композицию/.test(await p.status()), await p.status());
  await p.close();

  // Snapshot: PNG of the frame under the time indicator, saved and copied to the clipboard.
  p = await open({ compTime: 2.5 });
  await p.page.click("#fxBtn"); await p.page.click("#fxSnap"); await p.idle();
  t = fs.existsSync(path.join(p.home, "Documents", "Sayframe Snapshots")) ? fs.readdirSync(path.join(p.home, "Documents", "Sayframe Snapshots")) : [];
  check("FX9 'snapshot' saves the current frame as a PNG named after the comp", t.length === 1 && /^Тест_\d{4}-\d{2}-\d{2}_\d{6}\.png$/.test(t[0]) && p.ae.log.snaps[0].t === 2.5, t.join());
  check("FX9 and copies it to the clipboard", (p.sys.copied || []).length === 1 && p.sys.copied[0].indexOf("«class PNGf»") > 0 && p.sys.copied[0].indexOf(t[0]) > 0, JSON.stringify(p.sys.copied));
  check("FX9 the status says where it is", (await p.status()) === "Кадр сохранён: Документы › Sayframe Snapshots › " + t[0] + ". Он же в буфере обмена — можно сразу вставить." && (await p.page.locator("#fxConsole").isHidden()), await p.status());
  await p.close();
  p = await open({ copyFails: true });
  await p.page.click("#fxBtn"); await p.page.click("#fxSnap"); await p.idle();
  check("FX9 if the clipboard refuses, the file is still saved and the status says so", /В буфер обмена скопировать не получилось\.$/.test(await p.status()) && (await p.statusKind()) === "done", await p.status());
  await p.close();
  p = await open({ noActiveComp: true });
  await p.page.click("#fxBtn"); await p.page.click("#fxSnap"); await p.idle();
  check("FX9 no comp -> a hint", /^Откройте композицию/.test(await p.status()), await p.status());
  await p.close();

  console.log("\n=== hotkeys ===");
  p = await open({ selectedLayers: [mkFxLayer("A")] });
  t = await p.page.evaluate(() => window.__keyInterest.map((x) => JSON.parse(x)));
  check("H1 the panel asks After Effects to pass it the shortcut keys (Ctrl+Space on a Mac = key 49)", t.length === 1 && JSON.stringify(t[0]) === JSON.stringify([{ keyCode: 49, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }]), JSON.stringify(t));
  check("H1 the magnifier's tooltip names the shortcut", (await p.page.getAttribute("#fxBtn", "title")) === "Поиск эффектов (⌃Space)");
  await p.page.click("#prompt");
  await p.page.keyboard.press("Control+Space");
  check("H2 Ctrl+Space opens the console, even from the prompt field", (await p.page.locator("#fxConsole").isVisible()) && (await p.page.evaluate(() => document.activeElement.id)) === "fxSearch");
  await p.page.keyboard.press("Control+Space");
  check("H2 and closes it again", await p.page.locator("#fxConsole").isHidden());
  await p.page.click("#fxBtn");
  check("H3a the search window shows its shortcut with a link to change it", (await p.page.locator("#fxKeys").innerText()) === "Сочетание для поиска: ⌃Space — изменить");
  await p.page.click("#fxKeys");
  check("H3a the link opens the settings on 'General' with the search shortcut waiting for a new key", (await p.page.locator("#settingsSheet").isVisible()) && (await p.page.locator("#fxConsole").isHidden()) && (await p.page.locator("#setTabOther").getAttribute("aria-selected")) === "true" && (await p.page.locator('#hotkeys [data-action="console"]').innerText()) === "Нажмите сочетание…");
  await p.page.keyboard.press("Escape");
  await p.page.click("#settingsClose");
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
  t = await p.page.locator("#hotkeys .hotkey-row span").allInnerTexts();
  check("H3 settings list every action with its shortcut", t.join() === "Поиск эффектов (FX Console),Снимок кадра,Organize After Effects Project,Вставить картинку из буфера,Вкладка AI,Вкладка «Анимация»,Вкладка «Инструменты»" && (await p.page.locator("#hotkeys .hotkey-btn").allInnerTexts()).join() === "⌃Space,—,—,—,—,—,—", t.join());
  await p.page.locator("#hotkeys").scrollIntoViewIfNeeded();
  await p.page.screenshot({ path: path.join(SHOTS, "25-hotkeys-settings.png") });
  await p.page.click('#hotkeys [data-action="console"]');
  check("H4 a click waits for the new shortcut", (await p.page.locator('#hotkeys [data-action="console"]').innerText()) === "Нажмите сочетание…");
  check("H4 while waiting, After Effects is asked to pass every key combination to the panel", (await p.page.evaluate(() => JSON.parse(window.__keyInterest[window.__keyInterest.length - 1]).length)) > 500);
  await p.page.screenshot({ path: path.join(SHOTS, "26-hotkey-editor.png") });
  await p.page.keyboard.press("KeyK");
  check("H4 a plain letter is refused with a hint", /Нужно сочетание/.test(await p.page.locator("#hotkeyNote").innerText()) && (await p.page.locator('#hotkeys [data-action="console"]').innerText()) === "Нажмите сочетание…");
  await p.page.keyboard.press("Meta+KeyC");
  check("H4 Cmd+C is kept for copying", /занято/.test(await p.page.locator("#hotkeyNote").innerText()));
  await p.page.keyboard.press("Alt+KeyF");
  check("H4 Alt+F is taken, the layout does not matter (key position)", (await p.page.locator('#hotkeys [data-action="console"]').innerText()) === "⌥F" && (await p.page.locator("#hotkeyNote").innerText()) === "");
  await p.page.click('#hotkeys [data-action="tabTools"]'); await p.page.keyboard.press("Alt+Digit3");
  await p.page.click('#hotkeys [data-action="organize"]'); await p.page.keyboard.press("F6");
  await p.page.click('#hotkeys [data-action="snapshot"]'); await p.page.keyboard.press("Alt+KeyF");
  check("H5 giving the same shortcut to another action takes it from the first one, with a note", (await p.page.locator('#hotkeys [data-action="snapshot"]').innerText()) === "⌥F" && (await p.page.locator('#hotkeys [data-action="console"]').innerText()) === "—" && /было у «Поиск эффектов/.test(await p.page.locator("#hotkeyNote").innerText()));
  await p.page.click('#hotkeys [data-action="snapshot"]'); await p.page.keyboard.press("Backspace");
  await p.page.click('#hotkeys [data-action="console"]'); await p.page.keyboard.press("Control+Shift+KeyE");
  await p.page.click('#hotkeys [data-action="paste"]'); await p.page.keyboard.press("Escape");
  check("H5 Backspace clears, Esc cancels and leaves the settings open", (await p.page.locator('#hotkeys [data-action="snapshot"]').innerText()) === "—" && (await p.page.locator('#hotkeys [data-action="paste"]').innerText()) === "—" && (await p.page.locator("#settingsSheet").isVisible()));
  await p.page.click('#hotkeys [data-action="tabAI"]');
  await p.page.click('.hotkey-edit [data-mod="Alt"]'); await p.page.selectOption(".hotkey-edit select", "1");
  await p.page.locator(".hotkey-edit button", { hasText: "Готово" }).click();
  check("H5b the shortcut can also be put together with the mouse (for keys After Effects keeps to itself)", (await p.page.locator('#hotkeys [data-action="tabAI"]').innerText()) === "⌥1" && (await p.page.locator(".hotkey-edit").count()) === 0);
  await p.page.click('#hotkeys [data-action="tabAI"]');
  await p.page.locator(".hotkey-edit button", { hasText: "Убрать" }).click();
  check("H5b 'Remove' clears it", (await p.page.locator('#hotkeys [data-action="tabAI"]').innerText()) === "—");
  await p.page.click('#hotkeys [data-action="tabAI"]');
  await p.page.locator(".hotkey-edit button", { hasText: "Готово" }).click();
  check("H5b 'Done' without a key explains what is missing", /Нужно сочетание/.test(await p.page.locator("#hotkeyNote").innerText()));
  await p.page.locator(".hotkey-edit button", { hasText: "Отмена" }).click();
  t = await p.page.evaluate(() => JSON.parse(window.__keyInterest[window.__keyInterest.length - 1]));
  check("H5b after editing only the real shortcuts are passed to the panel again", t.length === 3, JSON.stringify(t));
  await p.page.click("#saveSettings");
  t = await p.page.evaluate(() => JSON.parse(window.__keyInterest[window.__keyInterest.length - 1]));
  check("H6 saved; After Effects is told about the new keys", JSON.stringify(t.map((x) => x.keyCode).sort((a, b) => a - b)) === JSON.stringify([14, 20, 97]) && (await p.page.getAttribute("#fxBtn", "title")) === "Поиск эффектов (⌃⇧E)", JSON.stringify(t));
  await p.page.keyboard.press("Control+Space");
  check("H6 the old shortcut does nothing now", await p.page.locator("#fxConsole").isHidden());
  await p.page.keyboard.press("Control+Shift+KeyE");
  check("H6 the new one opens the console", await p.page.locator("#fxConsole").isVisible());
  await p.page.keyboard.press("Escape");
  await p.page.keyboard.press("Alt+Digit3");
  check("H7 a tab shortcut switches tabs", (await p.page.locator("#tabMotion").getAttribute("aria-selected")) === "true");
  await p.page.keyboard.press("F6"); await p.idle();
  check("H7 an action shortcut runs it (F6 -> Organize)", /^Project organized successfully/.test(await p.status()), await p.status());
  await p.restart();
  await p.page.keyboard.press("Control+Shift+KeyE");
  check("H8 shortcuts survive a restart", await p.page.locator("#fxConsole").isVisible());
  await p.page.keyboard.press("Escape");
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
  await p.page.click('#hotkeys [data-action="console"]'); await p.page.keyboard.press("Alt+KeyQ");
  await p.page.click("#settingsClose");
  await p.page.keyboard.press("Alt+KeyQ");
  check("H8 a new shortcut is kept at once, even if the settings are closed without 'Save'", await p.page.locator("#fxConsole").isVisible());
  await p.page.keyboard.press("Escape");
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther"); await p.page.click("#hotkeysReset"); await p.page.click("#saveSettings");
  await p.page.keyboard.press("Control+Space");
  check("H8 'Reset' brings back Ctrl+Space and clears the rest", (await p.page.locator("#fxConsole").isVisible()) && p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  console.log("\n=== settings ===");
  p = await open({ settings: null });
  await p.page.click("#settingsBtn");
  await p.page.fill("#apiKey", "  sk-ant-abc  ");
  await p.page.locator("#models button", { hasText: "Opus 5.5" }).click();
  check("S0 settings open on the AI section: provider, key, model, checks and reference frames; colours and shortcuts are under 'General'", (await p.page.locator("#setTabAI").getAttribute("aria-selected")) === "true" && (await p.page.locator("#apiKey").isVisible()) && (await p.page.locator("#frames").isVisible()) && (await p.page.locator("#selfCheck").isVisible() || await p.page.locator("label.switch", { hasText: "проверяет результат" }).isVisible()) && (await p.page.locator("#accentSwatches").isHidden()) && (await p.page.locator("#hotkeys").isHidden()));
  await p.page.click("#setTabOther");
  check("S0 'General' holds colours, width, blocks and shortcuts; the AI fields are hidden", (await p.page.locator("#accentSwatches").isVisible()) && (await p.page.locator("#panelWidth").isVisible()) && (await p.page.locator("#toolSize").isVisible()) && (await p.page.locator("#hotkeys").isVisible()) && (await p.page.locator("#apiKey").isHidden()) && (await p.page.locator("#setTabOther").getAttribute("aria-selected")) === "true");
  await p.page.screenshot({ path: path.join(SHOTS, "07b-settings-general.png") });
  await p.page.locator("#accentSwatches button").nth(1).click();
  await p.page.click("#setTabAI");
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
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
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
  const spans = (p) => p.page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("#app > .view:not(#viewMotion), #app .view:not([hidden]):not(#viewMotion) > *, .sheet:not([hidden]) .sheet-card, .modal:not([hidden]) .modal-card")).filter((el) => el.offsetParent !== null || el.getClientRects().length).map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }).filter((x) => x[1] > x[0]));
  const within = (list, left, right) => list.length > 0 && list.every((x) => x[0] >= left && x[1] <= right);
  const overflow = (p) => p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const setWidth = async (p, v) => { if (await p.page.locator("#setTabOther").isVisible()) await p.page.click("#setTabOther"); return setWidth0(p, v); };
  const setWidth0 = (p, v) => p.page.evaluate((v) => { const el = document.getElementById("panelWidth"); el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);

  p = await open({ width: 380 });
  check("W1 at 380px the panel looks as before: content fills it", (await box(p, "#tabs")).split(",")[0] === "14" && (await box(p, "#tabs")).split(",")[2] === "352" && (await box(p, "#runBtn")).split(",")[2] === "326", await box(p, "#tabs") + " | " + await box(p, "#runBtn"));
  await p.close();

  p = await open({ width: 1000, replies: [msg("Создаю.\n```javascript\napp.__ran('ask');\n```")], settings: { alwaysAsk: true } });
  t = await spans(p);
  check("W2 in a wide panel the fields and buttons do not stretch: they stay in the 380px column on the left", within(t, 14, 366) && (await box(p, ".composer")).split(",")[2] === "352" && (await overflow(p)) <= 0, JSON.stringify(t));
  check("W2 the header and the tab bar stretch with the panel: gear at the right edge, tabs across the whole width", (await box(p, "#tabs")).split(",")[0] === "14" && (await box(p, "#tabs")).split(",")[2] === "972" && (await box(p, ".top")).split(",")[2] === "972" && (await box(p, "#settingsBtn")).split(",")[0] === "954" && (await p.page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return r("tabClaude").left < r("tabTools").left && r("tabTools").left < r("tabMotion").left && r("tabMotion").right > 900 && r("tabClaude").width > 150; })), (await box(p, "#tabs")) + " | " + (await box(p, "#settingsBtn")));
  c = [await box(p, "#runBtn"), await box(p, "#prompt"), await box(p, ".composer")].join(" | ");
  await p.page.setViewportSize({ width: 1600, height: 900 });
  check("W2 stretching the panel further moves and resizes none of the fields, only the tab bar grows", [await box(p, "#runBtn"), await box(p, "#prompt"), await box(p, ".composer")].join(" | ") === c && (await box(p, "#tabs")).split(",")[2] === "1572" && (await box(p, "#settingsBtn")).split(",")[0] === "1554" && (await overflow(p)) <= 0, c + " tabs " + await box(p, "#tabs"));
  await p.page.setViewportSize({ width: 1000, height: 760 });
  await p.page.screenshot({ path: path.join(SHOTS, "09b-wide-panel.png") });
  await p.page.click("#tabTools");
  check("W2 Tools tab stays in the column", within(await spans(p), 14, 366), JSON.stringify(await spans(p)));
  await p.page.click("#tabMotion");
  t = await p.page.evaluate(() => { const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)]; }; return { tabs: r("#tabs"), top: r(".top"), status: r("#statusBox"), tools: r("#motionTools"), cards: Array.prototype.map.call(document.querySelectorAll("#motionTools .tool-card"), (c) => { const b = c.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width)]; }) }; });
  check("W2 Animation tab in a wide panel: tabs and blocks get the whole width, the status line stays in the column", t.tabs.join() === "14,986" && t.top.join() === "14,986" && t.status[1] <= 366 && t.tools.join() === "14,986" && (await overflow(p)) <= 0, JSON.stringify(t));
  check("W2 the blocks are not stretched: 4 cells (168px) each, five side by side in one row, the sixth below", t.cards.map((c) => c[2]).join() === "168,168,168,168,168,168" && t.cards.map((c) => c[0]).join() === "14,190,366,542,718,718" && t.cards.slice(0, 5).every((c) => c[1] === t.cards[0][1]) && t.cards[5][1] > t.cards[4][1] && (await box(p, "#easeIn")).split(",")[2] === (await box(p, "#easeOut")).split(",")[2], JSON.stringify(t.cards));
  await p.page.click("#tabClaude");
  await p.page.fill("#prompt", "сделай слой"); await p.page.click("#runBtn");
  await p.page.waitForSelector("#modal:not([hidden])");
  check("W2 the confirmation dialog sits over the column, not in the middle of the wide panel", within(await spans(p), 14, 366), JSON.stringify(await spans(p)));
  await p.page.locator("#modalButtons button").last().click(); await p.idle();
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
  check("W2 settings stay in the column", within(await spans(p), 14, 366) && (await p.page.inputValue("#panelWidth")) === "380" && (await p.page.locator("#panelWidthVal").innerText()) === "380 px", JSON.stringify(await spans(p)));

  await setWidth(p, 520);
  t = await spans(p);
  check("W3 the width slider previews live", within(t, 14, 506) && (await box(p, ".sheet-card")).split(",")[2] === "492" && (await p.page.locator("#panelWidthVal").innerText()) === "520 px" && (await box(p, ".composer")).split(",")[2] === "492" && (await box(p, "#tabs")).split(",")[2] === "972", JSON.stringify(t));
  await p.page.click("#settingsClose");
  check("W3 closing without saving puts the old width back", (await box(p, ".composer")).split(",")[2] === "352" && (await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.settings.v1")).panelWidth)) !== 520);
  await p.page.click("#settingsBtn"); await setWidth(p, 520); await p.page.click("#saveSettings");
  check("W3 saved width applies to the fields and buttons", (await box(p, ".composer")).split(",")[2] === "492" && (await box(p, "#runBtn")).split(",")[2] === "466" && (await box(p, ".composer")).split(",")[0] === "14" && (await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.settings.v1")).panelWidth)) === 520);
  await p.page.screenshot({ path: path.join(SHOTS, "09c-wide-panel-520.png") });
  await p.restart();
  check("W3 the width survives a restart", (await box(p, ".composer")).split(",")[2] === "492" && p.errors.length === 0, p.errors.join(" | "));
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
  check("W3 settings show the saved width", (await p.page.inputValue("#panelWidth")) === "520" && (await p.page.locator("#panelWidthVal").innerText()) === "520 px");
  await p.page.focus("#panelWidth"); await p.page.keyboard.press("ArrowRight");
  check("W3 the slider works from the keyboard in steps of 10", (await p.page.locator("#panelWidthVal").innerText()) === "530 px" && (await box(p, ".sheet-card")).split(",")[2] === "502");
  await setWidth(p, 280); await p.page.click("#saveSettings");
  t = await spans(p);
  check("W3 the narrowest width still fits everything", within(t, 14, 266) && (await overflow(p)) <= 0, JSON.stringify(t));
  await p.page.click("#tabMotion");
  t = await p.page.evaluate(() => { const g = document.getElementById("anchorGrid").getBoundingClientRect(), a = document.getElementById("easeIn").getBoundingClientRect(); return [Math.round(g.right), Math.round(a.width)]; });
  check("W3 the width setting does not squeeze the Animation blocks: they use the panel itself", (await box(p, "#tabs")).split(",")[2] === "972" && (await box(p, "#motionTools")).split(",")[2] === "972" && t[1] > 30 && (await overflow(p)) <= 0, JSON.stringify(t) + " " + await box(p, "#motionTools"));
  await p.page.screenshot({ path: path.join(SHOTS, "09d-wide-panel-280.png") });
  await p.close();

  p = await open({ width: 300, settings: { panelWidth: 520 } });
  t = await spans(p);
  check("W4 a panel narrower than the chosen width: content shrinks to fit, no sideways scroll", within(t, 14, 286) && (await box(p, ".composer")).split(",")[2] === "272" && (await box(p, "#tabs")).split(",")[2] === "272" && (await overflow(p)) <= 0, JSON.stringify(t));
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
  check("T1 opens on the Claude tab", (await vis(p, "#prompt")) && (await vis(p, "#runBtn")) && (await vis(p, "#refBtn")) && (await vis(p, "#newBtn")) && !(await vis(p, "#viewTools .empty-note")) && (await p.page.locator("#tabClaude").getAttribute("aria-selected")) === "true");
  check("T1 status line is inside the Claude tab", (await p.page.locator("#viewClaude #statusBox").count()) === 1 && (await vis(p, "#status")));
  await p.page.screenshot({ path: path.join(SHOTS, "16-tab-claude.png") });
  await p.tab("tools");
  check("T2 Tools tab shows only the tools", (await vis(p, "#viewTools .empty-note")) && !(await vis(p, "#prompt")) && !(await vis(p, "#runBtn")) && !(await vis(p, "#refBtn")) && !(await vis(p, "#newBtn")) && !(await vis(p, "#fixBtn")) && (await p.page.locator("#tabTools").getAttribute("aria-selected")) === "true" && (await p.page.locator("#tabClaude").getAttribute("aria-selected")) === "false");
  check("T2 status line moved to the Tools tab", (await p.page.locator("#viewTools #statusBox").count()) === 1 && (await p.page.locator("#statusBox").count()) === 1 && (await vis(p, "#status")));
  await p.page.screenshot({ path: path.join(SHOTS, "17-tab-tools.png") });
  check("T2 the Animation tab is empty for now and says so; the paste block lives on the Tools tab (internal name motion)", (await p.page.locator("#tabTools").innerText()) === "Анимация" && (await p.page.locator("#tabMotion").innerText()) === "Инструменты" && (await p.page.locator("#viewMotion #pasteBtn").count()) === 1 && (await p.page.locator("#viewTools button").count()) === 0);
  await p.paste(); await p.idle(); await p.modalClick("Оставить как есть");
  check("T3 the paste block reports its result on its tab", /^Картинка вставлена/.test(await p.status()) && (await vis(p, "#status")) && (await p.page.locator("#viewMotion #statusBox").count()) === 1 && p.ae.log.imports.length === 1, await p.status());
  t = await p.status();
  await p.tab("claude");
  check("T3 the same status is shown after switching back", (await p.status()) === t && (await vis(p, "#status")) && (await vis(p, "#prompt")));
  await p.run("сделай слой");
  check("T4 Claude still works from its tab", p.ae.log.ran.join() === "one" && /^Готово: Создаю слой\./.test(await p.status()) && (await vis(p, "#replyCard")));
  await p.tab("tools");
  check("T4 the reply card stays on the Claude tab", !(await vis(p, "#replyCard")) && /^Готово: Создаю слой\./.test(await p.status()));
  await p.restart();
  check("T5 the open tab is remembered", (await vis(p, "#viewTools .empty-note")) && !(await vis(p, "#prompt")) && (await p.page.locator("#viewTools #statusBox").count()) === 1);
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
  check("O1 a single click only switches the tab", (await vis(p, "#viewTools .empty-note")) && !(await arrangingNow(p)));
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
  check("O2 dragging does not switch tabs or leave marks, rearranging stays on", (await vis(p, "#prompt")) && !(await vis(p, "#viewTools .empty-note")) && (await p.page.locator(".dragging, .reordering").count()) === 0 && (await arrangingNow(p)));
  t = await p.page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect().left; return r("tabTools") < r("tabClaude"); });
  check("O2 Tools is now drawn on the left", t === true);
  await p.page.screenshot({ path: path.join(SHOTS, "20-tabs-swapped.png") });
  await p.page.waitForTimeout(350);
  await p.tab("tools");
  check("O3 clicking still switches tabs after a drag, also while rearranging", (await vis(p, "#viewTools .empty-note")) && !(await vis(p, "#prompt")) && (await arrangingNow(p)));
  await p.page.click("#arrangeDone");
  check("O3 'Done' switches rearranging off", !(await arrangingNow(p)) && !(await vis(p, "#arrangeBar")) && (await order(p)) === "tools,claude,motion");
  await p.page.waitForTimeout(350);
  await dragTab(p, "#tabTools", "#tabClaude");
  check("O3 after 'Done' tabs do not move any more", (await order(p)) === "tools,claude,motion");
  await p.page.waitForTimeout(350);
  await p.paste(); await p.idle(); await p.modalClick("Оставить как есть");
  check("O3 tools still work in the new order", /^Картинка вставлена/.test(await p.status()), await p.status());
  await p.page.click("#tabTools");
  await p.restart();
  check("O4 order and open tab survive a restart; rearranging does not", (await order(p)) === "tools,claude,motion" && (await vis(p, "#viewTools .empty-note")) && (await p.page.locator("#tabTools").getAttribute("aria-selected")) === "true" && !(await arrangingNow(p)));
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
  check("O10 dragging a tab that is not open does not open it", (await vis(p, "#prompt")) && !(await vis(p, "#viewTools .empty-note")) && (await p.page.locator("#tabClaude").getAttribute("aria-selected")) === "true");
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
  const live = (p) => p.page.waitForFunction(() => !document.querySelector(".ease-card[data-live]"), null, { timeout: 15000 });
  const fillOf = (p, id) => p.page.locator("#" + id).evaluate((el) => el.style.getPropertyValue("--v"));
  let clock, prop1, prop2, grp, L, L2, before;

  p = await open({});
  check("M1 three tabs, Animation closed at first", (await order(p)) === "claude,tools,motion" && !(await vis(p, "#easeBothBtn")));
  await motionTab(p);
  check("M1 Animation tab shows both tools and nothing from the other tabs", (await vis(p, "#easeBothBtn")) && (await vis(p, "#anchorGrid")) && (await p.page.locator("#anchorGrid button").count()) === 9 && !(await vis(p, "#prompt")) && !(await vis(p, "#viewTools .empty-note")) && (await p.page.locator("#viewMotion #statusBox").count()) === 1);
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
  await live(p);
  check("M3 moving a slider with no keys selected -> a hint, not an error, nothing is locked", /^Выделите ключевые кадры на таймлайне — /.test(await p.status()) && (await p.statusKind()) === "" && !(await p.page.locator("#easeOut").isDisabled()) && p.errors.length === 0, await p.status());
  p.ae.log.undo.length = 0;
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
  const toggle = async (p) => { const b = p.page.locator("#easeCurveToggle"); return [await b.getAttribute("aria-expanded"), await b.getAttribute("title"), (await p.page.locator("#easeCurveToggle .tool-toggle-plus").evaluate((el) => getComputedStyle(el).display)) !== "none" ? "+" : "-"].join("|"); };
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
  const CELL = 44;   // one large cell with its gap
  const by = (pt, dx, dy) => ({ x: pt.x + dx, y: pt.y + (dy || 0) });
  const topOf = (r) => ({ x: (r.l + r.r) / 2, y: r.t + 20 });   // a point near the top: tall blocks may end below the window
  // Where each block sits on the grid: "name:column,row,width,height" in cells.
  const cellsNow = (p) => p.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#motionTools .tool-card"), (c) => { const a = /^(\d+) \/ span (\d+)$/.exec(c.style.gridColumn), b = /^(\d+) \/ span (\d+)$/.exec(c.style.gridRow); return c.getAttribute("data-tool") + ":" + (a[1] - 1) + "," + (b[1] - 1) + "," + a[2] + "," + b[2]; }).join(" "));
  const savedPlaces = (p) => p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.motion.v1") || "{}").places || "");
  const resizeTo = async (p, w) => { await p.page.setViewportSize({ width: w, height: 760 }); await p.page.waitForTimeout(80); };

  p = await open({});
  await motionTab(p);
  t = await toolRects(p);
  check("R1 at 380px easing and anchor stand side by side, align goes to the row below at the same size", (await toolOrder(p)) === "ease,anchor,align,shift,paste,organize" && t.ease.t === t.anchor.t && t.ease.r < t.anchor.l && t.ease.w === 168 && t.anchor.w === 168 && t.align.w === 168 && t.ease.l === 14 && t.anchor.r === 358 && t.align.t >= t.ease.b && t.align.l === 14, JSON.stringify(t));
  t = await p.page.evaluate(() => { const g = document.getElementById("motionTools"), cs = getComputedStyle(g); return [cs.display, cs.gridAutoRows, cs.rowGap, cs.columnGap, g.style.gridTemplateColumns].join("|"); });
  check("R1 the blocks stand on a grid of 36px cells with 8px gaps, 8 cells across at 380px", t === "grid|36px|8px|8px|repeat(8, 36px)", t);
  t = await p.page.evaluate(() => Array.prototype.every.call(document.querySelectorAll("#motionTools .tool-card"), (c) => { const r = c.getBoundingClientRect(), g = document.getElementById("motionTools").getBoundingClientRect(); return (r.left - g.left) % 44 === 0 && (r.top - g.top) % 44 === 0 && (r.width + 8) % 44 === 0 && (r.height + 8) % 44 === 0; }));
  check("R1 every block starts on a cell and is a whole number of cells wide and tall", t);
  t = await p.page.evaluate(() => { const inside = (card) => { const c = card.getBoundingClientRect(); return Array.prototype.every.call(card.querySelectorAll("input, button, select, svg, b, label"), (el) => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.left >= c.left - 0.5 && r.right <= c.right + 0.5); }); }; return Array.prototype.map.call(document.querySelectorAll("#motionTools .tool-card"), inside).join(); });
  check("R1 nothing sticks out of any block", t === "true,true,true,true,true,true" && (await overflow(p)) <= 0, t);
  t = await p.page.evaluate(() => [document.getElementById("easeIn").getBoundingClientRect().width, document.getElementById("easeOut").getBoundingClientRect().width, document.getElementById("anchorGrid").getBoundingClientRect().width].map(Math.round));
  check("R1 sliders stay usable and the arrow grid keeps its size", t[0] === t[1] && t[0] >= 40 && t[2] >= 118, t.join());
  await p.page.screenshot({ path: path.join(SHOTS, "21d-tools-side-by-side.png") });

  // Without the double click nothing can be dragged.
  t = await toolRects(p);
  await dragFrom(p, { x: t.ease.l + 6, y: t.ease.b - 5 }, { x: t.ease.l + 6 + 4 * CELL, y: t.ease.b - 5 });
  check("R2 without a double click a block cannot be dragged", (await toolOrder(p)) === "ease,anchor,align,shift,paste,organize" && (await savedTools(p)) !== "anchor,ease,align,shift,paste,organize" && (await p.page.locator("#motionTools .dragging").count()) === 0);
  c = await center(p, "#easeOut");
  await dragFrom(p, c, { x: middle(t.anchor).x + 20, y: c.y });
  check("R2 the sliders work as usual", (await toolOrder(p)) === "ease,anchor,align,shift,paste,organize" && (await p.page.inputValue("#easeOut")) === "100", await p.page.inputValue("#easeOut"));
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
  await dragFrom(p, c, by(c, 4 * CELL + 3, 4));
  t = await toolRects(p);
  check("R3 now the block is dragged by any place, even over a slider; dropped on the other block's cells, they swap", (await toolOrder(p)).indexOf("anchor,ease,") === 0 && t.anchor.r < t.ease.l && t.anchor.l === 14 && t.ease.l === 190 && /ease=4,0/.test(await savedPlaces(p)) && /anchor=0,0/.test(await savedPlaces(p)) && (await savedTools(p)).indexOf("anchor,ease,") === 0 && (await p.page.inputValue("#easeOut")) === "60", await toolOrder(p) + " " + await p.page.inputValue("#easeOut"));
  check("R3 no leftovers after the drop, rearranging stays on", (await p.page.locator("#motionTools .dragging").count()) === 0 && !(await p.page.locator("#motionTools").evaluate((el) => /reordering/.test(el.className))) && (await arrangingNow(p)));
  await p.page.screenshot({ path: path.join(SHOTS, "21e-tools-swapped.png") });
  await p.page.waitForTimeout(350);
  c = await center(p, "#anchorGrid button:nth-child(5)");
  await live(p);
  before = [await p.status(), p.ae.log.undo.length];
  await p.page.mouse.click(c.x, c.y); await p.idle();
  check("R3 while rearranging the buttons inside the blocks do nothing", (await p.status()) === before[0] && p.ae.log.undo.length === before[1], await p.status());
  t = await toolRects(p);
  c = middle(t.ease);
  await dragFrom(p, c, { x: c.x - 15, y: c.y + 10 });
  check("R3 a drag shorter than half a cell changes nothing", (await toolOrder(p)).indexOf("anchor,ease,") === 0 && (await toolRects(p)).ease.l === 190);
  c = await cellsNow(p);
  await p.page.mouse.move(middle(t.ease).x, middle(t.ease).y); await p.page.mouse.down();
  await p.page.mouse.move(middle(t.ease).x - CELL - 5, middle(t.ease).y, { steps: 6 });
  t = [await cellsNow(p), await p.page.locator("#motionTools .dragging").count()];
  await p.page.mouse.move(middle((await toolRects(p)).ease).x + CELL + 20, middle((await toolRects(p)).ease).y, { steps: 6 });
  await p.page.mouse.up();
  check("R3 while dragged the block jumps from cell to cell, the others make room at once", /ease:3,0,4,6/.test(t[0]) && t[1] === 1 && t[0] !== c, t[0]);
  check("R3 back on its cells the layout is as before", (await cellsNow(p)) === c, await cellsNow(p));
  t = await toolRects(p);
  await p.page.waitForTimeout(350);
  await p.page.mouse.dblclick(middle(t.ease).x, middle(t.ease).y);
  check("R3 a double click on a block switches rearranging off", !(await arrangingNow(p)) && (await toolOrder(p)).indexOf("anchor,ease,") === 0);
  await p.page.click("#easeBothBtn"); await p.idle();
  check("R3 the tools work again, in the new order", (await p.status()) === "Выделите ключевые кадры на таймлайне и нажмите ещё раз.");
  await p.restart();
  check("R3 the order survives a restart", (await toolOrder(p)).indexOf("anchor,ease,") === 0 && (await vis(p, "#easeBothBtn")) && !(await arrangingNow(p)));
  await arrange(p);
  t = await toolRects(p);
  await dragFrom(p, { x: t.ease.l + 6, y: t.ease.b - 5 }, { x: t.ease.l + 6 - 4 * CELL, y: t.ease.b - 5 });
  check("R3 dragging back restores the order", (await toolOrder(p)) === "ease,anchor,align,shift,paste,organize" && (await savedTools(p)) === "ease,anchor,align,shift,paste,organize", await toolOrder(p));
  await p.page.waitForTimeout(350);
  await dragTab(p, "#tabMotion", "#tabClaude");
  check("R3 the same mode moves the tabs", (await order(p)) === "motion,claude,tools");
  await p.page.waitForTimeout(350);
  await p.page.keyboard.press("Escape");
  check("R3 Esc ends it", !(await arrangingNow(p)));

  await p.page.focus(grip("anchor")); await p.page.keyboard.press("ArrowLeft");
  check("R4 keyboard: arrow on the block's handle moves it and keeps focus (no double click needed)", !(await arrangingNow(p)) && (await toolOrder(p)) === "anchor,ease,align,shift,paste,organize" && (await p.page.evaluate(() => document.activeElement.className)) === "tool-grip" && (await savedTools(p)) === "anchor,ease,align,shift,paste,organize");
  await p.page.keyboard.press("ArrowLeft");
  check("R4 at the edge nothing happens", (await toolOrder(p)) === "anchor,ease,align,shift,paste,organize");
  await p.page.keyboard.press("ArrowRight");
  check("R4 and back", (await toolOrder(p)) === "ease,anchor,align,shift,paste,organize" && p.errors.length === 0, p.errors.join(" | "));
  await p.page.focus(grip("ease")); await p.page.keyboard.press("ArrowDown");
  check("R4 down moves it a cell down", /ease:0,1,/.test(await cellsNow(p)), await cellsNow(p));
  await p.page.keyboard.press("ArrowUp");
  check("R4 up brings it back", (await toolOrder(p)) === "ease,anchor,align,shift,paste,organize" && /ease:0,0/.test(await cellsNow(p)), await cellsNow(p));
  await arrange(p); await p.page.click("#arrangeReset"); await p.page.waitForTimeout(350); await p.page.keyboard.press("Escape");
  await p.page.focus(grip("ease")); await p.page.keyboard.press("ArrowDown");
  check("R4 with a block right underneath, down swaps them", (await toolOrder(p)).split(",").slice(0, 2).join() === "align,anchor" && /ease:0,6/.test(await cellsNow(p)) && /align:0,0/.test(await cellsNow(p)), await cellsNow(p));
  await p.page.keyboard.press("ArrowUp");
  check("R4 and up swaps them back", /ease:0,0/.test(await cellsNow(p)) && /align:0,6/.test(await cellsNow(p)), await cellsNow(p));
  await p.page.focus(grip("anchor")); await p.page.keyboard.press("ArrowRight");
  check("R4 a block at the panel's right edge does not move further right", /anchor:4,0/.test(await cellsNow(p)), await cellsNow(p));
  await p.close();

  p = await open({ width: 300 });
  await motionTab(p);
  t = await toolRects(p);
  check("R5 in a narrow panel the blocks stack and keep their size", t.ease.b <= t.anchor.t && t.anchor.b <= t.align.t && t.ease.l === 14 && t.ease.w === 168 && t.anchor.w === 168 && t.align.w === 168 && (await overflow(p)) <= 0, JSON.stringify(t));
  await arrange(p);
  t = await toolRects(p);
  c = middle(t.anchor);
  await dragFrom(p, c, { x: c.x + 3, y: c.y - (t.anchor.t - t.ease.t) });
  t = await toolRects(p);
  check("R5 stacked blocks swap by dragging up or down", (await toolOrder(p)) === "anchor,ease,align,shift,paste,organize" && t.anchor.b <= t.ease.t, await toolOrder(p));
  await p.page.screenshot({ path: path.join(SHOTS, "21f-tools-stacked.png") });
  await p.close();

  p = await open({ width: 900 });
  await motionTab(p);
  t = await toolRects(p);
  check("R6 in a wide panel all four blocks fit one row, still 168px each", t.ease.t === t.anchor.t && t.anchor.t === t.align.t && t.align.t === t.shift.t && t.ease.l === 14 && t.anchor.l === 190 && t.align.l === 366 && t.shift.l === 542 && [t.ease, t.anchor, t.align, t.shift].every((x) => x.w === 168), JSON.stringify(t));
  await p.page.screenshot({ path: path.join(SHOTS, "21g-tools-wide.png") });
  await p.close();
  for (const [bad, want] of [['"anchor"', "anchor,ease,align,shift,paste,organize"], ['"ease,ease"', "ease,anchor,align,shift,paste,organize"], ["7", "ease,anchor,align,shift,paste,organize"], ["null", "ease,anchor,align,shift,paste,organize"], ['["anchor","ease"]', "ease,anchor,align,shift,paste,organize"],
    ['"anchor,ease"', "anchor,ease,align,shift,paste,organize"] /* an order saved before the Align block existed */, ['"align,ghost,ease"', "align,ease,anchor,shift,paste,organize"]]) {
    p = await open({});
    await p.page.evaluate((v) => localStorage.setItem("sayframe.motion.v1", '{"order":' + v + "}"), bad); await p.restart(); await motionTab(p);
    check("R7 saved order " + bad + " -> " + want, (await toolOrder(p)) === want && (await p.page.locator("#motionTools .tool-card").count()) === 6 && p.errors.length === 0, await toolOrder(p));
    await p.close();
  }
  p = await open({});
  await motionTab(p); await arrange(p);
  t = await toolRects(p);
  await dragFrom(p, middle(t.align), by(middle(t.align), 0, t.ease.t - t.align.t));
  check("R8 the block from the second row can be dragged up into the corner; the easing block takes its place", (await toolOrder(p)) === "align,anchor,ease,shift,paste,organize" && (await savedTools(p)) === "align,anchor,ease,shift,paste,organize" && /align:0,0/.test(await cellsNow(p)), await toolOrder(p) + " " + await cellsNow(p));
  await p.page.waitForTimeout(350);
  t = await toolRects(p);
  check("R8 then align and anchor share the first row", t.align.t === t.anchor.t && t.align.r < t.anchor.l && t.ease.t >= t.align.b, JSON.stringify(t));
  await dragFrom(p, middle(t.align), by(middle(t.align), 0, t.ease.t - t.align.t));
  check("R8 and down again", (await toolOrder(p)) === "ease,anchor,align,shift,paste,organize", await toolOrder(p));
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
  await live(p);
  for (const k of [prop1.keys[1], prop1.keys[2], prop2.keys[1]]) { k.inEase = k.inEase.map(() => ({ speed: 11, influence: 16.67 })); k.outEase = k.outEase.map(() => ({ speed: 22, influence: 16.67 })); }
  p.ae.log.undo.length = 0;
  await p.page.click("#easeBothBtn"); await p.idle();
  check("M4 'apply' eases both sides of every selected key", [prop1.keys[1], prop1.keys[2]].every((k) => eases(k.inEase) === "0/40" && eases(k.outEase) === "0/75" && k.inType === KIT.BEZIER && k.outType === KIT.BEZIER), eases(prop1.keys[1].inEase) + " | " + eases(prop1.keys[1].outEase));
  check("M4 one ease per dimension (3 for scale)", eases(prop2.keys[1].inEase) === "0/40,0/40,0/40" && eases(prop2.keys[1].outEase) === "0/75,0/75,0/75" && prop2.keys[1].inType === KIT.BEZIER);
  check("M4 unselected keys and values are untouched", eases(prop1.keys[0].inEase) === "11/16.67" && eases(prop1.keys[0].outEase) === "22/16.67" && prop1.keys[0].inType === KIT.LINEAR && prop1.keys.map((k) => k.value).join() === "0,50,100" && eases(prop2.keys[0].outEase) === "22/16.67,22/16.67,22/16.67");
  check("M4 result reported, one undo step", (await p.status()) === "Плавность применена: 3 ключа.\nОтменить: Cmd/Ctrl+Z." && (await p.statusKind()) === "done" && p.ae.log.undo.join() === "begin:Sayframe: ease keyframes,end", await p.status());
  await p.close();

  // Real time: the keys follow the sliders, no button needed.
  const easeCalls = (p) => p.ae.log.scripts.filter((x) => /sayframeHost\.ease\(/.test(x));
  p = await open(easeScene());
  await motionTab(p);
  await setSlider(p, "easeOut", 30); await live(p);
  check("L1 moving a slider changes the selected keys at once, without the button", [prop1.keys[1], prop1.keys[2]].every((k) => eases(k.inEase) === "0/30" && eases(k.outEase) === "0/30" && k.inType === KIT.BEZIER) && eases(prop2.keys[1].inEase) === "0/30,0/30,0/30", eases(prop1.keys[1].inEase));
  check("L1 unselected keys are left alone and the result is reported", eases(prop1.keys[0].inEase) === "11/16.67" && (await p.status()) === "Плавность применена: 3 ключа.\nОтменить: Cmd/Ctrl+Z." && (await p.statusKind()) === "done", await p.status());
  check("L1 nothing is locked while it applies", !(await p.page.locator("#easeOut").isDisabled()) && !(await p.page.locator("#easeBothBtn").isDisabled()) && !(await p.page.locator("#anchorGrid button").first().isDisabled()));
  t = easeCalls(p).length;
  await setSlider(p, "easeOut", 30); await p.page.waitForTimeout(150); await live(p);
  check("L1 a slider that did not change its value sends nothing", easeCalls(p).length === t);
  await p.page.locator("#easeLink").evaluate((el) => el.click()); await p.page.waitForTimeout(150); await live(p);
  check("L1 unlinking alone changes nothing", easeCalls(p).length === t);
  await setSlider(p, "easeIn", 80); await live(p);
  check("L1 unlinked: each slider drives its own side, live", eases(prop1.keys[1].inEase) === "0/80" && eases(prop1.keys[1].outEase) === "0/30" && eases(prop2.keys[1].outEase) === "0/30,0/30,0/30", eases(prop1.keys[1].inEase) + " | " + eases(prop1.keys[1].outEase));
  await typeNumber(p, "easeOutVal", "45"); await live(p);
  check("L1 a typed number applies live too", eases(prop1.keys[2].outEase) === "0/45" && eases(prop1.keys[2].inEase) === "0/80");
  await p.page.locator("#easeLink").evaluate((el) => el.click()); await live(p);
  check("L1 linking again copies the value onto the keys", eases(prop1.keys[1].inEase) === "0/45" && eases(prop1.keys[1].outEase) === "0/45", eases(prop1.keys[1].inEase));
  check("L1 no errors", p.errors.length === 0, p.errors.join());
  await p.close();

  // A real drag with the mouse, After Effects answering slowly: requests go one at a time and the last value wins.
  p = await open(Object.assign(easeScene(), { hostDelayMs: 120 }));
  await motionTab(p);
  c = await p.page.locator("#easeOut").boundingBox();
  await p.page.mouse.move(c.x + c.width * 0.6, c.y + c.height / 2);
  await p.page.mouse.down();
  for (let i = 1; i <= 30; i++) { await p.page.mouse.move(c.x + c.width * 0.6 - i * (c.width * 0.5 / 30), c.y + c.height / 2); await p.page.waitForTimeout(12); }
  t = [easeCalls(p).length, await p.page.getAttribute(".ease-card", "data-live")];
  await p.page.mouse.up();
  await live(p);
  before = Number(await p.page.inputValue("#easeOut"));
  check("L2 the keys change during the drag, before the mouse is released", t[0] >= 1 && t[1] === "on", t.join());
  check("L2 requests are not sent for every pixel", easeCalls(p).length >= 2 && easeCalls(p).length <= 8, String(easeCalls(p).length));
  check("L2 the keys end on the final slider value", before < 30 && eases(prop1.keys[1].outEase) === "0/" + (before || 0.1) && eases(prop1.keys[1].inEase) === "0/" + (before || 0.1) && (await p.page.inputValue("#easeIn")) === String(before), before + " " + eases(prop1.keys[1].outEase));
  check("L2 every step is a closed undo group", p.ae.log.undo.length === easeCalls(p).length * 2 && p.ae.log.undo.filter((x) => x === "end").length === easeCalls(p).length);
  await p.close();

  // Some After Effects versions drop the selection when a key is changed: the keys must stay selected for the next step.
  p = await open(easeScene());
  prop1.deselectsOnEase = true; prop2.deselectsOnEase = true;
  await motionTab(p);
  await setSlider(p, "easeOut", 20); await live(p);
  await setSlider(p, "easeOut", 90); await live(p);
  check("L3 keys stay selected, so the second step still finds them", prop1.selectedKeys.join() === "2,3" && prop2.selectedKeys.join() === "2" && eases(prop1.keys[2].outEase) === "0/90" && eases(prop2.keys[1].inEase) === "0/90,0/90,0/90", prop1.selectedKeys.join() + " " + eases(prop1.keys[2].outEase));
  await p.close();

  // Not while the panel is busy with something else, and not while rearranging.
  p = await open(Object.assign(easeScene(), { noActiveComp: true }));
  await motionTab(p);
  await setSlider(p, "easeOut", 10); await live(p);
  check("L4 no open composition -> a hint, not an error", /^Откройте композицию/.test(await p.status()) && (await p.statusKind()) === "" && p.errors.length === 0, await p.status());
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
  // ---------------------------------------------------------------- animation: a free panel, fixed blocks
  // Stretching the After Effects panel never resizes a block; it only changes how many stand in a row.
  console.log("\n=== animation: blocks reflow, sizes stay ===");
  const allInside = (p) => p.page.evaluate(() => Array.prototype.every.call(document.querySelectorAll("#motionTools .tool-card"), (card) => { const c = card.getBoundingClientRect(); return Array.prototype.every.call(card.querySelectorAll("input, button:not(.tool-grip), select, svg, b, label"), (el) => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5); }); }));
  const sizesNow = (p) => p.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#motionTools .tool-card"), (c) => { const b = c.getBoundingClientRect(); return Math.round(b.width) + "x" + Math.round(b.height); }).sort().join());
  // How many blocks stand in the first row, and is everything stacked in one column?
  const firstRow = (p) => p.page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll("#motionTools .tool-card"), (c) => /^1 \//.test(c.style.gridRow)).length);
  const oneColumn = (p) => p.page.evaluate(() => Array.prototype.every.call(document.querySelectorAll("#motionTools .tool-card"), (c) => /^1 \//.test(c.style.gridColumn)));
  p = await open({ width: 380 });
  await motionTab(p);
  c = await sizesNow(p);
  check("E1 at 380px (8 cells): two blocks in the first row, the rest below", (await firstRow(p)) === 2 && (await cellsNow(p)) === "ease:0,0,4,6 anchor:4,0,4,7 align:0,6,4,6 shift:4,7,4,11 paste:0,12,4,5 organize:0,17,4,7", await cellsNow(p));
  check("E1 (scene) block sizes", c === "168x212,168x256,168x256,168x300,168x300,168x476", c);
  await resizeTo(p, 600);
  check("E1 stretched to 600px: three in the first row, every block exactly the same size as before", (await firstRow(p)) === 3 && (await sizesNow(p)) === c, (await firstRow(p)) + " " + (await sizesNow(p)));
  await resizeTo(p, 800);
  check("E1 stretched to 800px: four in a row, same sizes", (await firstRow(p)) === 4 && (await sizesNow(p)) === c, (await firstRow(p)) + " " + (await sizesNow(p)));
  await resizeTo(p, 1400);
  t = await toolRects(p);
  check("E1 stretched to 1400px: all six in a row, still the same sizes, the blocks stay on the left", (await firstRow(p)) === 6 && (await sizesNow(p)) === c && t.ease.l === 14 && t.paste.r === 886 && (await overflow(p)) <= 0, JSON.stringify(t));
  await resizeTo(p, 300);
  check("E1 squeezed to 300px: one under another, same sizes again", (await oneColumn(p)) && (await sizesNow(p)) === c && (await overflow(p)) <= 0, (await cellsNow(p)) + " " + (await sizesNow(p)));
  await resizeTo(p, 380);
  check("E1 and back to 380px: the first layout returns", (await cellsNow(p)) === "ease:0,0,4,6 anchor:4,0,4,7 align:0,6,4,6 shift:4,7,4,11 paste:0,12,4,5 organize:0,17,4,7" && (await sizesNow(p)) === c);
  await p.page.click("#settingsBtn"); await setWidth(p, 640); await p.page.click("#saveSettings");
  check("E2 the width setting is for fields and buttons: it changes neither the blocks nor the tab bar", (await box(p, "#tabs")).split(",")[2] === "352" && (await sizesNow(p)) === c && (await firstRow(p)) === 2);
  await resizeTo(p, 1000);
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther"); await p.page.click('#toolSize button[data-value="small"]'); await p.page.click("#saveSettings");
  c = await sizesNow(p);
  t = await p.page.evaluate(() => { const g = document.getElementById("motionTools"), cs = getComputedStyle(g); return [cs.gridAutoRows, cs.columnGap].join("|"); });
  check("E3 small blocks: a finer grid (22px cells, 6px gaps), blocks 4 cells = 106px wide, all in a row", t === "22px|6px" && (await firstRow(p)) === 6 && c.split(",").every((x) => x.indexOf("106x") === 0), t + " " + c);
  await resizeTo(p, 270);
  check("E3 and wrap without changing size when the panel is narrow", (await firstRow(p)) === 2 && (await sizesNow(p)) === c && (await overflow(p)) <= 0, (await cellsNow(p)) + " " + (await sizesNow(p)));
  check("E3 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  // ---------------------------------------------------------------- animation: block size, in cells
  console.log("\n=== animation: block size ===");
  const edge = (tool, which) => '#motionTools [data-tool="' + tool + '"] ' + (which === "y" ? ".tool-resize-y" : which === "xy" ? ".tool-resize-xy" : ".tool-resize");
  const savedSizes = (p) => p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.motion.v1") || "{}").sizes);
  // Is the list beside the buttons (a wide, horizontal block) or under them (a narrow, vertical one)?
  const shape = (p, tool) => p.page.evaluate((tool) => { const card = document.querySelector('#motionTools [data-tool="' + tool + '"]'); const g = card.querySelector(tool === "align" ? ".align-to label" : ".anchor-grid").getBoundingClientRect(), s = card.querySelector(tool === "align" ? ".align-to select" : ".anchor-side").getBoundingClientRect(); return s.left >= g.right ? "horizontal" : s.top >= g.bottom ? "vertical" : "overlap"; }, tool);
  const dragEdge = async (p, tool, dx, dy, which) => { const c = await center(p, edge(tool, which)); await dragFrom(p, c, { x: c.x + dx, y: c.y + 3 + (dy || 0) }); };
  const onCells = (w, h) => (w + 8) % 44 === 0 && (h === undefined || (h + 8) % 44 === 0);

  p = await open({ width: 700, height: 1100, settings: { panelWidth: 640 } });   // blocks area: 672px = 15 cells
  await motionTab(p);
  t = await toolRects(p);
  check("S1 every block has three handles: right edge (width), bottom edge (height), corner (both)", (await p.page.evaluate(() => Array.prototype.every.call(document.querySelectorAll("#motionTools .tool-card"), (c) => { const r = c.getBoundingClientRect(); const x = c.querySelector(".tool-resize").getBoundingClientRect(), y = c.querySelector(".tool-resize-y").getBoundingClientRect(), xy = c.querySelector(".tool-resize-xy").getBoundingClientRect(); return x.left < r.right && x.right > r.right && x.height > 30 && getComputedStyle(c.querySelector(".tool-resize")).cursor === "ew-resize" && y.top < r.bottom && y.bottom > r.bottom && y.width > 30 && getComputedStyle(c.querySelector(".tool-resize-y")).cursor === "ns-resize" && xy.right > r.right && xy.bottom > r.bottom && getComputedStyle(c.querySelector(".tool-resize-xy")).cursor === "nwse-resize"; }))));
  check("S1 (scene) three blocks in one row, lists under the buttons", t.ease.t === t.anchor.t && t.anchor.t === t.align.t && (await shape(p, "anchor")) === "vertical" && (await shape(p, "align")) === "vertical", JSON.stringify(t));
  await p.page.mouse.move((await center(p, edge("anchor"))).x, (await center(p, edge("anchor"))).y); await p.page.mouse.down();
  c = await center(p, edge("anchor"));
  await p.page.mouse.move(c.x + 60, c.y, { steps: 5 });
  t = [await p.page.locator(".grid-cells").evaluate((el) => getComputedStyle(el).opacity), (await toolRects(p)).anchor.w];
  await p.page.mouse.move(c.x + 140, c.y, { steps: 5 });
  t.push((await toolRects(p)).anchor.w);
  await p.page.mouse.up();
  check("S2 while the edge is pulled the grid shows and the width jumps by whole cells", Number(t[0]) > 0.3 && t[1] === 212 && t[2] === 300, t.join());
  t = await toolRects(p);
  check("S2 pulled right by about three cells: 7 cells wide, remembered in cells", t.anchor.w === 300 && (await savedSizes(p)) === "anchor=7x0", t.anchor.w + " " + await savedSizes(p));
  check("S2 a wide block turns horizontal: the list stands beside the buttons", (await shape(p, "anchor")) === "horizontal", await shape(p, "anchor"));
  await p.page.waitForTimeout(250);
  check("S2 nothing is left marked, the grid hides again, nothing overflows", (await p.page.locator(".resizing, .resizing-x").count()) === 0 && (await p.page.locator(".grid-cells").evaluate((el) => getComputedStyle(el).opacity)) === "0" && (await overflow(p)) <= 0, await box(p, "#motionTools"));
  await p.page.screenshot({ path: path.join(SHOTS, "24-block-wide.png") });
  await dragEdge(p, "anchor", -132);
  check("S2 pulling it back makes it narrow and vertical again", (await shape(p, "anchor")) === "vertical" && (await toolRects(p)).anchor.w === 168 && (await savedSizes(p)) === "");
  await dragEdge(p, "anchor", -400);
  t = await toolRects(p);
  check("S3 a block cannot be narrower than 4 cells: its three buttons must fit", t.anchor.w === 168 && (await savedSizes(p)) === "" && (await p.page.evaluate(() => { const c = document.querySelector('[data-tool="anchor"]').getBoundingClientRect(), g = document.getElementById("anchorGrid").getBoundingClientRect(); return g.left >= c.left && g.right <= c.right; })), JSON.stringify(t.anchor));
  await dragEdge(p, "ease", 600);
  t = await toolRects(p);
  check("S4 the easing block pulled to the edge takes every cell of the row", t.ease.l === 14 && t.ease.w === 652 && (await savedSizes(p)) === "ease=99x0", JSON.stringify(t.ease) + " " + await savedSizes(p));
  t = await p.page.evaluate(() => [document.getElementById("easeIn").getBoundingClientRect().width, document.getElementById("easeOut").getBoundingClientRect().width, document.getElementById("easeCurve").getBoundingClientRect().width].map(Math.round));
  check("S4 then its sliders and curve stretch with it", t[0] === t[1] && t[0] > 240 && t[2] > 560, t.join());
  await p.page.screenshot({ path: path.join(SHOTS, "25-ease-full-width.png") });

  // height
  c = (await toolRects(p)).anchor;
  await dragEdge(p, "anchor", 0, 2 * CELL + 10, "y");
  t = await toolRects(p);
  check("S5 the bottom edge makes the block taller by whole cells", t.anchor.b - t.anchor.t === (c.b - c.t) + 2 * CELL && onCells(t.anchor.w, t.anchor.b - t.anchor.t) && (await savedSizes(p)) === "ease=99x0;anchor=4x9", (t.anchor.b - t.anchor.t) + " " + await savedSizes(p));
  check("S5 the content stays on top, the extra space is below", (await p.page.evaluate(() => { const c = document.querySelector('[data-tool="anchor"]').getBoundingClientRect(), s = document.getElementById("anchorKeys").getBoundingClientRect(); return c.bottom - s.bottom > 80; })));
  await dragEdge(p, "anchor", 0, -4 * CELL, "y");
  check("S5 but never shorter than its content", (await toolRects(p)).anchor.b - (await toolRects(p)).anchor.t === c.b - c.t && (await savedSizes(p)) === "ease=99x0" && (await allInside(p)), String((await toolRects(p)).anchor.b - (await toolRects(p)).anchor.t));
  await dragEdge(p, "align", 2 * CELL, CELL, "xy");
  t = await toolRects(p);
  check("S5 the corner changes both at once", t.align.w === 256 && onCells(t.align.w, t.align.b - t.align.t) && /align=6x7/.test(await savedSizes(p)), JSON.stringify(t.align) + " " + await savedSizes(p));
  check("S5 the others keep their size", t.anchor.w === 168 && t.shift.w === 168 && t.ease.w === 652);
  await p.restart();
  t = await toolRects(p);
  check("S6 sizes survive a restart", t.ease.w === 652 && t.align.w === 256 && /align=6x7/.test(await savedSizes(p)), JSON.stringify(t));
  await resizeTo(p, 420);
  t = await toolRects(p);
  check("S6 in a narrower panel a full-width block follows the panel, the others keep their size", t.ease.l === 14 && t.ease.w === 388 && t.anchor.w === 168 && t.align.w === 256 && (await overflow(p)) <= 0, JSON.stringify(t));
  await resizeTo(p, 700);
  await p.page.dblclick(edge("ease"));
  t = await toolRects(p);
  check("S7 a double click on an edge returns the usual size and does not start rearranging", !/ease=/.test(await savedSizes(p)) && t.ease.w === 168 && !(await arrangingNow(p)), JSON.stringify(t.ease) + " " + await savedSizes(p));
  await p.page.dblclick(edge("align", "y"));
  check("S7 the bottom edge too", (await savedSizes(p)) === "" && (await toolRects(p)).align.w === 168, await savedSizes(p));
  await p.page.focus(edge("align")); await p.page.keyboard.press("ArrowRight");
  await p.page.keyboard.press("ArrowRight"); await p.page.keyboard.press("ArrowLeft"); await p.page.keyboard.press("ArrowRight");
  check("S7 keyboard: arrows on the right edge change the width a cell at a time", (await toolRects(p)).align.w === 256 && (await savedSizes(p)) === "align=6x0", (await toolRects(p)).align.w + " " + await savedSizes(p));
  await p.page.keyboard.press("End");
  check("S7 End takes the whole row, Home returns the usual size", (await savedSizes(p)) === "align=99x0" && (await toolRects(p)).align.w === 652);
  await p.page.keyboard.press("Home");
  check("S7 Home", (await savedSizes(p)) === "");
  await p.page.focus(edge("anchor", "y")); c = (await toolRects(p)).anchor; await p.page.keyboard.press("ArrowDown"); await p.page.keyboard.press("ArrowDown");
  check("S7 arrows on the bottom edge change the height a cell at a time", (await toolRects(p)).anchor.b - (await toolRects(p)).anchor.t === c.b - c.t + 2 * CELL && (await savedSizes(p)) === "anchor=4x9", await savedSizes(p));
  await p.page.keyboard.press("Home");
  await arrange(p);
  c = await toolOrder(p);
  await dragEdge(p, "anchor", 200);
  t = await toolRects(p);
  check("S8 while rearranging, the edge still changes the width and does not move the block", t.anchor.w === 388 && (await toolOrder(p)) === c && (await arrangingNow(p)) && (await p.page.locator(".dragging, .reordering, .resizing").count()) === 0, JSON.stringify(t.anchor));
  await p.page.waitForTimeout(350);
  await p.page.keyboard.press("Escape");
  await p.page.click('#anchorGrid button:nth-child(5)'); await p.idle();
  check("S8 the tools keep working at any size", (await p.status()) === "Выделите слой в композиции и нажмите ещё раз." && p.errors.length === 0, await p.status());
  await p.close();
  p = await open({ width: 700, settings: { panelWidth: 640 } });
  await p.page.evaluate(() => { ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach((n) => window.addEventListener(n, (e) => e.stopImmediatePropagation(), true)); });
  await motionTab(p);
  await dragEdge(p, "align", 140);
  check("S9 resizing works with pointer events swallowed, as inside After Effects", (await toolRects(p)).align.w === 300 && (await shape(p, "align")) === "horizontal", JSON.stringify((await toolRects(p)).align));
  await p.close();
  for (const [bad, want] of [['"ease=9999;anchor=10;ghost=300;align=full"', "ease=99x0;align=99x0"] /* widths in pixels from 1.8.0 */, ['"anchor=abc;ease"', ""], ["42", ""], ['"anchor=300.5;align=-200"', ""], ['"align=200;ease=200"', "ease=5x0;align=5x0"], ['"ease=2x0;anchor=6x77;align=4x0"', "anchor=6x40"]]) {
    p = await open({});
    await p.page.evaluate((v) => localStorage.setItem("sayframe.motion.v1", '{"sizes":' + v + "}"), bad); await p.restart(); await motionTab(p);
    t = await toolRects(p);
    await setSlider(p, "easeIn", 61);
    check("S10 saved sizes " + bad + " -> " + JSON.stringify(want), (await savedSizes(p)) === want && Object.keys(t).every((k) => t[k].r <= 358 && t[k].l >= 14) && (await overflow(p)) <= 0 && p.errors.length === 0, (await savedSizes(p)) + " " + JSON.stringify(t));
    await p.close();
  }
  for (const [bad, want] of [['"ease=0,0;anchor=4,0;align=0,6;shift=4,7"', "ease=0,0;anchor=4,0;align=0,6;shift=4,7"], ['"ease=0,0"', "ease=0,0"] /* blocks without a place go to the first free cells */, ['"ease=a,b;anchor=1"', ""], ["5", ""]]) {
    p = await open({});
    await p.page.evaluate((v) => localStorage.setItem("sayframe.motion.v1", '{"places":' + v + "}"), bad); await p.restart(); await motionTab(p);
    await setSlider(p, "easeIn", 61);
    check("S10 saved places " + bad + " -> " + JSON.stringify(want), (await savedPlaces(p)) === want && (await overflow(p)) <= 0 && p.errors.length === 0, await savedPlaces(p));
    await p.close();
  }

  // placing blocks freely on the grid
  p = await open({ width: 900 });   // 872px = 20 cells
  await motionTab(p); await arrange(p);
  t = await toolRects(p);
  c = topOf(t.shift);
  await dragFrom(p, c, by(c, 2 * CELL + 4, 0));
  check("G1 a block dropped on empty cells stays there, leaving a gap", /shift:14,0,4,/.test(await cellsNow(p)) && /shift=14,0/.test(await savedPlaces(p)), await cellsNow(p));
  await dragFrom(p, topOf((await toolRects(p)).shift), by(topOf((await toolRects(p)).shift), -14 * CELL, 8 * CELL));
  check("G1 dropped low in another column, it stays on that cell, empty cells above it", /shift:0,8,4,/.test(await cellsNow(p)) && /shift=0,8/.test(await savedPlaces(p)), await cellsNow(p));
  await dragFrom(p, topOf((await toolRects(p)).shift), by(topOf((await toolRects(p)).shift), 12 * CELL, -8 * CELL));
  check("G1 dropped onto another block, the two swap places", /shift:12,0,4,/.test(await cellsNow(p)) && /align:8,0/.test(await cellsNow(p)) && /ease:0,0/.test(await cellsNow(p)) && /anchor:4,0/.test(await cellsNow(p)), await cellsNow(p));
  await dragFrom(p, topOf((await toolRects(p)).ease), by(topOf((await toolRects(p)).ease), 12 * CELL, 0));
  check("G1 the block that was dropped on takes the other's old place", /ease:12,0/.test(await cellsNow(p)) && /shift:0,0/.test(await cellsNow(p)), await cellsNow(p));
  await resizeTo(p, 380);
  t = await toolRects(p);
  check("G2 in a narrow panel blocks placed further right than it reaches move in and stack", Object.keys(t).every((k) => t[k].r <= 358) && (await overflow(p)) <= 0 && (await allInside(p)), await cellsNow(p));
  await resizeTo(p, 900);
  check("G2 widened again, they go back to their cells", /shift:0,0,4,/.test(await cellsNow(p)) && /ease:12,0/.test(await cellsNow(p)), await cellsNow(p));
  await p.page.click("#arrangeReset");
  check("G3 'Reset' returns the usual sizes and order, blocks follow each other again", (await cellsNow(p)) === "ease:0,0,4,6 anchor:4,0,4,7 align:8,0,4,6 shift:12,0,4,11 paste:16,0,4,5 organize:16,5,4,7" && (await savedPlaces(p)) === "" && (await savedSizes(p)) === "", await cellsNow(p));
  check("G3 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  // ---------------------------------------------------------------- animation: large or small blocks
  console.log("\n=== animation: block size setting ===");
  const toolsAttr = (p) => p.page.evaluate(() => document.documentElement.getAttribute("data-tools"));
  const gridBox = (p, id) => p.page.evaluate((id) => { const g = document.getElementById(id).getBoundingClientRect(), c = document.querySelector("#" + id + " button").getBoundingClientRect(); return [Math.round(g.width), Math.round(g.height), Math.round(c.width), Math.round(c.height)].join(); }, id);
  const rowShape = (p, id) => p.page.evaluate((id) => { const tops = Array.prototype.map.call(document.querySelectorAll("#" + id + " button"), (b) => Math.round(b.getBoundingClientRect().top)); const first = tops.filter((t) => t === tops[0]).length; const b = document.querySelector("#" + id + " button").getBoundingClientRect(), g = document.querySelector("#" + id + " svg").getBoundingClientRect(); return (first === 6 ? "6" : first + "+" + (6 - first)) + " " + Math.round(b.height) + " " + Math.round(g.width); }, id);
  const pressedSize = (p) => p.page.locator('#toolSize button[aria-pressed="true"]').getAttribute("data-value");

  p = await open({});
  await motionTab(p);
  check("Z1 blocks are large unless chosen otherwise", (await toolsAttr(p)) === "large" && (await gridBox(p, "anchorGrid")) === "122,122,38,38" && (await rowShape(p, "alignGrid")) === "6 30 20" && (await rowShape(p, "distGrid")) === "6 30 20", await gridBox(p, "anchorGrid") + " | " + await rowShape(p, "alignGrid"));
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
  check("Z1 settings offer two sizes, large is marked", (await p.page.locator("#toolSize button").count()) === 2 && (await pressedSize(p)) === "large" && (await p.page.locator("#toolSize button").allInnerTexts()).join() === "Крупные,Мелкие");
  await p.page.click('#toolSize button[data-value="small"]');
  check("Z2 choosing small shows at once", (await toolsAttr(p)) === "small" && (await pressedSize(p)) === "small");
  await p.page.click("#settingsClose");
  check("Z2 closing without saving returns large", (await toolsAttr(p)) === "large" && (await gridBox(p, "anchorGrid")) === "122,122,38,38");
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther"); await p.page.click('#toolSize button[data-value="small"]'); await p.page.click("#saveSettings");
  check("Z3 saved: the buttons are small now", (await toolsAttr(p)) === "small" && (await gridBox(p, "anchorGrid")) === "82,82,26,26" && (await rowShape(p, "alignGrid")) === "3+3 24 14" && (await rowShape(p, "distGrid")) === "3+3 24 14" && (await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.settings.v1")).toolSize)) === "small", await gridBox(p, "anchorGrid") + " " + await rowShape(p, "alignGrid"));
  t = await toolRects(p);
  check("Z3 at 380px three small blocks stand in one row", t.ease.t === t.anchor.t && t.anchor.t === t.align.t && t.ease.l === 14 && t.align.r === 344 && Math.abs(t.ease.w - t.anchor.w) <= 1, JSON.stringify(t));
  check("Z3 nothing sticks out of a small block or the panel", (await allInside(p)) && (await overflow(p)) <= 0);
  t = await p.page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return [r("easeIn").width, r("easeOut").width, r("easeBothBtn").width, r("anchorKeys").height, document.querySelector("#motionTools .ease-card").getBoundingClientRect().height].map(Math.round); });
  check("Z3 the easing block shrinks too and keeps equal sliders", t[0] === t[1] && t[0] >= 20 && t[2] === 26 && t[3] === 28, t.join());
  await p.page.screenshot({ path: path.join(SHOTS, "26-tools-small.png") });
  await setSlider(p, "easeOut", 100);
  check("Z3 slider fill follows the smaller thumb", (await fillOf(p, "easeOut")) === "1" && (await p.page.locator("#easeOut").evaluate((el) => getComputedStyle(el).getPropertyValue("--thumb").trim())) === "12px");
  await setSlider(p, "easeOut", 60);
  await p.page.click("#easeBothBtn"); await p.idle();
  c = await p.status();
  await p.page.locator("#anchorGrid button").nth(4).click(); await p.idle();
  t = await p.status();
  await p.page.click('#alignGrid button[data-edge="left"]'); await p.idle();
  check("Z4 every tool still works at the small size", c === "Выделите ключевые кадры на таймлайне и нажмите ещё раз." && t === "Выделите слой в композиции и нажмите ещё раз." && (await p.status()) === "Выделите слой в композиции и нажмите ещё раз.", c + " | " + t);
  await dragEdge(p, "anchor", -300);
  t = await toolRects(p);
  check("Z5 a small block is at least 4 small cells (106px) wide", t.anchor.w === 106 && (await savedSizes(p)) === "" && (await allInside(p)), JSON.stringify(t.anchor));
  await dragEdge(p, "anchor", 3 * 28 + 4);
  check("Z5 and grows by small cells", (await toolRects(p)).anchor.w === 190 && (await savedSizes(p)) === "anchor=7x0", (await toolRects(p)).anchor.w + " " + await savedSizes(p));
  await p.restart();
  check("Z5 the size and the widths survive a restart", (await toolsAttr(p)) === "small" && (await toolRects(p)).anchor.w === 190 && (await gridBox(p, "anchorGrid")) === "82,82,26,26");
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
  check("Z5 settings show the saved size", (await pressedSize(p)) === "small");
  await p.page.click('#toolSize button[data-value="large"]'); await p.page.click("#saveSettings");
  t = await toolRects(p);
  check("Z6 back to large: big buttons again, the same 7 cells are now large cells", (await toolsAttr(p)) === "large" && (await gridBox(p, "anchorGrid")) === "122,122,38,38" && t.anchor.w === 300 && (await allInside(p)) && (await overflow(p)) <= 0, JSON.stringify(t.anchor));
  check("Z6 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  p = await open({ width: 280, settings: { toolSize: "small", panelWidth: 280 } });
  await motionTab(p);
  t = await toolRects(p);
  check("Z7 in the narrowest panel two small blocks share a row", t.ease.t === t.anchor.t && t.ease.r < t.anchor.l && t.align.t >= t.ease.b && (await allInside(p)) && (await overflow(p)) <= 0, JSON.stringify(t));
  await arrange(p);
  t = await toolRects(p);
  await dragFrom(p, middle(t.align), by(middle(t.align), 0, t.ease.t - t.align.t));
  check("Z7 small blocks can still be rearranged", (await toolOrder(p)).indexOf("align,anchor,") === 0 && /align:0,0/.test(await cellsNow(p)), await toolOrder(p) + " " + await cellsNow(p));
  await p.close();
  for (const bad of ["tiny", 5, null, "SMALL"]) {
    p = await open({ settings: { toolSize: bad } });
    check("Z8 a broken saved size (" + JSON.stringify(bad) + ") means large", (await toolsAttr(p)) === "large" && p.errors.length === 0, await toolsAttr(p));
    await p.close();
  }

  // ---------------------------------------------------------------- animation: folding the option lists, hiding titles
  console.log("\n=== animation: fold options, hide titles ===");
  const fold = async (p, id) => { const b = p.page.locator("#" + id); return [await b.getAttribute("aria-expanded"), await b.getAttribute("title"), (await p.page.locator("#" + id + " .tool-toggle-plus").evaluate((el) => getComputedStyle(el).display)) !== "none" ? "+" : "-"].join("|"); };
  const cardH = (p, tool) => p.page.evaluate((tool) => Math.round(document.querySelector('#motionTools [data-tool="' + tool + '"]').getBoundingClientRect().height), tool);
  const savedMotion = (p, k) => p.page.evaluate((k) => JSON.parse(localStorage.getItem("sayframe.motion.v1") || "{}")[k], k);
  const titlesAttr = (p) => p.page.evaluate(() => document.documentElement.getAttribute("data-titles"));
  // Does the corner button overlap anything else in its block?
  const togglesClear = (p) => p.page.evaluate(() => Array.prototype.every.call(document.querySelectorAll("#motionTools .tool-toggle"), (b) => { const r = b.querySelector("svg").getBoundingClientRect(); return Array.prototype.every.call(b.parentNode.querySelectorAll(".tool-head b, .anchor-grid button, .ease-bar > *, .ease-curve, select, .anchor-side label, .align-btn, .align-to label, .align-label, .shift-pick label, .tool-info, .shift-arrow, .shift-do"), (el) => { const q = el.getBoundingClientRect(); if (q.width === 0) return true; const tw = el.nodeName === "B" ? (() => { const g = document.createRange(); g.selectNodeContents(el); const t = g.getBoundingClientRect(); return { left: Math.max(t.left, q.left), right: Math.min(t.right, q.right), top: t.top, bottom: t.bottom }; })() : q; return tw.right <= r.left || tw.left >= r.right || tw.bottom <= r.top || tw.top >= r.bottom; }); }));

  p = await open({});
  await motionTab(p);
  check("F1 each block has a minus in its top right corner", (await p.page.locator("#motionTools .tool-toggle").count()) === 6 && (await fold(p, "pasteOptsToggle")) === "true|Скрыть подсказку|-" && (await fold(p, "organizeOptsToggle")) === "true|Скрыть подсказку|-" && (await fold(p, "shiftOptsToggle")) === "true|Скрыть списки|-" && (await fold(p, "anchorOptsToggle")) === "true|Скрыть настройку|-" && (await fold(p, "alignOptsToggle")) === "true|Скрыть подписи|-" && (await p.page.evaluate(() => Array.prototype.every.call(document.querySelectorAll("#motionTools .tool-card"), (c) => { const b = c.querySelector(".tool-toggle").getBoundingClientRect(), r = c.getBoundingClientRect(); return b.top >= r.top && b.top - r.top < 8 && r.right - b.right < 16 && b.right <= r.right; }))));
  check("F1 the corner buttons do not cover titles or controls", await togglesClear(p));
  c = await cardH(p, "anchor");
  await p.page.click("#anchorOptsToggle");
  check("F2 minus on the anchor block hides its list and turns into a plus; the block shrinks", !(await vis(p, "#anchorSide")) && !(await vis(p, "#anchorKeys")) && (await fold(p, "anchorOptsToggle")) === "false|Показать настройку (сейчас: Добавить ключ)|+" && (await cardH(p, "anchor")) < c - 40 && (await savedMotion(p, "anchorOpts")) === false && (await vis(p, "#anchorGrid")), (await fold(p, "anchorOptsToggle")) + " " + (await cardH(p, "anchor")) + "/" + c);
  check("F2 the other blocks are left alone", (await vis(p, "#alignSide")) && (await vis(p, "#easeCurve")));
  c = await cardH(p, "align");
  await p.page.selectOption("#alignTo", "selection");
  await p.page.click("#alignOptsToggle");
  check("F2 same for the align block: the list and the 'distribute' caption go, both rows of buttons stay; the plus says what is chosen", !(await vis(p, "#alignSide")) && !(await vis(p, "#distLabel")) && (await vis(p, "#alignGrid")) && (await vis(p, "#distGrid")) && (await p.page.locator("#distGrid button:visible").count()) === 6 && (await fold(p, "alignOptsToggle")) === "false|Показать подписи (сейчас: Выделенным слоям)|+" && (await cardH(p, "align")) < c - 40 && (await savedMotion(p, "alignOpts")) === false, await fold(p, "alignOptsToggle"));
  await p.page.screenshot({ path: path.join(SHOTS, "27-tools-folded.png") });
  await p.restart();
  check("F3 folded lists stay folded after a restart", !(await vis(p, "#anchorSide")) && !(await vis(p, "#alignSide")) && (await vis(p, "#easeCurve")) && (await fold(p, "alignOptsToggle")) === "false|Показать подписи (сейчас: Выделенным слоям)|+");
  await p.page.focus("#anchorOptsToggle"); await p.page.keyboard.press("Enter");
  check("F3 plus brings the list back (keyboard too)", (await vis(p, "#anchorKeys")) && (await fold(p, "anchorOptsToggle")) === "true|Скрыть настройку|-" && (await savedMotion(p, "anchorOpts")) === true);
  await p.close();
  // a hidden list keeps working: the choice made before folding is the one used
  clock = { time: 0 };
  L = mkLayer(clock, { name: "a", rect: { left: 0, top: 0, width: 100, height: 100 }, position: [200, 100, 0] });
  L2 = mkLayer(clock, { name: "b", rect: { left: 0, top: 0, width: 300, height: 50 }, position: [500, 400, 0] });
  p = await open({ selectedLayers: [L, L2] });
  await motionTab(p); await p.page.selectOption("#alignTo", "selection"); await p.page.click("#alignOptsToggle");
  await p.page.click('#alignGrid button[data-edge="left"]'); await p.idle();
  check("F4 with the list hidden, align still uses the chosen target (selection)", sameVec(P(L).value, [200, 100, 0]) && sameVec(P(L2).value, [200, 400, 0]), P(L2).value.join());
  await p.page.selectOption("#anchorKeys", "skip"); await p.page.click("#anchorOptsToggle");
  A(L).addKey(0, [0, 0, 0]);
  await p.page.locator("#anchorGrid button").nth(4).click(); await p.idle();
  check("F4 and the anchor tool still uses its hidden choice (skip keyed layers)", /Пропущено: 1 слой/.test(await p.status()) && sameVec(A(L).keys[0].value, [0, 0, 0]), await p.status());
  check("F4 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  p = await open({});
  await motionTab(p);
  check("F5 titles are shown unless switched off", (await titlesAttr(p)) === "on" && (await p.page.locator("#motionTools .tool-head b").evaluateAll((l) => l.filter((b) => b.getBoundingClientRect().height > 0).map((b) => b.textContent).join())) === "Плавность ключей,Точка привязки,Выравнивание,Сдвиг во времени,Картинка из буфера,Порядок в проекте");
  c = [await cardH(p, "ease"), await cardH(p, "anchor"), await cardH(p, "align")];
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
  check("F5 settings have the switch, on", await p.page.isChecked("#toolTitles"));
  await p.page.locator("#toolTitles").evaluate((el) => el.click());
  check("F5 switching it off shows at once", (await titlesAttr(p)) === "off");
  await p.page.click("#settingsClose");
  check("F5 closing without saving brings the titles back", (await titlesAttr(p)) === "on" && (await p.page.locator("#motionTools .tool-head b").first().isVisible()));
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther"); await p.page.locator("#toolTitles").evaluate((el) => el.click()); await p.page.click("#saveSettings");
  t = [await cardH(p, "ease"), await cardH(p, "anchor"), await cardH(p, "align")];
  check("F6 saved: no titles, the blocks get lower", (await titlesAttr(p)) === "off" && (await p.page.locator("#motionTools .tool-head").evaluateAll((l) => l.every((h) => h.getBoundingClientRect().height === 0))) && t.every((h, i) => h < c[i]) && (await p.page.evaluate(() => JSON.parse(localStorage.getItem("sayframe.settings.v1")).toolTitles)) === false, t.join() + " vs " + c.join());
  check("F6 without titles the corner buttons still cover nothing", (await togglesClear(p)) && (await allInside(p)) && (await overflow(p)) <= 0);
  await p.page.screenshot({ path: path.join(SHOTS, "28-tools-no-titles.png") });
  await p.page.click("#anchorOptsToggle"); await p.page.click("#alignOptsToggle"); await p.page.click("#easeCurveToggle");
  check("F6 everything folded, no titles: just the buttons, and the tools work", (await togglesClear(p)) && (await allInside(p)) && (await cardH(p, "anchor")) < 170);
  await p.page.click("#easeBothBtn"); await p.idle();
  check("F6 easing still runs", (await p.status()) === "Выделите ключевые кадры на таймлайне и нажмите ещё раз.");
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther"); await p.page.click('#toolSize button[data-value="small"]'); await p.page.click("#saveSettings");
  t = await toolRects(p);
  check("F7 small, no titles, folded: three blocks in a row, nothing overlaps", t.ease.t === t.anchor.t && t.anchor.t === t.align.t && (await togglesClear(p)) && (await allInside(p)) && (await overflow(p)) <= 0 && (await cardH(p, "anchor")) <= 134, JSON.stringify(t) + " h=" + await cardH(p, "anchor"));
  await p.page.screenshot({ path: path.join(SHOTS, "29-tools-small-bare.png") });
  await p.page.click("#anchorOptsToggle"); await p.page.click("#alignOptsToggle"); await p.page.click("#easeCurveToggle");
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther"); await p.page.locator("#toolTitles").evaluate((el) => el.click()); await p.page.click("#saveSettings");
  check("F7 small with titles and everything open: titles do not run under the corner buttons", (await titlesAttr(p)) === "on" && (await togglesClear(p)) && (await allInside(p)) && (await overflow(p)) <= 0);
  await p.page.screenshot({ path: path.join(SHOTS, "26-tools-small.png") });
  await p.restart();
  check("F7 the titles choice survives a restart", (await titlesAttr(p)) === "on" && (await toolsAttr(p)) === "small" && p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  for (const bad of ["no", 0, null]) {
    p = await open({ settings: { toolTitles: bad } });
    check("F8 a broken saved titles value (" + JSON.stringify(bad) + ") means titles are shown", (await titlesAttr(p)) === "on" && p.errors.length === 0);
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
  await dragFrom(p, { x: t.ease.l + 6, y: t.ease.b - 5 }, { x: t.ease.l + 6 + 4 * CELL, y: t.ease.b - 5 });
  check("X1 blocks too", (await toolOrder(p)).indexOf("anchor,ease,") === 0 && (await savedTools(p)).indexOf("anchor,ease,") === 0, await toolOrder(p));
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
  t = await p.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#alignGrid button"), (b) => { const r = b.getBoundingClientRect(), s = b.querySelector("svg").getBoundingClientRect(); return r.width >= 20 && r.height >= 28 && s.width > 10 && !!b.title && b.title === b.getAttribute("aria-label"); }).join());
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

  // ---- distribute
  const distBtn = async (p, edge) => { await p.page.click('#distGrid button[data-dist="' + edge + '"]'); await p.idle(); };
  const mid = (l, axis) => { const b = compBox(l); return axis === "x" ? (b.l + b.r) / 2 : (b.t + b.b) / 2; };
  const three = () => {
    clock = { time: 0 };
    L = mkLayer(clock, { name: "a", rect: { left: 0, top: 0, width: 100, height: 100 }, position: [100, 100, 0] });   // 100..200 x 100..200
    L2 = mkLayer(clock, { name: "b", rect: { left: 0, top: 0, width: 300, height: 50 }, position: [150, 220, 0] });   // 150..450 x 220..270
    L3 = mkLayer(clock, { name: "c", rect: { left: 0, top: 0, width: 100, height: 200 }, position: [900, 700, 0] });  // 900..1000 x 700..900
  };
  p = await open({});
  await motionTab(p);
  check("D1 a second row: six 'distribute' buttons under a line and a caption, vertical ones first as in After Effects", (await p.page.locator("#distGrid button").evaluateAll((list) => list.map((b) => b.getAttribute("data-dist")).join())) === "top,vcenter,bottom,left,hcenter,right" && (await p.page.locator("#distLabel").innerText()) === "Распределить слои:" && (await p.page.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const to = r("#alignSide"), a = r("#alignGrid"), sep = r(".align-sep"), l = r("#distLabel"), d = r("#distGrid"); return to.bottom <= a.top && a.bottom <= sep.top && sep.bottom <= l.top && l.bottom <= d.top && sep.height >= 1; })));
  t = await p.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#distGrid button"), (b) => { const r = b.getBoundingClientRect(), s = b.querySelector("svg").getBoundingClientRect(); return r.width >= 20 && r.height >= 28 && s.width > 10 && /^Распределить по /.test(b.title) && b.title === b.getAttribute("aria-label"); }).join());
  check("D1 every button has a visible icon and a name", t === "true,true,true,true,true,true", t);
  check("D1 all twelve icons differ", (await p.page.evaluate(() => new Set(Array.prototype.map.call(document.querySelectorAll(".align-card .align-btn svg"), (x) => x.innerHTML)).size)) === 12);
  await distBtn(p, "left");
  check("D1 nothing selected -> a hint, not an error", (await p.status()) === "Выделите слой в композиции и нажмите ещё раз." && (await p.statusKind()) === "" && p.ae.log.undo.length === 0);
  await p.close();
  three();
  p = await open({ selectedLayers: [L, L3] });
  await motionTab(p); await distBtn(p, "left");
  check("D1 two layers are not enough -> a hint, nothing moves", /выделите три или больше/.test(await p.status()) && (await p.statusKind()) === "" && sameVec(P(L).value, [100, 100, 0]) && sameVec(P(L3).value, [900, 700, 0]), await p.status());
  await p.close();

  three();
  p = await open({ selectedLayers: [L3, L, L2] });   // the order of selection does not matter
  await motionTab(p);
  await distBtn(p, "left");
  check("D2 left edges: the outer layers stay, the middle one's left edge lands halfway (100..900 -> 500)", close2(compBox(L2).l, 500) && close2(compBox(L2).t, 220) && sameVec(P(L).value, [100, 100, 0]) && sameVec(P(L3).value, [900, 700, 0]), JSON.stringify(compBox(L2)));
  check("D2 result reported, one undo step", (await p.status()) === "Распределено: 3 слоя.\nОтменить: Cmd/Ctrl+Z." && (await p.statusKind()) === "done" && p.ae.log.undo.join() === "begin:Sayframe: distribute layers,end", await p.status());
  await distBtn(p, "left");
  check("D2 already even -> says so, changes nothing", (await p.status()) === "Слои уже стоят через равные промежутки." && (await p.statusKind()) === "" && close2(compBox(L2).l, 500));
  P(L2).setValue([150, 220, 0]); await distBtn(p, "hcenter");
  check("D2 horizontal centres (150..950 -> 550)", close2(mid(L2, "x"), 550) && close2(compBox(L2).t, 220), String(mid(L2, "x")));
  P(L2).setValue([150, 220, 0]); await distBtn(p, "right");
  check("D2 right edges (200..1000 -> 600)", close2(compBox(L2).r, 600), String(compBox(L2).r));
  P(L2).setValue([150, 220, 0]); await distBtn(p, "top");
  check("D2 top edges (100..700 -> 400), nothing moves sideways", close2(compBox(L2).t, 400) && close2(compBox(L2).l, 150), JSON.stringify(compBox(L2)));
  P(L2).setValue([150, 220, 0]); await distBtn(p, "vcenter");
  check("D2 vertical centres (150..800 -> 475)", close2(mid(L2, "y"), 475) && close2(compBox(L2).l, 150), String(mid(L2, "y")));
  P(L2).setValue([150, 220, 0]); await distBtn(p, "bottom");
  check("D2 bottom edges (200..900 -> 550)", close2(compBox(L2).b, 550), String(compBox(L2).b));
  check("D2 the outer layers never move, anchor and scale are not touched", sameVec(P(L).value, [100, 100, 0]) && sameVec(P(L3).value, [900, 700, 0]) && sameVec(L2.props["ADBE Scale"].value, [100, 100, 100]) && p.errors.length === 0);
  await p.close();

  // five layers picked in a random order: equal steps between the first and the last
  clock = { time: 0 };
  bx = [40, 700, 90, 1000, 300].map((x, i) => mkLayer(clock, { name: "n" + i, rect: { left: 0, top: 0, width: 20 + i * 10, height: 20 }, position: [x, 50 * i, 0] }));
  p = await open({ selectedLayers: bx });
  await motionTab(p); await distBtn(p, "left");
  t = bx.map((l) => compBox(l).l).sort((a, b) => a - b);
  check("D3 five layers: left edges 40, 280, 520, 760, 1000", t.every((x, i) => close2(x, 40 + 240 * i)) && close2(compBox(bx[0]).l, 40) && close2(compBox(bx[3]).l, 1000) && close2(compBox(bx[2]).l, 280) && close2(compBox(bx[4]).l, 520) && close2(compBox(bx[1]).l, 760), t.join());
  check("D3 heights are untouched and the report counts all five", bx.every((l, i) => close2(compBox(l).t, 50 * i)) && (await p.status()) === "Распределено: 5 слоёв.\nОтменить: Cmd/Ctrl+Z.", await p.status());
  await p.close();

  // a rotated child of a scaled parent in the middle; a 3D layer and a locked one in the selection
  three();
  kid = mkLayer(clock, { name: "parent", rect: { left: 0, top: 0, width: 10, height: 10 }, position: [0, 0, 0], scale: [200, 200, 100], rotation: 90 });
  L2.parent = kid; P(L2).setValue([120, -200, 0]);   // through the parent it covers 300..400 x 240..840
  bx = mkLayer(clock, { name: "3d", threeD: true, position: [500, 500, 50] });
  p = await open({ selectedLayers: [L, L2, L3, bx] });
  await motionTab(p);
  t = compBox(L2);
  await distBtn(p, "left");
  check("D4 a child of a rotated, scaled parent is moved in its parent's space; a 3D layer is skipped and named", close2(t.l, 300) && close2(t.t, 240) && close2(compBox(L2).l, 500) && close2(compBox(L2).t, 240) && sameVec(P(L2).value, [120, -300, 0]) && sameVec(P(kid).value, [0, 0, 0]) && sameVec(P(bx).value, [500, 500, 50]) && (await p.status()) === "Распределено: 3 слоя. Пропущено: 1 слой (3D-слой, камера или свет).\nОтменить: Cmd/Ctrl+Z.", JSON.stringify(compBox(L2)) + " " + await p.status());
  await p.close();
  three();
  bx = mkLayer(clock, { name: "locked", locked: true, rect: { left: 0, top: 0, width: 100, height: 100 }, position: [300, 300, 0] });
  p = await open({ selectedLayers: [L, L2, L3, bx] });
  await motionTab(p); await distBtn(p, "left");
  check("D4 a locked layer is reported, the rest is spread", /^Распределено: 4 слоя\. Не получилось: 1 слой \(слой заблокирован\?\)\./.test(await p.status()) && sameVec(P(bx).value, [300, 300, 0]) && (await p.statusKind()) === "done", await p.status());
  await p.close();

  // animated position: a keyframe at the current time
  three(); clock.time = 2;
  P(L2).addKey(0, [150, 220, 0]).addKey(4, [350, 220, 0]);   // at 2 s the mock holds the first key: 150
  p = await open({ selectedLayers: [L, L2, L3], compTime: 2 });
  await motionTab(p); await distBtn(p, "left");
  check("D5 animated position: a key appears at the current time, the others stay", P(L2).keys.length === 3 && sameVec(P(L2).keys[1].value, [500, 220, 0]) && close2(P(L2).keys[1].time, 2) && sameVec(P(L2).keys[0].value, [150, 220, 0]) && sameVec(P(L2).keys[2].value, [350, 220, 0]), JSON.stringify(P(L2).keys.map((k) => [k.time, k.value])));
  t = JSON.parse(await hostCall(p, 'sayframeHost.distribute("sideways")'));
  check("D5 the host refuses an unknown edge", t.ok === false && /BAD_ALIGN_EDGE/.test(JSON.stringify(t)), JSON.stringify(t));
  check("D5 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  // ---------------------------------------------------------------- animation: shift in time
  console.log("\n=== animation: shift in time ===");
  const F = 1 / 30;   // one frame of the mocked composition
  const R = (l) => l.props["ADBE Rotate Z"], SC = (l) => l.props["ADBE Scale"], MK = (l) => l.props["ADBE Marker"], SL = (l) => l.props["Slider"];
  const times = (prop) => prop.keys.map((k) => Math.round(k.time / F * 1000) / 1000).join();   // key times in frames
  const fr = (sec) => Math.round(sec / F * 1000) / 1000;
  const opt = (p, id) => p.page.locator("#" + id + " option").evaluateAll((l) => l.map((o) => o.value).join());
  const press = async (p, id) => { await p.page.click("#" + id); await p.idle(); };
  const setStep = async (p, id, text, key) => { await p.page.click("#" + id); await p.page.keyboard.type(text); await p.page.keyboard.press(key || "Enter"); };
  // A layer living from 1 s to 5 s (frames 30..150, middle at 90): it comes in over the first half second and leaves over the last.
  const actor = (o) => {
    const l = mkLayer(clock, Object.assign({ inPoint: 1, outPoint: 5 }, o));
    R(l).addKey(1, 0, { selected: true, inType: KIT.HOLD, outType: KIT.BEZIER }).addKey(1.5, 90).addKey(4.5, 90).addKey(5 - F, 0);
    R(l).keys[0].outEase = R(l)._ease(0, 75); R(l).keys[0].label = 3;
    SC(l).addKey(1, [0, 0, 100]).addKey(1.5, [100, 100, 100]);
    SL(l).addKey(2, 7);                       // inside an effect group
    MK(l).addKey(1.2, { comment: "in" }).addKey(4.6, { comment: "out" });
    return l;
  };

  p = await open({});
  await motionTab(p);
  check("T1 a fourth block, 'Shift in time', with three parts", (await p.page.locator('#motionTools [data-tool="shift"] .tool-head b').innerText()) === "Сдвиг во времени" && (await p.page.locator(".shift-card .shift-part").count()) === 3 && (await p.page.locator(".shift-card .align-sep").count()) === 2 && (await p.page.locator(".shift-card .shift-pick label").allInnerTexts()).join() === "Сдвинуть:,Подвести:,Расставить:");
  check("T1 the lists", (await opt(p, "shiftWhat")) === "in,out,layer" && (await opt(p, "timeAlign")) === "inStart,inEnd,outStart,outEnd" && (await opt(p, "staggerWhat")) === "layer,in,out" && (await opt(p, "staggerOrder")) === "asc,desc,selection,random");
  check("T1 defaults: in-animation, one frame, start of the in-animation, layers, top to bottom", [await p.page.inputValue("#shiftWhat"), await p.page.inputValue("#shiftStep"), await p.page.inputValue("#timeAlign"), await p.page.inputValue("#staggerWhat"), await p.page.inputValue("#staggerStep"), await p.page.inputValue("#staggerOrder")].join() === "in,1,inStart,layer,1,asc");
  check("T1 every control is visible and named", (await p.page.evaluate(() => Array.prototype.every.call(document.querySelectorAll(".shift-card button:not(.tool-grip), .shift-card select, .shift-card input"), (el) => { const r = el.getBoundingClientRect(); return r.width >= 14 && r.height >= 14 && !!(el.title || el.getAttribute("aria-label") || el.labels && el.labels.length); }))));
  await press(p, "shiftFwd");
  check("T1 nothing selected -> a hint, not an error", (await p.status()) === "Выделите слой в композиции и нажмите ещё раз." && (await p.statusKind()) === "" && p.ae.log.undo.length === 0);
  await press(p, "timeAlignBtn"); t = await p.status(); await press(p, "staggerBtn");
  check("T1 the same for the other two buttons", t === "Выделите слой в композиции и нажмите ещё раз." && (await p.status()) === t);
  await p.page.locator(".shift-card .tool-info").nth(0).click();
  check("T1 the 'i' explains the part in the status line", /^Появление — все ключи и маркеры в первой половине слоя/.test(await p.status()) && (await p.statusKind()) === "" && (await p.page.locator(".shift-card .tool-info").count()) === 3 && (await p.page.locator(".shift-card .tool-info").evaluateAll((l) => l.every((b) => b.title === b.getAttribute("data-info") && b.title.length > 40))));
  await p.page.selectOption("#shiftWhat", "out"); await p.page.selectOption("#timeAlign", "outEnd"); await p.page.selectOption("#staggerWhat", "in"); await p.page.selectOption("#staggerOrder", "random");
  await setStep(p, "shiftStep", "12"); await setStep(p, "staggerStep", "5");
  await setStep(p, "shiftStep", "abc"); t = await p.page.inputValue("#shiftStep");
  await setStep(p, "shiftStep", "0"); t += "," + await p.page.inputValue("#shiftStep");
  await setStep(p, "shiftStep", "77", "Escape"); t += "," + await p.page.inputValue("#shiftStep");
  check("T1 a step that is not a whole number from 1 is thrown away, Escape cancels typing", t === "12,12,12", t);
  await p.restart();
  check("T1 every choice survives a restart", [await p.page.inputValue("#shiftWhat"), await p.page.inputValue("#shiftStep"), await p.page.inputValue("#timeAlign"), await p.page.inputValue("#staggerWhat"), await p.page.inputValue("#staggerStep"), await p.page.inputValue("#staggerOrder")].join() === "out,12,outEnd,in,5,random" && (await vis(p, "#shiftFwd")));
  await p.page.evaluate(() => localStorage.setItem("sayframe.motion.v1", JSON.stringify({ shiftWhat: "x", shiftStep: -4, timeAlign: 5, staggerWhat: null, staggerStep: 100000, staggerOrder: "up" })));
  await p.restart(); await motionTab(p);
  check("T1 broken saved values fall back safely", [await p.page.inputValue("#shiftWhat"), await p.page.inputValue("#shiftStep"), await p.page.inputValue("#timeAlign"), await p.page.inputValue("#staggerWhat"), await p.page.inputValue("#staggerStep"), await p.page.inputValue("#staggerOrder")].join() === "in,1,inStart,layer,999,asc" && p.errors.length === 0);
  await p.close();
  p = await open({ noActiveComp: true });
  await motionTab(p); await press(p, "shiftBack");
  check("T1 no open composition -> hint", /^Откройте композицию/.test(await p.status()) && (await p.statusKind()) === "");
  await p.close();

  // the in-animation: keys and markers of the first half; the layer's start goes with it because the animation begins right there
  clock = { time: 0 };
  L = actor({});
  p = await open({ selectedLayers: [L] });
  await motionTab(p);
  await press(p, "shiftFwd");
  check("T2 one frame later: every key of the first half moved, in every property, with the marker", times(R(L)) === "31,46,135,149" && times(SC(L)) === "31,46" && times(SL(L)) === "61" && times(MK(L)) === "37,138", [times(R(L)), times(SC(L)), times(SL(L)), times(MK(L))].join(" | "));
  check("T2 the out-animation did not move, values are the same", sameVec(R(L).keys.map((k) => k.value), [0, 90, 90, 0]) && sameVec(SC(L).keys[1].value, [100, 100, 100]) && MK(L).keys[0].value.comment === "in");
  check("T2 the layer's start moved with its animation, the end stayed", close2(fr(L.inPoint), 31) && close2(fr(L.outPoint), 150), fr(L.inPoint) + " " + fr(L.outPoint));
  check("T2 a moved key keeps its interpolation, easing, selection and label", R(L).keys[0].inType === KIT.HOLD && R(L).keys[0].outType === KIT.BEZIER && eases(R(L).keys[0].outEase) === "0/75" && eases(R(L).keys[0].inEase) === "11/16.67" && R(L).keys[0].selected && R(L).keys[0].label === 3 && !R(L).keys[1].selected && R(L).keys[1].inType === KIT.LINEAR, eases(R(L).keys[0].outEase) + " " + R(L).keys[0].inType);
  check("T2 result reported, one undo step", (await p.status()) === "Сдвинуто на 1 кадр позже: 1 слой.\nОтменить: Cmd/Ctrl+Z." && (await p.statusKind()) === "done" && p.ae.log.undo.join() === "begin:Sayframe: shift in time,end", await p.status());
  await setStep(p, "shiftStep", "5"); await press(p, "shiftBack");
  check("T2 five frames earlier with the left arrow", times(R(L)) === "26,41,135,149" && times(MK(L)) === "32,138" && close2(fr(L.inPoint), 26) && (await p.status()) === "Сдвинуто на 5 кадров раньше: 1 слой.\nОтменить: Cmd/Ctrl+Z.", times(R(L)) + " " + await p.status());
  // keys three frames apart moved by three frames: one lands exactly where the other was
  L2 = mkLayer(clock, { inPoint: 1, outPoint: 5 });
  SL(L2).addKey(2, 1).addKey(2 + 3 * F, 2).addKey(2 + 6 * F, 3);
  p.ae.comp.selectedLayers = [L2];
  await setStep(p, "shiftStep", "3"); await press(p, "shiftFwd");
  check("T2 keys that land on each other's old places stay three separate keys", times(SL(L2)) === "63,66,69" && SL(L2).keys.map((k) => k.value).join() === "1,2,3", times(SL(L2)) + " " + SL(L2).keys.map((k) => k.value).join());
  await press(p, "shiftBack"); await press(p, "shiftBack");
  check("T2 and the other way", times(SL(L2)) === "57,60,63" && SL(L2).keys.map((k) => k.value).join() === "1,2,3", times(SL(L2)));
  check("T2 an animation in the middle of the layer leaves the layer's edges alone", L2.edgeSets.length === 0 && L2.inPoint === 1 && L2.outPoint === 5, L2.edgeSets.join());
  await setStep(p, "shiftStep", "40"); await press(p, "shiftBack");
  check("T2 unless the keys would leave the layer: then the start is pushed out to the first key", times(SL(L2)) === "17,20,23" && close2(fr(L2.inPoint), 17) && close2(fr(L2.outPoint), 150), times(SL(L2)) + " " + fr(L2.inPoint) + " " + fr(L2.outPoint));
  await p.close();

  // the out-animation
  L = actor({});
  p = await open({ selectedLayers: [L] });
  await motionTab(p); await p.page.selectOption("#shiftWhat", "out"); await setStep(p, "shiftStep", "3");
  await press(p, "shiftFwd");
  check("T3 out-animation three frames later: keys and marker of the second half, the layer's end with them", times(R(L)) === "30,45,138,152" && times(MK(L)) === "36,141" && times(SC(L)) === "30,45" && times(SL(L)) === "60" && close2(fr(L.outPoint), 153) && close2(fr(L.inPoint), 30), times(R(L)) + " " + fr(L.outPoint) + " " + fr(L.inPoint));
  await press(p, "shiftBack"); await press(p, "shiftBack");
  check("T3 and earlier", times(R(L)) === "30,45,132,146" && close2(fr(L.outPoint), 147), times(R(L)) + " " + fr(L.outPoint));
  await p.page.selectOption("#shiftWhat", "layer"); await press(p, "shiftFwd");
  check("T3 'whole layer' moves everything: both edges, every key, every marker", times(R(L)) === "33,48,135,149" && times(MK(L)) === "39,138" && times(SL(L)) === "63" && close2(fr(L.inPoint), 33) && close2(fr(L.outPoint), 150) && close2(fr(L.startTime), 3), times(R(L)) + " " + fr(L.startTime));
  await p.close();

  // layers with nothing to move, and ones After Effects refuses
  L = actor({});
  L2 = mkLayer(clock, { name: "still", inPoint: 0, outPoint: 4 });
  SL(L2).addKey(3, 1);                              // only an out-animation
  L3 = actor({ name: "locked", locked: true });
  p = await open({ selectedLayers: [L, L2, L3] });
  await motionTab(p); await press(p, "shiftFwd");
  check("T4 a layer without keys in the first half is skipped and a locked one is reported", (await p.status()) === "Сдвинуто на 1 кадр позже: 1 слой. Пропущено: 1 слой (нет ключей в первой половине слоя). Не получилось: 1 слой (слой заблокирован?).\nОтменить: Cmd/Ctrl+Z." && times(SL(L2)) === "90" && times(R(L3)) === "30,45,135,149" && times(R(L)) === "31,46,135,149", await p.status());
  p.ae.comp.selectedLayers = [L2];
  await press(p, "shiftFwd");
  check("T4 nothing to move at all -> said plainly, not an error", (await p.status()) === "Пропущено: 1 слой (нет ключей в первой половине слоя)." && (await p.statusKind()) === "");
  // a property After Effects will not take a key back into at a new time
  L2 = mkLayer(clock, { inPoint: 1, outPoint: 5 });
  SL(L2).addKey(2, 5); SL(L2).sticky = true; R(L2).addKey(2, 10);
  p.ae.comp.selectedLayers = [L2];
  await press(p, "shiftFwd");
  check("T4 a key that cannot be created at the new time is put back, not lost; the rest moves", times(SL(L2)) === "60" && SL(L2).keys[0].value === 5 && times(R(L2)) === "61" && /Не удалось перенести: 1 ключ\./.test(await p.status()), times(SL(L2)) + " " + await p.status());
  await p.close();

  // to the current-time indicator
  L = actor({});
  L2 = actor({ name: "late", inPoint: 2, outPoint: 6 }); R(L2).keys.forEach((k) => { k.time += 1; }); SC(L2).keys.forEach((k) => { k.time += 1; }); SL(L2).keys = []; MK(L2).keys = [];
  p = await open({ selectedLayers: [L, L2], compTime: 3 * F + 1 });   // frame 33
  await motionTab(p); await press(p, "timeAlignBtn");
  check("T5 start of the in-animation to the playhead: both layers begin at frame 33 now", times(R(L)) === "33,48,135,149" && times(R(L2)) === "33,48,165,179" && times(SC(L2)) === "33,48" && close2(fr(L.inPoint), 33) && close2(fr(L2.inPoint), 33) && close2(fr(L2.outPoint), 180), times(R(L)) + " | " + times(R(L2)) + " " + fr(L2.inPoint));
  check("T5 result reported, one undo step", (await p.status()) === "Поставлено на указатель времени: 2 слоя.\nОтменить: Cmd/Ctrl+Z." && p.ae.log.undo.join() === "begin:Sayframe: align to current time,end", await p.status());
  await press(p, "timeAlignBtn");
  check("T5 already there -> says so", (await p.status()) === "Уже на месте: 2 слоя." && (await p.statusKind()) === "" && times(R(L)) === "33,48,135,149");
  await p.page.selectOption("#timeAlign", "inEnd"); await press(p, "timeAlignBtn");
  check("T5 end of the in-animation to the playhead: the last key of the first half (here the effect's key at frame 63) lands there", times(R(L)) === "3,18,135,149" && times(SL(L)) === "33" && times(R(L2)) === "18,33,165,179" && close2(fr(L.inPoint), 3) && close2(fr(L2.inPoint), 18), times(R(L)) + " " + times(SL(L)));
  p.ae.comp.time = 140 * F;
  await p.page.selectOption("#timeAlign", "outStart"); await press(p, "timeAlignBtn");
  check("T5 start of the out-animation", times(R(L)) === "3,18,140,154" && times(MK(L)).split(",")[1] === "143" && times(R(L2)) === "18,33,140,154" && close2(fr(L.outPoint), 155) && close2(fr(L2.outPoint), 155), times(R(L)) + " " + times(MK(L)) + " " + fr(L.outPoint));
  await p.page.selectOption("#timeAlign", "outEnd"); await press(p, "timeAlignBtn");
  check("T5 end of the out-animation", times(R(L)) === "3,18,126,140" && times(R(L2)) === "18,33,126,140" && close2(fr(L.outPoint), 141), times(R(L)) + " " + fr(L.outPoint));
  await p.close();

  // staircase
  const trio = () => { clock = { time: 0 }; return [1, 2, 3].map((n) => actor({ name: "s" + n, index: n })); };
  const starts = (list) => list.map((l) => fr(l.startTime)).join();
  bx = trio();
  p = await open({ selectedLayers: [bx[2], bx[0], bx[1]] });   // picked in the order 3, 1, 2
  await motionTab(p); await setStep(p, "staggerStep", "2");
  await press(p, "staggerBtn");
  check("T6 layers, top to bottom: the top layer stays, each next one starts 2 frames later", starts(bx) === "0,2,4" && times(R(bx[2])) === "34,49,139,153" && close2(fr(bx[1].inPoint), 32), starts(bx));
  check("T6 result reported, one undo step", (await p.status()) === "Лесенка: 3 слоя, шаг 2 кадра.\nОтменить: Cmd/Ctrl+Z." && (await p.statusKind()) === "done" && p.ae.log.undo.join() === "begin:Sayframe: stagger,end", await p.status());
  await press(p, "staggerBtn");
  check("T6 pressing again makes the steps bigger", starts(bx) === "0,4,8");
  await p.page.selectOption("#staggerOrder", "desc"); await press(p, "staggerBtn");
  check("T6 bottom to top: the bottom layer stays (0,4,8 -> 4,6,8)", starts(bx) === "4,6,8", starts(bx));
  await p.page.selectOption("#staggerOrder", "selection"); await press(p, "staggerBtn");
  check("T6 in the order they were picked (3, 1, 2)", starts(bx) === "6,10,8", starts(bx));
  bx.forEach((l) => { l.startTime = 0; });
  await p.page.selectOption("#staggerOrder", "random"); await setStep(p, "staggerStep", "10"); await press(p, "staggerBtn");
  check("T6 random: the same steps in some order", starts(bx).split(",").map(Number).sort((a, b) => a - b).join() === "0,10,20", starts(bx));
  await p.close();
  bx = trio();
  L2 = mkLayer(clock, { name: "plain", index: 2, inPoint: 1, outPoint: 5 });   // no keys: sits between the first and the second
  p = await open({ selectedLayers: [bx[0], L2, bx[1], bx[2]] });
  await motionTab(p); await p.page.selectOption("#staggerWhat", "in"); await setStep(p, "staggerStep", "4"); await press(p, "staggerBtn");
  check("T7 staircase of in-animations: only their keys move, a layer without keys takes no step", bx.map((l) => times(R(l))).join(" | ") === "30,45,135,149 | 34,49,135,149 | 38,53,135,149" && starts(bx) === "0,0,0" && close2(fr(bx[2].inPoint), 38) && close2(fr(bx[2].outPoint), 150) && L2.inPoint === 1, bx.map((l) => times(R(l))).join(" | "));
  check("T7 the skipped layer is named in the report", (await p.status()) === "Лесенка: 3 слоя, шаг 4 кадра. Пропущено: 1 слой (нет ключей в первой половине слоя).\nОтменить: Cmd/Ctrl+Z.", await p.status());
  await p.page.selectOption("#staggerWhat", "out"); await press(p, "staggerBtn");
  check("T7 staircase of out-animations", bx.map((l) => times(R(l))).join(" | ") === "30,45,135,149 | 34,49,139,153 | 38,53,143,157" && close2(fr(bx[2].outPoint), 158), bx.map((l) => times(R(l))).join(" | "));
  p.ae.comp.selectedLayers = [bx[0]];
  await press(p, "staggerBtn");
  check("T7 one layer -> a hint", (await p.status()) === "Для лесенки выделите хотя бы два слоя." && (await p.statusKind()) === "");
  p.ae.comp.selectedLayers = [bx[0], L2];
  await press(p, "staggerBtn");
  check("T7 two layers but only one with keys -> a hint that names the way out", /хотя бы два слоя с ключами/.test(await p.status()) && (await p.statusKind()) === "" && times(R(bx[0])) === "30,45,135,149", await p.status());
  t = [JSON.parse(await hostCall(p, 'sayframeHost.shift("sideways",1)')), JSON.parse(await hostCall(p, 'sayframeHost.alignTime("middle")')), JSON.parse(await hostCall(p, 'sayframeHost.stagger("layer",2,"up")')), JSON.parse(await hostCall(p, 'sayframeHost.stagger("layer",0,"asc")'))];
  check("T7 the host refuses unknown targets, orders and a zero step", t.map((x) => x.ok + ":" + x.error).join() === "false:BAD_SHIFT_TARGET,false:BAD_SHIFT_TARGET,false:BAD_STAGGER_ORDER,false:BAD_SHIFT_FRAMES", JSON.stringify(t));
  check("T7 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  // folding, small size, rearranging
  p = await open({ width: 780 });
  await motionTab(p);
  c = await cardH(p, "shift");
  await p.page.selectOption("#shiftWhat", "out");
  await p.page.click("#shiftOptsToggle");
  check("T8 the minus hides the lists and leaves the buttons; the plus says what is chosen", !(await vis(p, "#shiftPick")) && !(await vis(p, "#timePick")) && !(await vis(p, "#staggerPick")) && !(await vis(p, "#staggerOrder")) && (await vis(p, "#shiftFwd")) && (await vis(p, "#shiftStep")) && (await vis(p, "#timeAlignBtn")) && (await vis(p, "#staggerBtn")) && (await vis(p, "#staggerStep")) && (await fold(p, "shiftOptsToggle")) === "false|Показать списки (сейчас: Исчезновение; Начало появления; Слои; Сверху вниз)|+" && (await cardH(p, "shift")) < c - 100 && (await savedMotion(p, "shiftOpts")) === false, (await fold(p, "shiftOptsToggle")) + " " + (await cardH(p, "shift")) + "/" + c);
  await p.restart();
  check("T8 folded stays folded after a restart, the hidden choice still applies", !(await vis(p, "#shiftPick")) && (await p.page.inputValue("#shiftWhat")) === "out" && (await togglesClear(p)));
  await p.page.click("#shiftOptsToggle");
  check("T8 the plus brings the lists back", (await vis(p, "#shiftPick")) && (await vis(p, "#staggerOrder")) && (await fold(p, "shiftOptsToggle")) === "true|Скрыть списки|-");
  t = await toolRects(p);
  check("T8 at 780px all four blocks share a row", t.ease.t === t.shift.t && t.align.r < t.shift.l && t.shift.w === 168 && (await overflow(p)) <= 0, JSON.stringify(t.shift));
  await dragEdge(p, "shift", 150);
  t = await toolRects(p);
  check("T8 the block can be widened; then caption, list and 'i' stand in one line", t.shift.w === 300 && (await p.page.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const a = r("#shiftPick label"), b = r("#shiftWhat"), i = r("#shiftPick .tool-info"); return a.right <= i.left && i.right <= b.left && Math.abs((a.top + a.bottom) - (b.top + b.bottom)) < 6; })), JSON.stringify(t.shift));
  await arrange(p, '#motionTools [data-tool="shift"] .tool-head b');
  t = await toolRects(p);
  await dragFrom(p, middle(t.shift), { x: t.ease.l + 20, y: middle(t.ease).y });
  check("T8 it is rearranged like the others", (await toolOrder(p)).split(",").indexOf("shift") < 3 && (await savedTools(p)) === (await toolOrder(p)), await toolOrder(p));
  await p.page.keyboard.press("Escape");
  check("T8 no page errors", p.errors.length === 0, p.errors.join(" | "));
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
  check("U6 banner stays visible on the Tools tab", (await barVisible(p)) && (await p.page.locator("#viewTools .empty-note").isVisible()));
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
  // "The update popup doesn't appear after pushing the update": an open panel must find a new release by itself.
  const fresh = { [U]: { version: CUR, files: [] } };
  p = await open({ updateUrl: U, updateEveryMs: 700, remote: fresh });
  await settle(p);
  check("U19 (scene) up to date, no banner", !(await barVisible(p)) && p.net.gets.length >= 1);
  c = p.net.gets.length;
  fresh[U] = { version: "9.9.9", notes: ["свежий выпуск"], files: [] };
  await p.page.waitForSelector("#updateBar:not([hidden])", { timeout: 6000 }).catch(() => {});
  check("U19 a release published while the panel is open shows up by itself, without a restart", (await barVisible(p)) && (await p.page.locator("#updateTitle").innerText()) === "Доступна версия 9.9.9" && (await p.page.locator("#updateNotes li").innerText()) === "свежий выпуск" && p.net.gets.length > c);
  await p.page.evaluate(() => { const s = document.getElementById("updateStatus"); s.textContent = "сообщение"; s.hidden = false; });
  await p.page.waitForTimeout(1800);
  check("U19 later background checks leave a banner that is already shown alone", (await p.page.locator("#updateStatus").innerText()) === "сообщение" && (await barVisible(p)));
  await p.page.click("#updateLater");
  await p.page.waitForTimeout(1800);
  check("U20 a closed banner stays closed for the same version", !(await barVisible(p)));
  fresh[U] = { version: "9.9.10", notes: ["ещё новее"], files: [] };
  await p.page.waitForSelector("#updateBar:not([hidden])", { timeout: 6000 }).catch(() => {});
  check("U20 but a newer release is announced again", (await barVisible(p)) && (await p.page.locator("#updateTitle").innerText()) === "Доступна версия 9.9.10");
  check("U20 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  const quiet = { [U]: { version: CUR, files: [] } };
  p = await open({ updateUrl: U, updateEveryMs: 3600000, remote: quiet });
  await settle(p);
  c = p.net.gets.length;
  quiet[U] = { version: "9.9.9", files: [] };
  await p.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.page.waitForTimeout(600);
  check("U21 coming back to the panel right after a check does not ask the server again", p.net.gets.length === c && !(await barVisible(p)));
  await p.page.evaluate(() => { const s = JSON.parse(localStorage.getItem("sayframe.update.v1")); s.lastCheck = Date.now() - 3 * 3600000; localStorage.setItem("sayframe.update.v1", JSON.stringify(s)); window.dispatchEvent(new Event("focus")); });
  await p.page.waitForSelector("#updateBar:not([hidden])", { timeout: 6000 }).catch(() => {});
  check("U21 coming back later does, and the banner appears", (await barVisible(p)) && p.net.gets.length === c + 1);
  await p.close();
  p = await open({ updateUrl: U, updateState: { base: U, lastCheck: Date.now() - 6 * 60000, latest: { info: { version: CUR }, url: U } }, remote: { [U]: { version: "9.9.9", files: [] } } });
  await settle(p);
  check("U22 a start six minutes after the last check asks the server (it used to wait six hours)", p.net.gets.length === 1 && (await barVisible(p)));
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
