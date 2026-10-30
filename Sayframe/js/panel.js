/*
 * Sayframe — интерфейс и логика панели (выполняется в HTML-движке After Effects).
 * Со стороны After Effects работает jsx/host.jsx; сюда он возвращает только JSON.
 */
(function () {
    "use strict";

    var VERSION = "1.58.0";
    // Адрес файла version.json с описанием последней версии. Пустая строка выключает проверку обновлений.
    var UPDATE_URL = typeof window.__SAYFRAME_TEST_UPDATE_URL__ === "string" ? window.__SAYFRAME_TEST_UPDATE_URL__ : "https://raw.githubusercontent.com/dalerodinaevb-arch/sayframe/main/version.json";
    // Открытый ключ выпусков (RSA, PEM). version.json подписывает tools/release.py закрытым ключом, который есть
    // только у автора; панель ставит обновление, только если подпись сошлась. Пустая строка — подпись не проверяется.
    var RELEASE_PUBLIC_KEY = typeof window.__SAYFRAME_TEST_UPDATE_KEY__ === "string" ? window.__SAYFRAME_TEST_UPDATE_KEY__ : "-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEApsiGAbh60o5bZxiGsQYN\n8a/1bGysik5YINiRkx2fz3tmcKBQMNVfuWF/+YWitR2ALljg2olLtuG8xE+azU9g\n/BEJ/oeaDzSeDFNSjqKl9gJpGa1FDAuhBNiM2lliCU7Oq0eJC7Jl5JszdkL9K3zq\nMHIqT0uWVGu/QNE71J21SW6KdJgl8G1IEWK4HuARlxVKvhOTUxnomMbchDiXZ9Ui\nWMd0Z1CHEbmKFo60WyRlQFdzqgvAtzl4fMBOcFQCtsoG6eng9xW/6sGZAqvW7b/M\n6vU8oxxuCdCpwS2BY0nsxLsBDL2uHdXn9ag3mTrCa3EIl43G1JRas4Jz7/EcbJ2H\n7cMY3uOkEh/1yF6wN44SQtp7R+Ap1iiM2/tOPYgHAiSZTZVDN8snuCHwLORZMXB0\nmrxJtBhVGA6oiqjUQMKUfdlb6Sm1wN/u+L4WTgaZ67X3nOn6pKHbjR4+Ieny2YEi\n1aGVLVEwMcAjygyNUDjY5mCbom27OLn7AHyqruYGRuHtAgMBAAE=\n-----END PUBLIC KEY-----\n";
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
    var MAX_TOKENS = 16384;     // длинный референс — длинный скрипт: при 8192 он обрывался
    var MAX_HISTORY = 16;
    // Сервер нейросети перегружен или упёрся в лимит ключа (429, 529…): панель ждёт и повторяет запрос.
    var AI_RETRY_MS = window.__SAYFRAME_TEST_RETRY_MS__ || [3000, 8000, 20000];
    var AI_RETRY_STATUS = [429, 500, 502, 503, 504, 529];
    // Цены Claude, долларов за миллион токенов: ввод, вывод, чтение из кэша. Запись в кэш — цена ввода × 1,25.
    var CLAUDE_PRICES = {
        "claude-sonnet-5-5": [2, 10, 0.2],
        "claude-opus-5-5": [4, 20, 0.2],
        "claude-haiku-4-5-20251001": [1, 5, 0.1]
    };
    var SPEND_KEY = "sayframe.spend.v1";
    var MAX_SYNTAX_RETRIES = 2;
    var MAX_CHECK_ROUNDS = 2;
    var FRAME_CHOICES = [6, 8, 12, 16, 24];
    var SETTINGS_KEY = "sayframe.settings.v1";
    // Анонимная статистика: адрес веб-приложения Google Apps Script (tools/stats/Code.gs). Пусто — ничего не отправляется.
    var STATS_URL = "https://script.google.com/macros/s/AKfycbwztwaUNH-e6ujv3hiN_OLrOABwl3qFcso5QenP-cW7jjKQASZsPOWFyGGzFBgDK5oQQg/exec";
    var STATS_KEY = "sayframe.stats.v1";
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
    var BACKGROUNDS = ["#0b0c12", "#17110b", "#0b1510", "#0b1219", "#140d17", "#101014"];

    var DEFAULTS = {
        apiKey: "",
        model: MODELS[0].id,
        provider: "claude",          // кто пишет скрипты: "claude" или "openai" (ChatGPT)
        openaiKey: "",
        openaiModel: OPENAI_MODELS[0].id,
        accent: ACCENTS[0],
        bg: BACKGROUNDS[0],          // фон раздела AI (и прежний общий «цвет фона»)
        bgTools: "#17110b",          // фон раздела «Анимация»
        bgMotion: "#0b1510",         // фон раздела «Инструменты»
        bgShape: "#0b1219",          // фон раздела «Шейп»
        bgBrand: "#130f17",          // фон раздела «Проекты»
        selfCheck: true,
        alwaysAsk: false,
        brandPics: false,   // отправлять ли AI маленькие картинки упомянутых логотипов и иконок
        motionStyle: "normal",  // стиль анимации для AI: normal, smooth, energetic, minimal, corporate, playful
        refFrames: 8,
        panelFit: true,     // поля и кнопки тянутся на всю ширину панели; false — держат ширину panelWidth у левого края
        panelWidth: 380,    // ширина содержимого в пикселях, когда panelFit выключен
        toolSize: "100",    // масштаб блоков раздела «Инструменты» в процентах: "100", "90", "80", "70", "60" или "50"
        toolTitles: true,   // показывать ли названия блоков раздела «Инструменты»
        stats: true,        // отправлять ли автору анонимный сигнал «установлено» и «открыто сегодня»
        infoTips: true,     // подсказки-окошки при наведении курсора на секунду
        pasteAnywhere: true,    // Cmd/Ctrl+V с картинкой в буфере где угодно в After Effects открывает окно вставки
        fxWhere: "panel",   // где открывается поиск эффектов по сочетанию вне панели: "panel" или "cursor"
        hotkeys: ""         // горячие клавиши: "console=Ctrl+Space;snapshot=;…"; пусто — стандартные
    };
    // Стили анимации: подпись в панели и что это значит для AI (библиотека SF получает то же имя).
    var MOTION_STYLES = [
        { id: "normal", label: "Обычный", note: "" },
        { id: "smooth", label: "Плавный", note: "Smooth and premium, like Apple: longer soft moves with a strong ease-out, no bounce, subtle scale and blur reveals, gentle stagger, calm rhythm." },
        { id: "energetic", label: "Энергичный", note: "Energetic and punchy: fast snappy moves, springs with overshoot, quick stagger, bold scale pops, motion blur, quick cuts between beats." },
        { id: "minimal", label: "Минимализм", note: "Minimal: few things move, small distances, fades and gentle slides, lots of empty space and holds, no bounce, restrained colour." },
        { id: "corporate", label: "Корпоративный", note: "Corporate and clean: confident calm moves, mask wipes and slides, tidy aligned layout, clear readable text, no playful bounce." },
        { id: "playful", label: "Игривый", note: "Playful: bouncy pops with overshoot, a little rotation, lively stagger, cheerful rhythm, elements that react to each other." }
    ];
    function motionStyleOf(id) {
        var i;
        for (i = 0; i < MOTION_STYLES.length; i++) { if (MOTION_STYLES[i].id === id) { return MOTION_STYLES[i]; } }
        return null;
    }

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
        "Motion design (make it look like a professional motion designer did it):",
        "- Nothing moves linearly: things arriving decelerate (ease out), things leaving accelerate (ease in). Elements enter one after another with a small stagger, not all at once. Combine moves (position plus scale or opacity), use a mask wipe or a text animator instead of a plain fade where it fits, give important elements a little overshoot, leave short holds so text can be read, and switch on motion blur for fast moves.",
        "- Typical timing: an element enters in 0.4-0.9 s, a stagger step is 0.04-0.1 s, text stays readable for at least 1.5 s.",
        "- Build the motion with the SF library, which is already loaded (tested recipes, ES3; times in comp seconds; o is an optional object; every recipe returns the layer):",
        "  SF.keys(prop, [[t, v], [t, v], ...], ease) - keys with easing; ease 'out' (default, arriving), 'in' (leaving), 'inout', 'linear', 'hold'.",
        "  SF.spring(prop) - overshoot and settle after the last key.",
        "  SF.fadeIn(layer, t, o) / SF.fadeOut(layer, t, o).",
        "  SF.slideIn(layer, t, {from: 'left'|'right'|'top'|'bottom', dist: px, dur: s, spring: bool}) / SF.slideOut(layer, t, {to: ...}) - move from/to an offset of the layer's current position.",
        "  SF.popIn(layer, t, {dur, spring}) / SF.popOut(layer, t, o) - scale up with an overshoot / scale away.",
        "  SF.wipe(layer, t, {from: 'left'|'right'|'top'|'bottom', dur, feather}) - mask reveal over the layer's own rectangle.",
        "  SF.textIn(textLayer, t, {by: 'chars'|'words'|'lines', style: 'rise'|'fade'|'scale'|'blur', dur}) - text animator, one piece after another. SF.typeOn(textLayer, t, {dur}) - typewriter.",
        "  SF.drawOn(shapeLayer, t, {dur}) - strokes draw themselves (Trim Paths). SF.blurIn(layer, t, {amount, dur}). SF.drift(layer, t, {dur, amount}) - slow push-in.",
        "  SF.stagger(layers, t, step, 'popIn', o) - the same recipe on several layers, each step seconds later. SF.motionBlur(layers) - motion blur on (all layers if omitted). SF.wiggle(prop, freq, amp).",
        "  SF.defaults holds the current style's dur, step and dist; the panel sets the style with SF.style(name) before your script runs - do not call SF.style yourself unless the user asks for a different style.",
        "- Create the layers and set their final look (position, size, colour) first, then animate them with SF. Use plain setValueAtTime only for things SF does not cover, and ease those keys with SF.keys.",
        "",
        "References:",
        "- A user message may start with images: either one reference picture, or frames sampled in chronological order from a reference video, with their timestamps listed in the text.",
        "- Study them closely: layout, shapes, colors, typography, and how each element changes from one frame to the next. You cannot see motion between frames, so infer it from those changes and from the user's words, and use the timestamps to set keyframe times.",
        "- Recreate the WHOLE reference video, from its first frame to its last, not just the opening seconds: the composition must be at least as long as the reference (lengthen the active composition if it is shorter), and every stage you see in the frames (new scenes, elements that appear later, text changes, transitions, the ending) must happen at about the same time as in the reference. Keep animating until the reference ends; do not leave the rest of the timeline static.",
        "- Rebuild the look and motion with native After Effects layers (shapes, text, solids, effects, expressions, keyframes). The reference file is not in the project, so never try to import or use it as footage.",
        "- In your one-sentence summary, say plainly what you approximated or left out (for example real 3D, photo-real materials, complex characters).",
        "",
        "Checking your own work:",
        "- After your script runs, the panel may send you frames of the resulting composition so you can check it. End every script with a line like: var SAYFRAME_CHECK_TIMES = [0, 0.4, 1.2, 3]; listing up to 6 times in seconds that best show the result (the start state, key moments of the motion, the final state). With a reference video, spread these times over its whole length, including its last second.",
        "- Give layers clear, unique names so a later fix script can find them.",
        "- When you receive a [Result check] message, follow the instructions in it.",
        "",
        "Every user message contains a snapshot of the current project state. Use it to refer to real layer names and indexes.",
        "If you are told that your previous script failed, return the full corrected script, not a patch."
    ].join("\n");

    // Скрипт для macOS: сохраняет картинку из буфера обмена в PNG.
    // Аргументы: путь для PNG и путь для файла с результатом (OK, FILE:<путь> или NOIMAGE).
    // Третий аргумент "strict": если в буфере что-то скопировано в самом After Effects (слои, ключи), — NOIMAGE.
    var JXA_CLIPBOARD = [
        'ObjC.import("AppKit");',
        "function run(argv) {",
        "    var out = argv[0];",
        '    var res = "NOIMAGE";',
        "    var pb = $.NSPasteboard.generalPasteboard;",
        '    if (argv[2] === "strict" && /adobe|aftereffects/i.test(ObjC.deepUnwrap(pb.types).join(" "))) {',
        "        if (argv.length > 1) { $(res).writeToFileAtomicallyEncodingError(argv[1], true, $.NSUTF8StringEncoding, null); }",
        "        return res;",
        "    }",
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

    // Скрипт для macOS 14 и новее: встроенное «отделить объект от фона» (Vision).
    // Аргументы: картинка, папка для масок, файл с результатом. Каждая найденная фигура — своя маска
    // mask-0.png, mask-1.png… в размер картинки (белое — объект). Результат: OK <число>, NOVISION или ERR <текст>.
    var JXA_VISION = [
        'ObjC.import("Foundation");',
        'ObjC.import("AppKit");',
        'ObjC.import("CoreImage");',
        "function run(argv) {",
        '    var res = "ERR";',
        "    try { res = cut(argv[0], argv[1]); } catch (e) { res = \"ERR \" + e; }",
        "    $(res).writeToFileAtomicallyEncodingError(argv[2], true, $.NSUTF8StringEncoding, null);",
        "    return res;",
        "}",
        "function cut(src, dir) {",
        '    try { ObjC.import("Vision"); } catch (e) { return "NOVISION"; }',
        '    if (!$.VNGenerateForegroundInstanceMaskRequest || typeof $.VNGenerateForegroundInstanceMaskRequest.alloc === "undefined") { return "NOVISION"; }',
        "    var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(src), $.NSDictionary.dictionary);",
        "    var req = $.VNGenerateForegroundInstanceMaskRequest.alloc.init;",
        "    if (!handler.performRequestsError($.NSArray.arrayWithObject(req), null)) { return \"ERR perform\"; }",
        "    var results = req.results;",
        '    if (results.isNil() || results.count === 0) { return "OK 0"; }',
        "    var obs = results.objectAtIndex(0);",
        "    var all = obs.allInstances;",
        "    var count = Math.min(all.count, 12), n = 0, idx = all.firstIndex, k;",
        "    var ctx = $.CIContext.contextWithOptions($.NSDictionary.dictionary);",
        "    for (k = 0; k < count; k++) {",
        "        var buf = obs.generateScaledMaskForImageForInstancesFromRequestHandlerError($.NSIndexSet.indexSetWithIndex(idx), handler, null);",
        "        var ci = $.CIImage.imageWithCVPixelBuffer(buf);",
        "        var cg = ctx.createCGImageFromRect(ci, ci.extent);",
        "        var rep = $.NSBitmapImageRep.alloc.initWithCGImage(cg);",
        "        var png = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary);",
        '        if (!png.isNil() && png.writeToFileAtomically(dir + "/mask-" + n + ".png", true)) { n++; }',
        "        idx = all.indexGreaterThanIndex(idx);",
        "    }",
        '    return "OK " + n;',
        "}"
    ].join("\n");

    var PS_CLIPBOARD = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
        "$o=[System.Windows.Forms.Clipboard]::GetDataObject(); " +
        "if($args[1] -eq 'strict' -and $o -and (($o.GetFormats() -join ' ') -match 'Adobe|AfterFX|After Effects')){'NOIMAGE'; return} " +
        "$i=[System.Windows.Forms.Clipboard]::GetImage(); " +
        "if($i){$i.Save($args[0],[System.Drawing.Imaging.ImageFormat]::Png); 'OK'} " +
        "else {$f=[System.Windows.Forms.Clipboard]::GetFileDropList(); if($f.Count -gt 0){'FILE:'+$f[0]} else {'NOIMAGE'}}";

    // Сочетания во всём After Effects. Панель слышит клавиши, только пока на ней фокус, а After Effects
    // на Windows не называет зажатую клавишу (keyboardState.keyName пустой). Поэтому рядом с панелью
    // работает маленький наблюдатель: он спрашивает у системы, какие клавиши зажаты, и, если в этот момент
    // впереди After Effects, пишет «HIT id». Аргументы: файл-пульс (панель обновляет его каждые
    // несколько секунд; перестал обновляться — панель закрыта, наблюдатель выходит) и файл со списком сочетаний.
    var JXA_KEYWATCH = [
        'ObjC.import("AppKit");',
        'ObjC.import("ApplicationServices");',
        "function run(argv) {",
        "    var hb = argv[0], keys = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(argv[1], 4, null).js);",
        "    var fm = $.NSFileManager.defaultManager, so = $.NSFileHandle.fileHandleWithStandardOutput;",
        "    var down = '', n = 0, i, k, f, hit, app, at;",
        "    function say(t) { so.writeData($(t + '\\n').dataUsingEncoding(4)); }",
        "    say('READY');",
        // macOS 10.15+: без разрешения «Мониторинг ввода» система не показывает чужие нажатия. Просим его один раз.
        "    try { if (!$.CGPreflightListenEventAccess()) { $.CGRequestListenEventAccess(); say('NOACCESS'); } } catch (e) {}",
        "    while (true) {",
        "        if (n++ % 40 === 0) {",
        "            at = fm.attributesOfItemAtPathError(hb, null);",
        "            if (at.isNil() || new Date() - at.fileModificationDate.js > 15000) { return; }",
        "        }",
        "        f = $.CGEventSourceFlagsState(0);",
        "        hit = '';",
        "        for (i = 0; i < keys.length; i++) {",
        "            k = keys[i];",
        "            if (!!(f & 0x40000) === k.ctrl && !!(f & 0x80000) === k.alt && !!(f & 0x20000) === k.shift && !!(f & 0x100000) === k.cmd &&",
        "                    $.CGEventSourceKeyState(0, k.code)) { hit = k.id; break; }",
        "        }",
        "        if (hit && hit !== down) {",
        "            app = $.NSWorkspace.sharedWorkspace.frontmostApplication;",
        // Где мышь: в точках экрана, от левого верхнего угла главного экрана (как у окон After Effects).
        "            if (/AfterEffects/i.test(app.isNil() ? '' : String(app.bundleIdentifier.js))) {",
        "                var m = $.NSEvent.mouseLocation, h = $.NSScreen.screens.objectAtIndex(0).frame.size.height;",
        "                say('HIT ' + hit + ' ' + Math.round(m.x) + ' ' + Math.round(h - m.y));",
        "            }",
        "        }",
        "        down = hit;",
        "        delay(0.05);",
        "    }",
        "}"
    ].join("\n");
    var PS_KEYWATCH = [
        "param($hb, $list)",
        "Add-Type -Namespace SF -Name K -MemberDefinition '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int v); " +
            "[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); " +
            "[DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p);'",
        // Без @(…): в PowerShell 5 это завернуло бы весь список в ещё один массив.
        "$keys = ConvertFrom-Json (Get-Content -Raw $list)",
        "Add-Type -AssemblyName System.Windows.Forms",
        "function Held($v) { return ([SF.K]::GetAsyncKeyState($v) -band 0x8000) -ne 0 }",
        "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()",
        "$down = ''; $n = 0",
        "while ($true) {",
        "  if ($n % 40 -eq 0) { if (-not (Test-Path $hb) -or ((Get-Date) - (Get-Item $hb).LastWriteTime).TotalSeconds -gt 15) { exit } }",
        "  $n++",
        "  $c = Held 0x11; $a = Held 0x12; $s = Held 0x10; $hit = ''",
        "  foreach ($k in $keys) { if ($c -eq $k.ctrl -and $a -eq $k.alt -and $s -eq $k.shift -and (Held $k.code)) { $hit = $k.id; break } }",
        "  if ($hit -and $hit -ne $down) {",
        "    $p = 0; [void][SF.K]::GetWindowThreadProcessId([SF.K]::GetForegroundWindow(), [ref]$p)",
        "    $name = ''; try { $name = (Get-Process -Id $p).ProcessName } catch {}",
        "    if ($name -match 'AfterFX') { $m = [System.Windows.Forms.Cursor]::Position; [Console]::Out.WriteLine('HIT ' + $hit + ' ' + $m.X + ' ' + $m.Y); [Console]::Out.Flush() }",
        "  }",
        "  $down = $hit",
        "  Start-Sleep -Milliseconds 50",
        "}"
    ].join("\r\n");

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

        // Несколько файлов сразу (иконки). Возвращает массив путей, пустой — если ничего не выбрали.
        function pickFiles(title) {
            var r;
            try {
                if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
                    r = window.cep.fs.showOpenDialogEx(true, false, title, "", []);
                } else if (window.cep && window.cep.fs && window.cep.fs.showOpenDialog) {
                    r = window.cep.fs.showOpenDialog(true, false, title, "", []);
                }
            } catch (e) {
                r = null;
            }
            return Promise.resolve(r && r.data && r.data.length ? Array.prototype.map.call(r.data, String) : []);
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
                pickFiles: pickFiles,
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
                verify: function () { return Promise.resolve(false); },
                postJSON: function (url, headers, body, timeoutMs, onRequest) {
                    var h = {};
                    var k, ctl;
                    for (k in headers) { if (headers.hasOwnProperty(k)) { h[k] = headers[k]; } }
                    h["anthropic-dangerous-direct-browser-access"] = "true";
                    ctl = typeof AbortController === "function" ? new AbortController() : null;
                    if (ctl && onRequest) { onRequest(function () { ctl.abort(); }); }
                    return fetch(url, { method: "POST", headers: h, body: body, signal: ctl ? ctl.signal : undefined }).then(function (res) {
                        return res.text().then(function (text) { return { status: res.status, text: text, retryAfter: res.headers.get("retry-after") || "" }; });
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
            // Долгий процесс: onLine получает каждую строку его вывода, onExit — код выхода и конец текста ошибки.
            spawn: function (file, args, onLine, onExit) {
                var child, rest = "";
                var err = "";
                try { child = cp.spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); } catch (e) { onExit(-1, String(e && e.message || e)); return { kill: function () {} }; }
                child.stderr.on("data", function (d) { err = (err + d.toString("utf8")).slice(-400); });
                child.stdout.on("data", function (d) {
                    var lines = (rest + d.toString("utf8")).split(/\r?\n/);
                    rest = lines.pop();
                    lines.forEach(function (l) { if (l) { onLine(l); } });
                });
                child.on("error", function (e) { onExit(-1, String(e && e.message || e)); });
                child.on("exit", function (code) { onExit(code === null ? -1 : code, err); });
                return { kill: function () { try { child.kill(); } catch (e) {} } };
            },
            pickFile: pickFile,
            pickFiles: pickFiles,
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
            // Подпись выпуска: RSA-SHA256 над текстом, подпись в base64, ключ в PEM.
            verify: function (text, sig, pem) {
                try {
                    return Promise.resolve(crypto.createVerify("RSA-SHA256").update(String(text), "utf8").verify(pem, String(sig), "base64"));
                } catch (e) {
                    return Promise.resolve(false);
                }
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
            // onRequest получает функцию, которая обрывает запрос (кнопка «Стоп»).
            postJSON: function (url, headers, body, timeoutMs, onRequest) {
                return new Promise(function (resolve, reject) {
                    var u = new URL(url);
                    var data = Buf.from(body, "utf8");
                    var h = { "content-length": data.length };
                    var k, rq;
                    for (k in headers) { if (headers.hasOwnProperty(k)) { h[k] = headers[k]; } }
                    rq = https.request({ method: "POST", hostname: u.hostname, port: 443, path: u.pathname, headers: h }, function (res) {
                        var chunks = [];
                        res.on("data", function (c) { chunks.push(c); });
                        res.on("end", function () { resolve({ status: res.statusCode, text: Buf.concat(chunks).toString("utf8"), retryAfter: String(res.headers["retry-after"] || "") }); });
                    });
                    rq.on("error", reject);
                    rq.setTimeout(timeoutMs || 300000, function () { rq.destroy(new Error("TIMEOUT")); });
                    if (onRequest) { onRequest(function () { rq.destroy(new Error("STOPPED")); }); }
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

    var hostReady = {};

    // Проверка: загружен ли host.jsx и есть ли в нём нужная функция. Если панель обновили, а After Effects
    // не перезапускали, в нём может сидеть старый host.jsx без новых функций — тогда перечитываем файл.
    function hostProbe(fn) {
        return "(typeof sayframeHost === 'object' && sayframeHost !== null" +
            (fn ? " && typeof sayframeHost." + fn + " === 'function'" : "") + ") ? 'yes' : 'no'";
    }

    function ensureHost(fn) {
        var key = fn || "";
        if (!hostReady[key]) {
            hostReady[key] = evalScript(hostProbe(fn)).then(function (t) {
                if (t === "yes") { return true; }
                return evalScript("$.evalFile(" + asciiJSON(extensionDir() + "/jsx/host.jsx") + "); " + hostProbe(fn)).then(function (t2) {
                    if (t2 !== "yes") { throw new Error("HOST_NOT_LOADED"); }
                    return true;
                });
            });
            hostReady[key].catch(function () { delete hostReady[key]; });
        }
        return hostReady[key];
    }

    function host(fn, args) {
        return ensureHost(fn).then(function () {
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
        var m = e && e.message ? e.message : String(e), host;
        var ec = /^EC_(COUNT|PROPS):(\d+):(\d+)$/.exec(m);
        if (ec && ec[1] === "COUNT") { return "Скопировано ключей: " + ec[2] + ", выделено: " + ec[3] + ". Выделите столько же ключей или кратно больше (" + ec[2] + ", " + (ec[2] * 2) + ", " + (ec[2] * 3) + "…)."; }
        if (ec) { return "Скопированы ключи " + ec[2] + " свойств, а выделены у " + ec[3] + ". Выделите ключи у одного свойства или у стольких же, сколько копировали."; }
        if (m === "EC_NO_KEYS") { return "Выделите на таймлайне ключи, куда вставить, или само свойство (у свойства без ключей панель их создаст), или слой — тогда вставится в то же свойство этого слоя."; }
        if (m === "EC_NO_TARGET") { return "У выделенного слоя нет такого свойства, откуда копировали. Выделите на таймлайне ключи или само свойство (Position, Scale…), куда вставить."; }
        if (m === "EC_TYPE") { return "Значения можно вставить только в свойство того же типа: позицию — в позицию, цвет — в цвет. Плавность вставляется куда угодно."; }
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
            host = m.split(":")[2] || "";
            m = m.split(":")[1];
            // Защита от ботов (Dribbble, Behance, Cloudflare…): страницу отдают только настоящему браузеру,
            // а прямые ссылки на сами файлы обычно открыты.
            if (m === "202" || m === "429" || m === "503" || m === "403") {
                return "сайт " + (host || "") + " не пускает программы" + (m === "403" ? " (нужен вход в аккаунт или стоит защита от ботов, код 403)" : " — у него защита от ботов (код " + m + ")") +
                    ". Откройте ссылку в браузере, щёлкните правой кнопкой по видео или картинке → «Копировать адрес видео» (или «…изображения») и вставьте сюда эту прямую ссылку" +
                    (/dribbble/.test(host) ? " — у Dribbble она начинается с cdn.dribbble.com" : "") + ". Или сохраните файл и прикрепите его кнопкой «+ Референс».";
            }
            if (m === "401") { return "сайт не пускает без входа в аккаунт (код 401). Скачайте файл и прикрепите его кнопкой «+ Референс»."; }
            if (m === "404") { return "по ссылке ничего нет (код 404)."; }
            return "сайт ответил ошибкой (код " + m + ").";
        }
        if (m === "TIMEOUT") { return aiName() + " не ответил вовремя. Попробуйте ещё раз."; }
        if (m === "NO_ACTIVE_COMP") { return "Откройте композицию: инструмент работает с открытой композицией."; }
        if (m === "NO_KEYS_SELECTED") { return "Выделите ключевые кадры на таймлайне и нажмите ещё раз."; }
        if (m === "NO_LAYERS_SELECTED") { return "Выделите слой в композиции и нажмите ещё раз."; }
        if (m === "LOGO_NOT_FOUND") { return "Файл логотипа не найден. Удалите его из проекта и добавьте снова."; }
        if (m === "ICON_NOT_FOUND") { return "Файл иконки не найден. Удалите её из проекта и добавьте снова."; }
        if (m === "BR_NO_TEXT") { return "Выделите текстовый слой в композиции и нажмите ещё раз."; }
        if (m === "DC_NO_PRECOMP") { return "Выделите слой-прекомпозицию (слой, внутри которого другая композиция) и нажмите ещё раз."; }
        if (m === "CO_NOT_PHOTO") { return "Cut out работает с фото: выделите слой, у которого источник — файл-картинка (JPG, PNG, PSD…), и нажмите ещё раз."; }
        if (m === "CO_NOT_STILL") { return "Cut out вырезает фон на фото, а это видео. Для видео в After Effects есть Roto Brush."; }
        if (m === "CO_MISSING") { return "Файл этого фото не найден на диске. Верните его на место (File > Replace Footage) и нажмите ещё раз."; }
        if (m === "CO_FORMAT") { return "Панель не смогла открыть этот файл картинки. Сохраните фото как JPG или PNG и замените им слой."; }
        if (m === "CO_LAYER_GONE") { return "Слоя, с которого открыли фото, больше нет в открытой композиции. Откройте ту композицию и нажмите Cut out ещё раз."; }
        if (m === "CO_NOT_SAVED") { return "Не удалось сохранить картинку без фона на диск. Проверьте, что в папке проекта можно записывать файлы."; }
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
        s.toolSize = cleanToolSize(s.toolSize);
        ["accent", "bg", "bgTools", "bgMotion", "bgShape", "bgBrand"].forEach(function (k) { var c = parseHex(s[k]); s[k] = c ? c.hex : DEFAULTS[k]; });
        if (!PROVIDERS.hasOwnProperty(s.provider)) { s.provider = "claude"; }
        if (!knownModel(OPENAI_MODELS, s.openaiModel)) { s.openaiModel = OPENAI_MODELS[0].id; }
        if (!motionStyleOf(s.motionStyle)) { s.motionStyle = "normal"; }
        return s;
    }

    // Масштаб блоков. Прежние «Крупные» — это 100 %, «Мелкие» — 60 %.
    var TOOL_SIZES = ["100", "90", "80", "70", "60", "50"];
    function cleanToolSize(v) {
        if (v === "small") { return "60"; }
        v = String(v);
        return TOOL_SIZES.indexOf(v) >= 0 ? v : "100";
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

    // У каждого раздела свой фон: открытый раздел красит фон панели своим цветом.
    var SECTION_BG = { claude: "bg", tools: "bgTools", motion: "bgMotion", shape: "bgShape", brand: "bgBrand" };
    var currentTab = "claude";

    function applyTheme(s) {
        var a = parseHex(s.accent) || parseHex(DEFAULTS.accent);
        var key = SECTION_BG[currentTab] || "bg";
        var bg = parseHex(s[key]) || parseHex(DEFAULTS[key]);
        var lum = (0.299 * a.r + 0.587 * a.g + 0.114 * a.b) / 255;
        var root = document.documentElement.style;
        root.setProperty("--accent", a.hex);
        root.setProperty("--accent-rgb", a.r + ", " + a.g + ", " + a.b);
        root.setProperty("--accent-hi", toHex(a.r + (255 - a.r) * 0.42, a.g + (255 - a.g) * 0.42, a.b + (255 - a.b) * 0.42));
        root.setProperty("--on-accent", lum > 0.5 ? "#0b0c12" : "#ffffff");
        root.setProperty("--bg", bg.hex);
        root.setProperty("--panel-w", clampPanelWidth(s.panelWidth) + "px");
        document.documentElement.setAttribute("data-fit", s.panelFit === false ? "off" : "on");
        document.documentElement.setAttribute("data-tools", cleanToolSize(s.toolSize));
        root.setProperty("--tz", String(Number(cleanToolSize(s.toolSize)) / 100));
        document.documentElement.setAttribute("data-titles", s.toolTitles === false ? "off" : "on");
        relayoutTools();
    }

    // ------------------------------------------------------------------ ui

    function el(id) { return document.getElementById(id); }

    var ui = {
        prompt: el("prompt"), styleRow: el("styleRow"), mentionList: el("mentionList"), brandHits: el("brandHits"), brandPics: el("brandPics"), runBtn: el("runBtn"), fixBtn: el("fixBtn"), newBtn: el("newBtn"),
        refBtn: el("refBtn"), refChip: el("refChip"), refText: el("refText"), refClear: el("refClear"),
        exprCard: el("exprCard"), exprToggle: el("exprToggle"), exprBody: el("exprBody"), exprWish: el("exprWish"),
        exprApplyBtn: el("exprApplyBtn"), exprFixBtn: el("exprFixBtn"),
        quickBox: el("quickBox"), quickToggle: el("quickToggle"), quickAdd: el("quickAdd"), quickEdit: el("quickEdit"), quickList: el("quickList"),
        quickForm: el("quickForm"), quickName: el("quickName"), quickText: el("quickText"), quickSave: el("quickSave"), quickCancel: el("quickCancel"),
        saveRow: el("saveRow"), saveScriptBtn: el("saveScriptBtn"), saveForm: el("saveForm"), saveName: el("saveName"),
        saveConfirm: el("saveConfirm"), saveCancel: el("saveCancel"),
        scriptsCard: el("scriptsCard"), scriptsToggle: el("scriptsToggle"), scriptsCount: el("scriptsCount"), scriptsList: el("scriptsList"),
        refLinkBtn: el("refLinkBtn"), refLinkRow: el("refLinkRow"), refLink: el("refLink"), refLinkAdd: el("refLinkAdd"), refLinkCancel: el("refLinkCancel"),
        statusBox: el("statusBox"), status: el("status"), stopBtn: el("stopBtn"), spendLine: el("spendLine"),
        replyCard: el("replyCard"), replyText: el("replyText"), replyCode: el("replyCode"), codeBox: el("codeBox"),
        pinLine: el("pinLine"), pasteBtn: el("pasteBtn"), settingsBtn: el("settingsBtn"),
        sheet: el("settingsSheet"), settingsClose: el("settingsClose"), apiKey: el("apiKey"), testKey: el("testKey"),
        keyHint: el("keyHint"), models: el("models"), provider: el("provider"), apiKeyLabel: el("apiKeyLabel"), accentSwatches: el("accentSwatches"), accentHex: el("accentHex"),
        bgSwatches: el("bgSwatches"), bgHex: el("bgHex"), bgPick: el("bgPick"), accentPick: el("accentPick"),
        bgToolsSwatches: el("bgToolsSwatches"), bgToolsHex: el("bgToolsHex"), bgToolsPick: el("bgToolsPick"),
        bgMotionSwatches: el("bgMotionSwatches"), bgMotionHex: el("bgMotionHex"), bgMotionPick: el("bgMotionPick"),
        bgShapeSwatches: el("bgShapeSwatches"), bgShapeHex: el("bgShapeHex"), bgShapePick: el("bgShapePick"),
        bgBrandSwatches: el("bgBrandSwatches"), bgBrandHex: el("bgBrandHex"), bgBrandPick: el("bgBrandPick"), selfCheck: el("selfCheck"), alwaysAsk: el("alwaysAsk"),
        panelFit: el("panelFit"), widthRow: el("widthRow"), panelWidth: el("panelWidth"), panelWidthVal: el("panelWidthVal"), toolSize: el("toolSize"), toolTitles: el("toolTitles"), fxWhere: el("fxWhere"), keyWatchState: el("keyWatchState"), pasteAnywhere: el("pasteAnywhere"), statsOn: el("statsOn"), infoTipsOn: el("infoTipsOn"),
        infoTip: el("infoTip"), infoTipTitle: el("infoTipTitle"), infoTipText: el("infoTipText"), infoTipHint: el("infoTipHint"),
        pasteOptsToggle: el("pasteOptsToggle"), pasteHint: el("pasteHint"),
        snapBar: el("snapBar"), snapClose: el("snapClose"), snapImport: el("snapImport"), snapBrowse: el("snapBrowse"), snapSave: el("snapSave"), snapFolder: el("snapFolder"),
        fxBtn: el("fxBtn"), snapBtn: el("snapBtn"), fxConsole: el("fxConsole"), fxSearch: el("fxSearch"), fxSnap: el("fxSnap"), fxClose: el("fxClose"), fxList: el("fxList"),
        acTabs: el("acTabs"), acSearch: el("acSearch"), acFavOnly: el("acFavOnly"), acModeRow: el("acModeRow"), acMode: el("acMode"),
        acDurRow: el("acDurRow"), acDur: el("acDur"), acDurVal: el("acDurVal"), acColorRow: el("acColorRow"), acColor: el("acColor"),
        acGrid: el("acGrid"), acHint: el("acHint"), acSize: el("acSize"), acFoot: el("acFoot"),
        fxKeys: el("fxKeys"), fxKeysCombo: el("fxKeysCombo"),
        setTabAI: el("setTabAI"), setTabOther: el("setTabOther"), setPaneAI: el("setPaneAI"), setPaneOther: el("setPaneOther"),
        hotkeys: el("hotkeys"), hotkeysReset: el("hotkeysReset"), hotkeyNote: el("hotkeyNote"),
        organizeBtn: el("organizeBtn"), organizeOptsToggle: el("organizeOptsToggle"), organizeHint: el("organizeHint"),
        decomposeBtn: el("decomposeBtn"), decomposeOptsToggle: el("decomposeOptsToggle"), decomposeHint: el("decomposeHint"),
        cacheBtn: el("cacheBtn"), cacheOptsToggle: el("cacheOptsToggle"), cacheHint: el("cacheHint"),
        nullpBtn: el("nullpBtn"), nullpOptsToggle: el("nullpOptsToggle"), nullpHint: el("nullpHint"),
        unusedBtn: el("unusedBtn"), unusedOptsToggle: el("unusedOptsToggle"), unusedHint: el("unusedHint"),
        cutoutBtn: el("cutoutBtn"), cutoutOptsToggle: el("cutoutOptsToggle"), cutoutHint: el("cutoutHint"),
        cutoutView: el("cutoutView"), cutoutName: el("cutoutName"), cutoutClose: el("cutoutClose"), cutoutBrush: el("cutoutBrush"),
        cutoutStage: el("cutoutStage"), cutoutCanvas: el("cutoutCanvas"), cutoutBusy: el("cutoutBusy"), cutoutNote: el("cutoutNote"),
        cutoutEdge: el("cutoutEdge"), cutoutUndo: el("cutoutUndo"), cutoutReset: el("cutoutReset"), cutoutDone: el("cutoutDone"),
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
        tabShape: el("tabShape"), viewShape: el("viewShape"), statusSlotShape: el("statusSlotShape"),
        tabBrand: el("tabBrand"), viewBrand: el("viewBrand"), statusSlotBrand: el("statusSlotBrand"),
        brandSelect: el("brandSelect"), brandRename: el("brandRename"), brandDelete: el("brandDelete"), brandNew: el("brandNew"),
        brandPickRow: el("brandPickRow"), brandNameRow: el("brandNameRow"), brandName: el("brandName"), brandNameOk: el("brandNameOk"),
        brandNameCancel: el("brandNameCancel"), brandDeleteNote: el("brandDeleteNote"), brandEmpty: el("brandEmpty"), brandFirst: el("brandFirst"),
        brandBody: el("brandBody"), brandLogos: el("brandLogos"), brandLogoAdd: el("brandLogoAdd"), brandIcons: el("brandIcons"), brandIconAdd: el("brandIconAdd"), brandColors: el("brandColors"),
        brandGrads: el("brandGrads"), brandGradFrom: el("brandGradFrom"), brandGradTo: el("brandGradTo"), brandGradType: el("brandGradType"),
        brandGradAngle: el("brandGradAngle"), brandGradName: el("brandGradName"), brandGradAdd: el("brandGradAdd"), brandGradPreview: el("brandGradPreview"),
        brandColorPick: el("brandColorPick"), brandColorHex: el("brandColorHex"), brandColorName: el("brandColorName"), brandColorAdd: el("brandColorAdd"),
        brandRigBtn: el("brandRigBtn"), brandFontList: el("brandFontList"), brandFontHead: el("brandFontHead"), brandFontBody: el("brandFontBody"),
        brandFontHeadApply: el("brandFontHeadApply"), brandFontBodyApply: el("brandFontBodyApply"), brandTexts: el("brandTexts"),
        brandTop: el("brandTop"), brandSubs: el("brandSubs"), brandShareRow: el("brandShareRow"), brandExport: el("brandExport"), brandImport: el("brandImport"),
        brandFirstImport: el("brandFirstImport"), brandAsk: el("brandAsk"), brandAskText: el("brandAskText"), brandAskUpdate: el("brandAskUpdate"),
        brandAskCopy: el("brandAskCopy"), brandAskCancel: el("brandAskCancel"),
        brandTextName: el("brandTextName"), brandTextValue: el("brandTextValue"), brandTextAdd: el("brandTextAdd"), brandFormats: el("brandFormats"),
        shapeTools: el("shapeTools"), shapeGridCells: el("shapeGridCells"), shapePinLine: el("shapePinLine"),
        ecOptsToggle: el("ecOptsToggle"), ecOpts: el("ecOpts"), ecCopy: el("ecCopy"), ecPasteEase: el("ecPasteEase"), ecPasteValue: el("ecPasteValue"),
        ecThrough: el("ecThrough"), ecClip: el("ecClip"),
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
        motion: { tab: ui.tabMotion, view: ui.viewMotion, slot: ui.statusSlotMotion },
        shape: { tab: ui.tabShape, view: ui.viewShape, slot: ui.statusSlotShape },
        brand: { tab: ui.tabBrand, view: ui.viewBrand, slot: ui.statusSlotBrand }
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
        currentTab = name;
        applyTheme(draft || settings);
        if (name === "motion" || name === "shape") { relayoutTools(); }
        try { window.localStorage.setItem(TAB_KEY, name); } catch (e) {}
    }

    function savedTab() {
        var name;
        try { name = window.localStorage.getItem(TAB_KEY); } catch (e) { name = null; }
        return typeof name === "string" && TABS.hasOwnProperty(name) ? name : DEFAULT_TAB_ORDER[0];
    }

    // Новая установка: вкладки в таком порядке, открыта первая — «Инструменты».
    var DEFAULT_TAB_ORDER = ["motion", "tools", "shape", "claude", "brand"];

    // ---- порядок вкладок: его можно менять перетаскиванием или Alt + стрелка, он запоминается

    function tabButtons() {
        return Array.prototype.slice.call(ui.tabs.querySelectorAll(".tab"));
    }

    // Узкая панель: если хоть одно название вкладки не помещается целиком, все вкладки показывают иконки.
    // Подсказка при наведении тогда начинается с названия.
    var TAB_TITLE = "Двойной щелчок — поменять вкладки местами";
    function fitTabs() {
        var buttons = tabButtons(), icons;
        ui.tabs.classList.remove("tabs-icons");
        icons = buttons.some(function (b) {
            var label = b.querySelector(".tab-label");
            return label && label.getBoundingClientRect().width > b.clientWidth - 12 + 0.5;
        });
        ui.tabs.classList.toggle("tabs-icons", icons);
        buttons.forEach(function (b) { b.title = icons ? b.getAttribute("aria-label") + "\n" + TAB_TITLE : TAB_TITLE; });
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
        try { saved = JSON.parse(window.localStorage.getItem(TAB_ORDER_KEY) || "null"); } catch (e) { saved = undefined; }
        if (saved === null) { saved = DEFAULT_TAB_ORDER; }
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
        // Новое действие: прежний «Стоп» к нему не относится, расход считается заново.
        if (on && !busy) { aiStop = { requested: false, waiters: [] }; opSpend = null; showSpend(); }
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
        ui.decomposeBtn.disabled = on;
        ui.cacheBtn.disabled = on;
        ui.nullpBtn.disabled = on;
        ui.unusedBtn.disabled = on;
        ui.cutoutBtn.disabled = on;
        ui.fxBtn.disabled = on;
        ui.snapBtn.disabled = on;
        ui.snapSave.disabled = on;
        ui.snapBrowse.disabled = on;
        ui.ecCopy.disabled = on;
        ui.ecPasteEase.disabled = on;
        ui.ecPasteValue.disabled = on;
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

    var RISK_PLAIN = /system\s*\.\s*callSystem|\bFile\s*\(|\bFolder\s*\(|\bSocket\s*\(|\$\s*\.\s*evalFile|\beval\s*\(|app\s*\.\s*quit|app\s*\.\s*newProject|app\s*\.\s*open\s*\(|project\s*\.\s*close|project\s*\.\s*save|renderQueue\s*\.\s*render|\.importFile\s*\(|\.remove\s*\(\s*\)/;
    // Обходные пути к тем же объектам: имя собрано из кусков строки, взято через [""], псевдоним, глобальный объект,
    // конструктор Function. Обычному скрипту анимации всё это не нужно, поэтому такой скрипт тоже показываем перед запуском.
    var RISK_HIDDEN = new RegExp([
        "callSystem", "evalFile", "ExternalObject", "fromCharCode", "\\bunescape\\b", "\\bdecodeURI", "\\bFunction\\b", "\\bconstructor\\b", "__\\w+__",
        "\\bsystem\\s*[.\\[]", "\\b(File|Folder|Socket)\\s*\\.", "\\.\\s*execute\\s*\\(", "[=(,:\\[]\\s*(system|File|Folder|Socket|eval)\\s*[;,)\\]}]", "[=(,:\\[]\\s*(system|File|Folder|Socket|eval)\\s*$",
        "[\"'](system|File|Folder|Socket|eval|quit|open|close|save|render|remove|importFile)[\"']",
        "\\$\\s*\\.\\s*global", "\\$\\s*\\[", "\\bthis\\s*\\[", "=\\s*this\\b", "return\\s+this\\b", "[(,]\\s*this\\s*[),]",
        "\\[[^\\]\\n]*[\"'][^\\]\\n]*\\+[^\\]\\n]*\\]", "\\[[^\\]\\n]*\\+[^\\]\\n]*[\"'][^\\]\\n]*\\]"
    ].join("|"), "m");
    var RISK_PLAIN_TEXT = "Этот скрипт удаляет что-то или обращается к файлам, сети, рендеру или проекту целиком. Проверьте его перед запуском.";
    var RISK_HIDDEN_TEXT = "Этот скрипт обращается к объектам After Effects обходным путём: так можно спрятать доступ к файлам или командам системы. Проверьте его перед запуском.";

    // Почему скрипт нужно показать перед запуском; пустая строка — можно запускать сразу.
    // \u0073 и \x73 в строках сначала раскрываются, чтобы имя нельзя было спрятать за кодами символов.
    function scriptRisk(code) {
        var plain = String(code).replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, function (m, u, x) {
            return String.fromCharCode(parseInt(u || x, 16));
        });
        if (RISK_PLAIN.test(plain)) { return RISK_PLAIN_TEXT; }
        if (RISK_HIDDEN.test(plain)) { return RISK_HIDDEN_TEXT; }
        return "";
    }

    function needsConfirmation(code) { return scriptRisk(code) !== ""; }

    // Спрашивает перед запуском скрипта, если он рискованный. true — можно запускать.
    async function allowScript(code, title) {
        var why = scriptRisk(code);
        if (!why) { return true; }
        return !!(await modal({
            title: title || "Запустить этот скрипт?",
            text: why,
            code: code,
            buttons: [{ label: "Не запускать", value: false }, { label: "Запустить", value: true, primary: true }]
        }));
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
            " s). Frame times in seconds: " + times.join(", ") + ".\n" +
            "Recreate the whole " + ref.duration.toFixed(1) + " s of it, not only the beginning: make the composition at least " + Math.ceil(ref.duration) +
            " s long and keep the animation going through every frame above, so what you see at each time happens at about that time.";
    }

    function checkNote(compName, frames, hasReference) {
        var times = [];
        var i;
        for (i = 0; i < frames.length; i++) { times.push(frames[i].time.toFixed(2)); }
        return "[Result check] The " + frames.length + ' images above are frames of the composition "' + compName +
            '" as it looks now, after your script ran, at these times in seconds: ' + times.join(", ") + ".\n" +
            "Compare them with what the user asked for" +
            (hasReference ? " and with the reference images earlier in this conversation" : "") + ".\n" +
            (hasReference ? "- With a reference video, also check that the composition is as long as the reference and that the later part of it is animated too, not only the opening. If the end is missing or static, that counts as clearly wrong.\n" : "") +
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

    // ------------------------------------------------- стоп и расходы

    var aiStop = { requested: false, waiters: [] };
    var aiPending = 0;      // сколько запросов к нейросети сейчас в пути
    var opSpend = null;     // расход текущего действия: { usd, tokens, priced }
    var spend = loadSpend();

    function requestStop() {
        aiStop.requested = true;
        aiStop.waiters.splice(0).forEach(function (f) { f(); });
        showStop();
    }
    function untilStopped() {
        var stop = aiStop;
        return new Promise(function (resolve) { if (stop.requested) { resolve(); } else { stop.waiters.push(resolve); } });
    }
    function showStop() { ui.stopBtn.hidden = aiPending === 0 || aiStop.requested; }
    function stoppedReply() { return { ok: false, stopped: true, text: "", stopReason: "", error: "Запрос остановлен." }; }
    // Пауза перед повтором; true — пока ждали, нажали «Стоп».
    function pause(ms) {
        return Promise.race([
            new Promise(function (resolve) { setTimeout(function () { resolve(false); }, ms); }),
            untilStopped().then(function () { return true; })
        ]);
    }

    function monthNow() { var d = new Date(); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2); }
    function loadSpend() {
        var s = null;
        try { s = JSON.parse(window.localStorage.getItem(SPEND_KEY) || "null"); } catch (e) { s = null; }
        if (!s || s.month !== monthNow() || typeof s.usd !== "number") { s = { month: monthNow(), usd: 0, tokens: 0 }; }
        return s;
    }
    function money(v) { return "$" + (v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4)); }
    function bigNumber(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }

    // u — токены ответа: { input, output, cacheRead, cacheWrite }. Цены известны только для Claude.
    function addSpend(u, claude) {
        var p = claude ? CLAUDE_PRICES[settings.model] : null;
        var tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
        var usd = p ? (u.input * p[0] + u.cacheWrite * p[0] * 1.25 + u.cacheRead * p[2] + u.output * p[1]) / 1e6 : 0;
        if (spend.month !== monthNow()) { spend = { month: monthNow(), usd: 0, tokens: 0 }; }
        spend.usd += usd;
        spend.tokens += tokens;
        try { window.localStorage.setItem(SPEND_KEY, JSON.stringify(spend)); } catch (e) {}
        if (!opSpend) { opSpend = { usd: 0, tokens: 0, priced: true }; }
        opSpend.usd += usd;
        opSpend.tokens += tokens;
        if (!p) { opSpend.priced = false; }
        showSpend();
    }
    function showSpend() {
        ui.spendLine.hidden = !opSpend;
        if (!opSpend) { return; }
        ui.spendLine.textContent = opSpend.priced ?
            "Расход: " + money(opSpend.usd) + " за этот запрос, " + money(spend.usd) + " за месяц." :
            "Расход: " + bigNumber(opSpend.tokens) + " токенов за этот запрос.";
    }

    // Запрос к нейросети: повторяет, когда сервер перегружен, слушается кнопки «Стоп» и считает расход.
    // opts.quiet — проверка ключа: один запрос без повторов, без кнопки и без счётчика.
    async function callAI(messages, maxTokens, system, opts) {
        var quiet = !!(opts && opts.quiet);
        var claude = settings.provider !== "openai";
        var attempt = 0;
        var out, wait, was;
        if (quiet) { return claude ? callClaude(messages, maxTokens, system, true) : callOpenAI(messages, maxTokens, system, true); }
        aiPending++;
        showStop();
        try {
            while (true) {
                if (aiStop.requested) { return stoppedReply(); }
                out = await (claude ? callClaude(messages, maxTokens, system) : callOpenAI(messages, maxTokens, system));
                if (out.usage) { addSpend(out.usage, claude); }
                if (out.stopped) { return stoppedReply(); }
                if (!out.retry || attempt >= AI_RETRY_MS.length) { return out; }
                wait = AI_RETRY_MS[attempt];
                if (/^\d+(\.\d+)?$/.test(out.retryAfter || "") && +out.retryAfter <= 60) { wait = Math.max(wait, Math.round(+out.retryAfter * 1000)); }
                attempt++;
                was = { text: ui.status.textContent, cls: ui.statusBox.className };
                setStatus((out.status === 429 ? aiName() + ": слишком много запросов подряд" : "Сервер " + aiName() + " перегружен") +
                    ", повторю через " + Math.ceil(wait / 1000) + " с (попытка " + (attempt + 1) + " из " + (AI_RETRY_MS.length + 1) + ")…", "busy");
                if (await pause(wait)) { return stoppedReply(); }
                ui.status.textContent = was.text;
                ui.statusBox.className = was.cls;
            }
        } finally {
            aiPending--;
            showStop();
        }
    }

    // Отправка с кнопкой «Стоп»: запрос обрывается, ответ — ошибка STOPPED.
    function postAI(url, headers, body, quiet) {
        var cancel = null;
        var req = platform.postJSON(url, headers, body, 300000, function (c) { cancel = c; });
        if (quiet) { return req; }
        return Promise.race([req, untilStopped().then(function () {
            if (cancel) { cancel(); }
            throw new Error("STOPPED");
        })]);
    }

    // Ошибка сети или сервера, после которой стоит повторить: перегрузка, лимит, оборванное соединение.
    function retryStatus(status, data) { return AI_RETRY_STATUS.indexOf(status) >= 0 && (status !== 500 || !!(data && data.error)); }
    function netFailure(e) {
        var m = e && e.message ? e.message : String(e);
        if (m === "STOPPED") { return stoppedReply(); }
        return { ok: false, text: "", stopReason: "", error: "Нет связи с сервером: " + humanError(e), retry: /ECONNRESET|socket hang up|EPIPE|ECONNREFUSED|EAI_AGAIN/.test(m) };
    }
    function busyError(status, name, text) {
        if (status === 429) { return name + ": слишком много запросов подряд (лимит ключа). Подождите минуту и повторите."; }
        if (status === 529 || status === 503) { return "Сервер " + name + " сейчас перегружен. Повторите через минуту."; }
        return text;
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

    function callOpenAI(messages, maxTokens, system, quiet) {
        var body = JSON.stringify({
            model: settings.openaiModel,
            max_completion_tokens: Math.max(maxTokens || 0, OPENAI_MAX_TOKENS),
            messages: openAIMessages(messages, system)
        });
        var headers = {
            "authorization": "Bearer " + settings.openaiKey,
            "content-type": "application/json"
        };
        return postAI(OPENAI_URL, headers, body, quiet).then(function (res) {
            var data, choice, content, u;
            var out = { ok: false, text: "", stopReason: "", error: "", status: res.status, retryAfter: res.retryAfter || "" };
            try { data = JSON.parse(res.text); } catch (e) {
                out.error = "Не удалось разобрать ответ сервера (код " + res.status + ").";
                out.retry = retryStatus(res.status, null);
                return out;
            }
            if (data && data.error) {
                out.error = busyError(res.status, "ChatGPT", "ChatGPT API: " + (data.error.message || data.error.code || data.error.type || "ошибка"));
                // 429 из-за исчерпанного баланса повторять бесполезно.
                out.retry = retryStatus(res.status, data) && data.error.code !== "insufficient_quota";
                return out;
            }
            u = data && data.usage;
            if (u) {
                content = u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens || 0;
                out.usage = { input: (u.prompt_tokens || 0) - content, output: u.completion_tokens || 0, cacheRead: content, cacheWrite: 0 };
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
        }, netFailure);
    }

    // Кэш: инструкции (system) — отдельная метка, остальной диалог Claude кэширует сам (метка на запросе).
    // Повторный запрос в том же диалоге читает общее начало из кэша — дешевле и быстрее.
    function callClaude(messages, maxTokens, system, quiet) {
        var body = JSON.stringify({
            model: settings.model,
            max_tokens: maxTokens || MAX_TOKENS,
            system: [{ type: "text", text: system || SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: messages,
            cache_control: { type: "ephemeral" }
        });
        var headers = {
            "x-api-key": settings.apiKey,
            "anthropic-version": API_VERSION,
            "content-type": "application/json"
        };
        return postAI(API_URL, headers, body, quiet).then(function (res) {
            var data, i, block, u;
            var out = { ok: false, text: "", stopReason: "", error: "", status: res.status, retryAfter: res.retryAfter || "" };
            try { data = JSON.parse(res.text); } catch (e) {
                out.error = "Не удалось разобрать ответ сервера (код " + res.status + ").";
                out.retry = retryStatus(res.status, null);
                return out;
            }
            if (data && data.error) {
                out.error = busyError(res.status, "Claude", "Claude API: " + (data.error.message || data.error.type || "ошибка"));
                out.retry = retryStatus(res.status, data) || data.error.type === "overloaded_error";
                return out;
            }
            u = data && data.usage;
            if (u) {
                out.usage = { input: u.input_tokens || 0, output: u.output_tokens || 0,
                    cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
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
        }, netFailure);
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
                if (reply.stopped) {
                    giveUp(scriptsRun > 0 ? doneText() + "\nПроверка результата остановлена." + undoHint() : "Остановлено, скрипт не запускался.");
                    return;
                }
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

            reason = scriptRisk(code) || null;
            if (reason === null && settings.alwaysAsk) {
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
            // Стиль движения для библиотеки SF — в той же строке, чтобы номера строк в ошибках не сдвигались.
            // Обычный стиль хост ставит сам перед каждым скриптом, поэтому строка нужна только для остальных.
            if (settings.motionStyle !== "normal" && code.indexOf("try { SF.style(") !== 0) { code = 'try { SF.style("' + settings.motionStyle + '"); } catch (eSF) {} ' + code; }
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
                    (res.undone ? "\nТо, что скрипт успел изменить, отменено. Нажмите «Исправить ошибку»." :
                        "\nЕсли скрипт успел что-то изменить, нажмите Cmd/Ctrl+Z, затем «Исправить ошибку»."), "error");
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

    // ---------------------------------------------------------- видео-референс по сценам
    // Одним скриптом AI повторяет из длинного видео только начало. Поэтому видео длиннее SCENE_MIN_SECONDS
    // делается в несколько шагов: (1) AI смотрит все кадры и пишет план сцен с таймингом, (2) панель
    // готовит композицию нужной длины, (3) каждая сцена — отдельный запрос со своими кадрами и своим
    // скриптом, (4) по желанию — одна проверка всего ролика по кадрам. Так ролик всегда сделан до конца.
    var SCENE_MIN_SECONDS = 5;
    var SCENE_MAX = 8;

    function sceneNeeded(ref) { return !!ref && !ref.isStill && ref.duration > SCENE_MIN_SECONDS && ref.frames.length > 2; }

    function framesWithTimes(frames, intro) {
        var content = [], i;
        for (i = 0; i < frames.length; i++) {
            content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: frames[i].data } });
        }
        content.push({ type: "text", text: intro });
        return content;
    }

    function timesOf(frames) { return frames.map(function (f) { return f.time.toFixed(2); }).join(", "); }

    // Разбирает план от AI: JSON где-то в ответе. Сцены — подряд от 0 до конца видео.
    function parsePlan(text, duration) {
        var m = /\{[\s\S]*\}/.exec(String(text || "")), plan, out = [], i, s, e, prev = 0;
        if (!m) { return null; }
        try { plan = JSON.parse(m[0]); } catch (err) { return null; }
        if (!plan || !(plan.scenes instanceof Array) || !plan.scenes.length) { return null; }
        for (i = 0; i < plan.scenes.length && out.length < SCENE_MAX; i++) {
            s = Number(plan.scenes[i].start); e = Number(plan.scenes[i].end);
            if (!isFinite(s)) { s = prev; }
            if (!isFinite(e) || e <= s) { continue; }
            s = Math.max(prev, Math.min(s, duration)); e = Math.min(duration, e);
            if (e - s < 0.2) { continue; }
            out.push({ start: s, end: e, what: String(plan.scenes[i].what || plan.scenes[i].description || "").substring(0, 1500) });
            prev = e;
        }
        if (!out.length) { return null; }
        out[0].start = 0;
        out[out.length - 1].end = duration;
        for (i = 1; i < out.length; i++) { out[i].start = out[i - 1].end; }
        return { scenes: out, look: String(plan.look || plan.style || "").substring(0, 1500), background: String(plan.background || "") };
    }

    function planText(plan) {
        return (plan.look ? "Overall look: " + plan.look + "\n" : "") + plan.scenes.map(function (sc, i) {
            return "Scene " + (i + 1) + " (" + sc.start.toFixed(2) + "-" + sc.end.toFixed(2) + " s): " + sc.what;
        }).join("\n");
    }

    // Композиция под референс: открытая удлиняется, а если её нет — создаётся с пропорциями видео.
    function sceneSetupCode(ref) {
        var k = 1920 / Math.max(ref.width || 1920, ref.height || 1080), w = Math.round((ref.width || 1920) * k / 2) * 2, h = Math.round((ref.height || 1080) * k / 2) * 2,
            d = Math.ceil(ref.duration * 10) / 10;
        return "var c = app.project.activeItem;\n" +
            "if (!c || !(c instanceof CompItem)) { c = app.project.items.addComp('Reference', " + w + ", " + h + ", 1, " + d + ", 30); c.openInViewer(); }\n" +
            "if (c.duration < " + d + ") { c.duration = " + d + "; }\n" +
            "if (c.workAreaStart + c.workAreaDuration < " + d + ") { try { c.workAreaStart = 0; c.workAreaDuration = " + d + "; } catch (e) {} }\n";
    }

    async function runByScenes(text, ref, info, picBlocks, note) {
        var plan, reply, i, sc, frames, content, code, syn, res, done = 0, fails = [], codes = [], tries, intro, snap, checkFrames, tdiff;
        function stop(msg, kind) { setBusy(false); setStatus(msg, kind); }
        if (!aiKey()) { stop("Нужен " + providerOf().keyLabel.replace(/^Ключ/, "ключ") + ". Вставьте его в настройках.", "error"); openSettings(); return; }
        setBusy(true);
        lastError = null;

        // 1. План сцен по всем кадрам.
        setStatus("Видео " + ref.duration.toFixed(1) + " с: " + aiName() + " смотрит все " + ref.frames.length + " кадров и делит его на сцены…", "busy");
        intro = "[Reference video plan] The " + ref.frames.length + " images above are frames sampled in order from the user's reference video \"" + ref.name + "\" (" +
            ref.width + "x" + ref.height + ", " + ref.duration.toFixed(2) + " s), at these times in seconds: " + timesOf(ref.frames) + ".\n" +
            "The whole video will be rebuilt in After Effects scene by scene, each scene by a separate script. First, split it into 2-" + SCENE_MAX +
            " consecutive scenes covering 0 to " + ref.duration.toFixed(2) + " s with no gaps (cut where the picture or the action clearly changes; a scene is usually 1.5-5 s).\n" +
            "For each scene describe precisely what is on screen and how it moves, so that someone who cannot see the video could rebuild it: elements, layout and positions, colours (hex), text (exact words), typography, and the motion with timing (what enters when, how, from where, how it leaves, transitions).\n" +
            "Reply with ONLY this JSON, no code block and no other text:\n" +
            "{\"look\": \"overall style, palette, fonts, background\", \"scenes\": [{\"start\": 0, \"end\": 2.4, \"what\": \"...\"}, ...]}\n\n" +
            (note ? note + "\n\n" : "") + "[User's request]\n" + text;
        reply = await callAI([{ role: "user", content: picBlocks.concat(framesWithTimes(ref.frames, intro)) }], 4096);
        if (!reply.ok) { pendingRef = ref; refSentNote = false; showRef(); stop(reply.error, "error"); return; }
        plan = parsePlan(reply.text, ref.duration);
        if (!plan) { pendingRef = ref; refSentNote = false; showRef(); stop(aiName() + " не прислал план сцен. Попробуйте ещё раз.", "error"); return; }
        showReply("План по сценам:\n" + plan.scenes.map(function (s, n) { return (n + 1) + ") " + s.start.toFixed(1) + "–" + s.end.toFixed(1) + " с: " + s.what; }).join("\n"));
        dialogHasRef = true;

        // 2. Композиция нужной длины.
        try {
            code = sceneSetupCode(ref);
            res = await host("run", [code, "композиция под референс", false, platform.tmpdir()]);
            if (res.runError) { throw new Error(res.runError); }
            codes.push(code);
        } catch (e) {
            stop("Не удалось подготовить композицию: " + humanError(e), "error");
            return;
        }

        // 3. Сцена за сценой.
        for (i = 0; i < plan.scenes.length; i++) {
            sc = plan.scenes[i];
            frames = ref.frames.filter(function (f) { return f.time >= sc.start - 0.05 && f.time <= sc.end + 0.05; });
            if (!frames.length) { frames = [ref.frames.reduce(function (a, f) { return Math.abs(f.time - (sc.start + sc.end) / 2) < Math.abs(a.time - (sc.start + sc.end) / 2) ? f : a; })]; }
            frames = frames.slice(0, 8);
            try { snap = (await host("info", [])).snapshot; } catch (e1) { snap = info.snapshot; }
            intro = "[Scene " + (i + 1) + " of " + plan.scenes.length + "] The " + frames.length + " images above are the reference video's frames for this scene, at " + timesOf(frames) + " s.\n" +
                "Build ONLY this scene, from " + sc.start.toFixed(2) + " to " + sc.end.toFixed(2) + " s, in the active composition: " + sc.what + "\n\n" +
                "Plan of the whole video (for context; other scenes are built by other scripts):\n" + planText(plan) + "\n\n" +
                "Rules for this scene:\n" +
                "- Layers from earlier scenes are in the project state below. Reuse things that continue (for example the background or a logo that stays) instead of making them again.\n" +
                "- New layers of this scene: set inPoint to " + sc.start.toFixed(2) + " and outPoint to " + sc.end.toFixed(2) + " (later if the plan says the element stays into the next scene). Put all keyframes inside that time. Name layers with the prefix \"S" + (i + 1) + " \".\n" +
                "- Keep it moving through the whole scene, then hand over to the next one (exit or transition at the end if the reference does).\n" +
                "- Do not change the composition's size or length, and do not touch other scenes' layers unless this scene continues them.\n\n" +
                (note ? note + "\n\n" : "") + "[Project state]\n" + snap + "\n\n[User's request]\n" + text;
            content = framesWithTimes(frames, intro);
            if (aiStop.requested) { fails.push(i + 1); continue; }
            setStatus("Сцена " + (i + 1) + " из " + plan.scenes.length + " (" + sc.start.toFixed(1) + "–" + sc.end.toFixed(1) + " с): жду " + aiName() + "…", "busy");
            for (tries = 0; tries < 2; tries++) {
                reply = await callAI([{ role: "user", content: content }]);
                if (!reply.ok) { fails.push(i + 1); break; }
                code = extractCode(reply.text);
                if (code === null) { fails.push(i + 1); break; }
                try { syn = (await host("syntax", [code])).error; } catch (e2) { syn = humanError(e2); }
                if (!syn) {
                    if (!(await allowScript(code, "Запустить скрипт сцены " + (i + 1) + "?"))) { fails.push(i + 1); break; }
                    if (settings.motionStyle !== "normal") { code = 'try { SF.style("' + settings.motionStyle + '"); } catch (eSF) {} ' + code; }
                    setStatus("Сцена " + (i + 1) + " из " + plan.scenes.length + ": выполняю скрипт…", "busy");
                    try { res = await host("run", [code, "сцена " + (i + 1), false, platform.tmpdir()]); } catch (e3) { res = { runError: humanError(e3) }; }
                    syn = res.runError;
                    if (!syn) { codes.push(code); done++; break; }
                }
                if (tries === 0) {
                    content = content.concat([{ type: "text", text: "Your script for this scene failed: " + syn + "\nAssume its partial changes were undone. Return the full corrected script for this scene." }]);
                    setStatus("Сцена " + (i + 1) + ": ошибка в скрипте, прошу " + aiName() + " исправить…", "busy");
                } else {
                    fails.push(i + 1);
                }
            }
        }

        // 4. Проверка всего ролика по кадрам (одна): AI сравнивает с референсом и правит, если что-то явно не так.
        if (settings.selfCheck && info.fileAccess !== false && done > 0 && !aiStop.requested) {
            setStatus("Готово сцен: " + done + " из " + plan.scenes.length + ". " + aiName() + " сверяет ролик с референсом…", "busy");
            try {
                tdiff = [];
                for (i = 0; i < 6; i++) { tdiff.push(Math.round(ref.duration * (i + 0.5) / 6 * 100) / 100); }
                res = await host("run", ["var SAYFRAME_CHECK_TIMES = [" + tdiff.join(", ") + "];", "проверка", true, platform.tmpdir()]);
                checkFrames = res.frames && res.frames.length ? await loadFrames(res.frames) : null;
            } catch (e4) { checkFrames = null; }
            if (checkFrames) {
                snap = (await host("info", [])).snapshot;
                content = framesWithTimes(ref.frames.filter(function (f, n) { return n % Math.max(1, Math.ceil(ref.frames.length / 8)) === 0; }),
                    "[Reference] The images above are frames of the user's reference video at " + timesOf(ref.frames.filter(function (f, n) { return n % Math.max(1, Math.ceil(ref.frames.length / 8)) === 0; })) + " s.");
                content = content.concat(framesWithTimes(checkFrames, "[Result check] These images are the rebuilt composition at " + timesOf(checkFrames) + " s, built scene by scene from this plan:\n" + planText(plan) +
                    "\nCompare with the reference at the same times. If the result is acceptable, reply with one short sentence in the user's language and NO code block. " +
                    "Only if something is clearly wrong (a scene missing or empty, an element missing, wrong colour or text, nothing moving where the reference moves), reply with one sentence and one code block that fixes the existing layers in place (find them by name).\n\n[Project state]\n" + snap));
                reply = await callAI([{ role: "user", content: content }]);
                code = reply.ok ? extractCode(reply.text) : null;
                if (code !== null) {
                    try {
                        syn = (await host("syntax", [code])).error;
                        if (!syn && await allowScript(code)) { res = await host("run", [code, "правка после проверки", false, platform.tmpdir()]); if (!res.runError) { codes.push(code); } }
                    } catch (e5) {}
                }
            }
        }

        if (currentRun) { currentRun.codes = currentRun.codes.concat(codes); }
        // В историю — коротко: что просили и какой план сделан, чтобы следующие просьбы его продолжали.
        history.push({ role: "user", content: "[Request]\n" + text + "\n(The user attached a reference video, " + ref.duration.toFixed(1) + " s. It was rebuilt scene by scene by separate scripts, following this plan:)\n" + planText(plan) });
        history.push({ role: "assistant", content: "Готово: ролик собран по сценам (" + done + " из " + plan.scenes.length + ")." });
        trimHistory();
        refSentNote = true;
        showRef();
        setBusy(false);
        setStatus(done === plan.scenes.length ?
            "Готово: ролик " + ref.duration.toFixed(1) + " с собран по " + plan.scenes.length + " сценам — от начала до конца.\nОтменить: Cmd/Ctrl+Z, каждая сцена — отдельный шаг." :
            "Собрано сцен: " + done + " из " + plan.scenes.length + "." + (aiStop.requested ? " Остановлено, остальные сцены не собирались." : fails.length ? " Не получились сцены: " + fails.join(", ") + " — попросите доделать их отдельно, например: «доделай сцену " + fails[0] + "»." : ""),
            done ? "done" : "error");
    }

    async function onRun() {
        var text = ui.prompt.value.replace(/^\s+|\s+$/g, "");
        var info, body, sent, hits, note, pics, picBlocks = [];
        if (busy) { return; }
        if (text === "") { setStatus("Напишите, что нужно сделать.", ""); return; }
        try {
            info = await host("info", []);
        } catch (e) {
            setStatus(humanError(e), "error");
            return;
        }
        hits = brandHitsNow();
        note = brandNote();
        if (motionStyleOf(settings.motionStyle).note) { note = (note ? note + "\n\n" : "") + "[Motion style] " + motionStyleOf(settings.motionStyle).note; }
        if (hits.length) { note = (note ? note + "\n" : "") + brandHitsNote(hits); }
        body = "[Project state]\n" + info.snapshot + (note ? "\n\n" + note : "") + "\n\n[Request]\n" + text;
        // По настройке AI видит и сами упомянутые логотипы и иконки.
        pics = settings.brandPics && hits.length ? await brandPictures(hits) : [];
        if (pics.length) {
            picBlocks = pics.map(function (pc) { return { type: "image", source: { type: "base64", media_type: "image/png", data: pc.data } }; });
            picBlocks.push({ type: "text", text: "[Brand pictures] The " + pics.length + " image(s) above show the brand items mentioned in the request, in order: " +
                pics.map(function (pc, i) { return (i + 1) + ") " + pc.item.kind + " \"" + pc.item.name + "\""; }).join(", ") + ". They are references for what the files look like." });
        }
        sent = pendingRef;
        // Длинное видео — по сценам: план, композиция нужной длины, по скрипту на сцену.
        if (sceneNeeded(sent)) {
            pendingRef = null;
            closeMention();
            beginRun(text.replace(/\s+/g, " "));
            await runByScenes(text, sent, info, picBlocks, note);
            endRun();
            return;
        }
        if (sent) {
            history.push({ role: "user", content: picBlocks.concat(framesContent(sent.frames, referenceNote(sent) + "\n\n" + body)) });
            pendingRef = null;
            refSentNote = true;
            showRef();
        } else {
            history.push({ role: "user", content: picBlocks.length ? picBlocks.concat([{ type: "text", text: body }]) : body });
        }
        closeMention();
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
                text: it.codes.map(scriptRisk).filter(Boolean)[0],
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
                    "\nСкрипт мог рассчитывать на другую композицию или слои." +
                    (res.undone ? " То, что этот шаг успел изменить, отменено." : " Если он успел что-то изменить, нажмите Cmd/Ctrl+Z."), "error");
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

    function linkHost(u) {
        try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
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
            if (r.status !== 200) { throw new Error("LINK_HTTP:" + r.status + ":" + linkHost(url)); }
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
                if (r.status !== 200) { throw new Error("LINK_HTTP:" + r.status + ":" + linkHost(target)); }
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
    // strict — вставка из любого места After Effects: то, что скопировано в самом After Effects, не трогаем.
    async function readClipboardOnce(strict) {
        var stamp = String(new Date().getTime());
        var tmp = platform.tmpdir();
        var png = platform.join(tmp, "sayframe_clip_" + stamp + ".png");
        var resFile = platform.join(tmp, "sayframe_clip_" + stamp + ".txt");
        var jsFile = platform.join(tmp, "sayframe_clip_" + stamp + ".js");
        var r, out;

        if (platform.isWindows()) {
            r = await platform.exec("powershell", ["-NoProfile", "-STA", "-Command",
                "& {" + PS_CLIPBOARD + "} '" + png.replace(/'/g, "''") + "'" + (strict ? " strict" : "")], 20000);
            out = r.stdout;
        } else {
            await platform.writeText(jsFile, JXA_CLIPBOARD);
            r = await platform.exec("osascript", ["-l", "JavaScript", jsFile, png, resFile].concat(strict ? ["strict"] : []), 20000);
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

        function swatches(container, input, colors, key, pick) {
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
                    if (pick) { pick.value = c; }
                    pressGroup(container, c);
                    applyTheme(draft);
                });
                container.insertBefore(b, pick || input);
            });
            input.addEventListener("input", function () {
                var p = parseHex(input.value);
                if (p) {
                    draft[key] = p.hex;
                    if (pick) { pick.value = p.hex; }
                    pressGroup(container, p.hex);
                    applyTheme(draft);
                }
            });
            // Палитра: любой цвет, не только готовые.
            if (pick) {
                pick.addEventListener("input", function () {
                    var p = parseHex(pick.value);
                    if (!p || !draft) { return; }
                    draft[key] = p.hex;
                    input.value = p.hex;
                    pressGroup(container, p.hex);
                    applyTheme(draft);
                });
            }
        }
        swatches(ui.accentSwatches, ui.accentHex, ACCENTS, "accent", ui.accentPick);
        swatches(ui.bgSwatches, ui.bgHex, BACKGROUNDS, "bg", ui.bgPick);
        swatches(ui.bgToolsSwatches, ui.bgToolsHex, BACKGROUNDS, "bgTools", ui.bgToolsPick);
        swatches(ui.bgMotionSwatches, ui.bgMotionHex, BACKGROUNDS, "bgMotion", ui.bgMotionPick);
        swatches(ui.bgShapeSwatches, ui.bgShapeHex, BACKGROUNDS, "bgShape", ui.bgShapePick);
        swatches(ui.bgBrandSwatches, ui.bgBrandHex, BACKGROUNDS, "bgBrand", ui.bgBrandPick);

        // Размер блоков тоже виден сразу и тоже возвращается, если настройки закрыть без сохранения.
        ui.toolSize.addEventListener("click", function (e) {
            var v = e.target && e.target.getAttribute ? e.target.getAttribute("data-value") : null;
            if (!draft || TOOL_SIZES.indexOf(v) < 0) { return; }
            draft.toolSize = v;
            pressGroup(ui.toolSize, v);
            applyTheme(draft);
        });

        ui.fxWhere.addEventListener("click", function (e) {
            var v = e.target && e.target.getAttribute ? e.target.getAttribute("data-value") : null;
            if (!draft || (v !== "panel" && v !== "cursor")) { return; }
            draft.fxWhere = v;
            pressGroup(ui.fxWhere, v);
        });

        ui.toolTitles.addEventListener("change", function () {
            if (!draft) { return; }
            draft.toolTitles = ui.toolTitles.checked;
            applyTheme(draft);
        });

        // «На всю ширину» и ширина меняются сразу; без «Сохранить» вернётся прежнее.
        ui.panelFit.addEventListener("change", function () {
            if (!draft) { return; }
            draft.panelFit = ui.panelFit.checked;
            ui.widthRow.hidden = draft.panelFit;
            applyTheme(draft);
        });
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
        ui.accentPick.value = draft.accent;
        [["bg", ui.bgSwatches, ui.bgHex, ui.bgPick], ["bgTools", ui.bgToolsSwatches, ui.bgToolsHex, ui.bgToolsPick],
            ["bgMotion", ui.bgMotionSwatches, ui.bgMotionHex, ui.bgMotionPick],
            ["bgShape", ui.bgShapeSwatches, ui.bgShapeHex, ui.bgShapePick], ["bgBrand", ui.bgBrandSwatches, ui.bgBrandHex, ui.bgBrandPick]].forEach(function (r) {
            r[2].value = draft[r[0]];
            r[3].value = draft[r[0]];
            pressGroup(r[1], draft[r[0]]);
        });
        ui.selfCheck.checked = draft.selfCheck;
        ui.alwaysAsk.checked = draft.alwaysAsk;
        ui.brandPics.checked = draft.brandPics;
        ui.panelFit.checked = draft.panelFit !== false;
        ui.widthRow.hidden = draft.panelFit !== false;
        ui.panelWidth.value = String(draft.panelWidth);
        ui.panelWidthVal.textContent = draft.panelWidth + " px";
        showProvider();
        pressGroup(ui.accentSwatches, draft.accent);
        pressGroup(ui.frames, draft.refFrames);
        pressGroup(ui.toolSize, draft.toolSize);
        ui.toolTitles.checked = draft.toolTitles;
        ui.pasteAnywhere.checked = draft.pasteAnywhere !== false;
        pressGroup(ui.fxWhere, draft.fxWhere === "cursor" ? "cursor" : "panel");
        ui.statsOn.checked = draft.stats !== false;
        ui.infoTipsOn.checked = draft.infoTips !== false;
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
            draft.brandPics = ui.brandPics.checked;
            draft.toolTitles = ui.toolTitles.checked;
            draft.pasteAnywhere = ui.pasteAnywhere.checked;
            draft.stats = ui.statsOn.checked;
            draft.infoTips = ui.infoTipsOn.checked;
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
        callAI([{ role: "user", content: "ping" }], 1, undefined, { quiet: true }).then(function (r) {
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

    var GRID_VERSION = 2;         // 2 — мелкая сетка (шаг 22 px)
    // Так было до 1.40.0: блоки по порядку, без мест и булавок, всё развёрнуто.
    var MOTION_LEGACY = { curve: true, order: "ease,anchor,align,shift,paste,organize,easecopy,decompose,cache,nullp,unused,cutout", sizes: "", places: "", pins: "",
        ecOpts: true, pasteOpts: true, organizeOpts: true, decomposeOpts: true, cacheOpts: true, nullpOpts: true, unusedOpts: true, cutoutOpts: true, anchorOpts: true, alignOpts: true };

    // Так «Инструменты» выглядят после новой установки: блоки-кнопки закреплены сверху, под линией — «Время»,
    // «Якорь», «Выровнять» и «Плавность»; подсказки и списки свёрнуты (их открывает плюс в углу блока).
    // У тех, кто уже настроил панель, сохранённое не меняется; новые блоки встают сверху, ближе к середине.
    var MOTION_DEFAULTS = { easeIn: 60, easeOut: 60, link: true, curve: false, anchorKeys: "key", alignTo: "comp",
        order: "paste,unused,easecopy,decompose,organize,cache,nullp,cutout,shift,anchor,align,ease",
        sizes: "ease=14x0;shift=12x0;easecopy=17x0",
        places: "paste=0,0;unused=8,0;easecopy=17,0;decompose=34,0;organize=0,5;cache=8,5;nullp=17,5;cutout=25,5;shift=0,12;anchor=12,12;align=20,12;ease=28,12",
        pins: "paste,unused,easecopy,decompose,organize,cache,nullp,cutout", grid: GRID_VERSION,
        ecOpts: false, ecThrough: false, pasteOpts: false, organizeOpts: false, decomposeOpts: false, cacheOpts: false, nullpOpts: false, unusedOpts: false, cutoutOpts: false,
        anchorOpts: false, alignOpts: false,
        shiftWhat: "in", shiftStep: 1, timeAlign: "inStart", staggerWhat: "layer", staggerStep: 1, staggerOrder: "asc", shiftOpts: true };
    var SHIFT_TARGETS = ["in", "out", "layer"];
    var TIME_POINTS = ["inStart", "inEnd", "outStart", "outEnd"];
    var STAGGER_ORDERS = ["asc", "desc", "selection", "random"];
    var MAX_STEP_FRAMES = 999;
    var TOOL_NAMES = ["ease", "anchor", "align", "shift", "paste", "organize", "easecopy", "decompose", "cache", "nullp", "unused", "cutout"];
    var SHAPE_TOOL_NAMES = [];
    // Сетка блоков. Таких сеток две — «Инструменты» и «Шейп»; G — та, с которой сейчас работаем.
    // Пока панель не собрана, G знает только имена блоков «Инструментов» (нужно, чтобы прочитать сохранённое).
    var G = { names: TOOL_NAMES };

    // ---- сетка раздела «Инструменты»: блоки стоят по клеткам, двигаются и растягиваются по ним.
    // Клетка квадратная: 14 px и 8 px между клетками, шаг сетки 22 px (до 1.34.0 был 44: клетка 36 px).
    // Промежуток между блоками прежний, а шаг вдвое мельче — блоки тянутся точнее и сужаются сильнее.
    // Ширина и высота блока — в клетках.
    var GRID_LARGE = { cell: 14, gap: 8 };

    var TOOL_MIN_COLS = 4;        // самый узкий блок: 4 клетки
    var TOOL_DEFAULT_COLS = 8;
    var TOOL_FULL = 99;           // «на всю ширину»: столько клеток, сколько есть в панели
    var TOOL_MAX_ROWS = 80;

    // Масштаб содержимого блока шириной w клеток. Всё содержимое помещается в блок обычной ширины
    // (TOOL_DEFAULT_COLS клеток); блок уже этого не обрезает кнопки, а уменьшает их целиком —
    // так блок можно сузить до TOOL_MIN_COLS клеток.
    // Блоки, в которых только кнопки: суженными они показывают одни иконки.
    var ICON_TOOLS = ["paste", "organize", "easecopy", "decompose", "cache", "nullp", "unused", "cutout"];
    var ICON_ROW_COLS = 7;        // «Копия» иконками в ряд — ровно 7 клеток; уже — столбик в 4 клетки
    // Ширина блока-иконок: столбик (4 клетки) или ряд (7 клеток, если в блоке несколько кнопок). Промежуточной нет.
    // Шаг клавиатурой у блока-иконок: столбик → ряд → обычный блок и обратно, без застревания на месте.
    function iconBump(name, w, was) {
        var to = iconCols(name, w);
        if (to !== was || w === was || w >= TOOL_FULL) { return to; }
        if (w > was) { return name === "easecopy" && was < ICON_ROW_COLS ? ICON_ROW_COLS : TOOL_DEFAULT_COLS; }
        return was > ICON_ROW_COLS && name === "easecopy" ? ICON_ROW_COLS : TOOL_MIN_COLS;
    }
    function iconCols(name, w) {
        if (ICON_TOOLS.indexOf(name) < 0 || w >= TOOL_DEFAULT_COLS) { return w; }
        return name === "easecopy" && w >= ICON_ROW_COLS ? ICON_ROW_COLS : TOOL_MIN_COLS;
    }
    function blockZoom(w, m) {
        var k = Number(document.documentElement.getAttribute("data-tools")) / 100;
        if (!(k > 0 && k <= 1)) { k = 1; }
        return Math.round(k * Math.min(1, (w * (m.cell + m.gap) - m.gap) / (TOOL_DEFAULT_COLS * (m.cell + m.gap) - m.gap)) * 1000) / 1000;
    }

    function gridModule() {
        // Клетка и промежуток — в том же масштабе, что и содержимое блоков (--tz в CSS).
        var k = Number(document.documentElement.getAttribute("data-tools")) / 100;
        if (!(k > 0 && k <= 1)) { k = 1; }
        // Клетка округляется вверх: блок обычной ширины не бывает уже своего содержимого.
        return { cell: Math.ceil(GRID_LARGE.cell * k - 0.001), gap: Math.max(3, Math.round(GRID_LARGE.gap * k)) };
    }

    // Размеры блоков: "ease=6x0;anchor=99x9" — ширина и высота в клетках. Высота 0 — по содержимому,
    // ширина 99 — на всю панель. Старые записи в пикселях ("anchor=320", "ease=full") переводятся в клетки.
    function parseSizes(text) {
        var out = {};
        var parts = String(text).split(";");
        var i, pair, m, w, h;
        for (i = 0; i < parts.length; i++) {
            pair = parts[i].split("=");
            if (pair.length !== 2 || G.names.indexOf(pair[0]) < 0) { continue; }
            m = /^(\d{1,2})x(\d{1,2})$/.exec(pair[1]);
            if (m) {
                w = Number(m[1]);
                h = Number(m[2]);
            } else if (pair[1] === "full") {
                w = TOOL_FULL;
                h = 0;
            } else if (/^\d{1,4}$/.test(pair[1]) && Number(pair[1]) >= 100) {
                w = Math.round((Number(pair[1]) + 8) / 44) * 2;
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
        for (i = 0; i < G.names.length; i++) {
            z = sizes[G.names[i]];
            if (z && !(z.w === TOOL_DEFAULT_COLS && !z.h)) { out.push(G.names[i] + "=" + z.w + "x" + (z.h || 0)); }
        }
        return out.join(";");
    }

    function sizeOf(name) {
        return parseSizes(G.st.sizes)[name] || { w: TOOL_DEFAULT_COLS, h: 0 };
    }

    // Места блоков: "ease=0,0;anchor=4,0" — колонка и ряд левого верхнего угла. Пусто — блоки идут
    // друг за другом по порядку и сами переносятся, когда панель сужают или растягивают.
    function parsePlaces(text) {
        var out = {};
        var parts = String(text).split(";");
        var i, pair, m;
        for (i = 0; i < parts.length; i++) {
            pair = parts[i].split("=");
            if (pair.length !== 2 || G.names.indexOf(pair[0]) < 0) { continue; }
            m = /^(\d{1,2}),(\d{1,3})$/.exec(pair[1]);
            if (m) { out[pair[0]] = { x: Number(m[1]), y: Number(m[2]) }; }
        }
        return out;
    }

    function placesText(places) {
        var out = [];
        var i, q;
        for (i = 0; i < G.names.length; i++) {
            q = places[G.names[i]];
            if (q) { out.push(G.names[i] + "=" + q.x + "," + q.y); }
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
            if (G.names.indexOf(want[i]) >= 0 && out.indexOf(want[i]) < 0) { out.push(want[i]); }
        }
        for (i = 0; i < G.names.length; i++) {
            if (out.indexOf(G.names[i]) < 0) { out.push(G.names[i]); }
        }
        return out.join(",");
    }
    // Раскладки, сохранённые на прежней крупной сетке (клетка вдвое больше), переводятся в новые клетки:
    // размеры и места умножаются на 2, «на всю ширину» и «по содержимому» остаются как есть.
    function upgradeGrid(saved) {
        if (!saved || saved.grid === GRID_VERSION) { return; }
        if (typeof saved.sizes === "string") {
            saved.sizes = saved.sizes.replace(/=(\d{1,2})x(\d{1,2})/g, function (all, w, h) {
                // Прежние пределы: не уже 4 крупных клеток и не выше 40.
                return "=" + (Number(w) === TOOL_FULL ? w : Math.max(4, Number(w)) * 2) + "x" + Math.min(40, Number(h)) * 2;
            });
        }
        if (typeof saved.places === "string") {
            saved.places = saved.places.replace(/=(\d{1,2}),(\d{1,3})/g, function (all, x, y) { return "=" + Number(x) * 2 + "," + Number(y) * 2; });
        }
        saved.grid = GRID_VERSION;
    }
    var TOOL_DRAG_START_PX = 6;  // сдвиг мыши, после которого нажатие на блок считается перетаскиванием

    function loadMotion() {
        var m = {};
        var saved, k;
        for (k in MOTION_DEFAULTS) { if (MOTION_DEFAULTS.hasOwnProperty(k)) { m[k] = MOTION_DEFAULTS[k]; } }
        try { saved = JSON.parse(window.localStorage.getItem(MOTION_KEY) || "null"); } catch (e) { saved = {}; }
        // Панель уже настраивали (что-то сохранено): чего нет в сохранённом, берётся по-старому, а не из новой раскладки.
        if (saved && typeof saved === "object") {
            for (k in MOTION_LEGACY) { if (MOTION_LEGACY.hasOwnProperty(k)) { m[k] = MOTION_LEGACY[k]; } }
        }
        if (saved && typeof saved === "object") {
            upgradeGrid(saved);
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
            { key: "decomposeOpts", button: ui.decomposeOptsToggle, part: ui.decomposeHint, hide: "Скрыть подсказку", show: "Показать подсказку" },
            { key: "cacheOpts", button: ui.cacheOptsToggle, part: ui.cacheHint, hide: "Скрыть подсказку", show: "Показать подсказку" },
            { key: "nullpOpts", button: ui.nullpOptsToggle, part: ui.nullpHint, hide: "Скрыть подсказку", show: "Показать подсказку" },
            { key: "unusedOpts", button: ui.unusedOptsToggle, part: ui.unusedHint, hide: "Скрыть подсказку", show: "Показать подсказку" },
            { key: "cutoutOpts", button: ui.cutoutOptsToggle, part: ui.cutoutHint, hide: "Скрыть подсказку", show: "Показать подсказку" },
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
            if (G.names.indexOf(n) >= 0 && out.indexOf(n) < 0) { out.push(n); }
        });
        return out.join(",");
    }

    function pinList() { return G.st && G.st.pins ? G.st.pins.split(",") : []; }

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
        var pins = pinList(), at = pins.indexOf(name), places = parsePlaces(G.st.places);
        if (at >= 0) { pins.splice(at, 1); } else { pins.push(name); }
        // Сохранённое место блока больше не подходит: он переезжает в другую часть.
        delete places[name];
        G.st.places = placesText(places);
        G.st.pins = cleanPins(pins.join(","));
        G.store();
        showPins();
        relayoutTools();
    }

    function enablePins(g) {
        G = g;
        toolCards().forEach(function (card) {
            var name = card.getAttribute("data-tool");
            var toggle = card.querySelector(".tool-toggle");
            var b = document.createElement("button");
            b.className = "tool-pin";
            b.setAttribute("data-pin", name);
            b.innerHTML = PIN_ICON;
            b.addEventListener("click", function (e) { e.stopPropagation(); G = g; togglePin(name); });
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
        { id: "anim", label: "Движения" },
        { id: "graphic", label: "Графика" },
        { id: "sfx", label: "Звуки" }
    ];
    var AC_PRESETS = {
        trans: [],
        text: [],
        anim: [],
        graphic: [],
        sfx: []
    };
    // Переходы прошлых версий (ключами на самом слое, до 1.19): нужны только для «✎ Изменить».
    var AC_LEGACY_TRANS = [["zoom-blur", "Зум с размытием"], ["spin-zoom", "Вращение с зумом"], ["push-left", "Сдвиг влево"], ["push-right", "Сдвиг вправо"],
        ["push-up", "Сдвиг вверх"], ["wipe", "Шторка"], ["clock-wipe", "Круговая шторка"], ["flash", "Вспышка"], ["glitch", "Глитч"],
        ["stretch", "Растяжение"], ["blur", "Размытие"]];

    // ---- «Переходы» — как Transitions в Animation Composer: переход ставится на склейку, а не на слой.
    // У указателя времени сверху появляется новый слой (половина до склейки, половина после): корректирующий
    // для камеры и глитча, заливка для засветок и затемнений, шейп для шторок. Всё на нём — выражения от длины
    // самого слоя, поэтому растянули слой — изменилась длительность. «Сила» — в Effect Controls.
    var TR_FOLDERS = [
        { id: "all", label: "Все" }, { id: "zoom", label: "Зум" }, { id: "pan", label: "Панорама" }, { id: "rotate", label: "Поворот" },
        { id: "shake", label: "Тряска" }, { id: "glitch", label: "Глитч" }, { id: "light", label: "Засветки" },
        { id: "fade", label: "Размытие и затемнение" }, { id: "shapes", label: "Шейпы" }
    ];
    var TR_LIST = [
        ["zoom", "zoom-in", "Наезд"], ["zoom", "zoom-out", "Отъезд"], ["zoom", "zoom-in-out", "Наезд и отъезд"],
        ["zoom", "zoom-distort-in", "Наезд с искажением"], ["zoom", "zoom-distort-out", "Отъезд с искажением"], ["zoom", "zoom-hit", "Мощный наезд с ударом"],
        ["pan", "pan-left", "Панорама влево"], ["pan", "pan-right", "Панорама вправо"], ["pan", "pan-up", "Панорама вверх"], ["pan", "pan-down", "Панорама вниз"],
        ["rotate", "rotate", "Поворот"], ["rotate", "roll", "Кувырок"], ["rotate", "zoom-rotate", "Наезд с поворотом"], ["rotate", "twirl", "Закрутка"],
        ["shake", "shake", "Тряска с искажением"],
        ["glitch", "glitch", "Цифровой глитч"], ["glitch", "glitch-shake", "Глитч с тряской"],
        ["light", "leak-warm", "Тёплая засветка"], ["light", "leak-cool", "Холодная засветка"], ["light", "flash", "Вспышка"],
        ["fade", "blur-dissolve", "Через размытие"], ["fade", "fade-black", "Через чёрный"], ["fade", "fade-white", "Через белый"],
        ["shapes", "wipe-left", "Шторка"], ["shapes", "wipe-up", "Шторка вверх"], ["shapes", "circle", "Круг"]
    ];
    var TR_BY_ID = {};

    // Пресеты, поставленные прошлыми версиями ключами (до 1.18): нужны только для названий во «✎ Изменить».
    var AC_LEGACY_ANIM = [["fade", "Прозрачность"], ["scale-up", "Масштаб"], ["pop", "Пружинка"], ["slide-left", "Слева"], ["slide-right", "Справа"],
        ["slide-up", "Снизу"], ["slide-down", "Сверху"], ["rotate-in", "Поворот"], ["spin-scale", "Вихрь"], ["blur-in", "Из размытия"],
        ["drop-bounce", "Падение с отскоком"], ["swing", "Качание"], ["squash", "Сплющивание"]];

    // ---- «Движения» — как Motion Presets в Animation Composer. Пресет не запекает ключи: на слой ставятся
    // маркер IN/OUT (его длина — длительность), эффекты-настройки и выражения поверх своих ключей слоя.
    // Каждое движение есть в нескольких кривых; формы движений те же, что в host.jsx (SF_MOTIONS).
    var SF_FOLDERS = [
        { id: "all", label: "Все" }, { id: "fade", label: "Прозрачность" }, { id: "move", label: "Сдвиг" }, { id: "scale", label: "Масштаб" },
        { id: "rotate", label: "Поворот" }, { id: "blur", label: "Размытие" }, { id: "combo", label: "Комбо" }
    ];
    var SF_CURVE_NAMES = { ease: "плавно", linear: "ровно", over: "с перелётом", bounce: "с отскоком", elastic: "пружина" };
    var SF_LIST = [
        ["fade", "fade", "Прозрачность", ["ease", "linear"], { op: 0 }],
        ["move", "from-bottom", "Снизу", ["ease", "over", "bounce"], { op: 0, dy: 1 }],
        ["move", "from-top", "Сверху", ["ease", "over", "bounce"], { op: 0, dy: -1 }],
        ["move", "from-left", "Слева", ["ease", "over", "bounce"], { op: 0, dx: -1 }],
        ["move", "from-right", "Справа", ["ease", "over", "bounce"], { op: 0, dx: 1 }],
        ["scale", "scale-up", "Из точки", ["ease", "over", "bounce", "elastic"], { op: 0, sc: 0 }],
        ["scale", "scale-down", "Из крупного", ["ease", "over"], { op: 0, sc: 200 }],
        ["rotate", "rotate", "Поворот", ["ease", "over", "elastic"], { op: 0, rot: -90 }],
        ["rotate", "spin", "Вихрь", ["ease", "over"], { op: 0, rot: -360, sc: 0 }],
        ["blur", "blur", "Из размытия", ["ease"], { op: 0, blur: 40 }],
        ["blur", "blur-scale", "Размытие с зумом", ["ease"], { op: 0, blur: 30, sc: 130 }],
        ["combo", "rise-rotate", "Снизу с поворотом", ["ease", "over"], { op: 0, dy: 1, rot: -20 }],
        ["combo", "rise-scale", "Снизу с масштабом", ["ease", "over"], { op: 0, dy: 1, sc: 60 }],
        ["combo", "stretch", "Растяжение", ["over", "elastic"], { op: 0, scx: 300, scy: 20 }],
        ["combo", "drop", "Падение", ["bounce", "over"], { dy: -1, far: true }]
    ];
    var SF_PARAM_LABELS = { dist: "Дистанция", sc: "Масштаб", scx: "Ширина", scy: "Высота", rot: "Угол", op: "Прозрачность", blur: "Размытие" };
    var SF_PARAM_UNIT = { dist: " px", sc: "%", scx: "%", scy: "%", rot: "°", op: "%", blur: "",
        tpos: " px", tscale: "%", trot: "°", tblur: "", ttrack: "", tskew: "°", top: "%", stagger: "%" };
    // Подписи настроек текстовых пресетов (во «✎ Изменить»); в панели эффекта их не добавляем.
    var TX_PARAM_LABELS = { tpos: "Сдвиг", tscale: "Масштаб", trot: "Угол", tblur: "Размытие", ttrack: "Трекинг", tskew: "Наклон", top: "Прозрачность", stagger: "Очерёдность" };
    var SF_PARAM_RANGE = { dist: [0, 2000, 10], sc: [0, 400, 5], scx: [0, 600, 5], scy: [0, 600, 5], rot: [-720, 720, 5], op: [0, 100, 5], blur: [0, 200, 1],
        tpos: [-500, 500, 5], tscale: [0, 600, 5], trot: [-360, 360, 5], tblur: [0, 200, 1], ttrack: [-100, 300, 1], tskew: [-90, 90, 1], top: [0, 100, 5], stagger: [0, 95, 5] };
    var SF_BY_MOTION = {};
    var SF_BY_ID = {};
    SF_LIST.forEach(function (m) {
        SF_BY_MOTION[m[1]] = { folder: m[0], motion: m[1], title: m[2], curves: m[3], shape: m[4] };
        m[3].forEach(function (c) {
            var id = m[1] + "." + c;
            SF_BY_ID[id] = { folder: m[0], motion: m[1], curve: c, title: m[2], shape: m[4] };
            AC_PRESETS.anim.push([id, m[2] + " · " + SF_CURVE_NAMES[c]]);
        });
    });

    // Текст прошлых версий (ключами, до 1.21) — только для «✎ Изменить».
    var AC_LEGACY_TEXT = [["typewriter", "Печатная машинка"], ["fade-letters", "Проявление по буквам"], ["slide-letters", "Буквы снизу"],
        ["pop-letters", "Буквы с масштабом"], ["blur-letters", "Буквы из размытия"], ["rotate-letters", "Буквы с поворотом"],
        ["words", "По словам"], ["random", "Случайные буквы"], ["tracking", "Разлёт букв"]];

    // ---- «Текст» — как Text Presets в Animation Composer: те же маркеры IN/OUT, что у «Движений», а сам пресет —
    // текстовый аниматор с селектором-выражением, который ведёт буквы, слова или строки по маркеру друг за другом.
    // Пресеты разложены по анимируемым свойствам; каждый — по буквам, по словам и по строкам.
    var TX_FOLDERS = [
        { id: "all", label: "Все" }, { id: "fade", label: "Прозрачность" }, { id: "move", label: "Сдвиг" }, { id: "scale", label: "Масштаб" },
        { id: "rotate", label: "Поворот" }, { id: "blur", label: "Размытие" }, { id: "other", label: "Трекинг и другое" }
    ];
    var TX_UNITS = [{ id: "all", label: "Все" }, { id: "c", label: "По буквам" }, { id: "w", label: "По словам" }, { id: "l", label: "По строкам" }];
    var TX_UNIT_NAMES = { c: "по буквам", w: "по словам", l: "по строкам" };
    var TX_LIST = [
        ["fade", "fade", "Проявление", ["ease"], { op: 0 }],
        ["move", "from-bottom", "Снизу", ["ease", "over"], { op: 0, y: 1 }],
        ["move", "from-top", "Сверху", ["ease"], { op: 0, y: -1 }],
        ["move", "from-left", "Слева", ["ease"], { op: 0, x: -1 }],
        ["move", "from-right", "Справа", ["ease"], { op: 0, x: 1 }],
        ["scale", "scale-up", "Из точки", ["ease", "over"], { op: 0, sc: 0 }],
        ["scale", "scale-down", "Из крупного", ["ease"], { op: 0, sc: 300 }],
        ["rotate", "rotate", "Поворот", ["over"], { op: 0, rot: -90 }],
        ["blur", "blur", "Из размытия", ["ease"], { op: 0, blur: 1 }],
        ["other", "tracking", "Разлёт", ["ease"], { op: 0, track: 1 }],
        ["other", "skew", "Наклон", ["over"], { op: 0, skew: 40, y: 0.5 }],
        ["other", "typewriter", "Печатная машинка", ["linear"], { op: 0, type: true }, ["c"]]
    ];
    var TX_BY_ID = {};
    var TX_BY_MOTION = {};
    TX_LIST.forEach(function (t) {
        (t[5] || ["c", "w", "l"]).forEach(function (u) {
            var motion = "tx-" + t[1] + "-" + u, title = t[2] + (t[5] ? "" : " " + TX_UNIT_NAMES[u]);
            TX_BY_MOTION[motion] = { folder: t[0], motion: motion, title: title, curves: t[3], shape: t[4], unit: u };
            t[3].forEach(function (c, i) {
                var id = motion + "." + c;
                TX_BY_ID[id] = { folder: t[0], motion: motion, curve: c, title: title, shape: t[4], unit: u };
                AC_PRESETS.text.push([id, title + (i > 0 ? " · " + SF_CURVE_NAMES[c] : "")]);
            });
        });
    });

    // ---- «Звуки» — как Sound Effects в Animation Composer: папки, превью ▶, высота тона и громкость до вставки
    // и потом во «✎ Изменить». Все звуки синтезированы tools/make_sfx.py (список ниже — из него же).
    var SFX_FOLDERS = [
        { id: "all", label: "Все" },
        { id: "whoosh", label: "Вжухи" },
        { id: "swipe", label: "Свайпы" },
        { id: "impact", label: "Удары" },
        { id: "riser", label: "Нарастания" },
        { id: "ui", label: "Интерфейс" },
        { id: "pop", label: "Попы" },
        { id: "glitch", label: "Глитч" },
        { id: "bell", label: "Звонки" },
        { id: "cartoon", label: "Мультяшные" },
        { id: "mech", label: "Механика" }
    ];
    var SFX_LIST = [
        ["whoosh", "whoosh", "Вжух"], ["whoosh", "whoosh-short", "Вжух короткий"], ["whoosh", "whoosh-long", "Вжух длинный"],
        ["whoosh", "whoosh-deep", "Вжух низкий"], ["whoosh", "whoosh-airy", "Вжух воздушный"], ["whoosh", "whoosh-fast", "Вжух быстрый"],
        ["whoosh", "whoosh-double", "Двойной вжух"], ["whoosh", "whoosh-reverse", "Обратный вжух"], ["whoosh", "swish", "Свист"],
        ["whoosh", "sword", "Взмах мечом"], ["whoosh", "wind-pass", "Порыв ветра"], ["whoosh", "swoosh-cloth", "Взмах ткани"],
        ["swipe", "swipe-up", "Взмах"], ["swipe", "swipe-in", "Свайп вверх"], ["swipe", "swipe-out", "Свайп вниз"],
        ["swipe", "swipe-long", "Длинный свайп"], ["swipe", "zip-up", "Молния вверх"], ["swipe", "zip-down", "Молния вниз"],
        ["swipe", "page", "Перелистывание"], ["swipe", "scribble", "Карандаш"], ["impact", "impact", "Удар"],
        ["impact", "impact-hard", "Жёсткий удар"], ["impact", "boom", "Кинематографичный бум"], ["impact", "punch", "Хлопок кулаком"],
        ["impact", "thud", "Глухой удар"], ["impact", "metal", "Металл"], ["impact", "metal-high", "Металл высокий"],
        ["impact", "explosion", "Взрыв"], ["impact", "braam", "Браам"], ["impact", "heartbeat", "Сердцебиение"], ["riser", "riser", "Нарастание"],
        ["riser", "riser-short", "Нарастание короткое"], ["riser", "riser-long", "Нарастание длинное"],
        ["riser", "riser-noise", "Шумовое нарастание"], ["riser", "riser-tone", "Тональное нарастание"], ["riser", "power-up", "Зарядка"],
        ["riser", "downer", "Спад"], ["riser", "downer-long", "Долгий спад"], ["riser", "power-down", "Выключение"], ["ui", "click", "Клик"],
        ["ui", "click-soft", "Мягкий клик"], ["ui", "click-hard", "Резкий клик"], ["ui", "tap", "Тап"], ["ui", "tick", "Тик"],
        ["ui", "toggle-on", "Переключатель вкл"], ["ui", "toggle-off", "Переключатель выкл"], ["ui", "hover", "Наведение"],
        ["ui", "select", "Выбор"], ["ui", "back", "Назад"], ["ui", "success", "Успех"], ["ui", "error", "Ошибка"], ["ui", "notify", "Уведомление"],
        ["ui", "message", "Сообщение"], ["pop", "pop", "Поп"], ["pop", "pop-high", "Поп высокий"], ["pop", "pop-low", "Поп низкий"],
        ["pop", "plop", "Плюх"], ["pop", "cork", "Пробка"], ["pop", "bubble", "Пузырь"], ["pop", "bubble-down", "Пузырь вниз"],
        ["pop", "bubbles", "Пузырьки"], ["glitch", "glitch", "Глитч"], ["glitch", "glitch-short", "Глитч короткий"],
        ["glitch", "glitch-long", "Глитч длинный"], ["glitch", "glitch-noise", "Цифровой шум"], ["glitch", "glitch-stutter", "Заикание"],
        ["glitch", "bitcrush", "Битовый шум"], ["glitch", "data", "Передача данных"], ["glitch", "static", "Помехи"],
        ["glitch", "tv-off", "Выключение ТВ"], ["bell", "ding", "Дзынь"], ["bell", "ding-low", "Дзынь низкий"],
        ["bell", "ding-high", "Дзынь высокий"], ["bell", "bell", "Колокольчик"], ["bell", "chime-up", "Перелив вверх"],
        ["bell", "chime-down", "Перелив вниз"], ["bell", "sparkle", "Волшебные искры"], ["bell", "alert", "Сигнал"], ["bell", "coin", "Монетка"],
        ["cartoon", "boing", "Пружина"], ["cartoon", "slide-up", "Свисток вверх"], ["cartoon", "slide-down", "Свисток вниз"],
        ["cartoon", "wobble", "Дрожание"], ["cartoon", "jump", "Прыжок"], ["cartoon", "fall", "Падение"], ["cartoon", "laser", "Лазер"],
        ["cartoon", "power-8bit", "8 бит: усиление"], ["cartoon", "squeak", "Писк"], ["mech", "typing", "Клавиатура"],
        ["mech", "typing-fast", "Быстрый набор"], ["mech", "shutter", "Затвор камеры"], ["mech", "flash", "Вспышка фотоаппарата"],
        ["mech", "switch", "Выключатель"], ["mech", "clock", "Часы"]
    ];
    var SFX_BY_ID = {};
    SFX_LIST.forEach(function (x) { SFX_BY_ID[x[1]] = { folder: x[0], title: x[2] }; AC_PRESETS.sfx.push([x[1], x[2]]); });

    // ---- «Графика» — как Graphic Components в Animation Composer: новый слой у указателя времени (над выделенным
    // слоем или в центре), анимация — выражения от длины слоя, «Цвет», «Размер» и «Толщина» — в Effect Controls.
    var GR_FOLDERS = [
        { id: "all", label: "Все" }, { id: "shapes", label: "Элементы" }, { id: "fx", label: "Спецэффекты" }, { id: "drawn", label: "Рисованные" },
        { id: "bg", label: "Фоны" }, { id: "overlay", label: "Оверлеи" }, { id: "titles", label: "Плашки" }
    ];
    var GR_DUR = { shapes: 1.2, fx: 1.2, drawn: 2.5, bg: 5, overlay: 5, titles: 4 };
    var GR_LIST = [
        ["shapes", "ring-burst", "Кольцо"], ["shapes", "ring-double", "Двойное кольцо"], ["shapes", "lines-burst", "Лучи"], ["shapes", "dots-burst", "Точки"],
        ["shapes", "star-burst", "Звёзды"], ["shapes", "circle-pop", "Круг"], ["shapes", "square-spin", "Квадрат"], ["shapes", "triangle-burst", "Треугольники"],
        ["shapes", "plus-burst", "Плюсы"], ["shapes", "zigzag", "Зигзаг"], ["shapes", "ripples", "Круги на воде"], ["shapes", "sparkle", "Искорка"],
        ["shapes", "confetti", "Конфетти"],
        ["fx", "speed-lines", "Линии скорости"], ["fx", "smoke-puff", "Облачко дыма"], ["fx", "explosion-burst", "Взрыв"], ["fx", "lightning", "Молния"],
        ["fx", "sunburst", "Солнечные лучи"], ["fx", "glitch-blocks", "Глитч-блоки"], ["fx", "shockwave", "Ударная волна"], ["fx", "swirl", "Вихрь"],
        ["drawn", "underline", "Подчёркивание"], ["drawn", "circle-scribble", "Обводка"], ["drawn", "arrow", "Стрелка"], ["drawn", "cross-out", "Зачёркивание"],
        ["drawn", "check", "Галочка"], ["drawn", "highlight", "Маркер"], ["drawn", "bracket", "Скобки"], ["drawn", "star-doodle", "Звёздочка"],
        ["drawn", "exclaim", "Акцент"],
        ["bg", "bg-gradient", "Градиент"], ["bg", "bg-grid", "Сетка"], ["bg", "bg-dots", "Точки"], ["bg", "bg-stripes", "Полосы"], ["bg", "bg-rays", "Лучи"],
        ["bg", "bg-circles", "Круги"],
        ["overlay", "vignette", "Виньетка"], ["overlay", "grain", "Зерно плёнки"], ["overlay", "flicker", "Мерцание"], ["overlay", "letterbox", "Кинополосы"],
        ["overlay", "frame", "Рамка"], ["overlay", "scanlines", "Строки развёртки"],
        ["titles", "lower-third", "Плашка для титра"], ["titles", "callout", "Выноска"], ["titles", "label", "Ярлык"], ["titles", "progress", "Полоса загрузки"],
        ["titles", "counter", "Счётчик"], ["titles", "timer", "Таймер"]
    ];
    var GR_TEXT_DEFAULT = { "lower-third": "Имя Фамилия", "callout": "Подпись", "label": "Ярлык" };
    var GR_BY_ID = {};
    GR_LIST.forEach(function (g) { GR_BY_ID[g[1]] = { folder: g[0], title: g[2] }; AC_PRESETS.graphic.push([g[1], g[2]]); });

    // Значки карточек: маленький SVG того же рисунка (цвет — из «Цвет графики»).
    function grIcon(id) {
        var S = function (d, extra) { return "<path d=\"" + d + "\" " + (extra || "") + "/>"; };
        var C = function (x, y, r, extra) { return "<circle cx=\"" + x + "\" cy=\"" + y + "\" r=\"" + r + "\" " + (extra || "") + "/>"; };
        var R = function (x, y, w, h, rx, extra) { return "<rect x=\"" + x + "\" y=\"" + y + "\" width=\"" + w + "\" height=\"" + h + "\" rx=\"" + (rx || 0) + "\" " + (extra || "") + "/>"; };
        var F = "fill=\"currentColor\" stroke=\"none\"", i, out = "", a;
        var rays = function (n, r1, r2) { var o = ""; for (i = 0; i < n; i++) { a = i * 2 * Math.PI / n; o += S("M" + (50 + Math.sin(a) * r1).toFixed(1) + " " + (50 - Math.cos(a) * r1).toFixed(1) + "L" + (50 + Math.sin(a) * r2).toFixed(1) + " " + (50 - Math.cos(a) * r2).toFixed(1)); } return o; };
        var ring = function (n, r, fn) { var o = ""; for (i = 0; i < n; i++) { a = i * 2 * Math.PI / n; o += fn(50 + Math.sin(a) * r, 50 - Math.cos(a) * r, a); } return o; };
        var star = function (cx, cy, r1, r2, n) { var p = "", k; for (k = 0; k < n * 2; k++) { a = k * Math.PI / n; var rr = k % 2 ? r2 : r1; p += (k ? "L" : "M") + (cx + Math.sin(a) * rr).toFixed(1) + " " + (cy - Math.cos(a) * rr).toFixed(1); } return p + "Z"; };
        switch (id) {
        case "ring-burst": out = C(50, 50, 28); break;
        case "ring-double": out = C(50, 50, 30) + C(50, 50, 18); break;
        case "lines-burst": out = rays(12, 18, 38); break;
        case "dots-burst": out = ring(10, 32, function (x, y) { return C(x, y, 4, F); }); break;
        case "star-burst": out = ring(8, 32, function (x, y) { return S(star(x, y, 7, 3, 5), F); }); break;
        case "circle-pop": out = C(50, 50, 24, F); break;
        case "square-spin": out = R(30, 30, 40, 40, 6, "transform=\"rotate(20 50 50)\""); break;
        case "triangle-burst": out = ring(6, 32, function (x, y) { return S("M" + x + " " + (y - 6) + "l6 10h-12z", F); }); break;
        case "plus-burst": out = ring(6, 32, function (x, y) { return S("M" + (x - 5) + " " + y + "h10M" + x + " " + (y - 5) + "v10"); }); break;
        case "zigzag": out = S("M15 58L25 42L35 58L45 42L55 58L65 42L75 58L85 42"); break;
        case "ripples": out = C(50, 50, 10) + C(50, 50, 22, "opacity=\".6\"") + C(50, 50, 34, "opacity=\".3\""); break;
        case "sparkle": out = S(star(50, 50, 28, 6, 4), F); break;
        case "confetti": out = R(22, 30, 6, 10, 1, F + " transform=\"rotate(20 25 35)\"") + R(48, 22, 6, 10, 1, F + " transform=\"rotate(-30 51 27)\"") + R(70, 40, 6, 10, 1, F) + R(35, 60, 6, 10, 1, F + " transform=\"rotate(50 38 65)\"") + R(62, 66, 6, 10, 1, F); break;
        case "speed-lines": out = rays(16, 30, 48); break;
        case "smoke-puff": out = C(40, 55, 14, F + " opacity=\".7\"") + C(58, 48, 16, F + " opacity=\".7\"") + C(52, 62, 12, F + " opacity=\".7\""); break;
        case "explosion-burst": out = S(star(50, 50, 34, 18, 12), F); break;
        case "lightning": out = S("M54 14L40 50H54L44 86", "stroke-width=\"6\""); break;
        case "sunburst": out = ring(12, 0, function (x, y, a2) { return S("M50 50L" + (50 + Math.sin(a2 - 0.13) * 46).toFixed(1) + " " + (50 - Math.cos(a2 - 0.13) * 46).toFixed(1) + "L" + (50 + Math.sin(a2 + 0.13) * 46).toFixed(1) + " " + (50 - Math.cos(a2 + 0.13) * 46).toFixed(1) + "Z", F + " opacity=\".7\""); }); break;
        case "glitch-blocks": out = R(18, 30, 30, 7, 0, F) + R(52, 46, 34, 7, 0, F) + R(26, 62, 24, 7, 0, F) + R(60, 24, 16, 7, 0, F); break;
        case "shockwave": out = C(50, 50, 34, "stroke-width=\"8\"") + C(50, 50, 44, "stroke-width=\"2\""); break;
        case "swirl": out = S("M50 50m0-2a4 4 0 1 1-4 4a10 10 0 1 1 10 10a18 18 0 1 1-18-18a28 28 0 1 1 28 28"); break;
        case "underline": out = S("M14 58q12-10 24 0t24 0t24 0"); break;
        case "circle-scribble": out = S("M50 30c26 0 38 10 36 20s-16 20-36 20s-36-8-36-20s20-22 42-18"); break;
        case "arrow": out = S("M16 66q30-46 66-20M70 40l12 6l-6 12"); break;
        case "cross-out": out = S("M24 30L76 70M76 30L24 70"); break;
        case "check": out = S("M24 52l16 16l36-36", "stroke-width=\"8\""); break;
        case "highlight": out = S("M14 52L86 48", "stroke-width=\"16\" opacity=\".55\""); break;
        case "bracket": out = S("M30 26H22V74H30M70 26H78V74H70"); break;
        case "star-doodle": out = S(star(50, 52, 32, 13, 5)); break;
        case "exclaim": out = rays(5, 20, 34).replace(/<path/g, "<path transform=\"rotate(-60 50 50)\""); break;
        case "bg-gradient": out = "<defs><linearGradient id=\"g\" x1=\"0\" x2=\"1\" y1=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"currentColor\"/><stop offset=\"1\" stop-color=\"#101018\"/></linearGradient></defs>" + R(4, 14, 92, 72, 6, "fill=\"url(#g)\" stroke=\"none\""); break;
        case "bg-grid": for (i = 0; i < 5; i++) { out += S("M" + (10 + i * 20) + " 14V86", "stroke-width=\"1.5\"") + S("M4 " + (20 + i * 15) + "H96", "stroke-width=\"1.5\""); } break;
        case "bg-dots": for (i = 0; i < 20; i++) { out += C(14 + (i % 5) * 18, 24 + Math.floor(i / 5) * 17, 2.6, F); } break;
        case "bg-stripes": for (i = 0; i < 6; i++) { out += S("M" + (i * 20 - 10) + " 86L" + (i * 20 + 30) + " 14", "stroke-width=\"6\" opacity=\".6\""); } break;
        case "bg-rays": out = ring(16, 0, function (x, y, a2) { return i % 2 ? "" : S("M50 50L" + (50 + Math.sin(a2) * 60).toFixed(1) + " " + (50 - Math.cos(a2) * 60).toFixed(1) + "L" + (50 + Math.sin(a2 + 0.4) * 60).toFixed(1) + " " + (50 - Math.cos(a2 + 0.4) * 60).toFixed(1) + "Z", F + " opacity=\".5\""); }); break;
        case "bg-circles": out = C(50, 50, 12) + C(50, 50, 24, "opacity=\".7\"") + C(50, 50, 36, "opacity=\".45\"") + C(50, 50, 48, "opacity=\".25\""); break;
        case "vignette": out = "<defs><radialGradient id=\"v\"><stop offset=\".45\" stop-color=\"currentColor\" stop-opacity=\"0\"/><stop offset=\"1\" stop-color=\"#000\"/></radialGradient></defs>" + R(4, 14, 92, 72, 4, "fill=\"url(#v)\" stroke=\"none\""); break;
        case "grain": for (i = 0; i < 40; i++) { out += C((i * 37) % 92 + 4, (i * 53) % 70 + 15, 1.4, F + " opacity=\".7\""); } break;
        case "flicker": out = R(4, 14, 92, 72, 4, F + " opacity=\".35\""); break;
        case "letterbox": out = R(4, 14, 92, 14, 0, "fill=\"#000\" stroke=\"none\"") + R(4, 72, 92, 14, 0, "fill=\"#000\" stroke=\"none\"") + R(4, 28, 92, 44, 0, F + " opacity=\".25\""); break;
        case "frame": out = R(12, 22, 76, 56, 4); break;
        case "scanlines": for (i = 0; i < 12; i++) { out += S("M4 " + (16 + i * 6) + "H96", "stroke-width=\"1.5\" opacity=\".5\""); } break;
        case "lower-third": out = R(14, 54, 66, 16, 2, "fill=\"#20202a\" stroke=\"none\"") + R(14, 54, 3, 16, 0, F) + S("M22 62H60", "stroke-width=\"3\""); break;
        case "callout": out = C(24, 70, 4, F) + S("M24 70L40 52H84", "stroke-width=\"3\""); break;
        case "label": out = R(22, 38, 56, 24, 12, F); break;
        case "progress": out = R(14, 44, 72, 12, 6) + S("M20 50H56", "stroke-width=\"6\""); break;
        case "counter": out = "<text x=\"50\" y=\"60\" text-anchor=\"middle\" font-size=\"28\" font-weight=\"800\" fill=\"currentColor\" stroke=\"none\">42%</text>"; break;
        case "timer": out = "<text x=\"50\" y=\"60\" text-anchor=\"middle\" font-size=\"24\" font-weight=\"800\" fill=\"currentColor\" stroke=\"none\">00:10</text>"; break;
        }
        return "<svg viewBox=\"0 0 100 100\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\">" + out + "</svg>";
    }

    TR_LIST.forEach(function (t) {
        TR_BY_ID[t[1]] = { folder: t[0], title: t[2] };
        AC_PRESETS.trans.push([t[1], t[2]]);
    });

    var AC_GLYPH = { arrow: "➜", star: "★", counter: "42%", timer: "00:10" };
    var AC_DEFAULTS = { sec: "trans", fav: [], mode: "in", dur: 0.6, color: "#ffffff", size: 112, favOnly: false, folder: "all", tfolder: "all", tdur: 0.8, xfolder: "all", xunit: "all", sfolder: "all", pitch: 0, vol: 0, gfolder: "all" };
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
        if (!SF_FOLDERS.some(function (f) { return f.id === out.folder; })) { out.folder = "all"; }
        if (!TR_FOLDERS.some(function (f) { return f.id === out.tfolder; })) { out.tfolder = "all"; }
        if (!TX_FOLDERS.some(function (f) { return f.id === out.xfolder; })) { out.xfolder = "all"; }
        if (!TX_UNITS.some(function (f) { return f.id === out.xunit; })) { out.xunit = "all"; }
        if (!SFX_FOLDERS.some(function (f) { return f.id === out.sfolder; })) { out.sfolder = "all"; }
        if (!GR_FOLDERS.some(function (f) { return f.id === out.gfolder; })) { out.gfolder = "all"; }
        out.pitch = Math.max(-12, Math.min(12, Math.round(Number(out.pitch)) || 0));
        out.vol = Math.max(-24, Math.min(6, Math.round(Number(out.vol)) || 0));
        out.tdur = Math.min(3, Math.max(0.2, Math.round(Number(out.tdur) * 10) / 10 || 0.8));
        out.fav = Array.isArray(s.fav) ? s.fav.filter(function (x) { return typeof x === "string"; }) : [];
        out.pins = Array.isArray(s.pins) ? s.pins.filter(function (x) { return typeof x === "string"; }) : [];
        return out;
    }

    function storeAcState() { try { window.localStorage.setItem(AC_KEY, JSON.stringify(acState)); } catch (e) {} }

    function acAll() {
        var out = [];
        AC_SECTIONS.forEach(function (s) {
            AC_PRESETS[s.id].forEach(function (p) {
                var item = { sec: s.id, id: p[0], name: p[1], key: s.id + ":" + p[0] }, sf = s.id === "anim" ? SF_BY_ID[p[0]] : null;
                if (sf) { item.folder = sf.folder; item.motion = sf.motion; item.curve = sf.curve; item.title = sf.title; item.shape = sf.shape; }
                if (s.id === "trans" && TR_BY_ID[p[0]]) { item.folder = TR_BY_ID[p[0]].folder; item.title = p[1]; }
                if (s.id === "sfx" && SFX_BY_ID[p[0]]) { item.folder = SFX_BY_ID[p[0]].folder; }
                if (s.id === "graphic" && GR_BY_ID[p[0]]) { item.folder = GR_BY_ID[p[0]].folder; }
                if (s.id === "text" && TX_BY_ID[p[0]]) {
                    sf = TX_BY_ID[p[0]];
                    item.folder = sf.folder; item.motion = sf.motion; item.curve = sf.curve; item.title = sf.title; item.shape = sf.shape; item.unit = sf.unit;
                }
                out.push(item);
            });
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
            if (acState.favOnly) { return true; }
            if (p.sec !== acState.sec) { return false; }
            if (p.sec === "anim") { return acState.folder === "all" || p.folder === acState.folder; }
            if (p.sec === "trans") { return acState.tfolder === "all" || p.folder === acState.tfolder; }
            if (p.sec === "sfx") { return acState.sfolder === "all" || p.folder === acState.sfolder; }
            if (p.sec === "graphic") { return acState.gfolder === "all" || p.folder === acState.gfolder; }
            if (p.sec === "text") { return (acState.xfolder === "all" || p.folder === acState.xfolder) && (acState.xunit === "all" || p.unit === acState.xunit); }
            return true;
        });
    }

    function acThumb(p) {
        var thumb = document.createElement("span");
        var obj = document.createElement("span");
        var i, bar;
        thumb.className = "ac-thumb";
        obj.className = "ac-obj ac-" + p.sec + " pv-" + p.sec + "-" + p.id;
        if (p.sec === "text") {
            obj.className = "ac-obj ac-text ac-txt";
            txSpans(obj, p.unit);
            txStill(obj, p);
        }
        if (p.sec === "anim") { obj.className = "ac-obj ac-anim"; obj.textContent = "✦"; }
        if (p.sec === "trans") {
            obj.className = "ac-obj ac-trv";
            obj.innerHTML = "<i class=\"trv-a\">A</i><i class=\"trv-b\">B</i>";
            bar = document.createElement("span");
            bar.className = "trv-ov trv-" + p.id;
            thumb.appendChild(obj);
            thumb.appendChild(bar);
            trStill(obj, bar, p.id);
            return thumb;
        }
        if (p.sec === "graphic") {
            obj.className = "ac-obj ac-gr";
            obj.style.color = acState.color;
            obj.innerHTML = grIcon(p.id);
            // Сама анимация — на холсте поверх всего мини-экрана; значок остаётся, если холст не работает.
            bar = document.createElement("canvas");
            bar.className = "ac-grc";
            if (bar.getContext && bar.getContext("2d")) { thumb.classList.add("gr-live"); }
            thumb.appendChild(bar);
        }
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
        if (acSeen) { acSeen.disconnect(); }
        grLive = [];
        ui.acGrid.innerHTML = "";
        ui.acGrid.style.setProperty("--ac-size", acState.size + "px");
        Array.prototype.forEach.call(ui.acTabs.querySelectorAll("button"), function (b) {
            var on = !searching && b.getAttribute("data-sec") === sec;
            b.setAttribute("aria-selected", on ? "true" : "false");
        });
        ui.acFavOnly.setAttribute("aria-pressed", acState.favOnly ? "true" : "false");
        ui.acModeRow.hidden = editing || !(searching || sec === "text" || sec === "anim");
        ui.acColorRow.hidden = editing || !(searching || sec === "graphic" || sec === "trans");
        ui.acDurRow.hidden = editing || (!searching && (sec === "sfx" || sec === "graphic"));
        ui.acFoot.hidden = editing;
        renderSfFolders(!searching && !editing && (sec === "anim" || sec === "trans" || sec === "text" || sec === "sfx" || sec === "graphic") ? sec : "");
        if (ui.acSndRow) {
            ui.acSndRow.hidden = editing || !(searching || sec === "sfx");
            ui.acPitch.value = String(acState.pitch);
            ui.acPitchVal.textContent = pitchText(acState.pitch);
            ui.acVol.value = String(acState.vol);
            ui.acVolVal.textContent = volText(acState.vol);
        }
        pressGroup(ui.acMode, acState.mode);
        ui.acDur.value = String(acState[durKey()]);
        ui.acDurVal.textContent = acState[durKey()].toFixed(1).replace(".", ",") + " с";
        ui.acColor.value = acState.color;
        ui.acSize.value = String(acState.size);
        ui.acHint.textContent = acHintText(searching ? "" : sec);
        if (editing) { renderAcEdit(); return; }
        if (!list.length) {
            ui.acGrid.appendChild(fxNote(acState.favOnly ? "В избранном пусто: нажмите ☆ на карточке, чтобы добавить." : "Ничего не нашлось."));
            return;
        }
        // Закреплённые карточки — первыми, под ними тонкая линия, дальше остальные.
        var pinned = list.filter(function (p) { return acState.pins.indexOf(p.key) >= 0; });
        var rest = list.filter(function (p) { return acState.pins.indexOf(p.key) < 0; });
        pinned.forEach(function (p) { ui.acGrid.appendChild(acCard(p, searching)); });
        if (pinned.length && rest.length) {
            var line = document.createElement("div");
            line.className = "ac-pin-line";
            line.setAttribute("role", "separator");
            ui.acGrid.appendChild(line);
        }
        rest.forEach(function (p) { ui.acGrid.appendChild(acCard(p, searching)); });
        markSfCards();
    }

    // У переходов своя длительность (по умолчанию 1 с: полсекунды до склейки и полсекунды после).
    function durKey() { return acState.sec === "trans" && !acState.favOnly && !(ui.acSearch && ui.acSearch.value.replace(/\s/g, "")) ? "tdur" : "dur"; }

    // Папки внутри раздела, как в дереве Animation Composer: у «Движений» и у «Переходов» свои.
    function renderSfFolders(sec) {
        var box = ui.acFolders, key = sec === "trans" ? "tfolder" : (sec === "text" ? "xfolder" : (sec === "sfx" ? "sfolder" : (sec === "graphic" ? "gfolder" : "folder")));
        if (!box) { return; }
        box.hidden = !sec;
        if (!sec) { return; }
        box.innerHTML = "";
        function chips(list, k, attr) {
            list.forEach(function (f) {
                var b = document.createElement("button");
                b.className = "ac-folder";
                b.setAttribute(attr, f.id);
                b.setAttribute("aria-pressed", acState[k] === f.id ? "true" : "false");
                b.textContent = f.label;
                b.addEventListener("click", function () { acState[k] = f.id; storeAcState(); renderAc(); });
                box.appendChild(b);
            });
        }
        chips(sec === "trans" ? TR_FOLDERS : (sec === "text" ? TX_FOLDERS : (sec === "sfx" ? SFX_FOLDERS : (sec === "graphic" ? GR_FOLDERS : SF_FOLDERS))), key, "data-folder");
        if (sec === "text") {
            var br = document.createElement("span");
            br.className = "ac-folder-break";
            box.appendChild(br);
            chips(TX_UNITS, "xunit", "data-unit");
        }
    }

    // ---- превью переходов: клип A до склейки, клип B после, то же движение, что даст выражение на слое.
    function trIn(x) { return x <= 0 ? 0 : Math.pow(2, 10 * x - 10); }
    function trOut(x) { return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); }
    function trCut(t, a, b) { return t < 0.5 ? a * trIn(t * 2) : b * (1 - trOut(t * 2 - 1)); }

    // Та же математика, что в выражениях на слое перехода (экспоненциальное движение к склейке и от неё).
    function trLook(id, t) {
        var bell = Math.pow(Math.sin(Math.PI * t), 2), peak = t < 0.5 ? trIn(t * 2) : trIn(2 - t * 2);
        var after = t < 0.5 ? 0 : Math.pow(1 - (t * 2 - 1), 2);
        var j = Math.floor(t * 24), r1 = Math.sin(j * 12.9898) * 43758.5453, rnd = r1 - Math.floor(r1);
        var o = { s: 1, r: 0, x: 0, y: 0, blur: 0, skew: 0, ov: 0, ox: 0, oy: 0, os: 1 };
        if (/^zoom-(in|distort-in)$/.test(id)) { o.s = 1 + trCut(t, 2, -0.67); o.blur = 5 * peak; }
        if (/^zoom-(out|distort-out)$/.test(id)) { o.s = 1 + trCut(t, -0.67, 2); o.blur = 5 * peak; }
        if (id === "zoom-in-out") { o.s = 1 + trCut(t, 2, 2); o.blur = 5 * peak; }
        if (id === "zoom-hit") { o.s = 1 + trCut(t, 3, -0.75) + 0.12 * after * Math.sin(t * 40); o.x = Math.sin(t * 90) * 0.05 * after; o.blur = 6 * peak; }
        if (id === "pan-left") { o.x = trCut(t, -1, 1); o.blur = 4 * peak; }
        if (id === "pan-right") { o.x = trCut(t, 1, -1); o.blur = 4 * peak; }
        if (id === "pan-up") { o.y = trCut(t, -1, 1); o.blur = 4 * peak; }
        if (id === "pan-down") { o.y = trCut(t, 1, -1); o.blur = 4 * peak; }
        if (id === "rotate") { o.s = 1 + 0.2 * bell; o.r = trCut(t, 90, -90); o.blur = 3 * peak; }
        if (id === "roll") { o.s = 1 + 0.3 * bell; o.r = trCut(t, 180, -180); o.blur = 4 * peak; }
        if (id === "zoom-rotate") { o.s = 1 + trCut(t, 2, -0.6); o.r = trCut(t, 120, -120); o.blur = 5 * peak; }
        if (id === "twirl") { o.s = 1 + trCut(t, 1.5, -0.5); o.r = trCut(t, 200, -200); o.blur = 4 * peak; }
        if (id === "shake") { o.s = 1 + 0.25 * bell; o.x = Math.sin(t * 90) * 0.07 * bell; o.y = Math.cos(t * 71) * 0.05 * bell; o.r = Math.sin(t * 57) * 10 * bell; o.blur = 2 * bell; }
        if (id === "glitch" || id === "glitch-shake") {
            o.x = (rnd - 0.5) * (id === "glitch" ? 0.2 : 0.35) * bell; o.skew = (rnd - 0.5) * 50 * bell; o.s = 1 + rnd * 0.3 * bell;
            if (id === "glitch-shake") { o.r = (rnd - 0.5) * 18 * bell; }
        }
        if (id === "blur-dissolve") { o.s = 1 + 0.15 * bell; o.blur = 10 * bell; }
        if (id === "leak-warm" || id === "leak-cool") { o.ov = Math.pow(Math.sin(Math.PI * t), 1.2); }
        if (id === "flash") { o.ov = peak; }
        if (id === "fade-black" || id === "fade-white") { o.ov = Math.min(1, Math.sin(Math.PI * t) * 1.4); }
        if (id === "wipe-left" || id === "wipe-up" || id === "circle") {
            var f = t < 0.5 ? 0.5 * trOut(t * 2) : 0.5 + 0.5 * trIn(t * 2 - 1);
            o.ov = 1;
            if (id === "wipe-left") { o.ox = f * 2 - 1; }
            if (id === "wipe-up") { o.oy = 1 - f * 2; }
            if (id === "circle") { o.os = t < 0.5 ? trOut(t * 2) : 1 - trIn(t * 2 - 1); }
        }
        return o;
    }

    // В покое карточка показывает кадр незадолго до склейки — так видно, чем переходы отличаются.
    function trStill(clips, ov, id) {
        var o = trLook(id, /^(wipe|circle)/.test(id) ? 0.12 : 0.46);
        clips.style.transform = "translate(" + (o.x * 100).toFixed(1) + "%," + (o.y * 100).toFixed(1) + "%) rotate(" + o.r.toFixed(1) +
            "deg) skewX(" + o.skew.toFixed(1) + "deg) scale(" + o.s.toFixed(3) + ")";
        clips.style.filter = "blur(" + o.blur.toFixed(2) + "px)";
        ov.style.opacity = String(Math.max(0, Math.min(1, o.ov)));
        ov.style.transform = "translate(" + (o.ox * 100).toFixed(1) + "%," + (o.oy * 100).toFixed(1) + "%) scale(" + o.os.toFixed(3) + ")";
    }

    function trPreview(card, p) {
        var clips = card.querySelector(".ac-trv"), b = card.querySelector(".trv-b"), ov = card.querySelector(".trv-ov");
        var n = 48, total = 2000, play = 1600, i, t, o, cf = [], of = [];
        if (!clips || !clips.animate) { return; }
        for (i = 0; i <= n; i++) {
            t = i / n;
            o = trLook(p.id, t);
            cf.push({ offset: t * play / total, transform: "translate(" + (o.x * 100).toFixed(1) + "%," + (o.y * 100).toFixed(1) + "%) rotate(" +
                o.r.toFixed(1) + "deg) skewX(" + o.skew.toFixed(1) + "deg) scale(" + o.s.toFixed(3) + ")", filter: "blur(" + o.blur.toFixed(2) + "px)" });
            of.push({ offset: t * play / total, opacity: Math.max(0, Math.min(1, o.ov)),
                transform: "translate(" + (o.ox * 100).toFixed(1) + "%," + (o.oy * 100).toFixed(1) + "%) scale(" + o.os.toFixed(3) + ")" });
        }
        cf.push({ offset: 1, transform: "none", filter: "blur(0px)" });
        of.push({ offset: 1, opacity: 0, transform: "none" });
        stopTrPreview(card);
        card.trAnims = [
            clips.animate(cf, { duration: total, iterations: Infinity }),
            b.animate([{ offset: 0, opacity: 0 }, { offset: 0.4, opacity: 0 }, { offset: 0.4001, opacity: 1 }, { offset: 0.9999, opacity: 1 }, { offset: 1, opacity: 0 }],
                { duration: total, iterations: Infinity }),
            ov.animate(of, { duration: total, iterations: Infinity })
        ];
    }

    // ---- Превью графики: каждая карточка рисует свою графику на холсте по тем же формулам, что стоят
    // в выражениях её слоя (host.jsx, GR_BUILD): та же длина, те же кривые, те же повторы и обрезки.
    // Размер и толщина — по умолчанию (100 % и 8 px), цвет — «Цвет графики».

    // Сколько пикселей композиции 1920×1080 видно по ширине мини-экрана и где его центр.
    var GR_VIEW = { "speed-lines": [1920, 0, 0], "lightning": [1250, 0, 0], "sunburst": [1100, 0, 0], "confetti": [1150, 0, 120],
        "lower-third": [1150, 330, -10], "callout": [1150, 300, -90], "progress": [900, 0, 0], "zigzag": [820, 0, 0], "underline": [880, 0, 0],
        "circle-scribble": [900, 0, 0], "arrow": [860, 0, 0], "bracket": [900, 0, 0], "highlight": [880, 0, 0], "shockwave": [960, 0, 0],
        "smoke-puff": [700, 0, -30], "glitch-blocks": [1100, 0, 0], "explosion-burst": [720, 0, 0], "label": [760, 0, 0] };

    function grRng(seed) {
        var a = (seed * 2654435761) >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function grHex(hex, m, a) {
        var n = parseInt(String(hex || "#ffffff").replace("#", ""), 16);
        if (isNaN(n)) { n = 0xffffff; }
        m = m === undefined ? 1 : m;
        return "rgba(" + Math.round(((n >> 16) & 255) * m) + "," + Math.round(((n >> 8) & 255) * m) + "," + Math.round((n & 255) * m) + "," + (a === undefined ? 1 : a) + ")";
    }

    // Точки контуров — как в слоях-фигурах: эллипс и звезда начинаются сверху и идут по часовой стрелке.
    function grEllipse(d, at) {
        var out = [], i, a, r = d / 2;
        at = at || [0, 0];
        for (i = 0; i < 72; i++) { a = -Math.PI / 2 + i * 2 * Math.PI / 72; out.push([at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r]); }
        return out;
    }

    function grRectPts(w, h, round, at) {
        var out = [], r = Math.min(round || 0, w / 2, h / 2), x0, y0, k, a;
        at = at || [0, 0];
        x0 = at[0] - w / 2; y0 = at[1] - h / 2;
        if (!r) { return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]; }
        [[x0 + w - r, y0 + r, -90], [x0 + w - r, y0 + h - r, 0], [x0 + r, y0 + h - r, 90], [x0 + r, y0 + r, 180]].forEach(function (c) {
            for (k = 0; k <= 6; k++) { a = (c[2] + k * 15) * Math.PI / 180; out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]); }
        });
        return out;
    }

    function grStarPts(n, outer, inner, polygon, at) {
        var out = [], k, a, r, m = polygon ? n : n * 2;
        at = at || [0, 0];
        for (k = 0; k < m; k++) {
            a = -Math.PI / 2 + k * 2 * Math.PI / m;
            r = polygon || k % 2 === 0 ? outer : inner;
            out.push([at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r]);
        }
        return out;
    }

    // Часть контура от start до end процентов длины (как Trim Paths).
    function grTrim(pts, closed, s, e) {
        var seg = [], total = 0, i, a, b, l, from, to, out = [], acc = 0, u;
        var list = closed ? pts.concat([pts[0]]) : pts;
        s = Math.max(0, Math.min(100, s)); e = Math.max(0, Math.min(100, e));
        if (s > e) { u = s; s = e; e = u; }
        if (e - s < 0.01) { return []; }
        for (i = 1; i < list.length; i++) {
            a = list[i - 1]; b = list[i]; l = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
            seg.push(l); total += l;
        }
        from = total * s / 100; to = total * e / 100;
        for (i = 1; i < list.length; i++) {
            a = list[i - 1]; b = list[i]; l = seg[i - 1];
            if (acc + l >= from && acc <= to && l > 0) {
                u = Math.max(0, (from - acc) / l);
                if (!out.length) { out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); }
                u = Math.min(1, (to - acc) / l);
                out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
            }
            acc += l;
        }
        return out;
    }

    // Рисовальщик одного кадра: t — секунды от начала слоя, L — длина слоя.
    function grPainter(ctx, t, L, color) {
        var g = {};
        var clamp = function (x) { return Math.min(1, Math.max(0, x)); };
        g.t = t; g.L = L;
        g.P = clamp(t / L);
        g.E = function (x) { x = clamp(x); return 1 - Math.pow(1 - x, 3); };
        g.B = function (x) { x = clamp(x); var s = 1.70158, q = x - 1; return 1 + (s + 1) * q * q * q + s * q * q; };
        g.In = function (d) { return g.E(t / d); };
        g.Out = function (d) { return g.E((L - t) / d); };
        g.W = 8;
        g.K = function (m, a) { return grHex(color, m, a); };
        g.rnd = function (seed, timeless) { var r = grRng(timeless ? seed : seed * 7919 + Math.floor(t * 12) + 1); return function (a, b) { var x = r(); return a === undefined ? x : a + x * (b - a); }; };
        // Группа: позиция, масштаб (в процентах), поворот, точка привязки, прозрачность — как Transform группы.
        g.grp = function (o, fn) {
            var sc = o.scale === undefined ? [100, 100] : (typeof o.scale === "number" ? [o.scale, o.scale] : o.scale);
            ctx.save();
            if (o.pos) { ctx.translate(o.pos[0], o.pos[1]); }
            if (o.rot) { ctx.rotate(o.rot * Math.PI / 180); }
            ctx.scale(Math.max(0.0001, sc[0] / 100), Math.max(0.0001, sc[1] / 100));
            if (sc[0] <= 0 || sc[1] <= 0) { ctx.restore(); return; }
            if (o.anchor) { ctx.translate(-o.anchor[0], -o.anchor[1]); }
            if (o.op !== undefined) { ctx.globalAlpha *= clamp(o.op / 100); }
            fn();
            ctx.restore();
        };
        // Repeater: копия i сдвинута на pos·i и повёрнута на rot·i вокруг начала координат группы.
        g.rep = function (n, rot, pos, fn) {
            var i;
            for (i = n - 1; i >= 0; i--) {
                ctx.save();
                if (pos) { ctx.translate(pos[0] * i, pos[1] * i); }
                if (rot) { ctx.rotate(rot * i * Math.PI / 180); }
                fn(i);
                ctx.restore();
            }
        };
        function trace(pts, closed) {
            var i;
            ctx.beginPath();
            for (i = 0; i < pts.length; i++) { if (i) { ctx.lineTo(pts[i][0], pts[i][1]); } else { ctx.moveTo(pts[i][0], pts[i][1]); } }
            if (closed) { ctx.closePath(); }
        }
        g.stroke = function (pts, closed, width, col, s, e) {
            if (width <= 0) { return; }
            if (s !== undefined) { pts = grTrim(pts, closed, s, e); closed = false; }
            if (pts.length < 2) { return; }
            trace(pts, closed);
            ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round";
            ctx.strokeStyle = col || g.K();
            ctx.stroke();
        };
        g.fill = function (pts, col) {
            if (pts.length < 3) { return; }
            trace(pts, true);
            ctx.fillStyle = col || g.K();
            ctx.fill();
        };
        g.text = function (str, x, y, size, align, alpha, col) {
            ctx.save();
            ctx.globalAlpha *= clamp(alpha);
            ctx.font = "700 " + size + "px Inter, 'Segoe UI', sans-serif";
            ctx.textAlign = align || "left";
            ctx.textBaseline = "alphabetic";
            ctx.fillStyle = col || "#fff";
            ctx.fillText(str, x, y);
            ctx.restore();
        };
        g.ctx = ctx;
        return g;
    }

    // Подпись к плашкам: появляется через 0,25 с за 0,3 с и уходит за 0,3 с до конца — как у текстового слоя.
    function grTextAlpha(g) { return Math.min(1, Math.max(0, (g.t - 0.25) / 0.3)) * Math.min(1, Math.max(0, (g.L - g.t) / 0.3)); }

    var GR_DRAW = {
        "ring-burst": function (g) {
            g.grp({ scale: g.E(g.P * 1.2) * 120 }, function () { g.stroke(grEllipse(200), true, g.W * (1 - g.E(g.P)) * 2); });
        },
        "ring-double": function (g) {
            g.grp({ scale: g.E(g.P * 1.2 - 0.18) * 90 }, function () { g.stroke(grEllipse(200), true, g.W * (1 - g.E(g.P - 0.15)) * 1.4); });
            g.grp({ scale: g.E(g.P * 1.2) * 120 }, function () { g.stroke(grEllipse(200), true, g.W * (1 - g.E(g.P)) * 2); });
        },
        "lines-burst": function (g) {
            g.rep(12, 30, null, function () { g.stroke([[0, -60], [0, -150]], false, g.W, null, 100 * g.E(g.P * 1.6 - 0.3), 100 * g.E(g.P * 1.6)); });
        },
        "dots-burst": function (g) {
            g.grp({ scale: 100 * (1 - g.E(g.P * 1.3 - 0.4)) }, function () {
                g.rep(10, 36, null, function () { g.fill(grEllipse(22, [0, -g.E(g.P * 1.3) * 170])); });
            });
        },
        "star-burst": function (g) {
            g.grp({ rot: g.P * 180, op: 100 * (1 - g.E(g.P * 1.3 - 0.5)) }, function () {
                g.rep(8, 45, null, function () { g.fill(grStarPts(5, 18, 8, false, [0, -g.E(g.P * 1.3) * 170])); });
            });
        },
        "circle-pop": function (g) {
            g.grp({ scale: 100 * g.B(g.t / 0.4) * g.Out(0.3) }, function () { g.fill(grEllipse(160)); });
        },
        "square-spin": function (g) {
            g.grp({ scale: 100 * g.B(g.t / 0.5) * g.Out(0.3), rot: g.E(g.P) * 180 }, function () { g.stroke(grRectPts(140, 140, 18), true, g.W); });
        },
        "triangle-burst": function (g) {
            g.grp({ rot: g.P * 240, op: 100 * (1 - g.E(g.P * 1.3 - 0.5)) }, function () {
                g.rep(6, 60, null, function () { g.fill(grStarPts(3, 16, 0, true, [0, -g.E(g.P * 1.3) * 160])); });
            });
        },
        "plus-burst": function (g) {
            var y = -g.E(g.P * 1.3) * 150, w = g.W * 0.7;
            g.grp({ op: 100 * (1 - g.E(g.P * 1.3 - 0.5)) }, function () {
                g.rep(6, 60, null, function () { g.fill(grRectPts(24, w, 0, [0, y])); g.fill(grRectPts(w, 24, 0, [0, y])); });
            });
        },
        "zigzag": function (g) {
            var pts = [], i;
            for (i = 0; i <= 8; i++) { pts.push([-240 + 60 * i, i % 2 ? -30 : 30]); }
            g.stroke(pts, false, g.W, null, 100 * g.E(g.P * 1.5 - 0.5), 100 * g.E(g.P * 1.5));
        },
        "ripples": function (g) {
            var i, q;
            for (i = 2; i >= 0; i--) {
                q = (g.t / 1.2 + i / 3) % 1;
                g.grp({ scale: q * 130 }, function () { g.stroke(grEllipse(200), true, g.W * (1 - q)); });
            }
        },
        "sparkle": function (g) {
            g.grp({ scale: 100 * g.B(g.t / 0.35) * g.Out(0.3) * (1 + 0.12 * Math.sin(g.t * 12)), rot: g.t * 40 }, function () { g.fill(grStarPts(4, 70, 14)); });
        },
        "confetti": function (g) {
            var i, r, m, a, v;
            for (i = 17; i >= 0; i--) {
                r = g.rnd(i + 1, true); m = 0.55 + r() * 0.45;
                r = g.rnd(i + 1, true); a = r(-Math.PI, 0); v = r(250, 520);
                var pos = [Math.cos(a) * v * g.t * 0.9, Math.sin(a) * v * g.t + 500 * g.t * g.t];
                r = g.rnd(i + 1, true);
                g.grp({ pos: pos, rot: r(-1, 1) * 720 * g.t, op: 100 * g.Out(0.25) }, function () { g.fill(grRectPts(14, 22, 2), g.K(m)); });
            }
        },
        "speed-lines": function (g) {
            var i, s, e;
            for (i = 19; i >= 0; i--) {
                s = g.rnd(i + 1, false)(0, 40); e = g.rnd(i + 1, false)(50, 100);
                g.grp({ rot: i * 18, op: 100 * g.In(0.15) * g.Out(0.2) }, function () { g.stroke([[0, -520], [0, -900]], false, g.W * 0.6, null, s, e); });
            }
        },
        "smoke-puff": function (g) {
            var i, r, a, rr, s;
            for (i = 6; i >= 0; i--) {
                r = g.rnd(i + 1, true); a = r(0, Math.PI * 2); rr = g.E(g.P) * r(60, 140);
                r = g.rnd(i + 1, true); s = (0.4 + g.E(g.P) * r(0.8, 1.4)) * 100;
                g.grp({ pos: [Math.cos(a) * rr, Math.sin(a) * rr - g.P * 60], scale: s, op: 80 * (1 - g.P) }, function () { g.fill(grEllipse(90), g.K(0.8)); });
            }
        },
        "explosion-burst": function (g) {
            g.grp({ scale: 100 * g.E(g.t / 0.25) * (1 - g.E(g.P * 1.2 - 0.2)) }, function () { g.fill(grEllipse(140), "#fff"); });
            g.grp({ scale: 100 * g.B(g.t / 0.3) * (1 - g.E(g.P * 1.2 - 0.3)) }, function () { g.fill(grStarPts(12, 180, 90)); });
        },
        "lightning": function (g) {
            var on = g.rnd(1, false)() < 0.75;
            g.grp({ op: on ? 100 * g.Out(0.2) : 0 }, function () { g.stroke([[-20, -320], [30, -120], [-30, -40], [40, 140], [-10, 320]], false, g.W * 1.2); });
        },
        "sunburst": function (g) {
            g.grp({ rot: g.t * 25, scale: 100 * g.E(g.t / 0.5) * g.Out(0.4), op: 70 }, function () {
                g.rep(12, 30, null, function () { g.fill([[0, 0], [-40, -400], [40, -400]]); });
            });
        },
        "glitch-blocks": function (g) {
            var i, r, at, on;
            for (i = 9; i >= 0; i--) {
                r = g.rnd(i + 1, false); at = [r(-400, 400), r(-220, 220)];
                on = g.rnd(i + 20, false)() < 0.5;
                g.grp({ op: on ? 100 * g.Out(0.15) : 0 }, function () { g.fill(grRectPts(120, 24, 0, at)); });
            }
        },
        "shockwave": function (g) {
            g.grp({ scale: g.E(g.P * 1.1 - 0.1) * 320 }, function () { g.stroke(grEllipse(200), true, g.W * 0.5 * (1 - g.E(g.P))); });
            g.grp({ scale: g.E(g.P * 1.1) * 250 }, function () { g.stroke(grEllipse(200), true, g.W * 3 * (1 - g.E(g.P))); });
        },
        "swirl": function (g) {
            var pts = [], i, u, a, r;
            for (i = 0; i <= 60; i++) { u = i / 60; a = u * Math.PI * 5; r = 10 + 160 * u; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
            g.grp({ rot: g.t * 120 }, function () { g.stroke(pts, false, g.W, null, 100 * g.E(g.P * 1.4 - 0.4), 100 * g.E(g.P * 1.4)); });
        },
        "underline": function (g) {
            var pts = [], i, u;
            for (i = 0; i <= 30; i++) { u = i / 30; pts.push([-300 + 600 * u, Math.sin(u * Math.PI * 3) * 10]); }
            g.stroke(pts, false, g.W, null, 100 * (1 - g.Out(0.4)), 100 * g.In(0.6));
        },
        "circle-scribble": function (g) {
            var pts = [], i, u, a, k;
            for (i = 0; i <= 70; i++) { u = i / 70; a = -Math.PI / 2 + u * Math.PI * 2.3; k = 1 + 0.06 * u; pts.push([Math.cos(a) * 280 * k, Math.sin(a) * 130 * k]); }
            g.stroke(pts, false, g.W, null, 100 * (1 - g.Out(0.4)), 100 * g.In(0.7));
        },
        "arrow": function (g) {
            var pts = [], i, u;
            for (i = 0; i <= 20; i++) { u = i / 20; pts.push([-260 + 500 * u, -120 * Math.sin(u * Math.PI) + 40 * u]); }
            g.stroke([[200, 0], [240, 40], [190, 70]], false, g.W, null, 100 * (1 - g.Out(0.4)), 100 * g.E((g.t - 0.5) / 0.25));
            g.stroke(pts, false, g.W, null, 100 * (1 - g.Out(0.4)), 100 * g.In(0.6));
        },
        "cross-out": function (g) {
            g.stroke([[200, -120], [-200, 120]], false, g.W, null, 100 * (1 - g.Out(0.3)), 100 * g.E((g.t - 0.3) / 0.35));
            g.stroke([[-200, -120], [200, 120]], false, g.W, null, 100 * (1 - g.Out(0.3)), 100 * g.In(0.35));
        },
        "check": function (g) {
            g.stroke([[-120, 0], [-40, 90], [140, -120]], false, g.W * 1.4, null, 100 * (1 - g.Out(0.3)), 100 * g.In(0.5));
        },
        "highlight": function (g) {
            g.grp({ op: 55 }, function () { g.stroke([[-300, 0], [300, -6]], false, g.W * 6, null, 100 * (1 - g.Out(0.3)), 100 * g.In(0.5)); });
        },
        "bracket": function (g) {
            g.stroke([[260, -140], [300, -140], [300, 140], [260, 140]], false, g.W, null, 100 * (1 - g.Out(0.3)), 100 * g.In(0.5));
            g.stroke([[-260, -140], [-300, -140], [-300, 140], [-260, 140]], false, g.W, null, 100 * (1 - g.Out(0.3)), 100 * g.In(0.5));
        },
        "star-doodle": function (g) {
            var pts = [], i;
            for (i = 0; i <= 5; i++) { pts.push([Math.cos(-Math.PI / 2 + i * 4 * Math.PI / 5) * 150, Math.sin(-Math.PI / 2 + i * 4 * Math.PI / 5) * 150]); }
            g.stroke(pts, false, g.W, null, 100 * (1 - g.Out(0.3)), 100 * g.In(0.7));
        },
        "exclaim": function (g) {
            g.grp({ rot: -60 }, function () { g.rep(5, 30, null, function () { g.stroke([[0, -70], [0, -130]], false, g.W, null, 100 * (1 - g.Out(0.3)), 100 * g.In(0.3)); }); });
        },
        "bg-gradient": function (g, W, H) {
            var c = g.ctx, pts = [[0.1 * W + Math.sin(g.t * 0.7) * W * 0.2, 0.1 * H + Math.cos(g.t * 0.5) * H * 0.2], [0.9 * W, 0.1 * H], [0.1 * W, 0.9 * H],
                [0.9 * W + Math.cos(g.t * 0.6) * W * 0.2, 0.9 * H + Math.sin(g.t * 0.8) * H * 0.2]];
            var n = parseInt(String(acState.color).replace("#", ""), 16) || 0xffffff, r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
            var cols = [[r, gg, b], [r * 0.3, gg * 0.3, b * 0.45], [b, r, gg], [8, 8, 15]];
            c.save();
            c.globalAlpha *= g.In(0.5) * g.Out(0.5);
            c.fillStyle = "rgb(8,8,15)"; c.fillRect(-W / 2, -H / 2, W, H);
            pts.forEach(function (p, i) {
                var gr = c.createRadialGradient(p[0] - W / 2, p[1] - H / 2, 0, p[0] - W / 2, p[1] - H / 2, W * 0.75);
                gr.addColorStop(0, "rgba(" + Math.round(cols[i][0]) + "," + Math.round(cols[i][1]) + "," + Math.round(cols[i][2]) + ",0.95)");
                gr.addColorStop(1, "rgba(" + Math.round(cols[i][0]) + "," + Math.round(cols[i][1]) + "," + Math.round(cols[i][2]) + ",0)");
                c.fillStyle = gr; c.fillRect(-W / 2, -H / 2, W, H);
            });
            c.restore();
        },
        "bg-grid": function (g, W, H) {
            g.grp({ op: 60 * g.In(0.5) * g.Out(0.5) }, function () {
                g.grp({ pos: [(g.t * 30) % 80, 0] }, function () { g.rep(Math.ceil(W / 80) + 3, 0, [80, 0], function () { g.stroke([[-W / 2 - 80, -H], [-W / 2 - 80, H]], false, g.W * 0.25); }); });
                g.grp({ pos: [0, (g.t * 30) % 80] }, function () { g.rep(Math.ceil(H / 80) + 3, 0, [0, 80], function () { g.stroke([[-W, -H / 2 - 80], [W, -H / 2 - 80]], false, g.W * 0.25); }); });
            });
        },
        "bg-dots": function (g, W, H) {
            g.grp({ op: 50 * g.In(0.5) * g.Out(0.5) }, function () {
                g.grp({ scale: 100 + 20 * Math.sin(g.t * 3) }, function () {
                    g.rep(Math.ceil(H / 60) + 1, 0, [0, 60], function () { g.rep(Math.ceil(W / 60) + 1, 0, [60, 0], function () { g.fill(grEllipse(10, [-W / 2, -H / 2])); }); });
                });
            });
        },
        "bg-stripes": function (g, W, H) {
            g.grp({ op: 35 * g.In(0.5) * g.Out(0.5) }, function () {
                g.grp({ pos: [(g.t * 60) % 100, 0], rot: 30 }, function () { g.rep(Math.ceil(W * 2.4 / 100) + 2, 0, [100, 0], function () { g.fill(grRectPts(40, H * 3, 0, [-W * 1.2, 0])); }); });
            });
        },
        "bg-rays": function (g, W, H) {
            var r = Math.ceil(Math.sqrt(W * W + H * H));
            g.grp({ op: 40 * g.In(0.5) * g.Out(0.5) }, function () {
                g.grp({ rot: g.t * 8 }, function () { g.rep(16, 22.5, null, function () { g.fill([[0, 0], [-r * 0.09, -r], [r * 0.09, -r]]); }); });
            });
        },
        "bg-circles": function (g) {
            var i, q;
            g.grp({ op: 70 * g.In(0.5) * g.Out(0.5) }, function () {
                for (i = 5; i >= 0; i--) {
                    q = (g.t / 4 + i / 6) % 1;
                    g.grp({ scale: q * 700, op: 100 * (1 - q) }, function () { g.stroke(grEllipse(300), true, g.W * 0.5); });
                }
            });
        },
        "vignette": function (g, W, H) {
            var c = g.ctx, gr = c.createRadialGradient(0, 0, 0, 0, 0, Math.sqrt(W * W + H * H) / 2);
            gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(0.45, "rgba(0,0,0,0.05)"); gr.addColorStop(1, "rgba(0,0,0,0.95)");
            c.save(); c.globalAlpha *= g.In(0.5) * g.Out(0.5); c.fillStyle = gr; c.fillRect(-W / 2, -H / 2, W, H); c.restore();
        },
        "grain": function (g, W, H) {
            var c = g.ctx, r = grRng(Math.floor(g.t * 24) + 1), i, a = 0.12 * g.In(0.3) * g.Out(0.3) / 0.12, s = W / 160;
            c.save();
            for (i = 0; i < 700; i++) {
                c.fillStyle = r() < 0.5 ? "rgba(255,255,255," + (0.35 * a) + ")" : "rgba(0,0,0," + (0.45 * a) + ")";
                c.fillRect(-W / 2 + r() * W, -H / 2 + r() * H, s, s);
            }
            c.restore();
        },
        "flicker": function (g, W, H) {
            var c = g.ctx, r = g.rnd(1, false), v = r() < 0.3 ? r(10, 35) : r(0, 6);
            c.save(); c.globalCompositeOperation = "lighter"; c.globalAlpha *= v / 100 * g.In(0.2) * g.Out(0.2);
            c.fillStyle = "#fff"; c.fillRect(-W / 2, -H / 2, W, H); c.restore();
        },
        "letterbox": function (g, W, H) {
            var k = (1 - g.In(0.6) * g.Out(0.6)) * H * 0.13;
            g.fill(grRectPts(W + 20, H * 0.12, 0, [0, -H / 2 + H * 0.06 - k]), "#000");
            g.fill(grRectPts(W + 20, H * 0.12, 0, [0, H / 2 - H * 0.06 + k]), "#000");
        },
        "frame": function (g, W, H) {
            g.stroke(grRectPts(W * 0.9, H * 0.86, 12), true, g.W * 0.6, null, 0, 100 * g.In(0.8) * g.Out(0.5));
        },
        "scanlines": function (g, W, H) {
            var i, y0 = (g.t * 12) % 6, step = 18;   // в мини-экране каждая третья строка, иначе их не видно
            g.grp({ op: 35 * g.In(0.3) * g.Out(0.3) * 2.2 }, function () {
                for (i = 0; i * step < H + 20; i++) { g.stroke([[-W, -H / 2 - 8 + y0 + i * step], [W, -H / 2 - 8 + y0 + i * step]], false, 6, "#000"); }
            });
        },
        "lower-third": function (g, W, H) {
            g.grp({ scale: [100, 100 * g.B(g.t / 0.4) * g.Out(0.3)] }, function () { g.fill(grRectPts(12, 110, 0, [0, 0])); });
            g.grp({ scale: [100 * g.E(g.t / 0.5) * g.Out(0.4), 100] }, function () { g.fill(grRectPts(640, 110, 6, [320, 0]), "rgba(20,20,26,0.9)"); });
            g.text(GR_TEXT_DEFAULT["lower-third"], 50, -12, Math.round(H / 22), "left", grTextAlpha(g));
        },
        "callout": function (g, W, H) {
            g.stroke([[0, 0], [120, -120], [420, -120]], false, g.W * 0.5, null, 100 * (1 - g.Out(0.4)), 100 * g.E((g.t - 0.15) / 0.5));
            g.grp({ scale: 100 * g.B(g.t / 0.3) * g.Out(0.3) }, function () { g.fill(grEllipse(24)); });
            g.text(GR_TEXT_DEFAULT.callout, 440, -150, Math.round(H / 22), "left", grTextAlpha(g));
        },
        "label": function (g, W, H) {
            g.grp({ scale: 100 * g.B(g.t / 0.4) * g.Out(0.3) }, function () { g.fill(grRectPts(360, 90, 45)); });
            g.text(GR_TEXT_DEFAULT.label, 0, H / 60, Math.round(H / 22), "center", grTextAlpha(g) * g.B(g.t / 0.4), acState.color.toLowerCase() === "#ffffff" ? "#111" : "#fff");
        },
        "progress": function (g) {
            g.grp({ op: 100 * g.In(0.3) * g.Out(0.3) }, function () {
                g.stroke([[-282, 0], [282, 0]], false, 22, null, 0, 100 * g.E(g.P));
                g.stroke(grRectPts(600, 36, 18), true, g.W * 0.4);
            });
        },
        "counter": function (g, W, H) {
            g.text(Math.round(100 * g.E(g.P / 0.9)) + "%", 0, H / 22, Math.round(H / 8), "center", g.In(0.2) * g.Out(0.2), g.K());
        },
        "timer": function (g, W, H) {
            var s = Math.max(0, Math.ceil(g.L - g.t)), m = Math.floor(s / 60), r = s % 60;
            g.text((m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r, 0, H / 22, Math.round(H / 8), "center", g.In(0.2) * g.Out(0.2), g.K());
        }
    };

    // Под оверлеями — условная картинка: иначе чёрные полосы и виньетку на чёрном экране не видно.
    function grBackdrop(ctx, W, H) {
        var gr = ctx.createLinearGradient(-W / 2, -H / 2, W / 2, H / 2);
        gr.addColorStop(0, "#3b4a6b"); gr.addColorStop(0.55, "#7a5c8f"); gr.addColorStop(1, "#d39b6a");
        ctx.fillStyle = gr; ctx.fillRect(-W / 2, -H / 2, W, H);
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.beginPath(); ctx.arc(W * 0.18, -H * 0.12, H * 0.22, 0, Math.PI * 2); ctx.fill();
    }

    // Один кадр графики id в момент t (секунды от начала слоя) на холст canvas.
    function grDrawFrame(canvas, id, t) {
        var ctx = canvas.getContext && canvas.getContext("2d");
        var info = GR_BY_ID[id], folder = info ? info.folder : "shapes", L = GR_DUR[folder] || 1.2;
        var full = folder === "bg" || folder === "overlay", Wc = canvas.width, Hc = canvas.height, view, k, g;
        var CW = 1920, CH = 1080;
        if (!ctx || !GR_DRAW[id]) { return; }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, Wc, Hc);
        view = GR_VIEW[id] || [760, 0, 0];
        // Фоны и оверлеи — на весь кадр (композиция заполняет мини-экран), остальное — крупно, как в Animation Composer.
        k = full ? Math.max(Wc / CW, Hc / CH) : Wc / view[0];
        if (full) { view = [CW, 0, 0]; }
        ctx.translate(Wc / 2 - view[1] * k, Hc / 2 - view[2] * k);
        ctx.scale(k, k);
        if (folder === "overlay") { grBackdrop(ctx, CW, CH); }
        g = grPainter(ctx, Math.max(0, Math.min(t, L)), L, acState.color);
        if (t > L) { return; }
        GR_DRAW[id](g, CW, CH);
    }

    // ---- Все превью играют сами и по кругу, пока карточка видна на экране (как в Animation Composer).
    // Невидимые карточки стоят: их не видно, а After Effects не тратит на них время.
    var grLive = [];
    var grRaf = 0;

    function grLoop() {
        var now = Date.now();
        grRaf = 0;
        grLive = grLive.filter(function (card) { return card.isConnected !== false && document.documentElement.contains(card); });
        grLive.forEach(function (card) {
            var info = GR_BY_ID[card.grId], L = GR_DUR[info ? info.folder : "shapes"] || 1.2, period = L + 0.6;
            grFit(card);
            grDrawFrame(card.grCanvas, card.grId, ((now - card.grStart) / 1000) % period);
        });
        if (grLive.length) { grRaf = window.requestAnimationFrame(grLoop); }
    }

    function grFit(card) {
        var th = card.querySelector(".ac-thumb"), dpr = window.devicePixelRatio || 1, w, h;
        if (!th || !card.grCanvas) { return; }
        w = Math.max(1, Math.round(th.clientWidth * dpr)); h = Math.max(1, Math.round(th.clientHeight * dpr));
        if (card.grCanvas.width !== w || card.grCanvas.height !== h) { card.grCanvas.width = w; card.grCanvas.height = h; }
    }

    function grPreview(card, p) {
        if (!card.grCanvas || !card.grCanvas.getContext) { return; }
        grFit(card);
        card.grId = p.id;
        if (grLive.indexOf(card) < 0) { card.grStart = Date.now(); grLive.push(card); }
        if (!grRaf) { grRaf = window.requestAnimationFrame(grLoop); }
    }

    function grStop(card) {
        var at = grLive.indexOf(card), info;
        if (at >= 0) { grLive.splice(at, 1); }
        if (card.grCanvas) {
            grFit(card);
            info = GR_BY_ID[card.grId];
            grDrawFrame(card.grCanvas, card.grId, (GR_DUR[info ? info.folder : "shapes"] || 1.2) * 0.45);
        }
    }

    var acSeen = typeof window.IntersectionObserver === "function" ? new window.IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
            var card = e.target;
            if (!card.acPlay) { return; }
            if (e.isIntersecting) { card.acPlay(); } else { card.acStop(); }
        });
    }, { threshold: 0.05 }) : null;

    // Карточке с превью — запуск и остановка; играет, пока видна.
    function acAutoplay(card, play, stop) {
        card.acPlay = play;
        card.acStop = stop;
        if (acSeen) { acSeen.observe(card); } else { play(); }
    }

    function stopTrPreview(card) {
        if (card.trAnims) { card.trAnims.forEach(function (a) { a.cancel(); }); card.trAnims = null; }
    }

    // ---- какие «Движения» уже стоят на выделенном слое: значок IN / OUT на карточке.
    // Панель спрашивает After Effects раз в полторы секунды, пока открыт раздел «Движения».
    var sfState = [];
    var sfPollTimer = null;

    function sfSetState(list) {
        var next = Array.isArray(list) ? list.slice(0).sort() : [];
        if (next.join("|") === sfState.join("|")) { return; }
        sfState = next;
        markSfCards();
    }

    function markSfCards() {
        Array.prototype.forEach.call(ui.acGrid.querySelectorAll(".ac-card[data-motion]"), function (card) {
            var m = card.getAttribute("data-motion"), c = card.getAttribute("data-curve");
            var on = ["in", "out"].filter(function (d) { return sfState.indexOf(m + ":" + d + ":" + c) >= 0; });
            var badge = card.querySelector(".ac-badge");
            card.classList.toggle("applied", on.length > 0);
            badge.hidden = !on.length;
            badge.textContent = on.map(function (d) { return d.toUpperCase(); }).join(" + ");
            badge.title = on.length ? "Стоит на выделенном слое. Щёлкните ещё раз, чтобы снять." : "";
        });
    }

    async function pollSfState() {
        var res;
        if (busy || ui.viewTools.hidden || (acState.sec !== "anim" && acState.sec !== "text") || document.hidden) { return; }
        try {
            res = await host("sfState", []);
            sfSetState(res.state);
        } catch (e) {}
    }

    // Превью карточки: та же форма движения и та же кривая, что в выражении на слое.
    function sfCurve(p, c) {
        var s, q, n, d;
        p = Math.min(1, Math.max(0, p));
        if (c === "linear") { return p; }
        if (c === "over") { s = 1.70158; q = p - 1; return 1 + (s + 1) * q * q * q + s * q * q; }
        if (c === "bounce") {
            n = 7.5625; d = 2.75;
            if (p < 1 / d) { return n * p * p; }
            if (p < 2 / d) { p -= 1.5 / d; return n * p * p + 0.75; }
            if (p < 2.5 / d) { p -= 2.25 / d; return n * p * p + 0.9375; }
            p -= 2.625 / d; return n * p * p + 0.984375;
        }
        if (c === "elastic") { if (p <= 0 || p >= 1) { return p; } return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * 2 * Math.PI / 3) + 1; }
        return 1 - Math.pow(1 - p, 3);
    }

    function sfFrame(m, k, ks, room) {
        var dist = room * (m.far ? 0.75 : 0.3);
        var sx = 1, sy = 1, f, op = 1;
        if (m.sc !== undefined) { f = 1 + k * (m.sc / 100 - 1); sx *= f; sy *= f; }
        if (m.scx !== undefined) { sx *= 1 + k * (m.scx / 100 - 1); sy *= 1 + k * (m.scy / 100 - 1); }
        if (m.op !== undefined) { op = 1 - ks * (1 - m.op / 100); }
        return {
            transform: "translate(" + ((m.dx || 0) * dist * k).toFixed(2) + "px," + ((m.dy || 0) * dist * k).toFixed(2) + "px) rotate(" +
                ((m.rot || 0) * k).toFixed(2) + "deg) scale(" + Math.max(0, sx).toFixed(3) + "," + Math.max(0, sy).toFixed(3) + ")",
            opacity: Math.max(0, Math.min(1, op)),
            filter: "blur(" + ((m.blur || 0) * ks * room / 600).toFixed(2) + "px)"
        };
    }

    function sfPreview(obj, p) {
        var m = p.shape, c = p.curve, soft = c === "linear" ? "linear" : "ease";
        var room = obj.parentNode.clientHeight || 100, n = 30, frames = [], i, t, fr;
        var inMs = 750, hold = 650, outMs = 750, rest = 450, total = inMs + hold + outMs + rest;
        if (!obj.animate) { return; }
        for (i = 0; i <= n; i++) {
            t = i / n;
            fr = sfFrame(m, 1 - sfCurve(t, c), 1 - sfCurve(t, soft), room); fr.offset = t * inMs / total; frames.push(fr);
        }
        for (i = 0; i <= n; i++) {
            t = i / n;
            fr = sfFrame(m, 1 - sfCurve(1 - t, c), 1 - sfCurve(1 - t, soft), room); fr.offset = (inMs + hold + t * outMs) / total; frames.push(fr);
        }
        fr = sfFrame(m, 1, 1, room); fr.offset = 1; frames.push(fr);
        stopSfPreview(obj);
        obj.sfAnim = obj.animate(frames, { duration: total, iterations: Infinity });
    }

    function stopSfPreview(obj) { if (obj.sfAnim) { obj.sfAnim.cancel(); obj.sfAnim = null; } }

    // Превью текста: каждая буква (слово, строка) — отдельный кусок, который идёт по той же формуле и с той же
    // очерёдностью, что и селектор на слое.
    function txSpans(obj, unit) {
        var parts = unit === "l" ? ["Ваш", "текст"] : (unit === "w" ? ["Ваш", " ", "текст"] : "Ваш текст".split(""));
        obj.innerHTML = "";
        parts.forEach(function (t) {
            var sp = document.createElement("span");
            sp.className = t === " " ? "txs txs-gap" : "txs";
            sp.textContent = t === " " ? "\u00a0" : t;
            obj.appendChild(sp);
            if (unit === "l" && t === "Ваш") { obj.appendChild(document.createElement("br")); }
        });
    }

    function txFrame(m, k, ks, i, n) {
        var sc = m.sc !== undefined ? 1 + k * (m.sc / 100 - 1) : 1;
        return {
            transform: "translate(" + (((m.x || 0) * 0.9 + (m.track ? (i - (n - 1) / 2) * 0.35 : 0)) * k).toFixed(3) + "em," + ((m.y || 0) * 0.9 * k).toFixed(3) +
                "em) rotate(" + ((m.rot || 0) * k).toFixed(1) + "deg) skewX(" + ((m.skew || 0) * k).toFixed(1) + "deg) scale(" + Math.max(0, sc).toFixed(3) + ")",
            opacity: Math.max(0, Math.min(1, 1 - ks)),
            filter: "blur(" + ((m.blur || 0) * 0.45 * ks).toFixed(3) + "em)"
        };
    }

    // В покое — кадр посередине появления: видно, как идут буквы, слова или строки.
    function txStill(obj, p) {
        var spans = Array.prototype.filter.call(obj.querySelectorAll(".txs"), function (x) { return !x.classList.contains("txs-gap"); });
        var n = spans.length, m = p.shape, c = p.curve, soft = c === "linear" ? "linear" : "ease";
        var stag = m.type ? 0.97 : (p.unit === "c" ? 0.6 : p.unit === "w" ? 0.5 : 0.4);
        spans.forEach(function (sp, i) {
            var st = (n > 1 ? i / (n - 1) : 0) * stag, lp = (0.55 - st) / Math.max(1 - stag, 0.02), fr = txFrame(m, 1 - sfCurve(lp, c), 1 - sfCurve(lp, soft), i, n);
            sp.style.transform = fr.transform;
            sp.style.opacity = String(Math.max(0.12, fr.opacity));
            sp.style.filter = fr.filter;
        });
    }

    function txPreview(card, p) {
        var spans = Array.prototype.filter.call(card.querySelectorAll(".txs"), function (x) { return !x.classList.contains("txs-gap"); });
        var n = spans.length, m = p.shape, c = p.curve, soft = c === "linear" ? "linear" : "ease";
        var stag = m.type ? 0.97 : (p.unit === "c" ? 0.6 : p.unit === "w" ? 0.5 : 0.4);
        var inMs = 1100, hold = 700, outMs = 1100, rest = 400, total = inMs + hold + outMs + rest, steps = 24;
        txStop(card);
        card.txAnims = spans.map(function (sp, i) {
            var frames = [], j, t, st = (n > 1 ? i / (n - 1) : 0) * stag, w = Math.max(1 - stag, 0.02), lp, fr;
            for (j = 0; j <= steps; j++) {
                t = j / steps; lp = (t - st) / w;
                fr = txFrame(m, 1 - sfCurve(lp, c), 1 - sfCurve(lp, soft), i, n); fr.offset = t * inMs / total; frames.push(fr);
            }
            for (j = 0; j <= steps; j++) {
                t = j / steps; lp = (t - st) / w;
                fr = txFrame(m, 1 - sfCurve(1 - lp, c), 1 - sfCurve(1 - lp, soft), i, n); fr.offset = (inMs + hold + t * outMs) / total; frames.push(fr);
            }
            fr = txFrame(m, 1, 1, i, n); fr.offset = 1; frames.push(fr);
            return sp.animate(frames, { duration: total, iterations: Infinity });
        });
    }

    function txStop(card) { if (card.txAnims) { card.txAnims.forEach(function (a) { a.cancel(); }); card.txAnims = null; } }

    function sfLabels(p) {
        var out = { title: p.title, curve: SF_CURVE_NAMES[p.curve], fade: "прозрачность", text: "Ваш текст" }, k;
        for (k in SF_PARAM_LABELS) { if (SF_PARAM_LABELS.hasOwnProperty(k)) { out[k] = SF_PARAM_LABELS[k]; } }
        return out;
    }

    function acHintText(sec) {
        if (sec === "graphic") {
            return "Щелчок по карточке добавляет графику новым слоем у указателя времени — поверх выделенного слоя или в центре кадра. " +
                "Длительность — длина слоя; цвет, размер и толщина — в Effect Controls.";
        }
        if (sec === "sfx") {
            return "▶ — послушать с выбранной высотой тона. Щелчок по карточке кладёт звук в композицию у указателя времени. " +
                "Высота тона — как в сэмплере: выше — звук короче, ниже — длиннее.";
        }
        if (sec === "text") {
            return "Выделите текстовый слой и щёлкните по карточке (нет слоя — панель создаст новый); щелчок по отмеченной снимает пресет. " +
                "Длительность — длина маркера IN/OUT, значения — в аниматоре текста, очерёдность букв — в «✎ Изменить».";
        }
        if (sec === "trans") {
            return "Поставьте указатель времени на склейку и щёлкните по карточке: сверху появится слой перехода — половина до склейки, " +
                "половина после. Длительность — длина этого слоя, «Сила» — в Effect Controls. Цвет — для шторок и круга.";
        }
        if (sec === "anim") {
            return "Выделите слои и щёлкните по карточке; щелчок по отмеченной снимает пресет. Ключи не запекаются: длительность — " +
                "длина маркера IN/OUT на слое, настройки — в Effect Controls, ваши ключи и выражения остаются.";
        }
        return "Выделите слои и щёлкните по карточке. Наведите курсор, чтобы увидеть движение.";
    }

    function acCard(p, showSection) {
        var card = document.createElement("div");
        var name = document.createElement("span");
        var star = document.createElement("button");
        var fav = acState.fav.indexOf(p.key) >= 0;
        var play, badge;
        card.className = "ac-card";
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("data-key", p.key);
        card.title = p.name + (showSection ? " · " + acSectionLabel(p.sec) : "");
        card.appendChild(acThumb(p));
        name.className = "ac-name";
        name.textContent = p.name;
        card.appendChild(name);
        // Над экраном — булавка и звезда, как на мини-экранах Animation Composer.
        var tools = document.createElement("span");
        var pin = document.createElement("button");
        var pinned = acState.pins.indexOf(p.key) >= 0;
        tools.className = "ac-tools";
        pin.className = "ac-pin" + (pinned ? " on" : "");
        pin.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" fill="currentColor"/></svg>';
        pin.title = pinned ? "Открепить" : "Закрепить наверху";
        pin.setAttribute("aria-label", pin.title);
        pin.setAttribute("aria-pressed", pinned ? "true" : "false");
        pin.addEventListener("click", function (e) {
            var at = acState.pins.indexOf(p.key);
            e.stopPropagation();
            if (at >= 0) { acState.pins.splice(at, 1); } else { acState.pins.push(p.key); }
            storeAcState();
            renderAc();
        });
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
        tools.appendChild(pin);
        tools.appendChild(star);
        card.querySelector(".ac-thumb").appendChild(tools);
        if (pinned) { card.classList.add("pinned"); }
        if (p.sec === "sfx") {
            play = document.createElement("button");
            play.className = "ac-play";
            play.textContent = "▶";
            play.title = "Послушать";
            play.setAttribute("aria-label", "Послушать «" + p.name + "»");
            play.addEventListener("click", function (e) { e.stopPropagation(); acPreviewSound(p); });
            card.appendChild(play);
        }
        if (p.motion) {
            badge = document.createElement("span");
            badge.className = "ac-badge";
            badge.hidden = true;
            card.appendChild(badge);
            card.setAttribute("data-motion", p.motion);
            card.setAttribute("data-curve", p.curve);
            if (p.sec === "text") {
                acAutoplay(card, function () { txPreview(card, p); }, function () { txStop(card); });
            } else {
                acAutoplay(card, function () { sfPreview(card.querySelector(".ac-obj"), p); }, function () { stopSfPreview(card.querySelector(".ac-obj")); });
            }
        }
        if (p.sec === "graphic") {
            card.grCanvas = card.querySelector(".ac-grc");
            card.grId = p.id;
            acAutoplay(card, function () { grPreview(card, p); }, function () { grStop(card); });
        }
        if (p.sec === "trans") {
            acAutoplay(card, function () { trPreview(card, p); }, function () { stopTrPreview(card); });
        }
        card.addEventListener("click", function () { applyAc(p); });
        card.addEventListener("keydown", function (e) {
            if (e.target === card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); applyAc(p); }
        });
        return card;
    }

    // ---- «Изменить»: пресеты Sayframe на выделенном слое — длительность, задержка, сила, плавность,
    // замена на другой пресет того же рода и «Убрать». Меняется сразу, как отпустили ползунок.

    var acEdit = { layer: "", items: null, groups: [], transition: null, sound: null, graphic: null, error: "" };

    function acPresetName(id) {
        var lists = [AC_LEGACY_ANIM, AC_LEGACY_TRANS, AC_LEGACY_TEXT], i, j;
        for (i = 0; i < lists.length; i++) {
            for (j = 0; j < lists[i].length; j++) {
                if (lists[i][j][0] === id) { return lists[i][j][1]; }
            }
        }
        return id;
    }

    function acSameKind(id) {
        var isText = AC_LEGACY_TEXT.some(function (p) { return p[0] === id; });
        var isLegacy = AC_LEGACY_ANIM.some(function (p) { return p[0] === id; });
        return isText ? AC_LEGACY_TEXT : (isLegacy ? AC_LEGACY_ANIM.concat(AC_LEGACY_TRANS) : AC_LEGACY_TRANS);
    }

    async function loadAcEdit() {
        var res;
        acEdit.error = "";
        try {
            res = await host("sfList", []);
            acEdit.groups = res.groups;
            acEdit.transition = res.transition || null;
            acEdit.sound = res.sound || null;
            acEdit.graphic = res.graphic || null;
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
        if (acEdit.transition) { grid.appendChild(trEditBox(acEdit.transition)); }
        if (acEdit.sound) { grid.appendChild(sndEditBox(acEdit.sound)); }
        if (acEdit.graphic) { grid.appendChild(grEditBox(acEdit.graphic)); }
        if (!acEdit.items.length && !acEdit.groups.length && !acEdit.transition && !acEdit.sound && !acEdit.graphic) {
            grid.appendChild(fxNote("На этом слое нет пресетов Sayframe. Поставьте пресет из разделов «Движения», «Переходы» или «Текст» — и его можно будет настроить здесь."));
            return;
        }
        acEdit.groups.forEach(function (g) { grid.appendChild(sfEditGroup(g)); });
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

    // «Движения» на слое: общая длительность и задержка направления (это маркер IN или OUT),
    // у каждого пресета — кривая, его настройки из Effect Controls и «Убрать».
    function sfEditGroup(g) {
        var box = document.createElement("div");
        var head = document.createElement("div");
        var name = document.createElement("b");
        var dirName = g.dir === "in" ? "Появление (маркер IN)" : "Исчезновение (маркер OUT)";
        box.className = "ac-edit-item sf-group";
        box.setAttribute("data-dir", g.dir);
        head.className = "ac-edit-top";
        name.textContent = dirName;
        head.appendChild(name);
        box.appendChild(head);
        box.appendChild(acSlider("Длительность", 0.1, 3, 0.1, Math.round(g.dur * 10) / 10, secText, function (v) {
            sfEditCall("sfTiming", [g.dir, v, null], "Длительность изменена.");
        }));
        box.appendChild(acSlider("Задержка", 0, 2, 0.1, Math.round(g.delay * 10) / 10, secText, function (v) {
            sfEditCall("sfTiming", [g.dir, null, v], "Задержка изменена.");
        }));
        g.presets.forEach(function (p) { box.appendChild(sfEditPreset(g, p)); });
        return box;
    }

    function sfEditPreset(g, p) {
        var info = SF_BY_MOTION[p.motion] || TX_BY_MOTION[p.motion] || { title: p.motion, curves: [p.curve] };
        var box = document.createElement("div");
        var head = document.createElement("div");
        var name = document.createElement("b");
        var remove = document.createElement("button");
        var row = document.createElement("label");
        var span = document.createElement("span");
        var sel = document.createElement("select");
        box.className = "sf-preset";
        box.setAttribute("data-motion", p.motion);
        head.className = "ac-edit-top";
        name.textContent = info.title;
        remove.className = "ghost warn";
        remove.textContent = "Убрать";
        remove.addEventListener("click", function () { sfEditCall("sfRemove", [g.dir, p.motion], "«" + info.title + "» убран со слоя."); });
        head.appendChild(name);
        head.appendChild(remove);
        box.appendChild(head);
        row.className = "ac-edit-row";
        span.textContent = "Кривая";
        sel.className = "sf-curve";
        info.curves.forEach(function (c) {
            var o = document.createElement("option");
            o.value = c;
            o.textContent = SF_CURVE_NAMES[c] || c;
            sel.appendChild(o);
        });
        sel.value = p.curve;
        sel.addEventListener("change", function () {
            sfEditCall("sfCurve", [g.dir, p.motion, sel.value, SF_CURVE_NAMES[sel.value] || sel.value], "Кривая «" + info.title + "» изменена.");
        });
        row.appendChild(span);
        row.appendChild(sel);
        box.appendChild(row);
        p.params.forEach(function (prm) {
            var r = SF_PARAM_RANGE[prm.key] || [0, 100, 1];
            var label = SF_PARAM_LABELS[prm.key] || TX_PARAM_LABELS[prm.key] || prm.key;
            var v = Math.round(Number(prm.value) * 100) / 100;
            box.appendChild(acSlider(label, Math.min(r[0], v), Math.max(r[1], v), r[2], v, function (x) {
                return String(x).replace(".", ",") + (SF_PARAM_UNIT[prm.key] || "");
            }, function (x) {
                if (prm.key === "stagger") {
                    sfEditCall("sfStagger", [g.dir, p.motion, x / 100], "«" + info.title + "»: очерёдность изменена.");
                    return;
                }
                sfEditCall("sfParam", [prm.name, x], "«" + info.title + "»: " + label.toLowerCase() + " изменена.");
            }));
        });
        return box;
    }

    // Выделена графика из библиотеки: цвет, размер (у счётчика — значение), толщина, длительность и «Убрать».
    function grEditBox(g) {
        var box = document.createElement("div");
        var head = document.createElement("div");
        var name = document.createElement("b");
        var remove = document.createElement("button");
        var row = document.createElement("label");
        var span = document.createElement("span");
        var color = document.createElement("input");
        var title = GR_BY_ID[g.id] ? GR_BY_ID[g.id].title : g.id;
        box.className = "ac-edit-item gr-edit";
        head.className = "ac-edit-top";
        name.textContent = "Графика «" + title + "»";
        remove.className = "ghost warn";
        remove.textContent = "Убрать";
        remove.addEventListener("click", async function () {
            if (busy) { return; }
            setBusy(true);
            try {
                await host("grRemove", []);
                setBusy(false);
                setStatus("Графика «" + title + "» убрана. Отменить — Cmd/Ctrl+Z.", "done");
                acEdit.graphic = null;
                loadAcEdit();
            } catch (e) {
                setBusy(false);
                toolFailed(e);
            }
        });
        head.appendChild(name);
        head.appendChild(remove);
        box.appendChild(head);
        row.className = "ac-edit-row";
        span.textContent = "Цвет";
        color.type = "color";
        color.className = "gr-color";
        color.value = g.color;
        color.setAttribute("aria-label", "Цвет");
        color.addEventListener("change", function () { sfEditCall("grSet", ["color", hexToRgb01(color.value)], "Цвет изменён."); });
        row.appendChild(span);
        row.appendChild(color);
        box.appendChild(row);
        box.appendChild(acSlider("Длительность", 0.2, 10, 0.1, Math.round(g.dur * 10) / 10, secText, function (v) { sfEditCall("grSet", ["dur", v], "Длительность изменена."); }));
        box.appendChild(acSlider(g.id === "counter" ? "Значение" : "Размер", 0, 400, 5, Math.round(g.size), function (v) { return v + (g.id === "counter" ? "" : "%"); },
            function (v) { sfEditCall("grSet", ["size", v], (g.id === "counter" ? "Значение" : "Размер") + " изменён."); }));
        if (g.thick !== undefined) {
            box.appendChild(acSlider("Толщина", 0, 60, 1, Math.round(g.thick), function (v) { return v + " px"; }, function (v) { sfEditCall("grSet", ["thick", v], "Толщина изменена."); }));
        }
        return box;
    }

    // Выделен звук из библиотеки: высота тона (полутоны; слой ускоряется или замедляется) и громкость.
    function sndEditBox(snd) {
        var box = document.createElement("div");
        var head = document.createElement("div");
        var name = document.createElement("b");
        var remove = document.createElement("button");
        box.className = "ac-edit-item snd-edit";
        head.className = "ac-edit-top";
        name.textContent = "Звук «" + String(snd.name).replace(/^♪\s*/, "") + "»";
        remove.className = "ghost warn";
        remove.textContent = "Убрать";
        remove.addEventListener("click", async function () {
            if (busy) { return; }
            setBusy(true);
            try {
                await host("sndRemove", []);
                setBusy(false);
                setStatus("Звук убран. Отменить — Cmd/Ctrl+Z.", "done");
                acEdit.sound = null;
                loadAcEdit();
            } catch (e) {
                setBusy(false);
                toolFailed(e);
            }
        });
        head.appendChild(name);
        head.appendChild(remove);
        box.appendChild(head);
        box.appendChild(acSlider("Высота тона", -12, 12, 1, Math.round(snd.pitch), pitchText, function (v) {
            sfEditCall("sndSet", [v, null], "Высота тона изменена.");
        }));
        box.appendChild(acSlider("Громкость", -24, 6, 1, Math.round(snd.volume), volText, function (v) {
            sfEditCall("sndSet", [null, v], "Громкость изменена.");
        }));
        return box;
    }

    // Выделен слой перехода: его длительность (слой растягивается вокруг склейки), сила и «Убрать».
    function trEditBox(t) {
        var box = document.createElement("div");
        var head = document.createElement("div");
        var name = document.createElement("b");
        var remove = document.createElement("button");
        var title = TR_BY_ID[t.id] ? TR_BY_ID[t.id].title : t.id;
        box.className = "ac-edit-item tr-edit";
        head.className = "ac-edit-top";
        name.textContent = "Переход «" + title + "»";
        remove.className = "ghost warn";
        remove.textContent = "Убрать";
        remove.addEventListener("click", async function () {
            if (busy) { return; }
            setBusy(true);
            try {
                await host("trRemove", []);
                setBusy(false);
                setStatus("Переход «" + title + "» убран. Отменить — Cmd/Ctrl+Z.", "done");
                acEdit.transition = null;
                loadAcEdit();
            } catch (e) {
                setBusy(false);
                toolFailed(e);
            }
        });
        head.appendChild(name);
        head.appendChild(remove);
        box.appendChild(head);
        box.appendChild(acSlider("Длительность", 0.2, 4, 0.1, Math.round(t.dur * 10) / 10, secText, function (v) {
            sfEditCall("trDuration", [v], "Длительность перехода изменена.");
        }));
        box.appendChild(acSlider("Сила", 0, 200, 5, Math.round(t.strength), function (v) { return v + "%"; }, function (v) {
            sfEditCall("sfParam", [t.strengthName, v], "Сила перехода изменена.");
        }));
        return box;
    }

    async function sfEditCall(fn, args, done) {
        var res;
        if (busy) { return; }
        setBusy(true);
        setStatus("Меняю пресет…", "busy");
        try {
            res = await host(fn, args);
            acEdit.layer = res.layer;
            acEdit.groups = res.groups;
            if (res.transition !== undefined) { acEdit.transition = res.transition; }
            if (res.sound !== undefined) { acEdit.sound = res.sound; }
            if (res.graphic !== undefined) { acEdit.graphic = res.graphic; }
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

    // Превью звучит так же, как слой в After Effects: быстрее — выше, медленнее — ниже (без сохранения высоты).
    function acPreviewSound(p) {
        try {
            if (acAudio) { acAudio.pause(); }
            acAudio = new Audio("file://" + encodeURI(acSoundPath(p.id)));
            acAudio.preservesPitch = false;
            acAudio.webkitPreservesPitch = false;
            acAudio.playbackRate = Math.pow(2, acState.pitch / 12);
            acAudio.volume = Math.min(1, Math.pow(10, acState.vol / 20));
            acAudio.play();
        } catch (e) {}
    }

    function pitchText(v) { v = Math.round(v * 10) / 10; return (v > 0 ? "+" : "") + String(v).replace(".", ",") + " пт"; }
    function volText(v) { v = Math.round(v * 10) / 10; return (v > 0 ? "+" : "") + String(v).replace(".", ",") + " дБ"; }

    // Ряд «Высота тона / Громкость» для звуков: значения запоминаются и идут в слой при вставке.
    function buildSndRow() {
        var row = document.createElement("div");
        row.id = "acSndRow";
        row.className = "ac-row ac-snd";
        row.innerHTML = '<label class="ac-slider">Высота тона <input id="acPitch" class="range" type="range" min="-12" max="12" step="1" aria-label="Высота тона"><output id="acPitchVal"></output></label>' +
            '<label class="ac-slider">Громкость <input id="acVol" class="range" type="range" min="-24" max="6" step="1" aria-label="Громкость"><output id="acVolVal"></output></label>';
        ui.acFolders.parentNode.insertBefore(row, ui.acFolders);
        ui.acSndRow = row;
        ui.acPitch = row.querySelector("#acPitch"); ui.acPitchVal = row.querySelector("#acPitchVal");
        ui.acVol = row.querySelector("#acVol"); ui.acVolVal = row.querySelector("#acVolVal");
        ui.acPitch.addEventListener("input", function () { acState.pitch = Number(ui.acPitch.value); ui.acPitchVal.textContent = pitchText(acState.pitch); storeAcState(); });
        ui.acVol.addEventListener("input", function () { acState.vol = Number(ui.acVol.value); ui.acVolVal.textContent = volText(acState.vol); storeAcState(); });
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
            if (p.sec === "anim") {
                res = await host("sfApply", [p.motion, p.curve, acState.mode, acState.dur, sfLabels(p)]);
                setBusy(false);
                sfSetState(res.state);
                sfReport(p, res);
            } else if (p.sec === "trans") {
                res = await host("trApply", [p.id, acState.tdur, hexToRgb01(acState.color),
                    { title: p.name, prefix: "Переход: ", marker: "Склейка: ", strength: "Сила" }]);
                setBusy(false);
                setStatus("«" + p.name + "» — на склейке " + secText(res.cut).replace(" с", " с от начала") + ", " + secText(res.dur) + ". Сверху новый слой «" + res.name +
                    "»: растяните его, чтобы изменить длительность; «Сила» — в Effect Controls. Отменить — Cmd/Ctrl+Z.", "done");
            } else if (p.sec === "text") {
                res = await host("sfApply", [p.motion, p.curve, acState.mode, acState.dur, sfLabels(p)]);
                setBusy(false);
                sfSetState(res.state);
                sfReport(p, res, (res.created ? " Текстового слоя не было — создан новый «Ваш текст»." : "") +
                    (res.notText && !res.created ? " Не текстовые слои пропущены: " + res.notText + "." : ""));
            } else if (p.sec === "graphic") {
                res = await host("grApply", [p.id, GR_DUR[p.folder] || 2, hexToRgb01(acState.color), {
                    title: p.name, marker: "Графика: ", color: "Цвет", size: "Размер", value: "Значение", thick: "Толщина",
                    text: GR_TEXT_DEFAULT[p.id] || "", textPrefix: "Текст: " }]);
                setBusy(false);
                setStatus("«" + p.name + "» — новый слой «" + res.name + "» у указателя времени, " + secText(res.dur) + "." +
                    (res.text ? " Текст — отдельным слоем «" + res.text + "», он привязан к графике." : "") +
                    " Растяните слой, чтобы изменить длительность; цвет, размер и толщина — в Effect Controls и во «✎ Изменить». Отменить — Cmd/Ctrl+Z.", "done");
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
                res = await host("acSound", [dest, "Sayframe SFX", acState.pitch, acState.vol, "♪ " + p.name]);
                setBusy(false);
                setStatus("Звук «" + p.name + "» добавлен у указателя времени" + (acState.pitch ? ", высота тона " + pitchText(acState.pitch) : "") + "." +
                    (res.reused ? "" : " Файл лежит в папке «Sayframe SFX» рядом с проектом.") + " Высоту тона и громкость можно поменять во «✎ Изменить».", "done");
            }
        } catch (e) {
            toolFailed(e);
        }
    }

    function sfReport(p, res, extra) {
        var skipped = res.skipped && res.skipped.length ?
            " Свойства со своими выражениями не тронуты: " + res.skipped.filter(function (x, i, a) { return a.indexOf(x) === i; }).join(", ") + "." : "";
        if (res.removed && !res.applied) {
            setStatus("«" + p.name + "» снят: " + plural(res.removed, "слой", "слоя", "слоёв") + ". Отменить — Cmd/Ctrl+Z.", "done");
            return;
        }
        setStatus("«" + p.name + "» — " + AC_MODE_TEXT[acState.mode] + ", " + plural(res.applied, "слой", "слоя", "слоёв") + "." +
            " Длительность — длина маркера " + (acState.mode === "out" ? "OUT" : acState.mode === "in" ? "IN" : "IN/OUT") +
            (p.sec === "text" ? ", настройки — в аниматоре текста на слое." : ", настройки — в Effect Controls.") + (extra || "") + skipped + " Отменить — Cmd/Ctrl+Z.", skipped ? "error" : "done");
    }

    function acReport(p, res, extra) {
        var what = plural(res.applied, "слой", "слоя", "слоёв");
        if (!res.applied) {
            setStatus("«" + p.name + "» не удалось добавить ни на один выделенный слой" + (res.skipped ? " (камеры и свет пропущены)" : "") + "." +
                (res.error ? " After Effects ответил: " + res.error : ""), res.failed ? "error" : "");
            return;
        }
        setStatus("«" + p.name + "» — " + AC_MODE_TEXT[acState.mode] + ", " + what + "." +
            (res.skipped ? " Пропущено: " + plural(res.skipped, "слой", "слоя", "слоёв") + "." : "") +
            (res.failed ? " Не получилось: " + plural(res.failed, "слой", "слоя", "слоёв") + "." + (res.error ? " After Effects ответил: " + res.error : "") : "") +
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
        ui.acFolders = document.createElement("div");
        ui.acFolders.id = "acFolders";
        ui.acFolders.className = "ac-folders";
        ui.acFolders.hidden = true;
        ui.acGrid.parentNode.insertBefore(ui.acFolders, ui.acGrid);
        buildSndRow();
        if (!sfPollTimer) { sfPollTimer = setInterval(pollSfState, 1500); }
        ui.acSearch.addEventListener("input", renderAc);
        ui.acSearch.addEventListener("keydown", function (e) { if (e.key === "Escape") { ui.acSearch.value = ""; renderAc(); } });
        ui.acFavOnly.addEventListener("click", function () { acState.favOnly = !acState.favOnly; storeAcState(); renderAc(); });
        Array.prototype.forEach.call(ui.acMode.querySelectorAll("button"), function (b) {
            b.addEventListener("click", function () { acState.mode = b.getAttribute("data-value"); storeAcState(); pressGroup(ui.acMode, acState.mode); });
        });
        ui.acDur.addEventListener("input", function () {
            acState[durKey()] = Math.round(Number(ui.acDur.value) * 10) / 10;
            ui.acDurVal.textContent = acState[durKey()].toFixed(1).replace(".", ",") + " с";
            storeAcState();
        });
        ui.acColor.addEventListener("input", function () {
            acState.color = ui.acColor.value;
            storeAcState();
            Array.prototype.forEach.call(ui.acGrid.querySelectorAll(".ac-gr"), function (o) { o.style.color = acState.color; });
        });
        ui.acSize.addEventListener("input", function () {
            acState.size = Number(ui.acSize.value);
            ui.acGrid.style.setProperty("--ac-size", acState.size + "px");
            acFitText();
            storeAcState();
        });
        // text previews follow the real width of a mini screen, like the small titles in Animation Composer
        function acFitText() {
            var t = ui.acGrid.querySelector(".ac-thumb");
            if (t && t.clientWidth) { ui.acGrid.style.setProperty("--ac-w", t.clientWidth + "px"); }
        }
        if (typeof window.ResizeObserver === "function") { new window.ResizeObserver(acFitText).observe(ui.acGrid); }
        window.addEventListener("resize", acFitText);
        renderAc();
        acFitText();
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

    // Поиск у курсора: отдельное маленькое окно After Effects (host fxPopup). Выбранное оно добавляет само
    // и присылает панели событие FX_EVENT — панель запоминает недавнее и пишет, что сделано.
    var FX_EVENT = "com.sayframe.fx";

    async function fxPopupAt(pos) {
        if (busy || !ui.modal.hidden) { return; }
        try {
            await host("fxPopup", [pos.x, pos.y, fxState.fav, fxState.recent]);
        } catch (e) {
            // Окно не открылось — поиск в панели, как раньше.
            try { window.focus(); } catch (e2) {}
            openFxConsole();
        }
    }

    function onFxPopupApplied(ev) {
        var r, what;
        try { r = JSON.parse(ev && ev.data !== undefined ? String(ev.data) : ""); } catch (e) { return; }
        if (!r || typeof r.id !== "string") { return; }
        what = r.kind === "effect" ? "Эффект" : "Пресет";
        if (r.error) { setStatus(humanError(new Error(r.error)), "error"); return; }
        fxState.recent = [r.id].concat(fxState.recent.filter(function (x) { return x !== r.id; })).slice(0, FX_RECENT_MAX);
        storeFxState();
        if (!r.applied) {
            setStatus(what + " «" + r.name + "» нельзя добавить на выделенные слои: камерам и свету эффекты не ставятся.", "");
        } else {
            setStatus(what + " «" + r.name + "» добавлен на " + fxApplied(r.applied) + "." +
                (r.skipped ? " Пропущено: " + fxApplied(r.skipped) + " (камера или свет)." : "") + " Отменить — Cmd/Ctrl+Z.", "done");
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
    // ---- снимок кадра: камера открывает плашку — «Добавить в проект AE» (включено), «Обзор…» и «Сохранить».
    // Папка и галочка запоминаются. Пока папку не выбирали, снимки ложатся рядом с проектом,
    // а у несохранённого проекта — в «Документы › Sayframe Snapshots».
    var SNAP_KEY = "sayframe.snap.v1";
    var snapState = { folder: "", importIt: true };
    try {
        (function () {
            var v = JSON.parse(window.localStorage.getItem(SNAP_KEY) || "{}") || {};
            if (typeof v.folder === "string") { snapState.folder = v.folder; }
            if (typeof v.importIt === "boolean") { snapState.importIt = v.importIt; }
        })();
    } catch (e) {}
    var snapFolderNow = "";

    function storeSnap() { try { window.localStorage.setItem(SNAP_KEY, JSON.stringify(snapState)); } catch (e) {} }

    function snapDefaultFolder() { return platform.join(platform.homedir(), "Documents", "Sayframe Snapshots"); }

    function showSnapFolder(path, auto) {
        var parts = String(path || "").split(/[\\\/]/).filter(Boolean);
        snapFolderNow = path;
        ui.snapFolder.textContent = "Папка: " + (parts.length > 2 ? "…/" : "/") + parts.slice(-2).join("/") + (auto ? " (рядом с проектом)" : "");
        ui.snapFolder.title = path;
    }

    async function onSnapshot() {
        var res;
        if (busy) { return; }
        closeFxConsole();
        // Плашка уже открыта (например, второй раз нажали сочетание клавиш) — это значит «сохранить».
        if (!ui.snapBar.hidden) { saveSnapshot(); return; }
        ui.snapImport.checked = snapState.importIt;
        ui.snapBar.hidden = false;
        if (snapState.folder) {
            showSnapFolder(snapState.folder, false);
        } else {
            showSnapFolder(snapDefaultFolder(), false);
            try {
                res = await host("snapWhere", [snapDefaultFolder()]);
                if (!snapState.folder && res.folder) { showSnapFolder(res.folder, !!res.project); }
            } catch (e) {}
        }
        try { ui.snapSave.focus(); } catch (e2) {}
    }

    function closeSnapBar() { ui.snapBar.hidden = true; }

    async function onSnapBrowse() {
        var res;
        if (busy) { return; }
        try {
            // Окно выбора открывается в текущей папке; папку по умолчанию создаём, чтобы оно открылось именно в ней.
            if ((snapFolderNow || snapDefaultFolder()) === snapDefaultFolder()) { try { await platform.mkdirp(snapDefaultFolder()); } catch (e1) {} }
            res = await host("snapPickFolder", [snapFolderNow || snapDefaultFolder(), "Папка для снимков кадра"]);
            if (res.folder) {
                snapState.folder = res.folder;
                storeSnap();
                showSnapFolder(res.folder, false);
            }
        } catch (e) {
            setStatus("Не удалось выбрать папку: " + humanError(e), "error");
        }
    }

    async function saveSnapshot() {
        var res, copied, folder = snapFolderNow || snapState.folder || snapDefaultFolder(), where;
        if (busy) { return; }
        snapState.importIt = ui.snapImport.checked;
        storeSnap();
        setBusy(true);
        setStatus("Снимаю кадр…", "busy");
        try {
            if (!(await host("info", [])).fileAccess) { throw new Error(FILE_ACCESS_HINT); }
            await platform.mkdirp(folder);
            res = await host("snapFrame", [folder, dateStamp(), "", snapState.importIt, true]);
            copied = await copyPngToClipboard(res.snap.path);
            setBusy(false);
            closeSnapBar();
            where = platform.basename(platform.dirname(res.snap.path)) + " › " + platform.basename(res.snap.path);
            setStatus("Кадр сохранён: " + where + "." +
                (res.imported ? " Добавлен в проект, папка «Sayframe Snapshots»." : (res.importFailed ? " В проект добавить не получилось." : "")) +
                (copied ? " Он же в буфере обмена — можно сразу вставить." : " В буфер обмена скопировать не получилось."), "done");
        } catch (e) {
            if (e && e.message === "NO_ACTIVE_COMP") { toolFailed(e); return; }
            setBusy(false);
            setStatus("Не удалось снять кадр: " + humanError(e), "error");
        }
    }

    function enableSnapBar() {
        ui.snapClose.addEventListener("click", closeSnapBar);
        ui.snapBrowse.addEventListener("click", onSnapBrowse);
        ui.snapSave.addEventListener("click", saveSnapshot);
        ui.snapImport.addEventListener("change", function () { snapState.importIt = ui.snapImport.checked; storeSnap(); });
        ui.snapBar.addEventListener("keydown", function (e) {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSnapBar(); }
            if (e.key === "Enter" && e.target !== ui.snapBrowse && e.target !== ui.snapClose) { e.preventDefault(); saveSnapshot(); }
        });
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

    // ---- подсказки при наведении: курсор задержался на секунду — окошко с объяснением.
    // У блоков, вкладок и кнопок шапки — подробный текст (data-info="Заголовок|Текст"), у остального — его title.
    // На время показа title убирается, чтобы не всплывала ещё и подсказка браузера, и сразу возвращается.
    var INFO_DELAY_MS = 1000;

    function enableInfoTips() {
        var timer = null, shown = null, x = 0, y = 0;

        function source(node) {
            var card;
            while (node && node !== document.body && node.getAttribute) {
                // Заголовок блока объясняет весь блок.
                if (node.classList && node.classList.contains("tool-head")) {
                    card = node.closest ? node.closest(".tool-card[data-info]") : null;
                    if (card) { return card; }
                }
                if (node.getAttribute("data-info") || node.getAttribute("title")) { return node; }
                node = node.parentNode;
            }
            return null;
        }

        function hide() {
            if (timer) { clearTimeout(timer); timer = null; }
            if (shown) {
                if (shown.sfTitle !== undefined && !shown.getAttribute("title")) { shown.setAttribute("title", shown.sfTitle); }
                shown.sfTitle = undefined;
                shown = null;
            }
            ui.infoTip.hidden = true;
        }

        function show(el) {
            var info = el.getAttribute("data-info") || "", title = el.getAttribute("title") || "", at = info.indexOf("|"), r, w, h, left, top;
            if (!info && !title) { return; }
            ui.infoTipTitle.textContent = info ? (at >= 0 ? info.slice(0, at) : "") : "";
            ui.infoTipText.textContent = info ? (at >= 0 ? info.slice(at + 1) : info) : title;
            ui.infoTipHint.textContent = info && title ? title : "";
            if (title) { el.sfTitle = title; el.removeAttribute("title"); }
            shown = el;
            ui.infoTip.hidden = false;
            r = ui.infoTip.getBoundingClientRect(); w = window.innerWidth; h = window.innerHeight;
            left = Math.min(Math.max(8, x + 14), w - r.width - 8);
            top = y + 18 + r.height > h - 8 ? Math.max(8, y - r.height - 12) : y + 18;
            ui.infoTip.style.left = Math.round(left) + "px";
            ui.infoTip.style.top = Math.round(top) + "px";
        }

        document.addEventListener("mouseover", function (e) {
            var el = settings.infoTips === false ? null : source(e.target);
            if (shown && el === shown) { return; }
            hide();
            if (!el || arranging) { return; }
            timer = setTimeout(function () { timer = null; show(el); }, INFO_DELAY_MS);
        });
        document.addEventListener("mousemove", function (e) { x = e.clientX; y = e.clientY; if (timer) { /* курсор ещё движется: ждём, пока он замрёт */ clearTimeout(timer); timer = setTimeout(function () { var el = source(document.elementFromPoint(x, y)); timer = null; if (el && settings.infoTips !== false && !arranging) { show(el); } }, INFO_DELAY_MS); } });
        document.addEventListener("mouseleave", hide);
        document.addEventListener("mousedown", hide, true);
        document.addEventListener("keydown", hide, true);
        document.addEventListener("wheel", hide, { passive: true, capture: true });
        window.addEventListener("blur", hide);
    }

    // ---- горячие клавиши. Хранятся строкой в настройках: "console=Ctrl+Space;snapshot=;…".

    var HOTKEY_ACTIONS = [
        { id: "console", label: "Поиск эффектов (FX Console)", def: "Ctrl+Space" },
        { id: "snapshot", label: "Снимок кадра", def: "" },
        { id: "organize", label: "Разложить по папкам (Organize)", def: "" },
        { id: "decompose", label: "Разобрать прекомпозицию (Decompose)", def: "" },
        { id: "cache", label: "Очистить кэш (Clear cache)", def: "" },
        { id: "nullp", label: "Null / Parent", def: "" },
        { id: "unused", label: "Удалить лишнее из проекта (Remove unused)", def: "" },
        { id: "cutout", label: "Вырезать фон на фото (Cut out)", def: "" },
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
        else if (id === "decompose") { onDecompose(); }
        else if (id === "cache") { onClearCache(); }
        else if (id === "nullp") { onNullParent(); }
        else if (id === "unused") { onRemoveUnused(); }
        else if (id === "cutout") { onCutout(); }
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
            // Это же нажатие уже пришло от наблюдателя за клавишами.
            if (lastPanelHotkey.src !== "panel" && lastPanelHotkey.id === id && Date.now() - lastPanelHotkey.at < 800) { return; }
            lastPanelHotkey = { id: id, at: Date.now(), src: "panel" };
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
    var lastPanelHotkey = { id: "", at: 0, src: "" };

    var KEYWATCH_BEAT_MS = 3000;
    var keyWatch = null;        // { proc, list, timer, hb } — наблюдатель за клавишами (см. JXA_KEYWATCH)
    var keyWatchState = "";     // что показать в настройках под сочетаниями

    function showKeyWatchState(text) {
        keyWatchState = text;
        ui.keyWatchState.textContent = text;
    }

    function watchHostHotkeys(map) {
        var list = [], k, parts;
        for (k in map) {
            if (!map.hasOwnProperty(k) || !map[k]) { continue; }
            parts = map[k].split("+");
            list.push({ id: k, key: parts[parts.length - 1], ctrl: parts.indexOf("Ctrl") >= 0, alt: parts.indexOf("Alt") >= 0,
                shift: parts.indexOf("Shift") >= 0, cmd: parts.indexOf("Cmd") >= 0 });
        }
        startKeyWatch(list);
        // After Effects тоже смотрит клавиши: на Mac он называет клавишу, и это запас, если системе
        // не понравится наблюдатель. Одно нажатие от обоих выполняется один раз (outsideHotkey).
        host("setHotkeys", [list]).catch(function () {});
    }

    function stopKeyWatch() {
        if (!keyWatch) { return; }
        clearInterval(keyWatch.timer);
        keyWatch.proc.kill();
        platform.remove(keyWatch.hb);
        keyWatch = null;
    }

    async function startKeyWatch(list) {
        var watch = [], tmp, hb, listFile, script, w;
        list.forEach(function (x) {
            var code = keyCodeOf(x.key);
            if (code !== null) { watch.push({ id: x.id, code: code, ctrl: x.ctrl, alt: x.alt, shift: x.shift, cmd: x.cmd }); }
        });
        // Обычная вставка (Cmd+V на Mac, Ctrl+V на Windows): с картинкой в буфере — окно вставки.
        if (settings.pasteAnywhere !== false) {
            watch.push({ id: PASTE_ANYWHERE, code: keyCodeOf("V"), ctrl: !isMac(), alt: false, shift: false, cmd: isMac() });
        }
        if (keyWatch && JSON.stringify(keyWatch.list) === JSON.stringify(watch)) { return; }
        stopKeyWatch();
        if (!watch.length) { showKeyWatchState(""); return; }
        if (!platform.available || typeof platform.spawn !== "function") {
            showKeyWatchState("Помощник за клавишами недоступен: сочетания работают, пока фокус на панели.");
            return;
        }
        showKeyWatchState("Запускаю помощника за клавишами…");
        tmp = platform.tmpdir();
        hb = platform.join(tmp, "sayframe_keys_" + Date.now() + ".beat");
        listFile = hb.replace(/\.beat$/, ".json");
        script = hb.replace(/\.beat$/, platform.isWindows() ? ".ps1" : ".js");
        w = keyWatch = { proc: { kill: function () {} }, list: watch, timer: 0, hb: hb };
        try {
            await platform.writeText(hb, String(Date.now()));
            await platform.writeText(listFile, JSON.stringify(watch));
            await platform.writeText(script, platform.isWindows() ? PS_KEYWATCH : JXA_KEYWATCH);
        } catch (e) { if (keyWatch === w) { keyWatch = null; } return; }
        if (keyWatch !== w) { return; }
        w.timer = setInterval(function () { platform.writeText(hb, String(Date.now())).catch(function () {}); }, KEYWATCH_BEAT_MS);
        w.proc = platform.spawn(platform.isWindows() ? "powershell" : "osascript",
            platform.isWindows() ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, hb, listFile] : ["-l", "JavaScript", script, hb, listFile],
            function (line) {
                var parts;
                if (keyWatch !== w) { return; }
                if (line.indexOf("HIT ") === 0) {
                    parts = line.substring(4).split(" ");
                    outsideHotkey(parts[0], "watch", parts.length >= 3 && isFinite(parts[1]) && isFinite(parts[2]) ? { x: +parts[1], y: +parts[2] } : null);
                }
                else if (line === "READY") { w.ready = true; showKeyWatchState("Помощник за клавишами работает: сочетания срабатывают во всём After Effects."); }
                else if (line === "NOACCESS") {
                    w.ready = false;
                    showKeyWatchState("macOS не даёт помощнику видеть клавиши вне панели. Откройте «Системные настройки» → «Конфиденциальность и безопасность» → " +
                        "«Мониторинг ввода» и включите там Adobe After Effects (или osascript), затем закройте и снова откройте панель.");
                    setStatus("Чтобы сочетания работали во всём After Effects, разрешите «Мониторинг ввода» (подробнее — в настройках панели, раздел «Общие»).", "");
                }
            },
            function (code, err) {
                platform.remove(script);
                platform.remove(listFile);
                if (keyWatch !== w) { return; }
                showKeyWatchState("Помощник за клавишами не запустился" + (err ? ": " + String(err).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").slice(-200) : " (код " + code + ")") +
                    ". Сочетания работают, пока фокус на панели" + (isMac() ? ", и через After Effects." : "."));
                // Наблюдатель не запустился или упал — остаются After Effects и сама панель.
                clearInterval(w.timer);
                platform.remove(hb);
                keyWatch = null;
            });
    }

    var PASTE_ANYWHERE = "pasteAny";

    // Cmd/Ctrl+V где-то в After Effects (не в панели). Слои и текст After Effects вставит сам,
    // панель вмешивается, только если в буфере картинка.
    async function pasteAnywhere() {
        var got;
        if (busy || !ui.modal.hidden || !ui.sheet.hidden || document.hasFocus()) { return; }
        try { got = await readClipboardOnce(true); } catch (e) { return; }
        // Скопированный в Finder или Проводнике файл — только если это картинка.
        if (got.kind === "none" || (got.kind === "file" && !/\.(png|jpe?g|gif|webp|bmp|tiff?|heic|psd)$/i.test(got.path))) { return; }
        if (busy || !ui.modal.hidden) { if (got.kind === "png") { platform.remove(got.path); } return; }
        try { window.focus(); } catch (e2) {}
        pasteImage(got);
    }

    function onHostHotkey(ev) {
        outsideHotkey(ev && ev.data !== undefined ? String(ev.data) : "", "host");
    }

    // Нажатие пришло не из самой панели: от After Effects (src "host") или от наблюдателя ("watch").
    // Одно нажатие могут заметить и они, и панель — второй раз его не выполняем.
    function outsideHotkey(id, src, pos) {
        // Поиск у курсора: место мыши знает только наблюдатель, поэтому ждём его, а не After Effects.
        if (id === "console" && src === "host" && settings.fxWhere === "cursor" && keyWatch && keyWatch.ready) { return; }
        if (id === PASTE_ANYWHERE && src === "watch") { pasteAnywhere(); return; }
        if (!id || !HOTKEY_ACTIONS.some(function (a) { return a.id === id; })) { return; }
        if (!ui.sheet.hidden || !ui.modal.hidden) { return; }
        // Панель уже сама поймала это нажатие.
        if (lastPanelHotkey.src !== src && lastPanelHotkey.id === id && Date.now() - lastPanelHotkey.at < 800) { return; }
        lastPanelHotkey = { id: id, at: Date.now(), src: src };
        // Поиск у курсора открывается окном After Effects, панель при этом фокус не забирает.
        if (id === "console" && pos && settings.fxWhere === "cursor" && !fxOpen()) { fxPopupAt(pos); return; }
        try { window.focus(); } catch (e) {}
        runHotkey(id);
    }

    function listenHostHotkeys() {
        var cep = window.__adobe_cep__;
        if (cep && typeof cep.addEventListener === "function") {
            try { cep.addEventListener(HOST_KEY_EVENT, onHostHotkey); } catch (e) {}
            try { cep.addEventListener(FX_EVENT, onFxPopupApplied); } catch (e2) {}
        }
    }

    function hotkeyHint() {
        var combo = parseHotkeys(settings.hotkeys).console;
        ui.fxBtn.title = "Поиск эффектов" + (combo ? " (" + comboLabel(combo) + ")" : "");
        var snap = parseHotkeys(settings.hotkeys).snapshot;
        ui.snapBtn.title = "Снимок кадра: PNG рядом с проектом и в буфер обмена" + (snap ? " (" + comboLabel(snap) + ")" : "");
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

    // Декомпоз: что вытащено и о чём стоит знать.
    var DC_NOTES = {
        opacity: "прозрачность прекомпозиции не перенесена — у слоёв своя",
        effects: "эффекты слоя-прекомпозиции не перенесены",
        masks: "маски слоя-прекомпозиции не перенесены",
        parents: "этот After Effects не умеет ставить родителя без сдвига — проверьте положение слоёв"
    };

    function decomposeReport(r) {
        var out = [], notes = [];
        var i;
        if (r.precomps) {
            out.push("Decompose: " + (r.precomps === 1 ? "из «" + r.names[0] + "»" : "из " + r.precomps + " прекомпозиций") + " вытащено слоёв: " + r.layers + ".");
            if (r.transform) { out.push("Прекомпозиция была сдвинута, увеличена или повёрнута, поэтому слои привязаны к невидимому слою «… [transform]» — так всё осталось на своих местах."); }
        }
        if (r.skipped.length) { out.push("Пропущено (растяжение или ремап времени): " + r.skipped.join(", ") + "."); }
        if (r.empty.length) { out.push("Пустые, вытаскивать нечего: " + r.empty.join(", ") + "."); }
        for (i = 0; i < r.notes.length; i++) { if (DC_NOTES[r.notes[i]]) { notes.push(DC_NOTES[r.notes[i]]); } }
        if (notes.length) { out.push("Учтите: " + notes.join("; ") + "."); }
        if (r.precomps) { out.push("Отменить — Cmd/Ctrl+Z."); }
        return out.join("\n");
    }

    async function onDecompose() {
        var res;
        if (busy) { return; }
        setBusy(true);
        setStatus("Вытаскиваю слои из прекомпозиции…", "busy");
        try {
            res = await host("decompose", []);
            setBusy(false);
            setStatus(decomposeReport(res.decomposed), res.decomposed.precomps ? "done" : "");
        } catch (e) {
            toolFailed(e);
        }
    }

    // Null / Parent: что сделала кнопка — зависит от выделения.
    function nullReport(r) {
        var c = r.children, m = r.created, list;
        if (c) {
            if (!c.names.length) { return "У «" + c.name + "» нет дочерних слоёв: к нему ничего не привязано через Parent."; }
            list = c.names.length > 12 ? c.names.slice(0, 12).join(", ") + " и ещё " + (c.names.length - 12) : c.names.join(", ");
            return "Дочерние слои «" + c.name + "» (" + c.names.length + "): " + list + ". Они выделены на таймлайне.";
        }
        if (!m.count) { return "Null: создан новый Null Object в центре композиции. Отменить — Cmd/Ctrl+Z."; }
        return "Null: «" + m.name + "» стал родителем для слоёв: " + m.count + "." +
            (m.parentOf ? " Сам он привязан к «" + m.parentOf + "», как были эти слои." : "") + " Отменить — Cmd/Ctrl+Z.";
    }

    async function onNullParent() {
        var res;
        if (busy) { return; }
        setBusy(true);
        try {
            res = await host("nullParent", []);
            setBusy(false);
            setStatus(nullReport(res), res.children && !res.children.names.length ? "" : "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    async function onRemoveUnused() {
        var r, list;
        if (busy) { return; }
        setBusy(true);
        setStatus("Ищу неиспользуемые файлы…", "busy");
        try {
            r = await host("removeUnused", []);
            setBusy(false);
            if (!r.removed) { setStatus("Remove unused: лишних файлов нет — всё в проекте где-то используется.", ""); return; }
            list = r.names.length > 10 ? r.names.slice(0, 10).join(", ") + " и ещё " + (r.names.length - 10) : r.names.join(", ");
            setStatus("Remove unused: убрано из проекта файлов: " + r.removed + " (" + list + "). С диска ничего не удалено. Отменить — Cmd/Ctrl+Z.", "done");
        } catch (e) {
            setBusy(false);
            setStatus("Не удалось убрать лишние файлы: " + humanError(e), "error");
        }
    }

    async function onClearCache() {
        if (busy) { return; }
        setBusy(true);
        setStatus("Очищаю память After Effects…", "busy");
        try {
            await host("clearCache", []);
            setBusy(false);
            setStatus("Clear cache: память After Effects очищена — RAM-превью, кэш изображений, снимки и история отмены.", "done");
        } catch (e) {
            setBusy(false);
            setStatus(e && e.message === "PURGE_UNAVAILABLE" ? "Этот After Effects не даёт очистить память из панели. Очистите её в меню Edit > Purge > All Memory." : "Не удалось очистить память: " + humanError(e), "error");
        }
    }

    // ------------------------------------------------------------ проекты (брендбуки)
    // Проект — бренд клиента или компании: логотипы (файлы копируются в «Документы / Sayframe Brands»),
    // цвета, шрифты, тексты. Хранится в localStorage; выбранный проект знает и AI.

    var BRAND_KEY = "sayframe.brands.v1";
    // Варианты логотипа: подпись в панели и что это значит для AI.
    var LOGO_VARIANTS = [["main", "Основной", "primary"], ["dark", "Тёмный", "dark, for light backgrounds"], ["white", "Белый", "white, for dark backgrounds"],
        ["vwhite", "Вертикальный белый", "vertical layout, white, for dark backgrounds"], ["vblack", "Вертикальный чёрный", "vertical layout, black, for light backgrounds"],
        ["mark", "Только лого", "symbol only, without the wordmark"], ["markgreen", "Только лого, фон зелёный", "symbol only, on a green background"],
        ["markwhite", "Только лого, фон белый", "symbol only, on a white background"]];
    function logoVariant(v) {
        var i;
        if (v === "icon") { v = "mark"; }      // «Значок» до 1.50.0
        for (i = 0; i < LOGO_VARIANTS.length; i++) { if (LOGO_VARIANTS[i][0] === v) { return LOGO_VARIANTS[i]; } }
        return LOGO_VARIANTS[0];
    }
    // Имя из имени файла: «alif_logo-white.png» → «alif logo white».
    function niceName(file) {
        return String(platform.basename(file)).replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "") || "logo";
    }
    var LOGO_EXT = /\.(png|jpe?g|svg|ai|eps|psd|pdf|tiff?|gif|webp)$/i;
    var LOGO_PREVIEW = /\.(png|jpe?g|svg|gif|webp)$/i;
    var BRAND_MAX = { colors: 24, texts: 30, logos: 30, gradients: 24, icons: 80 };
    var brandNaming = null;      // "new" или "rename", пока открыта строка названия
    var brandDelAt = 0;          // время первого нажатия «удалить»: второе в течение 4 с удаляет
    var brandFontsLoaded = false;

    function brandStr(v, max) { return typeof v === "string" ? v.replace(/^\s+|\s+$/g, "").substring(0, max) : ""; }

    function cleanBrand(b) {
        var out, i, c, t, l;
        if (!b || typeof b !== "object" || typeof b.id !== "string" || !b.id) { return null; }
        out = { id: b.id.substring(0, 40), name: brandStr(b.name, 60) || "Без названия", colors: [], gradients: [], fonts: { head: "", body: "" }, texts: [], logos: [], icons: [] };
        for (i = 0; b.colors instanceof Array && i < b.colors.length && out.colors.length < BRAND_MAX.colors; i++) {
            c = b.colors[i];
            if (c && parseHex(c.hex)) { out.colors.push({ name: brandStr(c.name, 30) || "Цвет", hex: parseHex(c.hex).hex }); }
        }
        for (i = 0; b.gradients instanceof Array && i < b.gradients.length && out.gradients.length < BRAND_MAX.gradients; i++) {
            c = cleanGradient(b.gradients[i]);
            if (c) { out.gradients.push(c); }
        }
        if (b.fonts && typeof b.fonts === "object") { out.fonts.head = brandStr(b.fonts.head, 120); out.fonts.body = brandStr(b.fonts.body, 120); }
        for (i = 0; b.texts instanceof Array && i < b.texts.length && out.texts.length < BRAND_MAX.texts; i++) {
            t = b.texts[i];
            if (t && brandStr(t.text, 300)) { out.texts.push({ name: brandStr(t.name, 30), text: brandStr(t.text, 300) }); }
        }
        for (i = 0; b.logos instanceof Array && i < b.logos.length && out.logos.length < BRAND_MAX.logos; i++) {
            l = b.logos[i];
            if (l && typeof l.file === "string" && l.file) {
                out.logos.push({ id: brandStr(l.id, 40) || brandNewId("l"), name: brandStr(l.name, 80) || platform.basename(l.file), file: l.file,
                    variant: logoVariant(l.variant)[0] });
            }
        }
        for (i = 0; b.icons instanceof Array && i < b.icons.length && out.icons.length < BRAND_MAX.icons; i++) {
            l = b.icons[i];
            if (l && typeof l.file === "string" && l.file) {
                out.icons.push({ id: brandStr(l.id, 40) || brandNewId("i"), name: brandStr(l.name, 80) || platform.basename(l.file), file: l.file });
            }
        }
        return out;
    }

    // Градиент бренда: два цвета (столько умеет Gradient Ramp в After Effects), линейный под углом или радиальный.
    function cleanGradient(g) {
        var a;
        if (!g || !parseHex(g.from) || !parseHex(g.to)) { return null; }
        a = Math.round(Number(g.angle));
        return { name: brandStr(g.name, 30) || "Градиент", from: parseHex(g.from).hex, to: parseHex(g.to).hex,
            type: g.type === "radial" ? "radial" : "linear", angle: isFinite(a) ? ((a % 360) + 360) % 360 : 90 };
    }

    // CSS-заливка для образца: угол как в After Effects и CSS (0° — снизу вверх, 90° — слева направо).
    function gradientCss(g) {
        return g.type === "radial" ? "radial-gradient(circle, " + g.from + ", " + g.to + ")" : "linear-gradient(" + g.angle + "deg, " + g.from + ", " + g.to + ")";
    }

    function brandNewId(prefix) { return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1000); }

    // Проект (например, «Alif Bank») состоит из разделов (Alif, Alifshop, Alif Academy…); у каждого раздела свой брендбук.
    // Старые проекты без разделов становятся проектом с одним разделом того же имени.
    // Сверху — разделы (например, Alif, Samsung). В разделе — проекты (Alif Shop, Alif Academy…) из списка,
    // у каждого проекта свой брендбук. Проекты из прежних версий попадают в раздел «Мои проекты».
    var BRAND_GROUP_DEFAULT = "Мои проекты";

    function cleanGroup(g) {
        var out, i, sb;
        if (!g || typeof g !== "object" || typeof g.id !== "string" || !g.id || !(g.subs instanceof Array)) { return null; }
        out = { id: g.id.substring(0, 40), name: brandStr(g.name, 60) || "Без названия", active: typeof g.active === "string" ? g.active : "", subs: [] };
        for (i = 0; i < g.subs.length && out.subs.length < 100; i++) {
            sb = cleanBrand(g.subs[i]);
            if (sb && !out.subs.some(function (x) { return x.id === sb.id; })) { out.subs.push(sb); }
        }
        if (!out.subs.some(function (x) { return x.id === out.active; })) { out.active = out.subs.length ? out.subs[0].id : ""; }
        return out;
    }

    function loadBrands() {
        var saved, out = { active: "", items: [] }, i, g, flat = [];
        try { saved = JSON.parse(window.localStorage.getItem(BRAND_KEY) || "null"); } catch (e) { saved = null; }
        if (saved && saved.items instanceof Array) {
            for (i = 0; i < saved.items.length && out.items.length < 100; i++) {
                if (saved.items[i] && saved.items[i].subs instanceof Array) {
                    g = cleanGroup(saved.items[i]);
                    if (g && !out.items.some(function (x) { return x.id === g.id; })) { out.items.push(g); }
                } else {
                    flat.push(saved.items[i]);
                }
            }
            out.active = typeof saved.active === "string" ? saved.active : "";
            // Прежний формат: просто список проектов — они становятся разделом «Мои проекты».
            if (flat.length) {
                g = cleanGroup({ id: "gmain", name: BRAND_GROUP_DEFAULT, active: out.active, subs: flat });
                if (g && g.subs.length) { out.items.unshift(g); out.active = g.id; }
            }
        }
        if (!out.items.some(function (x) { return x.id === out.active; })) { out.active = out.items.length ? out.items[0].id : ""; }
        return out;
    }

    var brands = loadBrands();

    function storeBrands() {
        try { window.localStorage.setItem(BRAND_KEY, JSON.stringify(brands)); } catch (e) {}
    }

    // Открытый раздел (Alif, Samsung…).
    function activeProject() {
        var i;
        for (i = 0; i < brands.items.length; i++) { if (brands.items[i].id === brands.active) { return brands.items[i]; } }
        return null;
    }

    // Брендбук проекта, выбранного в списке открытого раздела.
    function activeBrand() {
        var pr = activeProject(), i;
        if (!pr) { return null; }
        for (i = 0; i < pr.subs.length; i++) { if (pr.subs[i].id === pr.active) { return pr.subs[i]; } }
        return null;
    }

    function brandFullName(b) {
        var pr = activeProject();
        return pr && pr.name !== b.name && pr.name !== BRAND_GROUP_DEFAULT ? pr.name + " / " + b.name : b.name;
    }

    function brandFolder(b) { return platform.join(platform.homedir(), "Documents", "Sayframe Brands", b.id); }
    function brandBin(b) { return "Brand — " + b.name; }

    // Раздел для нового проекта: открытый, а если разделов ещё нет — «Мои проекты».
    function brandGroupForNew() {
        var g = activeProject();
        if (!g) {
            g = { id: brandNewId("g"), name: BRAND_GROUP_DEFAULT, active: "", subs: [] };
            brands.items.push(g);
            brands.active = g.id;
        }
        return g;
    }

    function fileUrl(p) {
        var norm = String(p).replace(/\\/g, "/");
        return "file://" + (norm.charAt(0) === "/" ? "" : "/") + encodeURI(norm).replace(/#/g, "%23").replace(/\?/g, "%3F");
    }

    function brandBgHex(b) {
        var i;
        for (i = 0; i < b.colors.length; i++) { if (/^(фон|background|bg)([^a-zа-яё]|$)/i.test(b.colors[i].name)) { return b.colors[i].hex; } }
        return "";
    }

    function mkEl(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined) { e.textContent = text; }
        return e;
    }

    function renderBrand() {
        var pr = activeProject(), b = activeBrand();
        var has = !!(pr && pr.subs.length);
        var i, o;
        ui.brandSelect.innerHTML = "";
        for (i = 0; pr && i < pr.subs.length; i++) {
            o = mkEl("option", "", pr.subs[i].name);
            o.value = pr.subs[i].id;
            ui.brandSelect.appendChild(o);
        }
        ui.brandSelect.value = pr ? pr.active : "";
        ui.brandPickRow.hidden = !has || brandNaming !== null;
        ui.brandShareRow.hidden = !has || brandNaming !== null || !!brandPending;
        ui.brandAsk.hidden = !brandPending;
        ui.brandTop.hidden = !has && brandNaming === null && !brandPending;
        ui.brandNameRow.hidden = brandNaming === null;
        ui.brandEmpty.hidden = has || brandNaming !== null;
        ui.brandBody.hidden = !b;
        ui.brandDeleteNote.hidden = !brandDelAt;
        ui.brandSubs.hidden = !brands.items.length;   // пока проектов нет, хватает большой кнопки «Создать первый проект»
        renderBrandSubs();
        renderBrandHits();
        if (!b) { return; }
        renderBrandLogos(b);
        renderBrandIcons(b);
        renderBrandColors(b);
        renderBrandGrads(b);
        if (document.activeElement !== ui.brandFontHead) { ui.brandFontHead.value = b.fonts.head; }
        if (document.activeElement !== ui.brandFontBody) { ui.brandFontBody.value = b.fonts.body; }
        renderBrandTexts(b);
    }

    // Разделы — ряд кнопок над проектом: «+» добавляет раздел, двойной щелчок переименовывает, × удаляет.
    function renderBrandSubs() {
        var box = ui.brandSubs, add;
        box.innerHTML = "";
        brands.items.forEach(function (g) {
            var on = g.id === brands.active;
            var chip = mkEl("button", "brand-sub", g.name);
            var x;
            chip.setAttribute("role", "tab");
            chip.setAttribute("aria-selected", on ? "true" : "false");
            chip.setAttribute("data-group", g.id);
            chip.title = on ? "Двойной щелчок — переименовать раздел" : "Открыть раздел «" + g.name + "»";
            chip.addEventListener("click", function () {
                if (brands.active !== g.id) { brands.active = g.id; brandDelAt = 0; brandNaming = null; storeBrands(); renderBrand(); }
            });
            chip.addEventListener("dblclick", function () { brandAskName("rename-group"); });
            if (on) {
                x = mkEl("span", "brand-sub-x", "×");
                x.setAttribute("role", "button");
                x.setAttribute("tabindex", "0");
                x.setAttribute("aria-label", "Удалить раздел «" + g.name + "»");
                x.title = x.getAttribute("aria-label");
                x.addEventListener("click", function (e) { e.stopPropagation(); brandDeleteGroup(); });
                x.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); brandDeleteGroup(); } });
                chip.appendChild(x);
            }
            box.appendChild(chip);
        });
        add = mkEl("button", "brand-sub brand-sub-add", "+");
        add.id = "brandSubAdd";
        add.title = "Добавить раздел (например, Samsung)";
        add.setAttribute("aria-label", add.title);
        add.addEventListener("click", function () { brandAskName("group"); });
        box.appendChild(add);
    }

    function brandX(label, onClick) {
        var x = mkEl("button", "brand-x", "×");
        x.setAttribute("aria-label", label);
        x.title = label;
        x.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
        return x;
    }

    // Карандаш у элемента: переименовать. Имя — то, по которому AI узнаёт элемент в запросе.
    function brandPen(label, onClick) {
        var p = mkEl("button", "brand-pen");
        p.type = "button";
        p.setAttribute("aria-label", label);
        p.title = label;
        p.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l2.2 2.2L4 10.2 1.5 10.5l.3-2.5z"/></svg>';
        p.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
        return p;
    }

    // Поле с именем на месте элемента: Enter или уход из поля — сохранить, Esc — отменить.
    function brandRenameInline(node, current, maxLen, save) {
        var input = mkEl("input", "field brand-rename"), done = false;
        input.value = current;
        input.maxLength = maxLen;
        input.spellcheck = false;
        input.setAttribute("aria-label", "Новое название");
        function finish(ok) {
            var v;
            if (done) { return; }
            done = true;
            v = brandStr(input.value, maxLen);
            if (ok && v && v !== current) { save(v); storeBrands(); }
            renderBrand();
        }
        input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener("blur", function () { finish(true); });
        node.parentNode.replaceChild(input, node);
        input.focus();
        input.select();
    }

    function renderBrandLogos(b) {
        var box = ui.brandLogos;
        box.innerHTML = "";
        box.setAttribute("data-empty", "Пока пусто: нажмите «+ Добавить» и выберите файл логотипа.");
        b.logos.forEach(function (l) {
            var tile = mkEl("div", "brand-logo");
            var pic = mkEl("button", "brand-logo-img");
            var sel = mkEl("select", "field");
            var img, nm;
            tile.setAttribute("data-logo", l.id);
            pic.title = "Вставить «" + l.name + "» в открытую композицию: прекомпозицией размером с логотип, в масштабе 10 %";
            pic.setAttribute("aria-label", pic.title);
            if (LOGO_PREVIEW.test(l.file)) {
                img = mkEl("img");
                img.alt = "";
                img.src = fileUrl(l.file);
                pic.appendChild(img);
            } else {
                pic.appendChild(mkEl("span", "", (l.file.match(/\.([a-z0-9]+)$/i) || ["", "file"])[1]));
            }
            pic.addEventListener("click", function () { brandPlaceLogo(l); });
            LOGO_VARIANTS.forEach(function (v) {
                var o = mkEl("option", "", v[1]);
                o.value = v[0];
                sel.appendChild(o);
            });
            sel.value = logoVariant(l.variant)[0];
            sel.setAttribute("aria-label", "Вариант логотипа «" + l.name + "»");
            sel.addEventListener("change", function () { l.variant = sel.value; storeBrands(); });
            nm = mkEl("small", "", l.name);
            nm.title = l.name + " — двойной щелчок, чтобы переименовать";
            nm.addEventListener("dblclick", function () { brandRenameInline(nm, l.name, 80, function (v) { l.name = v; }); });
            tile.appendChild(pic);
            tile.appendChild(nm);
            tile.appendChild(sel);
            tile.appendChild(brandPen("Переименовать логотип «" + l.name + "»", function () { brandRenameInline(nm, l.name, 80, function (v) { l.name = v; }); }));
            tile.appendChild(brandX("Убрать логотип «" + l.name + "» из проекта", function () { brandRemoveLogo(b, l); }));
            box.appendChild(tile);
        });
    }

    function renderBrandIcons(b) {
        var box = ui.brandIcons;
        box.innerHTML = "";
        box.setAttribute("data-empty", "Пока пусто: нажмите «+ Добавить» и выберите файлы иконок — можно сразу несколько.");
        b.icons.forEach(function (l) {
            var tile = mkEl("div", "brand-icon");
            var pic = mkEl("button", "brand-logo-img");
            var img, nm;
            tile.setAttribute("data-icon", l.id);
            pic.title = "Вставить иконку «" + l.name + "» в открытую композицию";
            pic.setAttribute("aria-label", pic.title);
            if (LOGO_PREVIEW.test(l.file)) {
                img = mkEl("img");
                img.alt = "";
                img.src = fileUrl(l.file);
                pic.appendChild(img);
            } else {
                pic.appendChild(mkEl("span", "", (l.file.match(/\.([a-z0-9]+)$/i) || ["", "file"])[1]));
            }
            pic.addEventListener("click", function () { brandPlaceIcon(l); });
            nm = mkEl("small", "", l.name);
            nm.title = l.name + " — двойной щелчок, чтобы переименовать";
            nm.addEventListener("dblclick", function () { brandRenameInline(nm, l.name, 80, function (v) { l.name = v; }); });
            tile.appendChild(pic);
            tile.appendChild(nm);
            tile.appendChild(brandPen("Переименовать иконку «" + l.name + "»", function () { brandRenameInline(nm, l.name, 80, function (v) { l.name = v; }); }));
            tile.appendChild(brandX("Убрать иконку «" + l.name + "» из проекта", function () { brandRemoveIcon(b, l); }));
            box.appendChild(tile);
        });
    }

    function renderBrandColors(b) {
        var box = ui.brandColors;
        box.innerHTML = "";
        box.setAttribute("data-empty", "Добавьте цвета бренда ниже: палитра или hex-код и название.");
        b.colors.forEach(function (c, i) {
            var chip = mkEl("button", "brand-chip");
            var sw = mkEl("i");
            var txt = mkEl("span", "", c.name);
            sw.style.background = c.hex;
            txt.appendChild(mkEl("small", "", c.hex));
            chip.appendChild(sw);
            chip.appendChild(txt);
            chip.setAttribute("data-hex", c.hex);
            chip.title = "Покрасить выделенные слои в «" + c.name + "» " + c.hex;
            chip.addEventListener("click", function () { brandPaint(c); });
            chip.appendChild(brandPen("Переименовать цвет «" + c.name + "»", function () { brandRenameInline(chip, c.name, 30, function (v) { c.name = v; }); }));
            chip.appendChild(brandX("Убрать цвет «" + c.name + "»", function () { b.colors.splice(i, 1); storeBrands(); renderBrand(); }));
            box.appendChild(chip);
        });
    }

    var brandGradFor = "", brandGradTouched = false;
    function renderBrandGrads(b) {
        var box = ui.brandGrads;
        box.innerHTML = "";
        box.setAttribute("data-empty", "Добавьте градиент ниже: два цвета, вид и угол.");
        // Для нового проекта форма предлагает его первые два цвета.
        // Пока цвета в форме не трогали, она предлагает первые два цвета проекта.
        if (brandGradFor !== b.id) { brandGradFor = b.id; brandGradTouched = false; }
        if (!brandGradTouched) {
            if (b.colors[0]) { ui.brandGradFrom.value = b.colors[0].hex; }
            if (b.colors[1]) { ui.brandGradTo.value = b.colors[1].hex; }
        }
        brandGradPreview();
        b.gradients.forEach(function (g, i) {
            var chip = mkEl("button", "brand-chip");
            var sw = mkEl("i", "brand-grad-sw");
            var txt = mkEl("span", "", g.name);
            sw.style.background = gradientCss(g);
            txt.appendChild(mkEl("small", "", g.type === "radial" ? "радиальный" : g.angle + "°"));
            chip.appendChild(sw);
            chip.appendChild(txt);
            chip.title = "Градиент «" + g.name + "» " + g.from + " → " + g.to + " на выделенные слои (ничего не выделено — новый солид)";
            chip.addEventListener("click", function () { brandGradient(g); });
            chip.appendChild(brandPen("Переименовать градиент «" + g.name + "»", function () { brandRenameInline(chip, g.name, 30, function (v) { g.name = v; }); }));
            chip.appendChild(brandX("Убрать градиент «" + g.name + "»", function () { b.gradients.splice(i, 1); storeBrands(); renderBrand(); }));
            box.appendChild(chip);
        });
    }

    function brandGradForm() {
        return cleanGradient({ name: ui.brandGradName.value, from: ui.brandGradFrom.value, to: ui.brandGradTo.value,
            type: ui.brandGradType.value, angle: ui.brandGradAngle.value });
    }

    function brandGradPreview() {
        var g = brandGradForm();
        if (g) { ui.brandGradPreview.style.background = gradientCss(g); }
        ui.brandGradAngle.disabled = ui.brandGradType.value === "radial";
    }

    function brandGradient(g) {
        brandCall("brandGradient", [g], function (r) {
            return (r.created ? "Новый солид «" + r.created + "» с градиентом на всю композицию." : "Градиент «" + g.name + "» на выделенных слоях: " + r.count + ".") +
                " Это эффект Gradient Ramp — точки начала и конца можно двигать. Отменить — Cmd/Ctrl+Z.";
        });
    }

    function renderBrandTexts(b) {
        var box = ui.brandTexts;
        box.innerHTML = "";
        box.setAttribute("data-empty", "Слоган, сайт, телефон, соцсети — добавьте ниже.");
        b.texts.forEach(function (t, i) {
            var row = mkEl("button", "brand-text");
            if (t.name) { row.appendChild(mkEl("small", "", t.name)); }
            row.appendChild(mkEl("span", "", t.text));
            row.title = "Создать текстовый слой с этим текстом";
            row.addEventListener("click", function () { brandMakeText(t); });
            row.appendChild(brandX("Убрать текст", function () { b.texts.splice(i, 1); storeBrands(); renderBrand(); }));
            box.appendChild(row);
        });
    }

    // ---- поделиться: проект целиком (с логотипами внутри) в один файл .sfbrand и обратно

    var BRAND_FILE = "sayframe-brand";
    var BRAND_FILE_MAX = 80 * 1024 * 1024;
    var brandPending = null;     // { brand, logos, same } — импорт ждёт ответа «обновить или копией»

    function brandSafeName(name) { return String(name).replace(/[\\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "") || "Brand"; }
    function logoExt(p) { var m = /\.([a-z0-9]+)$/i.exec(String(p)); return m ? m[1].toLowerCase() : ""; }

    async function brandExport() {
        var b = activeBrand(), g = activeProject();
        var r, pack, logos = [], icons = [], missing = 0, i, l;
        if (!b || busy) { return; }
        setBusy(true);
        try {
            r = await host("brandSaveDialog", [brandSafeName(b.name) + ".sfbrand", "Сохранить брендбук «" + b.name + "»"]);
        } catch (e) {
            setBusy(false);
            setStatus("Не удалось открыть окно сохранения: " + humanError(e), "error");
            return;
        }
        if (!r || !r.path) { setBusy(false); return; }
        setStatus("Собираю брендбук…", "busy");
        try {
            for (i = 0; i < b.logos.length; i++) {
                l = b.logos[i];
                try {
                    logos.push({ name: l.name, variant: l.variant, ext: logoExt(l.file), data: await platform.readBase64(l.file) });
                } catch (e1) {
                    missing++;
                }
            }
            for (i = 0; i < b.icons.length; i++) {
                l = b.icons[i];
                try {
                    icons.push({ name: l.name, ext: logoExt(l.file), data: await platform.readBase64(l.file) });
                } catch (e2) {
                    missing++;
                }
            }
            // section — раздел, в котором лежит проект: у коллеги брендбук встанет в раздел с тем же названием.
            pack = { format: BRAND_FILE, version: 1, section: g && g.name !== BRAND_GROUP_DEFAULT ? g.name : "",
                brand: { name: b.name, colors: b.colors, gradients: b.gradients, fonts: b.fonts, texts: b.texts, logos: logos, icons: icons } };
            await platform.writeText(r.path, JSON.stringify(pack));
            setBusy(false);
            setStatus("Брендбук «" + b.name + "» сохранён в файл " + platform.basename(r.path) + " (" + platform.dirname(r.path) + "). Отправьте его коллеге: у себя он откроет «Проекты» → «Импорт»." +
                (missing ? " Не нашлось файлов логотипов: " + missing + " — их в файле нет." : ""), "done");
        } catch (e) {
            setBusy(false);
            setStatus("Не удалось сохранить брендбук: " + humanError(e), "error");
        }
    }

    // Раздел из файла: брендбук без логотипов и логотипы отдельно (их ещё надо записать на диск).
    function brandFromFile(raw) {
        var b = cleanBrand({ id: brandNewId("b"), name: raw && raw.name, colors: raw && raw.colors, gradients: raw && raw.gradients, fonts: raw && raw.fonts, texts: raw && raw.texts, logos: [] });
        var logos = (raw && raw.logos instanceof Array ? raw.logos : []).filter(function (l) {
            return l && typeof l.data === "string" && l.data && LOGO_EXT.test("x." + String(l.ext || ""));
        }).slice(0, BRAND_MAX.logos);
        var icons = (raw && raw.icons instanceof Array ? raw.icons : []).filter(function (l) {
            return l && typeof l.data === "string" && l.data && LOGO_EXT.test("x." + String(l.ext || ""));
        }).slice(0, BRAND_MAX.icons);
        return { brand: b, logos: logos, icons: icons };
    }

    async function brandImport() {
        var path, text, pack, parts = [], groupName = "", same = null, g;
        if (busy) { return; }
        setBusy(true);
        path = await platform.pickFile("Выберите файл брендбука .sfbrand");
        if (!path) { setBusy(false); return; }
        try {
            text = await platform.readText(path);
            if (text.length > BRAND_FILE_MAX) { throw new Error("BIG"); }
            pack = JSON.parse(text);
        } catch (e) {
            pack = null;
        }
        setBusy(false);
        if (pack && pack.format === BRAND_FILE && pack.brand && typeof pack.brand === "object") {
            parts = [brandFromFile(pack.brand)];
            brandOpenSection(brandStr(pack.section, 60));
        } else if (pack && pack.format === BRAND_FILE && pack.project && pack.project.subs instanceof Array) {
            groupName = brandStr(pack.project.name, 60) || "Без названия";     // целый раздел с проектами
            parts = pack.project.subs.slice(0, 100).map(brandFromFile);
        }
        if (!parts.length) {
            setStatus("Это не файл брендбука Sayframe. Нужен файл .sfbrand, сохранённый кнопкой «Поделиться».", "error");
            return;
        }
        if (!groupName) {
            g = activeProject();
            (g ? g.subs : []).forEach(function (x) { if (x.name.toLowerCase() === parts[0].brand.name.toLowerCase()) { same = x; } });
        }
        if (same) {
            brandPending = { parts: parts, same: same };
            ui.brandAskText.textContent = "В разделе уже есть проект «" + same.name + "». Обновить его из файла или сохранить отдельной копией?";
            renderBrand();
            return;
        }
        await brandFinishImport(parts, null, groupName);
    }

    // Брендбук из файла встаёт в раздел, где он был у отправителя: в такой же по названию или в новый.
    function brandOpenSection(name) {
        var g = null;
        if (!name || name === BRAND_GROUP_DEFAULT) { return; }
        brands.items.forEach(function (x) { if (!g && x.name.toLowerCase() === name.toLowerCase()) { g = x; } });
        if (!g) {
            g = { id: brandNewId("g"), name: name, active: "", subs: [] };
            brands.items.push(g);
        }
        brands.active = g.id;
        storeBrands();
        renderBrand();
    }

    // Пишет логотипы на диск и добавляет проекты: в открытый раздел или (groupName) новым разделом.
    async function brandFinishImport(parts, replace, groupName) {
        var g, i, j, l, id, dest, fails = 0, idx, b, nLogos = 0;
        setBusy(true);
        setStatus("Добавляю брендбук…", "busy");
        try {
            if (groupName) {
                g = { id: brandNewId("g"), name: groupName, active: "", subs: [] };
                brands.items.push(g);
                brands.active = g.id;
            } else {
                g = brandGroupForNew();
            }
            if (replace) { brandForget(replace); }
            for (j = 0; j < parts.length; j++) {
                b = parts[j].brand;
                if (replace && j === 0) { b.id = replace.id; }
                if (parts[j].logos.length) { await platform.mkdirp(brandFolder(b)); }
                for (i = 0; i < parts[j].logos.length; i++) {
                    l = parts[j].logos[i];
                    id = brandNewId("l");
                    dest = platform.join(brandFolder(b), id + "-" + (brandStr(l.name, 60) || "logo").replace(/[^\w.\-]+/g, "_") + "." + String(l.ext).toLowerCase());
                    try {
                        await platform.writeBytes(dest, b64Bytes(l.data));
                        b.logos.push({ id: id, name: brandStr(l.name, 80) || "logo", file: dest,
                            variant: logoVariant(l.variant)[0] });
                        nLogos++;
                    } catch (e1) {
                        fails++;
                    }
                }
                if ((parts[j].icons || []).length) { await platform.mkdirp(brandFolder(b)); }
                for (i = 0; i < (parts[j].icons || []).length; i++) {
                    l = parts[j].icons[i];
                    id = brandNewId("i");
                    dest = platform.join(brandFolder(b), id + "-" + (brandStr(l.name, 60) || "icon").replace(/[^\w.\-]+/g, "_") + "." + String(l.ext).toLowerCase());
                    try {
                        await platform.writeBytes(dest, b64Bytes(l.data));
                        b.icons.push({ id: id, name: brandStr(l.name, 80) || "icon", file: dest });
                    } catch (e2) {
                        fails++;
                    }
                }
                idx = replace && j === 0 ? g.subs.indexOf(replace) : -1;
                if (idx >= 0) { g.subs[idx] = b; } else { g.subs.push(b); }
            }
            g.active = parts[0].brand.id;
            brandPending = null;
            storeBrands();
            renderBrand();
            setBusy(false);
            b = parts[0].brand;
            setStatus(groupName ? "Раздел «" + g.name + "» добавлен: проектов — " + parts.length + ", логотипов — " + nLogos + "." :
                "Брендбук «" + b.name + "» " + (replace ? "обновлён" : "добавлен") + (g.name !== BRAND_GROUP_DEFAULT ? " в раздел «" + g.name + "»" : "") + ": логотипов — " + b.logos.length + ", цветов — " + b.colors.length + ", текстов — " + b.texts.length + "." +
                (fails ? " Не удалось сохранить логотипов: " + fails + "." : ""), "done");
        } catch (e) {
            setBusy(false);
            setStatus("Не удалось добавить брендбук: " + humanError(e), "error");
        }
    }

    function brandAnswer(how) {
        var p = brandPending, n = 2, g = activeProject(), base;
        if (!p) { return; }
        if (how === "cancel") { brandPending = null; renderBrand(); setStatus("Импорт отменён.", ""); return; }
        if (how === "copy") {
            base = p.parts[0].brand.name;
            while (g && g.subs.some(function (x) { return x.name.toLowerCase() === (base + " " + n).toLowerCase(); })) { n++; }
            p.parts[0].brand.name = brandStr(base + " " + n, 60);
            brandFinishImport(p.parts, null, "");
            return;
        }
        brandFinishImport(p.parts, p.same, "");
    }

    // Название: новый проект, новый раздел или переименование того или другого — одна строка ввода.
    var BRAND_NAME_HINT = { "new": "Название: клиент или компания", rename: "Новое название проекта",
        group: "Название раздела", "rename-group": "Новое название раздела" };

    function brandAskName(mode) {
        var g = activeProject(), b = activeBrand();
        brandNaming = mode;
        brandDelAt = 0;
        ui.brandName.value = mode === "rename" && b ? b.name : mode === "rename-group" && g ? g.name : "";
        ui.brandName.placeholder = BRAND_NAME_HINT[mode] || "";
        renderBrand();
        ui.brandName.focus();
    }

    function brandNameDone(ok) {
        var name = brandStr(ui.brandName.value, 60);
        var mode = brandNaming, g = activeProject(), b = activeBrand(), sb, msg = "";
        if (ok && !name) { ui.brandName.focus(); return; }
        if (ok && mode === "rename" && b) {
            b.name = name;
            msg = "Проект переименован: «" + name + "».";
        } else if (ok && mode === "rename-group" && g) {
            g.name = name;
            msg = "Раздел переименован: «" + name + "».";
        } else if (ok && mode === "group") {
            g = { id: brandNewId("g"), name: name, active: "", subs: [] };
            brands.items.push(g);
            brands.active = g.id;
            msg = "Раздел «" + name + "» добавлен. Создайте в нём первый проект.";
        } else if (ok) {
            g = brandGroupForNew();
            sb = cleanBrand({ id: brandNewId("b"), name: name });
            g.subs.push(sb);
            g.active = sb.id;
            msg = "Проект «" + name + "» готов. Добавьте логотипы, цвета, шрифты и тексты.";
        }
        brandNaming = null;
        storeBrands();
        renderBrand();
        if (msg) { setStatus(msg, ""); }
    }

    // Файлы логотипов удаляем с диска, только если открытый проект After Effects их не использует:
    // иначе After Effects при перезагрузке футажа покажет «A file could not be found».
    async function brandRemoveFiles(paths) {
        var used = [], r;
        if (!paths.length) { return; }
        try { r = await host("brandFilesInUse", [paths]); used = r && r.used instanceof Array ? r.used : []; } catch (e) { return; }
        paths.forEach(function (p, i) { if (used.indexOf(i) < 0) { platform.remove(p); } });
    }

    function brandForget(b) {
        brandRemoveFiles(b.logos.concat(b.icons).filter(function (l) { return l.file.indexOf(brandFolder(b)) === 0; }).map(function (l) { return l.file; }));
    }

    // Удаление — со второго нажатия в течение 4 секунд. what: "project" или "group".
    var brandDelWhat = "";
    function brandArmDelete(what, text) {
        var now = Date.now();
        if (brandDelAt && brandDelWhat === what && now - brandDelAt <= 4000) { brandDelAt = 0; return true; }
        brandDelAt = now;
        brandDelWhat = what;
        ui.brandDeleteNote.textContent = text;
        renderBrand();
        setTimeout(function () { if (brandDelAt === now) { brandDelAt = 0; renderBrand(); } }, 4000);
        return false;
    }

    function brandDelete() {
        var g = activeProject(), b = activeBrand();
        if (!g || !b) { return; }
        if (!brandArmDelete("project", "Нажмите корзину ещё раз, чтобы удалить «" + b.name + "» вместе с его логотипами.")) { return; }
        brandForget(b);
        g.subs = g.subs.filter(function (x) { return x.id !== b.id; });
        g.active = g.subs.length ? g.subs[0].id : "";
        storeBrands();
        renderBrand();
        setStatus("Проект «" + b.name + "» удалён.", "");
    }

    function brandDeleteGroup() {
        var g = activeProject();
        if (!g) { return; }
        if (!brandArmDelete("group", "Нажмите × ещё раз, чтобы удалить раздел «" + g.name + "» со всеми его проектами (" + g.subs.length + ")." )) { return; }
        g.subs.forEach(brandForget);
        brands.items = brands.items.filter(function (x) { return x.id !== g.id; });
        brands.active = brands.items.length ? brands.items[0].id : "";
        storeBrands();
        renderBrand();
        setStatus("Раздел «" + g.name + "» удалён.", "");
    }

    function b64Bytes(b64) {
        var bin = atob(b64), out = new Uint8Array(bin.length), i;
        for (i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
        return out;
    }

    async function brandAddLogo() {
        var b = activeBrand();
        var src, id, dest, name;
        if (!b || busy) { return; }
        if (b.logos.length >= BRAND_MAX.logos) { setStatus("В разделе уже " + BRAND_MAX.logos + " логотипов — уберите лишние.", ""); return; }
        setBusy(true);
        src = await platform.pickFile("Выберите файл логотипа");
        if (!src) { setBusy(false); return; }
        if (!LOGO_EXT.test(src)) { setBusy(false); setStatus("Это не логотип: подойдут PNG, SVG, AI, EPS, PSD, PDF, JPG, TIFF, GIF или WebP.", "error"); return; }
        id = brandNewId("l");
        name = niceName(src);
        dest = src;
        // Копия в папку раздела: логотип не потеряется, даже если оригинал переместят.
        try {
            await platform.mkdirp(brandFolder(b));
            dest = platform.join(brandFolder(b), id + "-" + platform.basename(src).replace(/[^\w.\-]+/g, "_"));
            await platform.writeBytes(dest, b64Bytes(await platform.readBase64(src)));
        } catch (e) {
            dest = src;
        }
        b.logos.push({ id: id, name: name, file: dest, variant: "main" });
        storeBrands();
        renderBrand();
        setBusy(false);
        setStatus("Логотип «" + name + "» добавлен в проект «" + b.name + "». Щелчок по нему вставит его в композицию.", "done");
    }

    // Иконки: можно выбрать сразу несколько файлов; каждый копируется в папку проекта, как логотип.
    async function brandAddIcons() {
        var b = activeBrand();
        var list, src, id, dest, added = [], skipped = 0, i, room;
        if (!b || busy) { return; }
        room = BRAND_MAX.icons - b.icons.length;
        if (room <= 0) { setStatus("В проекте уже " + BRAND_MAX.icons + " иконок — уберите лишние.", ""); return; }
        setBusy(true);
        list = await platform.pickFiles("Выберите файлы иконок");
        if (!list || !list.length) { setBusy(false); return; }
        for (i = 0; i < list.length; i++) {
            src = list[i];
            if (!LOGO_EXT.test(src) || added.length >= room) { skipped++; continue; }
            id = brandNewId("i");
            dest = src;
            try {
                await platform.mkdirp(brandFolder(b));
                dest = platform.join(brandFolder(b), id + "-" + platform.basename(src).replace(/[^\w.\-]+/g, "_"));
                await platform.writeBytes(dest, b64Bytes(await platform.readBase64(src)));
            } catch (e) {
                dest = src;
            }
            b.icons.push({ id: id, name: niceName(src), file: dest });
            added.push(b.icons[b.icons.length - 1].name);
        }
        storeBrands();
        renderBrand();
        setBusy(false);
        if (!added.length) { setStatus("Это не иконки: подойдут SVG, PNG, AI, EPS, PSD, PDF, JPG, TIFF, GIF или WebP.", "error"); return; }
        setStatus((added.length === 1 ? "Иконка «" + added[0] + "» добавлена" : "Иконок добавлено: " + added.length) + " в проект «" + b.name + "». Щелчок по иконке вставит её в композицию." +
            (skipped ? " Пропущено файлов: " + skipped + " (не картинка или нет места)." : ""), "done");
    }

    function brandRemoveIcon(b, l) {
        b.icons = b.icons.filter(function (x) { return x.id !== l.id; });
        if (l.file.indexOf(brandFolder(b)) === 0) { brandRemoveFiles([l.file]); }
        storeBrands();
        renderBrand();
    }

    function brandPlaceIcon(l) {
        var b = activeBrand();
        if (!b) { return; }
        brandCall("brandIcon", [l.file, brandBin(b)], function (r) {
            return r.comp ? "Иконка «" + l.name + "» вставлена в «" + r.comp + "» в центр, в исходном размере. Файл — в папке «" + brandBin(b) + "». Отменить — Cmd/Ctrl+Z."
                : "Иконка «" + l.name + "» добавлена в проект, в папку «" + brandBin(b) + "». Откройте композицию — и щелчок вставит её туда.";
        });
    }

    function brandRemoveLogo(b, l) {
        b.logos = b.logos.filter(function (x) { return x.id !== l.id; });
        if (l.file.indexOf(brandFolder(b)) === 0) { brandRemoveFiles([l.file]); }
        storeBrands();
        renderBrand();
    }

    // Общий вызов хоста для кнопок раздела: занятость, статус, подсказка вместо ошибки на «ничего не выделено».
    async function brandCall(fn, args, report) {
        var res;
        if (busy) { return null; }
        setBusy(true);
        try {
            res = await host(fn, args);
            setBusy(false);
            setStatus(report(res), "done");
            return res;
        } catch (e) {
            toolFailed(e);
            return null;
        }
    }

    function brandPlaceLogo(l) {
        var b = activeBrand();
        if (!b) { return; }
        brandCall("brandLogo", [l.file, brandBin(b), l.name], function (r) {
            return r.comp ? "Логотип «" + l.name + "» вставлен в «" + r.comp + "» прекомпозицией «" + r.pre + "»: внутри логотип в масштабе 100 %, а сама прекомпозиция — " + r.scale + " %. Файл и прекомпозиция лежат в папке «" + brandBin(b) + "»."
                : "Логотип «" + l.name + "» добавлен в проект, в папку «" + brandBin(b) + "». Откройте композицию — и щелчок вставит его в неё.";
        });
    }

    function brandPaint(c) {
        brandCall("brandColor", [c.hex, c.name], function (r) {
            return "«" + c.name + "» " + c.hex + ": покрашено слоёв — " + r.count + "." + (r.linked ? " Цвет привязан к слою Brand Colors." : "") + " Отменить — Cmd/Ctrl+Z.";
        });
    }

    function brandRig() {
        var b = activeBrand();
        if (!b) { return; }
        if (!b.colors.length) { setStatus("Сначала добавьте цвета бренда.", ""); return; }
        brandCall("brandRig", [b.colors], function (r) {
            return "Слой Brand Colors " + (r.created ? "создан" : "обновлён") + " в «" + r.comp + "»: цветов — " + r.count +
                ". Теперь щелчок по цвету привязывает слой к нему: поменяете цвет в Brand Colors — он сменится везде.";
        });
    }

    function brandApplyFont(which) {
        var b = activeBrand();
        var font = brandStr((which === "head" ? ui.brandFontHead : ui.brandFontBody).value, 120);
        if (!b) { return; }
        if (!font) { setStatus("Впишите название шрифта, например Montserrat-Bold.", ""); return; }
        brandCall("brandFont", [font], function (r) {
            return r.missing ? "Шрифта «" + font + "» нет на этом компьютере — After Effects поставил замену. Установите шрифт или впишите его точное имя (PostScript)."
                : "Шрифт «" + font + "» поставлен текстовым слоям: " + r.count + ".";
        });
    }

    function brandMakeText(t) {
        var b = activeBrand();
        if (!b) { return; }
        brandCall("brandText", [t.text, b.fonts.head || b.fonts.body || "", b.colors.length ? b.colors[0].hex : ""], function (r) {
            return "Текстовый слой «" + r.name + "» создан в «" + r.comp + "»" + (r.missing ? ", но шрифта бренда нет на этом компьютере — стоит замена." : ".");
        });
    }

    function brandMakeComp(w, h) {
        var b = activeBrand();
        if (!b) { return; }
        brandCall("brandComp", [b.name + " " + w + "x" + h, w, h, 30, 10, brandBgHex(b), brandBin(b)], function (r) {
            return "Композиция «" + r.name + "» " + w + "×" + h + " создана и открыта" + (r.bg ? ", фон — цвет «Фон»." : ".");
        });
    }

    // Список шрифтов для подсказки при вводе (After Effects 2024 и новее умеет его отдать).
    async function brandLoadFonts() {
        var r;
        if (brandFontsLoaded) { return; }
        brandFontsLoaded = true;
        try { r = await host("brandFonts", []); } catch (e) { return; }
        (r && r.fonts instanceof Array ? r.fonts : []).slice(0, 4000).forEach(function (f) {
            var o = document.createElement("option");
            o.value = f;
            ui.brandFontList.appendChild(o);
        });
    }

    // Что знает AI о выбранном проекте.
    function brandNote() {
        var b = activeBrand();
        var lines = [];
        if (!b || (!b.colors.length && !b.gradients.length && !b.logos.length && !b.icons.length && !b.fonts.head && !b.fonts.body && !b.texts.length)) { return ""; }
        lines.push("[Brand: " + brandFullName(b) + "] Use this brand when the request mentions the brand, logo, brand colors or fonts, or asks for something \"in our style\".");
        if (b.colors.length) { lines.push("Colors: " + b.colors.map(function (c) { return c.name + " " + c.hex; }).join(", ")); }
        if (b.gradients.length) {
            lines.push("Gradients (two colors each; in After Effects use the Gradient Ramp effect, angle 0 = bottom to top, 90 = left to right): " +
                b.gradients.map(function (g) { return g.name + " " + g.from + " -> " + g.to + (g.type === "radial" ? " radial" : " linear " + g.angle + "deg"); }).join(", "));
        }
        if (b.fonts.head || b.fonts.body) { lines.push("Fonts (PostScript names): headings " + (b.fonts.head || "-") + ", body text " + (b.fonts.body || b.fonts.head || "-")); }
        if (b.logos.length) {
            lines.push("Logo files (import with app.project.importFile; reuse an item already in the project if its file matches): " +
                b.logos.map(function (l) { return '"' + l.name + '" (' + logoVariant(l.variant)[2] + "): " + l.file; }).join("; "));
        }
        if (b.icons.length) {
            lines.push("Icon files (import with app.project.importFile; reuse an item already in the project if its file matches): " +
                b.icons.map(function (l) { return l.name + ": " + l.file; }).join("; "));
        }
        if (b.texts.length) { lines.push("Brand texts: " + b.texts.map(function (t) { return (t.name ? t.name + ": " : "") + t.text; }).join(" | ")); }
        return lines.join("\n");
    }

    // Порядок разделов брендбука (Логотипы, Иконки, Цвета…): стрелки ↑ ↓ в заголовке меняют раздел местами с соседним.
    // Порядок общий для всех проектов и запоминается.
    var BRAND_ORDER_KEY = "sayframe.brandOrder.v1";
    var BRAND_SEC_NAMES = { logos: "Логотипы", icons: "Иконки", colors: "Цвета", grads: "Градиенты", fonts: "Шрифты", texts: "Тексты", formats: "Форматы" };

    function brandSecs() { return Array.prototype.slice.call(ui.brandBody.querySelectorAll(":scope > .brand-sec")); }

    function brandSecArrows() {
        var list = brandSecs();
        list.forEach(function (sec, i) {
            sec.querySelector('.brand-move [data-dir="-1"]').disabled = i === 0;
            sec.querySelector('.brand-move [data-dir="1"]').disabled = i === list.length - 1;
        });
    }

    function brandMoveSec(sec, dir) {
        var list = brandSecs(), i = list.indexOf(sec), other = list[i + dir];
        if (!other) { return; }
        if (dir < 0) { ui.brandBody.insertBefore(sec, other); } else { ui.brandBody.insertBefore(other, sec); }
        try { window.localStorage.setItem(BRAND_ORDER_KEY, JSON.stringify(brandSecs().map(function (x) { return x.getAttribute("data-sec"); }))); } catch (e) {}
        brandSecArrows();
        // Фокус остаётся на нажатой стрелке; если она стала неактивной (раздел дошёл до края) — на другой.
        var btn = sec.querySelector('.brand-move [data-dir="' + dir + '"]');
        (btn.disabled ? sec.querySelector('.brand-move [data-dir="' + (-dir) + '"]') : btn).focus();
        if (sec.scrollIntoView) { sec.scrollIntoView({ block: "nearest" }); }
    }

    function initBrandOrder() {
        var saved = null;
        try { saved = JSON.parse(window.localStorage.getItem(BRAND_ORDER_KEY) || "null"); } catch (e) {}
        brandSecs().forEach(function (sec) {
            var id = sec.getAttribute("data-sec"), name = BRAND_SEC_NAMES[id] || id, head = sec.querySelector(".brand-h"), box = mkEl("span", "brand-move");
            [[-1, "M6 10V2M2.5 5.5L6 2l3.5 3.5", "выше"], [1, "M6 2v8M2.5 6.5L6 10l3.5-3.5", "ниже"]].forEach(function (d) {
                var b = mkEl("button");
                b.type = "button";
                b.setAttribute("data-dir", String(d[0]));
                b.setAttribute("aria-label", "Раздел «" + name + "» " + d[2]);
                b.title = "Поднять раздел «" + name + "» " + d[2];
                if (d[0] > 0) { b.title = "Опустить раздел «" + name + "» " + d[2]; }
                b.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d[1] + '"/></svg>';
                b.addEventListener("click", function () { brandMoveSec(sec, d[0]); });
                box.appendChild(b);
            });
            head.insertBefore(box, head.querySelector("b").nextSibling);
        });
        if (saved instanceof Array) {
            var def = brandSecs().map(function (x) { return x.getAttribute("data-sec"); });
            var order = saved.filter(function (id, i) { return def.indexOf(id) >= 0 && saved.indexOf(id) === i; });
            // Раздел, которого нет в сохранённом порядке (появился в обновлении), встаёт после своего прежнего соседа.
            def.forEach(function (id, i) {
                var k, at = 0;
                if (order.indexOf(id) >= 0) { return; }
                for (k = i - 1; k >= 0; k--) { if (order.indexOf(def[k]) >= 0) { at = order.indexOf(def[k]) + 1; break; } }
                order.splice(at, 0, id);
            });
            order.forEach(function (id) { ui.brandBody.appendChild(ui.brandBody.querySelector(':scope > .brand-sec[data-sec="' + id + '"]')); });
        }
        brandSecArrows();
    }

    // ---- AI и брендбук: @-упоминания и «AI поймёт так»
    // Каждый элемент брендбука (логотип, иконка, цвет, градиент, текст, шрифт) — со своим именем.
    // В поле AI «@» открывает список элементов, выбранный встаёт меткой «@Имя». Без @ панель сама ищет в запросе
    // имена и варианты («белый логотип», «зелёный», «иконка корзина») и показывает под полем, что именно уйдёт AI.

    var BRAND_KIND_RU = { logo: "Логотип", icon: "Иконка", color: "Цвет", grad: "Градиент", text: "Текст", font: "Шрифт" };
    var BRAND_KIND_WORDS = { logo: ["лого", "logo", "знак"], icon: ["иконк", "icon", "значок", "пиктограм"], color: ["цвет", "color"],
        grad: ["градиент", "gradient"], text: ["текст", "слоган", "надпис", "text"], font: ["шрифт", "font"] };
    var brandOff = {};         // ключи элементов, которые пользователь убрал из «AI поймёт так» для этого запроса

    function brandItems(b) {
        var out = [];
        if (!b) { return out; }
        b.logos.forEach(function (l) { out.push({ key: "logo:" + l.id, kind: "logo", name: l.name, extra: logoVariant(l.variant)[1], ref: l }); });
        b.icons.forEach(function (l) { out.push({ key: "icon:" + l.id, kind: "icon", name: l.name, extra: "", ref: l }); });
        b.colors.forEach(function (c) { out.push({ key: "color:" + c.name + c.hex, kind: "color", name: c.name, extra: c.hex, ref: c }); });
        b.gradients.forEach(function (g) { out.push({ key: "grad:" + g.name + g.from + g.to, kind: "grad", name: g.name, extra: "", ref: g }); });
        b.texts.forEach(function (t, i) { out.push({ key: "text:" + i + t.text, kind: "text", name: t.name || t.text.substring(0, 30), extra: t.name ? t.text : "", ref: t }); });
        if (b.fonts.head) { out.push({ key: "font:head", kind: "font", name: b.fonts.head, extra: "заголовки", ref: { role: "headings", font: b.fonts.head } }); }
        if (b.fonts.body) { out.push({ key: "font:body", kind: "font", name: b.fonts.body, extra: "текст", ref: { role: "body text", font: b.fonts.body } }); }
        return out;
    }

    function normTxt(s) { return String(s || "").toLowerCase().replace(/ё/g, "е"); }
    function wordsOf(s) { return normTxt(s).split(/[^a-zа-я0-9]+/).filter(function (w) { return w.length >= 2; }); }
    function wordStem(w) { return w.length > 4 ? w.substring(0, w.length - 2) : w; }
    // Одно слово в разных формах: «белый» = «белое» = «белым», «лого» = «логотип».
    function sameWord(a, b) {
        var x = wordStem(a), y = wordStem(b);
        if (Math.min(x.length, y.length) < 3) { return a === b; }
        return x.indexOf(y) === 0 || y.indexOf(x) === 0;
    }
    function isKindWord(w, kind) {
        return BRAND_KIND_WORDS[kind].some(function (k) { return w.indexOf(k) === 0 || (w.length >= 4 && k.indexOf(w) === 0); });
    }

    // Что из брендбука упомянуто в запросе: [{ item, how: "@" | "name" | "variant" }], самое точное сначала.
    function brandMatches(text, b) {
        var low = normTxt(text), words = wordsOf(text), out = [];
        brandItems(b).forEach(function (it) {
            var kindHit = words.some(function (w) { return isKindWord(w, it.kind); });
            var nw = wordsOf(it.name).filter(function (w) { return !isKindWord(w, it.kind); });
            var xw = it.kind === "logo" ? wordsOf(it.extra) : [];
            var has = function (w) { return words.some(function (x) { return sameWord(w, x); }); };
            var nf = nw.filter(has).length, xf = xw.filter(has).length, score = 0, how = "";
            if (low.indexOf("@" + normTxt(it.name)) >= 0) { score = 100; how = "@"; }
            else if (nw.length && nf === nw.length && (nw.length > 1 || kindHit || nw[0].length >= 3)) { score = 10 + nf + (kindHit ? 1 : 0); how = "name"; }
            else if (it.kind === "logo" && kindHit && xw.length && xf === xw.length) { score = 5 + xf; how = "variant"; }
            if (score) { out.push({ item: it, how: how, score: score }); }
        });
        // Вариант логотипа: «вертикальный белый» точнее, чем просто «белый».
        out.sort(function (a, c) { return c.score - a.score; });
        out = out.filter(function (h) {
            return !(h.how === "variant" && out.some(function (o) { return o.how === "variant" && o.score > h.score && o.item.kind === "logo"; }));
        });
        return out.slice(0, 8);
    }

    function brandHitsNow() {
        var b = activeBrand(), text = ui.prompt.value;
        if (!b || !/\S/.test(text)) { return []; }
        return brandMatches(text, b).filter(function (h) { return !brandOff[h.item.key]; });
    }

    function renderBrandHits() {
        var hits, box = ui.brandHits;
        if (!/\S/.test(ui.prompt.value)) { brandOff = {}; }
        hits = brandHitsNow();
        box.innerHTML = "";
        box.hidden = !hits.length;
        if (!hits.length) { return; }
        box.appendChild(mkEl("span", "brand-hits-label", "AI поймёт так:"));
        hits.forEach(function (h) {
            var it = h.item, chip = mkEl("span", "brand-hit"), x = mkEl("button", "", "×");
            chip.appendChild(brandMentionSwatch(it));
            chip.appendChild(mkEl("span", "", BRAND_KIND_RU[it.kind] + ": " + it.name + (it.kind === "logo" ? " · " + it.extra : "")));
            chip.setAttribute("data-key", it.key);
            x.type = "button";
            x.setAttribute("aria-label", "Не передавать AI: " + it.name);
            x.title = "Не то — не передавать AI";
            x.addEventListener("click", function () { brandOff[it.key] = true; renderBrandHits(); ui.prompt.focus(); });
            chip.appendChild(x);
            box.appendChild(chip);
        });
    }

    // Строка для AI о том, что именно из брендбука имеется в виду в запросе.
    function brandHitsNote(hits) {
        if (!hits.length) { return ""; }
        return "[Brand items meant in this request — use exactly these]\n" + hits.map(function (h) {
            var it = h.item, r = it.ref;
            if (it.kind === "logo") { return "- logo \"" + it.name + "\" (" + logoVariant(r.variant)[2] + "): " + r.file; }
            if (it.kind === "icon") { return "- icon \"" + it.name + "\": " + r.file; }
            if (it.kind === "color") { return "- color \"" + it.name + "\" " + r.hex; }
            if (it.kind === "grad") { return "- gradient \"" + it.name + "\" " + r.from + " -> " + r.to + (r.type === "radial" ? " radial" : " linear " + r.angle + "deg"); }
            if (it.kind === "font") { return "- font for " + r.role + ": " + r.font; }
            return "- text \"" + it.name + "\": " + r.text;
        }).join("\n");
    }

    function brandMentionSwatch(it) {
        var sw = mkEl("i", "brand-mention-sw"), img;
        if ((it.kind === "logo" || it.kind === "icon") && LOGO_PREVIEW.test(it.ref.file)) {
            img = mkEl("img"); img.alt = ""; img.src = fileUrl(it.ref.file); sw.appendChild(img);
        } else if (it.kind === "color") {
            sw.style.background = it.ref.hex;
        } else if (it.kind === "grad") {
            sw.style.background = gradientCss(it.ref);
        } else {
            sw.textContent = it.kind === "font" ? "Aa" : it.kind === "text" ? "T" : "◆";
        }
        return sw;
    }

    // ---- список по «@»
    var mention = null;        // { start, query, list, index }

    function mentionQuery() {
        var pos = ui.prompt.selectionStart, before = ui.prompt.value.substring(0, pos), m;
        if (ui.prompt.selectionEnd !== pos) { return null; }
        m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
        return m ? { start: pos - m[2].length - 1, query: m[2] } : null;
    }

    function renderMention() {
        var q = mentionQuery(), b = activeBrand(), box = ui.mentionList, list, nq;
        if (!q || !b) { closeMention(); return; }
        nq = normTxt(q.query);
        list = brandItems(b).filter(function (it) {
            return !nq || normTxt(it.name).indexOf(nq) >= 0 || normTxt(BRAND_KIND_RU[it.kind]).indexOf(nq) === 0 || normTxt(it.extra).indexOf(nq) >= 0;
        }).slice(0, 8);
        mention = { start: q.start, query: q.query, list: list, index: mention && mention.query === q.query ? Math.min(mention.index, Math.max(0, list.length - 1)) : 0 };
        box.innerHTML = "";
        if (!list.length) {
            box.appendChild(mkEl("div", "mention-empty", brandItems(b).length ? "В брендбуке «" + b.name + "» нет такого. Продолжайте писать или нажмите Esc." : "Брендбук «" + b.name + "» пока пуст: добавьте логотипы и цвета во вкладке «Проекты»."));
        }
        list.forEach(function (it, i) {
            var row = mkEl("button", "mention-row");
            row.type = "button";
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", i === mention.index ? "true" : "false");
            row.appendChild(brandMentionSwatch(it));
            row.appendChild(mkEl("b", "", it.name));
            row.appendChild(mkEl("small", "", BRAND_KIND_RU[it.kind] + (it.extra && it.kind !== "text" ? " · " + it.extra : "")));
            row.addEventListener("mousedown", function (e) { e.preventDefault(); });
            row.addEventListener("click", function () { pickMention(i); });
            box.appendChild(row);
        });
        box.hidden = false;
    }

    function closeMention() {
        mention = null;
        ui.mentionList.hidden = true;
        ui.mentionList.innerHTML = "";
    }

    function pickMention(i) {
        var m = mention, it, v, ins;
        if (!m || !m.list[i]) { return; }
        it = m.list[i];
        v = ui.prompt.value;
        ins = "@" + it.name + " ";
        ui.prompt.value = v.substring(0, m.start) + ins + v.substring(m.start + 1 + m.query.length);
        ui.prompt.selectionStart = ui.prompt.selectionEnd = m.start + ins.length;
        delete brandOff[it.key];
        closeMention();
        ui.prompt.focus();
        renderBrandHits();
    }

    function initMentions() {
        var t = 0;
        ui.prompt.addEventListener("input", function () {
            renderMention();
            clearTimeout(t);
            t = setTimeout(renderBrandHits, 150);
        });
        ui.prompt.addEventListener("click", renderMention);
        ui.prompt.addEventListener("blur", function () { setTimeout(closeMention, 150); });
        ui.prompt.addEventListener("keydown", function (e) {
            if (!mention || ui.mentionList.hidden) { return; }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!mention.list.length) { return; }
                mention.index = (mention.index + (e.key === "ArrowDown" ? 1 : -1) + mention.list.length) % mention.list.length;
                Array.prototype.forEach.call(ui.mentionList.querySelectorAll(".mention-row"), function (r, i) { r.setAttribute("aria-selected", i === mention.index ? "true" : "false"); });
            } else if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey && mention.list.length) {
                e.preventDefault();
                pickMention(mention.index);
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeMention();
            }
        });
    }

    // Маленькие картинки упомянутых логотипов и иконок для AI (настройка «AI видит упомянутые логотипы»).
    async function brandPictures(hits) {
        var out = [], i, it, data, img, c, k, ext;
        for (i = 0; i < hits.length && out.length < 4; i++) {
            it = hits[i].item;
            if ((it.kind !== "logo" && it.kind !== "icon") || !LOGO_PREVIEW.test(it.ref.file)) { continue; }
            try {
                ext = (it.ref.file.match(/\.([a-z0-9]+)$/i) || ["", "png"])[1].toLowerCase();
                data = await platform.readBase64(it.ref.file);
                img = await coImage("data:" + (ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : "image/" + ext) + ";base64," + data);
                k = Math.min(1, 256 / Math.max(img.naturalWidth || 256, img.naturalHeight || 256));
                c = coCanvas(Math.max(1, Math.round((img.naturalWidth || 256) * k)), Math.max(1, Math.round((img.naturalHeight || 256) * k)));
                c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
                out.push({ item: it, data: c.toDataURL("image/png").replace(/^data:image\/png;base64,/, "") });
            } catch (e) {}
        }
        return out;
    }

    // Ряд «Стиль:» над полем AI. Выбор запоминается и действует на все запросы.
    function renderMotionStyles() {
        Array.prototype.forEach.call(ui.styleRow.querySelectorAll(".style-chip"), function (b) {
            b.setAttribute("aria-checked", b.getAttribute("data-style") === settings.motionStyle ? "true" : "false");
        });
    }
    function initMotionStyles() {
        MOTION_STYLES.forEach(function (st) {
            var b = mkEl("button", "style-chip", st.label);
            b.type = "button";
            b.setAttribute("role", "radio");
            b.setAttribute("data-style", st.id);
            b.title = st.id === "normal" ? "Без особого стиля: аккуратные плавности и очерёдность" : "Стиль движения: " + st.label.toLowerCase();
            b.addEventListener("click", function () {
                settings.motionStyle = st.id;
                storeSettings(settings);
                renderMotionStyles();
                setStatus(st.id === "normal" ? "Стиль анимации: обычный." : "Стиль анимации: «" + st.label + "» — для всех следующих запросов.", "");
            });
            ui.styleRow.appendChild(b);
        });
        renderMotionStyles();
    }

    function initBrand() {
        initBrandOrder();
        initMentions();
        ui.brandNew.addEventListener("click", function () { brandAskName("new"); });
        ui.brandFirst.addEventListener("click", function () { brandAskName("new"); });
        ui.brandRename.addEventListener("click", function () { if (activeBrand()) { brandAskName("rename"); } });
        ui.brandDelete.addEventListener("click", brandDelete);
        ui.brandNameOk.addEventListener("click", function () { brandNameDone(true); });
        ui.brandNameCancel.addEventListener("click", function () { brandNaming = null; renderBrand(); });
        ui.brandName.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); brandNameDone(true); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); brandNaming = null; renderBrand(); }
        });
        ui.brandSelect.addEventListener("change", function () { var g = activeProject(); if (g) { g.active = ui.brandSelect.value; } brandDelAt = 0; storeBrands(); renderBrand(); });
        ui.brandLogoAdd.addEventListener("click", brandAddLogo);
        ui.brandIconAdd.addEventListener("click", brandAddIcons);
        ui.brandExport.addEventListener("click", brandExport);
        ui.brandImport.addEventListener("click", brandImport);
        ui.brandFirstImport.addEventListener("click", brandImport);
        ui.brandAskUpdate.addEventListener("click", function () { brandAnswer("update"); });
        ui.brandAskCopy.addEventListener("click", function () { brandAnswer("copy"); });
        ui.brandAskCancel.addEventListener("click", function () { brandAnswer("cancel"); });
        ui.brandColorPick.addEventListener("input", function () { ui.brandColorHex.value = ui.brandColorPick.value; });
        ui.brandColorHex.addEventListener("input", function () { var c = parseHex(ui.brandColorHex.value); if (c) { ui.brandColorPick.value = c.hex; } });
        ui.brandColorAdd.addEventListener("click", function () {
            var b = activeBrand();
            var c = parseHex(ui.brandColorHex.value);
            if (!b) { return; }
            if (!c) { setStatus("Цвет нужен в виде hex-кода, например #ff5a1f.", ""); ui.brandColorHex.focus(); return; }
            if (b.colors.length >= BRAND_MAX.colors) { setStatus("В проекте уже " + BRAND_MAX.colors + " цветов.", ""); return; }
            b.colors.push({ name: brandStr(ui.brandColorName.value, 30) || "Цвет " + (b.colors.length + 1), hex: c.hex });
            ui.brandColorName.value = "";
            storeBrands();
            renderBrand();
        });
        ui.brandColorName.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); ui.brandColorAdd.click(); } });
        ui.brandRigBtn.addEventListener("click", brandRig);
        [ui.brandGradFrom, ui.brandGradTo, ui.brandGradType, ui.brandGradAngle].forEach(function (x) {
            x.addEventListener("input", brandGradPreview);
            x.addEventListener("change", brandGradPreview);
        });
        [ui.brandGradFrom, ui.brandGradTo].forEach(function (x) {
            x.addEventListener("input", function () { brandGradTouched = true; });
        });
        ui.brandGradAdd.addEventListener("click", function () {
            var b = activeBrand(), g = brandGradForm();
            if (!b || !g) { return; }
            if (b.gradients.length >= BRAND_MAX.gradients) { setStatus("В проекте уже " + BRAND_MAX.gradients + " градиентов.", ""); return; }
            if (!brandStr(ui.brandGradName.value, 30)) { g.name = "Градиент " + (b.gradients.length + 1); }
            b.gradients.push(g);
            ui.brandGradName.value = "";
            storeBrands();
            renderBrand();
        });
        ui.brandGradName.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); ui.brandGradAdd.click(); } });
        [["head", ui.brandFontHead], ["body", ui.brandFontBody]].forEach(function (f) {
            f[1].addEventListener("change", function () { var b = activeBrand(); if (b) { b.fonts[f[0]] = brandStr(f[1].value, 120); storeBrands(); } });
            f[1].addEventListener("focus", brandLoadFonts);
        });
        ui.brandFontHeadApply.addEventListener("click", function (e) { e.preventDefault(); brandApplyFont("head"); });
        ui.brandFontBodyApply.addEventListener("click", function (e) { e.preventDefault(); brandApplyFont("body"); });
        ui.brandTextAdd.addEventListener("click", function () {
            var b = activeBrand();
            var text = brandStr(ui.brandTextValue.value, 300);
            if (!b) { return; }
            if (!text) { ui.brandTextValue.focus(); return; }
            if (b.texts.length >= BRAND_MAX.texts) { setStatus("В проекте уже " + BRAND_MAX.texts + " текстов.", ""); return; }
            b.texts.push({ name: brandStr(ui.brandTextName.value, 30), text: text });
            ui.brandTextName.value = "";
            ui.brandTextValue.value = "";
            storeBrands();
            renderBrand();
        });
        ui.brandTextValue.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); ui.brandTextAdd.click(); } });
        ui.brandFormats.addEventListener("click", function (e) {
            var btn = e.target && e.target.closest ? e.target.closest("button[data-w]") : null;
            if (btn) { brandMakeComp(Number(btn.getAttribute("data-w")), Number(btn.getAttribute("data-h"))); }
        });
        renderBrand();
    }

    // Замечания вроде «ничего не выделено» — подсказка, а не ошибка.
    // ------------------------------------------------------------ Без фона (Cut out)
    // Фото выделенного слоя открывается в окне панели. На Mac (macOS 14+) объекты на фото находит сама система
    // (Vision): щелчок выбирает объект целиком. Иначе — GrabCut из js/cutout.js: щелчки «оставить»/«убрать»
    // и рамка кадра задают объект и фон. Кисти «Оставить» и «Убрать» поправляют результат в обоих случаях.
    // «Готово» — PNG с прозрачным фоном рядом с проектом, в окне Project — в папке «Cutouts».

    var CO_BROWSER_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
    var CO_PROC_MAX = 2048;      // маска считается не крупнее этого, потом растягивается на всё фото
    var CO_DISP_MAX = 1400;
    var CO_BIN = "Cutouts";
    var co = null;

    function coEngine() { return window.SayframeCutout; }

    function coImage(src) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error("CO_FORMAT")); };
            img.src = src;
        });
    }

    function coMime(path) {
        var m = /\.([a-z0-9]+)$/i.exec(path), e = m ? m[1].toLowerCase() : "png";
        return "image/" + (e === "jpg" ? "jpeg" : e);
    }

    // Фото → картинка в панели. Чего браузер не читает (PSD, TIFF, HEIC…), сначала переводится в PNG:
    // на Mac — системной sips, на Windows — через .NET (TIFF, BMP).
    async function coLoadPhoto(path, tmp) {
        var src = path, out, r;
        if (!CO_BROWSER_EXT.test(path)) {
            out = platform.join(tmp, "photo.png");
            if (platform.isWindows()) {
                r = await platform.exec("powershell", ["-NoProfile", "-Command",
                    "Add-Type -AssemblyName System.Drawing; [System.Drawing.Image]::FromFile($args[0]).Save($args[1], [System.Drawing.Imaging.ImageFormat]::Png)", path, out], 60000);
            } else {
                r = await platform.exec("sips", ["-s", "format", "png", path, "--out", out], 60000);
            }
            if (r.code !== 0 || !(await platform.exists(out))) { throw new Error("CO_FORMAT"); }
            src = out;
        }
        return coImage("data:" + coMime(src) + ";base64," + (await platform.readBase64(src)));
    }

    function coCanvas(w, h) {
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        return c;
    }

    // Картинка → RGBA размером w×h.
    function coPixels(img, w, h) {
        var c = coCanvas(w, h), g = c.getContext("2d");
        g.drawImage(img, 0, 0, w, h);
        return g.getImageData(0, 0, w, h).data;
    }

    // Маска-картинка (белое — объект) → Float32Array w×h.
    function coMaskField(img, w, h) {
        var px = coPixels(img, w, h), out = new Float32Array(w * h), i;
        for (i = 0; i < w * h; i++) { out[i] = px[i * 4] / 255 * (px[i * 4 + 3] / 255); }
        return out;
    }

    function coFit(w, h, max) {
        var k = Math.min(1, max / Math.max(w, h));
        return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
    }

    function coSetNote(text) { ui.cutoutNote.textContent = text || ""; }

    function coShowBusy(text) {
        ui.cutoutBusy.textContent = text || "Считаю…";
        ui.cutoutBusy.hidden = !text;
    }

    // Даёт окну перерисоваться перед долгим расчётом.
    function coBreath() { return new Promise(function (r) { setTimeout(r, 30); }); }

    async function onCutout() {
        var src, tmp, img, E = coEngine();
        if (busy || co) { return; }
        if (!E) { setStatus("Не загрузилась часть панели для вырезания фона (js/cutout.js). Переустановите Sayframe.", "error"); return; }
        setBusy(true);
        setStatus("Открываю фото…", "busy");
        try {
            src = await host("cutoutSource", []);
            tmp = platform.join(platform.tmpdir(), "sayframe-cutout-" + Date.now());
            await platform.mkdirp(tmp);
            img = await coLoadPhoto(src.path, tmp);
        } catch (e) {
            toolFailed(e);
            return;
        }
        co = { src: src, tmp: tmp, img: img, W: img.naturalWidth, H: img.naturalHeight, engine: "js",
            masks: [], sel: [], marks: [], hist: [], coarse: null, tool: "pick", stroke: null, seq: 0 };
        co.proc = coFit(co.W, co.H, CO_PROC_MAX);
        co.proc.rgba = coPixels(img, co.proc.w, co.proc.h);
        setBusy(false);
        setStatus(src.many ? "Cut out: взят верхний из выделенных слоёв — «" + src.layer + "»." : "", "");
        ui.cutoutName.textContent = src.layer;
        ui.cutoutName.title = src.path;
        coSetTool("pick");
        ui.cutoutView.hidden = false;
        coLayout();
        coRender();
        if (isMac()) {
            await coVision();
        } else {
            coSetNote("Щёлкните по тому, что нужно оставить. Alt+щелчок — убрать лишнее. Кистями «Оставить» и «Убрать» поправьте край.");
        }
    }

    // macOS сама находит объекты на фото. Не вышло — работает GrabCut, окно об этом пишет.
    async function coVision() {
        var c = co, js, res, n, i, img, out = [], r;
        coShowBusy("Ищу объекты на фото…");
        try {
            js = platform.join(c.tmp, "vision.js");
            res = platform.join(c.tmp, "vision.txt");
            await platform.writeText(js, JXA_VISION);
            r = await platform.exec("osascript", ["-l", "JavaScript", js, c.src.path, c.tmp, res], 90000);
            r = (await platform.exists(res)) ? String(await platform.readText(res)).trim() : "ERR " + (r.stderr || r.code);
            if (c !== co) { return; }
            if (/^OK \d+$/.test(r)) {
                n = Number(r.split(" ")[1]);
                for (i = 0; i < n; i++) {
                    img = await coImage("data:image/png;base64," + (await platform.readBase64(platform.join(c.tmp, "mask-" + i + ".png"))));
                    // Маска должна совпасть с фото по пропорциям (иначе фото повёрнуто, например по EXIF).
                    if (Math.abs(img.naturalWidth / img.naturalHeight - c.W / c.H) > 0.02) { throw new Error("CO_MASK_SHAPE"); }
                    out.push(img);
                }
            } else if (r === "NOVISION") {
                out = null;
            } else {
                throw new Error(r);
            }
        } catch (e) {
            out = null;
            r = String(e && e.message ? e.message : e).replace(/^ERR\s*/, "");
        }
        if (c !== co) { return; }
        coShowBusy("");
        if (out && out.length) {
            c.engine = "vision";
            c.masks = out.map(function (m) { return { img: m, proc: coMaskField(m, c.proc.w, c.proc.h), disp: null }; });
            coLayout();
            coSetNote("Нашлось объектов: " + out.length + ". Щёлкните по тому, что оставить (можно по нескольким). Alt+щелчок — убрать объект. Кисти «Оставить» и «Убрать» поправят край.");
        } else if (out) {
            coSetNote("macOS не нашла на фото отдельных объектов. Щёлкните по тому, что оставить, — панель отделит его по цветам. Alt+щелчок — убрать лишнее.");
        } else if (r === "NOVISION") {
            coSetNote("Щёлкните по тому, что нужно оставить. Alt+щелчок — убрать лишнее. (Выбор объекта целиком работает на macOS 14 и новее.)");
        } else {
            coSetNote("Встроенное выделение macOS не сработало (" + String(r).slice(0, 120) + "). Щёлкните по тому, что оставить, — панель отделит его по цветам.");
        }
        coRender();
    }

    // Размер холста под окно: фото целиком, чётко на Retina.
    function coLayout() {
        var c = co, st = ui.cutoutStage, dpr = Math.min(2, window.devicePixelRatio || 1), sw, sh, k, d;
        if (!c) { return; }
        sw = Math.max(80, st.clientWidth); sh = Math.max(80, st.clientHeight);
        k = Math.min(sw / c.W, sh / c.H);
        ui.cutoutCanvas.style.width = Math.round(c.W * k) + "px";
        ui.cutoutCanvas.style.height = Math.round(c.H * k) + "px";
        d = coFit(c.W, c.H, Math.min(CO_DISP_MAX, Math.round(Math.max(c.W, c.H) * k * dpr)));
        if (!c.disp || c.disp.w !== d.w || c.disp.h !== d.h) {
            c.disp = d;
            c.disp.rgba = coPixels(c.img, d.w, d.h);
            ui.cutoutCanvas.width = d.w; ui.cutoutCanvas.height = d.h;
            c.masks.forEach(function (m) { m.disp = null; });
        }
        c.masks.forEach(function (m) { if (!m.disp) { m.disp = coMaskField(m.img, c.disp.w, c.disp.h); } });
    }

    function coEdge() { return Number(ui.cutoutEdge.value) || 0; }

    function coHasKeep() {
        return co.sel.length > 0 || co.marks.some(function (m) { return m.v > 0; });
    }

    // Маска размером w×h (rgba — фото того же размера, fields — маски объектов в том же размере).
    function coAlpha(w, h, rgba, field) {
        var E = coEngine(), c = co, out, i, j, user;
        if (!coHasKeep()) { return null; }
        if (c.engine === "js") {
            if (!c.coarse) { return null; }
            return E.refine(rgba, w, h, c.coarse.alpha, c.coarse.w, c.coarse.h, c.marks, coEdge());
        }
        out = new Float32Array(w * h);
        for (j = 0; j < c.sel.length; j++) {
            for (i = 0; i < w * h; i++) { if (field(c.sel[j])[i] > out[i]) { out[i] = field(c.sel[j])[i]; } }
        }
        if (c.marks.length) {
            user = E.paintMarks(c.marks, w, h);
            for (i = 0; i < w * h; i++) { if (user[i] > 0) { out[i] = 1; } else if (user[i] < 0) { out[i] = 0; } }
        }
        return coEdge() > 0 ? E.feather(out, w, h, coEdge() * Math.max(w, h) / 1000) : out;
    }

    // Фото на шахматке: объект ярко, убранный фон — шахматкой. Метки кисти — полупрозрачным цветом.
    function coRender() {
        var c = co, d, g, data, a, i, x, y, ch, k, m, j, L;
        if (!c || !c.disp) { return; }
        d = c.disp;
        g = ui.cutoutCanvas.getContext("2d");
        a = coAlpha(d.w, d.h, d.rgba, function (n) { return c.masks[n].disp; });
        data = g.createImageData(d.w, d.h);
        for (y = 0; y < d.h; y++) {
            for (x = 0; x < d.w; x++) {
                i = y * d.w + x; k = i * 4;
                ch = ((x >> 3) + (y >> 3)) & 1 ? 58 : 38;
                if (!a) {
                    data.data[k] = d.rgba[k]; data.data[k + 1] = d.rgba[k + 1]; data.data[k + 2] = d.rgba[k + 2];
                } else {
                    data.data[k] = d.rgba[k] * a[i] + ch * (1 - a[i]);
                    data.data[k + 1] = d.rgba[k + 1] * a[i] + ch * (1 - a[i]);
                    data.data[k + 2] = d.rgba[k + 2] * a[i] + ch * (1 - a[i]);
                }
                data.data[k + 3] = 255;
            }
        }
        g.putImageData(data, 0, 0);
        L = Math.max(d.w, d.h);
        g.lineCap = "round"; g.lineJoin = "round";
        for (j = 0; j < c.marks.length + (c.stroke ? 1 : 0); j++) {
            m = j < c.marks.length ? c.marks[j] : c.stroke;
            g.globalAlpha = m.pts.length === 2 ? 0.9 : 0.35;
            g.strokeStyle = g.fillStyle = m.v > 0 ? "#7be3a7" : "#ff7d8e";
            if (m.pts.length === 2) {
                g.beginPath(); g.arc(m.pts[0] * d.w, m.pts[1] * d.h, Math.max(3, m.r * L * 0.6), 0, Math.PI * 2); g.fill();
                g.globalAlpha = 1; g.lineWidth = 1.5; g.strokeStyle = "#0b0c12"; g.stroke();
            } else {
                g.lineWidth = Math.max(2, m.r * L * 2);
                g.beginPath(); g.moveTo(m.pts[0] * d.w, m.pts[1] * d.h);
                for (k = 2; k < m.pts.length; k += 2) { g.lineTo(m.pts[k] * d.w, m.pts[k + 1] * d.h); }
                g.stroke();
            }
        }
        g.globalAlpha = 1;
    }

    // GrabCut заново (только для режима без macOS): по всем меткам.
    async function coSolve() {
        var c = co, seq = ++c.seq, E = coEngine(), r;
        if (c.engine !== "js") { coRender(); return; }
        if (!c.marks.some(function (m) { return m.v > 0; })) { c.coarse = null; coRender(); return; }
        coShowBusy("Считаю…");
        await coBreath();
        if (c !== co || seq !== c.seq) { return; }
        r = E.solve(c.proc.rgba, c.proc.w, c.proc.h, c.marks);
        if (c !== co || seq !== c.seq) { return; }
        c.coarse = r;
        coShowBusy("");
        coRender();
    }

    function coRemember() {
        co.hist.push({ marks: co.marks.slice(), sel: co.sel.slice() });
        if (co.hist.length > 60) { co.hist.shift(); }
    }

    function coChanged() { if (co.engine === "js") { coSolve(); } else { coRender(); } }

    function coSetTool(t) {
        if (co) { co.tool = t; }
        Array.prototype.forEach.call(ui.cutoutView.querySelectorAll(".cutout-tool"), function (b) {
            b.setAttribute("aria-pressed", b.getAttribute("data-co-tool") === t ? "true" : "false");
        });
    }

    function coPoint(e) {
        var r = ui.cutoutCanvas.getBoundingClientRect();
        return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    }

    function coBrushR() { return Number(ui.cutoutBrush.value) * 0.006; }

    // Щелчок «Объект»: на Mac — выбрать или убрать объект, найденный системой; иначе — точка-подсказка для GrabCut.
    function coPick(pt, remove) {
        var c = co, d = c.disp, x = Math.min(d.w - 1, Math.floor(pt[0] * d.w)), y = Math.min(d.h - 1, Math.floor(pt[1] * d.h)), hit = [], i;
        if (c.engine === "vision") {
            for (i = 0; i < c.masks.length; i++) { if (c.masks[i].disp[y * d.w + x] > 0.5) { hit.push(i); } }
            if (!hit.length) {
                coSetNote(remove ? "Здесь и так фон. Чтобы убрать кусок объекта, закрасьте его кистью «Убрать»."
                    : "Здесь macOS объекта не нашла. Закрасьте нужное кистью «Оставить».");
                return;
            }
            coRemember();
            if (remove) {
                c.sel = c.sel.filter(function (n) { return hit.indexOf(n) < 0; });
            } else {
                hit.forEach(function (n) { if (c.sel.indexOf(n) < 0) { c.sel.push(n); } });
            }
            coSetNote("");
            coRender();
            return;
        }
        coRemember();
        c.marks.push({ v: remove ? -1 : 1, r: 0.012, pts: [pt[0], pt[1]] });
        coChanged();
    }

    async function coDone() {
        var c = co, E = coEngine(), p = c.proc, a, mask, mg, md, i, full, fg, blob, bytes, dir, name, file, res, mode;
        if (!coHasKeep() || (c.engine === "js" && !c.coarse)) { coSetNote("Сначала щёлкните по тому, что нужно оставить."); return; }
        mode = ui.cutoutView.querySelector('input[name="cutoutMode"]:checked').value;
        ui.cutoutDone.disabled = true;
        coShowBusy("Сохраняю…");
        await coBreath();
        try {
            a = coAlpha(p.w, p.h, p.rgba, function (n) { return c.masks[n].proc; });
            mask = coCanvas(p.w, p.h); mg = mask.getContext("2d"); md = mg.createImageData(p.w, p.h);
            for (i = 0; i < p.w * p.h; i++) {
                md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = 255;
                md.data[i * 4 + 3] = Math.round(a[i] * 255);
            }
            mg.putImageData(md, 0, 0);
            full = coCanvas(c.W, c.H); fg = full.getContext("2d");
            fg.drawImage(c.img, 0, 0);
            fg.globalCompositeOperation = "destination-in";
            fg.imageSmoothingEnabled = true;
            fg.drawImage(mask, 0, 0, c.W, c.H);
            blob = await new Promise(function (resolve) { full.toBlob(resolve, "image/png"); });
            if (!blob) { throw new Error("CO_NOT_SAVED"); }
            bytes = await new Promise(function (resolve, reject) {
                var fr = new FileReader();
                fr.onload = function () { resolve(new Uint8Array(fr.result)); };
                fr.onerror = function () { reject(new Error("CO_NOT_SAVED")); };
                fr.readAsArrayBuffer(blob);
            });
            dir = c.src.dir ? platform.join(c.src.dir, "Sayframe Cutouts") : platform.join(platform.homedir(), "Documents", "Sayframe Cutouts");
            await platform.mkdirp(dir);
            name = String(c.src.item).replace(/\.[A-Za-z0-9]+$/, "").replace(/[\\\/:*?"<>|]+/g, "_").slice(0, 60) || "photo";
            file = platform.join(dir, name + " cutout " + coStamp() + ".png");
            try { await platform.writeBytes(file, bytes); } catch (e1) { throw new Error("CO_NOT_SAVED"); }
            res = await host("cutoutApply", [file, c.src.index, mode, CO_BIN, c.src.layer + " (без фона)"]);
        } catch (e) {
            if (co !== c) { return; }
            ui.cutoutDone.disabled = false;
            coShowBusy("");
            coSetNote(humanError(e));
            return;
        }
        coClose();
        setStatus(res.mode === "above"
            ? "Готово: вырезанное фото — новым слоем «" + res.layer + "» над «" + res.original + "», оригинал выключен. PNG — в папке «" + CO_BIN + "» проекта. Отменить — Cmd/Ctrl+Z."
            : "Готово: на слое «" + res.layer + "» теперь фото без фона. PNG — в папке «" + CO_BIN + "» проекта, оригинал остался в проекте. Отменить — Cmd/Ctrl+Z.", "done");
    }

    function coStamp() {
        var d = new Date();
        function two(n) { return (n < 10 ? "0" : "") + n; }
        return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + "-" + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
    }

    function coClose() {
        var c = co;
        if (!c) { return; }
        co = null;
        ui.cutoutView.hidden = true;
        ui.cutoutDone.disabled = false;
        coShowBusy("");
        coSetNote("");
        ["vision.js", "vision.txt", "photo.png"].concat(c.masks.map(function (m, i) { return "mask-" + i + ".png"; })).forEach(function (f) {
            platform.remove(platform.join(c.tmp, f));
        });
    }

    function coUndo() {
        var h;
        if (!co || !co.hist.length) { return; }
        h = co.hist.pop();
        co.marks = h.marks; co.sel = h.sel;
        if (!co.marks.some(function (m) { return m.v > 0; })) { co.coarse = null; }
        coChanged();
    }

    function enableCutout() {
        var cv = ui.cutoutCanvas, down = null, resizeT = 0;
        ui.cutoutClose.addEventListener("click", coClose);
        ui.cutoutDone.addEventListener("click", function () { if (co) { coDone(); } });
        ui.cutoutUndo.addEventListener("click", coUndo);
        ui.cutoutReset.addEventListener("click", function () {
            if (!co || (!co.marks.length && !co.sel.length)) { return; }
            coRemember();
            co.marks = []; co.sel = []; co.coarse = null;
            coRender();
        });
        ui.cutoutEdge.addEventListener("input", function () { if (co) { coRender(); } });
        Array.prototype.forEach.call(ui.cutoutView.querySelectorAll(".cutout-tool"), function (b) {
            b.addEventListener("click", function () { coSetTool(b.getAttribute("data-co-tool")); });
        });
        // Мышь, а не pointer events: в самом After Effects события указателя в панели срабатывают ненадёжно.
        cv.addEventListener("mousedown", function (e) {
            var pt;
            if (!co || e.button === 1) { return; }
            e.preventDefault();
            pt = coPoint(e);
            down = { pt: pt, remove: e.altKey || e.button === 2 || co.tool === "drop" };
            if (co.tool !== "pick") {
                co.stroke = { v: co.tool === "keep" ? 1 : -1, r: coBrushR(), pts: [pt[0], pt[1], pt[0], pt[1]] };
                coRender();
            }
        });
        document.addEventListener("mousemove", function (e) {
            var pt, s;
            if (!co || !down || !co.stroke) { return; }
            pt = coPoint(e); s = co.stroke.pts;
            if (Math.hypot(pt[0] - s[s.length - 2], pt[1] - s[s.length - 1]) < 0.004) { return; }
            s.push(pt[0], pt[1]);
            coRender();
        });
        document.addEventListener("mouseup", function () {
            var d = down;
            down = null;
            if (!co || !d) { return; }
            if (co.stroke) {
                coRemember();
                co.marks.push(co.stroke);
                co.stroke = null;
                coChanged();
                return;
            }
            coPick(d.pt, d.remove);
        });
        cv.addEventListener("contextmenu", function (e) { e.preventDefault(); });
        document.addEventListener("keydown", function (e) {
            if (!co) { return; }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); coClose(); return; }
            if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.stopPropagation(); coUndo(); }
        }, true);
        window.addEventListener("resize", function () {
            clearTimeout(resizeT);
            resizeT = setTimeout(function () { if (co) { coLayout(); coRender(); } }, 120);
        });
    }

    function toolFailed(e) {
        var m = e && e.message ? e.message : String(e);
        var hint = m === "NO_ACTIVE_COMP" || m === "NO_KEYS_SELECTED" || m === "NO_LAYERS_SELECTED" || m === "DC_NO_PRECOMP" || m === "CO_NOT_PHOTO" || m === "CO_NOT_STILL" || m === "BR_NO_TEXT" || m === "ALIGN_NEEDS_TWO" || m === "DISTRIBUTE_NEEDS_THREE" || m === "STAGGER_NEEDS_TWO" || m === "STAGGER_NO_KEYS";
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
        return Array.prototype.slice.call(G.el.querySelectorAll(".tool-card"));
    }

    function toolOf(node) {
        while (node && node !== G.el) {
            if (node.getAttribute && node.getAttribute("data-tool")) { return node; }
            node = node.parentNode;
        }
        return null;
    }

    function cardByName(name) {
        return G.el.querySelector('.tool-card[data-tool="' + name + '"]');
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
        var width = G.el.clientWidth;
        if (!width) { return 0; }
        return Math.max(1, Math.floor((width + m.gap) / (m.cell + m.gap)));
    }

    // G.last — как блоки этой сетки стоят сейчас: { cols, step, pos: { name: { x, y, w, h } }, need, pinRows }

    // Раскладывает блоки по сетке. places — места блоков (или null: по порядку, с переносом),
    // first — блок, который при споре за клетку получает её (его тянут или растягивают).
    function layoutTools(places, first) {
        var m = gridModule();
        var step = m.cell + m.gap;
        var cols = gridCols();
        var names = G.st.order.split(",");
        var cards = {};
        var items = [];
        var taken = [];
        var pos = {};
        var pins = pinList();
        var i, it, card, z, h, rows, sorted, pinned, rest, base;

        if (!cols) { return null; }
        G.el.style.gridTemplateColumns = "repeat(" + cols + ", " + m.cell + "px)";
        G.el.style.gridAutoRows = m.cell + "px";
        G.el.style.gap = m.gap + "px";

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
        function freeSpot(top, w, h) {
            var mid = Math.max(0, Math.round((cols - w) / 2));
            var r, d, c;
            for (r = top; r < top + 2000; r++) {
                for (d = 0; d <= cols; d++) {
                    c = mid - d;
                    if (c >= 0 && c + w <= cols && free(r, c, w, h)) { return { r: r, c: c }; }
                    c = mid + d;
                    if (d && c + w <= cols && free(r, c, w, h)) { return { r: r, c: c }; }
                }
            }
            return { r: top, c: 0 };
        }

        function placeGroup(group, top) {
            var r, c, j, g, q, list, spot, bottom = top;
            var flow = !places;
            // Панель уже, чем раскладка: блоки идут рядами в том же порядке (сверху вниз, слева направо),
            // без дыр. Места не забываются — в широкой панели всё встанет как было.
            if (places && group.some(function (x) { var p = places[x.name]; return p && p.x + x.w > cols; })) {
                flow = true;
                group = group.slice().sort(function (a, b) {
                    var p = places[a.name], q2 = places[b.name];
                    if (!p || !q2) { return p ? -1 : q2 ? 1 : a.index - b.index; }
                    return p.y !== q2.y ? p.y - q2.y : p.x - q2.x;
                });
            }
            if (flow) {
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
                    if (g.free) {
                        // Новый блок (появился в новой версии): обычного размера, в первом свободном месте сверху,
                        // как можно ближе к середине панели.
                        spot = freeSpot(top, g.w, g.h);
                        take(g.name, spot.r, spot.c, g.w, g.h);
                        continue;
                    }
                    r = Math.max(top, Math.min(g.y, 999));
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
            // Блоки-кнопки, суженные меньше обычного, становятся квадратными иконками, как в шапке панели.
            if (ICON_TOOLS.indexOf(names[i]) >= 0 && it.w < TOOL_DEFAULT_COLS) {
                // Несколько иконок: в ряд, если блок для этого достаточно широкий (7 клеток), иначе столбиком.
                it.w = Math.min(iconCols(names[i], it.w), cols);
                card.setAttribute("data-icons", it.w >= ICON_ROW_COLS ? "row" : "col");
                card.style.setProperty("--kz", String(blockZoom(TOOL_DEFAULT_COLS, m)));
            } else {
                card.removeAttribute("data-icons");
                card.style.setProperty("--kz", String(blockZoom(it.w, m)));
            }
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
        // Под закреплёнными — два пустых ряда мелкой сетки, посередине линия: так она не липнет к блокам.
        placeGroup(rest, pinned.length && rest.length ? base + 2 : base);

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
        G.cells.style.width = (cols * step - m.gap) + "px";
        G.cells.style.height = (h * step - m.gap) + "px";
        G.cells.style.backgroundSize = step + "px " + step + "px";
        G.cells.style.backgroundImage = 'url("data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="' + step + '" height="' + step + '"><rect x="0.5" y="0.5" width="' + (m.cell - 1) +
            '" height="' + (m.cell - 1) + '" rx="' + Math.round(m.cell / 5) + '" fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.13)" stroke-dasharray="3 3"/></svg>') + '")';
        if (pinned.length && rest.length) {
            G.line.hidden = false;
            G.line.style.top = Math.round(base * step + step - m.gap / 2) + "px";
            G.line.style.width = (cols * step - m.gap) + "px";
        } else {
            G.line.hidden = true;
        }
        G.last = { cols: cols, step: step, pos: pos, need: {}, pinRows: pinned.length ? base : 0 };
        for (i = 0; i < items.length; i++) { G.last.need[items[i].name] = items[i].need; }
        return G.last;
    }

    // Порядок блоков в документе меняется, только если он правда другой; фокус при этом не теряется.
    function reorderCards(sorted, cards) {
        var now = toolCards();
        var same = now.length === sorted.length;
        var active = document.activeElement;
        var i;
        for (i = 0; same && i < now.length; i++) { same = now[i] === cards[sorted[i].name]; }
        if (same) { return; }
        for (i = 0; i < sorted.length; i++) { G.el.appendChild(cards[sorted[i].name]); }
        if (active && active !== document.body && G.el.contains(active) && document.activeElement !== active) {
            try { active.focus(); } catch (e) {}
        }
    }

    function placesNow() {
        return G.st.places ? parsePlaces(G.st.places) : null;
    }

    var toolGridReady = false;

    var GRIDS = [];   // все сетки блоков: «Инструменты» и «Шейп»

    function relayoutTools() {
        var keep = G;
        if (!toolGridReady) { return; }
        GRIDS.forEach(function (g) { G = g; layoutTools(placesNow(), null); });
        G = keep;
    }

    // Запоминает, где блоки стоят сейчас: с этого момента они держат свои клетки.
    function storeLayout(fixed) {
        var names = [];
        var cards = toolCards();
        var places = {};
        var i, q;
        for (i = 0; i < cards.length; i++) { names.push(cards[i].getAttribute("data-tool")); }
        G.st.order = cleanToolOrder(names.join(","));
        if (fixed && G.last) {
            for (i = 0; i < G.names.length; i++) {
                q = G.last.pos[G.names[i]];
                if (q) { places[G.names[i]] = { x: q.x, y: q.y }; }
            }
            G.st.places = placesText(places);
        }
        G.store();
    }

    // Где блоки стоят сейчас, с размерами: { name: { x, y, w, h } }.
    function currentPlaces() {
        var out = {};
        var i, q;
        for (i = 0; i < G.names.length; i++) {
            q = G.last && G.last.pos[G.names[i]];
            if (q) { out[G.names[i]] = { x: q.x, y: q.y, w: q.w, h: q.h }; }
        }
        return out;
    }

    // Ставит блок на клетку (x, y) и раскладывает остальные. Блок, на чьё место он встал,
    // переходит на освободившееся место — блоки меняются местами. Возвращает, где блок оказался.
    function moveToolTo(name, x, y, base, swap) {
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
                places[k] = swap ? { x: swap.x, y: swap.y } : { x: me.x, y: me.y };
            }
        }
        places[name] = { x: x, y: y };
        G.st.places = placesText(places);
        return layoutTools(places, name).pos[name];
    }

    // Клавиатура: блок на клетку в любую сторону; если там другой блок — они меняются местами.
    function nudgeTool(card, dx, dy) {
        var name = card.getAttribute("data-tool");
        var base, me, tx, ty, k, o, now, swap = null;
        if (!G.last) { return false; }
        base = currentPlaces();
        me = base[name];
        tx = me.x + dx;
        ty = me.y + dy;
        if (tx < 0 || ty < 0 || tx + me.w > G.last.cols) { return false; }
        for (k in base) {
            if (!base.hasOwnProperty(k) || k === name) { continue; }
            o = base[k];
            if (tx < o.x + o.w && o.x < tx + me.w && ty < o.y + o.h && o.y < ty + me.h) {
                // Соседи меняются местами вплотную, даже если они разного размера: без щели между ними.
                if (dx < 0) { tx = o.x; swap = { x: o.x + me.w, y: o.y }; }
                if (dx > 0) { tx = Math.min(me.x + o.w, G.last.cols - me.w); swap = { x: me.x, y: o.y }; }
                if (dy < 0) { ty = o.y; swap = { x: o.x, y: o.y + me.h }; }
                if (dy > 0) { ty = me.y + o.h; swap = { x: o.x, y: me.y }; }
                break;
            }
        }
        now = moveToolTo(name, tx, ty, base, swap);
        storeLayout(true);
        return now.x !== me.x || now.y !== me.y;
    }

    // Размер блока в клетках. w: число клеток (TOOL_FULL — на всю ширину), h: 0 — по содержимому.
    function setToolCells(card, w, h) {
        var name = card.getAttribute("data-tool");
        var sizes = parseSizes(G.st.sizes);
        var cols = G.last ? G.last.cols : TOOL_FULL;
        var need = G.last && G.last.need[name] ? G.last.need[name] : 0;
        if (w >= cols) { w = TOOL_FULL; }
        if (w < TOOL_MIN_COLS) { w = TOOL_MIN_COLS; }
        w = iconBump(name, w, G.last && G.last.pos[name] ? G.last.pos[name].w : w);
        if (h <= need) { h = 0; }
        if (h > TOOL_MAX_ROWS) { h = TOOL_MAX_ROWS; }
        sizes[name] = { w: w, h: h };
        G.st.sizes = sizesText(sizes);
        layoutTools(placesNow(), name);
    }

    function enableToolReordering(g) {
        G = g;
        // На обычных событиях мыши: события указателя (pointer events) в After Effects не срабатывали.
        var drag = null;        // { card, name, offX, offY, x, y, moved, base }
        var dragEndedAt = 0;

        function finish() {
            if (!drag) { return; }
            G = g;
            if (drag.moved) {
                drag.card.className = drag.card.className.replace(/\s*dragging/g, "");
                G.el.className = G.el.className.replace(/\s*reordering/g, "");
                storeLayout(true);
                dragEndedAt = Date.now();
            }
            drag = null;
        }

        g.el.addEventListener("mousedown", function (e) {
            var card, r;
            G = g;
            card = toolOf(e.target);
            if (!arranging || !card || e.button !== 0 || isResizeHandle(e.target)) { return; }
            finish();
            r = card.getBoundingClientRect();
            drag = { card: card, name: card.getAttribute("data-tool"), x: e.clientX, y: e.clientY, offX: e.clientX - r.left, offY: e.clientY - r.top, moved: false, base: null, at: "" };
            e.preventDefault();
        });
        g.el.addEventListener("dragstart", function (e) { e.preventDefault(); });

        // Двойной щелчок по свободному месту блока включает перестановку; по ползунку, числу или кнопке — нет.
        g.el.addEventListener("dblclick", function (e) {
            var card;
            G = g;
            card = toolOf(e.target);
            if (!card || Date.now() - dragEndedAt < 300) { return; }
            // Двойной щелчок по краю блока возвращает ему обычный размер и перестановку не трогает.
            if (isResizeHandle(e.target)) { setToolCells(card, TOOL_DEFAULT_COLS, 0); G.store(); return; }
            if (!arranging && isToolControl(e.target, card)) { return; }
            setArranging(!arranging);
        });

        document.addEventListener("mousemove", function (e) {
            var grid, tx, ty, key;
            if (!drag) { return; }
            G = g;
            if (!G.last) { return; }
            if (!drag.moved) {
                if (Math.abs(e.clientX - drag.x) < TOOL_DRAG_START_PX && Math.abs(e.clientY - drag.y) < TOOL_DRAG_START_PX) { return; }
                drag.moved = true;
                drag.base = currentPlaces();
                drag.card.className += " dragging";
                G.el.className += " reordering";
            }
            e.preventDefault();
            // Левый верхний угол блока прилипает к ближайшей клетке; остальные блоки уступают место.
            grid = G.el.getBoundingClientRect();
            tx = Math.round((e.clientX - drag.offX - grid.left) / G.last.step);
            ty = Math.round((e.clientY - drag.offY - grid.top) / G.last.step);
            tx = Math.max(0, Math.min(tx, G.last.cols - G.last.pos[drag.name].w));
            ty = Math.max(0, ty);
            key = tx + "," + ty;
            if (key === drag.at) { return; }
            drag.at = key;
            moveToolTo(drag.name, tx, ty, drag.base);
        });

        document.addEventListener("mouseup", function () { finish(); }, true);
        window.addEventListener("blur", function () { finish(); });

        // С клавиатуры: фокус на полоске, стрелки двигают блок на клетку.
        g.el.addEventListener("keydown", function (e) {
            var grip = e.target;
            G = g;
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

    function enableToolResizing(g) {
        var rs = null;          // { card, mode, left, top }
        G = g;

        function finish() {
            if (!rs) { return; }
            G = g;
            rs.card.className = rs.card.className.replace(/\s*resizing/g, "");
            G.el.className = G.el.className.replace(/\s*resizing(-\w+)?/g, "");
            storeLayout(!!G.st.places);
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
            var step = G.last.step;
            var gap = gridModule().gap;
            var now = G.last.pos[rs.card.getAttribute("data-tool")];
            var w = now.w, h = now.h;
            if (rs.mode !== "y") { w = Math.round((e.clientX - rs.left + gap) / step); }
            if (rs.mode !== "x") { h = Math.round((e.clientY - rs.top + gap) / step); }
            return { w: Math.max(1, w), h: Math.max(1, h) };
        }

        g.el.addEventListener("mousedown", function (e) {
            var card, r, mode;
            if (e.button !== 0 || !isResizeHandle(e.target)) { return; }
            G = g;
            card = toolOf(e.target);
            if (!card || !G.last) { return; }
            finish();
            r = card.getBoundingClientRect();
            mode = e.target.getAttribute("data-resize");
            rs = { card: card, mode: mode, left: r.left, top: r.top, at: "" };
            card.className += " resizing";
            G.el.className += " resizing resizing-" + mode;
            e.preventDefault();
        });

        document.addEventListener("mousemove", function (e) {
            var z, key;
            if (!rs) { return; }
            G = g;
            if (!G.last) { return; }
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
        g.el.addEventListener("keydown", function (e) {
            var card, name, z, now;
            if (!isResizeHandle(e.target) || e.metaKey || e.ctrlKey || e.altKey) { return; }
            G = g;
            if (!G.last) { return; }
            card = toolOf(e.target);
            if (!card) { return; }
            name = card.getAttribute("data-tool");
            z = sizeOf(name);
            now = G.last.pos[name];
            if (e.key === "ArrowLeft") { setToolCells(card, now.w - 1, z.h); }
            else if (e.key === "ArrowRight") { setToolCells(card, now.w + 1, z.h); }
            else if (e.key === "ArrowUp") { setToolCells(card, z.w, now.h - 1); }
            else if (e.key === "ArrowDown") { setToolCells(card, z.w, now.h + 1); }
            else if (e.key === "Home") { setToolCells(card, TOOL_DEFAULT_COLS, 0); }
            else if (e.key === "End") { setToolCells(card, TOOL_FULL, z.h); }
            else { return; }
            e.preventDefault();
            storeLayout(!!G.st.places);
        });
    }

    // Раздел пересчитывает сетку, когда меняется ширина панели или содержимое блоков.
    function watchToolGrid(g) {
        var lastWidth = -1;
        toolGridReady = true;
        function check() {
            var w = g.el.clientWidth;
            if (w !== lastWidth) { lastWidth = w; relayoutTools(); }
        }
        if (typeof window.ResizeObserver === "function") {
            new window.ResizeObserver(check).observe(g.el);
        }
        window.addEventListener("resize", check);
    }

    // Обычные места и размеры — для всех сеток сразу.
    function enableGridReset() {
        if (document.fonts && document.fonts.ready) { document.fonts.ready.then(relayoutTools); }
        ui.arrangeReset.addEventListener("click", function () {
            var keep = G;
            GRIDS.forEach(function (g) {
                G = g;
                // Как после новой установки.
                G.st.places = G.defPlaces || "";
                G.st.sizes = G.defSizes || "";
                G.st.pins = G.defPins || "";
                G.st.order = G.defOrder;
                G.store();
            });
            G = keep;
            relayoutTools();
        });
    }

    // ------------------------------------------------------------ шейп
    // Вкладка «Шейп» — такая же сетка блоков, как «Инструменты», со своими местами, размерами и булавками.

    var SHAPE_KEY = "sayframe.shape.v1";
    var EC_KEY = "sayframe.easecopy.v1";
    var SHAPE_DEFAULTS = { order: "", sizes: "", places: "", pins: "", grid: GRID_VERSION };

    function loadShape() {
        var m = {}, saved, k, keep = G;
        for (k in SHAPE_DEFAULTS) { if (SHAPE_DEFAULTS.hasOwnProperty(k)) { m[k] = SHAPE_DEFAULTS[k]; } }
        try { saved = JSON.parse(window.localStorage.getItem(SHAPE_KEY) || "{}"); } catch (e) { saved = null; }
        if (saved && typeof saved === "object") {
            upgradeGrid(saved);
            for (k in SHAPE_DEFAULTS) {
                if (SHAPE_DEFAULTS.hasOwnProperty(k) && typeof saved[k] === typeof SHAPE_DEFAULTS[k]) { m[k] = saved[k]; }
            }
        }
        G = { names: SHAPE_TOOL_NAMES };
        m.order = cleanToolOrder(m.order);
        m.sizes = sizesText(parseSizes(m.sizes));
        m.places = placesText(parsePlaces(m.places));
        m.pins = cleanPins(m.pins);
        G = keep;
        return m;
    }

    var shape = loadShape();

    function storeShape() {
        try { window.localStorage.setItem(SHAPE_KEY, JSON.stringify(shape)); } catch (e) {}
    }

    // ---- «Копия плавности»: как EaseCopy — плавность отдельно от значений и значения отдельно от плавности.
    // Буфер хранится в панели (и переживает её перезапуск): что скопировано, у скольких свойств и ключей.
    var ecClip = null;
    try { ecClip = JSON.parse(window.localStorage.getItem(EC_KEY) || "null"); } catch (e) { ecClip = null; }
    if (!ecClip || !ecClip.groups || !ecClip.groups.length) { ecClip = null; }

    function showEcClip() {
        var n, names;
        if (!ecClip) {
            ui.ecClip.textContent = "Буфер пуст: выделите ключи и нажмите «Копировать».";
            ui.ecClip.classList.remove("has");
            return;
        }
        n = 0;
        names = [];
        ecClip.groups.forEach(function (g) { n += g.keys.length; if (names.indexOf(g.name) < 0) { names.push(g.name); } });
        ui.ecClip.textContent = "В буфере: " + plural(n, "ключ", "ключа", "ключей") + " · " + names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
        ui.ecClip.classList.add("has");
    }

    function showEcFold() {
        var open = motion.ecOpts !== false, label = open ? "Скрыть настройку" : "Показать настройку";
        if (!open) { label += " (сквозная скорость: " + (motion.ecThrough ? "вкл." : "выкл.") + ")"; }
        if (open) { ui.ecOpts.removeAttribute("hidden"); } else { ui.ecOpts.setAttribute("hidden", ""); }
        ui.ecOptsToggle.setAttribute("aria-expanded", open ? "true" : "false");
        ui.ecOptsToggle.setAttribute("aria-label", label);
        ui.ecOptsToggle.title = label;
    }

    async function onEcCopy() {
        var res;
        if (busy) { return; }
        setBusy(true);
        setStatus("Копирую ключи…", "busy");
        try {
            res = await host("ecCopy", []);
            setBusy(false);
            ecClip = { groups: res.groups };
            try { window.localStorage.setItem(EC_KEY, JSON.stringify(ecClip)); } catch (e1) {}
            showEcClip();
            setStatus("Скопировано: " + plural(res.keys, "ключ", "ключа", "ключей") + (res.groups.length > 1 ? " у " + res.groups.length + " свойств" : "") +
                ". Выделите другие ключи и нажмите «Вставить плавность» или «Вставить значения».", "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    async function onEcPaste(mode) {
        var res;
        if (busy) { return; }
        if (!ecClip) { setStatus("Сначала выделите ключи и нажмите «Копировать».", ""); return; }
        setBusy(true);
        setStatus(mode === "value" ? "Вставляю значения…" : "Вставляю плавность…", "busy");
        try {
            res = await host("ecPaste", [ecClip, mode, !!motion.ecThrough]);
            setBusy(false);
            if (res.created) {
                setStatus("У «" + (res.names || []).join("», «") + "» не было ключей — создал " + plural(res.created, "ключ", "ключа", "ключей") + " от указателя времени " +
                    (mode === "value" ? "со скопированными значениями и плавностью." : "с текущим значением и скопированной плавностью: задайте значения ключей, плавность уже стоит.") +
                    "\nОтменить: Cmd/Ctrl+Z.", "done");
                return;
            }
            setStatus((mode === "value" ? "Значения вставлены: " : "Плавность вставлена: ") + plural(res.keys, "ключ", "ключа", "ключей") +
                (res.properties > 1 ? " у " + res.properties + " свойств" : "") + (res.byLayer ? " (ключи не были выделены — взял то же свойство у выделенного слоя)" : "") + ".\nОтменить: Cmd/Ctrl+Z.", "done");
        } catch (e) {
            var m = e && e.message ? e.message : String(e);
            setBusy(false);
            setStatus(humanError(e), m === "NO_ACTIVE_COMP" || m === "NO_KEYS_SELECTED" || /^EC_/.test(m) ? "" : "error");
        }
    }

    function enableShape() {
        var sg = { name: "shape", el: ui.shapeTools, cells: ui.shapeGridCells, line: ui.shapePinLine, names: SHAPE_TOOL_NAMES, st: shape, store: storeShape, defOrder: SHAPE_DEFAULTS.order, last: null };
        GRIDS.push(sg);
        enableToolReordering(sg);
        enableToolResizing(sg);
        enablePins(sg);
        watchToolGrid(sg);
        ui.ecOptsToggle.addEventListener("click", function () {
            motion.ecOpts = motion.ecOpts === false;
            showEcFold();
            relayoutTools();
            storeMotion();
        });
        ui.ecThrough.checked = !!motion.ecThrough;
        ui.ecThrough.addEventListener("change", function () { motion.ecThrough = ui.ecThrough.checked; storeMotion(); showEcFold(); });
        ui.ecCopy.addEventListener("click", onEcCopy);
        ui.ecPasteEase.addEventListener("click", function () { onEcPaste("ease"); });
        ui.ecPasteValue.addEventListener("click", function () { onEcPaste("value"); });
        showEcFold();
        showEcClip();
    }

    function enableMotion() {
        var mg = { name: "motion", el: ui.motionTools, cells: ui.gridCells, line: ui.pinLine, names: TOOL_NAMES, st: motion, store: storeMotion, defOrder: MOTION_DEFAULTS.order,
            defPlaces: MOTION_DEFAULTS.places, defSizes: MOTION_DEFAULTS.sizes, defPins: MOTION_DEFAULTS.pins, last: null };
        GRIDS.push(mg);
        G = mg;
        enableToolReordering(mg);
        enableToolResizing(mg);
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
        enablePins(mg);
        ui.easeBothBtn.addEventListener("click", function () { onEase("both"); });
        ui.anchorKeys.addEventListener("change", function () {
            var v = ui.anchorKeys.value;
            motion.anchorKeys = v === "shift" || v === "skip" ? v : "key";
            storeMotion();
        });
        ui.alignTo.value = motion.alignTo;
        enableShiftTool();
        showFoldParts();
        watchToolGrid(mg);
        enableGridReset();
        enableShape();
        G = mg;
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

    // Подписанный version.json: { …поля для старых версий панели…, signed: { payload: "<JSON>", sig: "<base64>" } }.
    // Верим только payload, и только если подпись сошлась с RELEASE_PUBLIC_KEY.
    function signedInfo(raw) {
        var s = raw && raw.signed;
        if (RELEASE_PUBLIC_KEY === "") { return Promise.resolve(raw); }
        if (!s || typeof s.payload !== "string" || typeof s.sig !== "string" || typeof platform.verify !== "function") {
            return Promise.reject(new Error("UPDATE_UNSIGNED"));
        }
        return platform.verify(s.payload, s.sig, RELEASE_PUBLIC_KEY).then(function (ok) {
            var info;
            if (ok !== true) { throw new Error("UPDATE_UNSIGNED"); }
            try { info = JSON.parse(s.payload); } catch (e) { throw new Error("UPDATE_BAD_INFO"); }
            return info;
        });
    }

    // Читает version.json. Поле moved ведёт на новый адрес этого файла (переезд на другой сервер).
    function fetchUpdateInfo(url, hops) {
        var fresh = url + (url.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now();
        return platform.getText(fresh, 20000).then(function (r) {
            var raw;
            if (r.status !== 200) { throw new Error("UPDATE_HTTP_" + r.status); }
            try { raw = JSON.parse(r.text); } catch (e) { throw new Error("UPDATE_BAD_INFO"); }
            if (!raw || typeof raw !== "object") { throw new Error("UPDATE_BAD_INFO"); }
            return signedInfo(raw);
        }).then(function (info) {
            var moved;
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
        // Запомненное прежней версией панели (без проверки подписи) не годится.
        if (RELEASE_PUBLIC_KEY !== "" && state.signed !== true) { delete state.latest; }
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
            state.signed = RELEASE_PUBLIC_KEY !== "";
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
        if (m === "UPDATE_ROLLED_BACK") { return "Обновление не установилось, панель осталась на прежней версии. Попробуйте ещё раз позже."; }
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
                bak: platform.join(tmp, "old" + i),
                dest: platform.join.apply(null, [ext].concat(f.path.split("/"))),
                saved: false,     // прежний файл отложен в bak
                placed: false     // новый файл стоит на месте
            });
        }

        function cleanup() {
            var k;
            for (k = 0; k < plan.length; k++) { platform.remove(plan[k].tmp); platform.remove(plan[k].bak); }
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
        // Прежний файл сначала откладывается, потом на его место встаёт новый. Если что-то не получилось,
        // rollback() возвращает все отложенные файлы: панель остаётся целиком на прежней версии.
        function placeOne(p) {
            return function () {
                return platform.exists(p.dest).then(function (had) {
                    if (!had) { return null; }
                    return platform.move(p.dest, p.bak).then(function () { p.saved = true; });
                }).then(function () {
                    return platform.mkdirp(platform.dirname(p.dest));
                }).then(function () {
                    return platform.move(p.tmp, p.dest);
                }).then(function () { p.placed = true; });
            };
        }
        function rollback() {
            var back = Promise.resolve(true);
            plan.slice().reverse().forEach(function (p) {
                back = back.then(function (ok) {
                    var step = p.placed ? platform.remove(p.dest) : Promise.resolve();
                    return step.then(function () { return p.saved ? platform.move(p.bak, p.dest) : null; })
                        .then(function () { return ok; }, function () { return false; });
                });
            });
            return back;
        }
        for (i = 0; i < plan.length; i++) { chain = chain.then(fetchOne(plan[i], i)); }
        chain = chain.then(function () {
            var placing = Promise.resolve();
            var k;
            updateMessage("Устанавливаю обновление…", false);
            for (k = 0; k < plan.length; k++) { placing = placing.then(placeOne(plan[k])); }
            return placing.catch(function () {
                return rollback().then(function (ok) { throw new Error(ok ? "UPDATE_ROLLED_BACK" : "UPDATE_INSTALL_FAILED"); });
            });
        }).then(function () {
            // Новая версия host.jsx должна заменить загруженную в After Effects.
            hostReady = {};
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
        }).catch(function (e) {
            ui.checkUpdate.disabled = false;
            hint(e && e.message === "UPDATE_UNSIGNED" ?
                "На сервере лежит обновление без подписи автора. Панель его не ставит. Сообщите автору Sayframe." :
                "Не удалось проверить обновления. Проверьте интернет и попробуйте ещё раз.", "bad");
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
    ui.stopBtn.addEventListener("click", requestStop);
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
    ui.decomposeBtn.addEventListener("click", onDecompose);
    ui.cacheBtn.addEventListener("click", onClearCache);
    ui.nullpBtn.addEventListener("click", onNullParent);
    ui.unusedBtn.addEventListener("click", onRemoveUnused);
    ui.cutoutBtn.addEventListener("click", onCutout);
    enableCutout();
    initBrand();
    ui.fxBtn.addEventListener("click", openFxConsole);
    ui.fxClose.addEventListener("click", closeFxConsole);
    ui.fxSnap.addEventListener("click", onSnapshot);
    ui.snapBtn.addEventListener("click", onSnapshot);
    enableSnapBar();
    enableInfoTips();
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
    fitTabs();
    if (typeof window.ResizeObserver === "function") { new window.ResizeObserver(fitTabs).observe(ui.tabs); }
    if (document.fonts && document.fonts.ready) { document.fonts.ready.then(fitTabs); }
    registerHotkeys();
    window.addEventListener("unload", stopKeyWatch);
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
    initMotionStyles();
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

    // Анонимная статистика: один раз после установки — «install», потом не чаще раза в день — «day».
    // Уходят только случайный номер установки, версия Sayframe, система и версия After Effects.
    function statsPing() {
        var url = window.__SAYFRAME_STATS_URL__ || STATS_URL, st = {}, ev, day, ae = "", d = new Date(), bytes, i;
        if (!url || settings.stats === false) { return; }
        try { st = JSON.parse(window.localStorage.getItem(STATS_KEY) || "{}") || {}; } catch (e) { st = {}; }
        if (!/^[0-9a-f]{32}$/.test(st.id || "")) {
            bytes = new Uint8Array(16);
            window.crypto.getRandomValues(bytes);
            for (st.id = "", i = 0; i < 16; i++) { st.id += (bytes[i] + 256).toString(16).slice(1); }
        }
        day = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
        ev = !st.sent ? "install" : (st.day !== day ? "day" : "");
        try { window.localStorage.setItem(STATS_KEY, JSON.stringify(st)); } catch (e) {}
        if (!ev) { return; }
        try { ae = String(JSON.parse(window.__adobe_cep__.getHostEnvironment()).appVersion || ""); } catch (e) {}
        platform.postJSON(url, { "content-type": "text/plain;charset=utf-8" },
            JSON.stringify({ ev: ev, id: st.id, v: VERSION, os: platform.isWindows() ? "Windows" : "Mac", ae: ae }), 20000)
            .then(function (r) {
                if (!r || r.status >= 400) { return; }
                st.sent = 1;
                st.day = day;
                try { window.localStorage.setItem(STATS_KEY, JSON.stringify(st)); } catch (e) {}
            })
            .catch(function () {});
    }
    setTimeout(statsPing, 4000);
    setInterval(backgroundUpdateCheck, UPDATE_CHECK_EVERY_MS);
    window.addEventListener("focus", backgroundUpdateCheck);
})();
