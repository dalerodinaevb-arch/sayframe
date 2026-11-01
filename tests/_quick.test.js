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
// The release key pair: updates are signed with the private key, the panel checks them with the public one.
const RELEASE_KEYS = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const OTHER_KEYS = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
// version.json as tools/release.py writes it: the plain fields for old panels plus the signed copy.
function signRelease(info, key) {
  const payload = JSON.stringify(info);
  const sig = crypto.createSign("RSA-SHA256").update(payload, "utf8").sign(key || RELEASE_KEYS.privateKey, "base64");
  return Object.assign({}, info, { signed: { payload, sig } });
}
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

// Small real PNGs for the cut-out window: pngEncode(w, h, (x, y) => [r, g, b, a]) and pngDecode(buf) -> { w, h, px }.
const zlib = require("zlib");
function pngCrc(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCrc(td)); return Buffer.concat([len, td, crc]); }
function pngEncode(w, h, f) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const c = f(x, y); for (let k = 0; k < 4; k++) raw[y * (w * 4 + 1) + 1 + x * 4 + k] = c[k] === undefined ? 255 : c[k]; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
function pngDecode(buf) {
  let o = 8, w, h, bd, ct; const idat = [];
  while (o < buf.length) { const len = buf.readUInt32BE(o), type = buf.toString("latin1", o + 4, o + 8), d = buf.slice(o + 8, o + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; } else if (type === "IDAT") idat.push(d); o += 12 + len; }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error("png " + bd + "/" + ct);
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), st = w * bpp, px = Buffer.alloc(w * h * 4);
  const cur = Buffer.alloc(st); let prev = Buffer.alloc(st);
  for (let y = 0; y < h; y++) { const ft = raw[y * (st + 1)];
    for (let i = 0; i < st; i++) { const x = raw[y * (st + 1) + 1 + i], a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = x; if (ft === 1) v = x + a; else if (ft === 2) v = x + b; else if (ft === 3) v = x + ((a + b) >> 1); else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      cur[i] = v & 255; }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) px[(y * w + x) * 4 + k] = k < bpp ? cur[x * bpp + k] : 255;
    prev = Buffer.from(cur); }
  return { w, h, px, alpha: (x, y) => px[(y * w + x) * 4 + 3] };
}
// The cut-out photo: a red disc (centre 150,100, r 55) and a green square (20..70, 20..70) on blue.
const CO_W = 300, CO_H = 200;
const coDisc = (x, y) => (x - 150) * (x - 150) + (y - 100) * (y - 100) <= 55 * 55;
const coSquare = (x, y) => x >= 20 && x < 70 && y >= 20 && y < 70;
const coPhoto = () => pngEncode(CO_W, CO_H, (x, y) => coDisc(x, y) ? [220, 40, 40] : coSquare(x, y) ? [40, 200, 70] : [30, 60, 200]);

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
// A generic After Effects property for the Animation library: any child it is asked for exists,
// keys and eases are recorded. acDefault gives transform values a realistic start.
const AC_DEF = { "ADBE Geometry2-0002": [960, 540], "ADBE 4ColorGradient-0007": [1440, 270], "ADBE 4ColorGradient-0001": [480, 270], "ADBE 4ColorGradient-0005": [1440, 810], "ADBE Opacity": 100, "ADBE Scale": [100, 100, 100], "ADBE Position": [960, 540, 0], "ADBE Rotate Z": 0,
  "ADBE Text Percent Start": 0, "ADBE Text Percent End": 100, "ADBE Text Tracking Amount": 0 };
const acDefault = (mn) => (AC_DEF[mn] !== undefined ? JSON.parse(JSON.stringify(AC_DEF[mn])) : 0);
function acInit(p, name, value, log) {
  Object.assign(p, { name, matchName: name, value, keys: [], interp: [], eases: 0, expression: "", dimensionsSeparated: false, children: [], propertyValueType: 0 });
  const adopt = (c) => { c.parentProperty = p; c.propertyDepth = (p.propertyDepth || 0) + 1; p.children.push(c); c.propertyIndex = p.children.length; return c; };
  p.property = (k) => {
    if (typeof k === "number") {
      // an effect's parameters exist from the start, like in After Effects (matchName "<effect>-0001", ...)
      if (!p.children[k - 1] && p.parentProperty && p.parentProperty.matchName === "ADBE Effect Parade") {
        while (p.children.length < k) adopt(acInit({}, p.matchName + "-" + String(p.children.length + 1).padStart(4, "0"), 0, log));
      }
      return p.children[k - 1] || null;
    }
    let c = p.children.find((x) => x.matchName === k || x.name === k);
    if (!c) c = adopt(acInit({}, k, acDefault(k), log));
    return c;
  };
  p.addProperty = (mn) => { const c = adopt(acInit({}, mn, acDefault(mn), log)); if (log) log.acAdds.push(mn); return c; };
  Object.defineProperty(p, "numProperties", { configurable: true, get: () => p.children.length });
  p.remove = () => { const par = p.parentProperty; par.children.splice(par.children.indexOf(p), 1); par.children.forEach((c, i) => { c.propertyIndex = i + 1; }); if (log) log.acRemoved.push(p.name); };
  p.keyTime = (i) => p.keys[i - 1].t;
  p.keyValue = (i) => JSON.parse(JSON.stringify(p.keys[i - 1].v));
  p.removeKey = (i) => { p.keys.splice(i - 1, 1); };
  p.setValue = (v) => { p.value = v; };
  p.addKey = (t) => { let i = p.keys.findIndex((k) => Math.abs(k.t - t) < 1e-9); if (i < 0) { p.keys.push({ t, v: p.value }); p.keys.sort((a, b) => a.t - b.t); i = p.keys.findIndex((k) => Math.abs(k.t - t) < 1e-9); } return i + 1; };
  p.setValueAtKey = (i, v) => { p.keys[i - 1].v = v; };
  p.setValueAtTime = (t, v) => { p.setValueAtKey(p.addKey(t), v); };
  p.nearestKeyIndex = (t) => { let b = 1; p.keys.forEach((k, i) => { if (Math.abs(k.t - t) < Math.abs(p.keys[b - 1].t - t)) b = i + 1; }); return b; };
  Object.defineProperty(p, "numKeys", { configurable: true, get: () => p.keys.length });
  p.valueAtTime = () => p.value;
  p.setInterpolationTypeAtKey = (i, a, b) => { p.interp.push([i, a, b]); };
  p.setTemporalEaseAtKey = (i, a, b) => { if (!Array.isArray(a) || !Array.isArray(b)) throw new Error("ease must be arrays"); p.eases++; };
  return p;
}
// Layer markers, as in After Effects: a comment, a duration and hidden key/value parameters.
function MarkerValue(comment) { this.comment = comment; this.duration = 0; this.params = {}; }
MarkerValue.prototype.setParameters = function (o) { this.params = Object.assign({}, o); };
MarkerValue.prototype.getParameters = function () { return Object.assign({}, this.params); };
// Runs the expression After Effects would run on prop at time t (the JavaScript engine), with the
// layer's markers and effects. Returns the value it gives.
function sfEval(layer, prop, t, extra) {
  if (!prop.expression) return prop.value;
  const mk = acAt(layer, "ADBE Marker");
  const marks = mk ? mk.keys.map((k) => ({ time: k.t, duration: k.v.duration, comment: k.v.comment })) : [];
  const parade = acAt(layer, "ADBE Effect Parade");
  const effect = (n) => {
    const e = parade && parade.children.find((c) => c.name === n);
    if (!e) throw new Error("no effect " + n);
    return (i) => e.children[i - 1].value;
  };
  let seed = 1;
  return vm.runInNewContext(prop.expression, { value: JSON.parse(JSON.stringify(prop.value)), time: t, effect, Math, index: 1,
    noise: (x) => Math.sin(x * 1.7) * 0.8, seedRandom: (n) => { seed = n + Math.floor(t * 12); }, posterizeTime: () => {},
    random: () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; },
    thisLayer: { marker: { numKeys: marks.length, key: (i) => marks[i - 1] }, inPoint: layer.inPoint, outPoint: layer.outPoint },
    inPoint: layer.inPoint, outPoint: layer.outPoint,
    thisComp: { frameDuration: 1 / 30, width: 1920, height: 1080 }, ...(extra || {}) });
}
// Every property in a layer's tree that carries an expression.
const exprProps = (p, out = []) => { (p.children || []).forEach((c) => { if (c.expression) out.push(c); exprProps(c, out); }); return out; };
// Finds a child by match names along a path (for checks).
const acAt = (p, ...path) => path.reduce((n, k) => n && (typeof k === "number" ? n.children[k - 1] : n.children.find((x) => x.matchName === k)), p);
function mkAcLayer(name, kind, log) {
  const L = acInit(kind === "text" ? new TextLayer() : kind === "camera" ? new CameraLayer() : {}, name, null, log);
  Object.assign(L, { name, inPoint: 0, outPoint: 5, startTime: 0, selected: true, propertyDepth: 0, comment: "" });
  const mk = L.property("ADBE Marker");
  mk.keyValue = (i) => mk.keys[i - 1].v;   // MarkerValue objects keep their methods
  return L;
}
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
  this.name = opts.name || "Свойство";
}
Prop.prototype = {
  get numKeys() { return this.keys.length; },
  get value() { return this.keys.length ? this.valueAtTime(this.clock.time, true) : cloneValue(this._v); },
  get expression() { return this._expression; },
  set expression(x) { this._expression = x; },
  get selectedKeys() { const r = []; this.keys.forEach((k, i) => { if (k.selected) r.push(i + 1); }); return r; },
  // as in After Effects: one value type per kind of property (1D, 2D, 3D…)
  get propertyValueType() { return Array.isArray(this._v) ? "D" + this._v.length : "D1"; },
  get canVaryOverTime() { return !this.marker; },
  keyTemporalContinuous(i) { return !!this.keys[i - 1].tCont; }, setTemporalContinuousAtKey(i, on) { this.keys[i - 1].tCont = !!on; },
  keyTemporalAutoBezier(i) { return !!this.keys[i - 1].tAuto; }, setTemporalAutoBezierAtKey(i, on) { this.keys[i - 1].tAuto = !!on; },
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

// --- Decompose: a comp with a precomp layer, modelled closely enough for copying, moving, parenting and timing.
// spec: { pre: overrides for the precomp layer, inner: [layer specs] , selected: ["names"] }
function mkDcComp(name, specs, log) {
  const c = Object.assign(new CompItem(), { name, width: 1920, height: 1080, list: [] });
  Object.defineProperty(c, "numLayers", { get: () => c.list.length });
  Object.defineProperty(c, "selectedLayers", { get: () => c.list.filter((l) => l.selected) });
  c.layer = (i) => c.list[i - 1] || null;
  specs.forEach((sp) => c.list.push(mkDcLayer(c, sp, log)));
  c.list.forEach((l) => { if (l.spec.parent) l.setParentWithJump(c.list.find((x) => x.name === l.spec.parent)); l.jumps = 0; });
  c.duration = 10;
  c.layers = { addNull(dur) { const n = mkDcLayer(c, { name: "Null 1", isNull: true, startTime: 0, outPoint: dur, anchor: [50, 50, 0], position: [960, 540, 0] }, log); c.list.unshift(n); log.npNulls = (log.npNulls || 0) + 1; return n; } };
  return c;
}
function mkDcLayer(comp, sp, log) {
  const tr = {};
  const mk = (n, v) => { tr[n] = { value: v, numKeys: 0, expression: "", expressionEnabled: false, setValue(x) { tr[n].value = x; } }; };
  mk("ADBE Anchor Point", sp.anchor || [960, 540, 0]); mk("ADBE Position", sp.position || [960, 540, 0]);
  mk("ADBE Scale", sp.scale || [100, 100, 100]); mk("ADBE Rotate Z", sp.rotation || 0); mk("ADBE Opacity", sp.opacity === undefined ? 100 : sp.opacity);
  const time = { startTime: sp.startTime || 0, inPoint: sp.inPoint === undefined ? (sp.startTime || 0) : sp.inPoint, outPoint: sp.outPoint === undefined ? 10 : sp.outPoint };
  let parentRef = null;
  const L = { spec: sp, comp, name: sp.name, source: sp.source || null, nullLayer: !!sp.isNull, selected: !!sp.selected, locked: !!sp.locked, enabled: true, threeDLayer: !!sp.threeD,
    stretch: sp.stretch || 100, timeRemapEnabled: !!sp.remap, hasAudio: !!sp.audio, audioEnabled: !!sp.audio, jumps: 0, effects: sp.effects || 0, masks: sp.masks || 0 };
  const guard = () => { if (L.locked) throw new Error("After Effects error: layer is locked"); };
  Object.defineProperty(L, "index", { get: () => L.comp.list.indexOf(L) + 1 });
  Object.defineProperty(L, "parent", { get: () => parentRef, set(v) { guard(); parentRef = v; L.parentSets = (L.parentSets || 0) + 1; } });
  Object.defineProperty(L, "startTime", { get: () => time.startTime, set(v) { guard(); const d = v - time.startTime; time.startTime = v; time.inPoint += d; time.outPoint += d; } });
  Object.defineProperty(L, "inPoint", { get: () => time.inPoint, set(v) { guard(); time.inPoint = v; } });
  Object.defineProperty(L, "outPoint", { get: () => time.outPoint, set(v) { guard(); time.outPoint = v; } });
  L.property = (n) => (n === "ADBE Transform Group" ? { property: (m) => tr[m] || null } : n === "ADBE Effect Parade" ? { numProperties: L.effects } : n === "ADBE Mask Parade" ? { numProperties: L.masks } : null);
  L.tr = tr;
  const clone = (target) => {
    const n = mkDcLayer(target, Object.assign({}, sp, { name: L.name, startTime: time.startTime, inPoint: time.inPoint, outPoint: time.outPoint, selected: false, locked: L.locked }), log);
    Object.keys(tr).forEach((k) => { n.tr[k].value = tr[k].value; });
    n.copyOf = L; return n;
  };
  L.copyToComp = (target) => { const n = clone(target); target.list.unshift(n); log.dcCopies = (log.dcCopies || 0) + 1; };
  L.moveBefore = (other) => { guard(); const l = L.comp.list; l.splice(l.indexOf(L), 1); l.splice(l.indexOf(other), 0, L); };
  L.replaceSource = (item, fix) => { L.source = item; log.coReplaced = (log.coReplaced || []).concat([{ layer: L.name, item: item.name, fix }]); };
  L.duplicate = () => { const n = clone(L.comp); n.parent = L.parent; const l = L.comp.list; l.splice(l.indexOf(L), 0, n); return n; };
  L.remove = () => { const l = L.comp.list; l.splice(l.indexOf(L), 1); log.dcRemoved = (log.dcRemoved || []).concat([L.name]); };
  L.setParentWithJump = (p) => { parentRef = p; L.jumps++; };
  return L;
}
// --- Projects (brand books): a comp with a text, a shape, a solid and a plain layer, as the brand tools see them.
function mkBrColor(v) { const p = { value: v, numKeys: 0, canSetExpression: true, expression: "", setValue(x) { p.value = x; }, setValueAtKey(k, x) { p.value = x; } }; return p; }
function mkBrFx(log) {
  const list = [];
  return { list, get numProperties() { return list.length; }, property: (i) => (typeof i === "number" ? list[i - 1] : list.find((e) => e.name === i || e.matchName === i)) || null,
    addProperty(match) {
      if (match === "ADBE Ramp") {
        // Gradient Ramp: start/end point, start/end colour, shape — kept by match name.
        const vals = {}, e = { matchName: match, name: "Gradient Ramp", vals, property: (k) => ({ setValue(v) { vals[k] = v; } }) };
        list.push(e); return e;
      }
      const color = mkBrColor([1, 1, 1]);
      const e = { matchName: match, name: match === "ADBE Fill" ? "Fill" : "Color Control", color,
        property: (k) => (k === 1 || k === "ADBE Fill-0002" ? color : null) };
      list.push(e); log.brFx = (log.brFx || 0) + 1; return e;
    } };
}
function mkBrComp(log, layers) {
  const c = Object.assign(new CompItem(), { name: "Main", width: 1920, height: 1080, duration: 10, list: [] });
  Object.defineProperty(c, "numLayers", { get: () => c.list.length });
  Object.defineProperty(c, "selectedLayers", { get: () => c.list.filter((l) => l.selected) });
  c.layer = (i) => c.list[i - 1] || null;
  const mk = (kind, name, selected) => {
    const L = Object.create(kind === "text" ? TextLayer.prototype : kind === "shape" ? ShapeLayer.prototype : Object.prototype);
    const fx = mkBrFx(log);
    Object.assign(L, { name, kind, selected: !!selected, locked: false, fx, sourceRectAtTime: () => ({ left: 0, top: 0, width: 400, height: 200 }) });
    if (kind === "text") {
      L.td = { text: name, font: "ArialMT", fillColor: [1, 1, 1], applyFill: true };
      const doc = { get value() { return Object.assign({}, L.td); }, setValue(v) { L.td = Object.assign({}, v); } };
      L.property = (n) => (n === "ADBE Text Properties" ? { property: () => doc } : n === "ADBE Effect Parade" ? fx : null);
    } else if (kind === "shape") {
      L.fillColors = [mkBrColor([0, 0, 0]), mkBrColor([0, 0, 0])];
      const grp = (kids) => ({ numProperties: kids.length, property: (i) => kids[i - 1] });
      const fill = (col) => ({ matchName: "ADBE Vector Graphic - Fill", numProperties: 1, property: () => col });
      const root = grp([Object.assign(grp([fill(L.fillColors[0])]), { matchName: "ADBE Vector Group" }), fill(L.fillColors[1])]);
      L.property = (n) => (n === "ADBE Root Vectors Group" ? root : n === "ADBE Effect Parade" ? fx : null);
    } else {
      if (kind === "solid") { L.source = { mainSource: Object.assign(new SolidSource(), { color: [0, 0, 0] }) }; }
      L.property = (n) => (n === "ADBE Effect Parade" ? fx : null);
    }
    return L;
  };
  (layers || []).forEach((l) => c.list.push(mk(l.kind, l.name, l.selected)));
  c.layers = {
    addNull() { const n = mk("null", "Null 1"); c.list.unshift(n); return n; },
    addSolid(color, name, w, h, par, dur) { const n = mk("solid", name); n.sourceRectAtTime = () => ({ left: 0, top: 0, width: w, height: h }); n.solidSize = [w, h]; c.list.unshift(n); return n; },
    addText(t) { const n = mk("text", String(t)); n.added = true; c.list.unshift(n); log.brTexts = (log.brTexts || []).concat([n]); return n; },
    add(item) {
      const l = { name: item.name, source: item, collapseTransformation: false };
      l.property = (g) => (g === "ADBE Transform Group" ? { property: (n) => (n === "ADBE Scale" ? { setValue(v) { l.scale = v; } } : null) } : null);
      log.brAdded = (log.brAdded || []).concat([item.name]); log.brAddedLayers = (log.brAddedLayers || []).concat([l]); return l;
    }
  };
  return c;
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
    layers: { add(item) {
      const l = { index: 1, stretch: 100, name: "", source: item, levels: [0, 0] };
      l.property = (g) => (g === "ADBE Audio Group" ? { property: () => ({ setValue(v) { l.levels = v; }, get value() { return l.levels; } }) } : { property() { return { setValue() {} }; } });
      l.remove = () => { log.layersRemoved.push(l.name); };
      log.layerAdds.push(item); log.addedLayers.push(l); return l; },
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
      addShape() { const l = mkAcLayer("Shape Layer", "shape", log); log.acLayers.push(l); l.remove = () => { log.layersRemoved.push(l.name); }; return l; },
      addSolid(color, name, w, h, pa, dur) {
        const l = mkAcLayer(name, "solid", log); Object.assign(l, { solidColor: color, width: w, height: h, adjustmentLayer: false, blendingMode: 5208 });
        l.moveToBeginning = () => { l.movedToTop = true; }; l.remove = () => { log.layersRemoved.push(l.name); };
        log.acLayers.push(l); return l;
      },
      addText(t) { const l = mkAcLayer(String(t), "text", log); acInit(l.property("ADBE Text Properties").property("ADBE Text Document"), "ADBE Text Document", { text: t, fontSize: 40 }, log); log.acLayers.push(l); return l; },
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
  // opts.decomp: { pre: {...}, inner: [...], others: [...] } — "Main" with a precomp layer "PRE" whose source is "Inner".
  let dcMain = null;
  if (opts.decomp) {
    const d = opts.decomp;
    const inner = mkDcComp("Inner", d.inner || [{ name: "Logo", parent: "Shape", startTime: 0, outPoint: 10 }, { name: "Shape", startTime: 1, outPoint: 8 }, { name: "Bg2", startTime: 0, outPoint: 10, locked: true }], log);
    const pre = Object.assign({ name: "PRE", source: inner, startTime: 2, inPoint: 2, outPoint: 6, selected: true }, d.pre || {});
    dcMain = mkDcComp("Main", d.main || [{ name: "Title", selected: !!d.titleSelected }, pre, { name: "BG" }], log);
    log.dcInner = inner;
  }
  if (opts.np) { dcMain = mkDcComp("Main", opts.np, log); }
  // opts.co: { path, still, w, h } — the open comp has a photo layer «Фото» (selected) and «BG».
  if (opts.co) {
    const src = Object.assign(new FootageItem(), { name: path.basename(opts.co.path), width: opts.co.w || CO_W, height: opts.co.h || CO_H,
      mainSource: Object.assign(new FileSource(), { file: new File(opts.co.path), isStill: opts.co.still !== false }) });
    dcMain = mkDcComp("Main", [{ name: "Фото", source: src, selected: opts.co.select !== false }, { name: "BG" }], log);
  }
  if (opts.br) { dcMain = mkBrComp(log, opts.br); dcMain.openInViewer = () => { project.activeItem = dcMain; }; }
  log.dcMain = dcMain;
  // opts.unused: [{ name, used }] — footage in the project, used in a comp or not.
  (opts.unused || []).forEach((u) => projItems.push(Object.assign(new FootageItem(), { name: u.name, usedIn: u.used ? [comp] : [], parentFolder: rootFolder })));
  const project = { get numItems() { return projItems.length; },
    removeUnusedFootage() { const gone = projItems.filter((x) => x instanceof FootageItem && x.usedIn && !x.usedIn.length); gone.forEach((x) => projItems.splice(projItems.indexOf(x), 1)); log.unusedRemoved = gone.map((x) => x.name); return gone.length; }, activeItem: opts.noActiveComp ? null : dcMain || comp, item(i) { return projItems[i - 1]; },
    file: opts.projectFile ? new File(opts.projectFile) : null, rootFolder,
    addFootage(it) { projItems.push(it); },
    importFile(io) {
      if (opts.importThrows) throw new Error("unsupported file");
      log.imports.push(io.file.fsName);
      const it = Object.assign({ name: path.basename(io.file.fsName), parentFolder: rootFolder, remove() { log.removed.push("item"); } }, opts.footage);
      project.activeItem = it;
      return it;
    },
    items: { addFolder(name) { const f = new FolderItem(name); f.id = 900 + log.bins.length; projItems.push(f); log.bins.push(name);
        f.remove = () => { projItems.splice(projItems.indexOf(f), 1); log.bins.splice(log.bins.lastIndexOf(name), 1); log.undo.push("mark"); }; return f; },
      addComp(name, w, h, par, dur, fps) {
        const c = Object.assign(new CompItem(), { name, width: w, height: h, duration: dur, frameRate: fps, saved: [], scaleSet: null,
          openInViewer() { log.opened++; project.activeItem = c; },
          layers: { add(it) { c.added = it; c.addedLayer = { collapseTransformation: false, property() { return { property() { return { setValue(v) { c.scaleSet = v; } }; } }; } }; return c.addedLayer; },
            addSolid(color, nm, sw, sh) { c.solid = { color, name: nm, w: sw, h: sh }; return c.solid; } },
          saveFrameToPng(t, file) { c.saved.push(t); fs.writeFileSync(file.fsName, fakePng(c.saved.length - 1)); },
          remove() { log.removed.push("comp"); } });
        log.refComps.push(c); return c;
      } } };
  // A small After Effects install on disk for FX Console: shipped presets beside the app, user presets in Documents.
  function Folder(p) { this.fsName = p; this.name = encodeURI(path.basename(p)); }
  Object.defineProperty(Folder.prototype, "exists", { get() { return fs.existsSync(this.fsName) && fs.statSync(this.fsName).isDirectory(); } });
  Object.defineProperty(Folder.prototype, "parent", { get() { return new Folder(path.dirname(this.fsName)); } });
  Folder.prototype.selectDlg = function (prompt) { log.folderDlg.push({ path: this.fsName, prompt }); return opts.pickFolder === null ? null : new Folder(opts.pickFolder || this.fsName); };
  Folder.prototype.create = function () { fs.mkdirSync(this.fsName, { recursive: true }); return true; };
  Folder.prototype.getFiles = function () { return fs.readdirSync(this.fsName).sort().map((n) => { const f = path.join(this.fsName, n); return fs.statSync(f).isDirectory() ? new Folder(f) : new File(f); }); };
  const aeRoot = path.join(tmpDir, "Applications", "Adobe After Effects 2026");
  const write = (base, files) => Object.keys(files || {}).forEach((rel) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, files[rel]); });
  fs.mkdirSync(path.join(aeRoot, "Adobe After Effects 2026.app"), { recursive: true });
  write(path.join(aeRoot, "Presets"), opts.presets);
  write(path.join(tmpDir, "Documents", "Adobe", "After Effects 2026", "User Presets"), opts.userPresets);
  Folder.appPackage = new Folder(path.join(aeRoot, "Adobe After Effects 2026.app"));
  Folder.myDocuments = new Folder(path.join(tmpDir, "Documents"));
  log.acAdds = []; log.acLayers = []; log.acRemoved = []; log.layersRemoved = []; log.addedLayers = [];
  log.snaps = []; log.saveDlg = []; log.events = []; log.tasks = []; log.folderDlg = [];
  File.prototype.saveDlg = function (prompt) { log.saveDlg.push({ path: this.fsName, prompt }); return opts.saveAs === null ? null : new File(opts.saveAs || this.fsName); };
  Object.defineProperty(File.prototype, "parent", { configurable: true, get() { return new Folder(path.dirname(this.fsName)); } });
  const keyboardState = { keyName: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  function CSXSEvent() {} CSXSEvent.prototype.dispatch = function () { log.events.push({ type: this.type, data: this.data }); };
  // ScriptUI, just enough for the effect search window at the mouse: controls keep their state, the test
  // types and presses keys through them. log.windows holds every window made.
  log.windows = [];
  function SuiControl(type, text) {
    const c = { type, text: text || "", listeners: {}, items: [], _sel: null, children: [] };
    c.addEventListener = (t, fn) => { (c.listeners[t] = c.listeners[t] || []).push(fn); };
    c.add = (kind, label) => { const it = { text: label, index: c.items.length, subItems: [{ text: "" }] }; c.items.push(it); return it; };
    c.removeAll = () => { c.items = []; c._sel = null; };
    Object.defineProperty(c, "selection", { get: () => c._sel, set: (v) => { c._sel = typeof v === "number" ? c.items[v] || null : v; } });
    return c;
  }
  function Window(type, title) {
    const w = SuiControl("window", title);
    w.add = (kind, a, b) => { const c = SuiControl(kind, kind === "listbox" ? "" : b); w.children.push(c); return c; };
    w.layout = { layout() {} };
    w.bounds = { left: 0, top: 0, right: 356, bottom: 340 };
    w.shown = false; w.closed = false;
    w.places = [];
    Object.defineProperty(w, "location", { get: () => w._loc, set: (v) => { w._loc = v; w.places.push({ at: v, shown: w.shown }); } });
    // opts.popupMoves: like macOS, show() puts the palette back in the middle of the screen.
    w.show = () => { w.shown = true; if (opts.popupMoves) w._loc = [542, 280]; };
    w.close = () => { if (w.closed) return; w.closed = true; if (w.onClose) w.onClose(); };
    w.find = (kind) => w.children.find((c) => c.type === kind);
    w.key = (name) => { const ev = { keyName: name, preventDefault() {} }; (w.find("edittext").listeners.keydown || []).forEach((fn) => fn(ev)); };
    w.type_ = (text) => { const q = w.find("edittext"); q.text = text; q.onChanging(); };
    w.rows = () => w.find("listbox").items.map((it) => it.text + " | " + it.subItems[0].text);
    log.windows.push(w);
    return w;
  }
  function ExternalObject() {}
  comp.saveFrameToPng = function (t, file) { log.snaps.push({ t, path: file.fsName }); if (!opts.snapFails) fs.writeFileSync(file.fsName, fakePng(0)); };
  const app = { version: "26.0", project, effects: opts.effects || FX_EFFECTS,
    scheduleTask: (code, ms, repeat) => { log.tasks.push({ code, ms, repeat }); return log.tasks.length; }, cancelTask: (id) => { log.tasks[id - 1].cancelled = true; },
    preferences: { getPrefAsLong: () => (opts.fileAccessOff ? 0 : 1) },
    beginUndoGroup: (n) => log.undo.push("begin:" + n), endUndoGroup: () => log.undo.push("end"), __ran: (x) => log.ran.push(x),
    executeCommand: opts.noExecuteCommand ? undefined : (id) => { log.commands = (log.commands || []).concat([id]); },
    purge: (t) => { log.purges = (log.purges || []).concat([t]); },
    fonts: opts.noFonts ? undefined : { allFonts: [[{ postScriptName: "Inter-Regular" }, { postScriptName: "Inter-Bold" }], [{ postScriptName: "Montserrat-Bold" }]],
      getFontsByPostScriptName: (n) => (/^(Inter|Montserrat|ArialMT)/.test(n) ? [{ postScriptName: n }] : []) } };
  const ctx = vm.createContext({ app, PurgeTarget: opts.noPurge ? undefined : { ALL_CACHES: 1012, UNDO_CACHES: 1013, SNAPSHOT_CACHES: 1014, IMAGE_CACHES: 1015 }, File, Folder, MarkerValue, BlendingMode: { NORMAL: 5208, SCREEN: 5220, ADD: 5212 }, Shape: function Shape() {}, CSXSEvent, ExternalObject, Window, ScriptUI: { environment: { keyboardState } }, FolderItem, FootageItem, FileSource, PlaceholderSource, ImportOptions, CompItem, TextLayer, ShapeLayer, CameraLayer, LightLayer, SolidSource, $: { sleep() {}, screens: [{ left: 0, top: 0, right: 1440, bottom: 900 }] },
    KeyframeEase, KeyframeInterpolationType: KIT, PropertyType: { PROPERTY, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 } });
  ctx.$.global = ctx;
  if (!opts.hostNotPreloaded) vm.runInContext(hostSrc, ctx);
  if (opts.staleHost) vm.runInContext("delete sayframeHost.acAnimate; delete sayframeHost.acText; delete sayframeHost.acList; delete sayframeHost.trApply; delete sayframeHost.sfApply;", ctx);
  log.scripts = [];
  return { log, project, comp, projItems, ctx, keyboardState, evalScript(script) {
    log.lastScript = script; log.scripts.push(script);
    if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(script)) return "EvalScript error."; // the bridge must stay ASCII
    try {
      if (/^\$\.evalFile\(/.test(script)) { log.evalFiles = (log.evalFiles || 0) + 1; vm.runInContext(hostSrc, ctx); const rest = script.replace(/^\$\.evalFile\([^)]*\);\s*/, ""); const r0 = vm.runInContext(rest, ctx); return typeof r0 === "string" ? r0 : String(r0); }
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
          // Objects are served signed (as a real release), unless the scenario says otherwise.
          if (typeof r === "string") return { status: 200, text: r };
          return { status: 200, text: JSON.stringify(opts.unsignedUpdate || r.signed ? r : signRelease(r)) };
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
        case "verify": try { return crypto.createVerify("RSA-SHA256").update(args[0], "utf8").verify(args[2], args[1], "base64"); } catch (e) { return false; }
        case "reloaded": net.reloads = (net.reloads || 0) + 1; return null;
        case "pickFile": return opts.pickFile || null;
        case "pickFiles": return opts.pickFiles || (opts.pickFile ? [opts.pickFile] : []);
        case "imageSize": return opts.imageSize === undefined ? { width: 800, height: 600 } : opts.imageSize;
        case "exec": {
          sys.exec.push({ file: args[0], args: args[1] });
          if (args[0] !== "osascript") return { code: 1, stdout: "", stderr: "unknown command" };
          // Where the mouse is (the effect search at the mouse). opts.mouse: [x, y], or nothing — the system does not answer.
          if (args[1][0] === "-l" && args[1][2] === "-e" && /mouseLocation/.test(args[1][3])) return opts.mouse ? { code: 0, stdout: opts.mouse.join(" ") + "\n", stderr: "" } : { code: 1, stdout: "", stderr: "execution error" };
          if (args[1][0] === "-e") { sys.copied = (sys.copied || []).concat([args[1][1]]); return opts.copyFails ? { code: 1, stdout: "", stderr: "no" } : { code: 0, stdout: "", stderr: "" }; }
          if (/vision\.js$/.test(args[1][2] || "")) {
            // The cut-out window asks macOS for the objects on the photo. opts.vision: undefined — an older macOS,
            // { masks: [fn(x, y) -> bool, …] } — what it finds, { error } — it fails.
            const [, , js, src, dir, res] = args[1];
            sys.vision = { js: fs.readFileSync(js, "utf8"), src };
            const v = opts.vision;
            if (!v) { fs.writeFileSync(res, "NOVISION"); return { code: 0, stdout: "", stderr: "" }; }
            if (v.error) { fs.writeFileSync(res, "ERR " + v.error); return { code: 0, stdout: "", stderr: "" }; }
            v.masks.forEach((m, i) => fs.writeFileSync(path.join(dir, "mask-" + i + ".png"), pngEncode(v.w || CO_W, v.h || CO_H, (x, y) => m(x, y) ? [255, 255, 255] : [0, 0, 0])));
            fs.writeFileSync(res, "OK " + v.masks.length);
            return { code: 0, stdout: "", stderr: "" };
          }
          const [, , js, png, res] = args[1];
          sys.jxa = fs.readFileSync(js, "utf8");
          // opts.clipEmptyReads: the system says "nothing there" this many times before it hands the picture over.
          if (sys.exec.filter((x) => x.file === "osascript").length <= (opts.clipEmptyReads || 0)) { fs.writeFileSync(res, "NOIMAGE"); return { code: 0, stdout: "NOIMAGE\n", stderr: "" }; }
          // opts.clipFromAE: what is on the clipboard was copied inside After Effects (layers, keys).
          if (opts.clipFromAE && args[1].indexOf("strict") >= 0) { fs.writeFileSync(res, "NOIMAGE"); return { code: 0, stdout: "NOIMAGE\n", stderr: "" }; }
          const clip = opts.clip || "none";
          if (clip === "png") { fs.writeFileSync(png, fakePng(0)); fs.writeFileSync(res, "OK"); return { code: 0, stdout: "OK\n", stderr: "" }; }
          if (clip === "error") return { code: 1, stdout: "", stderr: "execution error: Error: TypeError (-2700)" };
          if (clip && clip.file) { fs.writeFileSync(res, "FILE:" + clip.file); return { code: 0, stdout: "", stderr: "" }; }
          fs.writeFileSync(res, "NOIMAGE"); return { code: 0, stdout: "NOIMAGE\n", stderr: "" };
        }
        case "postJSON": {
          const [url, headers, body] = args;
          if ((opts.statsUrl && url === opts.statsUrl) || /^https:\/\/script\.google\.com\/macros\//.test(url)) {
            net.stats = (net.stats || []).concat([{ url, headers, body: JSON.parse(body) }]);
            if (opts.statsFail) throw new Error("getaddrinfo ENOTFOUND script.google.com");
            return { status: 302, text: "" };   // Apps Script answers a POST with a redirect to the result
          }
          net.requests.push({ url, headers, body: JSON.parse(body), ascii: true });
          if (opts.offline) throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
          const r = net.replies.shift();
          if (r === undefined) return { status: 500, text: "" };
          // { hang: true } — the server never answers (until «Стоп»); { netError } — the connection breaks;
          // { httpStatus, retryAfter } — an error with that status (429, 529…).
          if (r.hang) return new Promise(() => {});
          if (r.netError) throw new Error(r.netError);
          const reply = Object.assign({}, r); delete reply.httpStatus; delete reply.retryAfter;
          return { status: r.httpStatus || (r.type === "error" ? 400 : 200), text: JSON.stringify(reply), retryAfter: r.retryAfter || "" };
        }
      }
      throw new Error("unknown platform call " + name);
    });

    const stored = opts.settings === null ? null : Object.assign({ apiKey: "sk-ant-test", selfCheck: false, infoTips: false }, opts.settings || {});
    await page.addInitScript(({ stored, fresh, tmpDir, home, hostPath, withSystemPath, updateUrl, updateKey, updateState, updateEveryMs, statsUrl, keyWatch, skin }) => {
      window.__SAYFRAME_TEST_UPDATE_URL__ = updateUrl;
      window.__SAYFRAME_TEST_UPDATE_KEY__ = updateKey;
      window.__SAYFRAME_TEST_RETRY_MS__ = [40, 40, 40];
      if (statsUrl) window.__SAYFRAME_STATS_URL__ = statsUrl;
      window.__SAYFRAME_TEST_UPDATE_EVERY_MS__ = updateEveryMs || 0;
      window.__opened = [];
      // Seed saved state only when the page is first opened. Touching localStorage from this start-up
      // script on a reload makes Chromium occasionally hand the page an empty store (a test-browser quirk).
      const firstOpen = window.name !== "sayframe-test-seeded";
      window.name = "sayframe-test-seeded";
      if (firstOpen) { if (stored) localStorage.setItem("sayframe.settings.v1", JSON.stringify(stored)); else localStorage.removeItem("sayframe.settings.v1"); }
      // Most scenarios were written for a panel that was already in use: AI tab first and open, blocks in a row.
      // A new install (opts.fresh) gets the layout of 1.40.0 instead.
      if (firstOpen && !fresh) {
        localStorage.setItem("sayframe.tabOrder.v1", JSON.stringify(["claude", "tools", "motion", "shape", "brand"]));
        localStorage.setItem("sayframe.tab.v1", "claude");
        localStorage.setItem("sayframe.motion.v1", JSON.stringify({ order: "ease,anchor,align,shift,paste,organize,easecopy,decompose,cache,nullp,unused", sizes: "", places: "", pins: "", grid: 2, curve: true,
          anchorOpts: true, alignOpts: true, shiftOpts: true, pasteOpts: true, organizeOpts: true, ecOpts: true, decomposeOpts: true, cacheOpts: true, nullpOpts: true, unusedOpts: true }));
      }
      if (updateState && firstOpen) localStorage.setItem("sayframe.update.v1", JSON.stringify(updateState));
      window.__keyInterest = [];
      window.__cepListeners = {};
      window.__adobe_cep__ = { evalScript(script, cb) { window.__hostEval(script).then(cb); },
        registerKeyEventsInterest(json) { window.__keyInterest.push(json); },
        addEventListener(type, fn) { window.__cepListeners[type] = fn; },
        getSystemPath() { return withSystemPath ? "file://" + hostPath : ""; },
        getHostEnvironment() { const env = { appName: "AEFT", appVersion: "25.0.1" }; const k = window.__skin;
          // opts.skin: the colours of After Effects' own panels, as CEP reports them ({ bg: [r, g, b], hi: [r, g, b] }).
          if (k) env.appSkinInfo = { panelBackgroundColor: { antialiasLevel: 0, color: { red: k.bg[0], green: k.bg[1], blue: k.bg[2], alpha: 255 } },
            systemHighlightColor: { red: k.hi[0], green: k.hi[1], blue: k.hi[2], alpha: 255 } };
          return JSON.stringify(env); } };
      window.__skin = skin;
      const call = (name) => function () { return window.__plat(name, Array.prototype.slice.call(arguments)); };
      window.__SAYFRAME_TEST_PLATFORM__ = {
        available: true,
        tmpdir: () => tmpDir, homedir: () => home, isWindows: () => false,
        join: function () { return Array.prototype.join.call(arguments, "/").replace(/\/+/g, "/"); },
        dirname: (p) => p.replace(/\/[^\/]*$/, ""), basename: (p) => p.replace(/^.*\//, ""),
        readBase64: call("readBase64"), readText: call("readText"), writeText: call("writeText"),
        writeBytes: (p, bytes) => window.__plat("writeBytes", [p, Array.from(bytes)]),
        remove: call("remove"), exists: call("exists"), mkdirp: call("mkdirp"), move: call("move"),
        exec: call("exec"), pickFile: call("pickFile"), pickFiles: call("pickFiles"), imageSize: call("imageSize"), postJSON: (u, h, b, t) => window.__plat("postJSON", [u, h, b, t]),
        getText: call("getText"), download: call("download"), fetchUrl: call("fetchUrl"), verify: call("verify"),
        openExternal: (u) => { window.__opened.push(u); return true; },
        reload: () => { window.__plat("reloaded", []).then(() => window.location.reload()); }
      };
      // opts.keyWatch: the platform can start long processes (the key watcher). The test plays its output.
      if (keyWatch) {
        window.__spawns = [];
        window.__SAYFRAME_TEST_PLATFORM__.spawn = (file, args, onLine, onExit) => {
          const s = { file, args, onLine, onExit, killed: false };
          window.__spawns.push(s);
          return { kill() { s.killed = true; } };
        };
      }
    }, { stored, fresh: !!opts.fresh, tmpDir, home, hostPath: extDir, withSystemPath: true, updateUrl: opts.updateUrl || "", updateKey: opts.updateKey === undefined ? RELEASE_KEYS.publicKey : opts.updateKey, updateState: opts.updateState || null, updateEveryMs: opts.updateEveryMs || 0, statsUrl: opts.statsUrl || "", keyWatch: !!opts.keyWatch, skin: opts.skin || null });

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
      // Waits for the task to start (the Run button goes grey) before waiting for it to end: otherwise a quick look
      // right after the click can find the button still enabled and return while the task is only beginning.
      async run(text) {
        await page.fill("#prompt", text); await page.click("#runBtn");
        await page.waitForFunction(() => document.getElementById("runBtn").disabled || !document.getElementById("modal").hidden, null, { timeout: 2000 }).catch(() => {});
        await h.idle();
      },
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
  const overflow = (p) => p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); let p, t;
  // Design: «Стекло» (default) or «After Effects» — same layout, AE-like look.
  p = await open({ width: 380 });
  t = () => p.page.evaluate(() => [document.documentElement.getAttribute("data-design"), getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector(".glow")).display]);
  check("DS1 by default the panel keeps its glass look", JSON.stringify(await t()) === JSON.stringify(["glass", "rgb(11, 12, 18)", "block"]), JSON.stringify(await t()));
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
  check("DS1 settings offer «Стекло», «After Effects» and «Студия», glass chosen", (await p.page.locator("#designPick button").allInnerTexts()).join() === "Стекло,After Effects,Студия" && (await p.page.getAttribute('#designPick [data-value="glass"]', "aria-pressed")) === "true");
  await p.page.click('#designPick [data-value="ae"]');
  check("DS2 picking «After Effects» shows at once: grey, no glow", JSON.stringify(await t()) === JSON.stringify(["ae", "rgb(35, 35, 35)", "none"]), JSON.stringify(await t()));
  await p.page.click("#settingsClose");
  check("DS2 closing without saving brings the glass back", (await t())[0] === "glass");
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther"); await p.page.click('#designPick [data-value="ae"]'); await p.page.click("#saveSettings");
  await p.restart();
  check("DS3 the design survives a restart and the layout stays the same", (await t())[0] === "ae" && (await p.page.locator("#tabs .tab").count()) === 5 && (await p.page.locator("#runBtn").isVisible()) && p.errors.length === 0, p.errors.join(" | "));
  await p.page.click("#tabMotion");
  check("DS3 the Tools tab works the same in the new look", (await p.page.locator('#motionTools .tool-card[data-tool="paste"] #pasteBtn').isVisible()) && (await overflow(p)) <= 0);
  await p.page.screenshot({ path: path.join(SHOTS, "09e-design-ae.png") });
  await p.close();

  // «After Effects» takes its colours from After Effects itself: the panel background (the Brightness slider) and the highlight colour.
  p = await open({ width: 380, settings: { design: "ae" }, skin: { bg: [50, 50, 50], hi: [230, 120, 20] } });
  t = () => p.page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector(".card")).backgroundColor, getComputedStyle(document.querySelector("#runBtn")).backgroundColor, getComputedStyle(document.body).color]);
  check("DS7 «After Effects» uses After Effects' own panel colour and highlight colour", JSON.stringify(await t()) === JSON.stringify(["rgb(50, 50, 50)", "rgb(55, 55, 55)", "rgb(230, 120, 20)", "rgb(214, 214, 214)"]), JSON.stringify(await t()));
  await p.page.evaluate(() => { window.__skin = { bg: [184, 184, 184], hi: [45, 140, 235] }; window.__cepListeners["com.adobe.csxs.events.ThemeColorChanged"]({}); });
  check("DS7 After Effects made lighter: the panel follows at once, with dark text", JSON.stringify(await t()) === JSON.stringify(["rgb(184, 184, 184)", "rgb(179, 179, 179)", "rgb(45, 140, 235)", "rgb(30, 30, 30)"]), JSON.stringify(await t()));
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther"); await p.page.click('#designPick [data-value="glass"]');
  check("DS7 the other designs keep their own colours", (await p.page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(11, 12, 18)" && p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  // «Студия»: same layout, dark with a dot grid, icons in tinted squares.
  p = await open({ width: 380 });
  t = () => p.page.evaluate(() => [document.documentElement.getAttribute("data-design"), getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.querySelector(".glow")).display,
    getComputedStyle(document.body, "::before").backgroundImage.indexOf("radial-gradient") >= 0]);
  await p.page.click("#settingsBtn"); await p.page.click("#setTabOther");
  await p.page.click('#designPick [data-value="studio"]');
  check("DS4 picking «Студия» shows at once: dark, dotted background, no glow", JSON.stringify(await t()) === JSON.stringify(["studio", "rgb(17, 18, 21)", "none", true]), JSON.stringify(await t()));
  check("DS4 the settings window stays on top in «Студия»", await p.page.evaluate(() => { document.querySelector("#saveSettings").scrollIntoView({ block: "center" }); const b = document.querySelector("#saveSettings").getBoundingClientRect(); const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!el && !!el.closest("#saveSettings"); }));
  await p.page.click("#saveSettings");
  await p.restart();
  await p.page.click("#tabMotion");
  t = await p.page.evaluate(() => { const a = document.querySelector('.easecopy-card').getBoundingClientRect(), n = document.querySelector('.easecopy-card').nextElementSibling; const row = [...document.querySelectorAll('.easecopy-card .paste-do')].map((x) => x.getBoundingClientRect()); return [document.documentElement.getAttribute("data-design"), row.every((r) => r.bottom <= a.bottom), getComputedStyle(document.querySelector("#pasteBtn svg")).borderRadius]; });
  check("DS5 «Студия» survives a restart; the Tools tab keeps its blocks, buttons fit their cards, icons sit in rounded squares", t[0] === "studio" && t[1] && t[2] === "8px" && (await p.page.locator('#motionTools .tool-card[data-tool="paste"] #pasteBtn').isVisible()) && (await overflow(p)) <= 0 && p.errors.length === 0, JSON.stringify(t));
  t = await p.page.evaluate(() => { const cs = (sel) => getComputedStyle(document.querySelector(sel)); return [cs("#pasteBtn").borderTopColor, cs("#pasteBtn").backgroundColor, cs("#ecCopy").borderTopColor]; });
  check("DS6 «Студия»: buttons inside a block have no frame of their own; a one-button block has no second background", t.join("|") === "rgba(0, 0, 0, 0)|rgba(0, 0, 0, 0)|rgba(0, 0, 0, 0)", t.join("|"));
  await p.page.screenshot({ path: path.join(SHOTS, "09f-design-studio.png") });
  await p.close();

  await browser.close();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS CRASH:", e); process.exit(2); });
