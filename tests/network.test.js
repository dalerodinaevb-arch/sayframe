// Runs the panel's real Node platform layer (not the mock) against a local HTTPS server.
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), vm = require("vm"), https = require("https");
const { spawnSync } = require("child_process");
// The panel verifies TLS certificates, so the local test server needs one Node trusts:
// make a throw-away certificate and restart this script with it as an extra trusted root.
if (!process.env.SAYFRAME_TEST_CERT_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sayframe-tls-"));
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
  if (made.status !== 0) { console.error("openssl is needed to make the test certificate"); process.exit(2); }
  const child = spawnSync(process.execPath, [__filename], { stdio: "inherit", env: Object.assign({}, process.env,
    { SAYFRAME_TEST_CERT_DIR: dir, NODE_EXTRA_CA_CERTS: path.join(dir, "cert.pem"), NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" }) });
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(child.status === null ? 2 : child.status);
}
const TLS = process.env.SAYFRAME_TEST_CERT_DIR;
const src = fs.readFileSync((process.env.SAYFRAME_EXT || path.join(__dirname, "..", "Sayframe")) + "/js/panel.js", "utf8");
const a = src.indexOf("    function makePlatform() {"), b = src.indexOf("    var platform = window.__SAYFRAME_TEST_PLATFORM__");
const window = { cep_node: { require }, location: { reload() {} } };
const ctx = vm.createContext({ window, URL, Promise, setTimeout, navigator: { platform: "MacIntel" }, Image: function () {}, console });
// The link helpers (types, size limit) live just above the platform layer in the panel.
const la = src.indexOf("    var LINK_MAX_BYTES"), lb = src.indexOf("    var MODELS = [");
vm.runInContext(src.slice(la, lb) + src.slice(a, b) + "\nthis.P = makePlatform();", ctx);
const P = ctx.P;
let pass = 0, fail = 0;
const check = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "  ok   " : "  FAIL ") + n + (c || x === undefined ? "" : "  -> " + x)); };
const BIN = crypto.randomBytes(300000);
const seen = [];
const server = https.createServer({ key: fs.readFileSync(TLS + "/key.pem"), cert: fs.readFileSync(TLS + "/cert.pem") }, (req, res) => {
  seen.push({ url: req.url, ua: req.headers["user-agent"] });
  const u = new URL(req.url, "https://localhost");
  if (u.pathname === "/version.json") { res.writeHead(200, { "content-type": "text/plain" }); res.end(JSON.stringify({ version: "1.2.3", notes: ["Привет"] })); }
  else if (u.pathname === "/file.bin") { res.writeHead(200); res.write(BIN.subarray(0, 1000)); setTimeout(() => res.end(BIN.subarray(1000)), 50); }
  else if (u.pathname === "/page") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<html><head><meta property='og:image' content='/pic'></head>Привет</html>"); }
  else if (u.pathname === "/pic") { res.writeHead(200, { "content-type": "image/png" }); res.end(BIN.subarray(0, 5000)); }
  else if (u.pathname === "/clip.mp4") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(BIN.subarray(0, 7000)); }
  else if (u.pathname === "/doc") { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF"); }
  else if (u.pathname === "/to-pic") { res.writeHead(302, { location: "/pic" }); res.end(); }
  else if (u.pathname === "/private") { res.writeHead(403, { "content-type": "text/html" }); res.end("no"); }
  else if (u.pathname === "/rel") { res.writeHead(302, { location: "/version.json?from=rel" }); res.end(); }
  else if (u.pathname === "/abs") { res.writeHead(301, { location: "https://localhost:" + server.address().port + "/rel" }); res.end(); }
  else if (u.pathname === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
  else if (u.pathname === "/downgrade") { res.writeHead(302, { location: "http://localhost:1/version.json" }); res.end(); }
  else if (u.pathname === "/slow") { setTimeout(() => { res.writeHead(200); res.end("late"); }, 3000); }
  else if (u.pathname === "/huge") { res.writeHead(200); const chunk = Buffer.alloc(1024 * 1024); let n = 0; const t = setInterval(() => { if (n++ > 25 || res.destroyed) { clearInterval(t); res.end(); } else res.write(chunk); }, 1); }
  else { res.writeHead(404); res.end("nope"); }
});
server.listen(0, "127.0.0.1", async () => {
  const B = "https://localhost:" + server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plat-"));
  try {
    let r = await P.getText(B + "/version.json?t=123", 5000);
    check("getText: 200, UTF-8 body, query string kept", r.status === 200 && JSON.parse(r.text).notes[0] === "Привет" && seen[seen.length - 1].url === "/version.json?t=123" && seen[seen.length - 1].ua === "Sayframe", JSON.stringify(r));
    r = await P.getText(B + "/missing", 5000);
    check("getText: 404 is returned, not thrown", r.status === 404);
    const dest = path.join(tmp, "f.bin");
    r = await P.download(B + "/file.bin?v=abc", dest, 5000);
    check("download: file on disk is byte-identical, sha256 is right", r.status === 200 && r.size === BIN.length && fs.readFileSync(dest).equals(BIN) && r.sha256 === crypto.createHash("sha256").update(BIN).digest("hex"));
    r = await P.download(B + "/missing", path.join(tmp, "none"), 5000);
    check("download: missing file writes nothing", r.status === 404 && r.sha256 === "" && !fs.existsSync(path.join(tmp, "none")));
    r = await P.getText(B + "/abs", 5000);
    check("redirects (absolute then relative) are followed", r.status === 200 && JSON.parse(r.text).version === "1.2.3" && seen[seen.length - 1].url === "/version.json?from=rel");
    r = await P.getText(B + "/loop", 5000).then(() => "resolved", (e) => e.message);
    check("redirect loop ends with an error", r === "TOO_MANY_REDIRECTS", r);
    r = await P.getText(B + "/downgrade", 5000).then(() => "resolved", (e) => e.message);
    check("redirect to plain http is refused", r === "BAD_URL", r);
    for (const bad of ["http://localhost:" + server.address().port + "/version.json", "file:///etc/passwd", "not a url", ""]) {
      r = await P.getText(bad, 3000).then(() => "resolved", (e) => e.message);
      check("non-https address refused: " + JSON.stringify(bad), r === "BAD_URL", r);
    }
    r = await P.getText(B + "/slow", 300).then(() => "resolved", (e) => e.message);
    check("slow server -> TIMEOUT", r === "TIMEOUT", r);
    r = await P.download(B + "/huge", path.join(tmp, "huge"), 20000).then(() => "resolved", (e) => e.message);
    check("oversized download is cut off and not written", r === "TOO_BIG" && !fs.existsSync(path.join(tmp, "huge")), r);
    // links used as a reference
    r = await P.fetchUrl(B + "/page", path.join(tmp, "l1"));
    check("fetchUrl: a page comes back as text, nothing is written", r.status === 200 && /Привет/.test(r.text) && /^text\/html/.test(r.contentType) && r.path === undefined && fs.readdirSync(tmp).filter((f) => /^l1/.test(f)).length === 0, JSON.stringify(r).slice(0, 120));
    check("fetchUrl: asks like a normal browser, not as 'Sayframe'", /Mozilla\/5\.0/.test(seen[seen.length - 1].ua), seen[seen.length - 1].ua);
    r = await P.fetchUrl(B + "/to-pic", path.join(tmp, "l2"));
    check("fetchUrl: a picture (after a redirect) is saved with the extension of its type", r.status === 200 && r.path === path.join(tmp, "l2.png") && fs.readFileSync(r.path).equals(BIN.subarray(0, 5000)) && r.finalUrl === B + "/pic", JSON.stringify(r));
    r = await P.fetchUrl(B + "/clip.mp4?x=1", path.join(tmp, "l3"));
    check("fetchUrl: a file the server does not name gets the extension from its address", r.path === path.join(tmp, "l3.mp4") && fs.statSync(r.path).size === 7000, JSON.stringify(r));
    r = await P.fetchUrl(B + "/doc", path.join(tmp, "l4"));
    check("fetchUrl: something that is not a picture, video or page is not saved", r.status === 200 && r.path === undefined && r.text === undefined && !fs.existsSync(path.join(tmp, "l4.pdf")));
    r = await P.fetchUrl(B + "/private", path.join(tmp, "l5"));
    check("fetchUrl: an error status is returned, not thrown, nothing saved", r.status === 403 && r.path === undefined);
    for (const bad of ["file:///etc/passwd", "ftp://x.org/a.png", "not a url"]) {
      r = await P.fetchUrl(bad, path.join(tmp, "l6")).then(() => "resolved", (e) => e.message);
      check("fetchUrl: refused " + JSON.stringify(bad), r === "LINK_BAD", r);
    }
    ctx.LINK_MAX_BYTES = 2 * 1024 * 1024;
    r = await P.fetchUrl(B + "/huge", path.join(tmp, "l7")).then(() => "resolved", (e) => e.message);
    check("fetchUrl: a file over the size limit is cut off", r === "LINK_TOO_BIG", r);
    check("fetchUrl: media types map to the right extensions", ctx.mediaExt("image/jpeg; charset=x", "https://a/b") === ".jpg" && ctx.mediaExt("video/quicktime", "https://a/b") === ".mov" && ctx.mediaExt("", "https://a/b/C.JPEG") === ".jpg" && ctx.mediaExt("text/plain", "https://a/b.png") === "");
    r = await P.getText("https://localhost:1/x", 3000).then(() => "resolved", (e) => e.code || e.message);
    check("unreachable server -> error", r !== "resolved", r);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true }); server.close();
    if (server.closeAllConnections) server.closeAllConnections();
  }
  console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
});
