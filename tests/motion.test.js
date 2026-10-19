// The SF motion library from host.jsx, run in Node against a small fake of the After Effects object model.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EXT = process.env.SAYFRAME_EXT || path.join(__dirname, "..", "Sayframe");
const src = fs.readFileSync(path.join(EXT, "jsx/host.jsx"), "utf8");
let pass = 0, fail = 0;
function check(name, ok, info) { if (ok) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (info !== undefined ? "  -> " + info : "")); } }

const KIT = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
function KeyframeEase(speed, influence) { if (!(influence >= 0.1 && influence <= 100)) throw new Error("bad influence"); this.speed = speed; this.influence = influence; }
function Shape() {}
function CompItem() {}
const clone = (v) => (Array.isArray(v) ? v.slice() : v && typeof v === "object" ? Object.assign(new Shape(), v, { vertices: v.vertices && v.vertices.map((p) => p.slice()) }) : v);
class Prop {
  constructor(v, dims) { this.v = clone(v); this.keys = []; this.dims = dims || 1; this.expression = ""; this.dimensionsSeparated = false; }
  get numKeys() { return this.keys.length; }
  get value() { return this.keys.length ? clone(this.keys[0].v) : clone(this.v); }
  setValue(v) { this.v = clone(v); }
  setValueAtTime(t, v) { const k = this.keys.find((x) => Math.abs(x.t - t) < 1e-9); if (k) k.v = clone(v); else { this.keys.push({ t, v: clone(v) }); this.keys.sort((a, b) => a.t - b.t); } }
  valueAtTime(t) { let k = this.keys[0]; for (const c of this.keys) if (c.t <= t + 1e-9) k = c; return clone(k.v); }
  nearestKeyIndex(t) { let b = 0; this.keys.forEach((k, i) => { if (Math.abs(k.t - t) < Math.abs(this.keys[b].t - t)) b = i; }); return b + 1; }
  setInterpolationTypeAtKey(i, a, b) { this.keys[i - 1].inType = a; this.keys[i - 1].outType = b; }
  setTemporalEaseAtKey(i, a, b) { if (a.length !== this.dims || b.length !== this.dims) throw new Error("wrong number of KeyframeEase"); this.keys[i - 1].inEase = a[0].influence; this.keys[i - 1].outEase = b[0].influence; }
}
// A group whose children are made on demand (addProperty) or given up front.
function group(kids, make) {
  const list = [];
  const g = { kids: kids || {}, list, addProperty(m) { const p = make(m); p.matchName = m; list.push(p); return p; },
    property(m) { return g.kids[m] || list.find((x) => x.matchName === m || x.name === m) || null; } };
  return g;
}
function mkComp() {
  const c = Object.assign(new CompItem(), { width: 1920, height: 1080, frameDuration: 1 / 30, motionBlur: false, layers: [] });
  c.numLayers = 0; c.layer = (i) => c.layers[i - 1];
  return c;
}
function mkLayer(c, o) {
  o = o || {};
  const t = { "ADBE Position": new Prop([960, 540, 0], 1), "ADBE Position_0": new Prop(960), "ADBE Position_1": new Prop(540), "ADBE Scale": new Prop([100, 100, 100], 3), "ADBE Opacity": new Prop(100) };
  if (o.separated) t["ADBE Position"].dimensionsSeparated = true;
  const L = { name: o.name || "L", motionBlur: false, width: 400, height: 200, t,
    sourceRectAtTime: () => ({ left: -100, top: -50, width: 200, height: 100 }) };
  const masks = group({}, () => group({ "ADBE Mask Shape": new Prop(new Shape()), "ADBE Mask Feather": new Prop([0, 0], 2) }));
  const animators = group({}, () => {
    const props = group({}, (m) => new Prop(m === "ADBE Text Opacity" ? 100 : m === "ADBE Text Blur" ? [0, 0] : [0, 0, 0], m === "ADBE Text Opacity" ? 1 : 3));
    const sels = group({}, () => group({ "ADBE Text Percent Start": new Prop(0), "ADBE Text Range Advanced": group({ "ADBE Text Range Type2": new Prop(1), "ADBE Text Range Shape": new Prop(1), "ADBE Text Selector Smoothness": new Prop(100) }) }));
    return group({ "ADBE Text Animator Properties": props, "ADBE Text Selectors": sels });
  });
  const fx = group({}, () => group({ "ADBE Gaussian Blur 2-0001": new Prop(0), "ADBE Gaussian Blur 2-0003": new Prop(0) }));
  const vectors = group({}, () => group({ "ADBE Vector Trim End": new Prop(100) }));
  const g = { "ADBE Transform Group": group(t), "ADBE Mask Parade": masks, "ADBE Effect Parade": fx };
  if (o.text) g["ADBE Text Properties"] = group({ "ADBE Text Animators": animators });
  if (o.shape) g["ADBE Root Vectors Group"] = vectors;
  L.property = (m) => g[m] || null;
  L.g = g;
  c.layers.push(L); c.numLayers = c.layers.length;
  return L;
}
function run(code, comp) {
  const ctx = vm.createContext({ app: { project: { activeItem: comp } }, KeyframeEase, KeyframeInterpolationType: KIT, Shape, CompItem, File: function () {}, Folder: function () {}, $: { sleep() {} } });
  vm.runInContext(src, ctx);
  ctx.c = comp;
  return vm.runInContext(code, ctx);
}
const keysOf = (p) => p.keys.map((k) => k.t.toFixed(2) + "=" + JSON.stringify(k.v)).join(" ");

let c = mkComp(), A = mkLayer(c, { name: "A" });
run("SF.popIn(c.layers[0], 1)", c);
let s = A.t["ADBE Scale"];
check("SF1 popIn: scale 0 -> 100 over the style's 0.7 s, eased out (15/85), with a spring after the last key, and a quick fade-in", keysOf(s) === "1.00=[0,0,100] 1.70=[100,100,100]" && s.keys[0].outEase === 15 && s.keys[1].inEase === 85 && /amp=0.06/.test(s.expression) && keysOf(A.t["ADBE Opacity"]) === "1.00=0 1.28=100", keysOf(s) + " " + JSON.stringify(s.keys) + " " + keysOf(A.t["ADBE Opacity"]));

c = mkComp(); A = mkLayer(c);
run("SF.slideIn(c.layers[0], 0.5, { from: 'left' })", c);
check("SF2 slideIn from the left: from 12% of the comp's width away to where the layer stands; spatial ease (one KeyframeEase) works", keysOf(A.t["ADBE Position"]) === "0.50=[730,540,0] 1.20=[960,540,0]" && A.t["ADBE Position"].keys[1].inEase === 85, keysOf(A.t["ADBE Position"]));
c = mkComp(); A = mkLayer(c, { separated: true });
run("SF.slideIn(c.layers[0], 0, { from: 'bottom', dist: 100 })", c);
check("SF2 with separated dimensions it keys X and Y", keysOf(A.t["ADBE Position_1"]) === "0.00=640 0.70=540" && keysOf(A.t["ADBE Position_0"]) === "0.00=960 0.70=960");
c = mkComp(); A = mkLayer(c);
run("SF.slideOut(c.layers[0], 3, { to: 'right' })", c);
check("SF2 slideOut eases in (soft start, fast exit) and fades out", keysOf(A.t["ADBE Position"]) === "3.00=[960,540,0] 3.70=[1190,540,0]" && A.t["ADBE Position"].keys[0].outEase === 85 && A.t["ADBE Opacity"].keys.length === 2 && A.t["ADBE Opacity"].keys[1].v === 0);

c = mkComp(); A = mkLayer(c);
run("SF.wipe(c.layers[0], 2, { from: 'left', feather: 10 })", c);
let m = A.g["ADBE Mask Parade"].list[0], sh = m.property("ADBE Mask Shape");
check("SF3 wipe: a mask over the layer's rectangle opens from the left edge, feathered", sh.keys.length === 2 && JSON.stringify(sh.keys[0].v.vertices) === "[[-102,-52],[-102,-52],[-102,52],[-102,52]]" && JSON.stringify(sh.keys[1].v.vertices) === "[[-102,-52],[102,-52],[102,52],[-102,52]]" && sh.keys[1].v.closed === true && m.property("ADBE Mask Feather").v.join() === "10,10", JSON.stringify(sh.keys.map((k) => k.v.vertices)));

c = mkComp(); A = mkLayer(c, { text: true });
run("SF.textIn(c.layers[0], 1, { by: 'words', style: 'rise', dur: 1.2 })", c);
let an = A.g["ADBE Text Properties"].property("ADBE Text Animators").list[0], pr = an.property("ADBE Text Animator Properties"), sl = an.property("ADBE Text Selectors").list[0], adv = sl.property("ADBE Text Range Advanced");
check("SF4 textIn by words: a text animator (opacity 0, rise 40 px) revealed word after word by the range Start 0 -> 100", pr.property("ADBE Text Opacity").v === 0 && pr.property("ADBE Text Position 3D").v.join() === "0,40,0" && adv.property("ADBE Text Range Type2").v === 3 && adv.property("ADBE Text Range Shape").v === 1 && adv.property("ADBE Text Selector Smoothness").v === 100 && keysOf(sl.property("ADBE Text Percent Start")) === "1.00=0 2.20=100", keysOf(sl.property("ADBE Text Percent Start")));
c = mkComp(); A = mkLayer(c, { text: true });
run("SF.typeOn(c.layers[0], 0, { dur: 2 })", c);
sl = A.g["ADBE Text Properties"].property("ADBE Text Animators").list[0].property("ADBE Text Selectors").list[0];
check("SF4 typeOn: no smoothness, linear", sl.property("ADBE Text Range Advanced").property("ADBE Text Selector Smoothness").v === 0 && sl.property("ADBE Text Percent Start").keys.every((k) => k.inType === KIT.LINEAR));
c = mkComp(); A = mkLayer(c);
run("SF.textIn(c.layers[0], 0)", c);
check("SF4 textIn on a layer that is not text: falls back to a fade, no error", A.t["ADBE Opacity"].keys.length === 2);

c = mkComp(); A = mkLayer(c, { shape: true });
run("SF.drawOn(c.layers[0], 0)", c);
check("SF5 drawOn: Trim Paths End 0 -> 100", keysOf(A.g["ADBE Root Vectors Group"].list[0].property("ADBE Vector Trim End")) === "0.00=0 0.98=100");
c = mkComp(); A = mkLayer(c);
run("SF.drawOn(c.layers[0], 0)", c);
check("SF5 drawOn on a layer without strokes: a wipe instead", A.g["ADBE Mask Parade"].list.length === 1);
c = mkComp(); A = mkLayer(c);
run("SF.blurIn(c.layers[0], 0, { amount: 50 })", c);
let bl = A.g["ADBE Effect Parade"].list[0];
check("SF5 blurIn: Gaussian Blur 50 -> 0 with repeated edge pixels", keysOf(bl.property("ADBE Gaussian Blur 2-0001")) === "0.00=50 0.70=0" && bl.property("ADBE Gaussian Blur 2-0003").v === 1);

c = mkComp(); const L3 = [mkLayer(c), mkLayer(c), mkLayer(c)];
run("SF.stagger([c.layers[0], c.layers[1], c.layers[2]], 1, null, 'fadeIn'); SF.motionBlur()", c);
check("SF6 stagger: the same recipe on each layer, the style's step (0.06 s) apart; motionBlur switches it on everywhere", L3.map((l) => l.t["ADBE Opacity"].keys[0].t.toFixed(2)).join() === "1.00,1.06,1.12" && c.motionBlur && L3.every((l) => l.motionBlur));

c = mkComp(); A = mkLayer(c);
run("SF.style('energetic'); SF.slideIn(c.layers[0], 0, { from: 'right' })", c);
check("SF7 style 'energetic': faster (0.45 s), farther, with a spring", keysOf(A.t["ADBE Position"]) === "0.00=[1344,540,0] 0.45=[960,540,0]" && /amp=0.08/.test(A.t["ADBE Position"].expression), keysOf(A.t["ADBE Position"]));
c = mkComp(); A = mkLayer(c);
run("SF.style('smooth'); SF.popIn(c.layers[0], 0, { spring: false })", c);
check("SF7 style 'smooth': a gentle scale from 85%, soft 10/90 ease, no spring when asked", keysOf(A.t["ADBE Scale"]) === "0.00=[85,85,100] 0.90=[100,100,100]" && A.t["ADBE Scale"].keys[1].inEase === 90 && A.t["ADBE Scale"].expression === "", keysOf(A.t["ADBE Scale"]));
check("SF7 an unknown style is the normal one", run("SF.style('weird')", mkComp()) === "normal");
c = mkComp(); A = mkLayer(c);
run("SF.keys(c.layers[0].property('ADBE Transform Group').property('ADBE Opacity'), [[0, 0], [1, 100], [2, 50]], 'linear')", c);
check("SF8 SF.keys with 'linear' sets linear keys", A.t["ADBE Opacity"].keys.length === 3 && A.t["ADBE Opacity"].keys.every((k) => k.inType === KIT.LINEAR));
let threw = "";
try { run("SF.popIn({}, 0)", Object.assign(new CompItem(), {})); } catch (e) { threw = String(e); }
check("SF8 no composition / not a layer: a clear error, not a crash of the panel", /property is not a function|SF:/.test(threw) || threw === "", threw);
threw = "";
try { run("SF.fadeIn()", null); } catch (e) { threw = String(e.message || e); }
check("SF8 host.jsx stays pure ASCII with the library", /^[\x09\x0a\x0d\x20-\x7e]*$/.test(src));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
