/*
 * Sayframe — интерфейс и логика панели (выполняется в HTML-движке After Effects).
 * Со стороны After Effects работает jsx/host.jsx; сюда он возвращает только JSON.
 */
(function () {
    "use strict";

    var VERSION = "1.5.1";
    // Адрес файла version.json с описанием последней версии. Пустая строка выключает проверку обновлений.
    var UPDATE_URL = typeof window.__SAYFRAME_TEST_UPDATE_URL__ === "string" ? window.__SAYFRAME_TEST_UPDATE_URL__ : "https://raw.githubusercontent.com/dalerodinaevb-arch/sayframe/main/version.json";
    var UPDATE_STATE_KEY = "sayframe.update.v1";
    var TAB_KEY = "sayframe.tab.v1";
    var TAB_ORDER_KEY = "sayframe.tabOrder.v1";
    var MOTION_KEY = "sayframe.motion.v1";   // положения ползунков и выбор в разделе «Анимация»
    var TAB_DRAG_START_PX = 6;   // сдвиг мыши, после которого нажатие на вкладку считается перетаскиванием
    var UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
    var UPDATE_MAX_FILES = 200;

    var API_URL = "https://api.anthropic.com/v1/messages";
    var API_VERSION = "2023-06-01";
    var MAX_TOKENS = 8192;
    var MAX_HISTORY = 16;
    var MAX_SYNTAX_RETRIES = 2;
    var MAX_CHECK_ROUNDS = 2;
    var FRAME_CHOICES = [6, 8, 12, 16];
    var SETTINGS_KEY = "sayframe.settings.v1";
    var OLD_SETTINGS_KEY = "claudePanel.settings.v2"; // настройки прежней версии панели
    var PASTE_BIN = "Из буфера";

    var MODELS = [
        { id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: "Быстрый и умный" },
        { id: "claude-opus-5-5", name: "Opus 5.5", note: "Для сложных задач" },
        { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", note: "Самый быстрый" }
    ];
    var ACCENTS = ["#9d7bff", "#62c8ff", "#ff7ac3", "#ffb957", "#b8f25a", "#f4f4f8"];
    var BACKGROUNDS = ["#0b0c12", "#101014", "#0d1117", "#140d17", "#0c1311"];

    var DEFAULTS = {
        apiKey: "",
        model: MODELS[0].id,
        accent: ACCENTS[0],
        bg: BACKGROUNDS[0],
        selfCheck: true,
        alwaysAsk: false,
        refFrames: 8,
        panelWidth: 380     // ширина содержимого в пикселях; сама панель After Effects может быть шире
    };
    var PANEL_WIDTH_MIN = 280;
    var PANEL_WIDTH_MAX = 640;

    function clampPanelWidth(v) {
        v = Math.round(Number(v) / 10) * 10;
        if (isNaN(v)) { return DEFAULTS.panelWidth; }
        return v < PANEL_WIDTH_MIN ? PANEL_WIDTH_MIN : v > PANEL_WIDTH_MAX ? PANEL_WIDTH_MAX : v;
    }

    var SYSTEM_PROMPT = [
        "You are an assistant built into a panel inside Adobe After Effects.",
        "The user describes, in plain words, what they want done in After Effects. You make it happen by writing a script that the panel runs immediately.",
        "",
        "Reply format:",
        "- One short sentence, in the user's language, saying what the script will do.",
        "- Then exactly one fenced code block (```javascript) with a complete ExtendScript script.",
        "- If the message is a question, or the task cannot be done by scripting, answer in plain text in the user's language and include no code block.",
        "",
        "Script rules:",
        "- ExtendScript is ES3: use var and function only. No let, const, arrow functions, template strings, JSON, Array.prototype.map/forEach/filter/indexOf, String.prototype.trim, or trailing commas.",
        "- The panel runs the script with eval() inside its own app.beginUndoGroup()/app.endUndoGroup(), so the user can undo everything with one Cmd/Ctrl+Z. Do not call beginUndoGroup or endUndoGroup yourself.",
        "- Work in the active composition (app.project.activeItem) when it is a CompItem. If the task needs a composition and none is active, create one (1920x1080, square pixels, 10 s, 30 fps) and call openInViewer() on it.",
        "- Layer indexes are 1-based. Prefer matchNames for properties and effects, for example 'ADBE Transform Group', 'ADBE Position', 'ADBE Scale', 'ADBE Opacity', 'ADBE Rotate Z', 'ADBE Gaussian Blur 2', 'ADBE Root Vectors Group'.",
        "- For keyframes use setValueAtTime(). For easing use KeyframeEase with setTemporalEaseAtKey(); the ease arrays need 1, 2 or 3 elements depending on the property, so try 1, then 2, then 3 inside try/catch.",
        "- Expressions are fine: property.expression = '...'.",
        "- Do not call alert, confirm or prompt. Do not use File, Folder, Socket, system.callSystem, $.evalFile, the render queue, or save/open/close/new project, and do not delete layers or project items, unless the user explicitly asks for that.",
        "- Write defensive code: check that things exist before using them, and throw new Error('clear message in the user\\'s language') when the request cannot be carried out (for example, no layer is selected).",
        "",
        "References:",
        "- A user message may start with images: either one reference picture, or frames sampled in chronological order from a reference video, with their timestamps listed in the text.",
        "- Study them closely: layout, shapes, colors, typography, and how each element changes from one frame to the next. You cannot see motion between frames, so infer it from those changes and from the user's words, and use the timestamps to set keyframe times.",
        "- Rebuild the look and motion with native After Effects layers (shapes, text, solids, effects, expressions, keyframes). The reference file is not in the project, so never try to import or use it as footage.",
        "- In your one-sentence summary, say plainly what you approximated or left out (for example real 3D, photo-real materials, complex characters).",
        "",
        "Checking your own work:",
        "- After your script runs, the panel may send you frames of the resulting composition so you can check it. End every script with a line like: var SAYFRAME_CHECK_TIMES = [0, 0.4, 1.2, 3]; listing up to 6 times in seconds that best show the result (the start state, key moments of the motion, the final state).",
        "- Give layers clear, unique names so a later fix script can find them.",
        "- When you receive a [Result check] message, follow the instructions in it.",
        "",
        "Every user message contains a snapshot of the current project state. Use it to refer to real layer names and indexes.",
        "If you are told that your previous script failed, return the full corrected script, not a patch."
    ].join("\n");

    // Скрипт для macOS: сохраняет картинку из буфера обмена в PNG.
    // Аргументы: путь для PNG и путь для файла с результатом (OK, FILE:<путь> или NOIMAGE).
    var JXA_CLIPBOARD = [
        'ObjC.import("AppKit");',
        "function run(argv) {",
        "    var out = argv[0];",
        '    var res = "NOIMAGE";',
        "    var pb = $.NSPasteboard.generalPasteboard;",
        '    var d = pb.dataForType("public.png");',
        "    if (d.isNil()) {",
        '        var t = pb.dataForType("public.tiff");',
        "        if (!t.isNil()) {",
        "            var rep = $.NSBitmapImageRep.imageRepWithData(t);",
        "            if (!rep.isNil()) { d = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary); }",
        "        }",
        "    }",
        "    if (!d.isNil()) {",
        '        res = d.writeToFileAtomically(out, true) ? "OK" : "WRITEFAIL";',
        "    } else {",
        '        var u = pb.stringForType("public.file-url");',
        "        if (!u.isNil()) {",
        "            var url = $.NSURL.URLWithString(u);",
        '            if (!url.isNil() && !url.path.isNil()) { res = "FILE:" + url.path.js; }',
        "        }",
        "    }",
        "    if (argv.length > 1) { $(res).writeToFileAtomicallyEncodingError(argv[1], true, $.NSUTF8StringEncoding, null); }",
        "    return res;",
        "}"
    ].join("\n");

    var PS_CLIPBOARD = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
        "$i=[System.Windows.Forms.Clipboard]::GetImage(); " +
        "if($i){$i.Save($args[0],[System.Drawing.Imaging.ImageFormat]::Png); 'OK'} " +
        "else {$f=[System.Windows.Forms.Clipboard]::GetFileDropList(); if($f.Count -gt 0){'FILE:'+$f[0]} else {'NOIMAGE'}}";

    // ------------------------------------------------------------ platform
    // Доступ к файлам, сети и системным командам. В After Effects это Node.js, встроенный в панель.

    function makePlatform() {
        var req = (window.cep_node && window.cep_node.require) ||
            (typeof window.require === "function" ? window.require : null);
        var fs, os, path, https, cp, crypto, Buf;

        function cb(resolve, reject) {
            return function (err, value) { if (err) { reject(err); } else { resolve(value); } };
        }
        function need() { return Promise.reject(new Error("NODE_UNAVAILABLE")); }

        function imageSize(p) {
            return new Promise(function (resolve) {
                var img = new Image();
                var done = false;
                var norm = String(p).replace(/\\/g, "/");
                function finish(v) { if (!done) { done = true; resolve(v); } }
                img.onload = function () { finish({ width: img.naturalWidth, height: img.naturalHeight }); };
                img.onerror = function () { finish(null); };
                setTimeout(function () { finish(null); }, 3000);
                img.src = "file://" + (norm.charAt(0) === "/" ? "" : "/") +
                    encodeURI(norm).replace(/#/g, "%23").replace(/\?/g, "%3F");
            });
        }

        function pickFile(title) {
            var r;
            try {
                if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
                    r = window.cep.fs.showOpenDialogEx(false, false, title, "", []);
                } else if (window.cep && window.cep.fs && window.cep.fs.showOpenDialog) {
                    r = window.cep.fs.showOpenDialog(false, false, title, "", []);
                }
            } catch (e) {
                r = null;
            }
            return Promise.resolve(r && r.data && r.data.length ? String(r.data[0]) : null);
        }

        function openExternal(url) {
            try {
                if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
                    window.cep.util.openURLInDefaultBrowser(url);
                    return true;
                }
            } catch (e) {}
            return false;
        }

        function reload() { window.location.reload(); }

        // GET по https с переходом по перенаправлениям. Возвращает { status, body: Buffer }.
        function httpGet(url, timeoutMs, redirects) {
            return new Promise(function (resolve, reject) {
                var u, rq;
                try { u = new URL(url); } catch (e) { reject(new Error("BAD_URL")); return; }
                if (u.protocol !== "https:") { reject(new Error("BAD_URL")); return; }
                rq = https.get({
                    hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
                    headers: { "user-agent": "Sayframe", "cache-control": "no-cache" }
                }, function (res) {
                    var chunks = [];
                    var size = 0;
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (redirects <= 0) { reject(new Error("TOO_MANY_REDIRECTS")); return; }
                        resolve(httpGet(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1));
                        return;
                    }
                    res.on("data", function (c) {
                        size += c.length;
                        if (size > 20 * 1024 * 1024) { rq.destroy(new Error("TOO_BIG")); return; }
                        chunks.push(c);
                    });
                    res.on("end", function () { resolve({ status: res.statusCode, body: Buf.concat(chunks) }); });
                    res.on("error", reject);
                });
                rq.on("error", reject);
                rq.setTimeout(timeoutMs || 20000, function () { rq.destroy(new Error("TIMEOUT")); });
            });
        }

        if (!req) {
            return {
                available: false,
                tmpdir: function () { return ""; },
                homedir: function () { return ""; },
                isWindows: function () { return /Win/.test(navigator.platform); },
                join: function () { return Array.prototype.join.call(arguments, "/"); },
                dirname: function (p) { return String(p).replace(/[\/\\][^\/\\]*$/, ""); },
                basename: function (p) { return String(p).replace(/^.*[\/\\]/, ""); },
                readBase64: need, readText: need, writeText: need, writeBytes: need,
                remove: function () { return Promise.resolve(); },
                exists: need, mkdirp: need, move: need, exec: need,
                pickFile: pickFile,
                imageSize: imageSize,
                openExternal: openExternal,
                reload: reload,
                getText: function (url) {
                    return fetch(url, { cache: "no-store" }).then(function (res) {
                        return res.text().then(function (text) { return { status: res.status, text: text }; });
                    });
                },
                download: need,
                postJSON: function (url, headers, body) {
                    var h = {};
                    var k;
                    for (k in headers) { if (headers.hasOwnProperty(k)) { h[k] = headers[k]; } }
                    h["anthropic-dangerous-direct-browser-access"] = "true";
                    return fetch(url, { method: "POST", headers: h, body: body }).then(function (res) {
                        return res.text().then(function (text) { return { status: res.status, text: text }; });
                    });
                }
            };
        }

        fs = req("fs"); os = req("os"); path = req("path"); https = req("https"); cp = req("child_process");
        crypto = req("crypto");
        Buf = req("buffer").Buffer;

        return {
            available: true,
            tmpdir: function () { return os.tmpdir(); },
            homedir: function () { return os.homedir(); },
            isWindows: function () { return os.platform() === "win32"; },
            join: function () { return path.join.apply(path, arguments); },
            dirname: function (p) { return path.dirname(p); },
            basename: function (p) { return path.basename(p); },
            readBase64: function (p) {
                return new Promise(function (resolve, reject) { fs.readFile(p, cb(resolve, reject)); })
                    .then(function (b) { return b.toString("base64"); });
            },
            readText: function (p) {
                return new Promise(function (resolve, reject) { fs.readFile(p, "utf8", cb(resolve, reject)); });
            },
            writeText: function (p, text) {
                return new Promise(function (resolve, reject) { fs.writeFile(p, text, "utf8", cb(resolve, reject)); });
            },
            writeBytes: function (p, bytes) {
                return new Promise(function (resolve, reject) { fs.writeFile(p, Buf.from(bytes), cb(resolve, reject)); });
            },
            remove: function (p) {
                return new Promise(function (resolve) { fs.unlink(p, function () { resolve(); }); });
            },
            exists: function (p) {
                return new Promise(function (resolve) { fs.access(p, function (err) { resolve(!err); }); });
            },
            mkdirp: function (p) {
                return new Promise(function (resolve, reject) { fs.mkdir(p, { recursive: true }, cb(resolve, reject)); });
            },
            move: function (a, b) {
                return new Promise(function (resolve, reject) {
                    fs.rename(a, b, function (err) {
                        if (!err) { resolve(); return; }
                        // Разные диски: копируем и удаляем оригинал.
                        fs.copyFile(a, b, function (err2) {
                            if (err2) { reject(err2); return; }
                            fs.unlink(a, function () { resolve(); });
                        });
                    });
                });
            },
            exec: function (file, args, timeoutMs) {
                return new Promise(function (resolve) {
                    cp.execFile(file, args, { timeout: timeoutMs || 15000, maxBuffer: 1024 * 1024 }, function (err, stdout, stderr) {
                        resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || (err ? err.message : "")) });
                    });
                });
            },
            pickFile: pickFile,
            imageSize: imageSize,
            openExternal: openExternal,
            reload: reload,
            getText: function (url, timeoutMs) {
                return httpGet(url, timeoutMs, 3).then(function (r) {
                    return { status: r.status, text: r.body.toString("utf8") };
                });
            },
            // Скачивает файл на диск и возвращает его контрольную сумму.
            download: function (url, dest, timeoutMs) {
                return httpGet(url, timeoutMs, 3).then(function (r) {
                    if (r.status !== 200) { return { status: r.status, sha256: "", size: 0 }; }
                    return new Promise(function (resolve, reject) { fs.writeFile(dest, r.body, cb(resolve, reject)); })
                        .then(function () {
                            return { status: 200, sha256: crypto.createHash("sha256").update(r.body).digest("hex"), size: r.body.length };
                        });
                });
            },
            postJSON: function (url, headers, body, timeoutMs) {
                return new Promise(function (resolve, reject) {
                    var u = new URL(url);
                    var data = Buf.from(body, "utf8");
                    var h = { "content-length": data.length };
                    var k, rq;
                    for (k in headers) { if (headers.hasOwnProperty(k)) { h[k] = headers[k]; } }
                    rq = https.request({ method: "POST", hostname: u.hostname, port: 443, path: u.pathname, headers: h }, function (res) {
                        var chunks = [];
                        res.on("data", function (c) { chunks.push(c); });
                        res.on("end", function () { resolve({ status: res.statusCode, text: Buf.concat(chunks).toString("utf8") }); });
                    });
                    rq.on("error", reject);
                    rq.setTimeout(timeoutMs || 300000, function () { rq.destroy(new Error("TIMEOUT")); });
                    rq.write(data);
                    rq.end();
                });
            }
        };
    }

    var platform = window.__SAYFRAME_TEST_PLATFORM__ || makePlatform();

    // ---------------------------------------------------------------- host

    // JSON только из ASCII: так строку можно без искажений передать в ExtendScript.
    function asciiJSON(v) {
        var s = JSON.stringify(v === undefined ? null : v);
        var out = "";
        var i, c;
        for (i = 0; i < s.length; i++) {
            c = s.charCodeAt(i);
            out += c > 126 ? "\\u" + ("0000" + c.toString(16)).slice(-4) : s.charAt(i);
        }
        return out;
    }

    function evalScript(script) {
        return new Promise(function (resolve, reject) {
            var cep = window.__adobe_cep__;
            if (!cep || typeof cep.evalScript !== "function") { reject(new Error("HOST_UNAVAILABLE")); return; }
            cep.evalScript(script, function (res) { resolve(res); });
        });
    }

    // Папка, в которой установлена панель.
    function extensionDir() {
        var dir = "";
        try {
            dir = window.__adobe_cep__ && window.__adobe_cep__.getSystemPath ? window.__adobe_cep__.getSystemPath("extension") : "";
        } catch (e) {}
        dir = String(dir || "");
        try { dir = decodeURI(dir); } catch (e2) {}
        if (/^file:\/\/\/[A-Za-z]:/.test(dir)) { return dir.replace(/^file:\/\/\//, ""); }
        return dir.replace(/^file:\/\//, "");
    }

    var hostReady = null;

    // host.jsx обычно загружает сам After Effects (ScriptPath в манифесте); если нет — загружаем вручную.
    function ensureHost() {
        if (!hostReady) {
            hostReady = evalScript("typeof sayframeHost").then(function (t) {
                if (t === "object") { return true; }
                return evalScript("$.evalFile(" + asciiJSON(extensionDir() + "/jsx/host.jsx") + "); typeof sayframeHost").then(function (t2) {
                    if (t2 !== "object") { throw new Error("HOST_NOT_LOADED"); }
                    return true;
                });
            });
            hostReady.catch(function () { hostReady = null; });
        }
        return hostReady;
    }

    function host(fn, args) {
        return ensureHost().then(function () {
            var list = [];
            var i;
            for (i = 0; i < args.length; i++) { list.push(asciiJSON(args[i])); }
            return evalScript("sayframeHost." + fn + "(" + list.join(",") + ")");
        }).then(function (res) {
            var data, err;
            if (typeof res !== "string" || res === "" || res.indexOf("EvalScript error") === 0) {
                throw new Error("HOST_ERROR");
            }
            try { data = JSON.parse(res); } catch (e) { throw new Error("HOST_BAD_REPLY"); }
            if (!data.ok) {
                err = new Error(data.error || "HOST_FAILED");
                err.hostLine = data.line;
                throw err;
            }
            return data;
        });
    }

    var FILE_ACCESS_HINT = "Включите в After Effects: Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network.";

    function humanError(e) {
        var m = e && e.message ? e.message : String(e);
        if (m === "HOST_UNAVAILABLE") { return "Панель открыта вне After Effects, связи с программой нет."; }
        if (m === "HOST_NOT_LOADED" || m === "HOST_ERROR" || m === "HOST_BAD_REPLY") {
            return "After Effects не ответил панели. Закройте и снова откройте её в меню Window > Extensions.";
        }
        if (m === "NODE_UNAVAILABLE") { return "Панель не получила доступ к файлам (Node.js выключен)."; }
        if (m === "FRAME_NOT_SAVED") { return "After Effects не сохранил кадр. " + FILE_ACCESS_HINT; }
        if (m === "NO_PICTURE_IN_FILE") { return "В этом файле нет изображения — нужен ролик или картинка."; }
        if (m === "NOT_AN_IMAGE") { return "Скопированный файл не является изображением."; }
        if (m === "TIMEOUT") { return "Claude не ответил вовремя. Попробуйте ещё раз."; }
        if (m === "NO_ACTIVE_COMP") { return "Откройте композицию: инструмент работает с открытой композицией."; }
        if (m === "NO_KEYS_SELECTED") { return "Выделите ключевые кадры на таймлайне и нажмите ещё раз."; }
        if (m === "NO_LAYERS_SELECTED") { return "Выделите слой в композиции и нажмите ещё раз."; }
        if (m === "ALIGN_NEEDS_TWO") { return "Чтобы выровнять слои друг по другу, выделите хотя бы два. Один слой выравнивается по композиции."; }
        return m;
    }

    // ------------------------------------------------------------ settings

    function loadSettings() {
        var s = {};
        var saved, k;
        for (k in DEFAULTS) { if (DEFAULTS.hasOwnProperty(k)) { s[k] = DEFAULTS[k]; } }
        try {
            saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ||
                window.localStorage.getItem(OLD_SETTINGS_KEY) || "{}");
            for (k in DEFAULTS) {
                if (DEFAULTS.hasOwnProperty(k) && saved.hasOwnProperty(k) && typeof saved[k] === typeof DEFAULTS[k]) { s[k] = saved[k]; }
            }
        } catch (e) {}
        s.panelWidth = clampPanelWidth(s.panelWidth);
        return s;
    }

    function storeSettings(s) {
        try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
    }

    function parseHex(hex) {
        var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).replace(/\s/g, ""));
        var n;
        if (!m) { return null; }
        n = parseInt(m[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, hex: "#" + m[1].toLowerCase() };
    }

    function toHex(r, g, b) {
        function h(v) { return ("0" + Math.round(v).toString(16)).slice(-2); }
        return "#" + h(r) + h(g) + h(b);
    }

    function applyTheme(s) {
        var a = parseHex(s.accent) || parseHex(DEFAULTS.accent);
        var bg = parseHex(s.bg) || parseHex(DEFAULTS.bg);
        var lum = (0.299 * a.r + 0.587 * a.g + 0.114 * a.b) / 255;
        var root = document.documentElement.style;
        root.setProperty("--accent", a.hex);
        root.setProperty("--accent-rgb", a.r + ", " + a.g + ", " + a.b);
        root.setProperty("--accent-hi", toHex(a.r + (255 - a.r) * 0.42, a.g + (255 - a.g) * 0.42, a.b + (255 - a.b) * 0.42));
        root.setProperty("--on-accent", lum > 0.5 ? "#0b0c12" : "#ffffff");
        root.setProperty("--bg", bg.hex);
        root.setProperty("--panel-w", clampPanelWidth(s.panelWidth) + "px");
    }

    // ------------------------------------------------------------------ ui

    function el(id) { return document.getElementById(id); }

    var ui = {
        prompt: el("prompt"), runBtn: el("runBtn"), fixBtn: el("fixBtn"), newBtn: el("newBtn"),
        refBtn: el("refBtn"), refChip: el("refChip"), refText: el("refText"), refClear: el("refClear"),
        statusBox: el("statusBox"), status: el("status"),
        replyCard: el("replyCard"), replyText: el("replyText"), replyCode: el("replyCode"), codeBox: el("codeBox"),
        pasteBtn: el("pasteBtn"), settingsBtn: el("settingsBtn"),
        sheet: el("settingsSheet"), settingsClose: el("settingsClose"), apiKey: el("apiKey"), testKey: el("testKey"),
        keyHint: el("keyHint"), models: el("models"), accentSwatches: el("accentSwatches"), accentHex: el("accentHex"),
        bgSwatches: el("bgSwatches"), bgHex: el("bgHex"), selfCheck: el("selfCheck"), alwaysAsk: el("alwaysAsk"),
        panelWidth: el("panelWidth"), panelWidthVal: el("panelWidthVal"),
        frames: el("frames"), saveSettings: el("saveSettings"),
        modal: el("modal"), modalTitle: el("modalTitle"), modalText: el("modalText"), modalCode: el("modalCode"),
        modalButtons: el("modalButtons"),
        updateBar: el("updateBar"), updateTitle: el("updateTitle"), updateNotes: el("updateNotes"),
        updateStatus: el("updateStatus"), updateNow: el("updateNow"), updateLater: el("updateLater"),
        updateDownload: el("updateDownload"),
        versionText: el("versionText"), checkUpdate: el("checkUpdate"), updateHint: el("updateHint"),
        arrangeBar: el("arrangeBar"), arrangeDone: el("arrangeDone"),
        tabs: el("tabs"), tabClaude: el("tabClaude"), tabTools: el("tabTools"), viewClaude: el("viewClaude"), viewTools: el("viewTools"),
        statusSlotClaude: el("statusSlotClaude"), statusSlotTools: el("statusSlotTools"),
        tabMotion: el("tabMotion"), viewMotion: el("viewMotion"), statusSlotMotion: el("statusSlotMotion"),
        easeIn: el("easeIn"), easeOut: el("easeOut"), easeInVal: el("easeInVal"), easeOutVal: el("easeOutVal"),
        easeLink: el("easeLink"), easeBothBtn: el("easeBothBtn"),
        motionTools: el("motionTools"), alignGrid: el("alignGrid"), alignTo: el("alignTo"), easeCurve: el("easeCurve"), easeCurveToggle: el("easeCurveToggle"), easeCurvePath: el("easeCurvePath"), easeHandles: el("easeHandles"),
        anchorGrid: el("anchorGrid"), anchorKeys: el("anchorKeys")
    };

    var settings = loadSettings();
    var draft = null;            // копия настроек, пока открыт экран настроек
    var history = [];
    var lastError = null;
    var pendingRef = null;       // референс, который уйдёт со следующим запросом
    var refSentNote = false;     // показываем «референс отправлен»
    var dialogHasRef = false;
    var checkMsgs = [];
    var busy = false;
    var KEY_HINT = ui.keyHint.textContent;

    // Вкладки: «Claude» (задача, референс, запуск, ответ) и «Инструменты» (всё, что работает без Claude).
    // Строка состояния общая и переезжает в открытую вкладку.
    var TABS = {
        claude: { tab: ui.tabClaude, view: ui.viewClaude, slot: ui.statusSlotClaude },
        tools: { tab: ui.tabTools, view: ui.viewTools, slot: ui.statusSlotTools },
        motion: { tab: ui.tabMotion, view: ui.viewMotion, slot: ui.statusSlotMotion }
    };

    function showTab(name) {
        var k;
        if (!TABS.hasOwnProperty(name)) { name = "claude"; }
        for (k in TABS) {
            if (TABS.hasOwnProperty(k)) {
                TABS[k].view.hidden = k !== name;
                TABS[k].tab.setAttribute("aria-selected", k === name ? "true" : "false");
            }
        }
        TABS[name].slot.appendChild(ui.statusBox);
        try { window.localStorage.setItem(TAB_KEY, name); } catch (e) {}
    }

    function savedTab() {
        var name;
        try { name = window.localStorage.getItem(TAB_KEY); } catch (e) { name = null; }
        return typeof name === "string" && TABS.hasOwnProperty(name) ? name : "claude";
    }

    // ---- порядок вкладок: его можно менять перетаскиванием или Alt + стрелка, он запоминается

    function tabButtons() {
        return Array.prototype.slice.call(ui.tabs.querySelectorAll(".tab"));
    }

    function tabOf(node) {
        while (node && node !== ui.tabs) {
            if (node.className && typeof node.className === "string" && /(^|\s)tab(\s|$)/.test(node.className)) { return node; }
            node = node.parentNode;
        }
        return null;
    }

    function storeTabOrder() {
        var names = [];
        var buttons = tabButtons();
        var i;
        for (i = 0; i < buttons.length; i++) { names.push(buttons[i].getAttribute("data-tab")); }
        try { window.localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(names)); } catch (e) {}
    }

    // Расставляет вкладки в сохранённом порядке. Незнакомые имена пропускает,
    // а вкладки, которых в сохранённом списке нет (появились в новой версии), ставит в конец.
    function applyTabOrder() {
        var buttons = tabButtons();
        var byName = {};
        var placed = {};
        var saved, i, name;
        try { saved = JSON.parse(window.localStorage.getItem(TAB_ORDER_KEY) || "null"); } catch (e) { saved = null; }
        if (Object.prototype.toString.call(saved) !== "[object Array]") { return; }
        for (i = 0; i < buttons.length; i++) { byName[buttons[i].getAttribute("data-tab")] = buttons[i]; }
        for (i = 0; i < saved.length; i++) {
            name = saved[i];
            if (typeof name === "string" && byName.hasOwnProperty(name) && !placed[name]) {
                placed[name] = true;
                ui.tabs.appendChild(byName[name]);
            }
        }
        for (i = 0; i < buttons.length; i++) {
            if (!placed[buttons[i].getAttribute("data-tab")]) { ui.tabs.appendChild(buttons[i]); }
        }
    }

    // Сдвигает вкладку на одно место влево (dir < 0) или вправо (dir > 0).
    function moveTab(btn, dir) {
        var buttons = tabButtons();
        var i = buttons.indexOf(btn);
        var j = i + (dir < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= buttons.length) { return false; }
        if (dir < 0) { ui.tabs.insertBefore(btn, buttons[j]); } else { ui.tabs.insertBefore(buttons[j], btn); }
        storeTabOrder();
        return true;
    }

    // ---- перестановка: вкладки и блоки раздела «Анимация» двигаются только в этом режиме.
    // Он включается двойным щелчком по вкладке или блоку, чтобы ничего не уезжало от случайного движения мыши.
    var arranging = false;

    function setArranging(on) {
        on = !!on;
        if (on === arranging) { return; }
        arranging = on;
        document.body.className = document.body.className.replace(/\s*arranging/g, "") + (on ? " arranging" : "");
        ui.arrangeBar.hidden = !on;
    }

    function enableArranging() {
        ui.arrangeDone.addEventListener("click", function () { setArranging(false); });
        document.addEventListener("keydown", function (e) {
            if (arranging && e.key === "Escape" && ui.sheet.hidden) { e.preventDefault(); setArranging(false); }
        });
    }

    function enableTabReordering() {
        // Перетаскивание сделано на обычных событиях мыши (mousedown, mousemove, mouseup).
        // На событиях указателя (pointer events) оно проходило тесты в браузере, но в самом After Effects
        // не срабатывало. Нажатие гасится (preventDefault), чтобы браузер не начал своё перетаскивание.
        var drag = null;        // { btn, startX, moved }
        var dragEndedAt = 0;

        function finish() {
            if (!drag) { return; }
            if (drag.moved) {
                drag.btn.className = drag.btn.className.replace(/\s*dragging/g, "");
                ui.tabs.className = ui.tabs.className.replace(/\s*reordering/g, "");
                storeTabOrder();
                dragEndedAt = Date.now();
            }
            drag = null;
        }

        ui.tabs.addEventListener("mousedown", function (e) {
            var btn = tabOf(e.target);
            if (!arranging || !btn || e.button !== 0) { return; }
            finish();
            drag = { btn: btn, startX: e.clientX, moved: false };
            // Иначе браузер может начать собственное перетаскивание или выделение, и движения мыши пропадут.
            e.preventDefault();
        });
        ui.tabs.addEventListener("dragstart", function (e) { e.preventDefault(); });

        ui.tabs.addEventListener("dblclick", function (e) {
            if (!tabOf(e.target) || Date.now() - dragEndedAt < 300) { return; }
            setArranging(!arranging);
        });

        document.addEventListener("mousemove", function (e) {
            var buttons, i, other, r, mid, mine;
            if (!drag) { return; }
            if (!drag.moved) {
                if (Math.abs(e.clientX - drag.startX) < TAB_DRAG_START_PX) { return; }
                drag.moved = true;
                drag.btn.className += " dragging";
                ui.tabs.className += " reordering";
            }
            e.preventDefault();
            // Указатель прошёл середину соседней вкладки — перетаскиваемая встаёт за неё.
            // Сравнение с серединой, а не с краем, чтобы вкладки разной ширины не прыгали туда-сюда.
            buttons = tabButtons();
            mine = buttons.indexOf(drag.btn);
            for (i = 0; i < buttons.length; i++) {
                other = buttons[i];
                if (other === drag.btn) { continue; }
                r = other.getBoundingClientRect();
                mid = r.left + r.width / 2;
                if (mine < i && e.clientX >= mid) {
                    ui.tabs.insertBefore(drag.btn, other.nextSibling);
                    mine = i;
                } else if (mine > i && e.clientX <= mid) {
                    ui.tabs.insertBefore(drag.btn, other);
                    break;
                }
            }
        });

        document.addEventListener("mouseup", function () { finish(); }, true);
        window.addEventListener("blur", function () { finish(); });

        ui.tabs.addEventListener("click", function (e) {
            var btn = tabOf(e.target);
            // Отпускание кнопки мыши после перетаскивания не должно переключать вкладку.
            if (!btn || Date.now() - dragEndedAt < 300) { return; }
            showTab(btn.getAttribute("data-tab"));
        });

        ui.tabs.addEventListener("keydown", function (e) {
            var btn = tabOf(e.target);
            var dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
            var buttons, next;
            if (!btn || !dir || e.metaKey || e.ctrlKey || e.shiftKey) { return; }
            e.preventDefault();
            if (e.altKey) {
                // Alt + стрелка двигает саму вкладку.
                if (moveTab(btn, dir)) { btn.focus(); }
                return;
            }
            // Стрелка без Alt переводит фокус на соседнюю вкладку.
            buttons = tabButtons();
            next = buttons[buttons.indexOf(btn) + dir];
            if (next) { next.focus(); }
        });
    }

    function setStatus(text, kind) {
        ui.status.textContent = text;
        ui.statusBox.className = "status" + (kind ? " " + kind : "");
    }

    function setBusy(on) {
        busy = on;
        ui.runBtn.disabled = on;
        ui.newBtn.disabled = on;
        ui.refBtn.disabled = on;
        ui.pasteBtn.disabled = on;
        setMotionDisabled(on);
        ui.settingsBtn.disabled = on;
        ui.refClear.disabled = on;
        ui.fixBtn.disabled = on || lastError === null;
        ui.fixBtn.hidden = lastError === null;
    }

    function showRef() {
        if (pendingRef) {
            ui.refChip.hidden = false;
            ui.refChip.className = "chip";
            ui.refClear.hidden = false;
            ui.refText.textContent = pendingRef.isStill ?
                pendingRef.name + " — картинка" :
                pendingRef.name + " — " + pendingRef.frames.length + " кадр. из " + pendingRef.duration.toFixed(1) + " с";
        } else if (refSentNote) {
            ui.refChip.hidden = false;
            ui.refChip.className = "chip sent";
            ui.refClear.hidden = true;
            ui.refText.textContent = "Референс отправлен, Claude помнит его в этом диалоге";
        } else {
            ui.refChip.hidden = true;
        }
    }

    function showReply(text) {
        var code = extractCode(text);
        // Пояснение к скрипту уже стоит в строке состояния, поэтому в карточке остаётся только сам скрипт.
        ui.replyCard.hidden = false;
        ui.replyText.hidden = code !== null;
        ui.replyText.textContent = code === null ? text.replace(/^\s+|\s+$/g, "") : "";
        ui.codeBox.hidden = code === null;
        ui.replyCode.textContent = code === null ? "" : code;
    }

    // Диалог поверх панели. buttons: [{ label, value, primary }]. Возвращает value нажатой кнопки; Esc — null.
    function modal(opts) {
        return new Promise(function (resolve) {
            var i;
            function close(value) {
                document.removeEventListener("keydown", onKey, true);
                ui.modal.hidden = true;
                resolve(value);
            }
            function onKey(e) {
                if (e.key === "Escape") { e.preventDefault(); close(null); }
            }
            function add(b) {
                var btn = document.createElement("button");
                btn.className = b.primary ? "primary" : "ghost";
                btn.textContent = b.label;
                btn.addEventListener("click", function () { close(b.value); });
                ui.modalButtons.appendChild(btn);
                if (b.primary) { setTimeout(function () { btn.focus(); }, 0); }
            }
            ui.modalTitle.textContent = opts.title;
            ui.modalText.textContent = opts.text || "";
            ui.modalText.style.whiteSpace = "pre-wrap";
            ui.modalCode.hidden = !opts.code;
            ui.modalCode.textContent = opts.code || "";
            ui.modalButtons.innerHTML = "";
            for (i = 0; i < opts.buttons.length; i++) { add(opts.buttons[i]); }
            ui.modal.hidden = false;
            document.addEventListener("keydown", onKey, true);
        });
    }

    // ----------------------------------------------------------- messaging

    function extractCode(text) {
        var m = /```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/.exec(text);
        return m ? m[1] : null;
    }

    function explanationOf(text) {
        var idx = text.indexOf("```");
        return (idx >= 0 ? text.substring(0, idx) : text).replace(/^\s+|\s+$/g, "");
    }

    function needsConfirmation(code) {
        return /system\s*\.\s*callSystem|\bFile\s*\(|\bFolder\s*\(|\bSocket\s*\(|\$\s*\.\s*evalFile|\beval\s*\(|app\s*\.\s*quit|app\s*\.\s*newProject|app\s*\.\s*open\s*\(|project\s*\.\s*close|project\s*\.\s*save|renderQueue\s*\.\s*render|\.importFile\s*\(|\.remove\s*\(\s*\)/.test(code);
    }

    function trimHistory() {
        while (history.length > MAX_HISTORY) { history.shift(); }
        while (history.length > 0 && history[0].role !== "user") { history.shift(); }
    }

    function framesContent(frames, text) {
        var content = [];
        var i;
        for (i = 0; i < frames.length; i++) {
            content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: frames[i].data } });
        }
        content.push({ type: "text", text: text });
        return content;
    }

    function referenceNote(ref) {
        var times = [];
        var i;
        if (ref.isStill) {
            return '[Reference] The image above is a reference picture from the user ("' + ref.name + '", ' +
                ref.width + "x" + ref.height + "). Recreate it as described in the request.";
        }
        for (i = 0; i < ref.frames.length; i++) { times.push(ref.frames[i].time.toFixed(2)); }
        return "[Reference] The " + ref.frames.length + ' images above are frames sampled in chronological order from the user\'s reference video "' +
            ref.name + '" (' + ref.width + "x" + ref.height + ", duration " + ref.duration.toFixed(2) +
            " s). Frame times in seconds: " + times.join(", ") + ".";
    }

    function checkNote(compName, frames, hasReference) {
        var times = [];
        var i;
        for (i = 0; i < frames.length; i++) { times.push(frames[i].time.toFixed(2)); }
        return "[Result check] The " + frames.length + ' images above are frames of the composition "' + compName +
            '" as it looks now, after your script ran, at these times in seconds: ' + times.join(", ") + ".\n" +
            "Compare them with what the user asked for" +
            (hasReference ? " and with the reference images earlier in this conversation" : "") + ".\n" +
            "- If the result is acceptable, reply with one short sentence in the user's language and NO code block. Small imperfections are fine; do not polish endlessly.\n" +
            "- Only if something is clearly wrong (an element is missing, invisible, off-screen, overlapping, unreadable, the wrong color, or moving at the wrong time), reply with one sentence saying what you are fixing, then one code block.\n" +
            "- That script runs on top of the current project: fix the existing layers in place (find them by name or index in the snapshot below). Do not recreate the composition and do not add duplicates of layers that already exist.";
    }

    // Кадры прошлых проверок больше не нужны — оставляем от них только текст.
    function dropOldCheckFrames() {
        var i, m, c;
        for (i = 0; i < checkMsgs.length; i++) {
            m = checkMsgs[i];
            if (m.content instanceof Array) {
                c = m.content[m.content.length - 1];
                m.content = "[Frames of this earlier result check were removed to save space.]\n" + (c && c.text ? c.text : "");
            }
        }
        checkMsgs = [];
    }

    // Читает сохранённые After Effects кадры в base64 и удаляет временные файлы.
    function loadFrames(list) {
        var out = [];
        var chain = Promise.resolve();
        list.forEach(function (f) {
            chain = chain.then(function () {
                return platform.readBase64(f.path).then(function (data) {
                    out.push({ time: f.time, data: data });
                    return platform.remove(f.path);
                });
            });
        });
        return chain.then(function () { return out; }, function (e) {
            list.forEach(function (f) { platform.remove(f.path); });
            throw e;
        });
    }

    function callClaude(messages, maxTokens) {
        var body = JSON.stringify({
            model: settings.model,
            max_tokens: maxTokens || MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: messages
        });
        var headers = {
            "x-api-key": settings.apiKey,
            "anthropic-version": API_VERSION,
            "content-type": "application/json"
        };
        return platform.postJSON(API_URL, headers, body, 300000).then(function (res) {
            var data, i, block;
            var out = { ok: false, text: "", stopReason: "", error: "" };
            try { data = JSON.parse(res.text); } catch (e) {
                out.error = "Не удалось разобрать ответ сервера (код " + res.status + ").";
                return out;
            }
            if (data && data.error) {
                out.error = "Claude API: " + (data.error.message || data.error.type || "ошибка");
                return out;
            }
            if (!data || !(data.content instanceof Array)) {
                out.error = "Неожиданный ответ сервера (код " + res.status + ").";
                return out;
            }
            for (i = 0; i < data.content.length; i++) {
                block = data.content[i];
                if (block && block.type === "text" && block.text) { out.text += block.text; }
            }
            out.stopReason = data.stop_reason || "";
            out.ok = true;
            return out;
        }, function (e) {
            return { ok: false, text: "", stopReason: "", error: "Нет связи с сервером: " + humanError(e) };
        });
    }

    // ---------------------------------------------------------- main flow

    // Отправляет history в Claude и выполняет ответ. label — имя шага для Undo,
    // sentRef — референс, ушедший с этим запросом (возвращаем его, если запрос не прошёл).
    async function askAndRun(label, sentRef, fileAccess) {
        var wantCheck = settings.selfCheck && fileAccess !== false;
        var round = 0;       // сколько проверок результата уже запрошено
        var scriptsRun = 0;  // сколько скриптов выполнено за этот запрос
        var firstExpl = "";
        var attempt, reply, code, expl, syn, reason, ok, res, frames, msg;

        function undoHint() {
            return scriptsRun > 1 ? "\nОтменить: Cmd/Ctrl+Z, каждая правка — отдельный шаг." : "\nОтменить всё: Cmd/Ctrl+Z.";
        }
        function doneText() { return "Готово" + (firstExpl ? ": " + firstExpl : "."); }
        function finish(text, kind) { setBusy(false); setStatus(text, kind); }

        // Запрос не ушёл: убираем последний вопрос из истории и возвращаем референс в панель.
        function giveUp(message) {
            if (history.length > 0 && history[history.length - 1].role === "user") { history.pop(); }
            if (sentRef) { pendingRef = sentRef; sentRef = null; refSentNote = false; showRef(); }
            finish(message, scriptsRun > 0 ? "done" : "error");
        }

        if (!settings.apiKey) {
            giveUp("Нужен ключ Anthropic API. Вставьте его в настройках.");
            openSettings();
            return;
        }

        lastError = null;
        setBusy(true);

        // Один проход цикла = один скрипт: запрос, запуск и, если нужно, кадры для проверки.
        while (true) {
            attempt = 0;
            while (true) {
                if (attempt > 0) {
                    setStatus("В скрипте синтаксическая ошибка, прошу Claude исправить (попытка " + (attempt + 1) + ")…", "busy");
                } else if (round > 0) {
                    setStatus(doneText() + "\nClaude смотрит на кадры результата (проверка " + round + " из " + MAX_CHECK_ROUNDS + ")…", "busy");
                } else {
                    setStatus("Жду ответ Claude…", "busy");
                }

                reply = await callClaude(history);
                if (!reply.ok) {
                    giveUp(scriptsRun > 0 ?
                        doneText() + "\nПроверить результат не удалось: " + reply.error + undoHint() :
                        reply.error);
                    return;
                }
                if (sentRef) { dialogHasRef = true; sentRef = null; }

                history.push({ role: "assistant", content: reply.text });
                trimHistory();
                showReply(reply.text);

                code = extractCode(reply.text);
                expl = explanationOf(reply.text);

                if (code === null) {
                    if (scriptsRun > 0) {
                        finish(doneText() + "\nClaude проверил результат: " + (expl || "замечаний нет.") + undoHint(), "done");
                    } else if (reply.stopReason === "max_tokens") {
                        finish("Ответ оборвался по длине. Попробуйте разбить задачу на части.", "error");
                    } else {
                        finish("Claude ответил текстом, скрипт не запускался.", "");
                    }
                    return;
                }

                try {
                    syn = (await host("syntax", [code])).error;
                } catch (e) {
                    finish(humanError(e), "error");
                    return;
                }
                if (syn) {
                    if (attempt < MAX_SYNTAX_RETRIES) {
                        attempt++;
                        history.push({
                            role: "user",
                            content: "Your script was NOT run because it has a syntax error: " + syn +
                                "\nRemember this is ExtendScript (ES3). Return the full corrected script."
                        });
                        continue;
                    }
                    finish(scriptsRun > 0 ?
                        doneText() + "\nПравка не запущена: в ней синтаксическая ошибка — " + syn + undoHint() :
                        "Скрипт не запущен: синтаксическая ошибка — " + syn, scriptsRun > 0 ? "done" : "error");
                    return;
                }
                break;
            }

            reason = null;
            if (needsConfirmation(code)) {
                reason = "Этот скрипт удаляет что-то или обращается к файлам, сети, рендеру или проекту целиком. Проверьте его перед запуском.";
            } else if (settings.alwaysAsk) {
                reason = expl || "Claude подготовил скрипт.";
            }
            if (reason !== null) {
                ok = await modal({
                    title: "Запустить этот скрипт?",
                    text: reason,
                    code: code,
                    buttons: [{ label: "Не запускать", value: false }, { label: "Запустить", value: true, primary: true }]
                });
                if (!ok) {
                    finish(scriptsRun > 0 ?
                        doneText() + "\nПравка не запущена, результат оставлен как есть." + undoHint() :
                        "Скрипт не запущен.", scriptsRun > 0 ? "done" : "");
                    return;
                }
            }

            setStatus(scriptsRun > 0 ? "Claude нашёл недочёт: " + (expl || "вношу правку") + "…" : "Выполняю скрипт…", "busy");
            try {
                res = await host("run", [code, scriptsRun > 0 ? "правка " + scriptsRun : label,
                    wantCheck && round < MAX_CHECK_ROUNDS, platform.tmpdir()]);
            } catch (e2) {
                finish(humanError(e2), "error");
                return;
            }

            if (res.runError) {
                lastError = res.runError;
                finish("Ошибка при выполнении" + (scriptsRun > 0 ? " правки" : "") + ": " + lastError +
                    "\nЕсли скрипт успел что-то изменить, нажмите Cmd/Ctrl+Z, затем «Исправить ошибку».", "error");
                return;
            }

            scriptsRun++;
            if (scriptsRun === 1) { firstExpl = expl; }

            frames = null;
            if (res.frames && res.frames.length) {
                try { frames = await loadFrames(res.frames); } catch (e3) { frames = null; }
            }
            if (!frames || frames.length === 0) {
                finish(doneText() + (scriptsRun > 1 ? "\nПравок после проверки: " + (scriptsRun - 1) + "." : "") + undoHint(), "done");
                return;
            }

            dropOldCheckFrames();
            try {
                msg = {
                    role: "user",
                    content: framesContent(frames, checkNote(res.compName, frames, dialogHasRef) +
                        "\n\n[Project state]\n" + (await host("info", [])).snapshot)
                };
            } catch (e4) {
                finish(doneText() + undoHint(), "done");
                return;
            }
            history.push(msg);
            checkMsgs.push(msg);
            trimHistory();
            round++;
        }
    }

    async function onRun() {
        var text = ui.prompt.value.replace(/^\s+|\s+$/g, "");
        var info, body, sent;
        if (busy) { return; }
        if (text === "") { setStatus("Напишите, что нужно сделать.", ""); return; }
        try {
            info = await host("info", []);
        } catch (e) {
            setStatus(humanError(e), "error");
            return;
        }
        body = "[Project state]\n" + info.snapshot + "\n\n[Request]\n" + text;
        sent = pendingRef;
        if (sent) {
            history.push({ role: "user", content: framesContent(sent.frames, referenceNote(sent) + "\n\n" + body) });
            pendingRef = null;
            refSentNote = true;
            showRef();
        } else {
            history.push({ role: "user", content: body });
        }
        trimHistory();
        text = text.replace(/\s+/g, " ");
        await askAndRun(text.length > 40 ? text.substring(0, 40) + "…" : text, sent, info.fileAccess);
    }

    async function onFix() {
        var info;
        if (busy || lastError === null) { return; }
        try {
            info = await host("info", []);
        } catch (e) {
            setStatus(humanError(e), "error");
            return;
        }
        history.push({
            role: "user",
            content: "[Project state]\n" + info.snapshot +
                "\n\n[Request]\nYour previous script threw an error while running: " + lastError +
                "\nAssume any partial changes it made have been undone. Return the full corrected script."
        });
        trimHistory();
        await askAndRun("исправление", null, info.fileAccess);
    }

    function onNew() {
        if (busy) { return; }
        history = [];
        checkMsgs = [];
        dialogHasRef = false;
        refSentNote = false;
        lastError = null;
        ui.replyCard.hidden = true;
        ui.fixBtn.disabled = true;
        ui.fixBtn.hidden = true;
        showRef();
        setStatus("Начат новый диалог: Claude больше не помнит предыдущие запросы.", "");
    }

    // ----------------------------------------------------------- reference

    async function onAttachReference() {
        var path, info, res, frames;
        if (busy) { return; }
        path = await platform.pickFile("Выберите видео или картинку-референс");
        if (!path) { return; }
        setBusy(true);
        setStatus("Снимаю кадры с референса…", "busy");
        try {
            info = await host("info", []);
            if (!info.fileAccess) { throw new Error(FILE_ACCESS_HINT); }
            res = await host("reference", [path, settings.refFrames, platform.tmpdir()]);
            frames = await loadFrames(res.ref.frames);
            pendingRef = {
                name: res.ref.name, isStill: res.ref.isStill, duration: res.ref.duration,
                width: res.ref.width, height: res.ref.height, frames: frames
            };
            refSentNote = false;
            setBusy(false);
            setStatus(pendingRef.isStill ?
                "Картинка прикреплена. Напишите, что с ней сделать, и нажмите «Выполнить»." :
                "Видео прикреплено: " + frames.length + " кадров. Claude увидит их по порядку, само движение опишите словами.", "done");
        } catch (e) {
            setBusy(false);
            setStatus("Не удалось подготовить референс: " + humanError(e), "error");
        }
        showRef();
    }

    function onClearReference() {
        if (busy) { return; }
        pendingRef = null;
        refSentNote = false;
        showRef();
        setStatus("Референс убран.", "");
    }

    // ----------------------------------------------------------- clipboard

    function pad2(n) { return n < 10 ? "0" + n : String(n); }

    function dateStamp() {
        var d = new Date();
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "_" +
            pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }

    // Достаёт картинку из системного буфера обмена.
    // { kind: "png", path } — временный PNG; { kind: "file", path } — скопированный файл; { kind: "none" }.
    async function grabClipboard() {
        var stamp = String(new Date().getTime());
        var tmp = platform.tmpdir();
        var png = platform.join(tmp, "sayframe_clip_" + stamp + ".png");
        var resFile = platform.join(tmp, "sayframe_clip_" + stamp + ".txt");
        var jsFile = platform.join(tmp, "sayframe_clip_" + stamp + ".js");
        var r, out;

        if (platform.isWindows()) {
            r = await platform.exec("powershell", ["-NoProfile", "-STA", "-Command",
                "& {" + PS_CLIPBOARD + "} '" + png.replace(/'/g, "''") + "'"], 20000);
            out = r.stdout;
        } else {
            await platform.writeText(jsFile, JXA_CLIPBOARD);
            r = await platform.exec("osascript", ["-l", "JavaScript", jsFile, png, resFile], 20000);
            out = "";
            try { out = await platform.readText(resFile); } catch (e) { out = ""; }
            if (out.replace(/\s/g, "") === "") { out = r.stdout; }
            await platform.remove(jsFile);
            await platform.remove(resFile);
        }
        out = String(out || "").replace(/^\s+|\s+$/g, "");

        if (out === "OK" && await platform.exists(png)) { return { kind: "png", path: png }; }
        if (out.indexOf("FILE:") === 0) { return { kind: "file", path: out.substring(5) }; }
        if (out === "NOIMAGE") { return { kind: "none", path: null }; }
        await platform.remove(png);
        throw new Error("Не удалось прочитать буфер обмена" +
            ((out || r.stderr) ? ": " + String(out || r.stderr).replace(/^\s+|\s+$/g, "").substring(0, 200) : "."));
    }

    // Вставляет картинку. grabbed — уже полученная картинка (Cmd+V в панели) или null (читаем буфер сами).
    async function pasteImage(grabbed) {
        var info, src, dest = null, folder, size, name, choice, res, where, made;
        if (busy) { return; }
        setBusy(true);
        setStatus("Читаю буфер обмена…", "busy");
        try {
            if (!grabbed) { grabbed = await grabClipboard(); }
            if (grabbed.kind === "none") {
                setBusy(false);
                setStatus("В буфере обмена нет картинки. Скопируйте изображение или снимок экрана и попробуйте ещё раз.", "");
                return;
            }
            info = await host("info", []);

            if (grabbed.kind === "png") {
                folder = info.projectPath ?
                    platform.join(platform.dirname(info.projectPath), "Clipboard Images") :
                    platform.join(platform.homedir(), "Documents", "After Effects Clipboard Images");
                await platform.mkdirp(folder);
                dest = platform.join(folder, "clipboard_" + dateStamp() + ".png");
                await platform.move(grabbed.path, dest);
                src = dest;
            } else {
                src = grabbed.path;
                if (!(await platform.exists(src))) { throw new Error("Скопированный файл не найден: " + src); }
            }

            name = platform.basename(src);
            size = await platform.imageSize(src);
            choice = await modal({
                title: "Вставка картинки",
                text: name + (size ? " — " + size.width + " × " + size.height + " пикс." : "") + "\n" +
                    (info.activeComp ?
                        "Как вставить её в композицию «" + info.activeComp + "»?" :
                        "Открытой композиции нет. «Прекомпозить» создаст новую композицию с этой картинкой."),
                buttons: [
                    { label: "Отмена", value: null },
                    { label: "Оставить как есть", value: "plain" },
                    { label: "Прекомпозить", value: "precomp", primary: true }
                ]
            });
            if (choice !== "plain" && choice !== "precomp") {
                if (dest) { await platform.remove(dest); }
                setBusy(false);
                setStatus("Вставка отменена.", "");
                return;
            }

            try {
                res = await host("placeImage", [src, choice, PASTE_BIN]);
            } catch (e) {
                if (dest) { await platform.remove(dest); }
                throw e;
            }

            if (res.placed === "comp-precomp") {
                made = "Картинка вставлена в «" + res.compName + "» прекомпозицией «" + res.preName + "».";
            } else if (res.placed === "comp-plain") {
                made = "Картинка вставлена слоем в «" + res.compName + "».";
            } else if (res.placed === "new-comp") {
                made = "Открытой композиции не было, поэтому создана новая «" + res.preName + "» с картинкой внутри.";
            } else {
                made = "Картинка добавлена в проект, в папку «" + PASTE_BIN + "». Откройте композицию, чтобы вставить её слоем.";
            }
            where = dest ? "\nФайл сохранён: " + dest : "";
            setBusy(false);
            setStatus(made + where + "\nОтменить: Cmd/Ctrl+Z.", "done");
        } catch (e2) {
            if (grabbed && grabbed.kind === "png" && grabbed.path) { await platform.remove(grabbed.path); }
            setBusy(false);
            setStatus("Не удалось вставить картинку: " + humanError(e2), "error");
        }
    }

    // Cmd/Ctrl+V в панели: если в буфере картинка, перехватываем её прямо из события вставки.
    function onPasteEvent(e) {
        var items = e.clipboardData ? e.clipboardData.items : null;
        var file = null;
        var inField = e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT");
        var i;
        if (!ui.sheet.hidden || !ui.modal.hidden) { return; }
        if (items) {
            for (i = 0; i < items.length; i++) {
                if (items[i].kind === "file" && /^image\//.test(items[i].type)) { file = items[i].getAsFile(); break; }
            }
        }
        if (file) {
            e.preventDefault();
            if (busy) { return; }
            blobToPng(file).then(function (bytes) {
                var png = platform.join(platform.tmpdir(), "sayframe_clip_" + new Date().getTime() + ".png");
                return platform.writeBytes(png, bytes).then(function () {
                    return pasteImage({ kind: "png", path: png });
                });
            }).catch(function () {
                // Не получилось взять картинку из события — читаем системный буфер обычным путём.
                pasteImage(null);
            });
        } else if (!inField) {
            e.preventDefault();
            pasteImage(null);
        }
    }

    // Любой формат из буфера (JPEG, WebP, GIF) приводим к PNG, который After Effects точно откроет.
    function blobToPng(blob) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(blob);
            var img = new Image();
            img.onload = function () {
                var canvas = document.createElement("canvas");
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext("2d").drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
                canvas.toBlob(function (out) {
                    var reader;
                    if (!out) { reject(new Error("PNG")); return; }
                    reader = new FileReader();
                    reader.onload = function () { resolve(new Uint8Array(reader.result)); };
                    reader.onerror = function () { reject(new Error("PNG")); };
                    reader.readAsArrayBuffer(out);
                }, "image/png");
            };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("PNG")); };
            img.src = url;
        });
    }

    // ------------------------------------------------------ settings sheet

    function pressGroup(container, value) {
        var buttons = container.querySelectorAll("button");
        var i;
        for (i = 0; i < buttons.length; i++) {
            buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-value") === String(value)));
        }
    }

    function buildSettings() {
        MODELS.forEach(function (m) {
            var b = document.createElement("button");
            var name = document.createElement("b");
            var note = document.createElement("small");
            b.className = "model";
            b.setAttribute("data-value", m.id);
            name.textContent = m.name;
            note.textContent = m.note;
            b.appendChild(name);
            b.appendChild(note);
            b.addEventListener("click", function () { draft.model = m.id; pressGroup(ui.models, m.id); });
            ui.models.appendChild(b);
        });

        function swatches(container, input, colors, key) {
            colors.forEach(function (c) {
                var b = document.createElement("button");
                b.className = "swatch";
                b.style.background = c;
                b.setAttribute("data-value", c);
                b.setAttribute("aria-label", c);
                b.title = c;
                b.addEventListener("click", function () {
                    draft[key] = c;
                    input.value = c;
                    pressGroup(container, c);
                    applyTheme(draft);
                });
                container.insertBefore(b, input);
            });
            input.addEventListener("input", function () {
                var p = parseHex(input.value);
                if (p) {
                    draft[key] = p.hex;
                    pressGroup(container, p.hex);
                    applyTheme(draft);
                }
            });
        }
        swatches(ui.accentSwatches, ui.accentHex, ACCENTS, "accent");
        swatches(ui.bgSwatches, ui.bgHex, BACKGROUNDS, "bg");

        // Ширина меняется сразу, пока тянут ползунок; без «Сохранить» вернётся прежняя.
        ui.panelWidth.addEventListener("input", function () {
            if (!draft) { return; }
            draft.panelWidth = clampPanelWidth(ui.panelWidth.value);
            ui.panelWidthVal.textContent = draft.panelWidth + " px";
            applyTheme(draft);
        });

        FRAME_CHOICES.forEach(function (n) {
            var b = document.createElement("button");
            b.textContent = String(n);
            b.setAttribute("data-value", String(n));
            b.addEventListener("click", function () { draft.refFrames = n; pressGroup(ui.frames, n); });
            ui.frames.appendChild(b);
        });
    }

    function openSettings() {
        var k;
        if (busy) { return; }
        draft = {};
        for (k in settings) { if (settings.hasOwnProperty(k)) { draft[k] = settings[k]; } }
        ui.apiKey.value = draft.apiKey;
        ui.accentHex.value = draft.accent;
        ui.bgHex.value = draft.bg;
        ui.selfCheck.checked = draft.selfCheck;
        ui.alwaysAsk.checked = draft.alwaysAsk;
        ui.panelWidth.value = String(draft.panelWidth);
        ui.panelWidthVal.textContent = draft.panelWidth + " px";
        ui.keyHint.textContent = KEY_HINT;
        ui.keyHint.className = "hint";
        pressGroup(ui.models, draft.model);
        pressGroup(ui.accentSwatches, draft.accent);
        pressGroup(ui.bgSwatches, draft.bg);
        pressGroup(ui.frames, draft.refFrames);
        ui.sheet.hidden = false;
        ui.sheet.scrollTop = 0;
    }

    function closeSettings(save) {
        if (save) {
            draft.apiKey = ui.apiKey.value.replace(/\s/g, "");
            draft.selfCheck = ui.selfCheck.checked;
            draft.alwaysAsk = ui.alwaysAsk.checked;
            settings = draft;
            storeSettings(settings);
            setStatus(settings.apiKey ? "Настройки сохранены." : "Ключ API не задан.", settings.apiKey ? "done" : "");
        }
        draft = null;
        applyTheme(settings);
        ui.sheet.hidden = true;
    }

    // Проверяет ключ самым коротким запросом из возможных.
    function onTestKey() {
        var saved = { apiKey: settings.apiKey, model: settings.model };
        var key = ui.apiKey.value.replace(/\s/g, "");
        if (!key) {
            ui.keyHint.textContent = "Сначала вставьте ключ.";
            ui.keyHint.className = "hint bad";
            return;
        }
        ui.testKey.disabled = true;
        ui.keyHint.textContent = "Проверяю…";
        ui.keyHint.className = "hint";
        settings.apiKey = key;
        settings.model = draft.model;
        callClaude([{ role: "user", content: "ping" }], 1).then(function (r) {
            settings.apiKey = saved.apiKey;
            settings.model = saved.model;
            ui.testKey.disabled = false;
            ui.keyHint.textContent = r.ok ? "Ключ работает." : r.error;
            ui.keyHint.className = "hint " + (r.ok ? "ok" : "bad");
        });
    }

    // ------------------------------------------------------------ анимация
    // Плавность ключей. Ползунки расходятся от кнопки, как ручки ключа в редакторе графиков:
    // левый — входящая сторона ключа (in, как движение останавливается перед ключом),
    // правый — исходящая (out, как оно начинается после ключа). Длина ползунка — влияние в процентах.

    var MOTION_DEFAULTS = { easeIn: 60, easeOut: 60, link: true, curve: true, anchorKeys: "key", alignTo: "comp", order: "ease,anchor,align" };
    var TOOL_NAMES = ["ease", "anchor", "align"];

    // Порядок блоков строкой через запятую. Незнакомые и повторные имена выбрасываются,
    // блоки, которых в сохранённом порядке нет (появились в новой версии), встают в конец.
    function cleanToolOrder(text) {
        var want = String(text).split(",");
        var out = [];
        var i;
        for (i = 0; i < want.length; i++) {
            if (TOOL_NAMES.indexOf(want[i]) >= 0 && out.indexOf(want[i]) < 0) { out.push(want[i]); }
        }
        for (i = 0; i < TOOL_NAMES.length; i++) {
            if (out.indexOf(TOOL_NAMES[i]) < 0) { out.push(TOOL_NAMES[i]); }
        }
        return out.join(",");
    }
    var TOOL_DRAG_START_PX = 6;  // сдвиг мыши, после которого нажатие на блок считается перетаскиванием

    function loadMotion() {
        var m = {};
        var saved, k;
        for (k in MOTION_DEFAULTS) { if (MOTION_DEFAULTS.hasOwnProperty(k)) { m[k] = MOTION_DEFAULTS[k]; } }
        try { saved = JSON.parse(window.localStorage.getItem(MOTION_KEY) || "{}"); } catch (e) { saved = null; }
        if (saved && typeof saved === "object") {
            for (k in MOTION_DEFAULTS) {
                if (MOTION_DEFAULTS.hasOwnProperty(k) && typeof saved[k] === typeof MOTION_DEFAULTS[k]) { m[k] = saved[k]; }
            }
        }
        m.easeIn = clampPercent(m.easeIn);
        m.easeOut = clampPercent(m.easeOut);
        if (m.anchorKeys !== "shift" && m.anchorKeys !== "skip") { m.anchorKeys = "key"; }
        if (m.alignTo !== "selection") { m.alignTo = "comp"; }
        m.order = cleanToolOrder(m.order);
        return m;
    }

    function clampPercent(v) {
        v = Math.round(Number(v));
        if (isNaN(v)) { return 60; }
        return v < 0 ? 0 : v > 100 ? 100 : v;
    }

    var motion = loadMotion();

    function storeMotion() {
        try { window.localStorage.setItem(MOTION_KEY, JSON.stringify(motion)); } catch (e) {}
    }

    function plural(n, one, few, many) {
        var a = Math.abs(n) % 100;
        var b = a % 10;
        if (a > 10 && a < 20) { return n + " " + many; }
        if (b === 1) { return n + " " + one; }
        if (b >= 2 && b <= 4) { return n + " " + few; }
        return n + " " + many;
    }

    // Минус в углу прячет кривую и становится плюсом; плюс возвращает её.
    // У SVG нет свойства hidden, поэтому меняем сам атрибут.
    function showEaseCurve() {
        var label = motion.curve ? "Скрыть кривую" : "Показать кривую";
        if (motion.curve) { ui.easeCurve.removeAttribute("hidden"); } else { ui.easeCurve.setAttribute("hidden", ""); }
        ui.easeCurveToggle.setAttribute("aria-expanded", motion.curve ? "true" : "false");
        ui.easeCurveToggle.setAttribute("aria-label", label);
        ui.easeCurveToggle.title = label;
    }

    function onEaseCurveToggle() {
        motion.curve = !motion.curve;
        showEaseCurve();
        storeMotion();
    }

    // Обновляет ползунки, числа и кривую. Кривая — значение между двумя выделенными ключами:
    // слева уход от первого ключа (out), справа приход ко второму (in).
    function drawEase() {
        var x0 = 12, y0 = 72, x1 = 188, y1 = 12, w = x1 - x0;
        var c1 = x0 + w * motion.easeOut / 100;
        var c2 = x1 - w * motion.easeIn / 100;
        ui.easeOut.value = String(motion.easeOut);
        ui.easeIn.value = String(motion.easeIn);
        ui.easeOut.style.setProperty("--v", String(motion.easeOut / 100));
        ui.easeIn.style.setProperty("--v", String(motion.easeIn / 100));
        ui.easeOutVal.value = String(motion.easeOut);
        ui.easeInVal.value = String(motion.easeIn);
        ui.easeLink.checked = motion.link;
        ui.easeCurvePath.setAttribute("d", "M" + x0 + " " + y0 + " C" + c1.toFixed(1) + " " + y0 + " " + c2.toFixed(1) + " " + y1 + " " + x1 + " " + y1);
        ui.easeHandles.setAttribute("d", "M" + x0 + " " + y0 + "H" + c1.toFixed(1) + "M" + x1 + " " + y1 + "H" + c2.toFixed(1));
    }

    function setEase(which, v) {
        if (which === "in") { motion.easeIn = v; } else { motion.easeOut = v; }
        if (motion.link) { motion.easeIn = v; motion.easeOut = v; }
        drawEase();
        storeMotion();
    }

    function onEaseSlider(which) {
        setEase(which, clampPercent(which === "in" ? ui.easeIn.value : ui.easeOut.value));
    }

    // Число рядом с ползунком можно набрать руками; мусор возвращает прежнее значение.
    function onEaseNumber(which) {
        var text = String(which === "in" ? ui.easeInVal.value : ui.easeOutVal.value).replace(/[\s%]/g, "");
        if (!/^\d{1,3}$/.test(text)) { drawEase(); return; }
        setEase(which, clampPercent(text));
    }

    function onEaseLink() {
        motion.link = ui.easeLink.checked;
        if (motion.link) { motion.easeIn = motion.easeOut; }
        drawEase();
        storeMotion();
    }

    function setMotionDisabled(on) {
        var cells = ui.anchorGrid.querySelectorAll("button");
        var i;
        ui.easeIn.disabled = on;
        ui.easeOut.disabled = on;
        ui.easeInVal.disabled = on;
        ui.easeOutVal.disabled = on;
        ui.easeLink.disabled = on;
        ui.easeBothBtn.disabled = on;
        ui.anchorKeys.disabled = on;
        for (i = 0; i < cells.length; i++) { cells[i].disabled = on; }
        cells = ui.alignGrid.querySelectorAll("button");
        ui.alignTo.disabled = on;
        for (i = 0; i < cells.length; i++) { cells[i].disabled = on; }
    }

    // Замечания вроде «ничего не выделено» — подсказка, а не ошибка.
    function toolFailed(e) {
        var m = e && e.message ? e.message : String(e);
        var hint = m === "NO_ACTIVE_COMP" || m === "NO_KEYS_SELECTED" || m === "NO_LAYERS_SELECTED" || m === "ALIGN_NEEDS_TWO";
        setBusy(false);
        setStatus(humanError(e), hint ? "" : "error");
    }

    // mode: "both"; хост умеет ещё "in" и "out" (только одна сторона ключа), кнопок для них в панели нет.
    function onEase(mode) {
        if (busy) { return; }
        setBusy(true);
        setStatus("Применяю плавность…", "busy");
        host("ease", [motion.easeIn, motion.easeOut, mode]).then(function (res) {
            var text;
            setBusy(false);
            if (!res.keys) {
                setStatus("Не удалось изменить выделенные ключи: After Effects не дал задать для них плавность.", "error");
                return;
            }
            text = "Плавность применена: " + plural(res.keys, "ключ", "ключа", "ключей") + ".";
            if (res.failed) { text += " Не получилось для " + plural(res.failed, "ключа", "ключей", "ключей") + "."; }
            setStatus(text + "\nОтменить: Cmd/Ctrl+Z.", "done");
        }).catch(toolFailed);
    }

    function onAnchor(fx, fy) {
        if (busy) { return; }
        setBusy(true);
        setStatus("Переношу точку привязки…", "busy");
        host("anchor", [fx, fy, motion.anchorKeys]).then(function (res) {
            var parts = [];
            setBusy(false);
            if (res.moved) { parts.push("Точка привязки перенесена: " + plural(res.moved, "слой", "слоя", "слоёв") + "."); }
            if (res.unchanged) { parts.push("Уже на месте: " + plural(res.unchanged, "слой", "слоя", "слоёв") + "."); }
            if (res.skipped) { parts.push("Пропущено: " + plural(res.skipped, "слой", "слоя", "слоёв") + " (камера, свет или слой с ключами)."); }
            if (res.failed) { parts.push("Не получилось: " + plural(res.failed, "слой", "слоя", "слоёв") + " (слой заблокирован?)."); }
            if (!parts.length) { parts.push("Нечего переносить."); }
            setStatus(parts.join(" ") + (res.moved ? "\nОтменить: Cmd/Ctrl+Z." : ""), res.moved ? "done" : res.failed ? "error" : "");
        }).catch(toolFailed);
    }

    function onAlign(edge) {
        if (busy) { return; }
        setBusy(true);
        setStatus("Выравниваю…", "busy");
        host("align", [edge, motion.alignTo]).then(function (res) {
            var parts = [];
            setBusy(false);
            if (res.moved) { parts.push("Выровнено: " + plural(res.moved, "слой", "слоя", "слоёв") + "."); }
            if (res.unchanged) { parts.push("Уже на месте: " + plural(res.unchanged, "слой", "слоя", "слоёв") + "."); }
            if (res.skipped) { parts.push("Пропущено: " + plural(res.skipped, "слой", "слоя", "слоёв") + " (3D-слой, камера или свет)."); }
            if (res.failed) { parts.push("Не получилось: " + plural(res.failed, "слой", "слоя", "слоёв") + " (слой заблокирован?)."); }
            if (!parts.length) { parts.push("Нечего выравнивать."); }
            setStatus(parts.join(" ") + (res.moved ? "\nОтменить: Cmd/Ctrl+Z." : ""), res.moved ? "done" : res.failed ? "error" : "");
        }).catch(toolFailed);
    }

    // ---- порядок блоков раздела: их можно менять местами, как вкладки

    function toolCards() {
        return Array.prototype.slice.call(ui.motionTools.querySelectorAll(".tool-card"));
    }

    function toolOf(node) {
        while (node && node !== ui.motionTools) {
            if (node.getAttribute && node.getAttribute("data-tool")) { return node; }
            node = node.parentNode;
        }
        return null;
    }

    // Ползунок, число, кнопка или список: двойной щелчок по ним — работа с ними, а не просьба о перестановке.
    function isToolControl(node, card) {
        while (node && node !== card) {
            if (/^(INPUT|BUTTON|SELECT|TEXTAREA|LABEL|A|OPTION)$/.test(node.nodeName)) { return true; }
            node = node.parentNode;
        }
        return false;
    }

    function applyToolOrder() {
        var names = motion.order.split(",");
        var cards = toolCards();
        var i, j;
        for (i = 0; i < names.length; i++) {
            for (j = 0; j < cards.length; j++) {
                if (cards[j].getAttribute("data-tool") === names[i]) { ui.motionTools.appendChild(cards[j]); }
            }
        }
    }

    function storeToolOrder() {
        var names = [];
        var cards = toolCards();
        var i;
        for (i = 0; i < cards.length; i++) { names.push(cards[i].getAttribute("data-tool")); }
        motion.order = cleanToolOrder(names.join(","));
        storeMotion();
    }

    // Сдвигает блок на одно место влево (-1) или вправо (+1). Возвращает true, если он сдвинулся.
    function moveTool(card, dir) {
        var cards = toolCards();
        var to = cards.indexOf(card) + dir;
        if (to < 0 || to >= cards.length) { return false; }
        if (dir < 0) { ui.motionTools.insertBefore(card, cards[to]); } else { ui.motionTools.insertBefore(card, cards[to].nextSibling); }
        storeToolOrder();
        return true;
    }

    function enableToolReordering() {
        // Как и у вкладок — на обычных событиях мыши.
        var drag = null;        // { card, x, y, moved }
        var dragEndedAt = 0;

        function finish() {
            if (!drag) { return; }
            if (drag.moved) {
                drag.card.className = drag.card.className.replace(/\s*dragging/g, "");
                ui.motionTools.className = ui.motionTools.className.replace(/\s*reordering/g, "");
                storeToolOrder();
                dragEndedAt = Date.now();
            }
            drag = null;
        }

        ui.motionTools.addEventListener("mousedown", function (e) {
            var card = toolOf(e.target);
            if (!arranging || !card || e.button !== 0) { return; }
            finish();
            drag = { card: card, x: e.clientX, y: e.clientY, moved: false };
            e.preventDefault();
        });
        ui.motionTools.addEventListener("dragstart", function (e) { e.preventDefault(); });

        // Двойной щелчок по свободному месту блока включает перестановку; по ползунку, числу или кнопке — нет.
        ui.motionTools.addEventListener("dblclick", function (e) {
            var card = toolOf(e.target);
            if (!card || Date.now() - dragEndedAt < 300) { return; }
            if (!arranging && isToolControl(e.target, card)) { return; }
            setArranging(!arranging);
        });

        document.addEventListener("mousemove", function (e) {
            var cards, i, other, r, mine, me, sameRow, pos, mid;
            if (!drag) { return; }
            if (!drag.moved) {
                if (Math.abs(e.clientX - drag.x) < TOOL_DRAG_START_PX && Math.abs(e.clientY - drag.y) < TOOL_DRAG_START_PX) { return; }
                drag.moved = true;
                drag.card.className += " dragging";
                ui.motionTools.className += " reordering";
            }
            e.preventDefault();
            // Указатель прошёл середину соседнего блока — перетаскиваемый встаёт на его место.
            // Блоки в одном ряду сравниваются по горизонтали, стоящие друг под другом — по вертикали.
            cards = toolCards();
            mine = cards.indexOf(drag.card);
            me = drag.card.getBoundingClientRect();
            for (i = 0; i < cards.length; i++) {
                other = cards[i];
                if (other === drag.card) { continue; }
                r = other.getBoundingClientRect();
                sameRow = r.top < me.bottom && r.bottom > me.top && (r.left >= me.right - 1 || r.right <= me.left + 1);
                pos = sameRow ? e.clientX : e.clientY;
                mid = sameRow ? r.left + r.width / 2 : r.top + r.height / 2;
                if (mine < i && pos >= mid) {
                    ui.motionTools.insertBefore(drag.card, other.nextSibling);
                    break;
                } else if (mine > i && pos <= mid) {
                    ui.motionTools.insertBefore(drag.card, other);
                    break;
                }
            }
        });

        document.addEventListener("mouseup", function () { finish(); }, true);
        window.addEventListener("blur", function () { finish(); });

        // С клавиатуры: фокус на полоске, стрелки двигают блок.
        ui.motionTools.addEventListener("keydown", function (e) {
            var grip = e.target;
            var dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
            var card;
            if (!dir || !grip.className || !/(^|\s)tool-grip(\s|$)/.test(String(grip.className)) || e.metaKey || e.ctrlKey || e.shiftKey) { return; }
            card = toolOf(grip);
            if (!card) { return; }
            e.preventDefault();
            if (moveTool(card, dir)) { grip.focus(); }
        });
    }

    function enableMotion() {
        applyToolOrder();
        enableToolReordering();
        ui.anchorKeys.value = motion.anchorKeys;
        showEaseCurve();
        drawEase();
        ui.easeIn.addEventListener("input", function () { onEaseSlider("in"); });
        ui.easeOut.addEventListener("input", function () { onEaseSlider("out"); });
        ui.easeInVal.addEventListener("change", function () { onEaseNumber("in"); });
        ui.easeOutVal.addEventListener("change", function () { onEaseNumber("out"); });
        [ui.easeInVal, ui.easeOutVal].forEach(function (box) {
            box.addEventListener("focus", function () { box.select(); });
            box.addEventListener("keydown", function (e) {
                if (e.key === "Enter") { box.blur(); }
                if (e.key === "Escape") { drawEase(); box.blur(); }
            });
        });
        ui.easeLink.addEventListener("change", onEaseLink);
        ui.easeCurveToggle.addEventListener("click", onEaseCurveToggle);
        ui.easeBothBtn.addEventListener("click", function () { onEase("both"); });
        ui.anchorKeys.addEventListener("change", function () {
            var v = ui.anchorKeys.value;
            motion.anchorKeys = v === "shift" || v === "skip" ? v : "key";
            storeMotion();
        });
        ui.alignTo.value = motion.alignTo;
        ui.alignTo.addEventListener("change", function () {
            motion.alignTo = ui.alignTo.value === "selection" ? "selection" : "comp";
            storeMotion();
        });
        ui.alignGrid.addEventListener("click", function (e) {
            var node = e.target;
            while (node && node !== ui.alignGrid && !(node.getAttribute && node.getAttribute("data-edge"))) { node = node.parentNode; }
            if (!node || node === ui.alignGrid || node.disabled) { return; }
            onAlign(node.getAttribute("data-edge"));
        });
        ui.anchorGrid.addEventListener("click", function (e) {
            var node = e.target;
            while (node && node !== ui.anchorGrid && !(node.getAttribute && node.getAttribute("data-fx") !== null)) { node = node.parentNode; }
            if (!node || node === ui.anchorGrid || node.disabled) { return; }
            onAnchor(Number(node.getAttribute("data-fx")), Number(node.getAttribute("data-fy")));
        });
    }

    // -------------------------------------------------------------- update
    // Панель читает version.json по адресу UPDATE_URL. Если там версия новее, показывает плашку
    // и по кнопке скачивает файлы панели, сверяет контрольные суммы и заменяет ими свои.

    var updateOffer = null;       // { info, url } — найденная новая версия
    var updateDismissed = false;  // плашку закрыли до следующего запуска
    var updating = false;

    function parseVersion(v) {
        var m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(v));
        return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
    }

    function isNewer(a, b) {
        var x = parseVersion(a);
        var y = parseVersion(b);
        var i;
        if (!x || !y) { return false; }
        for (i = 0; i < 3; i++) { if (x[i] !== y[i]) { return x[i] > y[i]; } }
        return false;
    }

    function httpsUrl(u, base) {
        var r;
        if (typeof u !== "string" || u === "") { return null; }
        try { r = base ? new URL(u, base) : new URL(u); } catch (e) { return null; }
        return r.protocol === "https:" ? r.toString() : null;
    }

    // Путь файла внутри панели: только обычные имена, без «..», скрытых файлов и абсолютных путей.
    function safeRelPath(p) {
        return typeof p === "string" && p.length < 200 &&
            /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(p);
    }

    function loadUpdateState() {
        var s;
        try { s = JSON.parse(window.localStorage.getItem(UPDATE_STATE_KEY) || "{}"); } catch (e) { s = null; }
        return s && typeof s === "object" ? s : {};
    }

    function storeUpdateState(s) {
        try { window.localStorage.setItem(UPDATE_STATE_KEY, JSON.stringify(s)); } catch (e) {}
    }

    // Читает version.json. Поле moved ведёт на новый адрес этого файла (переезд на другой сервер).
    function fetchUpdateInfo(url, hops) {
        var fresh = url + (url.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now();
        return platform.getText(fresh, 20000).then(function (r) {
            var info, moved;
            if (r.status !== 200) { throw new Error("UPDATE_HTTP_" + r.status); }
            try { info = JSON.parse(r.text); } catch (e) { throw new Error("UPDATE_BAD_INFO"); }
            if (!info || typeof info !== "object") { throw new Error("UPDATE_BAD_INFO"); }
            moved = httpsUrl(info.moved);
            if (moved && moved !== url && hops < 2) { return fetchUpdateInfo(moved, hops + 1); }
            if (!parseVersion(info.version)) { throw new Error("UPDATE_BAD_INFO"); }
            return { info: info, url: url };
        });
    }

    function updateConfigured() {
        return UPDATE_URL !== "" && typeof platform.getText === "function";
    }

    function canSelfUpdate(offer) {
        var files = offer.info.files;
        return platform.available && typeof platform.download === "function" && extensionDir() !== "" &&
            Object.prototype.toString.call(files) === "[object Array]" && files.length > 0 && files.length <= UPDATE_MAX_FILES;
    }

    function downloadUrl(offer) {
        return httpsUrl(offer.info.download, offer.url);
    }

    function updateMessage(text, bad) {
        ui.updateStatus.hidden = !text;
        ui.updateStatus.textContent = text || "";
        ui.updateStatus.className = bad ? "bad" : "";
    }

    function showUpdate(offer) {
        var notes = offer.info.notes;
        var i, li;
        updateOffer = offer;
        ui.updateTitle.textContent = "Доступна версия " + parseVersion(offer.info.version).join(".");
        ui.updateNotes.innerHTML = "";
        if (typeof notes === "string") { notes = [notes]; }
        if (Object.prototype.toString.call(notes) === "[object Array]") {
            for (i = 0; i < notes.length && i < 6; i++) {
                if (typeof notes[i] === "string" && notes[i] !== "") {
                    li = document.createElement("li");
                    li.textContent = notes[i].slice(0, 300);
                    ui.updateNotes.appendChild(li);
                }
            }
        }
        updateMessage("", false);
        ui.updateNow.disabled = false;
        ui.updateLater.disabled = false;
        ui.updateNow.textContent = canSelfUpdate(offer) ? "Обновить" : "Скачать обновление";
        ui.updateDownload.hidden = true;
        ui.updateBar.hidden = false;
    }

    // Показывает плашку, если версия на сервере новее установленной. Возвращает true, если новее.
    function considerOffer(offer, manual) {
        if (!offer || !offer.info || !isNewer(offer.info.version, VERSION)) {
            if (!updating) { ui.updateBar.hidden = true; updateOffer = null; }
            return false;
        }
        if (manual) { updateDismissed = false; }
        if (!updateDismissed && !updating) { showUpdate(offer); }
        return true;
    }

    // manual: проверку запросил пользователь — идём на сервер, даже если недавно проверяли.
    function checkForUpdate(manual) {
        var state, start;
        if (!updateConfigured()) { return Promise.resolve(null); }
        state = loadUpdateState();
        if (state.base !== UPDATE_URL) { state = { base: UPDATE_URL, justUpdated: state.justUpdated }; }
        if (!manual && state.latest && typeof state.lastCheck === "number" &&
                Date.now() >= state.lastCheck && Date.now() - state.lastCheck < UPDATE_CHECK_EVERY_MS) {
            considerOffer(state.latest, false);
            return Promise.resolve(state.latest);
        }
        start = httpsUrl(state.url) || UPDATE_URL;
        return fetchUpdateInfo(start, 0).catch(function (e) {
            // Запомненный адрес после переезда перестал отвечать — возвращаемся к исходному.
            if (start !== UPDATE_URL) { return fetchUpdateInfo(UPDATE_URL, 0); }
            throw e;
        }).then(function (offer) {
            state.lastCheck = Date.now();
            state.url = offer.url !== UPDATE_URL ? offer.url : "";
            state.latest = offer;
            storeUpdateState(state);
            considerOffer(offer, manual);
            return offer;
        });
    }

    function updateError(e) {
        var m = e && e.message ? e.message : String(e);
        if (m === "UPDATE_BAD_FILE") { return "Файлы обновления на сервере ещё не обновились. Попробуйте через несколько минут."; }
        if (m === "UPDATE_BAD_INFO") { return "Описание обновления на сервере повреждено. Попробуйте позже."; }
        if (m === "UPDATE_NO_ACCESS") { return "Нет прав на запись в папку панели. Установите новую версию установщиком."; }
        if (m === "UPDATE_SIGNED") { return "Эта копия панели установлена из подписанного пакета. Установите новую версию установщиком."; }
        if (m === "UPDATE_INSTALL_FAILED") { return "Обновление установилось не полностью. Переустановите панель установщиком."; }
        return "Не удалось скачать обновление. Проверьте интернет и попробуйте ещё раз.";
    }

    // Скачивает все файлы во временную папку, сверяет суммы и только потом заменяет файлы панели.
    function installUpdate(offer) {
        var info = offer.info;
        var ext = extensionDir();
        var base = httpsUrl(typeof info.base === "string" && info.base !== "" ? info.base : "Sayframe/", offer.url);
        var tmp = platform.join(platform.tmpdir(), "sayframe-update-" + Date.now());
        var plan = [];
        var i, f, chain;

        if (!base) { return Promise.reject(new Error("UPDATE_BAD_INFO")); }
        if (base.charAt(base.length - 1) !== "/") { base += "/"; }
        for (i = 0; i < info.files.length; i++) {
            f = info.files[i];
            if (!f || !safeRelPath(f.path) || !/^[0-9a-f]{64}$/i.test(String(f.sha256))) {
                return Promise.reject(new Error("UPDATE_BAD_INFO"));
            }
            plan.push({
                url: httpsUrl(f.path + "?v=" + String(f.sha256).slice(0, 12), base),
                sha: String(f.sha256).toLowerCase(),
                tmp: platform.join(tmp, "file" + i),
                dest: platform.join.apply(null, [ext].concat(f.path.split("/")))
            });
        }

        function cleanup() {
            var k;
            for (k = 0; k < plan.length; k++) { platform.remove(plan[k].tmp); }
        }

        chain = platform.exists(platform.join(ext, "META-INF", "signatures.xml")).then(function (signed) {
            var probe = platform.join(ext, ".sayframe-write-test");
            if (signed) { throw new Error("UPDATE_SIGNED"); }
            return platform.writeText(probe, "").then(function () { return platform.remove(probe); }, function () {
                throw new Error("UPDATE_NO_ACCESS");
            });
        }).then(function () { return platform.mkdirp(tmp); });

        function fetchOne(p, n) {
            return function () {
                updateMessage("Скачиваю обновление: файл " + (n + 1) + " из " + plan.length, false);
                return platform.download(p.url, p.tmp, 60000).then(function (r) {
                    if (r.status !== 200) { throw new Error("UPDATE_HTTP_" + r.status); }
                    if (String(r.sha256).toLowerCase() !== p.sha) { throw new Error("UPDATE_BAD_FILE"); }
                });
            };
        }
        function placeOne(p) {
            return function () {
                return platform.mkdirp(platform.dirname(p.dest)).then(function () { return platform.move(p.tmp, p.dest); });
            };
        }
        for (i = 0; i < plan.length; i++) { chain = chain.then(fetchOne(plan[i], i)); }
        chain = chain.then(function () {
            var placing = Promise.resolve();
            var k;
            updateMessage("Устанавливаю обновление…", false);
            for (k = 0; k < plan.length; k++) { placing = placing.then(placeOne(plan[k])); }
            return placing.catch(function () { throw new Error("UPDATE_INSTALL_FAILED"); });
        }).then(function () {
            // Новая версия host.jsx должна заменить загруженную в After Effects.
            return evalScript("$.evalFile(" + asciiJSON(ext + "/jsx/host.jsx") + "); 1").catch(function () {});
        });
        return chain.then(function () { cleanup(); }, function (e) { cleanup(); throw e; });
    }

    function onOpenDownload() {
        var url = updateOffer ? downloadUrl(updateOffer) : null;
        if (!url || !platform.openExternal(url)) {
            updateMessage("Ссылка на установщик недоступна. Скачайте новую версию там же, где брали панель.", true);
        }
    }

    function onUpdateNow() {
        var offer = updateOffer;
        if (!offer || updating) { return; }
        if (!canSelfUpdate(offer)) { onOpenDownload(); return; }
        if (busy) { updateMessage("Дождитесь окончания текущей задачи и нажмите ещё раз.", true); return; }
        updating = true;
        setBusy(true);
        ui.updateNow.disabled = true;
        ui.updateLater.disabled = true;
        ui.updateDownload.hidden = true;
        installUpdate(offer).then(function () {
            var state = loadUpdateState();
            state.justUpdated = parseVersion(offer.info.version).join(".");
            storeUpdateState(state);
            updateMessage("Готово, перезапускаю панель…", false);
            // Небольшая пауза, чтобы отметка об обновлении успела сохраниться до перезапуска.
            setTimeout(function () { platform.reload(); }, 400);
        }).catch(function (e) {
            updating = false;
            setBusy(false);
            ui.updateNow.disabled = false;
            ui.updateLater.disabled = false;
            updateMessage(updateError(e), true);
            ui.updateDownload.hidden = downloadUrl(offer) === null;
        });
    }

    function onUpdateLater() {
        if (updating) { return; }
        updateDismissed = true;
        ui.updateBar.hidden = true;
    }

    function onCheckUpdate() {
        function hint(text, kind) {
            ui.updateHint.hidden = false;
            ui.updateHint.textContent = text;
            ui.updateHint.className = "hint" + (kind ? " " + kind : "");
        }
        if (!updateConfigured()) { hint("В этой сборке проверка обновлений не настроена.", ""); return; }
        ui.checkUpdate.disabled = true;
        hint("Проверяю…", "");
        checkForUpdate(true).then(function (offer) {
            ui.checkUpdate.disabled = false;
            if (offer && isNewer(offer.info.version, VERSION)) {
                hint("Доступна версия " + parseVersion(offer.info.version).join(".") + ". Закройте настройки: кнопка обновления вверху панели.", "ok");
            } else {
                hint("У вас последняя версия.", "ok");
            }
        }).catch(function () {
            ui.checkUpdate.disabled = false;
            hint("Не удалось проверить обновления. Проверьте интернет и попробуйте ещё раз.", "bad");
        });
    }

    // После обновления панель перезапускается; один раз сообщаем, что оно установлено.
    function announceUpdate() {
        var state = loadUpdateState();
        if (!state.justUpdated) { return; }
        if (state.justUpdated === VERSION) { setStatus("Sayframe обновлён до версии " + VERSION + ".", "done"); }
        delete state.justUpdated;
        storeUpdateState(state);
    }

    // ---------------------------------------------------------------- init

    applyTheme(settings);
    buildSettings();
    showRef();
    applyTabOrder();
    showTab(savedTab());
    enableArranging();
    enableTabReordering();
    enableMotion();

    ui.runBtn.addEventListener("click", onRun);
    ui.fixBtn.addEventListener("click", onFix);
    ui.newBtn.addEventListener("click", onNew);
    ui.refBtn.addEventListener("click", onAttachReference);
    ui.refClear.addEventListener("click", onClearReference);
    ui.pasteBtn.addEventListener("click", function () { pasteImage(null); });
    ui.settingsBtn.addEventListener("click", openSettings);
    ui.settingsClose.addEventListener("click", function () { closeSettings(false); });
    ui.saveSettings.addEventListener("click", function () { closeSettings(true); });
    ui.testKey.addEventListener("click", onTestKey);
    ui.updateNow.addEventListener("click", onUpdateNow);
    ui.updateLater.addEventListener("click", onUpdateLater);
    ui.updateDownload.addEventListener("click", onOpenDownload);
    ui.checkUpdate.addEventListener("click", onCheckUpdate);
    ui.versionText.textContent = "Sayframe " + VERSION;
    document.addEventListener("paste", onPasteEvent);
    ui.prompt.addEventListener("keydown", function (e) {
        // Cmd/Ctrl+Enter запускает задачу.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onRun(); }
    });

    if (!settings.apiKey) {
        setStatus("Сначала откройте настройки (значок шестерёнки) и вставьте ключ Anthropic API.", "");
    }
    announceUpdate();
    ensureHost().catch(function (e) { setStatus(humanError(e), "error"); });
    // Проверка обновлений идёт в фоне и не мешает работе: об ошибках сети молчим.
    setTimeout(function () { checkForUpdate(false).catch(function () {}); }, 1200);
})();
