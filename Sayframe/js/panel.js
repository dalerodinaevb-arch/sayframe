/*
 * Sayframe — интерфейс и логика панели (выполняется в HTML-движке After Effects).
 * Со стороны After Effects работает jsx/host.jsx; сюда он возвращает только JSON.
 */
(function () {
    "use strict";

    var VERSION = "1.17.0";
    // Адрес файла version.json с описанием последней версии. Пустая строка выключает проверку обновлений.
    var UPDATE_URL = typeof window.__SAYFRAME_TEST_UPDATE_URL__ === "string" ? window.__SAYFRAME_TEST_UPDATE_URL__ : "https://raw.githubusercontent.com/dalerodinaevb-arch/sayframe/main/version.json";
    var UPDATE_STATE_KEY = "sayframe.update.v1";
    var TAB_KEY = "sayframe.tab.v1";
    var TAB_ORDER_KEY = "sayframe.tabOrder.v1";
    var MOTION_KEY = "sayframe.motion.v1";
    var SCRIPTS_KEY = "sayframe.scripts.v1";  // «Мои скрипты»: { open, items: [{ id, name, codes, created }] }
    var MAX_SCRIPTS = 100;
    var EXPR_OPEN_KEY = "sayframe.exprOpen.v1";
    var EXPR_MAX_TOKENS = 4096;
    var EXPR_RETRIES = 2;   // сколько раз нейросеть может поправить выражение, которое After Effects не принял
    var QUICK_KEY = "sayframe.quick.v1";      // быстрые задачи: { open, items: [{ id, name, text }] }
    var MAX_QUICK = 30;
    // Стандартные быстрые задачи. Текст написан подробно: так нейросеть точнее понимает, что нужно.
    var QUICK_DEFAULTS = [
        { id: "q-text", name: "Появление текста",
          text: "Сделай плавное появление текста: у выделенных текстовых слоёв (если ничего не выделено — у всех текстовых слоёв открытой композиции) буквы проявляются по очереди, слегка поднимаясь снизу и из прозрачности. Начало — текущее время, длительность около 1 секунды, с плавным замедлением в конце." },
        { id: "q-lower", name: "Подпись внизу кадра",
          text: "Сделай подпись внизу кадра (lower third) в открытой композиции: аккуратная плашка в левой нижней части кадра, на ней имя «Имя Фамилия» и строкой ниже «Должность» мельче. Плашка и текст плавно выезжают слева с текущего времени, держатся 4 секунды и так же плавно уезжают. Всё собери в отдельную прекомпозицию «Подпись»." },
        { id: "q-logo", name: "Логотип с отскоком",
          text: "Анимируй появление выделенного слоя как логотипа: масштаб от 0 до 100% с упругим отскоком (лёгкий перелёт и возврат), прозрачность от 0 до 100% в начале. Начало — текущее время, длительность около 0,8 секунды. Точку привязки поставь в центр слоя, чтобы он рос из середины." },
        { id: "q-tidy", name: "Упорядочить проект",
          text: "Упорядочи панель Project: разложи элементы по папкам «Композиции», «Видео», «Картинки», «Звук», «Заливки» и «Прочее». Уже существующие папки с такими именами используй, пустые не создавай, ничего не удаляй и не переименовывай." }
    ];
    var SCRIPT_NAME_MAX = 60;   // положения ползунков и выбор в разделе «Инструменты»
    var TAB_DRAG_START_PX = 6;   // сдвиг мыши, после которого нажатие на вкладку считается перетаскиванием
    // Как часто открытая панель сама спрашивает сервер о новой версии. Ещё она спрашивает при запуске
    // и когда в неё возвращаются (щелчок по панели), но не чаще, чем раз в UPDATE_THROTTLE_MS.
    var UPDATE_CHECK_EVERY_MS = window.__SAYFRAME_TEST_UPDATE_EVERY_MS__ || 5 * 60 * 1000;
    var UPDATE_THROTTLE_MS = Math.round(UPDATE_CHECK_EVERY_MS * 0.8);
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
    var LINK_MAX_BYTES = 150 * 1024 * 1024;   // больше ссылка-референс не скачивается
    var MEDIA_TYPES = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
        "image/bmp": ".bmp", "image/tiff": ".tif", "image/heic": ".heic",
        "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v", "video/webm": ".webm", "video/x-msvideo": ".avi"
    };
    var MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|mp4|mov|m4v|webm|avi)$/i;

    // Расширение для скачанного файла: по типу из ответа сервера, а если он ничего не сказал — по адресу.
    function mediaExt(type, url) {
        var t = String(type || "").split(";")[0].replace(/\s/g, "").toLowerCase();
        var m;
        if (MEDIA_TYPES.hasOwnProperty(t)) { return MEDIA_TYPES[t]; }
        try { m = MEDIA_EXT.exec(new URL(url).pathname); } catch (e) { m = null; }
        if (m && (t === "" || t === "application/octet-stream" || t === "binary/octet-stream")) { return m[0].toLowerCase().replace(".jpeg", ".jpg"); }
        return "";
    }

    var MODELS = [
        { id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: "Быстрый и умный" },
        { id: "claude-opus-5-5", name: "Opus 5.5", note: "Для сложных задач" },
        { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", note: "Самый быстрый" }
    ];
    // ChatGPT (OpenAI API). Отвечает через Chat Completions; у этих моделей есть размышление,
    // поэтому лимит ответа больше: он делится между размышлением и самим ответом.
    var OPENAI_URL = "https://api.openai.com/v1/chat/completions";
    var OPENAI_MAX_TOKENS = 32768;
    var OPENAI_MODELS = [
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", note: "Быстрый и умный" },
        { id: "gpt-6-astra", name: "GPT-6 Astra", note: "Для сложных задач" },
        { id: "gpt-6-luna", name: "GPT-6 Luna", note: "Самый быстрый" }
    ];
    var PROVIDERS = {
        claude: { name: "Claude", keyLabel: "Ключ Anthropic API", placeholder: "sk-ant-…", keyField: "apiKey", modelField: "model", models: MODELS,
            hint: "Создаётся на platform.claude.com, в разделе Settings → API keys. Хранится только на этом компьютере." },
        openai: { name: "ChatGPT", keyLabel: "Ключ OpenAI API", placeholder: "sk-…", keyField: "openaiKey", modelField: "openaiModel", models: OPENAI_MODELS,
            hint: "Создаётся на platform.openai.com, в разделе API keys. Оплата там отдельная: подписка ChatGPT Plus для API не подходит. Хранится только на этом компьютере." }
    };
    var ACCENTS = ["#9d7bff", "#62c8ff", "#ff7ac3", "#ffb957", "#b8f25a", "#f4f4f8"];
    var BACKGROUNDS = ["#0b0c12", "#101014", "#0d1117", "#140d17", "#0c1311"];

    var DEFAULTS = {
        apiKey: "",
        model: MODELS[0].id,
        provider: "claude",          // кто пишет скрипты: "claude" или "openai" (ChatGPT)
        openaiKey: "",
        openaiModel: OPENAI_MODELS[0].id,
        accent: ACCENTS[0],
        bg: BACKGROUNDS[0],
        selfCheck: true,
        alwaysAsk: false,
        refFrames: 8,
        panelWidth: 380,    // ширина содержимого в пикселях; сама панель After Effects может быть шире
        toolSize: "large",  // размер блоков раздела «Инструменты»: "large" или "small"
        toolTitles: true,   // показывать ли названия блоков раздела «Инструменты»
        hotkeys: ""         // горячие клавиши: "console=Ctrl+Space;snapshot=;…"; пусто — стандартные
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
        // Anything else the system itself can read as a picture (JPEG, HEIC, GIF, a promised image...).
        '    if (res === "NOIMAGE") {',
        "        try {",
        "            var img = $.NSImage.alloc.initWithPasteboard(pb);",
        "            if (!img.isNil()) {",
        "                var tiff2 = img.TIFFRepresentation;",
        "                var rep2 = tiff2.isNil() ? null : $.NSBitmapImageRep.imageRepWithData(tiff2);",
        "                var png2 = (!rep2 || rep2.isNil()) ? null : rep2.representationUsingTypeProperties(4, $.NSDictionary.dictionary);",
        '                if (png2 && !png2.isNil()) { res = png2.writeToFileAtomically(out, true) ? "OK" : "WRITEFAIL"; }',
        "            }",
        "        } catch (e) {}",
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
        var fs, os, path, https, httpMod, cp, crypto, Buf;

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

        // GET по http(s) для ссылок-референсов: с заголовками обычного браузера (иначе многие сайты
        // отдают пустую страницу), по перенаправлениям, не больше LINK_MAX_BYTES.
        function fetchRaw(url, redirects) {
            return new Promise(function (resolve, reject) {
                var u, mod, rq;
                try { u = new URL(url); } catch (e) { reject(new Error("LINK_BAD")); return; }
                if (u.protocol !== "https:" && u.protocol !== "http:") { reject(new Error("LINK_BAD")); return; }
                mod = u.protocol === "https:" ? https : httpMod;
                rq = mod.get({
                    hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search,
                    headers: {
                        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                        "accept": "text/html,application/xhtml+xml,image/*,video/*,*/*;q=0.8",
                        "accept-language": "ru,en;q=0.8"
                    }
                }, function (res) {
                    var chunks = [];
                    var size = 0;
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (redirects <= 0) { reject(new Error("TOO_MANY_REDIRECTS")); return; }
                        resolve(fetchRaw(new URL(res.headers.location, url).toString(), redirects - 1));
                        return;
                    }
                    res.on("data", function (c) {
                        size += c.length;
                        if (size > LINK_MAX_BYTES) { rq.destroy(new Error("LINK_TOO_BIG")); return; }
                        chunks.push(c);
                    });
                    res.on("end", function () {
                        resolve({ status: res.statusCode, type: String(res.headers["content-type"] || "").toLowerCase(), url: url, body: Buf.concat(chunks) });
                    });
                    res.on("error", reject);
                });
                rq.on("error", reject);
                rq.setTimeout(60000, function () { rq.destroy(new Error("TIMEOUT")); });
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
                fetchUrl: need,
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
        httpMod = req("http");
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
            // Ссылка-референс: страница возвращается текстом, картинка или видео — файлом во временной папке.
            // destBase — путь без расширения: расширение берётся из типа файла или из адреса.
            fetchUrl: function (url, destBase) {
                return fetchRaw(url, 6).then(function (r) {
                    var ext;
                    if (r.status !== 200) { return { status: r.status, contentType: r.type, finalUrl: r.url }; }
                    if (/^(text\/html|application\/xhtml)/.test(r.type)) {
                        return { status: 200, contentType: r.type, finalUrl: r.url, text: r.body.toString("utf8") };
                    }
                    ext = mediaExt(r.type, r.url);
                    if (!ext) { return { status: 200, contentType: r.type, finalUrl: r.url }; }
                    return new Promise(function (resolve, reject) { fs.writeFile(destBase + ext, r.body, cb(resolve, reject)); })
                        .then(function () { return { status: 200, contentType: r.type, finalUrl: r.url, path: destBase + ext, size: r.body.length }; });
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
        if (m === "LINK_BAD") { return "это не ссылка на сайт (нужна ссылка, которая начинается с https://)."; }
        if (m === "LINK_NO_MEDIA") { return "на странице не нашлось картинки или видео. Откройте картинку или видео отдельно и скопируйте ссылку на него."; }
        if (m === "LINK_NOT_MEDIA") { return "по ссылке не картинка и не видео."; }
        if (m === "LINK_TOO_BIG") { return "файл больше 150 МБ. Скачайте его и прикрепите кнопкой «+ Референс»."; }
        if (m === "TOO_MANY_REDIRECTS") { return "сайт слишком много раз перенаправляет запрос."; }
        if (/^LINK_HTTP:/.test(m)) {
            m = m.split(":")[1];
            if (m === "401" || m === "403") { return "сайт не пускает без входа в аккаунт (код " + m + "). Скачайте файл и прикрепите его кнопкой «+ Референс»."; }
            if (m === "404") { return "по ссылке ничего нет (код 404)."; }
            return "сайт ответил ошибкой (код " + m + ").";
        }
        if (m === "TIMEOUT") { return aiName() + " не ответил вовремя. Попробуйте ещё раз."; }
        if (m === "NO_ACTIVE_COMP") { return "Откройте композицию: инструмент работает с открытой композицией."; }
        if (m === "NO_KEYS_SELECTED") { return "Выделите ключевые кадры на таймлайне и нажмите ещё раз."; }
        if (m === "NO_LAYERS_SELECTED") { return "Выделите слой в композиции и нажмите ещё раз."; }
        if (m === "STAGGER_NEEDS_TWO") { return "Для лесенки выделите хотя бы два слоя."; }
        if (m === "STAGGER_NO_KEYS") { return "Для лесенки нужно хотя бы два слоя с ключами в этой половине слоя. Чтобы сдвинуть слои целиком, выберите «Слои»."; }
        if (m === "DISTRIBUTE_NEEDS_THREE") { return "Чтобы распределить слои, выделите три или больше: крайние останутся на месте, остальные встанут между ними через равные промежутки."; }
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
        if (s.toolSize !== "small") { s.toolSize = "large"; }
        if (!PROVIDERS.hasOwnProperty(s.provider)) { s.provider = "claude"; }
        if (!knownModel(OPENAI_MODELS, s.openaiModel)) { s.openaiModel = OPENAI_MODELS[0].id; }
        return s;
    }

    function knownModel(list, id) {
        var i;
        for (i = 0; i < list.length; i++) { if (list[i].id === id) { return true; } }
        return false;
    }

    function providerOf(s) { return PROVIDERS[(s || settings).provider] || PROVIDERS.claude; }
    function aiName() { return providerOf().name; }
    function aiKey(s) { s = s || settings; return s[providerOf(s).keyField] || ""; }

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
        document.documentElement.setAttribute("data-tools", s.toolSize === "small" ? "small" : "large");
        document.documentElement.setAttribute("data-titles", s.toolTitles === false ? "off" : "on");
        relayoutTools();
    }

    // ------------------------------------------------------------------ ui

    function el(id) { return document.getElementById(id); }

    var ui = {
        prompt: el("prompt"), runBtn: el("runBtn"), fixBtn: el("fixBtn"), newBtn: el("newBtn"),
        refBtn: el("refBtn"), refChip: el("refChip"), refText: el("refText"), refClear: el("refClear"),
        exprCard: el("exprCard"), exprToggle: el("exprToggle"), exprBody: el("exprBody"), exprWish: el("exprWish"),
        exprApplyBtn: el("exprApplyBtn"), exprFixBtn: el("exprFixBtn"),
        quickBox: el("quickBox"), quickToggle: el("quickToggle"), quickAdd: el("quickAdd"), quickEdit: el("quickEdit"), quickList: el("quickList"),
        quickForm: el("quickForm"), quickName: el("quickName"), quickText: el("quickText"), quickSave: el("quickSave"), quickCancel: el("quickCancel"),
        saveRow: el("saveRow"), saveScriptBtn: el("saveScriptBtn"), saveForm: el("saveForm"), saveName: el("saveName"),
        saveConfirm: el("saveConfirm"), saveCancel: el("saveCancel"),
        scriptsCard: el("scriptsCard"), scriptsToggle: el("scriptsToggle"), scriptsCount: el("scriptsCount"), scriptsList: el("scriptsList"),
        refLinkBtn: el("refLinkBtn"), refLinkRow: el("refLinkRow"), refLink: el("refLink"), refLinkAdd: el("refLinkAdd"), refLinkCancel: el("refLinkCancel"),
        statusBox: el("statusBox"), status: el("status"),
        replyCard: el("replyCard"), replyText: el("replyText"), replyCode: el("replyCode"), codeBox: el("codeBox"),
        pinLine: el("pinLine"), pasteBtn: el("pasteBtn"), settingsBtn: el("settingsBtn"),
        sheet: el("settingsSheet"), settingsClose: el("settingsClose"), apiKey: el("apiKey"), testKey: el("testKey"),
        keyHint: el("keyHint"), models: el("models"), provider: el("provider"), apiKeyLabel: el("apiKeyLabel"), accentSwatches: el("accentSwatches"), accentHex: el("accentHex"),
        bgSwatches: el("bgSwatches"), bgHex: el("bgHex"), selfCheck: el("selfCheck"), alwaysAsk: el("alwaysAsk"),
        panelWidth: el("panelWidth"), panelWidthVal: el("panelWidthVal"), toolSize: el("toolSize"), toolTitles: el("toolTitles"),
        pasteOptsToggle: el("pasteOptsToggle"), pasteHint: el("pasteHint"),
        fxBtn: el("fxBtn"), fxConsole: el("fxConsole"), fxSearch: el("fxSearch"), fxSnap: el("fxSnap"), fxClose: el("fxClose"), fxList: el("fxList"),
        acTabs: el("acTabs"), acSearch: el("acSearch"), acFavOnly: el("acFavOnly"), acModeRow: el("acModeRow"), acMode: el("acMode"),
        acDurRow: el("acDurRow"), acDur: el("acDur"), acDurVal: el("acDurVal"), acColorRow: el("acColorRow"), acColor: el("acColor"),
        acGrid: el("acGrid"), acHint: el("acHint"), acSize: el("acSize"), acFoot: el("acFoot"),
        fxKeys: el("fxKeys"), fxKeysCombo: el("fxKeysCombo"),
        setTabAI: el("setTabAI"), setTabOther: el("setTabOther"), setPaneAI: el("setPaneAI"), setPaneOther: el("setPaneOther"),
        hotkeys: el("hotkeys"), hotkeysReset: el("hotkeysReset"), hotkeyNote: el("hotkeyNote"),
        organizeBtn: el("organizeBtn"), organizeOptsToggle: el("organizeOptsToggle"), organizeHint: el("organizeHint"),
        anchorOptsToggle: el("anchorOptsToggle"), anchorSide: el("anchorSide"), alignOptsToggle: el("alignOptsToggle"), alignSide: el("alignSide"), distLabel: el("distLabel"), distGrid: el("distGrid"),
        shiftOptsToggle: el("shiftOptsToggle"), shiftPick: el("shiftPick"), timePick: el("timePick"), staggerPick: el("staggerPick"),
        shiftWhat: el("shiftWhat"), shiftStep: el("shiftStep"), shiftBack: el("shiftBack"), shiftFwd: el("shiftFwd"),
        timeAlign: el("timeAlign"), timeAlignBtn: el("timeAlignBtn"),
        staggerWhat: el("staggerWhat"), staggerStep: el("staggerStep"), staggerOrder: el("staggerOrder"), staggerBtn: el("staggerBtn"),
        frames: el("frames"), saveSettings: el("saveSettings"),
        modal: el("modal"), modalTitle: el("modalTitle"), modalText: el("modalText"), modalCode: el("modalCode"),
        modalButtons: el("modalButtons"),
        updateBar: el("updateBar"), updateTitle: el("updateTitle"), updateNotes: el("updateNotes"),
        updateStatus: el("updateStatus"), updateNow: el("updateNow"), updateLater: el("updateLater"),
        updateDownload: el("updateDownload"),
        versionText: el("versionText"), checkUpdate: el("checkUpdate"), updateHint: el("updateHint"),
        arrangeBar: el("arrangeBar"), arrangeDone: el("arrangeDone"), arrangeReset: el("arrangeReset"), gridCells: el("gridCells"),
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
    var currentRun = null;       // скрипты, выполненные за текущий запрос: { name, codes }
    var lastRun = null;          // то же для последнего законченного запроса — его можно сохранить
    var pendingRef = null;       // референс, который уйдёт со следующим запросом
    var refSentNote = false;     // показываем «референс отправлен»
    var dialogHasRef = false;
    var checkMsgs = [];
    var busy = false;

    // Вкладки: «Claude» (задача, референс, запуск, ответ), «Анимация» (внутреннее имя tools, пока пустая)
    // и «Инструменты» (внутреннее имя motion: блоки на сетке). Внутренние имена прежние, чтобы не сбить сохранённый порядок.
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
        if (name === "motion") { relayoutTools(); }
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

    // ---- перестановка: вкладки и блоки раздела «Инструменты» двигаются только в этом режиме.
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
        ui.refLinkBtn.disabled = on;
        ui.saveScriptBtn.disabled = on;
        ui.exprApplyBtn.disabled = on;
        ui.exprFixBtn.disabled = on;
        Array.prototype.forEach.call(ui.quickList.querySelectorAll("button"), function (b) { b.disabled = on; });
        ui.saveConfirm.disabled = on;
        Array.prototype.forEach.call(ui.scriptsList.querySelectorAll("button"), function (b) { b.disabled = on; });
        ui.refLinkAdd.disabled = on;
        ui.refLink.disabled = on;
        ui.pasteBtn.disabled = on;
        ui.organizeBtn.disabled = on;
        ui.fxBtn.disabled = on;
        ui.acGrid.classList.toggle("busy", on);
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
            ui.refText.textContent = "Референс отправлен, " + aiName() + " помнит его в этом диалоге";
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

    function callAI(messages, maxTokens, system) {
        return settings.provider === "openai" ? callOpenAI(messages, maxTokens, system) : callClaude(messages, maxTokens, system);
    }

    // История хранится в формате Claude; для ChatGPT картинки и текст перекладываются в его формат.
    function openAIMessages(messages, system) {
        var out = [{ role: "system", content: system || SYSTEM_PROMPT }];
        messages.forEach(function (m) {
            var parts;
            if (!(m.content instanceof Array)) { out.push({ role: m.role, content: m.content }); return; }
            parts = m.content.map(function (b) {
                if (b.type === "image") {
                    return { type: "image_url", image_url: { url: "data:" + b.source.media_type + ";base64," + b.source.data } };
                }
                return { type: "text", text: b.text };
            });
            out.push({ role: m.role, content: parts });
        });
        return out;
    }

    function callOpenAI(messages, maxTokens, system) {
        var body = JSON.stringify({
            model: settings.openaiModel,
            max_completion_tokens: Math.max(maxTokens || 0, OPENAI_MAX_TOKENS),
            messages: openAIMessages(messages, system)
        });
        var headers = {
            "authorization": "Bearer " + settings.openaiKey,
            "content-type": "application/json"
        };
        return platform.postJSON(OPENAI_URL, headers, body, 300000).then(function (res) {
            var data, choice, content;
            var out = { ok: false, text: "", stopReason: "", error: "" };
            try { data = JSON.parse(res.text); } catch (e) {
                out.error = "Не удалось разобрать ответ сервера (код " + res.status + ").";
                return out;
            }
            if (data && data.error) {
                out.error = "ChatGPT API: " + (data.error.message || data.error.code || data.error.type || "ошибка");
                return out;
            }
            choice = data && data.choices instanceof Array ? data.choices[0] : null;
            if (!choice || !choice.message) {
                out.error = "Неожиданный ответ сервера (код " + res.status + ").";
                return out;
            }
            content = choice.message.content;
            if (content instanceof Array) {
                content = content.map(function (c) { return c && c.text ? c.text : ""; }).join("");
            }
            out.text = typeof content === "string" ? content : "";
            if (choice.message.refusal && !out.text) { out.text = String(choice.message.refusal); }
            out.stopReason = choice.finish_reason === "length" ? "max_tokens" : (choice.finish_reason || "");
            out.ok = true;
            return out;
        }, function (e) {
            return { ok: false, text: "", stopReason: "", error: "Нет связи с сервером: " + humanError(e) };
        });
    }

    function callClaude(messages, maxTokens, system) {
        var body = JSON.stringify({
            model: settings.model,
            max_tokens: maxTokens || MAX_TOKENS,
            system: system || SYSTEM_PROMPT,
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

        if (!aiKey()) {
            giveUp("Нужен " + providerOf().keyLabel.replace(/^Ключ/, "ключ") + ". Вставьте его в настройках.");
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
                    setStatus("В скрипте синтаксическая ошибка, прошу " + aiName() + " исправить (попытка " + (attempt + 1) + ")…", "busy");
                } else if (round > 0) {
                    setStatus(doneText() + "\n" + aiName() + " смотрит на кадры результата (проверка " + round + " из " + MAX_CHECK_ROUNDS + ")…", "busy");
                } else {
                    setStatus("Жду ответ " + aiName() + "…", "busy");
                }

                reply = await callAI(history);
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
                        finish(doneText() + "\n" + aiName() + " проверил результат: " + (expl || "замечаний нет.") + undoHint(), "done");
                    } else if (reply.stopReason === "max_tokens") {
                        finish("Ответ оборвался по длине. Попробуйте разбить задачу на части.", "error");
                    } else {
                        finish(aiName() + " ответил текстом, скрипт не запускался.", "");
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
                reason = expl || aiName() + " подготовил скрипт.";
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

            setStatus(scriptsRun > 0 ? aiName() + " нашёл недочёт: " + (expl || "вношу правку") + "…" : "Выполняю скрипт…", "busy");
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
            if (currentRun) { currentRun.codes.push(code); }

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
        beginRun(text);
        await askAndRun(text.length > 40 ? text.substring(0, 40) + "…" : text, sent, info.fileAccess);
        endRun();
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
        beginRun(lastRun && lastRun.name ? lastRun.name : "исправление");
        await askAndRun("исправление", null, info.fileAccess);
        endRun();
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
        setStatus("Начат новый диалог: " + aiName() + " больше не помнит предыдущие запросы.", "");
    }

    // ---------------------------------------------------------- my scripts
    // Удачный скрипт (или несколько, если нейросеть после проверки вносила правки) можно сохранить
    // и потом запускать одной кнопкой: без нейросети, мгновенно и бесплатно.

    function beginRun(text) {
        currentRun = { name: String(text).substring(0, SCRIPT_NAME_MAX), codes: [] };
        lastRun = null;
        showSaveRow();
    }

    function endRun() {
        lastRun = currentRun && currentRun.codes.length ? currentRun : null;
        currentRun = null;
        showSaveRow();
    }

    function showSaveRow() {
        ui.saveRow.hidden = !lastRun || !!lastRun.saved;
        ui.saveForm.hidden = true;
    }

    function loadScripts() {
        var d, items, out = [];
        try { d = JSON.parse(window.localStorage.getItem(SCRIPTS_KEY) || "{}"); } catch (e) { d = {}; }
        if (!d || typeof d !== "object") { d = {}; }
        items = d.items instanceof Array ? d.items : [];
        items.forEach(function (it) {
            if (!it || typeof it.name !== "string" || !(it.codes instanceof Array) || !it.codes.length) { return; }
            if (!it.codes.every(function (c) { return typeof c === "string" && c.length > 0; })) { return; }
            if (out.length >= MAX_SCRIPTS) { return; }
            out.push({ id: String(it.id || ("s" + out.length + "_" + Date.now())), name: it.name.substring(0, SCRIPT_NAME_MAX) || "Скрипт",
                codes: it.codes.slice(), created: String(it.created || "") });
        });
        return { open: d.open !== false, items: out };
    }

    var scripts = loadScripts();

    function storeScripts() {
        try { window.localStorage.setItem(SCRIPTS_KEY, JSON.stringify(scripts)); } catch (e) {}
    }

    function scriptById(id) {
        var i;
        for (i = 0; i < scripts.items.length; i++) { if (scripts.items[i].id === id) { return scripts.items[i]; } }
        return null;
    }

    function drawScripts() {
        var n = scripts.items.length;
        ui.scriptsCard.hidden = n === 0;
        ui.scriptsCount.textContent = n ? String(n) : "";
        ui.scriptsToggle.setAttribute("aria-expanded", scripts.open ? "true" : "false");
        ui.scriptsList.hidden = !scripts.open;
        ui.scriptsList.textContent = "";
        scripts.items.forEach(function (it) {
            var li = document.createElement("li");
            var run = document.createElement("button");
            var label = document.createElement("span");
            var ren = document.createElement("button");
            var del = document.createElement("button");
            li.setAttribute("data-id", it.id);
            run.className = "script-run";
            run.setAttribute("data-act", "run");
            run.title = "Запустить: " + it.name + (it.codes.length > 1 ? " (" + it.codes.length + " шага)" : "");
            run.innerHTML = '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.8v8.4L10 6z"/></svg>';
            label.textContent = it.name;
            run.appendChild(label);
            ren.className = "script-act";
            ren.setAttribute("data-act", "rename");
            ren.setAttribute("aria-label", "Переименовать «" + it.name + "»");
            ren.title = "Переименовать";
            ren.textContent = "✎";
            del.className = "script-act";
            del.setAttribute("data-act", "delete");
            del.setAttribute("aria-label", "Удалить «" + it.name + "»");
            del.title = "Удалить";
            del.textContent = "×";
            [run, ren, del].forEach(function (b) { b.disabled = busy; li.appendChild(b); });
            ui.scriptsList.appendChild(li);
        });
    }

    function onSaveScript() {
        if (busy || !lastRun) { return; }
        ui.saveRow.hidden = true;
        ui.saveForm.hidden = false;
        ui.saveName.value = lastRun.name;
        ui.saveName.focus();
        ui.saveName.select();
    }

    function confirmSaveScript() {
        var name = ui.saveName.value.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        if (busy || !lastRun) { return; }
        if (!name) { ui.saveName.focus(); return; }
        if (scripts.items.length >= MAX_SCRIPTS) {
            setStatus("В «Моих скриптах» уже " + MAX_SCRIPTS + " скриптов. Удалите ненужные, чтобы сохранить новый.", "error");
            return;
        }
        scripts.items.unshift({ id: "s" + Date.now().toString(36) + Math.floor(Math.random() * 1000), name: name.substring(0, SCRIPT_NAME_MAX),
            codes: lastRun.codes.slice(), created: new Date().toISOString() });
        scripts.open = true;
        lastRun.saved = true;
        storeScripts();
        drawScripts();
        showSaveRow();
        setStatus("Скрипт «" + name + "» сохранён в «Мои скрипты». Теперь он запускается одной кнопкой, без нейросети.", "done");
    }

    async function runSavedScript(it) {
        var all = it.codes.join("\n\n");
        var i, res, ok;
        if (busy) { return; }
        if (it.codes.some(needsConfirmation)) {
            ok = await modal({
                title: "Запустить «" + it.name + "»?",
                text: "Этот скрипт удаляет что-то или обращается к файлам, сети, рендеру или проекту целиком. Проверьте его перед запуском.",
                code: all,
                buttons: [{ label: "Не запускать", value: false }, { label: "Запустить", value: true, primary: true }]
            });
            if (!ok) { setStatus("Скрипт не запущен.", ""); return; }
        }
        setBusy(true);
        setStatus("Запускаю «" + it.name + "»…", "busy");
        for (i = 0; i < it.codes.length; i++) {
            try {
                res = await host("run", [it.codes[i], it.name + (it.codes.length > 1 ? " " + (i + 1) : ""), false, platform.tmpdir()]);
            } catch (e) {
                setBusy(false);
                setStatus(humanError(e), "error");
                return;
            }
            if (res.runError) {
                setBusy(false);
                setStatus("Ошибка в «" + it.name + "»" + (it.codes.length > 1 ? " (шаг " + (i + 1) + " из " + it.codes.length + ")" : "") + ": " + res.runError +
                    "\nСкрипт мог рассчитывать на другую композицию или слои. Если он успел что-то изменить, нажмите Cmd/Ctrl+Z.", "error");
                return;
            }
        }
        setBusy(false);
        setStatus("Готово: «" + it.name + "»." + (it.codes.length > 1 ? "\nОтменить: Cmd/Ctrl+Z, каждый шаг — отдельно." : "\nОтменить: Cmd/Ctrl+Z."), "done");
    }

    function renameScript(li, it) {
        var input = document.createElement("input");
        var run = li.querySelector(".script-run");
        var done = false;
        function finish(save) {
            var name;
            if (done) { return; }
            done = true;
            name = input.value.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
            if (save && name) { it.name = name.substring(0, SCRIPT_NAME_MAX); storeScripts(); }
            drawScripts();
        }
        input.className = "field script-rename";
        input.maxLength = SCRIPT_NAME_MAX;
        input.value = it.name;
        input.setAttribute("aria-label", "Новое название");
        li.replaceChild(input, run);
        input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            if (e.key === "Escape") { e.preventDefault(); finish(false); }
        });
        input.addEventListener("blur", function () { finish(true); });
        input.focus();
        input.select();
    }

    async function deleteScript(it) {
        var ok = await modal({
            title: "Удалить «" + it.name + "»?",
            text: "Скрипт пропадёт из «Моих скриптов». Вернуть его будет нельзя.",
            buttons: [{ label: "Отмена", value: false }, { label: "Удалить", value: true, primary: true }]
        });
        if (!ok) { return; }
        scripts.items = scripts.items.filter(function (x) { return x !== it; });
        storeScripts();
        drawScripts();
        setStatus("Скрипт «" + it.name + "» удалён.", "");
    }

    function enableScripts() {
        drawScripts();
        showSaveRow();
        ui.saveScriptBtn.addEventListener("click", onSaveScript);
        ui.saveConfirm.addEventListener("click", confirmSaveScript);
        ui.saveCancel.addEventListener("click", function () { showSaveRow(); });
        ui.saveName.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); confirmSaveScript(); }
            if (e.key === "Escape") { e.preventDefault(); showSaveRow(); }
        });
        ui.scriptsToggle.addEventListener("click", function () {
            scripts.open = !scripts.open;
            storeScripts();
            drawScripts();
        });
        ui.scriptsList.addEventListener("click", function (e) {
            var btn = e.target.closest ? e.target.closest("button") : null;
            var li = btn ? btn.closest("li") : null;
            var it = li ? scriptById(li.getAttribute("data-id")) : null;
            if (!btn || !it || btn.disabled) { return; }
            if (btn.getAttribute("data-act") === "run") { runSavedScript(it); }
            else if (btn.getAttribute("data-act") === "rename") { renameScript(li, it); }
            else if (btn.getAttribute("data-act") === "delete") { deleteScript(it); }
        });
    }

    // --------------------------------------------------------- expressions
    // Нейросеть пишет выражения для выделенных свойств или чинит выражения с ошибкой. Ответ — JSON,
    // панель ставит выражения сама и, если After Effects сообщает об ошибке, просит поправить.

    var EXPR_SYSTEM = [
        "You write Adobe After Effects expressions for a panel inside After Effects.",
        "Either the user selected properties and says what they should do, or the panel sends expressions that give errors and asks you to fix them.",
        "",
        "Reply with ONE json code block and nothing outside it:",
        "```json",
        "{\"note\": \"one short sentence in the user's language\", \"expressions\": [{\"id\": 1, \"expression\": \"...\"}]}",
        "```",
        "",
        "Rules:",
        "- Give an expression for every listed property, by its id. If a property cannot sensibly do what is asked, leave it out and say why in \"note\".",
        "- Write for the JavaScript expression engine of After Effects. Use the expression language only (value, time, thisComp, thisLayer, thisProperty, wiggle(), loopOut(), loopIn(), linear(), ease(), valueAtTime(), key(), numKeys, nearestKey(), effect(\"...\")(\"...\"), comp(\"...\").layer(\"...\"), etc.). Never use ExtendScript (app., CompItem, $.).",
        "- The result must have the same dimension as the property's value: a number, a 2D or 3D array, or a color [r, g, b, a] from 0 to 1.",
        "- Build on the current value or animation when it makes sense (value + ..., wiggle() on top of value, loopOut() for existing keyframes).",
        "- Keep it short and readable. Put the numbers a user may want to change in named variables at the top (var freq = 2;).",
        "- When fixing, keep what the expression was meant to do and change as little as possible."
    ].join("\n");

    function exprPropText(p, i, withError) {
        var t = (i + 1) + ". Layer " + p.layer + ' "' + p.layerName + '" > ' + p.trail + " (matchName " + p.matchName + ")" +
            (p.value !== null ? ", value " + p.value : "") + ", keyframes: " + p.keys;
        if (p.expression) {
            t += "\n   current expression:\n" + p.expression.replace(/^/gm, "      ");
        } else {
            t += ", no expression yet";
        }
        if (withError && p.error) { t += "\n   error: " + p.error; }
        return t;
    }

    // Достаёт из ответа JSON с выражениями. Возвращает { note, list: [{ id, expression }] } или null.
    function parseExprReply(text) {
        var m = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/.exec(text);
        var raw = m ? m[1] : text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1);
        var data, list = [];
        try { data = JSON.parse(raw); } catch (e) { return null; }
        if (!data || !(data.expressions instanceof Array)) { return null; }
        data.expressions.forEach(function (x) {
            if (x && typeof x.expression === "string" && x.expression.replace(/\s/g, "") && Math.floor(Number(x.id)) === Number(x.id)) {
                list.push({ id: Number(x.id), expression: x.expression });
            }
        });
        return { note: typeof data.note === "string" ? data.note : "", list: list };
    }

    function showExprReply(note, done) {
        ui.replyCard.hidden = false;
        ui.replyText.hidden = !note;
        ui.replyText.textContent = note || "";
        ui.codeBox.hidden = done.length === 0;
        ui.replyCode.textContent = done.map(function (d) { return "// " + d.trail + "\n" + d.expression; }).join("\n\n");
        lastRun = null;
        showSaveRow();
    }

    // Общий ход: спросить нейросеть, поставить выражения, при ошибках попросить поправить.
    // props — свойства из After Effects (с адресами), firstMessage — первый вопрос.
    async function runExpressions(props, firstMessage, verb) {
        var messages = [{ role: "user", content: firstMessage }];
        var pending = props.map(function (p, i) { return i; });   // какие свойства ещё без рабочего выражения
        var done = [];
        var failed = {};
        var note = "";
        var round = 0;
        var reply, parsed, items, map, res, errors, steps = 0;

        while (true) {
            setStatus(round === 0 ? "Жду выражение от " + aiName() + "…" : "After Effects не принял выражение, прошу " + aiName() + " поправить (попытка " + (round + 1) + ")…", "busy");
            reply = await callAI(messages, EXPR_MAX_TOKENS, EXPR_SYSTEM);
            if (!reply.ok) { return finishExpr(done, failed, props, note, steps, reply.error); }
            messages.push({ role: "assistant", content: reply.text });
            parsed = parseExprReply(reply.text);
            if (!parsed) { return finishExpr(done, failed, props, note, steps, aiName() + " ответил не в том виде: выражение не найдено."); }
            if (parsed.note) { note = parsed.note; }
            items = [];
            map = [];
            parsed.list.forEach(function (x) {
                var i = x.id - 1;
                if (pending.indexOf(i) < 0) { return; }
                items.push({ layer: props[i].layer, path: props[i].path, expression: x.expression });
                map.push(i);
            });
            if (!items.length) { return finishExpr(done, failed, props, note, steps, null); }
            try {
                res = await host("exprApply", [items]);
            } catch (e) {
                return finishExpr(done, failed, props, note, steps, humanError(e));
            }
            steps++;
            errors = [];
            res.results.forEach(function (r, k) {
                var i = map[k];
                if (r.ok) {
                    done.push({ trail: r.trail || props[i].trail, expression: items[k].expression });
                    delete failed[i];
                    pending.splice(pending.indexOf(i), 1);
                } else {
                    failed[i] = r.error;
                    errors.push("id " + (i + 1) + ": " + r.error);
                }
            });
            if (!errors.length || round >= EXPR_RETRIES) { return finishExpr(done, failed, props, note, steps, null); }
            round++;
            messages.push({ role: "user", content: "After Effects reported errors for these expressions:\n" + errors.join("\n") +
                "\nReturn corrected expressions for these ids in the same JSON format." });
        }
    }

    function finishExpr(done, failed, props, note, steps, error) {
        var bad = Object.keys(failed);
        var text;
        showExprReply(note, done);
        setBusy(false);
        if (error && !done.length) { setStatus(error, "error"); return; }
        if (!done.length && !bad.length) { setStatus(note || aiName() + " не предложил выражений.", ""); return; }
        text = done.length ? "Выражение стоит: " + done.map(function (d) { return d.trail; }).join(", ") + "." : "";
        if (bad.length) {
            text += (text ? "\n" : "") + "Не получилось для: " + bad.map(function (i) { return props[i].trail + " (" + failed[i] + ")"; }).join("; ") + ".";
        }
        if (note) { text += "\n" + note; }
        if (error) { text += "\n" + error; }
        if (steps) { text += steps > 1 ? "\nОтменить: Cmd/Ctrl+Z, каждая попытка — отдельный шаг." : "\nОтменить: Cmd/Ctrl+Z."; }
        setStatus(text, bad.length && !done.length ? "error" : "done");
    }

    function exprReady() {
        if (busy) { return false; }
        if (!aiKey()) {
            setStatus("Нужен " + providerOf().keyLabel.replace(/^Ключ/, "ключ") + ". Вставьте его в настройках.", "error");
            openSettings();
            return false;
        }
        return true;
    }

    async function onExprApply() {
        var wish = ui.exprWish.value.replace(/^\s+|\s+$/g, "");
        var t;
        if (!exprReady()) { return; }
        if (!wish) { setStatus("Напишите, что должно делать выделенное свойство, например: «пусть качается».", ""); ui.exprWish.focus(); return; }
        setBusy(true);
        setStatus("Смотрю, что выделено…", "busy");
        try {
            t = await host("exprTargets", []);
        } catch (e) {
            setBusy(false);
            setStatus(humanError(e), /^Откройте композицию/.test(humanError(e)) ? "" : "error");
            return;
        }
        if (!t.props.length) {
            setBusy(false);
            setStatus("Выделите свойство на таймлайне (например, Position или Opacity) и нажмите ещё раз.", "");
            return;
        }
        await runExpressions(t.props, "[Request]\n" + wish + '\n\n[Properties] (composition "' + t.compName + '")\n' +
            t.props.map(function (p, i) { return exprPropText(p, i, false); }).join("\n"), "put");
    }

    async function onExprFix() {
        var t;
        if (!exprReady()) { return; }
        setBusy(true);
        setStatus("Ищу выражения с ошибкой…", "busy");
        try {
            t = await host("exprBroken", []);
        } catch (e) {
            setBusy(false);
            setStatus(humanError(e), /^Откройте композицию/.test(humanError(e)) ? "" : "error");
            return;
        }
        if (!t.props.length) {
            setBusy(false);
            setStatus("В открытой композиции «" + t.compName + "» нет выражений с ошибкой.", "done");
            return;
        }
        await runExpressions(t.props, "[Request]\nThese expressions give errors in After Effects. Fix each one." +
            (ui.exprWish.value.replace(/\s/g, "") ? "\nThe user adds: " + ui.exprWish.value.replace(/^\s+|\s+$/g, "") : "") +
            '\n\n[Properties] (composition "' + t.compName + '")\n' + t.props.map(function (p, i) { return exprPropText(p, i, true); }).join("\n"), "fix");
    }

    function enableExpressions() {
        var open = true;
        try { open = window.localStorage.getItem(EXPR_OPEN_KEY) !== "0"; } catch (e) {}
        function draw() {
            ui.exprToggle.setAttribute("aria-expanded", open ? "true" : "false");
            ui.exprBody.hidden = !open;
        }
        draw();
        ui.exprToggle.addEventListener("click", function () {
            open = !open;
            try { window.localStorage.setItem(EXPR_OPEN_KEY, open ? "1" : "0"); } catch (e) {}
            draw();
        });
        ui.exprApplyBtn.addEventListener("click", onExprApply);
        ui.exprFixBtn.addEventListener("click", onExprFix);
        ui.exprWish.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onExprApply(); }
        });
    }

    // --------------------------------------------------------- quick tasks
    // Кнопки с частыми просьбами. Нажатие кладёт текст задачи в поле запроса: его можно поправить
    // (имя в подписи, длительность) и нажать «Выполнить». Свои задачи сохраняются кнопкой «+».

    function defaultQuick() {
        return QUICK_DEFAULTS.map(function (q) { return { id: q.id, name: q.name, text: q.text }; });
    }

    function loadQuick() {
        var d, out = [];
        try { d = JSON.parse(window.localStorage.getItem(QUICK_KEY) || "null"); } catch (e) { d = null; }
        if (!d || typeof d !== "object" || !(d.items instanceof Array)) { return { open: !(d && d.open === false), items: defaultQuick() }; }
        d.items.forEach(function (q) {
            if (!q || typeof q.name !== "string" || typeof q.text !== "string" || !q.name || !q.text || out.length >= MAX_QUICK) { return; }
            out.push({ id: String(q.id || ("q" + out.length + "_" + Date.now())), name: q.name.substring(0, 40), text: q.text });
        });
        return { open: d.open !== false, items: out };
    }

    var quick = loadQuick();
    var quickEditing = false;
    var quickFormFor = null;   // id задачи, которую правят; "" — новая

    function storeQuick() {
        try { window.localStorage.setItem(QUICK_KEY, JSON.stringify(quick)); } catch (e) {}
    }

    function quickById(id) {
        var i;
        for (i = 0; i < quick.items.length; i++) { if (quick.items[i].id === id) { return quick.items[i]; } }
        return null;
    }

    function missingDefaults() {
        return QUICK_DEFAULTS.filter(function (q) { return !quickById(q.id); });
    }

    function drawQuick() {
        var reset;
        ui.quickToggle.setAttribute("aria-expanded", quick.open ? "true" : "false");
        ui.quickList.hidden = !quick.open;
        ui.quickEdit.setAttribute("aria-pressed", quickEditing ? "true" : "false");
        ui.quickBox.className = "quick" + (quickEditing ? " editing" : "");
        ui.quickList.textContent = "";
        quick.items.forEach(function (q) {
            var b = document.createElement("button");
            var label = document.createElement("span");
            var del;
            b.className = "quick-chip";
            b.setAttribute("data-id", q.id);
            b.title = quickEditing ? "Изменить «" + q.name + "»" : q.text;
            label.textContent = q.name;
            b.appendChild(label);
            if (quickEditing) {
                del = document.createElement("span");
                del.className = "quick-del";
                del.setAttribute("data-act", "delete");
                del.setAttribute("aria-label", "Удалить «" + q.name + "»");
                del.title = "Удалить";
                del.textContent = "×";
                b.appendChild(del);
            }
            b.disabled = busy;
            ui.quickList.appendChild(b);
        });
        if (quickEditing && missingDefaults().length) {
            reset = document.createElement("button");
            reset.className = "quick-link";
            reset.setAttribute("data-act", "reset");
            reset.textContent = "Вернуть стандартные";
            reset.disabled = busy;
            ui.quickList.appendChild(reset);
        }
    }

    function openQuickForm(q) {
        var text = ui.prompt.value.replace(/^\s+|\s+$/g, "");
        quickFormFor = q ? q.id : "";
        ui.quickName.value = q ? q.name : (text ? text.replace(/\s+/g, " ").substring(0, 30) : "");
        ui.quickText.value = q ? q.text : text;
        ui.quickForm.hidden = false;
        quick.open = true;
        drawQuick();
        (ui.quickName.value ? ui.quickText : ui.quickName).focus();
    }

    function closeQuickForm() {
        quickFormFor = null;
        ui.quickForm.hidden = true;
    }

    function saveQuickForm() {
        var name = ui.quickName.value.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").substring(0, 40);
        var text = ui.quickText.value.replace(/^\s+|\s+$/g, "");
        var q;
        if (!name) { ui.quickName.focus(); return; }
        if (!text) { ui.quickText.focus(); return; }
        if (quickFormFor) {
            q = quickById(quickFormFor);
            if (q) { q.name = name; q.text = text; }
        } else {
            if (quick.items.length >= MAX_QUICK) {
                setStatus("Быстрых задач уже " + MAX_QUICK + ". Удалите ненужные, чтобы добавить новую.", "error");
                return;
            }
            quick.items.push({ id: "q" + Date.now().toString(36) + Math.floor(Math.random() * 1000), name: name, text: text });
        }
        storeQuick();
        closeQuickForm();
        drawQuick();
        setStatus("Быстрая задача «" + name + "» сохранена.", "done");
    }

    async function deleteQuick(q) {
        var ok = await modal({
            title: "Удалить задачу «" + q.name + "»?",
            text: QUICK_DEFAULTS.some(function (d) { return d.id === q.id; }) ?
                "Стандартную задачу можно будет вернуть: «✎» → «Вернуть стандартные»." : "Свою задачу вернуть будет нельзя.",
            buttons: [{ label: "Отмена", value: false }, { label: "Удалить", value: true, primary: true }]
        });
        if (!ok) { return; }
        quick.items = quick.items.filter(function (x) { return x !== q; });
        if (quickFormFor === q.id) { closeQuickForm(); }
        storeQuick();
        drawQuick();
    }

    function useQuick(q) {
        ui.prompt.value = q.text;
        ui.prompt.focus();
        try { ui.prompt.setSelectionRange(q.text.length, q.text.length); } catch (e) {}
        setStatus("Задача «" + q.name + "» в поле запроса. Поправьте, если нужно, и нажмите «Выполнить».", "");
    }

    function enableQuick() {
        drawQuick();
        ui.quickToggle.addEventListener("click", function () {
            quick.open = !quick.open;
            if (!quick.open) { closeQuickForm(); }
            storeQuick();
            drawQuick();
        });
        ui.quickAdd.addEventListener("click", function () { if (!busy) { openQuickForm(null); } });
        ui.quickEdit.addEventListener("click", function () {
            quickEditing = !quickEditing;
            if (quickEditing) { quick.open = true; } else { closeQuickForm(); }
            drawQuick();
        });
        ui.quickSave.addEventListener("click", saveQuickForm);
        ui.quickCancel.addEventListener("click", closeQuickForm);
        [ui.quickName, ui.quickText].forEach(function (f) {
            f.addEventListener("keydown", function (e) {
                if (e.key === "Escape") { e.preventDefault(); closeQuickForm(); }
                if (e.key === "Enter" && (f === ui.quickName || e.metaKey || e.ctrlKey)) { e.preventDefault(); saveQuickForm(); }
            });
        });
        ui.quickList.addEventListener("click", function (e) {
            var t = e.target;
            var act = t.getAttribute ? t.getAttribute("data-act") : null;
            var chip = t.closest ? t.closest(".quick-chip") : null;
            var q = chip ? quickById(chip.getAttribute("data-id")) : null;
            if (busy) { return; }
            if (act === "reset") {
                missingDefaults().forEach(function (d) { quick.items.push({ id: d.id, name: d.name, text: d.text }); });
                storeQuick();
                drawQuick();
                return;
            }
            if (!q) { return; }
            if (act === "delete") { deleteQuick(q); return; }
            if (quickEditing) { openQuickForm(q); return; }
            useQuick(q);
        });
    }

    // ----------------------------------------------------------- reference

    // Снимает кадры с файла и делает его референсом. name — как его показать, note — добавка к сообщению.
    async function useReference(path, name, note) {
        var info = await host("info", []);
        var res, frames;
        if (!info.fileAccess) { throw new Error(FILE_ACCESS_HINT); }
        res = await host("reference", [path, settings.refFrames, platform.tmpdir()]);
        frames = await loadFrames(res.ref.frames);
        pendingRef = {
            name: name || res.ref.name, isStill: res.ref.isStill, duration: res.ref.duration,
            width: res.ref.width, height: res.ref.height, frames: frames
        };
        refSentNote = false;
        setBusy(false);
        setStatus((pendingRef.isStill ?
            "Картинка прикреплена. Напишите, что с ней сделать, и нажмите «Выполнить»." :
            "Видео прикреплено: " + frames.length + " кадров. " + aiName() + " увидит их по порядку, само движение опишите словами.") +
            (note ? "\n" + note : ""), "done");
    }

    async function onAttachReference() {
        var path;
        if (busy) { return; }
        path = await platform.pickFile("Выберите видео или картинку-референс");
        if (!path) { return; }
        setBusy(true);
        setStatus("Снимаю кадры с референса…", "busy");
        try {
            await useReference(path, null, "");
        } catch (e) {
            setBusy(false);
            setStatus("Не удалось подготовить референс: " + humanError(e), "error");
        }
        showRef();
    }

    // ---- референс по ссылке: прямая ссылка на картинку или видео либо страница, где они есть

    function decodeEntities(t) {
        return String(t).replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
            .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); })
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }

    function tagAttrs(tag) {
        var out = {};
        var re = /([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
        var m;
        while ((m = re.exec(tag)) !== null) {
            out[m[1].toLowerCase()] = decodeEntities(m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5]);
        }
        return out;
    }

    function absoluteUrl(u, base) {
        var r;
        try { r = new URL(u, base); } catch (e) { return null; }
        return r.protocol === "https:" || r.protocol === "http:" ? r.toString() : null;
    }

    function isVideoUrl(u) {
        try { return /\.(mp4|mov|m4v|webm)$/i.test(new URL(u).pathname); } catch (e) { return false; }
    }

    // Что есть на странице: видео (только прямой файл), главная картинка и заголовок.
    // Берётся то, что сайт сам показывает при публикации ссылки (og:video, og:image и т. п.).
    function pageMedia(html, base) {
        var metas = {};
        var found = { video: null, image: null, title: "" };
        var re = /<(meta|link|video|source)\b[^>]*>/gi;
        var m, a, key, i, u, t;
        function first(keys, test) {
            var j, k, v;
            for (j = 0; j < keys.length; j++) {
                k = metas[keys[j]];
                if (!k) { continue; }
                v = absoluteUrl(k, base);
                if (v && (!test || test(v))) { return v; }
            }
            return null;
        }
        while ((m = re.exec(html)) !== null) {
            a = tagAttrs(m[0]);
            t = m[1].toLowerCase();
            if (t === "meta") {
                key = String(a.property || a.name || a.itemprop || "").toLowerCase();
                if (key && a.content && !metas.hasOwnProperty(key)) { metas[key] = a.content; }
            } else if (t === "link" && /(^|\s)image_src(\s|$)/i.test(a.rel || "") && a.href && !metas.hasOwnProperty("link:image_src")) {
                metas["link:image_src"] = a.href;
            } else if ((t === "video" || t === "source") && a.src && !found.video) {
                u = absoluteUrl(a.src, base);
                if (u && (isVideoUrl(u) || /^video\/(mp4|quicktime|webm)/.test(a.type || ""))) { found.video = u; }
            }
        }
        if (!found.video) {
            i = /^video\/(mp4|quicktime|webm|x-m4v)/.test(String(metas["og:video:type"] || ""));
            found.video = first(["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"], function (v) { return i || isVideoUrl(v); });
        }
        found.image = first(["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src", "link:image_src"], null);
        m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
        found.title = decodeEntities(metas["og:title"] || (m ? m[1] : "")).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        return found;
    }

    function isYouTube(u) {
        try { return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(u).hostname); } catch (e) { return false; }
    }

    // Как ссылку показать: имя файла из адреса, иначе заголовок страницы, иначе сайт.
    function linkName(mediaUrl, title, pageUrl) {
        var u, last;
        try { u = new URL(mediaUrl); } catch (e) { u = null; }
        if (u) {
            last = u.pathname.replace(/\/+$/, "").replace(/^.*\//, "");
            try { last = decodeURIComponent(last); } catch (e2) {}
            if (MEDIA_EXT.test(last) && last.length <= 80) { return last; }
        }
        if (title) { return title.length > 60 ? title.substring(0, 60) + "…" : title; }
        try { return new URL(pageUrl || mediaUrl).hostname.replace(/^www\./, ""); } catch (e3) { return "ссылка"; }
    }

    function normalizeLink(text) {
        var t = String(text || "").replace(/^\s+|\s+$/g, "");
        if (!t) { return null; }
        if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) { t = "https://" + t; }
        return absoluteUrl(t, undefined) && /^https?:\/\/[^\s\/]+\.[^\s\/]+/i.test(t) ? absoluteUrl(t, undefined) : null;
    }

    async function onAttachLink() {
        var url = normalizeLink(ui.refLink.value);
        var base, r, found, target, note, name, title, path;
        if (busy) { return; }
        if (!url) {
            setStatus("Вставьте ссылку на картинку, видео или страницу с ними (начинается с https://).", "");
            ui.refLink.focus();
            return;
        }
        setBusy(true);
        setStatus("Скачиваю по ссылке…", "busy");
        base = platform.join(platform.tmpdir(), "sayframe_link_" + Date.now());
        note = "";
        title = "";
        try {
            r = await platform.fetchUrl(url, base);
            if (r.status !== 200) { throw new Error("LINK_HTTP:" + r.status); }
            target = url;
            if (r.text !== undefined) {
                found = pageMedia(r.text, r.finalUrl || url);
                title = found.title;
                if (isYouTube(r.finalUrl || url)) {
                    target = found.image;
                    note = "С YouTube панель берёт только обложку ролика. Чтобы показать само движение, скачайте или запишите видео и прикрепите файл.";
                } else {
                    target = found.video || found.image;
                }
                if (!target) { throw new Error("LINK_NO_MEDIA"); }
                setStatus("Скачиваю " + (target === found.video ? "видео" : "картинку") + " со страницы…", "busy");
                r = await platform.fetchUrl(target, base);
                if (r.status !== 200) { throw new Error("LINK_HTTP:" + r.status); }
            }
            if (!r.path) { throw new Error("LINK_NOT_MEDIA"); }
            path = r.path;
            setStatus("Снимаю кадры с референса…", "busy");
            name = linkName(r.finalUrl || target, title, url);
            await useReference(path, name, note);
            ui.refLink.value = "";
            ui.refLinkRow.hidden = true;
        } catch (e) {
            setBusy(false);
            setStatus("Не удалось взять референс по ссылке: " + (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|^TIMEOUT$/.test(String(e && e.message)) ?
                "нет связи с сайтом. Проверьте ссылку и интернет." : humanError(e)), "error");
        } finally {
            if (path) { platform.remove(path); }
        }
        showRef();
    }

    function showLinkRow(on) {
        ui.refLinkRow.hidden = !on;
        if (on) { ui.refLink.focus(); }
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

    var CLIPBOARD_RETRY_MS = [350, 700];  // паузы перед повторным чтением буфера, если картинки в нём не нашлось

    function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    // Достаёт картинку из системного буфера обмена.
    // Сразу после копирования система иногда ещё не отдаёт картинку — первое чтение говорит «пусто»,
    // а следующее уже находит её. Поэтому «пусто» перепроверяем пару раз, прежде чем поверить.
    async function grabClipboard() {
        var got = await readClipboardOnce();
        var i;
        for (i = 0; i < CLIPBOARD_RETRY_MS.length && got.kind === "none"; i++) {
            await sleep(CLIPBOARD_RETRY_MS[i]);
            got = await readClipboardOnce();
        }
        return got;
    }

    // Одно чтение буфера.
    // { kind: "png", path } — временный PNG; { kind: "file", path } — скопированный файл; { kind: "none" }.
    async function readClipboardOnce() {
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
        var files = e.clipboardData ? e.clipboardData.files : null;
        var file = null;
        var inField = e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT");
        var text = "";
        var i;
        if (!ui.sheet.hidden || !ui.modal.hidden) { return; }
        if (items) {
            for (i = 0; i < items.length; i++) {
                if (items[i].kind === "file" && /^image\//.test(items[i].type)) { file = items[i].getAsFile(); break; }
            }
        }
        if (!file && files) {
            for (i = 0; i < files.length; i++) {
                if (/^image\//.test(files[i].type)) { file = files[i]; break; }
            }
        }
        // Курсор стоит в поле ввода (например, в задаче для Claude), а текста в буфере нет:
        // значит, вставляют не текст. Раньше такое нажатие Cmd+V просто пропадало.
        if (inField && !file) {
            try { text = e.clipboardData ? String(e.clipboardData.getData("text/plain") || "") : ""; } catch (err) { text = "x"; }
            if (text === "") { inField = false; }
        }
        // Во вкладке AI картинка из буфера становится референсом, а не слоем в композиции.
        var handle = ui.viewClaude.hidden ? pasteImage : pasteAsReference;
        if (file) {
            e.preventDefault();
            if (busy) { return; }
            blobToPng(file).then(function (bytes) {
                var png = platform.join(platform.tmpdir(), "sayframe_clip_" + new Date().getTime() + ".png");
                return platform.writeBytes(png, bytes).then(function () {
                    return handle({ kind: "png", path: png });
                });
            }).catch(function () {
                // Не получилось взять картинку из события — читаем системный буфер обычным путём.
                handle(null);
            });
        } else if (!inField) {
            e.preventDefault();
            handle(null);
        }
    }

    // Cmd/Ctrl+V во вкладке AI: снимок экрана или скопированная картинка — референс для задачи.
    async function pasteAsReference(grabbed) {
        var temp = null;
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
            if (grabbed.kind === "png") { temp = grabbed.path; }
            else if (!(await platform.exists(grabbed.path))) { throw new Error("Скопированный файл не найден: " + grabbed.path); }
            setStatus("Снимаю кадры с референса…", "busy");
            await useReference(grabbed.path, grabbed.kind === "png" ? "Снимок из буфера" : platform.basename(grabbed.path), "");
        } catch (e) {
            setBusy(false);
            setStatus("Не удалось взять референс из буфера: " + humanError(e), "error");
        } finally {
            if (temp) { try { await platform.remove(temp); } catch (e2) {} }
        }
        showRef();
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

    // Модели и ключ в настройках — той нейросети, что выбрана сверху. Ключи у Claude и ChatGPT свои,
    // при переключении набранный ключ не теряется.
    function showProvider() {
        var p = providerOf(draft);
        ui.models.textContent = "";
        p.models.forEach(function (m) {
            var b = document.createElement("button");
            var name = document.createElement("b");
            var note = document.createElement("small");
            b.className = "model";
            b.setAttribute("data-value", m.id);
            name.textContent = m.name;
            note.textContent = m.note;
            b.appendChild(name);
            b.appendChild(note);
            b.addEventListener("click", function () { draft[p.modelField] = m.id; pressGroup(ui.models, m.id); });
            ui.models.appendChild(b);
        });
        pressGroup(ui.models, draft[p.modelField]);
        pressGroup(ui.provider, draft.provider);
        ui.apiKeyLabel.textContent = p.keyLabel;
        ui.apiKey.placeholder = p.placeholder;
        ui.apiKey.value = draft[p.keyField] || "";
        ui.keyHint.textContent = p.hint;
        ui.keyHint.className = "hint";
    }

    function keepTypedKey() {
        if (draft) { draft[providerOf(draft).keyField] = ui.apiKey.value.replace(/\s/g, ""); }
    }

    function buildSettings() {
        ui.provider.addEventListener("click", function (e) {
            var v = e.target && e.target.getAttribute ? e.target.getAttribute("data-value") : null;
            if (!draft || !PROVIDERS.hasOwnProperty(v) || v === draft.provider) { return; }
            keepTypedKey();
            draft.provider = v;
            showProvider();
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

        // Размер блоков тоже виден сразу и тоже возвращается, если настройки закрыть без сохранения.
        ui.toolSize.addEventListener("click", function (e) {
            var v = e.target && e.target.getAttribute ? e.target.getAttribute("data-value") : null;
            if (!draft || (v !== "large" && v !== "small")) { return; }
            draft.toolSize = v;
            pressGroup(ui.toolSize, v);
            applyTheme(draft);
        });

        ui.toolTitles.addEventListener("change", function () {
            if (!draft) { return; }
            draft.toolTitles = ui.toolTitles.checked;
            applyTheme(draft);
        });

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

    // Настройки разбиты на два раздела: всё про нейросеть (AI) и остальное («Общие»).
    var setPane = "ai";

    function showSetPane(name) {
        setPane = name === "other" ? "other" : "ai";
        ui.setPaneAI.hidden = setPane !== "ai";
        ui.setPaneOther.hidden = setPane !== "other";
        ui.setTabAI.setAttribute("aria-selected", String(setPane === "ai"));
        ui.setTabAI.setAttribute("aria-pressed", String(setPane === "ai"));
        ui.setTabOther.setAttribute("aria-selected", String(setPane === "other"));
        ui.setTabOther.setAttribute("aria-pressed", String(setPane === "other"));
        if (setPane !== "other") { stopHotkeyEdit(); }
    }

    function openSettings() {
        var k;
        if (busy) { return; }
        draft = {};
        for (k in settings) { if (settings.hasOwnProperty(k)) { draft[k] = settings[k]; } }
        ui.accentHex.value = draft.accent;
        ui.bgHex.value = draft.bg;
        ui.selfCheck.checked = draft.selfCheck;
        ui.alwaysAsk.checked = draft.alwaysAsk;
        ui.panelWidth.value = String(draft.panelWidth);
        ui.panelWidthVal.textContent = draft.panelWidth + " px";
        showProvider();
        pressGroup(ui.accentSwatches, draft.accent);
        pressGroup(ui.bgSwatches, draft.bg);
        pressGroup(ui.frames, draft.refFrames);
        pressGroup(ui.toolSize, draft.toolSize);
        ui.toolTitles.checked = draft.toolTitles;
        closeFxConsole();
        hotkeyEdit = null;
        ui.hotkeyNote.textContent = "";
        renderHotkeys();
        showSetPane("ai");
        ui.sheet.hidden = false;
        ui.sheet.scrollTop = 0;
    }

    function closeSettings(save) {
        if (save && draft) {
            keepTypedKey();
            draft.selfCheck = ui.selfCheck.checked;
            draft.alwaysAsk = ui.alwaysAsk.checked;
            draft.toolTitles = ui.toolTitles.checked;
            settings = draft;
            storeSettings(settings);
            registerHotkeys();
            hotkeyHint();
            setStatus(aiKey() ? "Настройки сохранены." : "Ключ API не задан.", aiKey() ? "done" : "");
        }
        draft = null;
        stopHotkeyEdit();
        applyTheme(settings);
        ui.sheet.hidden = true;
    }

    // Проверяет ключ самым коротким запросом из возможных — у той нейросети, что выбрана в настройках.
    function onTestKey() {
        var saved = settings;
        var key = ui.apiKey.value.replace(/\s/g, "");
        var trial = {};
        var k;
        if (!key) {
            ui.keyHint.textContent = "Сначала вставьте ключ.";
            ui.keyHint.className = "hint bad";
            return;
        }
        for (k in draft) { if (draft.hasOwnProperty(k)) { trial[k] = draft[k]; } }
        trial[providerOf(trial).keyField] = key;
        ui.testKey.disabled = true;
        ui.keyHint.textContent = "Проверяю…";
        ui.keyHint.className = "hint";
        settings = trial;
        callAI([{ role: "user", content: "ping" }], 1).then(function (r) {
            settings = saved;
            ui.testKey.disabled = false;
            ui.keyHint.textContent = r.ok ? "Ключ работает." : r.error;
            ui.keyHint.className = "hint " + (r.ok ? "ok" : "bad");
        });
    }

    // ------------------------------------------------------------ анимация
    // Плавность ключей. Ползунки расходятся от кнопки, как ручки ключа в редакторе графиков:
    // левый — входящая сторона ключа (in, как движение останавливается перед ключом),
    // правый — исходящая (out, как оно начинается после ключа). Длина ползунка — влияние в процентах.

    var MOTION_DEFAULTS = { easeIn: 60, easeOut: 60, link: true, curve: true, anchorKeys: "key", alignTo: "comp", order: "ease,anchor,align,shift,paste,organize", sizes: "", places: "", pins: "", pasteOpts: true, organizeOpts: true, anchorOpts: true, alignOpts: true,
        shiftWhat: "in", shiftStep: 1, timeAlign: "inStart", staggerWhat: "layer", staggerStep: 1, staggerOrder: "asc", shiftOpts: true };
    var SHIFT_TARGETS = ["in", "out", "layer"];
    var TIME_POINTS = ["inStart", "inEnd", "outStart", "outEnd"];
    var STAGGER_ORDERS = ["asc", "desc", "selection", "random"];
    var MAX_STEP_FRAMES = 999;
    var TOOL_NAMES = ["ease", "anchor", "align", "shift", "paste", "organize"];

    // ---- сетка раздела «Инструменты»: блоки стоят по клеткам, двигаются и растягиваются по ним.
    // Клетка квадратная: у крупных блоков 36 px и 8 px между клетками, у мелких 22 и 6 (кратно 2 и 4,
    // как советуют сетки iOS и Android). Ширина и высота блока — в клетках.
    var GRID_LARGE = { cell: 36, gap: 8 };
    var GRID_SMALL = { cell: 22, gap: 6 };
    var TOOL_MIN_COLS = 4;        // уже блок не делается: в него перестают помещаться три кнопки в ряд
    var TOOL_DEFAULT_COLS = 4;
    var TOOL_FULL = 99;           // «на всю ширину»: столько клеток, сколько есть в панели
    var TOOL_MAX_ROWS = 40;

    function gridModule() {
        return document.documentElement.getAttribute("data-tools") === "small" ? GRID_SMALL : GRID_LARGE;
    }

    // Размеры блоков: "ease=6x0;anchor=99x9" — ширина и высота в клетках. Высота 0 — по содержимому,
    // ширина 99 — на всю панель. Старые записи в пикселях ("anchor=320", "ease=full") переводятся в клетки.
    function parseSizes(text) {
        var out = {};
        var parts = String(text).split(";");
        var i, pair, m, w, h;
        for (i = 0; i < parts.length; i++) {
            pair = parts[i].split("=");
            if (pair.length !== 2 || TOOL_NAMES.indexOf(pair[0]) < 0) { continue; }
            m = /^(\d{1,2})x(\d{1,2})$/.exec(pair[1]);
            if (m) {
                w = Number(m[1]);
                h = Number(m[2]);
            } else if (pair[1] === "full") {
                w = TOOL_FULL;
                h = 0;
            } else if (/^\d{1,4}$/.test(pair[1]) && Number(pair[1]) >= 100) {
                w = Math.round((Number(pair[1]) + GRID_LARGE.gap) / (GRID_LARGE.cell + GRID_LARGE.gap));
                h = 0;
            } else {
                continue;
            }
            if (w < TOOL_MIN_COLS) { w = TOOL_MIN_COLS; }
            if (w > TOOL_FULL) { w = TOOL_FULL; }
            if (h > TOOL_MAX_ROWS) { h = TOOL_MAX_ROWS; }
            if (w === TOOL_DEFAULT_COLS && h === 0) { continue; }
            out[pair[0]] = { w: w, h: h };
        }
        return out;
    }

    function sizesText(sizes) {
        var out = [];
        var i, z;
        for (i = 0; i < TOOL_NAMES.length; i++) {
            z = sizes[TOOL_NAMES[i]];
            if (z && !(z.w === TOOL_DEFAULT_COLS && !z.h)) { out.push(TOOL_NAMES[i] + "=" + z.w + "x" + (z.h || 0)); }
        }
        return out.join(";");
    }

    function sizeOf(name) {
        return parseSizes(motion.sizes)[name] || { w: TOOL_DEFAULT_COLS, h: 0 };
    }

    // Места блоков: "ease=0,0;anchor=4,0" — колонка и ряд левого верхнего угла. Пусто — блоки идут
    // друг за другом по порядку и сами переносятся, когда панель сужают или растягивают.
    function parsePlaces(text) {
        var out = {};
        var parts = String(text).split(";");
        var i, pair, m;
        for (i = 0; i < parts.length; i++) {
            pair = parts[i].split("=");
            if (pair.length !== 2 || TOOL_NAMES.indexOf(pair[0]) < 0) { continue; }
            m = /^(\d{1,2}),(\d{1,3})$/.exec(pair[1]);
            if (m) { out[pair[0]] = { x: Number(m[1]), y: Number(m[2]) }; }
        }
        return out;
    }

    function placesText(places) {
        var out = [];
        var i, q;
        for (i = 0; i < TOOL_NAMES.length; i++) {
            q = places[TOOL_NAMES[i]];
            if (q) { out.push(TOOL_NAMES[i] + "=" + q.x + "," + q.y); }
        }
        return out.join(";");
    }

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
        if (SHIFT_TARGETS.indexOf(m.shiftWhat) < 0) { m.shiftWhat = "in"; }
        if (SHIFT_TARGETS.indexOf(m.staggerWhat) < 0) { m.staggerWhat = "layer"; }
        if (TIME_POINTS.indexOf(m.timeAlign) < 0) { m.timeAlign = "inStart"; }
        if (STAGGER_ORDERS.indexOf(m.staggerOrder) < 0) { m.staggerOrder = "asc"; }
        m.shiftStep = clampStep(m.shiftStep);
        m.staggerStep = clampStep(m.staggerStep);
        m.order = cleanToolOrder(m.order);
        m.sizes = sizesText(parseSizes(m.sizes));
        m.places = placesText(parsePlaces(m.places));
        m.pins = cleanPins(m.pins);
        return m;
    }

    // Число кадров для сдвига и лесенки: целое от 1 до 999.
    function clampStep(v) {
        v = Math.round(Number(v));
        if (isNaN(v) || v < 1) { return 1; }
        return v > MAX_STEP_FRAMES ? MAX_STEP_FRAMES : v;
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

    // Минус в углу блока прячет его дополнительную часть и становится плюсом; плюс возвращает её.
    // У плавности это кривая, у точки привязки и выравнивания — список с настройкой.
    // Спрятанная настройка продолжает действовать: в подсказке плюса написано, что выбрано.
    function foldParts() {
        return [
            { key: "curve", button: ui.easeCurveToggle, part: ui.easeCurve, hide: "Скрыть кривую", show: "Показать кривую" },
            { key: "anchorOpts", button: ui.anchorOptsToggle, part: ui.anchorSide, hide: "Скрыть настройку", show: "Показать настройку", select: ui.anchorKeys },
            { key: "alignOpts", button: ui.alignOptsToggle, part: ui.alignSide, more: [ui.distLabel], hide: "Скрыть подписи", show: "Показать подписи", select: ui.alignTo },
            { key: "pasteOpts", button: ui.pasteOptsToggle, part: ui.pasteHint, hide: "Скрыть подсказку", show: "Показать подсказку" },
            { key: "organizeOpts", button: ui.organizeOptsToggle, part: ui.organizeHint, hide: "Скрыть подсказку", show: "Показать подсказку" },
            { key: "shiftOpts", button: ui.shiftOptsToggle, part: ui.shiftPick, more: [ui.timePick, ui.staggerPick, ui.staggerOrder], hide: "Скрыть списки", show: "Показать списки",
                selects: [ui.shiftWhat, ui.timeAlign, ui.staggerWhat, ui.staggerOrder] }
        ];
    }

    // У SVG нет свойства hidden, поэтому меняем сам атрибут.
    function showFoldParts() {
        var parts = foldParts();
        var i, j, f, open, label, opt;
        for (i = 0; i < parts.length; i++) {
            f = parts[i];
            open = motion[f.key] !== false;
            label = open ? f.hide : f.show;
            if (!open && f.select) {
                opt = f.select.options[f.select.selectedIndex];
                if (opt) { label += " (сейчас: " + opt.text + ")"; }
            }
            if (!open && f.selects) {
                opt = [];
                for (j = 0; j < f.selects.length; j++) {
                    if (f.selects[j].selectedIndex >= 0) { opt.push(f.selects[j].options[f.selects[j].selectedIndex].text); }
                }
                label += " (сейчас: " + opt.join("; ") + ")";
            }
            if (open) { f.part.removeAttribute("hidden"); } else { f.part.setAttribute("hidden", ""); }
            for (j = 0; f.more && j < f.more.length; j++) {
                if (open) { f.more[j].removeAttribute("hidden"); } else { f.more[j].setAttribute("hidden", ""); }
            }
            f.button.setAttribute("aria-expanded", open ? "true" : "false");
            f.button.setAttribute("aria-label", label);
            f.button.title = label;
        }
    }

    // ---- булавка: закреплённый блок встаёт наверх, под закреплёнными — тонкая линия, ниже остальные.

    function cleanPins(text) {
        var out = [];
        String(text || "").split(",").forEach(function (n) {
            if (TOOL_NAMES.indexOf(n) >= 0 && out.indexOf(n) < 0) { out.push(n); }
        });
        return out.join(",");
    }

    function pinList() { return motion && motion.pins ? motion.pins.split(",") : []; }

    var PIN_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path class="pin-body" d="M6 2.2h4l-.6 4 2.4 2.3v1H4.2v-1L6.6 6.2z"/><path d="M8 9.5V14"/></svg>';

    function showPins() {
        var pins = pinList();
        toolCards().forEach(function (card) {
            var name = card.getAttribute("data-tool");
            var b = card.querySelector(".tool-pin");
            var on = pins.indexOf(name) >= 0;
            var label = card.getAttribute("aria-label") || "";
            if (!b) { return; }
            b.setAttribute("aria-pressed", on ? "true" : "false");
            b.title = on ? "Открепить" : "Закрепить наверху";
            b.setAttribute("aria-label", (on ? "Открепить блок «" : "Закрепить наверху блок «") + label + "»");
            card.classList.toggle("pinned", on);
        });
    }

    function togglePin(name) {
        var pins = pinList(), at = pins.indexOf(name), places = parsePlaces(motion.places);
        if (at >= 0) { pins.splice(at, 1); } else { pins.push(name); }
        // Сохранённое место блока больше не подходит: он переезжает в другую часть.
        delete places[name];
        motion.places = placesText(places);
        motion.pins = cleanPins(pins.join(","));
        storeMotion();
        showPins();
        relayoutTools();
    }

    function enablePins() {
        toolCards().forEach(function (card) {
            var name = card.getAttribute("data-tool");
            var toggle = card.querySelector(".tool-toggle");
            var b = document.createElement("button");
            b.className = "tool-pin";
            b.setAttribute("data-pin", name);
            b.innerHTML = PIN_ICON;
            b.addEventListener("click", function (e) { e.stopPropagation(); togglePin(name); });
            card.insertBefore(b, toggle || card.firstChild);
        });
        showPins();
    }

    function enableFolding() {
        foldParts().forEach(function (f) {
            f.button.addEventListener("click", function () {
                motion[f.key] = motion[f.key] === false;
                showFoldParts();
                relayoutTools();
                storeMotion();
            });
        });
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
        var before = motion.easeIn + "/" + motion.easeOut;
        if (which === "in") { motion.easeIn = v; } else { motion.easeOut = v; }
        if (motion.link) { motion.easeIn = v; motion.easeOut = v; }
        drawEase();
        storeMotion();
        if (motion.easeIn + "/" + motion.easeOut !== before) { liveEaseSoon(); }
    }

    // ---- плавность в реальном времени: пока двигают ползунок, выделенные ключи меняются сразу.
    // After Effects не успевает за каждым пикселем, поэтому запросы идут по одному: пока один выполняется,
    // новые значения копятся, и следующим уходит самое свежее. Ползунки на это время не блокируются.
    var LIVE_EASE_EVERY_MS = 60;
    var liveEase = { running: false, pending: false, timer: null, last: 0 };

    function liveEaseMark() {
        var card = ui.easeIn && ui.easeIn.closest ? ui.easeIn.closest(".tool-card") : null;
        if (!card) { return; }
        if (liveEase.running || liveEase.pending) { card.setAttribute("data-live", "on"); } else { card.removeAttribute("data-live"); }
    }

    function liveEaseSoon() {
        liveEase.pending = true;
        liveEaseMark();
        pumpLiveEase();
    }

    function pumpLiveEase() {
        var wait;
        if (liveEase.running || !liveEase.pending) { return; }
        wait = LIVE_EASE_EVERY_MS - (Date.now() - liveEase.last);
        if (wait > 0) {
            if (!liveEase.timer) { liveEase.timer = setTimeout(function () { liveEase.timer = null; pumpLiveEase(); }, wait); }
            return;
        }
        liveEase.pending = false;
        // Идёт другая работа (например, Claude выполняет задачу) — не вмешиваемся.
        if (busy) { liveEaseMark(); return; }
        liveEase.running = true;
        liveEase.last = Date.now();
        host("ease", [motion.easeIn, motion.easeOut, "both"]).then(function (res) {
            if (!busy) { showEaseResult(res); }
        }).catch(function (e) {
            var m = e && e.message ? e.message : String(e);
            if (busy) { return; }
            if (m === "NO_KEYS_SELECTED") {
                setStatus("Выделите ключевые кадры на таймлайне — плавность будет меняться сразу, пока вы двигаете ползунок.", "");
            } else {
                setStatus(humanError(e), m === "NO_ACTIVE_COMP" ? "" : "error");
            }
        }).then(function () {
            liveEase.running = false;
            liveEase.last = Date.now();
            liveEaseMark();
            pumpLiveEase();
        });
    }

    function showEaseResult(res) {
        var text;
        if (!res.keys) {
            setStatus("Не удалось изменить выделенные ключи: After Effects не дал задать для них плавность.", "error");
            return;
        }
        text = "Плавность применена: " + plural(res.keys, "ключ", "ключа", "ключей") + ".";
        if (res.failed) { text += " Не получилось для " + plural(res.failed, "ключа", "ключей", "ключей") + "."; }
        setStatus(text + "\nОтменить: Cmd/Ctrl+Z.", "done");
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
        var before = motion.easeIn;
        motion.link = ui.easeLink.checked;
        if (motion.link) { motion.easeIn = motion.easeOut; }
        drawEase();
        storeMotion();
        if (motion.easeIn !== before) { liveEaseSoon(); }
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
        cells = ui.distGrid.querySelectorAll("button");
        for (i = 0; i < cells.length; i++) { cells[i].disabled = on; }
        cells = [ui.shiftWhat, ui.shiftStep, ui.shiftBack, ui.shiftFwd, ui.timeAlign, ui.timeAlignBtn, ui.staggerWhat, ui.staggerStep, ui.staggerOrder, ui.staggerBtn];
        for (i = 0; i < cells.length; i++) { cells[i].disabled = on; }
    }

    // ------------------------------------------------------------ раздел «Анимация»
    // Библиотека готовых пресетов, как в Animation Composer: переходы, текст, анимация, графика, звуки.
    // Всё создаётся заново ключами, эффектами, аниматорами текста и шейп-слоями; звуки синтезированы
    // нами (tools/make_sfx.py) — чужих пресетов и сэмплов в панели нет.

    var AC_KEY = "sayframe.ac.v1";
    var AC_SECTIONS = [
        { id: "trans", label: "Переходы" },
        { id: "text", label: "Текст" },
        { id: "anim", label: "Анимация" },
        { id: "graphic", label: "Графика" },
        { id: "sfx", label: "Звуки" }
    ];
    var AC_PRESETS = {
        trans: [["zoom-blur", "Зум с размытием"], ["spin-zoom", "Вращение с зумом"], ["push-left", "Сдвиг влево"], ["push-right", "Сдвиг вправо"],
            ["push-up", "Сдвиг вверх"], ["wipe", "Шторка"], ["clock-wipe", "Круговая шторка"], ["flash", "Вспышка"], ["glitch", "Глитч"],
            ["stretch", "Растяжение"], ["blur", "Размытие"]],
        text: [["typewriter", "Печатная машинка"], ["fade-letters", "Проявление по буквам"], ["slide-letters", "Буквы снизу"],
            ["pop-letters", "Буквы с масштабом"], ["blur-letters", "Буквы из размытия"], ["rotate-letters", "Буквы с поворотом"],
            ["words", "По словам"], ["random", "Случайные буквы"], ["tracking", "Разлёт букв"]],
        anim: [["fade", "Прозрачность"], ["scale-up", "Масштаб"], ["pop", "Пружинка"], ["slide-left", "Слева"], ["slide-right", "Справа"],
            ["slide-up", "Снизу"], ["slide-down", "Сверху"], ["rotate-in", "Поворот"], ["spin-scale", "Вихрь"], ["blur-in", "Из размытия"],
            ["drop-bounce", "Падение с отскоком"], ["swing", "Качание"], ["squash", "Сплющивание"]],
        graphic: [["ring", "Кольцо"], ["burst", "Лучи"], ["underline", "Подчёркивание"], ["lower-third", "Плашка для титра"], ["arrow", "Стрелка"],
            ["progress", "Полоса загрузки"], ["ripples", "Круги"], ["star", "Звезда"], ["counter", "Счётчик 0–100%"], ["timer", "Таймер 10 с"]],
        sfx: [["whoosh", "Вжух"], ["swish", "Свист"], ["swipe-up", "Взмах"], ["pop", "Поп"], ["click", "Клик"], ["bubble", "Пузырь"],
            ["ding", "Дзынь"], ["notify", "Уведомление"], ["riser", "Нарастание"], ["impact", "Удар"], ["glitch", "Глитч"], ["typing", "Клавиатура"]]
    };
    var AC_GLYPH = { arrow: "➜", star: "★", counter: "42%", timer: "00:10" };
    var AC_DEFAULTS = { sec: "trans", fav: [], mode: "in", dur: 0.6, color: "#ffffff", size: 112, favOnly: false };
    var acState = loadAcState();
    var acAudio = null;

    function loadAcState() {
        var s, out = {}, k;
        try { s = JSON.parse(window.localStorage.getItem(AC_KEY) || "{}"); } catch (e) { s = {}; }
        if (!s || typeof s !== "object") { s = {}; }
        for (k in AC_DEFAULTS) {
            if (AC_DEFAULTS.hasOwnProperty(k)) { out[k] = typeof s[k] === typeof AC_DEFAULTS[k] ? s[k] : AC_DEFAULTS[k]; }
        }
        if (!AC_PRESETS.hasOwnProperty(out.sec) && out.sec !== "edit") { out.sec = "trans"; }
        if (["in", "out", "both"].indexOf(out.mode) < 0) { out.mode = "in"; }
        out.dur = Math.min(3, Math.max(0.2, Math.round(Number(out.dur) * 10) / 10 || 0.6));
        out.size = Math.min(200, Math.max(80, Number(out.size) || 112));
        if (!/^#[0-9a-f]{6}$/i.test(out.color)) { out.color = "#ffffff"; }
        out.fav = Array.isArray(s.fav) ? s.fav.filter(function (x) { return typeof x === "string"; }) : [];
        return out;
    }

    function storeAcState() { try { window.localStorage.setItem(AC_KEY, JSON.stringify(acState)); } catch (e) {} }

    function acAll() {
        var out = [];
        AC_SECTIONS.forEach(function (s) {
            AC_PRESETS[s.id].forEach(function (p) { out.push({ sec: s.id, id: p[0], name: p[1], key: s.id + ":" + p[0] }); });
        });
        return out;
    }

    function acSectionLabel(sec) {
        var i;
        for (i = 0; i < AC_SECTIONS.length; i++) { if (AC_SECTIONS[i].id === sec) { return AC_SECTIONS[i].label; } }
        return "";
    }

    function acVisible() {
        var q = fxLower(ui.acSearch.value).replace(/^\s+|\s+$/g, "");
        return acAll().filter(function (p) {
            if (acState.favOnly && acState.fav.indexOf(p.key) < 0) { return false; }
            if (q) { return fxLower(p.name).indexOf(q) >= 0 || fxLower(p.id).indexOf(q) >= 0; }
            return acState.favOnly || p.sec === acState.sec;
        });
    }

    function acThumb(p) {
        var thumb = document.createElement("span");
        var obj = document.createElement("span");
        var i, bar;
        thumb.className = "ac-thumb";
        obj.className = "ac-obj ac-" + p.sec + " pv-" + p.sec + "-" + p.id;
        if (p.sec === "text") { obj.textContent = "Текст"; }
        if (p.sec === "graphic" && AC_GLYPH[p.id]) { obj.textContent = AC_GLYPH[p.id]; }
        if (p.sec === "graphic" && p.id === "progress") { obj.appendChild(document.createElement("i")); }
        if (p.sec === "sfx") {
            for (i = 0; i < 5; i++) { bar = document.createElement("i"); obj.appendChild(bar); }
        }
        thumb.appendChild(obj);
        return thumb;
    }

    function renderAc() {
        var list = acVisible();
        var searching = !!ui.acSearch.value.replace(/\s/g, "") || acState.favOnly;
        var sec = acState.sec;
        var editing = sec === "edit" && !searching;
        ui.acGrid.innerHTML = "";
        ui.acGrid.style.setProperty("--ac-size", acState.size + "px");
        Array.prototype.forEach.call(ui.acTabs.querySelectorAll("button"), function (b) {
            var on = !searching && b.getAttribute("data-sec") === sec;
            b.setAttribute("aria-selected", on ? "true" : "false");
        });
        ui.acFavOnly.setAttribute("aria-pressed", acState.favOnly ? "true" : "false");
        ui.acModeRow.hidden = editing || !(searching || sec === "trans" || sec === "text" || sec === "anim");
        ui.acColorRow.hidden = editing || !(searching || sec === "graphic");
        ui.acDurRow.hidden = editing || (!searching && sec === "sfx");
        ui.acFoot.hidden = editing;
        pressGroup(ui.acMode, acState.mode);
        ui.acDur.value = String(acState.dur);
        ui.acDurVal.textContent = acState.dur.toFixed(1).replace(".", ",") + " с";
        ui.acColor.value = acState.color;
        ui.acSize.value = String(acState.size);
        ui.acHint.textContent = acHintText(searching ? "" : sec);
        if (editing) { renderAcEdit(); return; }
        if (!list.length) {
            ui.acGrid.appendChild(fxNote(acState.favOnly ? "В избранном пусто: нажмите ☆ на карточке, чтобы добавить." : "Ничего не нашлось."));
            return;
        }
        list.forEach(function (p) { ui.acGrid.appendChild(acCard(p, searching)); });
    }

    function acHintText(sec) {
        if (sec === "graphic") { return "Щелчок по карточке добавляет графику новым слоем у указателя времени."; }
        if (sec === "sfx") { return "▶ — послушать. Щелчок по карточке кладёт звук в композицию у указателя времени."; }
        if (sec === "text") { return "Выделите текстовый слой и щёлкните по карточке. Если текстового слоя нет, панель создаст новый."; }
        return "Выделите слои и щёлкните по карточке. Наведите курсор, чтобы увидеть движение.";
    }

    function acCard(p, showSection) {
        var card = document.createElement("div");
        var name = document.createElement("span");
        var star = document.createElement("button");
        var fav = acState.fav.indexOf(p.key) >= 0;
        var play;
        card.className = "ac-card";
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("data-key", p.key);
        card.title = p.name + (showSection ? " · " + acSectionLabel(p.sec) : "");
        card.appendChild(acThumb(p));
        name.className = "ac-name";
        name.textContent = p.name;
        card.appendChild(name);
        star.className = "ac-star" + (fav ? " on" : "");
        star.textContent = fav ? "★" : "☆";
        star.title = fav ? "Убрать из избранного" : "В избранное";
        star.setAttribute("aria-label", star.title);
        star.addEventListener("click", function (e) {
            var at = acState.fav.indexOf(p.key);
            e.stopPropagation();
            if (at >= 0) { acState.fav.splice(at, 1); } else { acState.fav.push(p.key); }
            storeAcState();
            renderAc();
        });
        card.appendChild(star);
        if (p.sec === "sfx") {
            play = document.createElement("button");
            play.className = "ac-play";
            play.textContent = "▶";
            play.title = "Послушать";
            play.setAttribute("aria-label", "Послушать «" + p.name + "»");
            play.addEventListener("click", function (e) { e.stopPropagation(); acPreviewSound(p); });
            card.appendChild(play);
        }
        card.addEventListener("click", function () { applyAc(p); });
        card.addEventListener("keydown", function (e) {
            if (e.target === card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); applyAc(p); }
        });
        return card;
    }

    // ---- «Изменить»: пресеты Sayframe на выделенном слое — длительность, задержка, сила, плавность,
    // замена на другой пресет того же рода и «Убрать». Меняется сразу, как отпустили ползунок.

    var acEdit = { layer: "", items: null, error: "" };

    function acPresetName(id) {
        var secs = ["anim", "trans", "text"], i, j;
        for (i = 0; i < secs.length; i++) {
            for (j = 0; j < AC_PRESETS[secs[i]].length; j++) {
                if (AC_PRESETS[secs[i]][j][0] === id) { return AC_PRESETS[secs[i]][j][1]; }
            }
        }
        return id;
    }

    function acSameKind(id) {
        var isText = AC_PRESETS.text.some(function (p) { return p[0] === id; });
        return isText ? AC_PRESETS.text : AC_PRESETS.anim.concat(AC_PRESETS.trans);
    }

    async function loadAcEdit() {
        var res;
        acEdit.error = "";
        try {
            res = await host("acList", []);
            acEdit.layer = res.layer;
            acEdit.items = res.items;
        } catch (e) {
            acEdit.items = null;
            acEdit.error = e && e.message === "NO_LAYERS_SELECTED" ? "Выделите слой, на котором стоит пресет Sayframe, и нажмите «Обновить»." : humanError(e);
        }
        if (acState.sec === "edit") { renderAc(); }
    }

    function acSlider(label, min, max, step, value, fmt, onChange) {
        var row = document.createElement("label");
        var span = document.createElement("span");
        var input = document.createElement("input");
        var out = document.createElement("output");
        row.className = "ac-edit-row";
        span.textContent = label;
        input.type = "range";
        input.className = "range";
        input.min = String(min); input.max = String(max); input.step = String(step);
        input.value = String(value);
        input.setAttribute("aria-label", label);
        out.textContent = fmt(Number(value));
        input.addEventListener("input", function () { out.textContent = fmt(Number(input.value)); });
        input.addEventListener("change", function () { onChange(Number(input.value)); });
        row.appendChild(span); row.appendChild(input); row.appendChild(out);
        return row;
    }

    function secText(v) { return v.toFixed(1).replace(".", ",") + " с"; }

    function renderAcEdit() {
        var grid = ui.acGrid, head = document.createElement("div"), title = document.createElement("span"), refresh = document.createElement("button");
        head.className = "ac-edit-head";
        title.textContent = acEdit.items ? "Слой «" + acEdit.layer + "»" : "";
        refresh.className = "ghost";
        refresh.id = "acEditRefresh";
        refresh.textContent = "Обновить";
        refresh.addEventListener("click", loadAcEdit);
        head.appendChild(title);
        head.appendChild(refresh);
        grid.appendChild(head);
        if (!acEdit.items) {
            grid.appendChild(fxNote(acEdit.error || "Читаю пресеты на выделенном слое…"));
            return;
        }
        if (!acEdit.items.length) {
            grid.appendChild(fxNote("На этом слое нет пресетов Sayframe. Поставьте пресет из разделов «Переходы», «Текст» или «Анимация» — и его можно будет настроить здесь."));
            return;
        }
        acEdit.items.forEach(function (it, index) { grid.appendChild(acEditItem(it, index)); });
    }

    function acEditItem(it, index) {
        var box = document.createElement("div");
        var head = document.createElement("div");
        var name = document.createElement("b");
        var remove = document.createElement("button");
        var swap = document.createElement("select");
        var swapRow = document.createElement("label");
        var span = document.createElement("span");
        box.className = "ac-edit-item";
        box.setAttribute("data-index", String(index));
        head.className = "ac-edit-top";
        name.textContent = acPresetName(it.id) + " — " + (it.dir === "out" ? "исчезновение" : "появление");
        remove.className = "ghost warn";
        remove.textContent = "Убрать";
        remove.addEventListener("click", function () { acEditCall("acRemove", [index], "«" + acPresetName(it.id) + "» убран со слоя."); });
        head.appendChild(name);
        head.appendChild(remove);
        box.appendChild(head);
        swapRow.className = "ac-edit-row";
        span.textContent = "Пресет";
        swap.className = "ac-swap";
        acSameKind(it.id).forEach(function (p) {
            var o = document.createElement("option");
            o.value = p[0];
            o.textContent = p[1];
            swap.appendChild(o);
        });
        swap.value = it.id;
        swap.addEventListener("change", function () { acEditSet(index, { id: swap.value }); });
        swapRow.appendChild(span);
        swapRow.appendChild(swap);
        box.appendChild(swapRow);
        box.appendChild(acSlider("Длительность", 0.1, 3, 0.1, it.dur, secText, function (v) { acEditSet(index, { dur: v }); }));
        box.appendChild(acSlider("Задержка", 0, 2, 0.1, it.delay || 0, secText, function (v) { acEditSet(index, { delay: v }); }));
        box.appendChild(acSlider("Сила", 20, 200, 10, Math.round((it.strength || 1) * 100), function (v) { return v + "%"; },
            function (v) { acEditSet(index, { strength: v / 100 }); }));
        box.appendChild(acSlider("Плавность", 0, 100, 5, it.ease || 0, function (v) { return v ? v + "%" : "как в пресете"; },
            function (v) { acEditSet(index, { ease: v }); }));
        return box;
    }

    function acEditSet(index, prm) {
        var it = acEdit.items && acEdit.items[index];
        acEditCall("acEdit", [index, prm], it ? "«" + acPresetName(prm.id || it.id) + "» обновлён." : "Пресет обновлён.");
    }

    async function acEditCall(fn, args, done) {
        var res;
        if (busy) { return; }
        setBusy(true);
        setStatus("Меняю пресет…", "busy");
        try {
            res = await host(fn, args);
            acEdit.layer = res.layer;
            acEdit.items = res.items;
            setBusy(false);
            setStatus(done + " Отменить — Cmd/Ctrl+Z.", "done");
        } catch (e) {
            setBusy(false);
            if (e && e.message === "PRESET_GONE") {
                setStatus("Этого пресета на слое уже нет — список обновлён.", "");
                loadAcEdit();
                return;
            }
            toolFailed(e);
        }
        renderAc();
    }

    function acSoundPath(id) { return platform.join(extensionDir(), "sfx", id + ".wav"); }

    function acPreviewSound(p) {
        try {
            if (acAudio) { acAudio.pause(); }
            acAudio = new Audio("file://" + encodeURI(acSoundPath(p.id)));
            acAudio.play();
        } catch (e) {}
    }

    function hexToRgb01(hex) {
        var c = parseHex(hex);
        return c ? [c.r / 255, c.g / 255, c.b / 255] : [1, 1, 1];
    }

    var AC_MODE_TEXT = { "in": "появление", "out": "исчезновение", "both": "появление и исчезновение" };

    async function applyAc(p) {
        var res, info, folder, dest;
        if (busy) { return; }
        setBusy(true);
        setStatus("Добавляю «" + p.name + "»…", "busy");
        try {
            if (p.sec === "anim" || p.sec === "trans") {
                res = await host("acAnimate", [p.id, acState.mode, acState.dur]);
                setBusy(false);
                acReport(p, res, "");
            } else if (p.sec === "text") {
                res = await host("acText", [p.id, acState.mode, acState.dur, "Ваш текст"]);
                setBusy(false);
                acReport(p, res, res.created ? " Текстового слоя не было — создан новый «Ваш текст»." : "");
            } else if (p.sec === "graphic") {
                res = await host("acGraphic", [p.id, acState.dur, hexToRgb01(acState.color)]);
                setBusy(false);
                setStatus("Добавлено: «" + p.name + "» — новый слой «" + res.name + "» у указателя времени. Отменить — Cmd/Ctrl+Z.", "done");
            } else {
                info = await host("info", []);
                if (!info.fileAccess) { throw new Error(FILE_ACCESS_HINT); }
                folder = info.projectPath ? platform.join(platform.dirname(info.projectPath), "Sayframe SFX") :
                    platform.join(platform.homedir(), "Documents", "Sayframe SFX");
                await platform.mkdirp(folder);
                dest = platform.join(folder, p.id + ".wav");
                if (!(await platform.exists(dest))) {
                    await platform.writeBytes(dest, base64ToBytes(await platform.readBase64(acSoundPath(p.id))));
                }
                res = await host("acSound", [dest, "Sayframe SFX"]);
                setBusy(false);
                setStatus("Звук «" + p.name + "» добавлен у указателя времени." + (res.reused ? "" : " Файл лежит в папке «Sayframe SFX» рядом с проектом."), "done");
            }
        } catch (e) {
            toolFailed(e);
        }
    }

    function acReport(p, res, extra) {
        var what = plural(res.applied, "слой", "слоя", "слоёв");
        if (!res.applied) {
            setStatus("«" + p.name + "» не удалось добавить ни на один выделенный слой" + (res.skipped ? " (камеры и свет пропущены)" : "") + ".", res.failed ? "error" : "");
            return;
        }
        setStatus("«" + p.name + "» — " + AC_MODE_TEXT[acState.mode] + ", " + what + "." +
            (res.skipped ? " Пропущено: " + plural(res.skipped, "слой", "слоя", "слоёв") + "." : "") +
            (res.failed ? " Не получилось: " + plural(res.failed, "слой", "слоя", "слоёв") + "." : "") +
            extra + " Отменить — Cmd/Ctrl+Z.", res.failed ? "error" : "done");
    }

    function base64ToBytes(b64) {
        var bin = atob(b64), out = new Uint8Array(bin.length), i;
        for (i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
        return out;
    }

    function enableAc() {
        AC_SECTIONS.forEach(function (s) {
            var b = document.createElement("button");
            b.className = "ac-tab";
            b.setAttribute("role", "tab");
            b.setAttribute("data-sec", s.id);
            b.textContent = s.label;
            b.addEventListener("click", function () {
                acState.sec = s.id;
                acState.favOnly = false;
                ui.acSearch.value = "";
                storeAcState();
                renderAc();
            });
            ui.acTabs.appendChild(b);
        });
        (function () {
            var b = document.createElement("button");
            b.className = "ac-tab ac-tab-edit";
            b.setAttribute("role", "tab");
            b.setAttribute("data-sec", "edit");
            b.textContent = "✎ Изменить";
            b.title = "Настроить пресеты, которые уже стоят на выделенном слое";
            b.addEventListener("click", function () {
                acState.sec = "edit";
                acState.favOnly = false;
                ui.acSearch.value = "";
                storeAcState();
                acEdit.items = null;
                renderAc();
                loadAcEdit();
            });
            ui.acTabs.appendChild(b);
        })();
        ui.acSearch.addEventListener("input", renderAc);
        ui.acSearch.addEventListener("keydown", function (e) { if (e.key === "Escape") { ui.acSearch.value = ""; renderAc(); } });
        ui.acFavOnly.addEventListener("click", function () { acState.favOnly = !acState.favOnly; storeAcState(); renderAc(); });
        Array.prototype.forEach.call(ui.acMode.querySelectorAll("button"), function (b) {
            b.addEventListener("click", function () { acState.mode = b.getAttribute("data-value"); storeAcState(); pressGroup(ui.acMode, acState.mode); });
        });
        ui.acDur.addEventListener("input", function () {
            acState.dur = Math.round(Number(ui.acDur.value) * 10) / 10;
            ui.acDurVal.textContent = acState.dur.toFixed(1).replace(".", ",") + " с";
            storeAcState();
        });
        ui.acColor.addEventListener("input", function () { acState.color = ui.acColor.value; storeAcState(); });
        ui.acSize.addEventListener("input", function () {
            acState.size = Number(ui.acSize.value);
            ui.acGrid.style.setProperty("--ac-size", acState.size + "px");
            storeAcState();
        });
        renderAc();
        if (acState.sec === "edit") { loadAcEdit(); }
    }

    // ---- FX Console: поиск эффектов и пресетов, как в одноимённом плагине Video Copilot.
    // Открывается горячей клавишей (по умолчанию Ctrl+Space) или лупой в шапке; Enter добавляет
    // найденное на выделенные слои. Там же — снимок кадра в PNG и в буфер обмена.

    var FX_KEY = "sayframe.fx.v1";           // { fav: [id], recent: [id] }
    var FX_MAX_SHOWN = 40;
    var FX_RECENT_MAX = 8;
    var fxCatalog = null;                    // { items: [{ id, kind, name, cat, m | p }] }
    var fxShown = [];                        // что сейчас в списке
    var fxActive = 0;
    var fxLoading = null;

    function loadFxState() {
        var s;
        try { s = JSON.parse(window.localStorage.getItem(FX_KEY) || "{}"); } catch (e) { s = {}; }
        if (!s || typeof s !== "object") { s = {}; }
        return {
            fav: Array.isArray(s.fav) ? s.fav.filter(function (x) { return typeof x === "string"; }) : [],
            recent: Array.isArray(s.recent) ? s.recent.filter(function (x) { return typeof x === "string"; }).slice(0, FX_RECENT_MAX) : []
        };
    }
    var fxState = loadFxState();
    function storeFxState() { try { window.localStorage.setItem(FX_KEY, JSON.stringify(fxState)); } catch (e) {} }

    function fxLower(t) { return String(t).toLowerCase().replace(/ё/g, "е"); }

    async function ensureFxCatalog() {
        var res, items = [];
        if (fxCatalog) { return fxCatalog; }
        if (!fxLoading) {
            fxLoading = host("fxCatalog", []).then(function (r) {
                r.effects.forEach(function (e) {
                    items.push({ id: "e:" + e.m, kind: "effect", name: e.n, cat: e.c, m: e.m, key: fxLower(e.n), catKey: fxLower(e.c) });
                });
                r.presets.forEach(function (p) {
                    items.push({ id: "p:" + p.p, kind: "preset", name: p.n, cat: p.u ? "Мои пресеты" : p.g, p: p.p, key: fxLower(p.n), catKey: fxLower(p.g) });
                });
                fxCatalog = { items: items, byId: {} };
                items.forEach(function (it) { fxCatalog.byId[it.id] = it; });
                return fxCatalog;
            });
            fxLoading.catch(function () { fxLoading = null; });
        }
        res = await fxLoading;
        return res;
    }

    // Чем меньше число, тем выше в списке: начало названия, начало слова, просто вхождение, категория.
    function fxScore(it, words, whole) {
        var score = 0, i, w, at;
        for (i = 0; i < words.length; i++) {
            w = words[i];
            at = it.key.indexOf(w);
            if (at === 0) { score += 0; }
            else if (at > 0 && /[\s\-_(]/.test(it.key.charAt(at - 1))) { score += 1; }
            else if (at > 0) { score += 3; }
            else if (it.catKey.indexOf(w) >= 0) { score += 6; }
            else { return null; }
        }
        if (it.key === whole) { score -= 5; }
        if (fxState.fav.indexOf(it.id) >= 0) { score -= 2; }
        if (it.kind === "preset") { score += 1; }
        return score;
    }

    function fxSearch(query) {
        var whole = fxLower(query).replace(/^\s+|\s+$/g, "");
        var words = whole.split(/\s+/).filter(Boolean);
        var found = [];
        var pick = function (ids) { return ids.map(function (id) { return fxCatalog.byId[id]; }).filter(Boolean); };
        if (!words.length) {
            return { fav: pick(fxState.fav), recent: pick(fxState.recent.filter(function (id) { return fxState.fav.indexOf(id) < 0; })) };
        }
        fxCatalog.items.forEach(function (it) {
            var sc = fxScore(it, words, whole);
            if (sc !== null) { found.push({ it: it, sc: sc }); }
        });
        found.sort(function (a, b) { return a.sc - b.sc || a.it.name.length - b.it.name.length || (a.it.name < b.it.name ? -1 : 1); });
        return { found: found.slice(0, FX_MAX_SHOWN).map(function (f) { return f.it; }), total: found.length };
    }

    function fxRow(it, index) {
        var li = document.createElement("li");
        var badge = document.createElement("span");
        var name = document.createElement("span");
        var cat = document.createElement("small");
        var star = document.createElement("button");
        var fav = fxState.fav.indexOf(it.id) >= 0;
        li.className = "fx-item" + (index === fxActive ? " active" : "");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", index === fxActive ? "true" : "false");
        li.setAttribute("data-index", String(index));
        badge.className = "fx-badge " + it.kind;
        badge.textContent = it.kind === "effect" ? "fx" : "пресет";
        name.className = "fx-name";
        name.textContent = it.name;
        cat.className = "fx-cat";
        cat.textContent = it.cat || "";
        star.className = "fx-star" + (fav ? " on" : "");
        star.textContent = fav ? "★" : "☆";
        star.title = fav ? "Убрать из избранного" : "В избранное";
        star.setAttribute("aria-label", star.title);
        star.addEventListener("mousedown", function (e) { e.preventDefault(); });
        star.addEventListener("click", function (e) {
            e.stopPropagation();
            toggleFxFavorite(it);
        });
        li.addEventListener("mousedown", function (e) { e.preventDefault(); });
        li.addEventListener("click", function () { applyFx(it); });
        li.appendChild(badge);
        li.appendChild(name);
        li.appendChild(cat);
        li.appendChild(star);
        return li;
    }

    function fxHead(text) {
        var li = document.createElement("li");
        li.className = "fx-head";
        li.setAttribute("role", "presentation");
        li.textContent = text;
        return li;
    }

    function fxNote(text) {
        var li = document.createElement("li");
        li.className = "fx-note";
        li.setAttribute("role", "presentation");
        li.textContent = text;
        return li;
    }

    function renderFx() {
        var list = ui.fxList;
        var r, all = [];
        list.innerHTML = "";
        if (!fxCatalog) { list.appendChild(fxNote("Загружаю список эффектов…")); return; }
        r = fxSearch(ui.fxSearch.value);
        if (r.found) {
            all = r.found;
            if (!all.length) { list.appendChild(fxNote("Ничего не нашлось. Попробуйте другое слово — по-английски, как эффект называется в After Effects.")); }
        } else {
            all = r.fav.concat(r.recent);
            if (!all.length) {
                list.appendChild(fxNote("Начните печатать название: blur, glow, curves, wiggle… Найденное добавится на выделенные слои."));
            }
        }
        if (fxActive >= all.length) { fxActive = Math.max(0, all.length - 1); }
        fxShown = all;
        all.forEach(function (it, i) {
            if (!r.found && i === 0 && r.fav.length) { list.appendChild(fxHead("Избранное")); }
            if (!r.found && i === r.fav.length && r.recent.length) { list.appendChild(fxHead("Недавние")); }
            list.appendChild(fxRow(it, i));
        });
        if (r.found && r.total > r.found.length) { list.appendChild(fxNote("И ещё " + (r.total - r.found.length) + " — уточните запрос.")); }
        markFxActive();
    }

    function markFxActive() {
        var rows = ui.fxList.querySelectorAll(".fx-item");
        var i;
        for (i = 0; i < rows.length; i++) {
            rows[i].className = "fx-item" + (i === fxActive ? " active" : "");
            rows[i].setAttribute("aria-selected", i === fxActive ? "true" : "false");
            if (i === fxActive && rows[i].scrollIntoView) { rows[i].scrollIntoView({ block: "nearest" }); }
        }
    }

    function toggleFxFavorite(it) {
        var at = fxState.fav.indexOf(it.id);
        if (at >= 0) { fxState.fav.splice(at, 1); } else { fxState.fav.push(it.id); }
        storeFxState();
        renderFx();
        ui.fxSearch.focus();
    }

    function fxOpen() { return !ui.fxConsole.hidden; }

    async function openFxConsole() {
        if (busy || !ui.sheet.hidden || !ui.modal.hidden) { return; }
        ui.fxConsole.hidden = false;
        ui.fxSearch.value = "";
        fxActive = 0;
        renderFx();
        ui.fxSearch.focus();
        try {
            await ensureFxCatalog();
            if (fxOpen()) { renderFx(); }
        } catch (e) {
            if (!fxOpen()) { return; }
            ui.fxList.innerHTML = "";
            ui.fxList.appendChild(fxNote("Не удалось получить список эффектов: " + humanError(e)));
        }
    }

    function closeFxConsole() {
        if (!fxOpen()) { return; }
        ui.fxConsole.hidden = true;
        ui.fxSearch.blur();
    }

    function fxApplied(n) { return plural(n, "слой", "слоя", "слоёв"); }

    async function applyFx(it) {
        var res, what;
        if (busy) { return; }
        closeFxConsole();
        setBusy(true);
        setStatus("Добавляю «" + it.name + "»…", "busy");
        try {
            res = it.kind === "effect" ? await host("applyEffect", [it.m, it.name]) : await host("applyPreset", [it.p, it.name]);
            fxState.recent = [it.id].concat(fxState.recent.filter(function (x) { return x !== it.id; })).slice(0, FX_RECENT_MAX);
            storeFxState();
            setBusy(false);
            what = it.kind === "effect" ? "Эффект" : "Пресет";
            if (!res.applied) {
                setStatus(what + " «" + it.name + "» нельзя добавить на выделенные слои: камерам и свету эффекты не ставятся.", "");
            } else {
                setStatus(what + " «" + it.name + "» добавлен на " + fxApplied(res.applied) + "." +
                    (res.skipped ? " Пропущено: " + fxApplied(res.skipped) + " (камера или свет)." : "") + " Отменить — Cmd/Ctrl+Z.", "done");
            }
        } catch (e) {
            toolFailed(e);
        }
    }

    function onFxKey(e) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!fxShown.length) { return; }
            fxActive = (fxActive + (e.key === "ArrowDown" ? 1 : -1) + fxShown.length) % fxShown.length;
            markFxActive();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (fxShown[fxActive]) { applyFx(fxShown[fxActive]); }
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeFxConsole();
        }
    }

    // Снимок кадра: PNG кадра под указателем времени — в «Документы/Sayframe Snapshots» и в буфер обмена.
    async function onSnapshot() {
        var folder, res, copied;
        if (busy) { return; }
        closeFxConsole();
        setBusy(true);
        setStatus("Снимаю кадр…", "busy");
        try {
            if (!(await host("info", [])).fileAccess) { throw new Error(FILE_ACCESS_HINT); }
            // Окно «Сохранить» открывается в папке проекта; у несохранённого проекта — в «Документы › Sayframe Snapshots».
            folder = platform.join(platform.homedir(), "Documents", "Sayframe Snapshots");
            await platform.mkdirp(folder);
            setStatus("Выберите, куда сохранить кадр…", "busy");
            res = await host("snapFrame", [folder, dateStamp(), "Сохранить кадр (PNG)"]);
            if (!res.snap) {
                setBusy(false);
                setStatus("Снимок отменён.", "");
                return;
            }
            copied = await copyPngToClipboard(res.snap.path);
            setBusy(false);
            setStatus("Кадр сохранён: " + platform.basename(platform.dirname(res.snap.path)) + " › " + platform.basename(res.snap.path) +
                (copied ? ". Он же в буфере обмена — можно сразу вставить." : ". В буфер обмена скопировать не получилось."), "done");
        } catch (e) {
            if (e && e.message === "NO_ACTIVE_COMP") { toolFailed(e); return; }
            setBusy(false);
            setStatus("Не удалось снять кадр: " + humanError(e), "error");
        }
    }

    async function copyPngToClipboard(path) {
        var r;
        try {
            if (platform.isWindows()) {
                r = await platform.exec("powershell", ["-NoProfile", "-STA", "-Command",
                    "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
                    "$i = [System.Drawing.Image]::FromFile('" + path.replace(/'/g, "''") + "'); " +
                    "[System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()"], 20000);
            } else {
                r = await platform.exec("osascript", ["-e",
                    "set the clipboard to (read (POSIX file \"" + path.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\") as «class PNGf»)"], 20000);
            }
            return r.code === 0;
        } catch (e) {
            return false;
        }
    }

    // ---- горячие клавиши. Хранятся строкой в настройках: "console=Ctrl+Space;snapshot=;…".

    var HOTKEY_ACTIONS = [
        { id: "console", label: "Поиск эффектов (FX Console)", def: "Ctrl+Space" },
        { id: "snapshot", label: "Снимок кадра", def: "" },
        { id: "organize", label: "Organize After Effects Project", def: "" },
        { id: "paste", label: "Вставить картинку из буфера", def: "" },
        { id: "tabAI", label: "Вкладка AI", def: "" },
        { id: "tabAnim", label: "Вкладка «Анимация»", def: "" },
        { id: "tabTools", label: "Вкладка «Инструменты»", def: "" }
    ];
    var HOTKEY_RESERVED = { C: 1, V: 1, X: 1, A: 1, Z: 1 };

    function isMac() { return !platform.isWindows(); }

    function parseHotkeys(text) {
        var out = {}, parts = String(text || "").split(";"), i, pair;
        HOTKEY_ACTIONS.forEach(function (a) { out[a.id] = a.def; });
        if (!text) { return out; }
        for (i = 0; i < parts.length; i++) {
            pair = parts[i].split("=");
            if (pair.length === 2 && out.hasOwnProperty(pair[0]) && (pair[1] === "" || normalCombo(pair[1]) === pair[1])) { out[pair[0]] = pair[1]; }
        }
        return out;
    }

    function hotkeysText(map) {
        return HOTKEY_ACTIONS.map(function (a) { return a.id + "=" + (map[a.id] || ""); }).join(";");
    }

    var KEY_NAMES = { Space: "Space", Enter: "Enter", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
        Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", ArrowUp: "Up", ArrowDown: "Down",
        ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };

    // Клавиша берётся по её месту на клавиатуре (e.code), поэтому сочетание не зависит от раскладки.
    function keyOf(e) {
        var c = e.code || "", m;
        if ((m = /^Key([A-Z])$/.exec(c))) { return m[1]; }
        if ((m = /^Digit(\d)$/.exec(c))) { return m[1]; }
        if (/^F([1-9]|1[0-2])$/.test(c)) { return c; }
        return KEY_NAMES[c] || "";
    }

    function comboOf(e) {
        var key = keyOf(e), parts = [];
        if (!key) { return ""; }
        if (e.ctrlKey) { parts.push("Ctrl"); }
        if (e.altKey) { parts.push("Alt"); }
        if (e.shiftKey) { parts.push("Shift"); }
        if (e.metaKey) { parts.push(isMac() ? "Cmd" : "Win"); }
        parts.push(key);
        return parts.join("+");
    }

    // Сочетание, которое можно назначить: с Cmd/Ctrl/Alt (или Shift с F-клавишей) либо одна F-клавиша.
    function normalCombo(text) {
        var parts = String(text).split("+"), key = parts.pop(), mods = {}, order = ["Ctrl", "Alt", "Shift", "Cmd"], out = [], i;
        if (!key) { return ""; }
        for (i = 0; i < parts.length; i++) {
            if (order.indexOf(parts[i]) < 0 || mods[parts[i]]) { return ""; }
            mods[parts[i]] = true;
        }
        if (!/^(F([1-9]|1[0-2])|[A-Z0-9]|Space|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|[`\-=\[\];',.\/\\])$/.test(key)) { return ""; }
        if (!/^F/.test(key) || key.length === 1) {
            if (!mods.Ctrl && !mods.Alt && !mods.Cmd) { return ""; }
        }
        for (i = 0; i < order.length; i++) { if (mods[order[i]]) { out.push(order[i]); } }
        out.push(key);
        return out.join("+");
    }

    var MAC_MODS = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" };

    function comboLabel(combo) {
        var parts;
        if (!combo) { return "—"; }
        if (!isMac()) { return combo; }
        parts = combo.split("+");
        return parts.slice(0, -1).map(function (m) { return MAC_MODS[m] || m; }).join("") + parts[parts.length - 1];
    }

    function hotkeyAction(combo) {
        var map = parseHotkeys(settings.hotkeys), k;
        for (k in map) { if (map.hasOwnProperty(k) && map[k] && map[k] === combo) { return k; } }
        return null;
    }

    function runHotkey(id) {
        if (id === "console") { if (fxOpen()) { closeFxConsole(); } else { openFxConsole(); } return; }
        if (busy) { return; }
        if (id === "snapshot") { onSnapshot(); return; }
        closeFxConsole();
        if (id === "organize") { onOrganize(); }
        else if (id === "paste") { pasteImage(null); }
        else if (id === "tabAI") { showTab("claude"); }
        else if (id === "tabAnim") { showTab("tools"); }
        else if (id === "tabTools") { showTab("motion"); }
    }

    function onHotkeyDown(e) {
        var combo, id;
        if (hotkeyEdit && !ui.sheet.hidden) { captureHotkey(e); return; }
        if (!ui.sheet.hidden || !ui.modal.hidden) { return; }
        combo = comboOf(e);
        id = combo ? hotkeyAction(combo) : null;
        if (id) {
            e.preventDefault();
            e.stopPropagation();
            lastPanelHotkey = { id: id, at: Date.now() };
            runHotkey(id);
        }
    }

    // В настройках: строка на каждое действие, кнопка показывает сочетание. Щелчок открывает редактор:
    // можно нажать сочетание на клавиатуре или собрать его мышью (модификаторы и клавиша из списка) —
    // второй способ нужен, если After Effects перехватывает какое-то сочетание раньше панели.
    // Изменения сохраняются сразу, без кнопки «Сохранить».

    var HOTKEY_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
        "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
        "Space", "Enter", "Up", "Down", "Left", "Right", "`", "-", "=", "[", "]", ";", "'", ",", ".", "/", "\\"];
    var hotkeyEdit = null;       // { id, mods: { Ctrl, Alt, Shift, Cmd }, key } — открытый редактор

    function hotkeyModNames() { return isMac() ? ["Ctrl", "Alt", "Shift", "Cmd"] : ["Ctrl", "Alt", "Shift"]; }

    function modLabel(m) { return isMac() ? MAC_MODS[m] + " " + (m === "Alt" ? "Option" : m) : m; }

    function startHotkeyEdit(id) {
        var map = parseHotkeys(settings.hotkeys), parts = map[id] ? map[id].split("+") : [], mods = {};
        parts.slice(0, -1).forEach(function (m) { mods[m] = true; });
        hotkeyEdit = { id: id, mods: mods, key: parts.length ? parts[parts.length - 1] : "" };
        ui.hotkeyNote.textContent = "";
        registerAllKeys();
        renderHotkeys();
        ui.hotkeys.querySelector('[data-action="' + id + '"]').focus();
    }

    function stopHotkeyEdit() {
        if (!hotkeyEdit) { return; }
        hotkeyEdit = null;
        registerHotkeys();
        renderHotkeys();
    }

    function editorCombo() {
        var parts = [];
        if (!hotkeyEdit.key) { return ""; }
        ["Ctrl", "Alt", "Shift", "Cmd"].forEach(function (m) { if (hotkeyEdit.mods[m]) { parts.push(m); } });
        parts.push(hotkeyEdit.key);
        return parts.join("+");
    }

    // Записывает сочетание действию и сразу сохраняет. Пустая строка — убрать сочетание.
    function setHotkey(id, combo) {
        var map = parseHotkeys(settings.hotkeys), k, taken = null, text;
        if (combo) {
            combo = normalCombo(combo);
            if (!combo) {
                ui.hotkeyNote.textContent = "Нужно сочетание с " + (isMac() ? "Cmd, Ctrl или Option" : "Ctrl или Alt") + " (F1–F12 — можно без них).";
                return false;
            }
            if (/^(Ctrl|Cmd)\+[A-Z]$/.test(combo) && HOTKEY_RESERVED[combo.slice(-1)]) {
                ui.hotkeyNote.textContent = comboLabel(combo) + " занято: копирование, вставка и отмена должны работать как обычно.";
                return false;
            }
            for (k in map) {
                if (map.hasOwnProperty(k) && k !== id && map[k] === combo) { map[k] = ""; taken = k; }
            }
        }
        map[id] = combo || "";
        text = hotkeysText(map);
        settings.hotkeys = text;
        if (draft) { draft.hotkeys = text; }
        storeSettings(settings);
        hotkeyHint();
        hotkeyEdit = null;
        registerHotkeys();
        ui.hotkeyNote.textContent = taken ? comboLabel(combo) + " было у «" + HOTKEY_ACTIONS.filter(function (a) { return a.id === taken; })[0].label + "» — там теперь пусто." : "";
        renderHotkeys();
        return true;
    }

    function renderHotkeyEditor() {
        var box = document.createElement("div");
        var hint = document.createElement("p");
        var mods = document.createElement("div");
        var key = document.createElement("select");
        var actions = document.createElement("div");
        var ok = document.createElement("button");
        var clear = document.createElement("button");
        var cancel = document.createElement("button");
        box.className = "hotkey-edit";
        hint.textContent = "Нажмите сочетание на клавиатуре — или выберите клавиши ниже и нажмите «Готово».";
        mods.className = "frames hotkey-mods";
        hotkeyModNames().forEach(function (m) {
            var b = document.createElement("button");
            b.textContent = modLabel(m);
            b.setAttribute("data-mod", m);
            b.setAttribute("aria-pressed", hotkeyEdit.mods[m] ? "true" : "false");
            b.addEventListener("click", function () {
                hotkeyEdit.mods[m] = !hotkeyEdit.mods[m];
                b.setAttribute("aria-pressed", hotkeyEdit.mods[m] ? "true" : "false");
            });
            mods.appendChild(b);
        });
        key.className = "hotkey-key";
        key.setAttribute("aria-label", "Клавиша");
        [""].concat(HOTKEY_KEYS).forEach(function (k) {
            var o = document.createElement("option");
            o.value = k;
            o.textContent = k === "" ? "Клавиша…" : k;
            key.appendChild(o);
        });
        key.value = hotkeyEdit.key;
        key.addEventListener("change", function () { hotkeyEdit.key = key.value; });
        mods.appendChild(key);
        actions.className = "hotkey-actions";
        ok.className = "primary";
        ok.textContent = "Готово";
        ok.addEventListener("click", function () { setHotkey(hotkeyEdit.id, editorCombo() || "x"); });
        clear.className = "ghost";
        clear.textContent = "Убрать";
        clear.addEventListener("click", function () { setHotkey(hotkeyEdit.id, ""); });
        cancel.className = "ghost";
        cancel.textContent = "Отмена";
        cancel.addEventListener("click", function () { ui.hotkeyNote.textContent = ""; stopHotkeyEdit(); });
        actions.appendChild(ok);
        actions.appendChild(clear);
        actions.appendChild(cancel);
        box.appendChild(hint);
        box.appendChild(mods);
        box.appendChild(actions);
        return box;
    }

    function renderHotkeys() {
        var map = parseHotkeys(settings.hotkeys);
        ui.hotkeys.innerHTML = "";
        HOTKEY_ACTIONS.forEach(function (a) {
            var row = document.createElement("div");
            var label = document.createElement("span");
            var btn = document.createElement("button");
            var editing = hotkeyEdit && hotkeyEdit.id === a.id;
            row.className = "hotkey-row";
            label.textContent = a.label;
            btn.className = "hotkey-btn" + (map[a.id] ? "" : " empty") + (editing ? " recording" : "");
            btn.setAttribute("data-action", a.id);
            btn.textContent = editing ? "Нажмите сочетание…" : comboLabel(map[a.id]);
            btn.title = "Изменить сочетание";
            btn.addEventListener("click", function () {
                if (hotkeyEdit && hotkeyEdit.id === a.id) { stopHotkeyEdit(); } else { startHotkeyEdit(a.id); }
            });
            row.appendChild(label);
            row.appendChild(btn);
            ui.hotkeys.appendChild(row);
            if (editing) { ui.hotkeys.appendChild(renderHotkeyEditor()); }
        });
    }

    // Нажатие на клавиатуре, пока открыт редактор.
    function captureHotkey(e) {
        var plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
        if (/^(Control|Alt|Shift|Meta|OS)/.test(e.key)) { return; }   // ждём саму клавишу
        if (e.key === "Tab" || (plain && (e.key === "Enter" || e.key === " ") && e.target && e.target.tagName === "BUTTON" && !e.target.classList.contains("hotkey-btn"))) { return; }
        if (e.target && e.target.tagName === "SELECT" && plain) { return; }
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape" && plain) { ui.hotkeyNote.textContent = ""; stopHotkeyEdit(); return; }
        if ((e.key === "Backspace" || e.key === "Delete") && plain) { setHotkey(hotkeyEdit.id, ""); return; }
        setHotkey(hotkeyEdit.id, comboOf(e) || "x");
    }

    // Пока открыт редактор, просим After Effects отдавать панели все сочетания с модификаторами,
    // иначе на Mac программа забирает себе те, что есть в её меню, и до панели они не доходят.
    function registerAllKeys() {
        var cep = window.__adobe_cep__, list = [], i, k, code;
        if (!cep || typeof cep.registerKeyEventsInterest !== "function") { return; }
        for (k = 0; k < HOTKEY_KEYS.length; k++) {
            code = keyCodeOf(HOTKEY_KEYS[k]);
            if (code === null) { continue; }
            for (i = 0; i < 16; i++) {
                list.push({ keyCode: code, ctrlKey: !!(i & 1), altKey: !!(i & 2), shiftKey: !!(i & 4), metaKey: !!(i & 8) });
            }
        }
        try { cep.registerKeyEventsInterest(JSON.stringify(list)); } catch (e) {}
    }

    // Mac: After Effects сам обрабатывает сочетания из своего меню, даже когда активна панель.
    // Здесь панель говорит программе, какие сочетания отдавать ей.
    var MAC_KEYCODES = { A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17,
        1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, "=": 24, 9: 25, 7: 26, "-": 27, 8: 28, 0: 29, "]": 30, O: 31, U: 32, "[": 33, I: 34, P: 35,
        Enter: 36, L: 37, J: 38, "'": 39, K: 40, ";": 41, "\\": 42, ",": 43, "/": 44, N: 45, M: 46, ".": 47, Space: 49, "`": 50,
        F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
        Left: 123, Right: 124, Down: 125, Up: 126, Home: 115, End: 119, PageUp: 116, PageDown: 121 };
    var WIN_KEYCODES = { Space: 32, Enter: 13, Left: 37, Up: 38, Right: 39, Down: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34,
        ";": 186, "=": 187, ",": 188, "-": 189, ".": 190, "/": 191, "`": 192, "[": 219, "\\": 220, "]": 221, "'": 222 };

    function keyCodeOf(key) {
        if (isMac()) { return MAC_KEYCODES.hasOwnProperty(key) ? MAC_KEYCODES[key] : null; }
        if (/^[A-Z0-9]$/.test(key)) { return key.charCodeAt(0); }
        if (/^F\d+$/.test(key)) { return 111 + Number(key.slice(1)); }
        return WIN_KEYCODES.hasOwnProperty(key) ? WIN_KEYCODES[key] : null;
    }

    function registerHotkeys() {
        var cep = window.__adobe_cep__, map = parseHotkeys(settings.hotkeys), list = [], k, parts, code;
        watchHostHotkeys(map);
        if (!cep || typeof cep.registerKeyEventsInterest !== "function") { return; }
        for (k in map) {
            if (!map.hasOwnProperty(k) || !map[k]) { continue; }
            parts = map[k].split("+");
            code = keyCodeOf(parts[parts.length - 1]);
            if (code === null) { continue; }
            list.push({ keyCode: code, ctrlKey: parts.indexOf("Ctrl") >= 0, altKey: parts.indexOf("Alt") >= 0,
                shiftKey: parts.indexOf("Shift") >= 0, metaKey: parts.indexOf("Cmd") >= 0 });
        }
        try { cep.registerKeyEventsInterest(JSON.stringify(list)); } catch (e) {}
    }

    // Сочетания вне панели: After Effects отдаёт клавиши только той панели, на которой фокус, поэтому
    // хост несколько раз в секунду смотрит, какие клавиши зажаты, и присылает панели событие.
    // Как и в FX Console, сочетание нужно чуть подержать.
    var HOST_KEY_EVENT = "com.sayframe.hotkey";
    var lastPanelHotkey = { id: "", at: 0 };

    function watchHostHotkeys(map) {
        var list = [], k, parts;
        for (k in map) {
            if (!map.hasOwnProperty(k) || !map[k]) { continue; }
            parts = map[k].split("+");
            list.push({ id: k, key: parts[parts.length - 1], ctrl: parts.indexOf("Ctrl") >= 0, alt: parts.indexOf("Alt") >= 0,
                shift: parts.indexOf("Shift") >= 0, cmd: parts.indexOf("Cmd") >= 0 });
        }
        host("setHotkeys", [list]).catch(function () {});
    }

    function onHostHotkey(ev) {
        var id = ev && ev.data !== undefined ? String(ev.data) : "";
        if (!id || !HOTKEY_ACTIONS.some(function (a) { return a.id === id; })) { return; }
        if (!ui.sheet.hidden || !ui.modal.hidden) { return; }
        // Панель уже сама поймала это нажатие.
        if (lastPanelHotkey.id === id && Date.now() - lastPanelHotkey.at < 800) { return; }
        try { window.focus(); } catch (e) {}
        runHotkey(id);
    }

    function listenHostHotkeys() {
        var cep = window.__adobe_cep__;
        if (cep && typeof cep.addEventListener === "function") {
            try { cep.addEventListener(HOST_KEY_EVENT, onHostHotkey); } catch (e) {}
        }
    }

    function hotkeyHint() {
        var combo = parseHotkeys(settings.hotkeys).console;
        ui.fxBtn.title = "Поиск эффектов" + (combo ? " (" + comboLabel(combo) + ")" : "");
        ui.fxKeysCombo.textContent = combo ? comboLabel(combo) : "не задано";
    }

    // Из окна поиска — сразу к настройке его сочетания.
    function onFxKeys() {
        closeFxConsole();
        openSettings();
        if (ui.sheet.hidden) { return; }
        showSetPane("other");
        startHotkeyEdit("console");
        ui.hotkeys.scrollIntoView({ block: "center" });
    }

    // ---- порядок в проекте: всё из окна Project — по папкам. Двигаются только сами элементы внутри проекта.

    var ORGANIZE_LABELS = [
        ["Compositions", "композиции"], ["Precomps", "прекомпозиции"], ["Videos", "видео"], ["Audio", "аудио"],
        ["Images", "картинки"], ["Solids", "солиды"], ["Assets", "ресурсы"], ["Other", "прочее"]
    ];

    function organizeReport(o) {
        var parts = [];
        var i, n;
        if (!o.total) { return "Project organized successfully\nВ проекте пока нечего раскладывать."; }
        if (!o.moved) { return "Project organized successfully\nВсё уже лежало по своим папкам."; }
        for (i = 0; i < ORGANIZE_LABELS.length; i++) {
            n = o.counts[ORGANIZE_LABELS[i][0]];
            if (n) { parts.push(ORGANIZE_LABELS[i][1] + " " + n); }
        }
        return "Project organized successfully\nПеремещено: " + parts.join(", ") + "." +
            (o.created.length ? " Новые папки: " + o.created.join(", ") + "." : "") +
            " Отменить — Cmd/Ctrl+Z.";
    }

    async function onOrganize() {
        var res;
        if (busy) { return; }
        setBusy(true);
        setStatus("Навожу порядок в проекте…", "busy");
        try {
            res = await host("organizeProject", []);
            setBusy(false);
            setStatus(organizeReport(res.organized), "done");
        } catch (e) {
            setBusy(false);
            setStatus("Не удалось навести порядок: " + humanError(e), "error");
        }
    }

    // Замечания вроде «ничего не выделено» — подсказка, а не ошибка.
    function toolFailed(e) {
        var m = e && e.message ? e.message : String(e);
        var hint = m === "NO_ACTIVE_COMP" || m === "NO_KEYS_SELECTED" || m === "NO_LAYERS_SELECTED" || m === "ALIGN_NEEDS_TWO" || m === "DISTRIBUTE_NEEDS_THREE" || m === "STAGGER_NEEDS_TWO" || m === "STAGGER_NO_KEYS";
        setBusy(false);
        setStatus(humanError(e), hint ? "" : "error");
    }

    // mode: "both"; хост умеет ещё "in" и "out" (только одна сторона ключа), кнопок для них в панели нет.
    function onEase(mode) {
        if (busy) { return; }
        // Кнопка применяет те же значения, что и ожидающий «живой» запрос от ползунка: он больше не нужен.
        liveEase.pending = false;
        liveEaseMark();
        setBusy(true);
        setStatus("Применяю плавность…", "busy");
        host("ease", [motion.easeIn, motion.easeOut, mode]).then(function (res) {
            setBusy(false);
            showEaseResult(res);
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

    function onDistribute(edge) {
        if (busy) { return; }
        setBusy(true);
        setStatus("Распределяю…", "busy");
        host("distribute", [edge]).then(function (res) {
            var parts = [];
            setBusy(false);
            if (res.moved) { parts.push("Распределено: " + plural(res.spread, "слой", "слоя", "слоёв") + "."); }
            else if (!res.failed) { parts.push("Слои уже стоят через равные промежутки."); }
            if (res.skipped) { parts.push("Пропущено: " + plural(res.skipped, "слой", "слоя", "слоёв") + " (3D-слой, камера или свет)."); }
            if (res.failed) { parts.push("Не получилось: " + plural(res.failed, "слой", "слоя", "слоёв") + " (слой заблокирован?)."); }
            setStatus(parts.join(" ") + (res.moved ? "\nОтменить: Cmd/Ctrl+Z." : ""), res.moved ? "done" : res.failed ? "error" : "");
        }).catch(toolFailed);
    }

    // ---- сдвиг во времени: появление, исчезновение или слой целиком

    function drawShift() {
        ui.shiftWhat.value = motion.shiftWhat;
        ui.shiftStep.value = String(motion.shiftStep);
        ui.timeAlign.value = motion.timeAlign;
        ui.staggerWhat.value = motion.staggerWhat;
        ui.staggerStep.value = String(motion.staggerStep);
        ui.staggerOrder.value = motion.staggerOrder;
    }

    // Набранное число кадров; мусор возвращает прежнее значение.
    function onStepNumber(input, key) {
        var text = String(input.value).replace(/\s/g, "");
        if (/^\d{1,3}$/.test(text) && Number(text) >= 1) { motion[key] = clampStep(text); storeMotion(); }
        input.value = String(motion[key]);
    }

    // Общий отчёт: сколько слоёв сдвинуто, сколько пропущено и почему.
    function showShiftResult(res, what, done) {
        var parts = [];
        if (res.moved) { parts.push(done); }
        if (res.unchanged && !res.steps) { parts.push("Уже на месте: " + plural(res.unchanged, "слой", "слоя", "слоёв") + "."); }
        if (res.skipped) { parts.push("Пропущено: " + plural(res.skipped, "слой", "слоя", "слоёв") + " (нет ключей " + (what === "out" ? "во второй" : "в первой") + " половине слоя)."); }
        if (res.failed) { parts.push("Не получилось: " + plural(res.failed, "слой", "слоя", "слоёв") + " (слой заблокирован?)."); }
        if (res.keysFailed && !res.failed) { parts.push("Не удалось перенести: " + plural(res.keysFailed, "ключ", "ключа", "ключей") + "."); }
        if (!parts.length) { parts.push("Нечего сдвигать."); }
        setStatus(parts.join(" ") + (res.moved ? "\nОтменить: Cmd/Ctrl+Z." : ""), res.moved ? "done" : res.failed ? "error" : "");
    }

    function onShift(direction) {
        var what = motion.shiftWhat;
        var frames = motion.shiftStep;
        if (busy) { return; }
        setBusy(true);
        setStatus("Сдвигаю…", "busy");
        host("shift", [what, direction * frames]).then(function (res) {
            setBusy(false);
            showShiftResult(res, what, "Сдвинуто на " + plural(frames, "кадр", "кадра", "кадров") + (direction > 0 ? " позже: " : " раньше: ") + plural(res.moved, "слой", "слоя", "слоёв") + ".");
        }).catch(toolFailed);
    }

    function onTimeAlign() {
        var point = motion.timeAlign;
        if (busy) { return; }
        setBusy(true);
        setStatus("Ставлю на указатель…", "busy");
        host("alignTime", [point]).then(function (res) {
            setBusy(false);
            showShiftResult(res, point.indexOf("out") === 0 ? "out" : "in", "Поставлено на указатель времени: " + plural(res.moved, "слой", "слоя", "слоёв") + ".");
        }).catch(toolFailed);
    }

    function onStagger() {
        var what = motion.staggerWhat;
        var frames = motion.staggerStep;
        if (busy) { return; }
        setBusy(true);
        setStatus("Делаю лесенку…", "busy");
        host("stagger", [what, frames, motion.staggerOrder]).then(function (res) {
            setBusy(false);
            showShiftResult(res, what, "Лесенка: " + plural(res.steps, "слой", "слоя", "слоёв") + ", шаг " + plural(frames, "кадр", "кадра", "кадров") + ".");
        }).catch(toolFailed);
    }

    function enableShiftTool() {
        var infos = ui.motionTools.querySelectorAll(".tool-info");
        var i;
        function pick(select, key, allowed) {
            select.addEventListener("change", function () {
                motion[key] = allowed.indexOf(select.value) >= 0 ? select.value : MOTION_DEFAULTS[key];
                storeMotion();
                showFoldParts();
            });
        }
        drawShift();
        pick(ui.shiftWhat, "shiftWhat", SHIFT_TARGETS);
        pick(ui.timeAlign, "timeAlign", TIME_POINTS);
        pick(ui.staggerWhat, "staggerWhat", SHIFT_TARGETS);
        pick(ui.staggerOrder, "staggerOrder", STAGGER_ORDERS);
        ui.shiftStep.addEventListener("change", function () { onStepNumber(ui.shiftStep, "shiftStep"); });
        ui.staggerStep.addEventListener("change", function () { onStepNumber(ui.staggerStep, "staggerStep"); });
        [ui.shiftStep, ui.staggerStep].forEach(function (input) {
            input.addEventListener("keydown", function (e) {
                if (e.key === "Enter") { input.blur(); }
                if (e.key === "Escape") { input.value = String(motion[input === ui.shiftStep ? "shiftStep" : "staggerStep"]); input.blur(); }
            });
            input.addEventListener("focus", function () { input.select(); });
        });
        ui.shiftBack.addEventListener("click", function () { onShift(-1); });
        ui.shiftFwd.addEventListener("click", function () { onShift(1); });
        ui.timeAlignBtn.addEventListener("click", onTimeAlign);
        ui.staggerBtn.addEventListener("click", onStagger);
        // «i» рядом со списком: объяснение появляется в строке состояния (и во всплывающей подсказке).
        for (i = 0; i < infos.length; i++) {
            infos[i].addEventListener("click", function () {
                if (!busy) { setStatus(this.getAttribute("data-info"), ""); }
            });
        }
    }

    // ---- сетка блоков раздела «Инструменты»

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

    function cardByName(name) {
        return ui.motionTools.querySelector('.tool-card[data-tool="' + name + '"]');
    }

    // Ползунок, число, кнопка или список: двойной щелчок по ним — работа с ними, а не просьба о перестановке.
    function isToolControl(node, card) {
        while (node && node !== card) {
            if (/^(INPUT|BUTTON|SELECT|TEXTAREA|LABEL|A|OPTION)$/.test(node.nodeName)) { return true; }
            node = node.parentNode;
        }
        return false;
    }

    function isResizeHandle(node) {
        return !!(node && node.getAttribute && node.getAttribute("data-resize"));
    }

    // Сколько клеток помещается в ширину панели. 0 — раздел сейчас не виден.
    function gridCols() {
        var m = gridModule();
        var width = ui.motionTools.clientWidth;
        if (!width) { return 0; }
        return Math.max(1, Math.floor((width + m.gap) / (m.cell + m.gap)));
    }

    var lastLayout = null;   // { cols, pos: { name: { x, y, w, h } } } — как блоки стоят сейчас

    // Раскладывает блоки по сетке. places — места блоков (или null: по порядку, с переносом),
    // first — блок, который при споре за клетку получает её (его тянут или растягивают).
    function layoutTools(places, first) {
        var m = gridModule();
        var step = m.cell + m.gap;
        var cols = gridCols();
        var names = motion.order.split(",");
        var cards = {};
        var items = [];
        var taken = [];
        var pos = {};
        var pins = pinList();
        var i, it, card, z, h, rows, sorted, pinned, rest, base;

        if (!cols) { return null; }
        ui.motionTools.style.gridTemplateColumns = "repeat(" + cols + ", " + m.cell + "px)";
        ui.motionTools.style.gridAutoRows = m.cell + "px";
        ui.motionTools.style.gap = m.gap + "px";

        function free(r0, c0, w, hh) {
            var a, b;
            for (a = r0; a < r0 + hh; a++) {
                if (!taken[a]) { continue; }
                for (b = c0; b < c0 + w; b++) { if (taken[a][b]) { return false; } }
            }
            return true;
        }
        function take(name, r0, c0, w, hh) {
            var a, b;
            for (a = r0; a < r0 + hh; a++) {
                if (!taken[a]) { taken[a] = []; }
                for (b = c0; b < c0 + w; b++) { taken[a][b] = true; }
            }
            pos[name] = { x: c0, y: r0, w: w, h: hh };
        }
        // Раскладывает группу блоков не выше ряда top; возвращает ряд под самым нижним из них.
        function placeGroup(group, top) {
            var r, c, j, g, q, list, bottom = top;
            if (!places) {
                // По порядку, как текст: блок встаёт правее предыдущего, а если не влезает — в начало следующего ряда.
                r = top;
                c = 0;
                for (j = 0; j < group.length; j++) {
                    g = group[j];
                    for (;;) {
                        if (c + g.w > cols) { r++; c = 0; }
                        if (free(r, c, g.w, g.h)) { break; }
                        c++;
                    }
                    take(g.name, r, c, g.w, g.h);
                    c += g.w;
                }
            } else {
                // По местам: каждый блок стоит на своей клетке; если она занята блоком выше, он сдвигается вниз.
                list = group.slice();
                for (j = 0; j < list.length; j++) {
                    // Блок без места (например, новый в этой версии) встаёт в первую свободную клетку слева сверху.
                    q = places[list[j].name];
                    list[j].free = !q;
                    list[j].x = q ? Math.min(q.x, cols - list[j].w) : 0;
                    list[j].y = q ? q.y : 100000 + j;
                }
                list.sort(function (a, b) {
                    if (a.y !== b.y) { return a.y - b.y; }
                    if (a.name === first || b.name === first) { return a.name === first ? -1 : 1; }
                    return a.x !== b.x ? a.x - b.x : a.index - b.index;
                });
                for (j = 0; j < list.length; j++) {
                    g = list[j];
                    r = Math.max(top, g.free ? 0 : Math.min(g.y, 999));
                    while (!free(r, g.x, g.w, g.h)) { r++; }
                    take(g.name, r, g.x, g.w, g.h);
                }
            }
            for (j = 0; j < group.length; j++) {
                q = pos[group[j].name];
                if (q.y + q.h > bottom) { bottom = q.y + q.h; }
            }
            return bottom;
        }

        // Ширина каждого блока, затем высота его содержимого при этой ширине: меньше неё блок не бывает.
        for (i = 0; i < names.length; i++) {
            card = cardByName(names[i]);
            if (!card) { continue; }
            cards[names[i]] = card;
            z = sizeOf(names[i]);
            it = { name: names[i], index: i, w: Math.min(Math.max(z.w, Math.min(TOOL_MIN_COLS, cols)), cols), h: z.h };
            card.style.gridColumn = "1 / span " + it.w;
            card.style.gridRow = "1 / span 1";
            card.style.alignSelf = "start";
            items.push(it);
        }
        for (i = 0; i < items.length; i++) {
            rows = Math.max(1, Math.ceil((cards[items[i].name].offsetHeight + m.gap) / step));
            items[i].need = rows;
            items[i].h = Math.min(Math.max(items[i].h, rows), TOOL_MAX_ROWS);
        }

        // Закреплённые блоки (булавка) стоят сверху, остальные — под ними, ниже тонкой линии.
        pinned = items.filter(function (x) { return pins.indexOf(x.name) >= 0; });
        rest = items.filter(function (x) { return pins.indexOf(x.name) < 0; });
        base = placeGroup(pinned, 0);
        if (!pinned.length) { base = 0; }
        placeGroup(rest, base);

        // Блоки на свои клетки; в документе — в порядке чтения, чтобы Tab шёл по ним так же.
        sorted = items.slice().sort(function (a, b) {
            var p = pos[a.name], q = pos[b.name];
            return p.y !== q.y ? p.y - q.y : p.x - q.x;
        });
        rows = 0;
        for (i = 0; i < sorted.length; i++) {
            it = pos[sorted[i].name];
            card = cards[sorted[i].name];
            card.style.gridColumn = (it.x + 1) + " / span " + it.w;
            card.style.gridRow = (it.y + 1) + " / span " + it.h;
            card.style.alignSelf = "";
            card.setAttribute("data-cells", it.w + "x" + it.h);
            if (it.y + it.h > rows) { rows = it.y + it.h; }
        }
        reorderCards(sorted, cards);
        h = rows;
        ui.gridCells.style.width = (cols * step - m.gap) + "px";
        ui.gridCells.style.height = (h * step - m.gap) + "px";
        ui.gridCells.style.backgroundSize = step + "px " + step + "px";
        ui.gridCells.style.backgroundImage = 'url("data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="' + step + '" height="' + step + '"><rect x="0.5" y="0.5" width="' + (m.cell - 1) +
            '" height="' + (m.cell - 1) + '" rx="' + Math.round(m.cell / 5) + '" fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.13)" stroke-dasharray="3 3"/></svg>') + '")';
        if (pinned.length && rest.length) {
            ui.pinLine.hidden = false;
            ui.pinLine.style.top = Math.round(base * step - m.gap / 2) + "px";
            ui.pinLine.style.width = (cols * step - m.gap) + "px";
        } else {
            ui.pinLine.hidden = true;
        }
        lastLayout = { cols: cols, step: step, pos: pos, need: {}, pinRows: pinned.length ? base : 0 };
        for (i = 0; i < items.length; i++) { lastLayout.need[items[i].name] = items[i].need; }
        return lastLayout;
    }

    // Порядок блоков в документе меняется, только если он правда другой; фокус при этом не теряется.
    function reorderCards(sorted, cards) {
        var now = toolCards();
        var same = now.length === sorted.length;
        var active = document.activeElement;
        var i;
        for (i = 0; same && i < now.length; i++) { same = now[i] === cards[sorted[i].name]; }
        if (same) { return; }
        for (i = 0; i < sorted.length; i++) { ui.motionTools.appendChild(cards[sorted[i].name]); }
        if (active && active !== document.body && ui.motionTools.contains(active) && document.activeElement !== active) {
            try { active.focus(); } catch (e) {}
        }
    }

    function placesNow() {
        return motion.places ? parsePlaces(motion.places) : null;
    }

    var toolGridReady = false;

    function relayoutTools() {
        if (toolGridReady) { layoutTools(placesNow(), null); }
    }

    // Запоминает, где блоки стоят сейчас: с этого момента они держат свои клетки.
    function storeLayout(fixed) {
        var names = [];
        var cards = toolCards();
        var places = {};
        var i, q;
        for (i = 0; i < cards.length; i++) { names.push(cards[i].getAttribute("data-tool")); }
        motion.order = cleanToolOrder(names.join(","));
        if (fixed && lastLayout) {
            for (i = 0; i < TOOL_NAMES.length; i++) {
                q = lastLayout.pos[TOOL_NAMES[i]];
                if (q) { places[TOOL_NAMES[i]] = { x: q.x, y: q.y }; }
            }
            motion.places = placesText(places);
        }
        storeMotion();
    }

    // Где блоки стоят сейчас, с размерами: { name: { x, y, w, h } }.
    function currentPlaces() {
        var out = {};
        var i, q;
        for (i = 0; i < TOOL_NAMES.length; i++) {
            q = lastLayout && lastLayout.pos[TOOL_NAMES[i]];
            if (q) { out[TOOL_NAMES[i]] = { x: q.x, y: q.y, w: q.w, h: q.h }; }
        }
        return out;
    }

    // Ставит блок на клетку (x, y) и раскладывает остальные. Блок, на чьё место он встал,
    // переходит на освободившееся место — блоки меняются местами. Возвращает, где блок оказался.
    function moveToolTo(name, x, y, base) {
        var places = {};
        var me = base[name];
        var k, o;
        x = Math.max(0, x);
        y = Math.max(0, y);
        for (k in base) {
            if (!base.hasOwnProperty(k)) { continue; }
            o = base[k];
            places[k] = { x: o.x, y: o.y };
            if (k !== name && me && x < o.x + o.w && o.x < x + me.w && y < o.y + o.h && o.y < y + me.h) {
                places[k] = { x: me.x, y: me.y };
            }
        }
        places[name] = { x: x, y: y };
        motion.places = placesText(places);
        return layoutTools(places, name).pos[name];
    }

    // Клавиатура: блок на клетку в любую сторону; если там другой блок — они меняются местами.
    function nudgeTool(card, dx, dy) {
        var name = card.getAttribute("data-tool");
        var base, me, tx, ty, k, o, now;
        if (!lastLayout) { return false; }
        base = currentPlaces();
        me = base[name];
        tx = me.x + dx;
        ty = me.y + dy;
        if (tx < 0 || ty < 0 || tx + me.w > lastLayout.cols) { return false; }
        for (k in base) {
            if (!base.hasOwnProperty(k) || k === name) { continue; }
            o = base[k];
            if (tx < o.x + o.w && o.x < tx + me.w && ty < o.y + o.h && o.y < ty + me.h) {
                if (dx < 0) { tx = o.x; }
                if (dx > 0) { tx = Math.max(0, o.x + o.w - me.w); }
                if (dy) { ty = o.y; }
                break;
            }
        }
        now = moveToolTo(name, tx, ty, base);
        storeLayout(true);
        return now.x !== me.x || now.y !== me.y;
    }

    // Размер блока в клетках. w: число клеток (TOOL_FULL — на всю ширину), h: 0 — по содержимому.
    function setToolCells(card, w, h) {
        var name = card.getAttribute("data-tool");
        var sizes = parseSizes(motion.sizes);
        var cols = lastLayout ? lastLayout.cols : TOOL_FULL;
        var need = lastLayout && lastLayout.need[name] ? lastLayout.need[name] : 0;
        if (w >= cols) { w = TOOL_FULL; }
        if (w < TOOL_MIN_COLS) { w = TOOL_MIN_COLS; }
        if (h <= need) { h = 0; }
        if (h > TOOL_MAX_ROWS) { h = TOOL_MAX_ROWS; }
        sizes[name] = { w: w, h: h };
        motion.sizes = sizesText(sizes);
        layoutTools(placesNow(), name);
    }

    function enableToolReordering() {
        // На обычных событиях мыши: события указателя (pointer events) в After Effects не срабатывали.
        var drag = null;        // { card, name, offX, offY, x, y, moved, base }
        var dragEndedAt = 0;

        function finish() {
            if (!drag) { return; }
            if (drag.moved) {
                drag.card.className = drag.card.className.replace(/\s*dragging/g, "");
                ui.motionTools.className = ui.motionTools.className.replace(/\s*reordering/g, "");
                storeLayout(true);
                dragEndedAt = Date.now();
            }
            drag = null;
        }

        ui.motionTools.addEventListener("mousedown", function (e) {
            var card = toolOf(e.target);
            var r;
            if (!arranging || !card || e.button !== 0 || isResizeHandle(e.target)) { return; }
            finish();
            r = card.getBoundingClientRect();
            drag = { card: card, name: card.getAttribute("data-tool"), x: e.clientX, y: e.clientY, offX: e.clientX - r.left, offY: e.clientY - r.top, moved: false, base: null, at: "" };
            e.preventDefault();
        });
        ui.motionTools.addEventListener("dragstart", function (e) { e.preventDefault(); });

        // Двойной щелчок по свободному месту блока включает перестановку; по ползунку, числу или кнопке — нет.
        ui.motionTools.addEventListener("dblclick", function (e) {
            var card = toolOf(e.target);
            if (!card || Date.now() - dragEndedAt < 300) { return; }
            // Двойной щелчок по краю блока возвращает ему обычный размер и перестановку не трогает.
            if (isResizeHandle(e.target)) { setToolCells(card, TOOL_DEFAULT_COLS, 0); storeMotion(); return; }
            if (!arranging && isToolControl(e.target, card)) { return; }
            setArranging(!arranging);
        });

        document.addEventListener("mousemove", function (e) {
            var grid, tx, ty, key;
            if (!drag || !lastLayout) { return; }
            if (!drag.moved) {
                if (Math.abs(e.clientX - drag.x) < TOOL_DRAG_START_PX && Math.abs(e.clientY - drag.y) < TOOL_DRAG_START_PX) { return; }
                drag.moved = true;
                drag.base = currentPlaces();
                drag.card.className += " dragging";
                ui.motionTools.className += " reordering";
            }
            e.preventDefault();
            // Левый верхний угол блока прилипает к ближайшей клетке; остальные блоки уступают место.
            grid = ui.motionTools.getBoundingClientRect();
            tx = Math.round((e.clientX - drag.offX - grid.left) / lastLayout.step);
            ty = Math.round((e.clientY - drag.offY - grid.top) / lastLayout.step);
            tx = Math.max(0, Math.min(tx, lastLayout.cols - lastLayout.pos[drag.name].w));
            ty = Math.max(0, ty);
            key = tx + "," + ty;
            if (key === drag.at) { return; }
            drag.at = key;
            moveToolTo(drag.name, tx, ty, drag.base);
        });

        document.addEventListener("mouseup", function () { finish(); }, true);
        window.addEventListener("blur", function () { finish(); });

        // С клавиатуры: фокус на полоске, стрелки двигают блок на клетку.
        ui.motionTools.addEventListener("keydown", function (e) {
            var grip = e.target;
            var dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
            var dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
            var card;
            if ((!dx && !dy) || !grip.className || !/(^|\s)tool-grip(\s|$)/.test(String(grip.className)) || e.metaKey || e.ctrlKey || e.shiftKey) { return; }
            card = toolOf(grip);
            if (!card) { return; }
            e.preventDefault();
            nudgeTool(card, dx, dy);
            grip.focus();
        });
    }

    // ---- размер блоков: за правый край — ширина, за нижний — высота, за угол — обе; по клеткам

    function enableToolResizing() {
        var rs = null;          // { card, mode, left, top }

        function finish() {
            if (!rs) { return; }
            rs.card.className = rs.card.className.replace(/\s*resizing/g, "");
            ui.motionTools.className = ui.motionTools.className.replace(/\s*resizing(-\w+)?/g, "");
            storeLayout(!!motion.places);
            rs = null;
        }

        // Ручки снизу и в углу добавляются к каждому блоку здесь, правая уже есть в разметке.
        toolCards().forEach(function (card) {
            var title = card.getAttribute("aria-label");
            var right = card.querySelector(".tool-resize");
            var bottom = document.createElement("div");
            var corner = document.createElement("div");
            right.setAttribute("data-resize", "x");
            bottom.className = "tool-resize-y";
            bottom.setAttribute("data-resize", "y");
            bottom.setAttribute("role", "separator");
            bottom.setAttribute("aria-orientation", "horizontal");
            bottom.setAttribute("tabindex", "0");
            bottom.setAttribute("aria-label", "Высота блока «" + title + "»");
            bottom.title = "Потяните, чтобы изменить высоту блока. Двойной щелчок — размер по умолчанию";
            corner.className = "tool-resize-xy";
            corner.setAttribute("data-resize", "xy");
            corner.setAttribute("aria-hidden", "true");
            corner.title = "Потяните, чтобы изменить ширину и высоту блока";
            card.appendChild(bottom);
            card.appendChild(corner);
        });

        function cellsAt(e) {
            var step = lastLayout.step;
            var gap = gridModule().gap;
            var now = lastLayout.pos[rs.card.getAttribute("data-tool")];
            var w = now.w, h = now.h;
            if (rs.mode !== "y") { w = Math.round((e.clientX - rs.left + gap) / step); }
            if (rs.mode !== "x") { h = Math.round((e.clientY - rs.top + gap) / step); }
            return { w: Math.max(1, w), h: Math.max(1, h) };
        }

        ui.motionTools.addEventListener("mousedown", function (e) {
            var card, r, mode;
            if (e.button !== 0 || !isResizeHandle(e.target)) { return; }
            card = toolOf(e.target);
            if (!card || !lastLayout) { return; }
            finish();
            r = card.getBoundingClientRect();
            mode = e.target.getAttribute("data-resize");
            rs = { card: card, mode: mode, left: r.left, top: r.top, at: "" };
            card.className += " resizing";
            ui.motionTools.className += " resizing resizing-" + mode;
            e.preventDefault();
        });

        document.addEventListener("mousemove", function (e) {
            var z, key;
            if (!rs || !lastLayout) { return; }
            e.preventDefault();
            z = cellsAt(e);
            key = z.w + "x" + z.h;
            if (key === rs.at) { return; }
            rs.at = key;
            setToolCells(rs.card, rs.mode === "y" ? sizeOf(rs.card.getAttribute("data-tool")).w : z.w, rs.mode === "x" ? sizeOf(rs.card.getAttribute("data-tool")).h : z.h);
        });

        document.addEventListener("mouseup", function () { finish(); }, true);
        window.addEventListener("blur", function () { finish(); });

        // С клавиатуры: на правом крае стрелки влево-вправо меняют ширину, на нижнем вверх-вниз — высоту.
        // Home — обычный размер, End — на всю ширину.
        ui.motionTools.addEventListener("keydown", function (e) {
            var card, name, z, now;
            if (!isResizeHandle(e.target) || e.metaKey || e.ctrlKey || e.altKey || !lastLayout) { return; }
            card = toolOf(e.target);
            if (!card) { return; }
            name = card.getAttribute("data-tool");
            z = sizeOf(name);
            now = lastLayout.pos[name];
            if (e.key === "ArrowLeft") { setToolCells(card, now.w - 1, z.h); }
            else if (e.key === "ArrowRight") { setToolCells(card, now.w + 1, z.h); }
            else if (e.key === "ArrowUp") { setToolCells(card, z.w, now.h - 1); }
            else if (e.key === "ArrowDown") { setToolCells(card, z.w, now.h + 1); }
            else if (e.key === "Home") { setToolCells(card, TOOL_DEFAULT_COLS, 0); }
            else if (e.key === "End") { setToolCells(card, TOOL_FULL, z.h); }
            else { return; }
            e.preventDefault();
            storeLayout(!!motion.places);
        });
    }

    // Раздел пересчитывает сетку, когда меняется ширина панели или содержимое блоков.
    function watchToolGrid() {
        var lastWidth = -1;
        toolGridReady = true;
        function check() {
            var w = ui.motionTools.clientWidth;
            if (w !== lastWidth) { lastWidth = w; relayoutTools(); }
        }
        if (typeof window.ResizeObserver === "function") {
            new window.ResizeObserver(check).observe(ui.motionTools);
        }
        window.addEventListener("resize", check);
        if (document.fonts && document.fonts.ready) { document.fonts.ready.then(relayoutTools); }
        ui.arrangeReset.addEventListener("click", function () {
            motion.places = "";
            motion.sizes = "";
            motion.order = MOTION_DEFAULTS.order;
            relayoutTools();
            storeMotion();
        });
    }

    function enableMotion() {
        enableToolReordering();
        enableToolResizing();
        ui.anchorKeys.value = motion.anchorKeys;
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
        enableFolding();
        enablePins();
        ui.easeBothBtn.addEventListener("click", function () { onEase("both"); });
        ui.anchorKeys.addEventListener("change", function () {
            var v = ui.anchorKeys.value;
            motion.anchorKeys = v === "shift" || v === "skip" ? v : "key";
            storeMotion();
        });
        ui.alignTo.value = motion.alignTo;
        enableShiftTool();
        showFoldParts();
        watchToolGrid();
        relayoutTools();
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
        ui.distGrid.addEventListener("click", function (e) {
            var node = e.target;
            while (node && node !== ui.distGrid && !(node.getAttribute && node.getAttribute("data-dist"))) { node = node.parentNode; }
            if (!node || node === ui.distGrid || node.disabled) { return; }
            onDistribute(node.getAttribute("data-dist"));
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
    var dismissedVersion = "";    // какую версию при этом предлагали: о более новой скажем снова
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
        if (updateDismissed && String(offer.info.version) !== dismissedVersion) { updateDismissed = false; }
        // Фоновая проверка не перерисовывает плашку, которая уже показывает эту версию:
        // иначе пропало бы сообщение об ошибке или ходе обновления.
        if (!manual && updateOffer && !ui.updateBar.hidden && String(updateOffer.info.version) === String(offer.info.version)) { return true; }
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
                Date.now() >= state.lastCheck && Date.now() - state.lastCheck < UPDATE_THROTTLE_MS) {
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
        dismissedVersion = updateOffer ? String(updateOffer.info.version) : "";
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
    enableScripts();
    enableQuick();
    enableExpressions();
    ui.refBtn.addEventListener("click", onAttachReference);
    ui.refLinkBtn.addEventListener("click", function () { showLinkRow(ui.refLinkRow.hidden); });
    ui.refLinkCancel.addEventListener("click", function () { showLinkRow(false); });
    ui.refLinkAdd.addEventListener("click", onAttachLink);
    ui.refLink.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); onAttachLink(); }
        if (e.key === "Escape") { e.preventDefault(); showLinkRow(false); }
    });
    ui.refClear.addEventListener("click", onClearReference);
    ui.pasteBtn.addEventListener("click", function () { pasteImage(null); });
    ui.organizeBtn.addEventListener("click", onOrganize);
    ui.fxBtn.addEventListener("click", openFxConsole);
    ui.fxClose.addEventListener("click", closeFxConsole);
    ui.fxSnap.addEventListener("click", onSnapshot);
    ui.fxKeys.addEventListener("mousedown", function (e) { e.preventDefault(); });
    ui.fxKeys.addEventListener("click", onFxKeys);
    ui.fxSearch.addEventListener("input", function () { fxActive = 0; renderFx(); });
    ui.fxSearch.addEventListener("keydown", onFxKey);
    ui.fxConsole.addEventListener("mousedown", function (e) { if (e.target === ui.fxConsole) { closeFxConsole(); } });
    ui.hotkeysReset.addEventListener("click", function () {
        var text = hotkeysText(parseHotkeys(""));
        settings.hotkeys = text;
        if (draft) { draft.hotkeys = text; }
        storeSettings(settings);
        hotkeyEdit = null;
        ui.hotkeyNote.textContent = "";
        registerHotkeys();
        hotkeyHint();
        renderHotkeys();
    });
    ui.setTabAI.addEventListener("click", function () { showSetPane("ai"); });
    ui.setTabOther.addEventListener("click", function () { showSetPane("other"); });
    document.addEventListener("keydown", onHotkeyDown, true);
    enableAc();
    listenHostHotkeys();
    registerHotkeys();
    hotkeyHint();
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

    if (!aiKey()) {
        setStatus("Сначала откройте настройки (значок шестерёнки) и вставьте " + providerOf().keyLabel.replace(/^Ключ/, "ключ") + ".", "");
    }
    announceUpdate();
    ensureHost().catch(function (e) { setStatus(humanError(e), "error"); });
    // Проверка обновлений идёт в фоне и не мешает работе: об ошибках сети молчим.
    // Раньше панель спрашивала сервер только при запуске и не чаще раза в шесть часов, поэтому
    // о свежем выпуске узнавала очень поздно. Теперь — при запуске, раз в несколько минут, пока открыта,
    // и когда в неё возвращаются.
    var backgroundChecking = false;
    function backgroundUpdateCheck() {
        if (updating || backgroundChecking) { return; }
        backgroundChecking = true;
        checkForUpdate(false).catch(function () {}).then(function () { backgroundChecking = false; });
    }
    setTimeout(backgroundUpdateCheck, 1200);
    setInterval(backgroundUpdateCheck, UPDATE_CHECK_EVERY_MS);
    window.addEventListener("focus", backgroundUpdateCheck);
})();
