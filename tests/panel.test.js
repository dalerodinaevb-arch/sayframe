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
function makeAE(opts, tmpDir) {
  const log = { undo: [], removed: [], opened: 0, imports: [], layerAdds: [], precomposes: [], bins: [], ran: [], refComps: [] };
  function File(p) { this.fsName = p; this.name = encodeURI(path.basename(p)); }
  Object.defineProperty(File.prototype, "exists", { get() { return fs.existsSync(this.fsName); } });
  Object.defineProperty(File.prototype, "length", { get() { return fs.existsSync(this.fsName) ? fs.statSync(this.fsName).size : 0; } });
  function CompItem() {} function TextLayer() {} function ShapeLayer() {} function CameraLayer() {} function LightLayer() {} function SolidSource() {}
  function ImportOptions(f) { this.file = f; }
  const rootFolder = { name: "Root" };
  function FolderItem(name) { this.name = name; this.parentFolder = rootFolder; }
  const comp = Object.assign(new CompItem(), { name: "Тест", width: 1920, height: 1080, duration: 10, frameRate: 30, time: 0, numLayers: 2, workAreaStart: 0, workAreaDuration: 5,
    openInViewer() { log.opened++; project.activeItem = comp; },
    layers: { add(item) { log.layerAdds.push(item); return { index: 1, property() { return { property() { return { setValue() {} }; } }; } }; },
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
  const ctx = vm.createContext({ app, File, FolderItem, ImportOptions, CompItem, TextLayer, ShapeLayer, CameraLayer, LightLayer, SolidSource, $: { sleep() {} } });
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
  const savedOrder = (p) => p.page.evaluate(() => localStorage.getItem("sayframe.tabOrder.v1"));
  const center = async (p, sel) => { const b = await p.page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  async function dragTab(p, from, to, opts) {
    const a = await center(p, from), b = typeof to === "string" ? await center(p, to) : to;
    await p.page.mouse.move(a.x, a.y); await p.page.mouse.down();
    await p.page.mouse.move(b.x, b.y, { steps: 12 });
    if (opts && opts.beforeUp) await opts.beforeUp();
    await p.page.mouse.up();
  }
  p = await open({ clip: "png", footage: IMG });
  check("O1 default order", (await order(p)) === "claude,tools" && (await savedOrder(p)) === null);
  await dragTab(p, "#tabClaude", "#tabTools", { beforeUp: async () => {
    check("O2 tab is marked while it is dragged", (await p.page.locator("#tabClaude.dragging").count()) === 1 && (await p.page.locator("#tabs.reordering").count()) === 1);
    await p.page.screenshot({ path: path.join(SHOTS, "19-tab-dragging.png") });
  } });
  check("O2 dragging Claude onto Tools swaps them", (await order(p)) === "tools,claude", await order(p));
  check("O2 the new order is saved", (await savedOrder(p)) === '["tools","claude"]', await savedOrder(p));
  check("O2 dragging does not switch tabs or leave marks", (await vis(p, "#prompt")) && !(await vis(p, "#pasteBtn")) && (await p.page.locator(".dragging, .reordering").count()) === 0);
  t = await p.page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect().left; return r("tabTools") < r("tabClaude"); });
  check("O2 Tools is now drawn on the left", t === true);
  await p.page.screenshot({ path: path.join(SHOTS, "20-tabs-swapped.png") });
  await p.page.waitForTimeout(350);
  await p.tab("tools");
  check("O3 clicking still switches tabs after a drag", (await vis(p, "#pasteBtn")) && !(await vis(p, "#prompt")));
  await p.page.click("#pasteBtn"); await p.idle(); await p.modalClick("Оставить как есть");
  check("O3 tools still work in the new order", /^Картинка вставлена/.test(await p.status()), await p.status());
  await p.restart();
  check("O4 order and open tab survive a restart", (await order(p)) === "tools,claude" && (await vis(p, "#pasteBtn")) && (await p.page.locator("#tabTools").getAttribute("aria-selected")) === "true");
  await dragTab(p, "#tabTools", "#tabClaude");
  check("O5 dragging back restores the order", (await order(p)) === "claude,tools" && (await savedOrder(p)) === '["claude","tools"]');
  await p.page.waitForTimeout(350);
  c = await center(p, "#tabClaude");
  await p.page.mouse.move(c.x, c.y); await p.page.mouse.down(); await p.page.mouse.move(c.x + 3, c.y + 1); await p.page.mouse.up();
  check("O6 a click with a tiny hand movement is still a click", (await order(p)) === "claude,tools" && (await vis(p, "#prompt")));
  c = await center(p, "#tabTools");
  await dragTab(p, "#tabClaude", { x: c.x + 400, y: c.y + 200 });
  check("O7 releasing outside the tabs keeps a valid order", ["claude,tools", "tools,claude"].includes(await order(p)) && (await p.page.locator(".dragging, .reordering").count()) === 0, await order(p));
  await p.page.evaluate(() => localStorage.setItem("sayframe.tabOrder.v1", '["claude","tools"]')); await p.restart();
  await p.page.waitForTimeout(350);
  await p.page.focus("#tabClaude"); await p.page.keyboard.press("Alt+ArrowRight");
  check("O8 Alt+Right moves the focused tab right and keeps focus", (await order(p)) === "tools,claude" && (await p.page.evaluate(() => document.activeElement.id)) === "tabClaude" && (await savedOrder(p)) === '["tools","claude"]');
  await p.page.keyboard.press("Alt+ArrowRight");
  check("O8 at the edge nothing happens", (await order(p)) === "tools,claude");
  await p.page.keyboard.press("ArrowLeft");
  check("O8 plain arrow moves focus, not the tab", (await order(p)) === "tools,claude" && (await p.page.evaluate(() => document.activeElement.id)) === "tabTools");
  await p.page.keyboard.press("Alt+ArrowLeft");
  check("O8 Alt+Left at the left edge does nothing", (await order(p)) === "tools,claude");
  await p.page.focus("#tabClaude"); await p.page.keyboard.press("Alt+ArrowLeft");
  check("O8 Alt+Left moves the tab back", (await order(p)) === "claude,tools");
  check("O8 no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();
  for (const [bad, want] of [['not json', "claude,tools"], ['{"a":1}', "claude,tools"], ['["tools"]', "tools,claude"], ['["ghost","tools","tools","claude",5]', "tools,claude"], ['[]', "claude,tools"]]) {
    p = await open({});
    await p.page.evaluate((v) => localStorage.setItem("sayframe.tabOrder.v1", v), bad); await p.restart();
    check("O9 saved order " + bad + " -> " + want, (await order(p)) === want && p.errors.length === 0 && (await vis(p, "#prompt")), await order(p));
    await p.close();
  }
  p = await open({ width: 300, height: 620 });
  await dragTab(p, "#tabTools", "#tabClaude");
  t = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("O10 reordering works in a 300px panel", (await order(p)) === "tools,claude" && t <= 0);
  check("O10 dragging a tab that is not open does not open it", (await vis(p, "#prompt")) && !(await vis(p, "#pasteBtn")) && (await p.page.locator("#tabClaude").getAttribute("aria-selected")) === "true");
  await p.close();

  // ------------------------------------------------------------------ updates
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
