/*
 * Sayframe — интерфейс и логика панели (выполняется в HTML-движке After Effects).
 * Со стороны After Effects работает jsx/host.jsx; сюда он возвращает только JSON.
 */
(function () {
    "use strict";

    var VERSION = "1.78.3";
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
    var QUICK_ICONS = { "q-text": "T↑", "q-lower": "▭", "q-logo": "◎", "q-tidy": "▤" };
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
        design: "studio",   // вид панели: "studio" (Студия, основной), "glass" (стекло) или "ae" (как родные панели After Effects)
        designSet: 0,       // 2 — «Студия» уже поставлена основной (один раз, при обновлении); дальше выбор человека не трогаем
        panelFit: true,     // поля и кнопки тянутся на всю ширину панели; false — держат ширину panelWidth у левого края
        panelWidth: 380,    // ширина содержимого в пикселях, когда panelFit выключен
        toolSize: "100",    // масштаб блоков раздела «Инструменты» в процентах: "100", "90", "80", "70", "60" или "50"
        toolTitles: true,   // показывать ли названия блоков раздела «Инструменты»
        windows: "default", // отдельные окна в меню Window › Extensions, через запятую: "ease,align"; "default" — стандартный набор
        hiddenTools: "",    // спрятанные блоки «Инструментов» и «Шейпа», через запятую: "cache,nullp"
        stats: true,        // отправлять ли автору анонимный сигнал «установлено» и «открыто сегодня»
        infoTips: true,     // подсказки-окошки при наведении курсора на секунду
        previewPlay: "always",  // превью анимаций: "always" — играют сами по кругу, "hover" — только под курсором
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
        { id: "playful", label: "Игривый", note: "Playful: bouncy pops with overshoot, a little rotation, lively stagger, cheerful rhythm, elements that react to each other." },
        // Стили-паки: точные правила движения и свои приёмы библиотеки SF (как скиллы у моушн-дизайнеров).
        { id: "collage", label: "Бумажный коллаж", pack: true, tricks: ["на двойках 12 к/с", "падение + осадка", "наезд в деталь", "рваные края", "дрожь бумаги", "удар заголовка"],
          note: "Style pack: torn-paper COLLAGE, stop-motion. Rules: (1) everything moves ON TWOS - 12 drawings a second: call SF.onTwos() at the very end of the script, after all keys, and SF.boil(layers, 1.5) on the paper pieces so they jitter 1-2 px per drawing. " +
            "(2) Build with layered paper: solid or shape layers in paper colours (off-white #efe6d2, kraft #c9a873, plus 1-2 bold accents), each with SF.torn(layer) for white fibrous edges, a slight random rotation (-6..6 deg) and a soft drop shadow; halftone or grain texture via SF.grain(). Photos or logos become cut-outs with SF.torn too. " +
            "(3) Objects arrive with SF.dropIn(layer, t) (3 drawings falling with a tilt + 1 settle drawing 103% -> 100%), pop-ups appear in 1-2 drawings; never smooth slow fades. " +
            "(4) No hard cuts until the logo: go from scene to scene by pushing into a detail with SF.pushIn(layer or a null-parented group, t, {at: [x, y], zoom: 6, dur: 1}) then a paper iris, a torn wipe (SF.wipe on a torn paper layer) or a page tear. " +
            "(5) Title lands from above with SF.slam(title, t) (0.75 s, no overshoot), heavy italic serif, white paper outline; the logo flickers between 2-3 looks held 2-3 drawings each, inside a torn band. " +
            "(6) Cut the beats to a 120 BPM grid (0.5 s); nothing stays static longer than about 1 s except the title and logo holds. No full-screen flashing." },
        { id: "archival", label: "Архивный эдит", pack: true, tricks: ["ч/б со свечением", "плёночное зерно", "кинетический текст", "текст за объектом", "мягкие сплиты"],
          note: "Style pack: soft ARCHIVAL editorial edit. Rules: (1) Look: a bright black-and-white grade with soft bloom and light organic grain on top of everything - call SF.bw(), SF.bloom() and SF.grain(null, {amount: 4}) once (they share one adjustment layer 'SF Look'). " +
            "(2) Collage-like inserts look like archival photos/footage: slight vignette, paper or film borders, a little rotation, gentle push-ins with SF.drift. " +
            "(3) Typography in three roles: a big serif headline, a small mono/caption label, and an accent word; smooth kinetic text with SF.textIn (by words, style 'rise' or 'blur'), occasional selective stop-motion (SF.onTwos on just one element). " +
            "(4) Text can sit BEHIND an object (duplicate the object above the text with a mask). " +
            "(5) Split screens slide in softly (SF.wipe or SF.slideIn with dist 80-120 px), no hard bounces, calm 0.8-1.0 s moves, generous holds so everything can be read. Keep names, numbers and quotes exactly as given." },
        { id: "kinetic", label: "Кинетическая типографика", pack: true, tricks: ["текст в ритм", "удары по словам", "крупные слова", "маски-шторки", "резкие стопы"],
          note: "Style pack: KINETIC TYPOGRAPHY. Rules: (1) Text is the hero: few words on screen at a time, very large (title 160-260 px at 1080p), heavy grotesk, high contrast (black/white + one accent). " +
            "(2) Words hit on the beat: a 0.5 s grid (120 BPM), each word or line enters on a beat with SF.slam, SF.wipe or SF.textIn(by 'chars' or 'words', dur 0.3-0.5) and a very strong ease-out (moves stop dead, no bounce). " +
            "(3) Mix scales: one huge word, one small label; rotate a line 90 degrees now and then; masks and shape bars wipe text in and out. " +
            "(4) Transitions are hard: a block of colour wipes the frame, or the camera scales through a letter (SF.pushIn into a letter). " +
            "(5) Motion blur on, no fades longer than 0.2 s, holds of 0.5-1 s per phrase." },
        { id: "neon", label: "Неон", pack: true, tricks: ["свечение трубок", "мигание при включении", "линии рисуются", "тёмный фон", "лёгкое дрожание"],
          note: "Style pack: NEON SIGNS at night. Rules: (1) Background near-black blue (#07070f to #120a24), maybe a faint brick or grid texture at 10-15% opacity. " +
            "(2) Everything is a glowing tube: text in a rounded or script font as outlined/stroked shape or text with stroke, 2-3 saturated colours (#ff2bd6 pink, #20e3ff cyan, #ffe14d yellow), and SF.neon(layer, t) on each piece - two glows, the tube flickers on (hold frames). " +
            "(3) Lines and icons draw themselves with SF.drawOn (0.6-1 s, ease in-out), then glow. Pieces switch on one after another with SF.neon at 0.15-0.3 s steps - never fade or slide in. " +
            "(4) Alive while it holds: a subtle flicker (opacity wiggle 1-2 times a second, 5-10%) on one or two signs, a slow drift (SF.drift 3-4%). " +
            "(5) Exit: tubes switch off in reverse order with a short flicker. Optional reflection: a blurred, flipped copy at 20% opacity under the sign." },
        { id: "glitch", label: "Глитч", pack: true, tricks: ["цифровые сбои", "рывки по кадрам", "мигание", "моноширинный текст", "резкие склейки"],
          note: "Style pack: DIGITAL GLITCH. Rules: (1) Palette: black #000, white, one acid colour (#00ff9c or #ff2e4d); mono or tech grotesk type, uppercase, tracking +50. " +
            "(2) Things do not glide in: they appear with SF.glitch(layer, t, {dur: 0.2-0.35}) - frame-by-frame sideways jumps, stretches and flicker, then they sit still. Also glitch on exits and at every cut. " +
            "(3) Rhythm: hard cuts every 0.5-1 s, holds are short; between hits everything is perfectly still (contrast is the point). " +
            "(4) Extra layers: thin horizontal bars or blocks (solid rectangles 2-20 px high) that blink for 1-2 frames across the frame during hits; a copy of the title in the acid colour offset 6-10 px and visible only during hits (RGB split feel). " +
            "(5) Text can type on with SF.typeOn with a block cursor. No soft fades, no bounce, no blur transitions." },
        { id: "vhs", label: "Ретро VHS", pack: true, tricks: ["полосы развёртки", "шум плёнки", "мягкая картинка", "дата в углу", "дрожание кадра"],
          note: "Style pack: RETRO 80s/90s VHS. Rules: (1) Call SF.vhs() once - noise, scan lines, softness and washed colour on one adjustment layer 'SF Look' on top; add SF.grain(null, {amount: 4}). " +
            "(2) Colours: warm faded (#f2e9d8, #e85d75, #3fb6c6, #f6c453) on dark navy; chrome or bold italic type with a hard drop shadow offset 6-8 px; a camcorder overlay: 'PLAY >' top left and a date like 'JAN 01 1994' bottom right in a mono font. " +
            "(3) Motion is a bit clunky and analog: moves 0.6-0.8 s with ease-out, slight wiggle of the whole picture (a null parent with wiggle(1, 3)), sometimes a quick 2-3 frame vertical jump (tracking error) at cuts. " +
            "(4) Transitions: a white flash of 2 frames to 60% max, a horizontal wipe with a noisy edge, or a quick zoom. (5) Keep text big and simple; 4:3 safe area." },
        { id: "swiss", label: "Швейцарский", pack: true, tricks: ["строгая сетка", "жёсткие стопы", "маски-шторки", "крупная типографика", "плашки цвета"],
          note: "Style pack: SWISS / INTERNATIONAL TYPOGRAPHIC. Rules: (1) A strict grid: 12 columns, margins 80 px at 1080p; everything snaps to it; flush-left, ragged-right text; Helvetica/Inter-like grotesk in two weights. " +
            "(2) Colours: off-white #f1efe9, black, one strong red #e3241b (or the brand colour) used as solid blocks. " +
            "(3) Motion is precise and fast: moves 0.35-0.5 s with an extreme ease-out (SF.style handles it: everything stops dead, no overshoot, no springs); elements slide exactly along the grid lines (SF.slideIn with dist = one or two columns) or are revealed by SF.wipe from a grid edge. " +
            "(4) Solid colour bars sweep across to reveal or hide content; numbers and big type (200+ px) carry the composition; generous empty space. " +
            "(5) Staggers follow reading order (left to right, top to bottom) with 0.05-0.08 s steps; holds 1-1.5 s; transitions are a full-frame colour block wiping through." },
        { id: "sketch", label: "Скетч от руки", pack: true, tricks: ["дрожащий контур", "рисуется линия", "на двойках", "бумага в клетку", "маркерные акценты"],
          note: "Style pack: HAND-DRAWN SKETCH / doodle. Rules: (1) Paper background (#faf7f0, maybe a faint 40 px grid at 8% opacity); ink #1d1d1f strokes 4-8 px with round caps; 1-2 marker accent colours (#ffd23f highlighter, #ff6b6b). " +
            "(2) Shapes are drawn: build icons, arrows, circles and underlines as shape strokes and reveal them with SF.drawOn (0.5-0.9 s); fills appear a beat later as a marker scribble (a thick stroke drawing on). " +
            "(3) Everything boils: SF.sketch(layer) on drawn layers (outline wobble 8 times a second) and SF.onTwos() at the end (12 drawings/s). " +
            "(4) Things pop in with a small overshoot (springs are on in this style) and a little rotation (-4..4 deg); text in a handwritten or rounded font, revealed by words. " +
            "(5) Arrows and circles point to and frame the important words; transitions: the camera pans along the paper to the next drawing, or a hand-drawn line wipes the frame." }
    ];
    // Свои стили, которые AI разобрал по референсу: { id: "my-…", label, base, note, tricks, palette, rows }.
    var STYLES_KEY = "sayframe.styles.v1";
    var CUSTOM_STYLES = (function () { var a = []; try { a = JSON.parse(window.localStorage.getItem(STYLES_KEY) || "[]"); } catch (e) { a = []; } return a instanceof Array ? a.filter(function (x) { return x && x.id && x.label; }) : []; })();
    function motionStyleOf(id) {
        var i;
        for (i = 0; i < MOTION_STYLES.length; i++) { if (MOTION_STYLES[i].id === id) { return MOTION_STYLES[i]; } }
        for (i = 0; i < CUSTOM_STYLES.length; i++) { if (CUSTOM_STYLES[i].id === id) { return CUSTOM_STYLES[i]; } }
        return null;
    }
    // Имя стиля для библиотеки SF: у своих стилей — тот готовый стиль, на котором они построены.
    function sfStyleName(id) {
        var st = motionStyleOf(id);
        return st && st.base ? st.base : st ? st.id : "normal";
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
        "  Style-pack recipes: SF.dropIn(layer, t, {from}) - stop-motion drop (3 drawings + settle). SF.pushIn(layer, t, {at: [x, y], zoom: 6, dur: 1}) - accelerating push into a detail that ends centred. SF.slam(layer, t, {dur, dist}) - title lands from above, no overshoot.",
        "  SF.neon(layer, t) - neon glow, flickers on at t. SF.glitch(layer, t, {dur, amount}) - frame-by-frame glitch hit. SF.vhs() - VHS look (on 'SF Look'). SF.sketch(layer) - hand-drawn outline wobble.",
        "  SF.onTwos(layers, fps) - stop-motion: keyframed transforms step at 12 drawings/s (call last; all layers if omitted). SF.boil(layers, px) - paper jitter per drawing. SF.torn(layer) - torn paper edge. SF.grain(layer, {amount}), SF.bloom(layer), SF.bw(layer) - look effects; with layer null they go on one shared adjustment layer 'SF Look' on top.",
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

    // То же для Premiere Pro: другие объекты (секвенции, дорожки, клипы) и своя библиотека PR из host_pr.jsx.
    var PR_SYSTEM_PROMPT = [
        "You are an assistant built into a panel inside Adobe Premiere Pro.",
        "The user describes, in plain words, what they want done in Premiere Pro. You make it happen by writing a script that the panel runs immediately.",
        "",
        "Reply format:",
        "- One short sentence, in the user's language, saying what the script will do.",
        "- Then exactly one fenced code block (```javascript) with a complete ExtendScript script for Premiere Pro.",
        "- If the message is a question, or the task cannot be done by scripting in Premiere Pro, answer in plain text in the user's language and include no code block.",
        "",
        "Script rules:",
        "- ExtendScript is ES3: use var and function only. No let, const, arrow functions, template strings, JSON, Array.prototype.map/forEach/filter/indexOf, String.prototype.trim, or trailing commas.",
        "- This is the Premiere Pro object model, not After Effects: app.project, app.project.activeSequence, sequence.videoTracks / audioTracks (track 0 is V1 / A1, the lowest), track.clips (TrackItem: name, start, end, inPoint, outPoint, projectItem, components, isSelected(), setSelected(), remove(ripple, alignToVideo)), app.project.rootItem (bins and ProjectItems), sequence.markers, app.encoder.",
        "- Time is in ticks: 254016000000 per second. Time objects have .seconds and .ticks. Positions on the timeline are seconds or tick strings.",
        "- Premiere has no undo groups for scripts: every change is a separate undo step. Keep scripts focused and do not make changes the user did not ask for.",
        "- Work in the active sequence. If the task needs a sequence and none is open, throw new Error with a clear message asking the user to open one.",
        "- Clip effects are components: clip.components (Motion, Opacity, plus applied effects). Their parameters are component.properties with getValue(), setValue(v, true), setTimeVarying(true), addKey(t), setValueAtKey(t, v, true). Motion > Position is normalised [x, y] (0..1 of the frame); Scale is percent.",
        "- To add an effect use the QE DOM: app.enableQE(); var qs = qe.project.getActiveSequence(); qs.getVideoTrackAt(n).getItemAt(i).addVideoEffect(qe.project.getVideoEffectByName('Gaussian Blur')). Transitions: addTransition(qe.project.getVideoTransitionByName('Cross Dissolve'), true, '00;00;01;00'). Wrap QE calls in try/catch: QE is undocumented and can differ between versions.",
        "- Text and titles: Premiere cannot create text layers by plain scripting. Use sequence.importMGT(path, ticks, videoTrackIndex, audioTrackIndex) only when the user gives a .mogrt file; otherwise explain in the reply that the text has to be made with the Essential Graphics panel, and still do the rest of the task.",
        "- Do not call alert, confirm or prompt. Do not delete clips, sequences or project items, close or save the project, or touch files, unless the user explicitly asks for that.",
        "- Write defensive code: check that things exist before using them, and throw new Error('clear message in the user\\'s language') when the request cannot be carried out (for example, no clip is selected).",
        "",
        "The PR helper library is already loaded (tested, ES3). Prefer it over raw calls:",
        "  PR.seq() - the active sequence (throws when none). PR.fps(), PR.duration(), PR.playhead() - in seconds.",
        "  PR.secs(timeOrTicks) - seconds. PR.ticks(sec) - tick string. PR.time(sec) - a Time object.",
        "  PR.track('V'|'A', n) - track n from 1. PR.clips(track) - its clips as an array. PR.selected() - selected clips of the active sequence.",
        "  PR.bin(name) - a bin in the project root, made when missing. PR.findItem(name) - a project item by name.",
        "  PR.importFile(path, binName) - imports a file and returns its project item. PR.place(item, sec) - puts an item on the lowest free video track at sec (default: playhead).",
        "  PR.freeAt(track, a, b) - is the track empty between a and b seconds. PR.component(clip, name) and PR.param(clip, componentName, paramName), e.g. PR.param(clip, 'Motion', 'Scale').",
        "",
        "Every user message contains a snapshot of the current project state (sequence, tracks, clips with times, selection). Use it to refer to real clip names, tracks and times.",
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
            // Содержимое папки: [{ name, dir }]; нет папки — пустой список.
            listDir: function (p) {
                return new Promise(function (resolve) {
                    fs.readdir(p, { withFileTypes: true }, function (err, list) {
                        resolve(err ? [] : list.map(function (d) { return { name: d.name, dir: d.isDirectory() }; }));
                    });
                });
            },
            copyFile: function (a, b) {
                return new Promise(function (resolve, reject) { fs.copyFile(a, b, cb(resolve, reject)); });
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

    // ---------------------------------------------------------------- программа
    // Та же панель работает в After Effects и в Premiere Pro. В Premiere она — отдельное расширение
    // (com.sayframe.pr.panel со своим manifest-pr.xml), берёт команды из jsx/host_pr.jsx и показывает
    // только то, что там есть: AI, Проекты и быстрый экспорт.
    var IS_PR = (function () {
        try { return String(JSON.parse(window.__adobe_cep__.getHostEnvironment()).appName || "") === "PPRO"; } catch (e) { return false; }
    })();
    var APP_NAME = IS_PR ? "Premiere Pro" : "After Effects";
    // Быстрые задачи в Premiere свои и хранятся отдельно.
    if (IS_PR) {
        QUICK_KEY = "sayframe.quick.pr.v1";
        QUICK_ICONS = { "p-dissolve": "⧉", "p-gaps": "⇤", "p-markers": "◆", "p-tidy": "▤" };
        QUICK_DEFAULTS = [
            { id: "p-dissolve", name: "Переходы между клипами",
              text: "Поставь переход Cross Dissolve длиной 0,5 секунды на каждый стык соседних клипов на дорожке V1 открытой секвенции. Там, где переход уже есть, ничего не меняй." },
            { id: "p-gaps", name: "Убрать пустоты",
              text: "Убери пустые места между клипами на дорожке V1 открытой секвенции: сдвинь клипы влево вплотную друг к другу, порядок не меняй. Клипы на других дорожках, которые стоят над сдвинутым клипом, сдвинь вместе с ним." },
            { id: "p-markers", name: "Маркеры каждые 5 секунд",
              text: "Поставь маркеры на открытой секвенции каждые 5 секунд от начала до конца, с названиями «5 с», «10 с» и так далее." },
            { id: "p-tidy", name: "Упорядочить проект",
              text: "Упорядочи панель Project: разложи элементы по корзинам «Секвенции», «Видео», «Картинки», «Звук» и «Прочее». Уже существующие корзины с такими именами используй, пустые не создавай, ничего не удаляй и не переименовывай." }
        ];
    }
    var HOST_JSX = IS_PR ? "/jsx/host_pr.jsx" : "/jsx/host.jsx";
    // Команды host_pr.jsx: остальные в Premiere сразу отвечают NOT_IN_PREMIERE, не трогая программу.
    var PR_FNS = ["info", "syntax", "run", "reference", "brandLogo", "brandIcon", "brandComp", "brandFilesInUse", "brandSaveDialog",
        "exportInfo", "exportOne", "exportReveal", "exportPickFile", "acSound", "sndTargets", "sndApplyFiles", "sfApply", "sfState", "trApply",
        "easePR", "ecCopy", "ecPaste", "stagger", "anchor", "align", "distribute", "placeImage", "organizeProject", "removeUnused", "cutoutSource", "cutoutApply"];

    // ---- Sayframe для Premiere Pro у тех, кто поставил панель раньше (обновлялся из After Effects):
    // если на компьютере есть Premiere Pro, а расширения SayframePR рядом нет, панель один раз предлагает
    // поставить его сама — копией своей папки с manifest-pr.xml вместо manifest.xml.
    var PR_OFFER_KEY = "sayframe.prOffer.v1";   // "no" — отказались, "done" — поставлено

    function premiereRoots() {
        if (window.__SAYFRAME_TEST_APPS__) { return [window.__SAYFRAME_TEST_APPS__]; }
        return platform.isWindows() ? ["C:\\Program Files\\Adobe"] : ["/Applications"];
    }

    async function premiereOnComputer() {
        var roots = premiereRoots(), i, list;
        for (i = 0; i < roots.length; i++) {
            list = await platform.listDir(roots[i]);
            if (list.some(function (d) { return d.dir && /^Adobe Premiere Pro/i.test(d.name); })) { return true; }
        }
        return false;
    }

    function premiereDir() { return platform.join(platform.dirname(extensionDir()), "SayframePR"); }

    async function copyTree(src, dst) {
        var list = await platform.listDir(src), i, d;
        await platform.mkdirp(dst);
        for (i = 0; i < list.length; i++) {
            d = list[i];
            if (/^\./.test(d.name)) { continue; }
            if (d.dir) { await copyTree(platform.join(src, d.name), platform.join(dst, d.name)); }
            else { await platform.copyFile(platform.join(src, d.name), platform.join(dst, d.name)); }
        }
    }

    // Ставит расширение для Premiere Pro рядом: сначала во временную папку, потом одним переименованием.
    async function installPremiereCopy() {
        var ext = extensionDir(), dest = premiereDir(), staging = platform.join(platform.dirname(ext), ".SayframePR.installing");
        await copyTree(ext, staging);
        await platform.writeText(platform.join(staging, "CSXS", "manifest.xml"), await platform.readText(platform.join(ext, "CSXS", "manifest-pr.xml")));
        await platform.move(staging, dest);
    }

    async function offerPremiere() {
        var said = "", ext = extensionDir(), choice;
        if (IS_PR || SOLO || !platform.available || !platform.listDir || !platform.copyFile || !ext || busy) { return; }
        try { said = window.localStorage.getItem(PR_OFFER_KEY) || ""; } catch (e) {}
        if (said) { return; }
        if (!(await platform.exists(platform.join(ext, "CSXS", "manifest-pr.xml")))) { return; }
        if (await platform.exists(premiereDir())) { try { window.localStorage.setItem(PR_OFFER_KEY, "done"); } catch (e0) {} return; }
        if (!(await premiereOnComputer())) { return; }
        choice = await modal({ title: "Sayframe в Premiere Pro",
            text: "На компьютере есть Premiere Pro. Добавить Sayframe и туда? Там будут AI, Проекты и быстрый экспорт, ключ и настройки — те же, что здесь.\n\nПосле этого перезапустите Premiere Pro: панель будет в меню Window > Extensions > Sayframe.",
            buttons: [{ label: "Не надо", value: "no" }, { label: "Добавить", value: "yes", primary: true }] });
        if (choice === null) { return; }   // Esc — спросим в другой раз
        if (choice === "no") { try { window.localStorage.setItem(PR_OFFER_KEY, "no"); } catch (e1) {} setStatus("Хорошо. Добавить Sayframe в Premiere Pro можно потом установщиком.", ""); return; }
        try {
            await installPremiereCopy();
            try { window.localStorage.setItem(PR_OFFER_KEY, "done"); } catch (e2) {}
            setStatus("Sayframe добавлен в Premiere Pro. Перезапустите Premiere Pro — панель будет в меню Window > Extensions > Sayframe.", "done");
        } catch (e3) {
            setStatus("Не получилось добавить Sayframe в Premiere Pro. Закройте Premiere Pro и запустите установщик Sayframe.", "error");
        }
    }

    // ---------------------------------------------------------------- отдельные окна
    // Раздел или блок можно открыть своим окном After Effects (Window › Extensions › «Sayframe — …»).
    // Каждое окно — своё расширение в manifest.xml с Id com.sayframe.ae.win.<key>; панель узнаёт по Id,
    // что ей показать. Какие окна есть в меню, выбирают в Настройках › «Окна»: панель переписывает manifest.xml,
    // After Effects читает его при запуске.
    var WIN_PREFIX = "com.sayframe.ae.win.";
    var WINDOWS = [
        { key: "anim", tab: "tools", label: "Анимация", w: 380, h: 720 },
        { key: "tools", tab: "motion", label: "Инструменты", w: 380, h: 720 },
        { key: "shape", tab: "shape", label: "Шейп", w: 380, h: 560 },
        { key: "projects", tab: "brand", label: "Проекты", w: 380, h: 640 },
        { key: "ease", tool: "ease", label: "Плавность", w: 300, h: 330 },
        { key: "align", tool: "align", label: "Выровнять", w: 300, h: 300 },
        { key: "anchor", tool: "anchor", label: "Якорь", w: 300, h: 300 },
        { key: "stagger", tool: "stagger", label: "Лесенка", w: 300, h: 340 },
        { key: "easecopy", tool: "easecopy", label: "Копия", w: 300, h: 330 },
        { key: "paste", tool: "paste", label: "Картинка", w: 300, h: 180 },
        { key: "organize", tool: "organize", label: "Порядок", w: 300, h: 200 },
        { key: "decompose", tool: "decompose", label: "Декомпоз", w: 300, h: 200 },
        { key: "cache", tool: "cache", label: "Кэш", w: 300, h: 200 },
        { key: "nullp", tool: "nullp", label: "Null", w: 300, h: 200 },
        { key: "unused", tool: "unused", label: "Чистка", w: 300, h: 200 },
        { key: "cutout", tool: "cutout", label: "Вырезка", w: 300, h: 200 },
        { key: "pathfinder", tool: "pathfinder", label: "Pathfinder", w: 300, h: 260 },
        { key: "split", tool: "split", label: "Разделить", w: 300, h: 200 },
        { key: "export", label: "Экспорт", w: 340, h: 640 }
    ];
    // Все окна всегда есть в manifest.xml, но без пункта в меню Window › Extensions: их открывает только ↗.
    var WIN_DEFAULT = WINDOWS.map(function (w) { return w.key; });

    function winByKey(key) {
        var i;
        for (i = 0; i < WINDOWS.length; i++) { if (WINDOWS[i].key === key) { return WINDOWS[i]; } }
        return null;
    }
    function winByTool(tool) {
        var i;
        for (i = 0; i < WINDOWS.length; i++) { if (WINDOWS[i].tool === tool) { return WINDOWS[i]; } }
        return null;
    }

    // Это окно — отдельный раздел или блок? null — большой Sayframe.
    var SOLO = (function () {
        var id = "";
        try { id = String(window.__adobe_cep__ && window.__adobe_cep__.getExtensionId ? window.__adobe_cep__.getExtensionId() : ""); } catch (e) {}
        return !IS_PR && id.indexOf(WIN_PREFIX) === 0 ? winByKey(id.slice(WIN_PREFIX.length)) : null;
    })();

    // Список окон больше не выбирают: в manifest.xml всегда все (в меню их нет, так что оно не засоряется).
    function windowList() { return WIN_DEFAULT.slice(); }

    // manifest.xml с нужными окнами: прежние окна убираются, новые встают после большой панели.
    function windowsManifest(text, keys) {
        var list = "", disp = "";
        text = String(text).replace(/\r?\n[ \t]*<Extension Id="com\.sayframe\.ae\.win\.[^"]+" Version="[^"]*"\/>/g, "")
            .replace(/\r?\n[ \t]*<Extension Id="com\.sayframe\.ae\.win\.[^"]+">[\s\S]*?\n[ \t]*<\/Extension>/g, "");
        keys.forEach(function (k) {
            var w = winByKey(k);
            if (!w) { return; }
            list += '\n    <Extension Id="' + WIN_PREFIX + k + '" Version="1.0.0"/>';
            disp += "\n    <Extension Id=\"" + WIN_PREFIX + k + "\">\n      <DispatchInfo>\n        <Resources>\n          <MainPath>./index.html</MainPath>\n" +
                "          <ScriptPath>./jsx/host.jsx</ScriptPath>\n          <CEFCommandLine>\n            <Parameter>--enable-nodejs</Parameter>\n" +
                "            <Parameter>--mixed-context</Parameter>\n          </CEFCommandLine>\n        </Resources>\n        <Lifecycle>\n" +
                "          <AutoVisible>true</AutoVisible>\n        </Lifecycle>\n        <UI>\n          <Type>Panel</Type>\n" +
                "          <Geometry>\n" +
                "            <Size>\n              <Height>" + w.h + "</Height>\n              <Width>" + w.w + "</Width>\n            </Size>\n" +
                "            <MinSize>\n              <Height>120</Height>\n              <Width>200</Width>\n            </MinSize>\n" +
                "            <MaxSize>\n              <Height>2400</Height>\n              <Width>1200</Width>\n            </MaxSize>\n" +
                "          </Geometry>\n        </UI>\n      </DispatchInfo>\n    </Extension>";
        });
        text = text.replace(/(<Extension Id="com\.sayframe\.ae\.panel" Version="[^"]*"\/>)/, function (m) { return m + list; });
        return text.replace(/(\r?\n[ \t]*<\/DispatchInfoList>)/, function (m) { return disp + m; });
    }

    // Окна, которые After Effects прочитал при запуске (их можно открыть сразу), и есть ли запрет на запись.
    var winLoaded = null, winLocked = "";

    function manifestPath() { return platform.join(extensionDir(), "CSXS", "manifest.xml"); }

    function loadedWindows(text) {
        var re = /<Extension Id="com\.sayframe\.ae\.win\.([^"]+)" Version="[^"]*"\/>/g, m, out = [];
        while ((m = re.exec(String(text))) !== null) { out.push(m[1]); }
        return out;
    }

    // Приводит manifest.xml к выбору из настроек. Возвращает "same" (уже так), "written" (нужен перезапуск AE),
    // "signed" / "noaccess" / "nofile" — переписать нельзя.
    async function syncWindowsManifest() {
        var dir = extensionDir(), text, next;
        if (IS_PR) { return "same"; }
        if (!dir || !platform.available) { return "nofile"; }
        try { text = await platform.readText(manifestPath()); } catch (e) { return "nofile"; }
        if (winLoaded === null) { winLoaded = loadedWindows(text); }
        next = windowsManifest(text, windowList(settings.windows));
        if (next === text) { return "same"; }
        try { if (await platform.exists(platform.join(dir, "META-INF", "signatures.xml"))) { winLocked = "signed"; return "signed"; } } catch (e1) {}
        try { await platform.writeText(manifestPath(), next); } catch (e2) { winLocked = "noaccess"; return "noaccess"; }
        return "written";
    }

    // Окна, которые After Effects знает прямо сейчас: он читает manifest.xml только при запуске,
    // поэтому после обновления или смены списка новые окна появляются лишь после перезапуска AE.
    // null — After Effects не сказал (тогда верим файлу, каким он был при запуске панели).
    function hostWindows() {
        var cep = window.__adobe_cep__, list, out = [], mine = false, i, id;
        if (!cep || typeof cep.getExtensions !== "function") { return null; }
        try { list = JSON.parse(cep.getExtensions(JSON.stringify([]))); } catch (e) { return null; }
        if (!list || typeof list.length !== "number") { return null; }
        for (i = 0; i < list.length; i++) {
            id = String(list[i] && list[i].id || "");
            if (id.indexOf("com.sayframe.ae.") === 0) { mine = true; }
            if (id.indexOf(WIN_PREFIX) === 0) { out.push(id.slice(WIN_PREFIX.length)); }
        }
        return mine ? out : null;
    }

    function openWindow(key) {
        var w = winByKey(key), list, known = hostWindows() || winLoaded || [], inFile;
        if (!w) { return; }
        if (known.indexOf(key) >= 0 && window.__adobe_cep__ && typeof window.__adobe_cep__.requestOpenExtension === "function") {
            try {
                window.__adobe_cep__.requestOpenExtension(WIN_PREFIX + key, "");
                setStatus("Открываю окно «" + w.label + "».", "done");
                return;
            } catch (e) {}
        }
        inFile = windowList(settings.windows).indexOf(key) >= 0;
        if (inFile && winLocked === "") {
            setStatus("Окно «" + w.label + "» уже добавлено, но After Effects его ещё не видит. Перезапустите After Effects один раз — потом ↗ откроет его сразу.", "");
            syncWindowsManifest().catch(function () {});
            return;
        }
        list = windowList(settings.windows);
        if (list.indexOf(key) < 0) { list.push(key); }
        settings.windows = windowList(list.join(",")).join(",");
        if (draft) { draft.windows = settings.windows; }
        storeSettings(settings);
        showWindowPicker();
        syncWindowsManifest().then(function (r) {
            if (r === "signed" || r === "noaccess" || r === "nofile") { setStatus(winLockText(r), "error"); return; }
            setStatus("Окно «" + w.label + "» откроется после перезапуска After Effects: нажмите ↗ ещё раз.", "done");
        });
    }

    function winLockText(r) {
        return r === "signed" ? "Эта копия панели установлена из подписанного пакета: список окон поменять нельзя." :
            "Нет доступа к папке панели: список окон поменять не получилось. Переустановите панель установщиком.";
    }

    // Настройки › «Окна»: переключатели разделов и блоков.
    function buildWindowPicker() {
        [["Разделы", function (w) { return !!w.tab; }], ["Блоки", function (w) { return !w.tab; }]].forEach(function (g) {
            var head = document.createElement("span"), box = document.createElement("div");
            head.className = "label";
            head.textContent = g[0];
            box.className = "win-list";
            WINDOWS.filter(g[1]).forEach(function (w) {
                var lab = document.createElement("label"), inp = document.createElement("input"), tr = document.createElement("span"), tx = document.createElement("span");
                lab.className = "switch";
                inp.type = "checkbox";
                inp.setAttribute("data-win", w.key);
                tr.className = "track";
                tx.className = "text";
                tx.textContent = w.label;
                lab.appendChild(inp); lab.appendChild(tr); lab.appendChild(tx);
                inp.addEventListener("change", onWindowPick);
                box.appendChild(lab);
            });
            ui.winPicker.appendChild(head);
            ui.winPicker.appendChild(box);
        });
    }

    function showWindowPicker() {
        var list = windowList((draft || settings).windows);
        Array.prototype.forEach.call(ui.winPicker.querySelectorAll("input[data-win]"), function (i) {
            i.checked = list.indexOf(i.getAttribute("data-win")) >= 0;
            i.disabled = !!winLocked;
        });
        if (winLocked) { ui.winNote.textContent = winLockText(winLocked); }
    }

    async function onWindowPick(e) {
        var list = [], r;
        e.stopPropagation();
        Array.prototype.forEach.call(ui.winPicker.querySelectorAll("input[data-win]"), function (i) { if (i.checked) { list.push(i.getAttribute("data-win")); } });
        settings.windows = list.join(",");
        if (draft) { draft.windows = settings.windows; }
        storeSettings(settings);
        r = await syncWindowsManifest();
        if (r === "signed" || r === "noaccess" || r === "nofile") { ui.winNote.textContent = winLockText(r); showWindowPicker(); return; }
        ui.winNote.textContent = sameList(list, winLoaded || []) ? "Меню Window › Extensions такое же, как сейчас." :
            "Сохранено. Перезапустите After Effects — меню Window › Extensions обновится.";
    }

    function sameList(a, b) { return a.slice().sort().join() === b.slice().sort().join(); }

    // Кнопка ↗ у каждого блока большого Sayframe: открыть его отдельным окном.
    function addWindowButtons() {
        Array.prototype.forEach.call(document.querySelectorAll(".motion-tools .tool-card[data-tool]"), function (card) {
            var w = winByTool(card.getAttribute("data-tool")), b;
            if (!w || card.querySelector(".win-open")) { return; }
            b = winButton(w);
            card.appendChild(b);
        });
        ui.exHead.insertBefore(winButton(winByKey("export")), ui.exClose);
    }

    function winButton(w) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "win-open";
        b.setAttribute("data-win", w.key);
        b.title = "Открыть «" + w.label + "» отдельным окном";
        b.setAttribute("aria-label", b.title);
        b.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5 3 9"/></svg>';
        b.addEventListener("mousedown", function (e) { e.stopPropagation(); });
        b.addEventListener("click", function (e) { e.stopPropagation(); e.preventDefault(); openWindow(w.key); });
        return b;
    }

    // Само отдельное окно: тема «After Effects», без шапки и вкладок; блок — один, раздел — целиком.
    function startSolo() {
        var root = document.documentElement, card;
        root.setAttribute("data-solo", SOLO.key);
        if (SOLO.tab) {
            root.setAttribute("data-solo-kind", "tab");
            showTab(SOLO.tab);
        } else if (SOLO.tool) {
            root.setAttribute("data-solo-kind", "tool");
            card = document.querySelector('.motion-tools .tool-card[data-tool="' + SOLO.tool + '"]');
            if (card) {
                card.classList.add("solo-card");
                card.classList.remove("tool-off");
                card.removeAttribute("style");
                showTab(card.closest("#shapeTools") ? "shape" : "motion");
            }
        } else {
            root.setAttribute("data-solo-kind", "export");
            Object.keys(TABS).forEach(function (k) { TABS[k].view.hidden = true; });
            ui.exportBar.parentNode.insertBefore(ui.statusBox, ui.exportBar.nextSibling);
            onExport();
            // Вернулись в окно — композиция могла смениться.
            window.addEventListener("focus", function () { if (!busy && !ui.exSetup.hidden) { exLoadInfo(); } });
        }
        applyTheme(settings);
        setStatus("Готов.", "");
    }

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
                // try/catch: if the host file fails to load, the reply carries the real error and its line.
                return evalScript("try { $.evalFile(" + asciiJSON(extensionDir() + HOST_JSX) + "); " + hostProbe(fn) +
                    " } catch (e) { 'ERR ' + (e.line || '?') + ': ' + e.message }").then(function (t2) {
                    var err;
                    if (t2 !== "yes") {
                        err = new Error("HOST_NOT_LOADED");
                        if (typeof t2 === "string" && t2.indexOf("ERR ") === 0) { err.hostDetail = t2.slice(4); }
                        throw err;
                    }
                    return true;
                });
            });
            hostReady[key].catch(function () { delete hostReady[key]; });
        }
        return hostReady[key];
    }

    function host(fn, args) {
        if (IS_PR && PR_FNS.indexOf(fn) < 0) { return Promise.reject(new Error("NOT_IN_PREMIERE")); }
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
        if (m === "MK_GONE") { return "Этого уже нет в композиции. Нажмите кнопку ещё раз — блок создаст новое."; }
        if (m === "HOST_UNAVAILABLE") { return "Панель открыта вне " + APP_NAME + ", связи с программой нет."; }
        if (m === "HOST_NOT_LOADED" && e.hostDetail) {
            return APP_NAME + " не смог загрузить скрипт панели (строка " + e.hostDetail + "). Пришлите этот текст разработчику.";
        }
        if (m === "HOST_NOT_LOADED" || m === "HOST_ERROR" || m === "HOST_BAD_REPLY") {
            return APP_NAME + " не ответил панели. Закройте и снова откройте её в меню Window > Extensions.";
        }
        if (m === "NOT_IN_PREMIERE") { return "В Premiere Pro этого инструмента пока нет — он работает в After Effects."; }
        if (m === "REF_NOT_IN_PREMIERE") { return "В Premiere Pro референсы пока не поддерживаются: опишите задачу словами."; }
        if (m === "NO_SEQUENCE") { return "Откройте секвенцию: инструмент работает с открытой секвенцией."; }
        if (m === "NO_FREE_TRACK") { return "На всех дорожках под указателем уже есть клипы. Добавьте пустую дорожку и нажмите ещё раз."; }
        if (m === "NO_KEYS_ON_CLIPS") { return "У выделенных клипов нет ключей. Поставьте хотя бы два ключа (секундомер в Effect Controls) и нажмите ещё раз."; }
        if (IS_PR && m === "STAGGER_NEEDS_TWO") { return "Для лесенки выделите хотя бы два клипа."; }
        if (IS_PR && m === "ALIGN_NEEDS_TWO") { return "Чтобы выровнять клипы друг по другу, выделите хотя бы два. Один клип выравнивается по кадру."; }
        if (IS_PR && m === "DISTRIBUTE_NEEDS_THREE") { return "Чтобы распределить, выделите хотя бы три клипа."; }
        if (IS_PR && m === "CO_NOT_PHOTO") { return "Вырезка работает с фото: выделите на таймлайне клип-картинку (JPG, PNG…) и нажмите ещё раз."; }
        if (m === "NO_CLIPS") { return "Выделите видеоклипы на таймлайне и щёлкните ещё раз."; }
        if (m === "NO_CUT") { return "Поставьте указатель на стык двух клипов (или выделите клипы у стыка) и щёлкните ещё раз."; }
        if (m === "NO_TRANSITION") { return "Premiere Pro не нашёл этот встроенный переход. Возьмите другой или наш из разделов «Зум», «Панорама», «Поворот»."; }
        if (m === "IMPORT_FAILED") { return "Premiere Pro не смог импортировать файл."; }
        if (m === "NO_NEW_SEQUENCE") { return "Premiere Pro не создал секвенцию."; }
        if (m === "NODE_UNAVAILABLE") { return "Панель не получила доступ к файлам (Node.js выключен)."; }
        if (m === "NO_H264") { return IS_PR ? "Не нашёл в Premiere Pro настройку H.264 (MP4) для экспорта." : "В After Effects нет настройки H.264 (MP4) — нужен After Effects 2023 или новее. Или включите «Через Media Encoder»."; }
        if (m === "EXPORT_NO_FOLDER") { return "Не получилось создать папку для видео. " + FILE_ACCESS_HINT; }
        if (m === "EXPORT_BUSY") { return "After Effects уже что-то сохраняет (Render Queue). Дождитесь конца и попробуйте снова."; }
        if (m === "BAD_EXPORT_SIZE") { return "Размер видео — от 16 до 16384 пикселей."; }
        if (m === "NO_RENDER_QUEUE") { return "У After Effects не нашлось Render Queue."; }
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
        if (m === "OR_NO_CAROUSEL") { return "Сначала создайте карусель (или выделите её слой «Карусель: управление»)."; }
        if (m === "OR_NO_PHOTOS") { return "Выделите фото или видео в окне Project и нажмите «Фото в карточки» ещё раз."; }
        if (m === "GL_NO_SHAPE") { return "Нарисуйте фигуру (пером или прямоугольником), выделите её и нажмите «Сделать стеклом»."; }
        if (m === "LOGO_NOT_FOUND") { return "Файл логотипа не найден. Удалите его из проекта и добавьте снова."; }
        if (m === "ICON_NOT_FOUND") { return "Файл иконки не найден. Удалите её из проекта и добавьте снова."; }
        if (m === "BR_NO_TEXT") { return "Выделите текстовый слой в композиции и нажмите ещё раз."; }
        if (m === "SM_ONE_PIECE") { return "В этом шейпе одна фигура — делить нечего. Чтобы собрать шейпы в один, выделите несколько шейп-слоёв."; }
        if (m === "SM_NOT_SHAPE") { return "Разделить можно шейп-слой с несколькими группами или слой с несколькими масками. Чтобы собрать, выделите несколько шейп-слоёв."; }
        if (m === "SM_NEED_SHAPES") { return "Чтобы собрать в один, выделите хотя бы два шейп-слоя."; }
        if (m === "PF_NEED_SHAPES") { return "Для Pathfinder выделите хотя бы два шейп-слоя."; }
        if (m === "NO_TEXT_LAYER") { return "Выделите текстовый слой — плашка встанет под ним."; }
        if (m === "RB_NO_PATH") { return "Не нашёл линию: нарисуйте её пером (маска или путь шейпа), выделите этот слой и нажмите ещё раз. Или выберите готовую форму."; }
        if (m === "GRID_TOO_TIGHT") { return "Отступы больше самой сетки: уменьшите отступ или число строк и столбцов."; }
        if (m === "SM_LOCKED") { return "Слой заблокирован (замок на таймлайне). Снимите замок и нажмите ещё раз."; }
        if (m === "DC_NO_PRECOMP") { return "Выделите слой-прекомпозицию (слой, внутри которого другая композиция) и нажмите ещё раз."; }
        if (m === "CO_NOT_PHOTO") { return "Cut out работает с фото: выделите слой, у которого источник — файл-картинка (JPG, PNG, PSD…), и нажмите ещё раз."; }
        if (m === "CO_NOT_STILL") { return "Cut out вырезает фон на фото, а это видео. Для видео в After Effects есть Roto Brush."; }
        if (m === "CO_MISSING") { return "Файл этого фото не найден на диске. Верните его на место (File > Replace Footage) и нажмите ещё раз."; }
        if (m === "CO_FORMAT") { return "Панель не смогла открыть этот файл картинки. Сохраните фото как JPG или PNG и замените им слой."; }
        if (m === "CO_LAYER_GONE") { return "Слоя, с которого открыли фото, больше нет в открытой композиции. Откройте ту композицию и нажмите Cut out ещё раз."; }
        if (m === "CO_NOT_SAVED") { return "Не удалось сохранить картинку без фона на диск. Проверьте, что в папке проекта можно записывать файлы."; }
        if (m === "STAGGER_NEEDS_TWO") { return "Для лесенки выделите хотя бы два слоя."; }
        if (m === "KA_NO_KEYS") { return "У выделенных слоёв нет ключей. Выделите ключи на таймлайне (или слои с анимацией) и нажмите ещё раз."; }
        if (m === "KA_NEED_TWO") { return "Нужно хотя бы два ключа на одном свойстве: выделите их и нажмите ещё раз."; }
        if (m === "STAGGER_NO_KEYS") { return "Для лесенки нужно хотя бы два слоя с ключами. Чтобы сдвинуть слои целиком, выберите «Слои»."; }
        if (m === "DISTRIBUTE_NEEDS_THREE") { return "Чтобы распределить слои, выделите три или больше: крайние останутся на месте, остальные встанут между ними через равные промежутки."; }
        if (m === "ALIGN_NEEDS_TWO") { return "Чтобы выровнять слои друг по другу, выделите хотя бы два. Один слой выравнивается по композиции."; }
        return m;
    }

    // ------------------------------------------------------------ settings

    var DESIGN_SET = 2;

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
        if (s.previewPlay !== "hover") { s.previewPlay = "always"; }
        ["accent", "bg", "bgTools", "bgMotion", "bgShape", "bgBrand"].forEach(function (k) { var c = parseHex(s[k]); s[k] = c ? c.hex : DEFAULTS[k]; });
        if (!PROVIDERS.hasOwnProperty(s.provider)) { s.provider = "claude"; }
        if (!knownModel(OPENAI_MODELS, s.openaiModel)) { s.openaiModel = OPENAI_MODELS[0].id; }
        if (!motionStyleOf(s.motionStyle)) { s.motionStyle = "normal"; }
        // С этой версии основная тема — «Студия»: при обновлении она ставится всем один раз, потом выбор свой.
        if (s.designSet !== DESIGN_SET) {
            s.design = "studio";
            s.designSet = DESIGN_SET;
            // У того, кто уже пользовался панелью, это сразу сохраняется: дальше он выбирает тему сам.
            if (saved && typeof saved === "object" && Object.keys(saved).length) { try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e2) {} }
        }
        if (DESIGNS.indexOf(s.design) < 0) { s.design = "studio"; }
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
        shareSoon();
    }

    // ---- Общее для After Effects и Premiere Pro: настройки (ключ AI, модель, тема…) и Проекты лежат ещё и
    // в ~/.sayframe/shared.json. Панель, открытая позже, берёт оттуда то, что новее её собственного.
    // Отдельные окна в этом не участвуют.
    var SHARED_STAMP_KEY = "sayframe.shared.v1";
    var SHARED_LOCAL = ["windows", "hotkeys"];   // эти настройки у каждой программы свои
    var sharedTimer = null;
    var sharedRead = false, sharedPending = false;   // пока общий файл не прочитан, ничего в него не пишем

    function sharedKeys() { return [SETTINGS_KEY, "sayframe.brands.v1"]; }
    function sharedPath() { return platform.join(platform.homedir(), ".sayframe", "shared.json"); }

    function shareSoon() {
        if (SOLO || !platform.available) { return; }
        if (!sharedRead) { sharedPending = true; return; }
        if (sharedTimer) { clearTimeout(sharedTimer); }
        sharedTimer = setTimeout(function () { sharedTimer = null; writeShared(); }, 300);
    }

    function writeShared() {
        var data = { t: Date.now(), app: IS_PR ? "PPRO" : "AEFT", items: {} };
        sharedKeys().forEach(function (k) {
            var v = null;
            try { v = window.localStorage.getItem(k); } catch (e) {}
            if (typeof v === "string") { data.items[k] = v; }
        });
        try { window.localStorage.setItem(SHARED_STAMP_KEY, String(data.t)); } catch (e1) {}
        return platform.mkdirp(platform.dirname(sharedPath())).then(function () {
            return platform.writeText(sharedPath(), JSON.stringify(data));
        }).catch(function () {});
    }

    // При запуске: общий файл новее — берём его и перезапускаем панель один раз; старее — обновляем его.
    function readShared() {
        var mine = 0;
        if (SOLO || !platform.available) { sharedRead = true; return Promise.resolve(false); }
        try { mine = Number(window.localStorage.getItem(SHARED_STAMP_KEY) || 0) || 0; } catch (e) {}
        return platform.readText(sharedPath()).then(function (text) {
            var data = JSON.parse(text), items = data && data.items, local, next, changed = [];
            if (!data || !(Number(data.t) > mine) || !items || typeof items !== "object") {
                if (!data || Number(data.t) < mine) { sharedPending = true; }
                return false;
            }
            sharedKeys().forEach(function (k) {
                var before = null;
                if (typeof items[k] !== "string") { return; }
                try { before = window.localStorage.getItem(k); } catch (e0) {}
                if (k === SETTINGS_KEY) {
                    try {
                        next = JSON.parse(items[k]);
                        local = JSON.parse(window.localStorage.getItem(k) || "{}") || {};
                        SHARED_LOCAL.forEach(function (n) { if (local.hasOwnProperty(n)) { next[n] = local[n]; } else { delete next[n]; } });
                        if (JSON.stringify(next) !== JSON.stringify(local)) { window.localStorage.setItem(k, JSON.stringify(next)); changed.push(k); }
                    } catch (e1) {}
                    return;
                }
                if (items[k] !== before) { try { window.localStorage.setItem(k, items[k]); changed.push(k); } catch (e2) {} }
            });
            try { window.localStorage.setItem(SHARED_STAMP_KEY, String(data.t)); } catch (e3) {}
            return changed.length ? changed : false;
        }, function () {
            sharedPending = true;
            return false;
        }).catch(function () { return false; }).then(function (fresh) {
            sharedRead = true;
            if (!fresh && sharedPending) { sharedPending = false; writeShared(); }
            return fresh;
        });
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

    var DESIGNS = ["glass", "ae", "studio"];

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
        document.documentElement.setAttribute("data-design", SOLO ? "ae" : (DESIGNS.indexOf(s.design) >= 0 ? s.design : "studio"));
        document.documentElement.setAttribute("data-fit", s.panelFit === false ? "off" : "on");
        document.documentElement.setAttribute("data-tools", cleanToolSize(s.toolSize));
        root.setProperty("--tz", String(Number(cleanToolSize(s.toolSize)) / 100));
        document.documentElement.setAttribute("data-titles", s.toolTitles === false ? "off" : "on");
        applyHostSkin(SOLO ? true : s.design === "ae");
        toolsHidden = hiddenToolList(s.hiddenTools);
        Array.prototype.forEach.call(document.querySelectorAll(".motion-tools .tool-card[data-tool]"), function (c) {
            c.classList.toggle("tool-off", toolsHidden.indexOf(c.getAttribute("data-tool")) >= 0);
        });
        relayoutTools();
        aiLayout();
        stickTop();
    }

    // Шапка и вкладки стоят на месте, когда раздел прокручивают: вкладки прилипают сразу под шапкой.
    function stickTop() {
        var top = document.querySelector("#app > .top"), app = document.getElementById("app"), tabs = document.getElementById("tabs");
        var shade, cs, pad, gap, h;
        if (!top || !app || !tabs) { return; }
        shade = document.getElementById("topShade");
        if (!shade) {
            shade = document.createElement("div");
            shade.id = "topShade";
            shade.setAttribute("aria-hidden", "true");
            app.insertBefore(shade, app.firstChild);
            app.addEventListener("scroll", function () { app.classList.toggle("app-scrolled", app.scrollTop > 2); });
        }
        cs = window.getComputedStyle(app);
        pad = parseFloat(cs.paddingTop) || 0;
        gap = parseFloat(cs.rowGap || cs.gap) || 0;
        app.style.setProperty("--top-h", top.offsetHeight + "px");
        // Подложка от самого верха панели до низа вкладок (и полпромежутка под ними); места в разделе не занимает.
        h = pad + top.offsetHeight + gap + tabs.offsetHeight + gap / 2;
        shade.style.height = h + "px";
        shade.style.margin = (-pad) + "px " + (-pad) + "px " + (pad - h - gap) + "px";
    }
    window.addEventListener("resize", stickTop);

    // Дизайн «After Effects» берёт цвета у самого After Effects: фон панелей (его меняет ползунок
    // «Яркость» в настройках внешнего вида) и цвет выделения. Остальные оттенки — от фона, как у Adobe.
    var AE_SKIN_VARS = ["--ae-bg", "--ae-card", "--ae-top", "--ae-deep", "--ae-in", "--ae-in2", "--ae-glass", "--ae-glass2", "--ae-line",
        "--ae-btn", "--ae-btn-hi", "--ae-edge", "--ae-text", "--ae-muted", "--ae-faint", "--ae-acc", "--ae-acc-hi", "--ae-acc-rgb"];

    function hostSkin() {
        var env, skin, bg, hi;
        function rgb(c) {
            c = c && c.color ? c.color : c;
            return c && isFinite(c.red) && isFinite(c.green) && isFinite(c.blue) ? { r: Math.round(c.red), g: Math.round(c.green), b: Math.round(c.blue) } : null;
        }
        try { env = JSON.parse(window.__adobe_cep__.getHostEnvironment()); } catch (e) { return null; }
        skin = env && env.appSkinInfo;
        bg = skin && rgb(skin.panelBackgroundColor);
        hi = skin && rgb(skin.systemHighlightColor);
        return bg ? { bg: bg, hi: hi } : null;
    }

    function applyHostSkin(on) {
        var root = document.documentElement.style, skin = on ? hostSkin() : null, b, light, acc, tone;
        if (!skin) { AE_SKIN_VARS.forEach(function (v) { root.removeProperty(v); }); return; }
        b = skin.bg;
        light = 0.299 * b.r + 0.587 * b.g + 0.114 * b.b > 150;
        // На светлом фоне всё, что на тёмном светлее фона, становится темнее, и наоборот.
        tone = function (d) {
            function c(v) { return Math.max(0, Math.min(255, v + (light ? -d : d))); }
            return toHex(c(b.r), c(b.g), c(b.b));
        };
        acc = skin.hi || { r: 45, g: 140, b: 235 };
        // «Чёткий»: фон чуть глубже, чем у After Effects, блоки и кнопки заметно светлее — всё отделено.
        // Акцент After Effects, но сочнее (дальше от серого).
        acc = (function (a) {
            var m = (a.r + a.g + a.b) / 3;
            function c(v) { return Math.round(Math.max(0, Math.min(255, m + (v - m) * 1.2))); }
            return { r: c(a.r), g: c(a.g), b: c(a.b) };
        })(acc);
        root.setProperty("--ae-bg", tone(-12));
        root.setProperty("--ae-card", tone(9));
        root.setProperty("--ae-top", tone(-13));
        root.setProperty("--ae-deep", tone(-22));
        root.setProperty("--ae-in", tone(-15));
        root.setProperty("--ae-in2", tone(-9));
        root.setProperty("--ae-glass", tone(7));
        root.setProperty("--ae-glass2", tone(14));
        root.setProperty("--ae-line", tone(31));
        root.setProperty("--ae-btn", tone(27));
        root.setProperty("--ae-btn-hi", tone(41));
        root.setProperty("--ae-edge", tone(59));
        root.setProperty("--ae-text", light ? "#111111" : "#f2f2f2");
        root.setProperty("--ae-muted", light ? "#3a3a3a" : "#bdbdbd");
        root.setProperty("--ae-faint", light ? "#5e5e5e" : "#8a8a8a");
        root.setProperty("--ae-acc", toHex(acc.r, acc.g, acc.b));
        root.setProperty("--ae-acc-hi", toHex(acc.r + (255 - acc.r) * 0.3, acc.g + (255 - acc.g) * 0.3, acc.b + (255 - acc.b) * 0.3));
        root.setProperty("--ae-acc-rgb", acc.r + ", " + acc.g + ", " + acc.b);
    }

    // ------------------------------------------------------------------ ui

    function el(id) { return document.getElementById(id); }

    var ui = {
        prompt: el("prompt"), styleRow: el("styleRow"), mentionList: el("mentionList"), brandHits: el("brandHits"), brandPics: el("brandPics"), runBtn: el("runBtn"), fixBtn: el("fixBtn"), newBtn: el("newBtn"),
        refBtn: el("refBtn"), refChip: el("refChip"), refText: el("refText"), refClear: el("refClear"),
        exprCard: el("exprCard"), exprToggle: el("exprToggle"), exprBody: el("exprBody"), exprWish: el("exprWish"),
        exprApplyBtn: el("exprApplyBtn"), exprFixBtn: el("exprFixBtn"),
        quickBox: el("quickBox"), aiModes: el("aiModes"), promptFoot: el("promptFoot"), aiExample: el("aiExample"), aiExampleMenu: el("aiExampleMenu"), aiStyleBtn: el("aiStyleBtn"), aiStylePop: el("aiStylePop"), scriptsEmpty: el("scriptsEmpty"), quickToggle: el("quickToggle"), quickAdd: el("quickAdd"), quickEdit: el("quickEdit"), quickList: el("quickList"),
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
        designPick: el("designPick"), panelFit: el("panelFit"), widthRow: el("widthRow"), panelWidth: el("panelWidth"), panelWidthVal: el("panelWidthVal"), toolSize: el("toolSize"), previewPlay: el("previewPlay"), toolTitles: el("toolTitles"), toolLook: el("toolLook"), toolPicker: el("toolPicker"), fxWhere: el("fxWhere"), fxWhereState: el("fxWhereState"), keyWatchState: el("keyWatchState"), pasteAnywhere: el("pasteAnywhere"), statsOn: el("statsOn"), infoTipsOn: el("infoTipsOn"),
        infoTip: el("infoTip"), infoTipTitle: el("infoTipTitle"), infoTipText: el("infoTipText"), infoTipHint: el("infoTipHint"),
        pasteOptsToggle: el("pasteOptsToggle"), pasteHint: el("pasteHint"),
        snapBar: el("snapBar"), snapClose: el("snapClose"), snapImport: el("snapImport"), snapBrowse: el("snapBrowse"), snapSave: el("snapSave"), snapFolder: el("snapFolder"),
        winPicker: el("winPicker"), winNote: el("winNote"), exHead: el("exHead"),
        exportBtn: el("exportBtn"), exportBar: el("exportBar"), exClose: el("exClose"), exSetup: el("exSetup"), exCompName: el("exCompName"), exCompMeta: el("exCompMeta"),
        exTargets: el("exTargets"), exCustom: el("exCustom"), exQualRow: el("exQualRow"), exW: el("exW"), exH: el("exH"), exFitRow: el("exFitRow"), exFitText: el("exFitText"), exFit: el("exFit"),
        exQuality: el("exQuality"), exSpan: el("exSpan"), exFolder: el("exFolder"), exBrowse: el("exBrowse"), exAmeRow: el("exAmeRow"), exAme: el("exAme"), exGo: el("exGo"), exResults: el("exResults"),
        fxBtn: el("fxBtn"), snapBtn: el("snapBtn"), fxConsole: el("fxConsole"), fxSearch: el("fxSearch"), fxSnap: el("fxSnap"), fxClose: el("fxClose"), fxList: el("fxList"),
        orbitPane: el("orbitPane"), orbitStage: el("orbitStage"), orbitRing: el("orbitRing"), orbitLayout: el("orbitLayout"), orbitShape: el("orbitShape"),
        orbitCornerRow: el("orbitCornerRow"), orbitCornerIco: el("orbitCornerIco"), orbitCorners: el("orbitCorners"), orbitCornersVal: el("orbitCornersVal"),
        orbitBackC: el("orbitBackC"), orbitBackHex: el("orbitBackHex"), orbitBackDot: el("orbitBackDot"), orbitPhotos: el("orbitPhotos"), orbitLess: el("orbitLess"), orbitMore: el("orbitMore"), orbitCount: el("orbitCount"),
        orbitRadius: el("orbitRadius"), orbitRadiusVal: el("orbitRadiusVal"), orbitW: el("orbitW"), orbitWVal: el("orbitWVal"), orbitH: el("orbitH"), orbitHVal: el("orbitHVal"),
        orbitNumbers: el("orbitNumbers"), orbitCamera: el("orbitCamera"), orbitBtn: el("orbitBtn"),
        gridStage: el("gridStage"), gridW: el("gridW"), gridH: el("gridH"), gridFit: el("gridFit"), gridRows: el("gridRows"), gridRowsLess: el("gridRowsLess"), gridRowsMore: el("gridRowsMore"),
        gridCols: el("gridCols"), gridColsLess: el("gridColsLess"), gridColsMore: el("gridColsMore"), gridGap: el("gridGap"), gridGapVal: el("gridGapVal"), gridGapName: el("gridGapName"),
        gridGapV: el("gridGapV"), gridGapVVal: el("gridGapVVal"), gridGapVRow: el("gridGapVRow"), gridRound: el("gridRound"), gridRoundVal: el("gridRoundVal"),
        gridRand: el("gridRand"), gridRandVal: el("gridRandVal"), gridSplit: el("gridSplit"), gridSeed: el("gridSeed"), gridDice: el("gridDice"), gridMode: el("gridMode"),
        gridAnim: el("gridAnim"), gridInBtn: el("gridInBtn"), gridOutBtn: el("gridOutBtn"), gridInMini: el("gridInMini"), gridOutMini: el("gridOutMini"), gridInName: el("gridInName"), gridOutName: el("gridOutName"),
        gridPop: el("gridPop"), gridPopTitle: el("gridPopTitle"), gridTabs: el("gridTabs"), gridPopList: el("gridPopList"), gridDur: el("gridDur"), gridDurVal: el("gridDurVal"), gridStep: el("gridStep"), gridStepVal: el("gridStepVal"),
        gridNumbers: el("gridNumbers"), gridBtn: el("gridBtn"),
        acBody: el("acBody"),
        acTabs: el("acTabs"), acSearch: el("acSearch"), acFavOnly: el("acFavOnly"), acModeRow: el("acModeRow"), acMode: el("acMode"),
        acDurRow: el("acDurRow"), acDur: el("acDur"), acDurVal: el("acDurVal"), acColorRow: el("acColorRow"), acColor: el("acColor"),
        acGrid: el("acGrid"), acHint: el("acHint"), acSize: el("acSize"), acFoot: el("acFoot"),
        fxKeys: el("fxKeys"), fxKeysCombo: el("fxKeysCombo"),
        setTabs: el("setTabs"), themeNote: el("themeNote"), accentGroup: el("accentGroup"), bgGroup: el("bgGroup"),
        hotkeys: el("hotkeys"), hotkeysReset: el("hotkeysReset"), hotkeyNote: el("hotkeyNote"),
        organizeBtn: el("organizeBtn"), organizeOptsToggle: el("organizeOptsToggle"), organizeHint: el("organizeHint"),
        decomposeBtn: el("decomposeBtn"), decomposeOptsToggle: el("decomposeOptsToggle"), decomposeHint: el("decomposeHint"),
        cacheBtn: el("cacheBtn"), cacheOptsToggle: el("cacheOptsToggle"), cacheHint: el("cacheHint"),
        nullpBtn: el("nullpBtn"), nullpOptsToggle: el("nullpOptsToggle"), nullpHint: el("nullpHint"),
        splitBtn: el("splitBtn"), splitOptsToggle: el("splitOptsToggle"), splitHint: el("splitHint"),
        tbText: el("tbText"), tbPresets: el("tbPresets"), tbPer: el("tbPer"), tbLook: el("tbLook"), tbStyle: el("tbStyle"),
        tbSwatches: el("tbSwatches"), tbColor: el("tbColor"), tbStrokeColor: el("tbStrokeColor"), tbStrokeRow: el("tbStrokeRow"), tbStrokeWRow: el("tbStrokeWRow"),
        tbPx: el("tbPx"), tbPxVal: el("tbPxVal"), tbPy: el("tbPy"), tbPyVal: el("tbPyVal"), tbRound: el("tbRound"), tbRoundVal: el("tbRoundVal"),
        tbStroke: el("tbStroke"), tbStrokeVal: el("tbStrokeVal"), tbSkew: el("tbSkew"), tbSkewVal: el("tbSkewVal"), tbOpacity: el("tbOpacity"), tbOpacityVal: el("tbOpacityVal"),
        tbShadow: el("tbShadow"), tbGlow: el("tbGlow"), tbBtn: el("tbBtn"),
        glPane: document.querySelector(".gl-pane"), glMode: el("glMode"), glTextPart: el("glTextPart"), glShapePart: el("glShapePart"), glText: el("glText"), glForms: el("glForms"),
        glStage: el("glStage"), glShapes: el("glShapes"), glKinds: el("glKinds"), glKindName: el("glKindName"), glEdges: el("glEdges"), glBlur: el("glBlur"), glBlurVal: el("glBlurVal"),
        glLight: el("glLight"), glLightVal: el("glLightVal"), glSize: el("glSize"), glSizeVal: el("glSizeVal"), glSizeRow: el("glSizeRow"), glAdd: el("glAdd"), glMine: el("glMine"),
        phPhone: el("phPhone"), phModel: el("phModel"), phColors: el("phColors"), phPose: el("phPose"), phSize: el("phSize"), phSizeVal: el("phSizeVal"),
        rbStage: el("rbStage"), rbSeedRow: el("rbSeedRow"), rbSeed: el("rbSeed"), rbDice: el("rbDice"), rbDirRow: el("rbDirRow"), rbDir: el("rbDir"), rbAngle: el("rbAngle"), rbAngleVal: el("rbAngleVal"), rbRunDir: el("rbRunDir"), rbMode: el("rbMode"), rbRibbonOpts: el("rbRibbonOpts"), rbForm: el("rbForm"), rbText: el("rbText"), rbSep: el("rbSep"),
        rbRibColorRow: el("rbRibColorRow"), rbRibColors: el("rbRibColors"), rbTextColors: el("rbTextColors"), rbPaint: el("rbPaint"), rbCustom: el("rbCustom"), rbGradRow: el("rbGradRow"), rbGradA: el("rbGradA"), rbGradB: el("rbGradB"), rbGradBar: el("rbGradBar"), rbGradDir: el("rbGradDir"), rbPairs: el("rbPairs"), rbRingColorRow: el("rbRingColorRow"), rbRibbonSl: el("rbRibbonSl"), rbRingSl: el("rbRingSl"),
        rbRibbonSw: el("rbRibbonSw"), rbRingSw: el("rbRingSw"), rbRun: el("rbRun"), rbOverlap: el("rbOverlap"), rbShadow: el("rbShadow"), rbShadowRow: el("rbShadowRow"), rbBack: el("rbBack"), rbCamera: el("rbCamera"), rbBtn: el("rbBtn"),
        rbWidth: el("rbWidth"), rbWidthVal: el("rbWidthVal"), rbSize: el("rbSize"), rbSizeVal: el("rbSizeVal"), rbSpeed: el("rbSpeed"), rbSpeedVal: el("rbSpeedVal"),
        rbRings: el("rbRings"), rbRingsVal: el("rbRingsVal"), rbRadius: el("rbRadius"), rbRadiusVal: el("rbRadiusVal"), rbTilt: el("rbTilt"), rbTiltVal: el("rbTiltVal"),
        rbRingSpeed: el("rbRingSpeed"), rbRingSpeedVal: el("rbRingSpeedVal"),
        phRound: el("phRound"), phRoundVal: el("phRoundVal"), phScreen: el("phScreen"), phShadow: el("phShadow"), phAppear: el("phAppear"), phBtn: el("phBtn"),
        pfModes: el("pfModes"), pfName: el("pfName"), pfSub: el("pfSub"), pfKeep: el("pfKeep"), pfOptsToggle: el("pfOptsToggle"), pfHint: el("pfHint"),
        unusedBtn: el("unusedBtn"), unusedOptsToggle: el("unusedOptsToggle"), unusedHint: el("unusedHint"),
        cutoutBtn: el("cutoutBtn"), cutoutOptsToggle: el("cutoutOptsToggle"), cutoutHint: el("cutoutHint"),
        cutoutView: el("cutoutView"), cutoutName: el("cutoutName"), cutoutClose: el("cutoutClose"), cutoutBrush: el("cutoutBrush"),
        cutoutStage: el("cutoutStage"), cutoutCanvas: el("cutoutCanvas"), cutoutBusy: el("cutoutBusy"), cutoutNote: el("cutoutNote"),
        cutoutEdge: el("cutoutEdge"), cutoutUndo: el("cutoutUndo"), cutoutReset: el("cutoutReset"), cutoutDone: el("cutoutDone"),
        anchorOptsToggle: el("anchorOptsToggle"), anchorSide: el("anchorSide"), alignOptsToggle: el("alignOptsToggle"), alignSide: el("alignSide"), distLabel: el("distLabel"), distGrid: el("distGrid"),
        staggerOptsToggle: el("staggerOptsToggle"), staggerPrevText: el("staggerPrevText"),
        staggerWhat: el("staggerWhat"), staggerStep: el("staggerStep"), staggerLess: el("staggerLess"), staggerMore: el("staggerMore"),
        staggerOrder: el("staggerOrder"), staggerOrderName: el("staggerOrderName"), staggerBtn: el("staggerBtn"), staggerActs: el("staggerActs"), staggerLayerActs: el("staggerLayerActs"),
        frames: el("frames"), settingsSaved: el("settingsSaved"),
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
        brandTop: el("brandTop"), brandSubs: el("brandSubs"), brandBar: el("brandBar"), brandMore: el("brandMore"), brandMenu: el("brandMenu"), brandSubChips: el("brandSubChips"), brandLogoCap: el("brandLogoCap"), brandShareRow: el("brandShareRow"), brandExport: el("brandExport"), brandImport: el("brandImport"),
        brandFirstImport: el("brandFirstImport"), brandAsk: el("brandAsk"), brandAskText: el("brandAskText"), brandAskUpdate: el("brandAskUpdate"),
        brandAskCopy: el("brandAskCopy"), brandAskCancel: el("brandAskCancel"),
        brandTextName: el("brandTextName"), brandTextValue: el("brandTextValue"), brandTextAdd: el("brandTextAdd"), brandFormats: el("brandFormats"),
        shapeTools: el("shapeTools"), shapeGridCells: el("shapeGridCells"), shapePinLine: el("shapePinLine"),
        ecOptsToggle: el("ecOptsToggle"), ecOpts: el("ecOpts"), ecCopy: el("ecCopy"), ecPasteEase: el("ecPasteEase"), ecPasteValue: el("ecPasteValue"),
        ecThrough: el("ecThrough"), ecClip: el("ecClip"),
        easeIn: el("easeIn"), easeOut: el("easeOut"), easeInVal: el("easeInVal"), easeOutVal: el("easeOutVal"),
        easeLink: el("easeLink"), easeBothBtn: el("easeBothBtn"),
        motionTools: el("motionTools"), alignGrid: el("alignGrid"), alignTo: el("alignTo"), easeCurve: el("easeCurve"), easeCurveToggle: el("easeCurveToggle"), easeCurvePath: el("easeCurvePath"), easeView: el("easeView"), easeState: el("easeState"),
        easeSpeedFill: el("easeSpeedFill"), easeSpeedPath: el("easeSpeedPath"), easeSpeedHandles: el("easeSpeedHandles"), easeSpeedPeak: el("easeSpeedPeak"), easeSpeedEnds: el("easeSpeedEnds"), easeHandles: el("easeHandles"),
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

    // Premiere: только AI и Проекты. Кнопки остальных вкладок убираются, их разделы остаются скрытыми.
    function setupPremiere() {
        var root = document.documentElement, badge;
        if (!IS_PR) { return; }
        root.setAttribute("data-app", "ppro");
        ["shape"].forEach(function (k) {
            TABS[k].view.hidden = true;
            if (TABS[k].tab.parentNode) { TABS[k].tab.parentNode.removeChild(TABS[k].tab); }
            delete TABS[k];
        });
        ui.snapBtn.hidden = true;
        ui.fxBtn.hidden = true;
        ui.exportBtn.setAttribute("data-info", "Быстрый экспорт|Сохраняет открытую секвенцию в MP4 для Reels, YouTube, Telegram, TikTok или поста — сразу в нужном размере.");
        // «Анимация» в Premiere — «Монтаж»: переходы, движения и звуки.
        TABS.tools.tab.querySelector(".tab-label").textContent = "Монтаж";
        TABS.tools.tab.setAttribute("aria-label", "Монтаж");
        TABS.tools.tab.setAttribute("data-info", "Монтаж|Переходы на стык клипов, движения появления и исчезновения, звуки. Щелчок по карточке — сразу на таймлайн; всё ставится ключами, их видно и можно править в Effect Controls.");
        ui.tabClaude.setAttribute("data-info", "AI|Опишите задачу словами — Claude напишет скрипт и выполнит его в Premiere Pro: клипы, дорожки, маркеры, эффекты, экспорт.");
        ui.exAme.parentNode.querySelector("span:last-child").textContent = "Через Media Encoder — Premiere не занят";
        ui.exAmeRow.title = "Media Encoder сохраняет видео в фоне, а Premiere Pro в это время свободен.";
        ui.prompt.placeholder = "Опишите, что сделать в секвенции. @ — логотип, цвет или иконка из брендбука";
        ui.prompt.setAttribute("data-ph", ui.prompt.placeholder);
        if (document.documentElement.getAttribute("data-design") === "studio") { ui.prompt.placeholder = "Что сделать в секвенции?"; }
        ui.exSpan.querySelector('[data-v="all"] span').textContent = "Всю секвенцию";
        ui.exSpan.querySelector('[data-v="work"] span').textContent = "От In до Out";
        setupPremiereTools();
        badge = document.createElement("span");
        badge.className = "app-badge";
        badge.textContent = "Premiere";
        document.querySelector("header.top .brand").appendChild(badge);
    }

    // ---- «Инструменты» в Premiere: те же блоки, только для клипов. Плавность — плитки: три настоящих типа ключей
    // Premiere (Bezier, Linear, Hold) и кривые, которые панель запекает ключом на каждом кадре между ключами.
    var PR_EASE_KEY = "sayframe.prEase.v1";        // выбранная плитка
    var PR_BAKED_KEY = "sayframe.prBaked.v1";      // где мы запекали: какие ключи были исходными
    var PR_EASES = [
        ["Ключи Premiere", [["ease", "Плавно"], ["lin", "Ровно"], ["hold", "Стоп"]]],
        ["По кадрам — точно по кривой", [["inn", "Разгон"], ["out", "Торможение"], ["auto", "Авто"], ["cont", "Непрерывно"], ["over", "С перелётом"], ["bounce", "Отскок"],
            ["elastic", "Пружина"], ["sharp", "Резко"], ["soft", "Очень плавно"], ["slow", "Медленный старт"], ["stop", "Мягкая остановка"], ["back", "Назад-вперёд"]]]
    ];
    var PR_EASE_F = {
        ease: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }, lin: function (t) { return t; }, hold: function (t) { return t < 0.97 ? 0 : 1; },
        inn: function (t) { return t * t * t; }, out: function (t) { return 1 - Math.pow(1 - t, 3); },
        auto: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }, cont: function (t) { return t * t * (3 - 2 * t); },
        over: function (t) { return sfCurve(t, "over"); }, bounce: function (t) { return sfCurve(t, "bounce"); }, elastic: function (t) { return sfCurve(t, "elastic"); },
        sharp: function (t) { return t <= 0 ? 0 : (t >= 1 ? 1 : (t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2)); },
        soft: function (t) { return t < 0.5 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2; },
        slow: function (t) { return t <= 0 ? 0 : Math.pow(2, 10 * t - 10); }, stop: function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); },
        back: function (t) { var c = 2.5949095; return t < 0.5 ? (Math.pow(2 * t, 2) * ((c + 1) * 2 * t - c)) / 2 : (Math.pow(2 * t - 2, 2) * ((c + 1) * (t * 2 - 2) + c) + 2) / 2; }
    };

    function prEaseIcon(f) {
        var d = "", i, t;
        for (i = 0; i <= 40; i++) { t = i / 40; d += (i ? "L" : "M") + (4 + t * 40).toFixed(1) + " " + (25 - f(t) * 18).toFixed(1); }
        return '<svg viewBox="0 0 48 32" aria-hidden="true"><path d="' + d + '"/></svg>';
    }

    function prEaseKind() {
        var k;
        try { k = window.localStorage.getItem(PR_EASE_KEY); } catch (e) { k = null; }
        return PR_EASE_F[k] ? k : "ease";
    }

    function prBaked() {
        var m;
        try { m = JSON.parse(window.localStorage.getItem(PR_BAKED_KEY) || "{}"); } catch (e) { m = {}; }
        return m && typeof m === "object" ? m : {};
    }

    function setupPremiereTools() {
        var ease = document.querySelector('[data-tool="ease"]'), box, go, kind = prEaseKind(), t;
        ["cache", "nullp", "decompose"].forEach(function (k) { var c = document.querySelector('[data-tool="' + k + '"]'); if (c) { c.hidden = true; c.classList.add("pr-off"); } });
        if (ease) {
            ease.classList.add("pr-ease-card");
            box = document.createElement("div");
            box.id = "prEase";
            box.className = "pr-ease";
            box.innerHTML = PR_EASES.map(function (g) {
                return '<div class="pr-ease-group">' + g[0] + '</div><div class="pr-ease-grid">' + g[1].map(function (e) {
                    return '<button type="button" class="pr-ease-btn" data-ease="' + e[0] + '" aria-pressed="' + (e[0] === kind ? "true" : "false") + '">' + prEaseIcon(PR_EASE_F[e[0]]) + '<span>' + e[1] + '</span></button>';
                }).join("") + '</div>';
            }).join("");
            go = document.createElement("button");
            go.id = "prEaseGo";
            go.type = "button";
            go.className = "shift-do shift-go pr-ease-go";
            go.textContent = "Поставить на выделенные клипы";
            go.title = "Premiere не говорит, какие ключи выделены: плавность встаёт на все ключи выделенных клипов.";
            box.appendChild(go);
            ease.appendChild(box);
            box.addEventListener("click", function (e) {
                var b = e.target && e.target.closest ? e.target.closest(".pr-ease-btn") : null;
                if (!b) { return; }
                try { window.localStorage.setItem(PR_EASE_KEY, b.getAttribute("data-ease")); } catch (e1) {}
                Array.prototype.forEach.call(box.querySelectorAll(".pr-ease-btn"), function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
            });
            go.addEventListener("click", onPrEase);
        }
        t = document.querySelector('#alignTo option[value="comp"]'); if (t) { t.textContent = "Кадру"; }
        t = document.querySelector('#alignTo option[value="selection"]'); if (t) { t.textContent = "Выделенным клипам"; }
        Array.prototype.forEach.call(document.querySelectorAll('#viewMotion [data-v="layer"] span, #distLabel'), function (n) { n.textContent = n.textContent.replace("Слои", "Клипы").replace("слои", "клипы"); });
    }

    async function onPrEase() {
        var kind = prEaseKind(), res, all, k, name = "";
        if (busy) { return; }
        PR_EASES.forEach(function (g) { g[1].forEach(function (e) { if (e[0] === kind) { name = e[1]; } }); });
        setBusy(true);
        setStatus("Ставлю плавность «" + name + "»…", "busy");
        try {
            all = prBaked();
            res = await host("easePR", [kind, all]);
            for (k in res.baked) { if (res.baked.hasOwnProperty(k)) { all[k] = res.baked[k]; } }
            try { window.localStorage.setItem(PR_BAKED_KEY, JSON.stringify(all)); } catch (e1) {}
            setBusy(false);
            setStatus("Плавность «" + name + "»: " + plural(res.clips, "клип", "клипа", "клипов") + ", " + plural(res.params, "свойство", "свойства", "свойств") +
                (res.isNative ? ". Это настоящие ключи Premiere — их можно двигать руками." : ", добавлено " + plural(res.keys, "ключ", "ключа", "ключей") + " по кадрам. Другой тип плавности сначала уберёт их."), "done");
        } catch (e) {
            toolFailed(e);
        }
    }

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
        document.documentElement.setAttribute("data-tab", name);
        applyTheme(draft || settings);
        if (name === "motion" || name === "shape") { relayoutTools(); }
        if (!SOLO) { try { window.localStorage.setItem(TAB_KEY, name); } catch (e) {} }
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
        // Внизу видна одна строка (кроме ошибок); весь текст — при наведении.
        ui.status.title = text;
        ui.statusBox.className = "status" + (kind ? " " + kind : "");
    }

    function setBusy(on) {
        // Новое действие: прежний «Стоп» к нему не относится, расход считается заново.
        if (on && !busy) { aiStop = { requested: false, waiters: [] }; opSpend = null; showSpend(); }
        busy = on;
        ui.runBtn.disabled = on;
        if (ui.planBuild) { ui.planBuild.disabled = on; ui.planChange.disabled = on; }
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
        ui.splitBtn.disabled = on;
        Array.prototype.forEach.call(ui.pfModes.querySelectorAll("button"), function (b) { b.disabled = on; });
        if (ui.orbitBtn) { ui.orbitBtn.disabled = on; }
        if (ui.gridBtn) { ui.gridBtn.disabled = on; }
        if (ui.tbBtn) { ui.tbBtn.disabled = on; }
        if (ui.phBtn) { ui.phBtn.disabled = on; }
        if (ui.rbBtn) { ui.rbBtn.disabled = on; }
        ui.unusedBtn.disabled = on;
        ui.cutoutBtn.disabled = on;
        ui.fxBtn.disabled = on;
        ui.snapBtn.disabled = on;
        ui.exportBtn.disabled = on;
        ui.exGo.disabled = on || !exInfo;
        ui.exBrowse.disabled = on;
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
        var out = [{ role: "system", content: system || (IS_PR ? PR_SYSTEM_PROMPT : SYSTEM_PROMPT) }];
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
            system: [{ type: "text", text: system || (IS_PR ? PR_SYSTEM_PROMPT : SYSTEM_PROMPT), cache_control: { type: "ephemeral" } }],
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
            if (sfStyleName(settings.motionStyle) !== "normal" && code.indexOf("try { SF.style(") !== 0) { code = 'try { SF.style("' + sfStyleName(settings.motionStyle) + '"); } catch (eSF) {} ' + code; }
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
                    if (sfStyleName(settings.motionStyle) !== "normal") { code = 'try { SF.style("' + sfStyleName(settings.motionStyle) + '"); } catch (eSF) {} ' + code; }
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
        var info, body, sent, hits, note, pics, planRes, picBlocks = [];
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
        hidePlan();
        planState = null;
        // Длинное видео — по сценам: план, композиция нужной длины, по скрипту на сцену.
        if (sceneNeeded(sent)) {
            pendingRef = null;
            closeMention();
            beginRun(text.replace(/\s+/g, " "));
            await runByScenes(text, sent, info, picBlocks, note);
            endRun();
            return;
        }
        // «Студия»: сначала план по секундам; простые команды AI выполняет сразу.
        if (planMode()) {
            if (!aiKey()) { setStatus("Нужен " + providerOf().keyLabel.replace(/^Ключ/, "ключ") + ". Вставьте его в настройках.", "error"); openSettings(); return; }
            planRes = await requestPlan({ text: text.replace(/\s+/g, " "), info: info, sent: sent,
                content: sent ? picBlocks.concat(framesContent(sent.frames, referenceNote(sent) + "\n\n" + body)) : picBlocks.length ? picBlocks.concat([{ type: "text", text: body }]) : body });
            if (planRes !== "direct") { return; }
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
        planState = null;
        hidePlan();
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
        if (ui.scriptsEmpty) { ui.scriptsEmpty.hidden = n > 0; }
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
            var del, ic;
            b.className = "quick-chip";
            b.setAttribute("data-id", q.id);
            b.title = quickEditing ? "Изменить «" + q.name + "»" : q.text;
            label.textContent = q.name;
            ic = document.createElement("i");
            ic.className = "quick-ic";
            ic.setAttribute("aria-hidden", "true");
            ic.textContent = QUICK_ICONS[q.id] || "✦";
            b.appendChild(label);
            b.appendChild(ic);
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
        if (quickEditing && flowOn()) {
            // «Студия»: в режиме правки последняя плитка — «Своя задача» (в других дизайнах для этого «+» в заголовке).
            reset = document.createElement("button");
            reset.className = "quick-new";
            reset.setAttribute("data-act", "new");
            reset.innerHTML = "<span>Своя задача</span><i class=\"quick-ic\" aria-hidden=\"true\">+</i>";
            reset.title = "Сохранить свою задачу: текст из поля станет плиткой";
            reset.disabled = busy;
            ui.quickList.appendChild(reset);
        }
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
            var nw = t.closest ? t.closest(".quick-new") : null;
            var act = nw ? "new" : t.getAttribute ? t.getAttribute("data-act") : null;
            var chip = t.closest ? t.closest(".quick-chip") : null;
            var q = chip ? quickById(chip.getAttribute("data-id")) : null;
            if (busy) { return; }
            if (act === "new") { openQuickForm(null); return; }
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
            choice = IS_PR ? "plain" : await modal({
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

            if (res.placed === "seq") {
                made = "Картинка вставлена в «" + res.compName + "» у указателя, дорожка " + res.track + ". Файл — в корзине «" + PASTE_BIN + "».";
            } else if (res.placed === "comp-precomp") {
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

        // Превью анимаций: играют всегда или только под курсором. Карточки перестраиваются сразу.
        ui.previewPlay.addEventListener("click", function (e) {
            var b = e.target && e.target.closest ? e.target.closest("button[data-value]") : null;
            var v = b ? b.getAttribute("data-value") : null;
            if (!draft || (v !== "always" && v !== "hover")) { return; }
            draft.previewPlay = v;
            pressGroup(ui.previewPlay, v);
            setTimeout(function () { commitSettings(); renderAc(); }, 0);
        });

        // Дизайн меняется сразу и сразу сохраняется.
        ui.designPick.addEventListener("click", function (e) {
            var b = e.target && e.target.closest ? e.target.closest("button[data-value]") : null;
            var v = b ? b.getAttribute("data-value") : null;
            if (!draft || DESIGNS.indexOf(v) < 0) { return; }
            draft.design = v;
            pressGroup(ui.designPick, v);
            showThemeOpts(v);
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

        // «На всю ширину» и ширина меняются сразу и сразу же сохраняются.
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

    // Настройки разбиты на пять разделов: AI, Темы, Инструменты, Клавиши, Прочее.
    var SET_PANES = ["ai", "theme", "tools", "win", "keys", "more"];
    var setPane = "ai";

    function showSetPane(name) {
        setPane = SET_PANES.indexOf(name) >= 0 ? name : "ai";
        SET_PANES.forEach(function (k) {
            var id = k.charAt(0).toUpperCase() + k.slice(1), on = k === setPane;
            el("setPane" + (k === "ai" ? "AI" : id)).hidden = !on;
            el("setTab" + (k === "ai" ? "AI" : id)).setAttribute("aria-selected", String(on));
            el("setTab" + (k === "ai" ? "AI" : id)).setAttribute("aria-pressed", String(on));
        });
        if (setPane !== "keys") { stopHotkeyEdit(); }
    }

    // Акцент и фон разделов есть только у «Стекла»: у «After Effects» и «Студии» свои цвета, их настройки прячутся.
    var DESIGN_NOTES = { ae: "У темы «After Effects» свои цвета: акцент и фон разделов у неё не меняются.", studio: "У «Студии» свои цвета: акцент и фон разделов у неё не меняются." };

    function showThemeOpts(design) {
        var own = !!DESIGN_NOTES[design];
        ui.accentGroup.hidden = own;
        ui.bgGroup.hidden = own;
        ui.themeNote.hidden = !own;
        ui.themeNote.textContent = DESIGN_NOTES[design] || "";
        // «Студия» раскладывает блоки сама (столбики, свёртка по названию): размер и названия блоков там не действуют.
        ui.toolLook.hidden = design === "studio";
    }

    // Широкие настройки (панель растянута, «На всю ширину»): разделы встают слева столбиком.
    function fitSettings() {
        var card = ui.sheet ? ui.sheet.querySelector(".sheet-card") : null;
        if (card) { card.classList.toggle("set-wide", card.getBoundingClientRect().width >= 680); }
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
        pressGroup(ui.previewPlay, draft.previewPlay === "hover" ? "hover" : "always");
        ui.toolTitles.checked = draft.toolTitles;
        showToolPicker();
        showWindowPicker();
        ui.pasteAnywhere.checked = draft.pasteAnywhere !== false;
        pressGroup(ui.fxWhere, draft.fxWhere === "cursor" ? "cursor" : "panel");
        pressGroup(ui.designPick, DESIGNS.indexOf(draft.design) >= 0 ? draft.design : "studio");
        showThemeOpts(DESIGNS.indexOf(draft.design) >= 0 ? draft.design : "studio");
        ui.statsOn.checked = draft.stats !== false;
        ui.infoTipsOn.checked = draft.infoTips !== false;
        closeFxConsole();
        hotkeyEdit = null;
        ui.hotkeyNote.textContent = "";
        renderHotkeys();
        showSetPane("ai");
        ui.settingsSaved.textContent = "Изменения сохраняются сами.";
        ui.settingsSaved.className = "hint settings-saved";
        settingsChanged = false;
        ui.sheet.hidden = false;
        fitSettings();
        ui.sheet.scrollTop = 0;
    }

    // Настройки сохраняются сами: любое изменение сразу записывается, «×» просто закрывает окно.
    var commitTimer = null, savedFlash = null, settingsChanged = false;

    function commitSettings() {
        var next = {}, k;
        if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
        if (!draft) { return false; }
        keepTypedKey();
        draft.selfCheck = ui.selfCheck.checked;
        draft.alwaysAsk = ui.alwaysAsk.checked;
        draft.brandPics = ui.brandPics.checked;
        draft.toolTitles = ui.toolTitles.checked;
        draft.pasteAnywhere = ui.pasteAnywhere.checked;
        draft.stats = ui.statsOn.checked;
        draft.infoTips = ui.infoTipsOn.checked;
        for (k in draft) { if (draft.hasOwnProperty(k)) { next[k] = draft[k]; } }
        if (JSON.stringify(next) === JSON.stringify(settings)) { return false; }
        settings = next;
        storeSettings(settings);
        registerHotkeys();
        hotkeyHint();
        settingsChanged = true;
        ui.settingsSaved.textContent = "Сохранено ✓";
        ui.settingsSaved.className = "hint settings-saved ok";
        if (savedFlash) { clearTimeout(savedFlash); }
        savedFlash = setTimeout(function () {
            ui.settingsSaved.textContent = "Изменения сохраняются сами.";
            ui.settingsSaved.className = "hint settings-saved";
        }, 1500);
        return true;
    }

    // Щелчок и выбор сохраняются сразу (после своих обработчиков), набор текста — после короткой паузы.
    function scheduleCommit(ms) {
        if (!draft) { return; }
        if (commitTimer) { clearTimeout(commitTimer); }
        commitTimer = setTimeout(commitSettings, ms);
    }

    function closeSettings() {
        commitSettings();
        if (settingsChanged) { setStatus(aiKey() ? "Настройки сохранены." : "Ключ API не задан.", aiKey() ? "done" : ""); }
        settingsChanged = false;
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
            if (settings === trial) { settings = saved; }
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
    var MOTION_LEGACY = { curve: true, order: "ease,anchor,align,paste,organize,easecopy,decompose,cache,nullp,unused,cutout", sizes: "", places: "", pins: "",
        ecOpts: true, pasteOpts: true, organizeOpts: true, decomposeOpts: true, cacheOpts: true, nullpOpts: true, unusedOpts: true, cutoutOpts: true, splitOpts: true, pfOpts: true, anchorOpts: true, alignOpts: true, staggerOpts: true };

    // Так «Инструменты» выглядят после новой установки: блоки-кнопки закреплены сверху, под линией — «Лесенка»,
    // «Якорь», «Выровнять» и «Плавность»; подсказки и списки свёрнуты (их открывает плюс в углу блока).
    // У тех, кто уже настроил панель, сохранённое не меняется; новые блоки встают сверху, ближе к середине.
    var MOTION_DEFAULTS = { easeIn: 60, easeOut: 60, link: true, curve: false, easeView: "speed", anchorKeys: "key", alignTo: "comp",
        order: "paste,unused,easecopy,decompose,organize,cache,nullp,cutout,stagger,anchor,align,ease",
        sizes: "ease=14x0;stagger=12x0;easecopy=17x0",
        places: "paste=0,0;unused=8,0;easecopy=17,0;decompose=34,0;organize=0,5;cache=8,5;nullp=17,5;cutout=25,5;stagger=0,12;anchor=12,12;align=20,12;ease=28,12",
        pins: "paste,unused,easecopy,decompose,organize,cache,nullp,cutout", grid: GRID_VERSION,
        ecOpts: false, ecThrough: false, pasteOpts: false, organizeOpts: false, decomposeOpts: false, cacheOpts: false, nullpOpts: false, unusedOpts: false, cutoutOpts: false, splitOpts: false, pfOpts: false,
        anchorOpts: false, alignOpts: false,
        staggerWhat: "layer", staggerStep: 1, staggerOrder: "asc", staggerOpts: true,
        flowFold: "easecopy,anchor,align", flowSort: "" };
    var STAGGER_ORDERS = ["asc", "random", "desc", "align"];
    var STAGGER_TARGETS = ["layer", "keys"];
    var MAX_STEP_FRAMES = 999;
    var TOOL_NAMES = ["ease", "anchor", "align", "stagger", "paste", "organize", "easecopy", "decompose", "cache", "nullp", "unused", "cutout"];
    var SHAPE_TOOL_NAMES = ["pathfinder", "split"];
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
    var ICON_TOOLS = ["paste", "organize", "easecopy", "decompose", "cache", "nullp", "unused", "cutout", "split"];
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

    // Блоки, которым обычная ширина мала: пять кнопок Pathfinder в ряд.
    var TOOL_WIDE = { pathfinder: 14 };

    function sizeOf(name) {
        return parseSizes(G.st.sizes)[name] || { w: TOOL_WIDE[name] || TOOL_DEFAULT_COLS, h: 0 };
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
        if (m.easeView !== "value") { m.easeView = "speed"; }
        if (STAGGER_TARGETS.indexOf(m.staggerWhat) < 0) { m.staggerWhat = m.staggerWhat === "in" || m.staggerWhat === "out" ? "keys" : "layer"; }
        if (STAGGER_ORDERS.indexOf(m.staggerOrder) < 0) { m.staggerOrder = "asc"; }
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
            { key: "splitOpts", button: ui.splitOptsToggle, part: ui.splitHint, hide: "Скрыть подсказку", show: "Показать подсказку" },
            { key: "pfOpts", button: ui.pfOptsToggle, part: ui.pfHint, hide: "Скрыть подсказку", show: "Показать подсказку" },
            { key: "staggerOpts", button: ui.staggerOptsToggle, part: ui.staggerPrevText, hide: "Скрыть подсказку", show: "Показать подсказку" }
        ];
    }

    // У SVG нет свойства hidden, поэтому меняем сам атрибут.
    function showFoldParts() {
        var parts = foldParts();
        var i, j, f, open, label, opt, inFlow;
        for (i = 0; i < parts.length; i++) {
            f = parts[i];
            // «Студия»: подписи и кривая всегда открыты, а текстовые подсказки спрятаны — их видно при наведении на блок.
            inFlow = !!(f.part.closest && f.part.closest(".tool-flow"));
            open = inFlow ? f.hide !== "Скрыть подсказку" : motion[f.key] !== false;
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
        drawEaseSpeed();
        pressGroupV(ui.easeView, motion.easeView);
        ui.easeCurve.setAttribute("data-view", motion.easeView);
        showEaseState();
    }

    // График скорости, как Speed Graph в After Effects: та же кривая Безье, но по высоте — скорость.
    // Слева выход из первого ключа (easeOut), справа вход во второй (easeIn); скорость у ключей — ноль.
    function easeSpeedPoints(o, i) {
        var pts = [], k, t, u, dx, dy;
        o = Math.max(0.001, o / 100);
        i = Math.max(0.001, i / 100);
        for (k = 0; k <= 80; k++) {
            t = k / 80; u = 1 - t;
            dx = 3 * u * u * o + 6 * u * t * (1 - i - o) + 3 * t * t * i;
            dy = 6 * u * t;
            pts.push({ x: 3 * u * u * t * o + 3 * u * t * t * (1 - i) + t * t * t, s: dx > 1e-6 ? dy / dx : 0 });
        }
        return pts;
    }

    function drawEaseSpeed() {
        var x0 = 12, x1 = 188, base = 76, top = 12, pts = easeSpeedPoints(motion.easeOut, motion.easeIn), max = 0, d = "", pk = null;
        pts.forEach(function (q) { if (q.s > max) { max = q.s; pk = q; } });
        pts.forEach(function (q, k) {
            d += (k ? "L" : "M") + (x0 + q.x * (x1 - x0)).toFixed(1) + " " + (base - (max ? q.s / max : 0) * (base - top)).toFixed(1);
        });
        ui.easeSpeedPath.setAttribute("d", d);
        ui.easeSpeedFill.setAttribute("d", d + "L" + x1 + " " + base + "L" + x0 + " " + base + "Z");
        ui.easeSpeedHandles.setAttribute("d", "M" + x0 + " " + base + "H" + (x0 + (x1 - x0) * motion.easeOut / 100).toFixed(1) + "M" + x1 + " " + base + "H" + (x1 - (x1 - x0) * motion.easeIn / 100).toFixed(1));
        ui.easeSpeedEnds.setAttribute("d", "M" + (x0 + (x1 - x0) * motion.easeOut / 100).toFixed(1) + " " + base + "h0M" + (x1 - (x1 - x0) * motion.easeIn / 100).toFixed(1) + " " + base + "h0");
        ui.easeSpeedPeak.setAttribute("d", pk ? "M" + (x0 + pk.x * (x1 - x0)).toFixed(1) + " " + top + "h0" : "");
    }

    // Что показывает график: выделенные ключи (их плавность читается из After Effects) или ползунки.
    var easeSeen = { sig: "", keys: 0, name: "", mixed: false };

    function showEaseState() {
        var t;
        if (easeSeen.keys >= 2 && easeSeen.name) {
            t = "Выделено " + plural(easeSeen.keys, "ключ", "ключа", "ключей") + ", «" + easeSeen.name + "»: выход " + motion.easeOut + "%, вход " + motion.easeIn + "%." +
                (easeSeen.mixed ? " У других пар плавность другая — показана первая." : "");
        } else if (easeSeen.keys === 1) {
            t = "Выделен один ключ: выделите два и больше, чтобы увидеть их плавность.";
        } else {
            t = "";   // ничего не выделено: график показывает ползунки, строка не нужна
        }
        ui.easeState.textContent = t;
        ui.easeCurve.title = t || "Ключи не выделены — график показывает настройку ползунков. Выделите ключи, и он покажет их плавность.";
    }

    // Раз в секунду, пока открыты «Инструменты»: какие ключи выделены. Новое выделение — ползунки и график встают по нему.
    async function pollEaseState() {
        var r, sig;
        if (busy || liveEase.running || liveEase.pending || ui.viewMotion.hidden || document.hidden || motion.curve === false) { return; }
        try { r = await host("easeRead", []); } catch (e) { return; }
        sig = r.keys + "|" + (r.name || "") + "|" + (r.out === undefined ? "" : r.out + "/" + r["in"]);
        if (sig === easeSeen.sig) { return; }
        easeSeen = { sig: sig, keys: r.keys || 0, name: r.name || "", mixed: !!r.mixed };
        if (r.name && typeof r.out === "number" && typeof r["in"] === "number") {
            motion.easeOut = clampPercent(r.out);
            motion.easeIn = clampPercent(r["in"]);
            if (motion.easeOut !== motion.easeIn) { motion.link = false; }
            storeMotion();
        }
        drawEase();
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
        Array.prototype.forEach.call(document.querySelectorAll("#anchorOpts button"), function (b) { b.disabled = on; });
        for (i = 0; i < cells.length; i++) { cells[i].disabled = on; }
        cells = ui.alignGrid.querySelectorAll("button");
        ui.alignTo.disabled = on;
        for (i = 0; i < cells.length; i++) { cells[i].disabled = on; }
        cells = ui.distGrid.querySelectorAll("button");
        for (i = 0; i < cells.length; i++) { cells[i].disabled = on; }
        cells = [ui.staggerStep, ui.staggerLess, ui.staggerMore, ui.staggerBtn];
        for (i = 0; i < cells.length; i++) { cells[i].disabled = on; }
        [ui.staggerWhat, ui.staggerOrder].forEach(function (g) {
            Array.prototype.forEach.call(g.querySelectorAll("button"), function (b) { b.disabled = on; });
        });
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
        { id: "sfx", label: "Звуки" },
        { id: "orbit", label: "Макеты" }
    ].filter(function (s) {
        // В Premiere Pro вкладка называется «Монтаж»: только то, что Premiere умеет сам — переходы, движения, звуки.
        return !IS_PR || s.id === "trans" || s.id === "anim" || s.id === "sfx";
    });
    var AC_PRESETS = {
        trans: [],
        text: [],
        anim: [],
        graphic: [],
        sfx: [],
        orbit: []
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
    var TR_LIST_AE = [
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
    // Premiere Pro: встроенные переходы Premiere (ставятся на стык) и наши — ключами на двух клипах у стыка.
    // Глитча, засветок и шейпов нет: в Premiere их скриптом не собрать.
    var TR_LIST_PR = [
        ["builtin", "pr-cross-dissolve", "Наплыв"], ["builtin", "pr-film-dissolve", "Плёночный наплыв"], ["builtin", "pr-dip-black", "Через чёрный"],
        ["builtin", "pr-dip-white", "Через белый"], ["builtin", "pr-push", "Сдвиг"], ["builtin", "pr-cross-zoom", "Перекрёстный зум"]
    ].concat(TR_LIST_AE.filter(function (t) {
        return ["zoom-in", "zoom-out", "zoom-in-out", "zoom-hit", "pan-left", "pan-right", "pan-up", "pan-down",
            "rotate", "roll", "zoom-rotate", "shake", "blur-dissolve"].indexOf(t[1]) >= 0;
    }));
    var TR_LIST = IS_PR ? TR_LIST_PR : TR_LIST_AE;
    if (IS_PR) {
        TR_FOLDERS = [
            { id: "all", label: "Все" }, { id: "builtin", label: "Premiere" }, { id: "zoom", label: "Зум" }, { id: "pan", label: "Панорама" },
            { id: "rotate", label: "Поворот" }, { id: "shake", label: "Тряска" }, { id: "fade", label: "Размытие" }
        ];
    }
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
    // ---- «Заготовки» — готовые вещи для монтажёра: эффекты-сборки (жидкое стекло), потом макеты телефонов и т. п.
    // Всё собирается из стандартных эффектов After Effects, без сторонних плагинов.
    var KIT_FOLDERS = [{ id: "all", label: "Все" }, { id: "fx", label: "Эффекты" }];
    // Жидкое стекло переехало блоком в «Макеты»; раздел «Заготовки» пока пуст и спрятан.
    var KIT_LIST = [];
    var KIT_BY_ID = {};
    KIT_LIST.forEach(function (k) { KIT_BY_ID[k[1]] = { folder: k[0] }; AC_PRESETS.kit.push([k[1], k[2]]); });

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
    var AC_DEFAULTS = { sec: "trans", fav: [], mode: "in", dur: 0.6, color: "#ffffff", size: 112, favOnly: false, folder: "all", tfolder: "all", tdur: 0.8, xfolder: "all", xunit: "all", sfolder: "all", pitch: 0, len: 100, vol: 0, gfolder: "all", kfolder: "all" };
    var acState = loadAcState();

    function loadAcState() {
        var s, out = {}, k;
        try { s = JSON.parse(window.localStorage.getItem(AC_KEY) || "{}"); } catch (e) { s = {}; }
        if (!s || typeof s !== "object") { s = {}; }
        for (k in AC_DEFAULTS) {
            if (AC_DEFAULTS.hasOwnProperty(k)) { out[k] = typeof s[k] === typeof AC_DEFAULTS[k] ? s[k] : AC_DEFAULTS[k]; }
        }
        if (!AC_SECTIONS.some(function (x) { return x.id === out.sec; }) && (out.sec !== "edit" || IS_PR)) { out.sec = "trans"; }
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
        if (!KIT_FOLDERS.some(function (f) { return f.id === out.kfolder; })) { out.kfolder = "all"; }
        out.pitch = Math.max(-12, Math.min(12, Math.round(Number(out.pitch)) || 0));
        out.len = Math.max(50, Math.min(200, Math.round((Number(out.len) || 100) / 5) * 5));
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
                if (s.id === "kit" && KIT_BY_ID[p[0]]) { item.folder = KIT_BY_ID[p[0]].folder; }
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
            if (p.sec === "kit") { return acState.kfolder === "all" || p.folder === acState.kfolder; }
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
            // Настоящая волна звука (из sfx/peaks.json); пока она не прочитана — пять полосок-эквалайзер.
            if (SFX_PEAKS && SFX_PEAKS[p.id]) {
                obj.className = "ac-obj ac-wave";
                thumb.classList.add("ac-thumb-wave");
                obj.innerHTML = sfxWaveSvg(SFX_PEAKS[p.id].p, "") + sfxWaveSvg(SFX_PEAKS[p.id].p, "ac-wave-done") + "<i class=\"ac-wave-head\"></i>";
            } else {
                for (i = 0; i < 5; i++) { bar = document.createElement("i"); obj.appendChild(bar); }
            }
        }
        if (p.sec === "kit") {
            // Стекло над цветной картинкой: под ним всё размыто и чуть увеличено, по краю — блик.
            obj.className = "ac-obj ac-kit kit-" + p.id;
            obj.innerHTML = "<i class=\"kit-bg\"><b></b><b></b><b></b></i><i class=\"kit-glass\"><i class=\"kit-lens\"><b></b><b></b><b></b></i></i>";
        }
        thumb.appendChild(obj);
        return thumb;
    }

    function renderAc() {
        var list = acVisible();
        var searching = !!ui.acSearch.value.replace(/\s/g, "") || acState.favOnly;
        var sec = acState.sec;
        var editing = sec === "edit" && !searching;
        var orbitOn = sec === "orbit" && !searching;
        if (sec === "sfx" || searching) { loadSfxPeaks(); }
        if (acSeen) { acSeen.disconnect(); }
        grLive = [];
        ui.acGrid.innerHTML = "";
        ui.acGrid.style.setProperty("--ac-size", acState.size + "px");
        Array.prototype.forEach.call(ui.acTabs.querySelectorAll("button"), function (b) {
            var on = !searching && b.getAttribute("data-sec") === sec;
            b.setAttribute("aria-selected", on ? "true" : "false");
        });
        ui.acFavOnly.setAttribute("aria-pressed", acState.favOnly ? "true" : "false");
        if (el("acEdit")) { el("acEdit").setAttribute("aria-pressed", editing ? "true" : "false"); }
        // «Авто / Наведение» нужен только там, где есть превью-анимации: в «Звуках» и «Макетах» его нет.
        el("acPlay").hidden = !searching && (sec === "sfx" || orbitOn);
        Array.prototype.forEach.call(el("acPlay").querySelectorAll("button[data-value]"), function (b) {
            b.setAttribute("aria-pressed", b.getAttribute("data-value") === (settings.previewPlay === "hover" ? "hover" : "always") ? "true" : "false");
        });
        ui.acModeRow.hidden = editing || !(searching || sec === "text" || sec === "anim");
        // Цвет нужен только графике и переходам-шейпам (шторки, круг).
        ui.acColorRow.hidden = editing || !(searching || sec === "graphic" || (sec === "trans" && acState.tfolder === "shapes"));
        ui.acDurRow.hidden = editing || (!searching && (sec === "sfx" || sec === "graphic" || sec === "kit"));
        ui.acFoot.hidden = editing || orbitOn;
        ui.acHint.hidden = editing || orbitOn;
        if (ui.orbitPane) { ui.orbitPane.hidden = !orbitOn; ui.acBody.hidden = orbitOn; }
        if (orbitOn) {
            renderSfFolders("");
            if (ui.acSndRow) { ui.acSndRow.hidden = true; }
            drawMkFolds();
            drawOrbitPreview();
            drawGridPreview();
            return;
        }
        renderSfFolders(!searching && !editing && (sec === "anim" || sec === "trans" || sec === "text" || sec === "sfx" || sec === "graphic" || sec === "kit") ? sec : "");
        if (ui.acSndRow) {
            ui.acSndRow.hidden = editing || !(searching || sec === "sfx");
            ui.acPitch.value = String(acState.pitch);
            ui.acPitchVal.textContent = pitchText(acState.pitch);
            ui.acLen.value = String(acState.len);
            ui.acLenVal.textContent = lenText(acState.len);
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
        var box = ui.acFolders, key = sec === "trans" ? "tfolder" : (sec === "text" ? "xfolder" : (sec === "sfx" ? "sfolder" : (sec === "graphic" ? "gfolder" : (sec === "kit" ? "kfolder" : "folder"))));
        if (!box) { return; }
        box.hidden = !sec;
        box.parentNode.classList.toggle("with-side", !!sec);
        if (!sec) { return; }
        box.innerHTML = "";
        function head(text) {
            var h = document.createElement("div");
            h.className = "ac-side-h";
            h.textContent = text;
            box.appendChild(h);
        }
        head("Виды");
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
        chips(sec === "trans" ? TR_FOLDERS : (sec === "text" ? TX_FOLDERS : (sec === "sfx" ? SFX_FOLDERS : (sec === "graphic" ? GR_FOLDERS : (sec === "kit" ? KIT_FOLDERS : SF_FOLDERS)))), key, "data-folder");
        if (sec === "text") {
            var br = document.createElement("span");
            br.className = "ac-folder-break";
            box.appendChild(br);
            head("По чему");
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
        if (id === "fade-black" || id === "fade-white" || id === "pr-dip-black" || id === "pr-dip-white") { o.ov = Math.min(1, Math.sin(Math.PI * t) * 1.4); }
        if (id === "pr-push") { o.x = t < 0.5 ? -t : 1 - t; }
        if (id === "pr-cross-zoom") { o.s = 1 + trCut(t, 2, 2); o.blur = 8 * peak; }
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
        var o = trLook(id, /^(wipe|circle)/.test(id) ? 0.12 : (/^pr-dip/.test(id) ? 0.2 : 0.46));
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
            b.animate(/^pr-(cross|film)-dissolve$/.test(p.id) ?
                [{ offset: 0, opacity: 0 }, { offset: 0.15, opacity: 0 }, { offset: 0.65, opacity: 1 }, { offset: 0.9999, opacity: 1 }, { offset: 1, opacity: 0 }] :
                [{ offset: 0, opacity: 0 }, { offset: 0.4, opacity: 0 }, { offset: 0.4001, opacity: 1 }, { offset: 0.9999, opacity: 1 }, { offset: 1, opacity: 0 }],
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
    // В настройках можно выбрать «При наведении»: тогда превью стоит и играет, только пока над ним курсор.
    function acAutoplay(card, play, stop) {
        card.acPlay = play;
        card.acStop = stop;
        if (settings.previewPlay === "hover") {
            card.setAttribute("data-hover-play", "true");
            card.addEventListener("mouseenter", function () { play(); });
            card.addEventListener("mouseleave", function () { stop(); });
            window.requestAnimationFrame(function () { stop(); });
            return;
        }
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
        if (IS_PR && sec === "sfx") {
            return "▶ — послушать с выбранными тоном и длиной. Щелчок по карточке кладёт звук на свободную аудиодорожку у указателя. " +
                "Высота тона меняет только тон, «Длина» — только длину. Выделен звуковой клип — ползунки меняют и его.";
        }
        if (IS_PR && sec === "trans") {
            return "Поставьте указатель на стык двух клипов и щёлкните по карточке. «Premiere» — встроенные переходы Premiere, " +
                "остальные ставятся ключами на оба клипа: половина до стыка, половина после. Ключи видно в Effect Controls.";
        }
        if (IS_PR && sec === "anim") {
            return "Выделите клипы на таймлайне и щёлкните по карточке: в начале (появление), в конце (исчезновение) или в обоих местах " +
                "встанут ключи на Motion и Opacity. Править — в Effect Controls.";
        }
        if (sec === "kit") {
            return "Жидкое стекло: выделите слой-фигуру (шейп, текст, логотип) и щёлкните по карточке — фигура станет стеклом, которое увеличивает, " +
                "размывает и подсвечивает то, что под ним. Ничего не выделено — панель нарисует скруглённый прямоугольник. Двигайте и анимируйте саму фигуру — " +
                "стекло идёт за ней. Сила — в Effect Controls слоя «Жидкое стекло», обводка (толщина, цвет, прозрачность) — у слоя «Стекло: обводка».";
        }
        if (sec === "graphic") {
            return "Щелчок по карточке добавляет графику новым слоем у указателя времени — поверх выделенного слоя или в центре кадра. " +
                "Длительность — длина слоя; цвет, размер и толщина — в Effect Controls.";
        }
        if (sec === "sfx") {
            return "▶ — послушать с выбранными тоном и длиной. Щелчок по карточке кладёт звук в композицию у указателя времени. " +
                "Высота тона меняет только тон, «Длина» — только длину (растягивание клипа, как в Audition). Выделен звуковой слой в композиции — ползунки меняют и его. Отпустили ползунок — звук сразу играет с новыми настройками.";
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
            if (SFX_PEAKS && SFX_PEAKS[p.id]) {
                badge = document.createElement("span");
                badge.className = "ac-dur";
                card.classList.add("has-dur");
                badge.setAttribute("data-id", p.id);
                badge.textContent = sfxDurText(p.id);
                card.appendChild(badge);
            }
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
        if (p.sec === "kit") {
            acAutoplay(card, function () { card.classList.add("kit-play"); }, function () { card.classList.remove("kit-play"); });
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
        box.appendChild(acSlider("Высота тона", -12, 12, 1, Math.round(snd.pitch), pitchText, function (v) { sndChanged({ pitch: v }); }));
        box.appendChild(acSlider("Длина", 50, 200, 5, Math.round(snd.len || 100), lenText, function (v) { sndChanged({ len: v }); }));
        box.appendChild(acSlider("Громкость", -24, 6, 1, Math.round(snd.volume), volText, function (v) { sndChanged({ volume: v }); }));
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

    // ---- звук: высота тона без изменения длины и длина без изменения тона.
    // After Effects умеет только Stretch (быстрее — выше и короче). Поэтому длина — это Stretch слоя, а тон панель
    // пересчитывает сама: растягивает звук по времени кусочками (WSOLA) и проигрывает быстрее — длина та же, тон выше.
    // Сдвиг тона файла = тон + 12·log2(длина/100): Stretch потом понизит его ровно на столько.

    function sndFileShift(pitch, len) { return Math.round((pitch + 12 * Math.log(len / 100) / Math.LN2) * 100) / 100; }

    // WAV (PCM 16/24/32 бит или float) → { rate, ch: [Float32Array…] }.
    function wavDecode(bytes) {
        var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), pos = 12, fmt = null, id, size, n, chs, i, c, bps, off, out, frames;
        if (bytes.length < 44 || dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) { return null; }
        while (pos + 8 <= bytes.length) {
            id = dv.getUint32(pos, false); size = dv.getUint32(pos + 4, true);
            if (id === 0x666d7420) { fmt = { tag: dv.getUint16(pos + 8, true), n: dv.getUint16(pos + 10, true), rate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) }; }
            if (id === 0x64617461 && fmt) {
                n = fmt.n; bps = fmt.bits / 8; frames = Math.floor(Math.min(size, bytes.length - pos - 8) / (bps * n));
                chs = []; for (c = 0; c < n; c++) { chs.push(new Float32Array(frames)); }
                for (i = 0; i < frames; i++) {
                    for (c = 0; c < n; c++) {
                        off = pos + 8 + (i * n + c) * bps;
                        if (fmt.tag === 3 && bps === 4) { out = dv.getFloat32(off, true); }
                        else if (bps === 2) { out = dv.getInt16(off, true) / 32768; }
                        else if (bps === 3) { out = ((dv.getUint8(off) | (dv.getUint8(off + 1) << 8) | (dv.getInt8(off + 2) << 16))) / 8388608; }
                        else if (bps === 4) { out = dv.getInt32(off, true) / 2147483648; }
                        else { out = (dv.getUint8(off) - 128) / 128; }
                        chs[c][i] = out;
                    }
                }
                return { rate: fmt.rate, ch: chs };
            }
            pos += 8 + size + (size & 1);
        }
        return null;
    }

    function wavEncode(snd) {
        var n = snd.ch.length, frames = snd.ch[0].length, len = 44 + frames * n * 2, buf = new ArrayBuffer(len), dv = new DataView(buf), i, c, v, o = 44;
        function str(at, t) { for (var k = 0; k < t.length; k++) { dv.setUint8(at + k, t.charCodeAt(k)); } }
        str(0, "RIFF"); dv.setUint32(4, len - 8, true); str(8, "WAVE"); str(12, "fmt "); dv.setUint32(16, 16, true);
        dv.setUint16(20, 1, true); dv.setUint16(22, n, true); dv.setUint32(24, snd.rate, true); dv.setUint32(28, snd.rate * n * 2, true);
        dv.setUint16(32, n * 2, true); dv.setUint16(34, 16, true); str(36, "data"); dv.setUint32(40, frames * n * 2, true);
        for (i = 0; i < frames; i++) {
            for (c = 0; c < n; c++) { v = Math.max(-1, Math.min(1, snd.ch[c][i])); dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2; }
        }
        return new Uint8Array(buf);
    }

    // Растягивает звук по времени в r раз, не меняя тон: кусочки по ~23 мс, каждый следующий берётся там,
    // где он лучше всего продолжает предыдущий (WSOLA). Смещения ищутся по смеси каналов — каналы не расходятся.
    function sndStretchTime(ch, rate, r) {
        var N = rate >= 88000 ? 2048 : 1024, Hs = N / 2, tol = N / 8, L = N / 4, len = ch[0].length;
        var outLen = Math.max(1, Math.round(len * r)), mono = new Float32Array(len), win = new Float32Array(N);
        var out = ch.map(function () { return new Float32Array(outLen + N); }), norm = new Float32Array(outLen + N);
        var i, k, c, at, best, bestScore, cand, sc, j, prev = 0, nat;
        for (i = 0; i < len; i++) { for (c = 0; c < ch.length; c++) { mono[i] += ch[c][i]; } }
        for (i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); }
        for (k = 0; k * Hs < outLen; k++) {
            at = Math.round(k * Hs / r);
            best = at;
            if (k > 0) {
                nat = prev + Hs;
                bestScore = -Infinity;
                for (cand = Math.max(0, at - tol); cand <= Math.min(len - L - 1, at + tol); cand++) {
                    sc = 0;
                    for (j = 0; j < L; j += 4) { if (nat + j < len) { sc += mono[cand + j] * mono[nat + j]; } }
                    if (sc > bestScore) { bestScore = sc; best = cand; }
                }
            }
            best = Math.max(0, Math.min(len - 1, best));
            for (i = 0; i < N; i++) {
                if (best + i >= len) { break; }
                for (c = 0; c < ch.length; c++) { out[c][k * Hs + i] += ch[c][best + i] * win[i]; }
                norm[k * Hs + i] += win[i];
            }
            prev = best;
        }
        return out.map(function (o) {
            var res = new Float32Array(outLen);
            for (i = 0; i < outLen; i++) { res[i] = norm[i] > 1e-3 ? o[i] / norm[i] : 0; }
            return res;
        });
    }

    // Тон на semis полутонов выше (ниже), длина та же: растянуть в r раз и проиграть в r раз быстрее.
    function sndPitchShift(snd, semis) {
        var r = Math.pow(2, semis / 12), long, len = snd.ch[0].length;
        if (Math.abs(semis) < 0.01) { return snd; }
        long = sndStretchTime(snd.ch, snd.rate, r);
        return { rate: snd.rate, ch: long.map(function (x) {
            var o = new Float32Array(len), i, t, a, f;
            for (i = 0; i < len; i++) {
                t = i * r; a = Math.floor(t); f = t - a;
                o[i] = a + 1 < x.length ? x[a] * (1 - f) + x[a + 1] * f : (a < x.length ? x[a] : 0);
            }
            return o;
        }) };
    }

    // Любой звук (не WAV — через декодер браузера) → { rate, ch }.
    async function sndRead(file) {
        var bytes = base64ToBytes(await platform.readBase64(file)), snd = wavDecode(bytes), Ctx, ctx, buf, i;
        if (snd) { return snd; }
        Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Ctx) { throw new Error("Не получилось прочитать звук: этот формат панель не открывает. Сохраните его как WAV."); }
        ctx = new Ctx(1, 1, 44100);
        buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        snd = { rate: buf.sampleRate, ch: [] };
        for (i = 0; i < buf.numberOfChannels; i++) { snd.ch.push(buf.getChannelData(i)); }
        return snd;
    }

    // Файл со сдвинутым тоном рядом с прочими звуками: «имя.tone+3.40.wav». Готовый не пересчитывается.
    async function sndVariant(src, shift, folder) {
        var name, dest;
        if (Math.abs(shift) < 0.01) { return src; }
        name = platform.basename(src).replace(/(\.tone[+-]\d+\.\d\d)?\.[^.]*$/i, "") + ".tone" + (shift > 0 ? "+" : "-") + Math.abs(shift).toFixed(2) + ".wav";
        dest = platform.join(folder, name);
        if (await platform.exists(dest)) { return dest; }
        await platform.writeBytes(dest, wavEncode(sndPitchShift(await sndRead(src), shift)));
        return dest;
    }

    // Premiere Pro: растянуть клип скриптом там нельзя, поэтому и тон, и длина — в самом файле.
    // Тон сдвигается на тон + 12·log2(длина/100), потом файл играет медленнее (длиннее) ровно на столько же ниже.
    async function sndMake(src, pitch, len, folder) {
        var name, dest, snd, shift = sndFileShift(pitch, len);
        if (!IS_PR) { return sndVariant(src, shift, folder); }
        if (Math.abs(pitch) < 0.01 && Math.round(len) === 100) { return src; }
        name = platform.basename(src).replace(/(\.tone[+-]\d+\.\d\d)?(\.len\d+)?\.[^.]*$/i, "") + ".tone" + (pitch < 0 ? "-" : "+") +
            Math.abs(pitch).toFixed(2) + ".len" + Math.round(len) + ".wav";
        dest = platform.join(folder, name);
        if (!(await platform.exists(dest))) {
            snd = sndPitchShift(await sndRead(src), shift);
            if (Math.round(len) !== 100) { snd = sndSpeed(snd, 100 / len); }
            await platform.writeBytes(dest, wavEncode(snd));
        }
        sndMetaSet(dest, { src: src, p: pitch, l: len });
        return dest;
    }

    // Проиграть в rate раз быстрее (rate < 1 — медленнее и длиннее).
    function sndSpeed(snd, rate) {
        return { rate: snd.rate, ch: snd.ch.map(function (x) {
            var n = Math.max(1, Math.round(x.length / rate)), o = new Float32Array(n), i, t, a, f;
            for (i = 0; i < n; i++) {
                t = i * rate; a = Math.floor(t); f = t - a;
                o[i] = a + 1 < x.length ? x[a] * (1 - f) + x[a + 1] * f : (a < x.length ? x[a] : 0);
            }
            return o;
        }) };
    }

    // Premiere: из какого звука, с каким тоном и длиной сделан файл на таймлайне (для ползунков у выделенного клипа).
    var SND_META_KEY = "sayframe.sndMeta.pr.v1";
    function sndMetaAll() {
        var m;
        try { m = JSON.parse(window.localStorage.getItem(SND_META_KEY) || "{}"); } catch (e) { m = {}; }
        return m && typeof m === "object" ? m : {};
    }
    function sndMetaSet(file, meta) {
        var m = sndMetaAll(), k = Object.keys(m);
        m[file] = meta;
        if (k.length > 400) { delete m[k[0]]; }
        try { window.localStorage.setItem(SND_META_KEY, JSON.stringify(m)); } catch (e) {}
    }

    async function sndFolder() {
        var info = await host("info", []), folder;
        if (!info.fileAccess) { throw new Error(FILE_ACCESS_HINT); }
        folder = info.projectPath ? platform.join(platform.dirname(info.projectPath), "Sayframe SFX") : platform.join(platform.homedir(), "Documents", "Sayframe SFX");
        await platform.mkdirp(folder);
        return folder;
    }

    // Превью звучит так же, как будет в After Effects: тон — пересчётом, длина — скоростью (как Stretch).
    var acCtx = null, acSrc = null, acLastSound = "";
    function acPreviewSound(p) {
        acLastSound = p.id;
        return sndPlay(acSoundPath(p.id), acState.pitch, acState.len, acState.vol, p.id);
    }

    async function sndPlay(file, pitch, len, vol, id) {
        var snd, Ctx, buf, gain, c;
        try {
            if (acSrc) { try { acSrc.stop(); } catch (e0) {} acSrc = null; }
            Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) { return; }
            if (!acCtx) { acCtx = new Ctx(); }
            snd = sndPitchShift(await sndRead(file), sndFileShift(pitch, len));
            buf = acCtx.createBuffer(snd.ch.length, snd.ch[0].length, snd.rate);
            for (c = 0; c < snd.ch.length; c++) { buf.getChannelData(c).set(snd.ch[c]); }
            acSrc = acCtx.createBufferSource();
            acSrc.buffer = buf;
            acSrc.playbackRate.value = 100 / len;
            gain = acCtx.createGain();
            gain.gain.value = Math.pow(10, vol / 20);
            acSrc.connect(gain); gain.connect(acCtx.destination);
            acSrc.start();
            if (id) { sfxShowPlaying(id, buf.duration * len / 100); }
        } catch (e) {}
    }

    // Отпустили ползунок: выделенный звуковой слой меняется и сразу звучит с новыми тоном, длиной и громкостью;
    // слой не выделен — звучит звук, который вы последним слушали или вставили из библиотеки.
    async function sndChanged(change) {
        var list = await sndToSelected(change);
        if (list && list.length) { return sndPlay(list[0].src, list[0].pitch, list[0].len, list[0].volume, ""); }
        if (acLastSound && acState.sec === "sfx" && SFX_BY_ID[acLastSound]) { return acPreviewSound({ id: acLastSound }); }
    }

    // Волны карточек «Звуки»: длина и 48 уровней громкости на каждый звук, читаются один раз.
    var SFX_PEAKS = null, sfxPeaksLoading = false;
    function loadSfxPeaks() {
        if (SFX_PEAKS || sfxPeaksLoading) { return; }
        sfxPeaksLoading = true;
        platform.readText(platform.join(extensionDir(), "sfx", "peaks.json")).then(function (text) {
            var d = JSON.parse(text);
            if (d && typeof d === "object") { SFX_PEAKS = d; if (acState.sec === "sfx" || ui.acSearch.value) { renderAc(); } }
        }).catch(function () {});
    }

    function sfxWaveSvg(pk, cls) {
        var out = "", i, a;
        for (i = 0; i < pk.length; i++) {
            a = Math.max(0.6, (Number(pk[i]) || 0) / 100 * 19);
            out += "<rect x=\"" + (i * 2 + 0.3) + "\" y=\"" + (20 - a).toFixed(1) + "\" width=\"1.4\" height=\"" + (2 * a).toFixed(1) + "\" rx=\"0.5\"/>";
        }
        return "<svg class=\"ac-wave-svg" + (cls ? " " + cls : "") + "\" viewBox=\"0 0 " + pk.length * 2 + " 40\" preserveAspectRatio=\"none\" aria-hidden=\"true\">" +
            "<line x1=\"0\" x2=\"" + pk.length * 2 + "\" y1=\"20\" y2=\"20\"/>" + out + "</svg>";
    }

    // Длина звука на карточке — с учётом ползунка «Длина».
    function sfxDurText(id) {
        var d = SFX_PEAKS && SFX_PEAKS[id] ? SFX_PEAKS[id].dur * acState.len / 100 : 0;
        return d ? (Math.round(d * 10) / 10).toFixed(1).replace(".", ",") + " с" : "";
    }

    function sfxUpdateDurs() {
        Array.prototype.forEach.call(document.querySelectorAll("#acGrid .ac-dur"), function (el) { el.textContent = sfxDurText(el.getAttribute("data-id")); });
    }

    // Пока звук играет, пройденная часть волны подсвечивается и по ней бежит линия.
    function sfxShowPlaying(id, seconds) {
        Array.prototype.forEach.call(document.querySelectorAll("#acGrid .ac-card.playing"), function (c) { c.classList.remove("playing"); });
        var card = document.querySelector('#acGrid .ac-card[data-key="sfx:' + id + '"]');
        if (!card || !seconds) { return; }
        void card.offsetWidth;
        card.style.setProperty("--play", seconds.toFixed(3) + "s");
        card.classList.add("playing");
        clearTimeout(card.playTimer);
        card.playTimer = setTimeout(function () { card.classList.remove("playing"); }, seconds * 1000 + 100);
    }

    function pitchText(v) { v = Math.round(v * 10) / 10; return (v > 0 ? "+" : "") + String(v).replace(".", ",") + " пт"; }
    function lenText(v) { return Math.round(v) + "%"; }
    function volText(v) { v = Math.round(v * 10) / 10; return (v > 0 ? "+" : "") + String(v).replace(".", ",") + " дБ"; }

    // Ряд «Высота тона / Громкость» для звуков: значения запоминаются и идут в слой при вставке.
    function buildSndRow() {
        var row = document.createElement("div");
        row.id = "acSndRow";
        row.className = "ac-row ac-snd";
        row.innerHTML = '<label class="ac-slider"><span>Высота тона</span><input id="acPitch" class="range" type="range" min="-12" max="12" step="1" aria-label="Высота тона"><output id="acPitchVal"></output></label>' +
            '<label class="ac-slider" title="Растягивание клипа: длиннее или короче, тон тот же"><span>Длина</span><input id="acLen" class="range" type="range" min="50" max="200" step="5" aria-label="Длина"><output id="acLenVal"></output></label>' +
            '<label class="ac-slider"><span>Громкость</span><input id="acVol" class="range" type="range" min="-24" max="6" step="1" aria-label="Громкость"><output id="acVolVal"></output></label>';
        ui.acFoot.querySelector(".ac-opts").appendChild(row);
        ui.acSndRow = row;
        ui.acPitch = row.querySelector("#acPitch"); ui.acPitchVal = row.querySelector("#acPitchVal");
        ui.acVol = row.querySelector("#acVol"); ui.acVolVal = row.querySelector("#acVolVal");
        ui.acLen = row.querySelector("#acLen"); ui.acLenVal = row.querySelector("#acLenVal");
        ui.acLen.addEventListener("input", function () { acState.len = Number(ui.acLen.value); ui.acLenVal.textContent = lenText(acState.len); storeAcState(); sfxUpdateDurs(); });
        ui.acLen.addEventListener("change", function () { sndChanged({ len: acState.len }); });
        ui.acPitch.addEventListener("input", function () { acState.pitch = Number(ui.acPitch.value); ui.acPitchVal.textContent = pitchText(acState.pitch); storeAcState(); });
        ui.acVol.addEventListener("input", function () { acState.vol = Number(ui.acVol.value); ui.acVolVal.textContent = volText(acState.vol); storeAcState(); });
        // Отпустили ползунок — то же значение уходит в выделенные звуковые слои (любой звук, не только из библиотеки).
        ui.acPitch.addEventListener("change", function () { sndChanged({ pitch: acState.pitch }); });
        ui.acVol.addEventListener("change", function () { sndChanged({ volume: acState.vol }); });
    }

    // Меняет у выделенных звуковых слоёв то, что задано в change ({pitch} / {len} / {volume}), остальное у каждого своё.
    async function sndToSelected(change, quietIfNone) {
        var res, folder, list = [], i, t, pitch, len, file, what;
        if (busy) { return; }
        try { res = await host("sndTargets", []); } catch (e0) { return; }
        if (!res || !res.list || !res.list.length) { return; }
        if (IS_PR) {
            res.list = res.list.map(function (t) {
                var m = sndMetaAll()[t.path] || { src: t.path, p: 0, l: 100 };
                return { index: t.index, src: m.src, pitch: m.p, len: m.l, volume: t.volume };
            });
        }
        setBusy(true);
        setStatus("Пересчитываю звук…", "busy");
        try {
            folder = await sndFolder();
            for (i = 0; i < res.list.length; i++) {
                t = res.list[i];
                pitch = change.pitch !== undefined ? change.pitch : t.pitch;
                len = change.len !== undefined ? change.len : t.len;
                file = await sndMake(t.src, pitch, len, folder);
                list.push({ index: t.index, file: file, len: len, volume: change.volume !== undefined ? change.volume : t.volume, src: t.src, pitch: pitch });
            }
            res = await host("sndApplyFiles", [list]);
            setBusy(false);
            what = change.pitch !== undefined ? "Высота тона " + pitchText(change.pitch) : change.len !== undefined ? "Длина " + lenText(change.len) : "Громкость " + volText(change.volume);
            setStatus(what + ": " + (IS_PR ? (res.count === 1 ? "клип «" + res.name + "»" : plural(res.count, "звуковой клип", "звуковых клипа", "звуковых клипов")) + "." :
                (res.count === 1 ? "слой «" + res.name + "»" : plural(res.count, "звуковой слой", "звуковых слоя", "звуковых слоёв")) + ".\nОтменить: Cmd/Ctrl+Z."), "done");
            if (acEdit && acEdit.sound) { loadAcEdit(); }
            return list;
        } catch (e) {
            toolFailed(e);
        }
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
            } else if (p.sec === "trans" && IS_PR) {
                res = await host("trApply", [p.id, acState.tdur]);
                setBusy(false);
                setStatus("«" + p.name + "» — на стыке «" + res.a + "» и «" + res.b + "» (" + secText(res.cut).replace(" с", " с от начала") + "), " + secText(res.dur) + "." +
                    (res.builtin ? " Это переход Premiere: длину меняйте, потянув за его край." :
                        " Ключи стоят на обоих клипах — их видно в Effect Controls." + (res.noBlur ? " Размытие не добавилось: Premiere не нашёл Gaussian Blur." : "")), "done");
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
            } else if (p.sec === "kit") {
                res = await host("kitApply", [p.id, { glass: "Жидкое стекло", edge: "Стекло: блик", shape: "Стекло", stroke: "Стекло: обводка",
                    strokeWidth: "Толщина обводки", strokeColor: "Цвет обводки", strokeOpacity: "Прозрачность обводки" }]);
                setBusy(false);
                setStatus(kitReport(res.glass), "done");
            } else if (p.sec === "graphic") {
                res = await host("grApply", [p.id, GR_DUR[p.folder] || 2, hexToRgb01(acState.color), {
                    title: p.name, marker: "Графика: ", color: "Цвет", size: "Размер", value: "Значение", thick: "Толщина",
                    text: GR_TEXT_DEFAULT[p.id] || "", textPrefix: "Текст: " }]);
                setBusy(false);
                setStatus("«" + p.name + "» — новый слой «" + res.name + "» у указателя времени, " + secText(res.dur) + "." +
                    (res.text ? " Текст — отдельным слоем «" + res.text + "», он привязан к графике." : "") +
                    " Растяните слой, чтобы изменить длительность; цвет, размер и толщина — в Effect Controls и во «✎ Изменить». Отменить — Cmd/Ctrl+Z.", "done");
            } else {
                acLastSound = p.id;
                folder = await sndFolder();
                dest = platform.join(folder, p.id + ".wav");
                if (!(await platform.exists(dest))) {
                    await platform.writeBytes(dest, base64ToBytes(await platform.readBase64(acSoundPath(p.id))));
                }
                res = await host("acSound", [await sndMake(dest, acState.pitch, acState.len, folder), "Sayframe SFX", acState.len, acState.vol, "♪ " + p.name,
                    { src: dest, p: acState.pitch, l: acState.len }]);
                setBusy(false);
                if (IS_PR) {
                    setStatus("Звук «" + p.name + "» — на дорожке " + (res.track || "") + " у указателя" + (acState.pitch ? ", высота тона " + pitchText(acState.pitch) : "") +
                        (acState.len !== 100 ? ", длина " + lenText(acState.len) : "") + ". Файл — в корзине «Sayframe SFX». Выделите клип и двигайте ползунки — он поменяется.", "done");
                    return;
                }
                setStatus("Звук «" + p.name + "» добавлен у указателя времени" + (acState.pitch ? ", высота тона " + pitchText(acState.pitch) : "") + (acState.len !== 100 ? ", длина " + lenText(acState.len) : "") + "." +
                    (res.reused ? "" : " Файл лежит в папке «Sayframe SFX» рядом с проектом.") + " Выделите слой и двигайте ползунки внизу — он поменяется.", "done");
            }
        } catch (e) {
            toolFailed(e);
        }
    }

    function kitReport(g) {
        return "Жидкое стекло готово: " + (g.created ? "нарисовал фигуру «" + g.shape + "» в центре кадра" : "фигура — «" + g.shape + "»") +
            ". Над ней слой «" + g.name + "» (увеличение, размытие, яркость — в Effect Controls) и «" + g.edge + "» — блик по краю. " +
            (g.stroke ? "Обводка — слой «" + g.stroke + "»: толщина, цвет и прозрачность в его Effect Controls. " : "") +
            "Двигайте и анимируйте «" + g.shape + "» — стекло идёт за ней. Отменить — Cmd/Ctrl+Z.";
    }

    function sfReport(p, res, extra) {
        if (IS_PR) {
            setStatus("«" + p.name + "» — " + AC_MODE_TEXT[acState.mode] + ", " + plural(res.applied, "клип", "клипа", "клипов") + ". Ключи на Motion и Opacity — " +
                "их видно и можно править в Effect Controls." + (res.noBlur ? " Размытие не добавилось: Premiere не нашёл Gaussian Blur." : ""), "done");
            return;
        }
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

    // ---- Grid: бенто-сетка из скруглённых плиток. Раскладка — тот же код, что в host.jsx (gridLayout):
    // одно и то же «Вариант» даёт одну и ту же раскладку и в превью, и в After Effects.
    var GRID_DEFAULTS = { rows: 4, cols: 5, gap: 20, split: false, gapV: 20, round: 20, rand: 100, seed: 12345, fit: true, w: 1920, h: 1080, mode: "shape", numbers: true, appear: "seq", disappear: "none", dur: 0.6, step: 0.05 };

    function gridImul(a, b) {
        var ah = (a >>> 16) & 0xffff, al = a & 0xffff, bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
        return ((al * bl) + ((((ah * bl + al * bh) & 0xffff) << 16) >>> 0)) | 0;
    }

    function gridRng(seed) {
        var a = Math.floor(Number(seed) || 0) >>> 0;
        return function () {
            var t;
            a = (a + 0x6D2B79F5) >>> 0;
            t = a;
            t = gridImul(t ^ (t >>> 15), t | 1);
            t ^= t + gridImul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function gridLayout(rows, cols, rand, seed) {
        var rng = gridRng(seed), occ = [], boxes = [], r, c, w, h, i, j, p = Math.max(0, Math.min(100, rand)) / 100;
        var maxW = Math.max(1, Math.min(cols, 1 + Math.round(p * 2))), maxH = Math.max(1, Math.min(rows, 1 + Math.round(p)));
        for (r = 0; r < rows; r++) { occ.push([]); for (c = 0; c < cols; c++) { occ[r].push(false); } }
        function clear(r0, c0, ww, hh) {
            var y, x;
            if (r0 + hh > rows || c0 + ww > cols) { return false; }
            for (y = r0; y < r0 + hh; y++) { for (x = c0; x < c0 + ww; x++) { if (occ[y][x]) { return false; } } }
            return true;
        }
        for (r = 0; r < rows; r++) {
            for (c = 0; c < cols; c++) {
                if (occ[r][c]) { continue; }
                w = 1; h = 1;
                if (rng() < p * 0.6) { w = 1 + Math.floor(rng() * maxW); h = 1 + Math.floor(rng() * maxH); }
                while (w > 1 && !clear(r, c, w, 1)) { w--; }
                while (h > 1 && !clear(r, c, w, h)) { h--; }
                for (i = r; i < r + h; i++) { for (j = c; j < c + w; j++) { occ[i][j] = true; } }
                boxes.push({ r: r, c: c, w: w, h: h });
            }
        }
        return boxes;
    }

    // ---- Grid tiles coming in and going out. The same code is in panel.js (the preview) and in host.jsx (the keys),
    // so the preview shows what the comp gets. o: a tile (c, r: its middle in cells; C, R: the grid; i, n: its number;
    // r1..r3, side: its own random numbers; px, py: its middle, cx, cy: the grid's middle, S: the grid's size, h: its height).
    var GRFX_WOW = ["explode", "assemble", "domino", "tetris", "spiral", "jelly", "puzzle", "glitch", "deal", "flip3d", "zoom", "snake"];
    var GRFX_SIMPLE = ["none", "seq", "up", "wave", "center", "rand", "flip", "spring", "wipe", "blur", "drop", "spin"];
    // These only ease in one go: two keys are enough. The rest overshoot or bounce: a key every second frame.
    var GRFX_SMOOTH = { seq: 1, up: 1, center: 1, wipe: 1, blur: 1, spin: 1, zoom: 1, flip: 1, deal: 1 };
    function grfxEz(x) { return 1 - Math.pow(1 - x, 3); }
    function grfxBack(x) { var c = 2.2; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); }
    function grfxBounce(x) {
        var n = 7.5625, d = 2.75;
        if (x < 1 / d) { return n * x * x; }
        if (x < 2 / d) { x -= 1.5 / d; return n * x * x + 0.75; }
        if (x < 2.5 / d) { x -= 2.25 / d; return n * x * x + 0.9375; }
        x -= 2.625 / d;
        return n * x * x + 0.984375;
    }
    function grfxCap(v) { return Math.max(0, Math.min(1, v)); }
    // Which tile comes first: the smaller, the earlier.
    function grfxOrd(fx, o) {
        var C = o.C, R = o.R, cc, rr, ring;
        switch (fx) {
        case "up": return (R - o.r) / R;
        case "wave": case "flip3d": return (o.c + o.r) / (C + R);
        case "center": case "zoom": return Math.sqrt(Math.pow(o.c - C / 2, 2) + Math.pow((o.r - R / 2) * 1.2, 2));
        case "assemble": return -Math.sqrt(Math.pow(o.c - C / 2, 2) + Math.pow(o.r - R / 2, 2));
        case "rand": case "explode": case "glitch": case "puzzle": return o.r1;
        case "flip": case "wipe": return o.c / C;
        case "drop": return o.r / R;
        case "tetris": return ((R - o.r) / R) * 0.6 + (o.c / C) * 0.4;
        case "spiral":
            cc = Math.floor(o.c); rr = Math.floor(o.r); ring = Math.min(cc, rr, C - 1 - cc, R - 1 - rr);
            return ring + (Math.atan2(rr - R / 2, cc - C / 2) + Math.PI) / (2 * Math.PI);
        case "snake": rr = Math.floor(o.r); return rr * C + (rr % 2 ? C - o.c : o.c);
        case "jelly": return o.r2 * 0.4 + (o.c / C) * 0.6;
        default: return o.i;
        }
    }
    // Each tile's delay: its place in the order times the step.
    function grfxDelays(fx, os, step) {
        var idx = [], d = [], i;
        for (i = 0; i < os.length; i++) { idx.push(i); d.push(0); }
        idx.sort(function (a, b) { var x = grfxOrd(fx, os[a]) - grfxOrd(fx, os[b]); return Math.abs(x) > 1e-9 ? x : a - b; });
        for (i = 0; i < idx.length; i++) { d[idx[i]] = i * step; }
        return d;
    }
    // How a tile looks at p (0 not there yet, 1 in its place): offsets, scale, turns (degrees), opacity 0..1, blur in px, wipe 0..1 hidden.
    function grfxAt(fx, p, o) {
        var e = grfxEz(p), S = o.S, f = { x: 0, y: 0, z: 0, sx: 1, sy: 1, rz: 0, rx: 0, ry: 0, op: 1, blur: 0, wipe: 0 }, b, w, d, k, a;
        switch (fx) {
        case "none": f.op = p > 0 ? 1 : 0; break;
        case "seq": f.op = e; f.sx = f.sy = 0.6 + 0.4 * e; break;
        case "up": f.op = e; f.y = (1 - e) * S * 0.12; break;
        case "wave": f.op = grfxCap(p * 2); f.sx = f.sy = grfxBack(p); break;
        case "center": f.op = grfxCap(p * 3); f.sx = f.sy = e; break;
        case "rand": f.op = grfxCap(p * 3); f.sx = f.sy = grfxBack(p); break;
        case "flip": f.op = p > 0 ? 1 : 0; f.ry = (1 - e) * 90; break;
        case "spring": f.op = grfxCap(p * 4); f.sx = f.sy = p <= 0 ? 0 : 1 - Math.cos(p * Math.PI * 2.5) * Math.exp(-p * 4); break;
        case "wipe": f.wipe = 1 - e; break;
        case "blur": f.op = e; f.blur = (1 - e) * S * 0.03; f.sx = f.sy = 1.15 - 0.15 * e; break;
        case "drop": f.op = grfxCap(p * 4); f.y = -(1 - grfxBounce(p)) * S * 0.35; break;
        case "spin": f.op = e; f.rz = (1 - e) * -180; f.sx = f.sy = e; break;
        case "explode":
            b = grfxBack(p); f.op = grfxCap(p * 3);
            f.x = (1 - b) * (o.r1 - 0.5) * S * 1.6; f.y = (1 - b) * (o.r2 - 0.5) * S * 1.2; f.rz = (1 - b) * (o.r3 - 0.5) * 540; f.sx = f.sy = 0.4 + 0.6 * b;
            break;
        case "assemble":
            b = grfxBack(p); f.op = grfxCap(p * 4);
            f.x = (1 - b) * (o.cx - o.px); f.y = (1 - b) * (o.cy - o.py); f.sx = f.sy = 0.15 + 0.85 * b;
            break;
        case "domino":
            // Falls forward round its top edge.
            f.op = p > 0 ? 1 : 0; f.rx = (1 - grfxBounce(p)) * -110; a = f.rx * Math.PI / 180;
            f.y = o.h / 2 * (Math.cos(a) - 1); f.z = o.h / 2 * Math.sin(a);
            break;
        case "tetris": f.op = p > 0 ? 1 : 0; f.y = -(1 - grfxBounce(p)) * S * 0.6; break;
        case "spiral": f.op = grfxCap(p * 3); f.rz = (1 - e) * 180; f.sx = f.sy = grfxBack(p); break;
        case "jelly": w = Math.sin(p * 11) * Math.exp(-4 * p) * 0.45; f.op = grfxCap(p * 5); f.sx = e * (1 + w); f.sy = e * (1 - w); break;
        case "puzzle":
            d = (1 - grfxBack(p)) * S * 0.7; f.op = grfxCap(p * 3);
            f.x = [d, -d, 0, 0][o.side]; f.y = [0, 0, d, -d][o.side];
            break;
        case "glitch":
            if (p <= 0) { f.op = 0; break; }
            if (p < 0.7) { k = Math.floor(p * 30 + o.i * 3); f.op = k % 3 ? 1 : 0.15; f.x = ((k * 7) % 5 - 2) * S * 0.012; }
            break;
        case "deal":
            f.op = p > 0 ? 1 : 0;
            f.x = (1 - e) * (o.cx - S * 0.55 - o.px); f.y = (1 - e) * (o.cy + S * 0.45 - o.py); f.rz = (1 - e) * -70; f.sx = f.sy = 0.7 + 0.3 * e;
            break;
        case "flip3d": f.op = p > 0 ? 1 : 0; f.rx = (1 - grfxBack(p)) * -90; break;
        case "zoom": f.op = grfxCap(p * 2); f.sx = f.sy = 1 + (1 - e) * 2.2; f.blur = (1 - e) * S * 0.02; break;
        }
        return f;
    }
    // Each tile's own random numbers: the same variant number gives the same ones.
    function grfxTiles(os, seed) {
        var rng = gridRng((Math.floor(Number(seed) || 0) + 99) >>> 0), i;
        for (i = 0; i < os.length; i++) { os[i].r1 = rng(); os[i].r2 = rng(); os[i].r3 = rng(); os[i].side = Math.floor(rng() * 4); os[i].i = i; os[i].n = os.length; }
        return os;
    }
    var GRFX_NAMES = { explode: "Взрыв", assemble: "Сборка", domino: "Домино", tetris: "Тетрис", spiral: "Спираль", jelly: "Желе", puzzle: "Пазл",
        glitch: "Глитч", deal: "Раздача", flip3d: "3D-волна", zoom: "Удар", snake: "Змейка", none: "Нет", seq: "По очереди", up: "Снизу", wave: "Волна",
        center: "Из центра", rand: "Случайно", flip: "Переворот", spring: "Пружинка", wipe: "Шторка", blur: "Размытие", drop: "Падение", spin: "Вращение" };

    // The look at p as CSS on a preview tile (the same numbers After Effects gets as keys).
    function grfxCss(el, f) {
        el.style.transform = "translate3d(" + f.x.toFixed(1) + "px," + f.y.toFixed(1) + "px," + f.z.toFixed(1) + "px) rotateX(" + f.rx.toFixed(1) + "deg) rotateY(" + f.ry.toFixed(1) +
            "deg) rotate(" + f.rz.toFixed(1) + "deg) scale(" + f.sx.toFixed(3) + "," + f.sy.toFixed(3) + ")";
        el.style.opacity = String(f.op);
        el.style.filter = f.blur > 0.05 ? "blur(" + f.blur.toFixed(1) + "px)" : "";
        el.style.clipPath = f.wipe > 0.001 ? "inset(0 " + (f.wipe * 100).toFixed(1) + "% 0 0)" : "";
    }
    // A set of preview tiles at time t of a play: mode "in" / "out", dur and step in seconds.
    function grfxShow(set, fx, mode, t, dur, step) {
        var d = grfxDelays(fx, set.os, step), i, p;
        for (i = 0; i < set.els.length; i++) {
            p = grfxCap((t - d[i]) / dur);
            if (mode === "out") { p = 1 - p; }
            if (mode === "show") { p = 1; }
            grfxCss(set.els[i], grfxAt(fx, p, set.os[i]));
        }
        return Math.max.apply(null, d.concat([0])) + dur;
    }
    // A tiny grid (5 tiles) for the buttons and the choice list.
    var GRFX_MINI = [[0, 0, 1, 1], [1, 0, 1, 2], [2, 0, 1, 1], [0, 1, 1, 1], [2, 1, 1, 1]];
    function grfxMini(host) {
        var W = host.clientWidth || 38, H = host.clientHeight || 28, pad = 3, g = 2, cw = (W - pad * 2) / 3, ch = (H - pad * 2) / 2, html = "", os = [], els;
        GRFX_MINI.forEach(function (b, i) {
            var w = b[2] * cw - g, h = b[3] * ch - g, x = pad + b[0] * cw, y = pad + b[1] * ch;
            html += "<i class=\"gr-mb\" style=\"--h:" + (250 + i * 22) + ";left:" + x.toFixed(1) + "px;top:" + y.toFixed(1) + "px;width:" + w.toFixed(1) + "px;height:" + h.toFixed(1) + "px\"></i>";
            os.push({ c: b[0] + b[2] / 2, r: b[1] + b[3] / 2, C: 3, R: 2, px: x + w / 2, py: y + h / 2, cx: W / 2, cy: H / 2, S: Math.max(W, H), h: h });
        });
        host.innerHTML = html;
        els = Array.prototype.slice.call(host.querySelectorAll(".gr-mb"));
        return { els: els, os: grfxTiles(os, 7) };
    }

    function drawGridPreview() {
        var g = orbit.grid, st = ui.gridStage, boxes, W, H, sw, sh, k, gx, gy, cw, ch, html = "", pad = 10, ox, oy;
        if (!st || st.offsetParent === null) { return; }
        boxes = gridLayout(g.rows, g.cols, g.rand, g.seed);
        W = g.fit ? 1920 : g.w; H = g.fit ? 1080 : g.h;
        sw = st.clientWidth - pad * 2; sh = st.clientHeight - pad * 2;
        k = Math.min(sw / W, sh / H);
        gx = g.gap * k; gy = (g.split ? g.gapV : g.gap) * k;
        cw = (W * k - gx * (g.cols - 1)) / g.cols; ch = (H * k - gy * (g.rows - 1)) / g.rows;
        ox = pad + (sw - W * k) / 2; oy = pad + (sh - H * k) / 2;
        grPrev = { els: [], os: [] };
        boxes.forEach(function (b, i) {
            var bw = b.w * cw + (b.w - 1) * gx, bh = b.h * ch + (b.h - 1) * gy;
            grPrev.os.push({ c: b.c + b.w / 2, r: b.r + b.h / 2, C: g.cols, R: g.rows, px: ox + b.c * (cw + gx) + bw / 2, py: oy + b.r * (ch + gy) + bh / 2,
                cx: ox + W * k / 2, cy: oy + H * k / 2, S: Math.max(W, H) * k, h: bh });
            html += "<div class=\"gr-box\" style=\"--h:" + (250 + i * 9) + ";left:" + (ox + b.c * (cw + gx)).toFixed(1) + "px;top:" + (oy + b.r * (ch + gy)).toFixed(1) +
                "px;width:" + Math.max(1, bw).toFixed(1) + "px;height:" + Math.max(1, bh).toFixed(1) + "px;border-radius:" + Math.min(g.round * k, Math.min(bw, bh) / 2).toFixed(1) + "px\">" +
                (g.numbers && bh > 12 ? "<span style=\"font-size:" + Math.round(Math.max(9, Math.min(15, Math.min(bw, bh) * 0.35))) + "px\">" + (i + 1) + "</span>" : "") + "</div>";
        });
        st.innerHTML = html;
        grPrev.els = Array.prototype.slice.call(st.querySelectorAll(".gr-box"));
        grfxTiles(grPrev.os, g.seed);
    }
    var grPrev = { els: [], os: [] };

    // Playing in the preview: one at a time; «loop» repeats while the pointer is on a choice.
    var grPlaying = null, grRaf = 0, grPop = "";
    function grNow() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }
    function grPlay(fx, mode, loop) {
        grPlaying = { fx: fx, mode: mode, t0: grNow(), loop: !!loop };
        grKick();
    }
    function grKick() { if (!grRaf) { grRaf = requestAnimationFrame(grTick); } }
    function grTick() {
        var now = grNow(), g = orbit.grid, len, t, busyMinis = false;
        grRaf = 0;
        if (grPlaying && grPrev.els.length) {
            t = now - grPlaying.t0;
            len = grfxShow(grPrev, grPlaying.fx, grPlaying.mode, t, g.dur, g.step);
            if (t > len + 0.6) {
                if (grPlaying.loop) { grPlaying.t0 = now; } else { grPlaying = null; grfxShow(grPrev, "none", "show", 0, 1, 0); }
            }
        }
        // The little pictures move while the list is open or the pointer is on a button.
        Array.prototype.forEach.call(document.querySelectorAll(".gr-mini.gr-live"), function (m) {
            var tt = (now % 2.2), out = m.getAttribute("data-mode") === "out";
            if (!m.grSet) { m.grSet = grfxMini(m); }
            grfxShow(m.grSet, m.getAttribute("data-fx"), tt < 1.6 ? (out ? "out" : "in") : (out ? "hide" : "show"), tt, 0.45, 0.08);
            busyMinis = true;
        });
        if (grPlaying || busyMinis) { grKick(); }
    }
    function grMiniStill(m, fx, out) {
        m.setAttribute("data-fx", fx); m.setAttribute("data-mode", out ? "out" : "in");
        m.grSet = grfxMini(m);
        grfxShow(m.grSet, fx, "show", 0, 1, 0);
    }

    function grOpenPop(which) {
        var g = orbit.grid, cur;
        if (grPop === which) { grClosePop(); return; }
        grPop = which;
        ui.gridPop.hidden = false;
        ui.gridPop.closest(".mk-card").classList.add("gr-popping");
        ui.gridPop.style.top = (ui.gridAnim.offsetTop + ui.gridAnim.offsetHeight + 6) + "px";
        ui.gridPopTitle.textContent = which === "in" ? "Появление" : "Исчезновение";
        ui.gridInBtn.setAttribute("aria-expanded", String(which === "in"));
        ui.gridOutBtn.setAttribute("aria-expanded", String(which === "out"));
        cur = which === "in" ? g.appear : g.disappear;
        grFillPop(GRFX_SIMPLE.indexOf(cur) > 1 ? "simple" : "wow");
    }
    function grClosePop() {
        grPop = "";
        if (!ui.gridPop) { return; }
        ui.gridPop.hidden = true;
        ui.gridPop.closest(".mk-card").classList.remove("gr-popping");
        ui.gridInBtn.setAttribute("aria-expanded", "false");
        ui.gridOutBtn.setAttribute("aria-expanded", "false");
        ui.gridPopList.innerHTML = "";
    }
    function grFillPop(tab) {
        var g = orbit.grid, cur = grPop === "in" ? g.appear : g.disappear, list = tab === "simple" ? GRFX_SIMPLE : GRFX_WOW, html = "";
        pressGroupV(ui.gridTabs, tab);
        list.forEach(function (fx) {
            html += "<button type=\"button\" class=\"kr-b gr-opt\" data-v=\"" + fx + "\" aria-pressed=\"" + (fx === cur) + "\"><span class=\"gr-mini gr-live\" data-fx=\"" + fx +
                "\" data-mode=\"" + grPop + "\"></span><span>" + GRFX_NAMES[fx] + "</span></button>";
        });
        ui.gridPopList.innerHTML = html;
        grKick();
    }

    function drawGrid() {
        var g = orbit.grid;
        if (!ui.gridStage) { return; }
        ui.gridRows.value = String(g.rows);
        ui.gridCols.value = String(g.cols);
        ui.gridW.value = String(g.w); ui.gridH.value = String(g.h);
        ui.gridW.disabled = g.fit; ui.gridH.disabled = g.fit;
        ui.gridFit.setAttribute("aria-pressed", String(g.fit));
        ui.gridGap.value = String(g.gap); ui.gridGapVal.textContent = String(g.gap);
        ui.gridGapV.value = String(g.gapV); ui.gridGapVVal.textContent = String(g.gapV);
        ui.gridGapVRow.hidden = !g.split;
        ui.gridGapName.textContent = g.split ? "По горизонтали" : "Отступ";
        ui.gridSplit.checked = g.split;
        ui.gridRound.value = String(g.round); ui.gridRoundVal.textContent = String(g.round);
        ui.gridRand.value = String(g.rand); ui.gridRandVal.textContent = g.rand + "%";
        ui.gridSeed.value = String(g.seed);
        pressGroupV(ui.gridMode, g.mode);
        ui.gridNumbers.checked = g.numbers;
        ui.gridInName.textContent = GRFX_NAMES[g.appear];
        ui.gridOutName.textContent = GRFX_NAMES[g.disappear];
        grMiniStill(ui.gridInMini, g.appear, false);
        grMiniStill(ui.gridOutMini, g.disappear, true);
        ui.gridDur.value = String(g.dur); ui.gridDurVal.textContent = g.dur.toFixed(2).replace(/0$/, "") + " с";
        ui.gridStep.value = String(g.step); ui.gridStepVal.textContent = g.step.toFixed(2) + " с";
        drawGridPreview();
    }

    function setGrid(k, v) { orbit.grid[k] = v; storeOrbit(); drawGrid(); mkTouched("grid"); }

    function gridInt(v, lo, hi, def) {
        v = Math.round(Number(v));
        return isNaN(v) ? def : Math.max(lo, Math.min(hi, v));
    }

    async function onGrid() {
        var res, g = orbit.grid;
        if (busy) { return; }
        setBusy(true);
        setStatus("Строю сетку…", "busy");
        try {
            res = await host("gridMake", [{ rows: g.rows, cols: g.cols, gap: g.gap, split: g.split, gapV: g.gapV, round: g.round, rand: g.rand, seed: g.seed,
                fit: g.fit, w: g.w, h: g.h, mode: g.mode, numbers: g.numbers, appear: g.appear, disappear: g.disappear, dur: g.dur, step: g.step },
                { tile: "Плитка ", number: "Номер плитки ", ctrl: "Grid: управление", folder: "Grid", shape: "Форма", fxBlur: "Размытие", fxWipe: "Шторка" }, mkArg("grid")]);
            setBusy(false);
            setStatus("Сетка готова: " + plural(res.tiles, "плитка", "плитки", "плиток") + ", " + res.w + "×" + res.h + ". Двигайте всю сетку слоем «" + res.ctrl + "»." +
                (res.precomp ? " Каждая плитка — композиция в папке «" + res.folder + "»: откройте и положите внутрь картинку или видео." : "") +
                (res.appear !== "none" ? " Появление «" + GRFX_NAMES[res.appear] + "» — от указателя времени." : "") +
                (res.disappear !== "none" ? " Исчезновение «" + GRFX_NAMES[res.disappear] + "» — к концу композиции." : "") + " Отменить — Cmd/Ctrl+Z.", "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    function enableGrid() {
        if (!ui.gridStage) { return; }
        var step = function (btn, key, d, lo, hi) { btn.addEventListener("click", function () { setGrid(key, gridInt(orbit.grid[key] + d, lo, hi, orbit.grid[key])); }); };
        step(ui.gridRowsLess, "rows", -1, 1, 20); step(ui.gridRowsMore, "rows", 1, 1, 20);
        step(ui.gridColsLess, "cols", -1, 1, 20); step(ui.gridColsMore, "cols", 1, 1, 20);
        [["gridRows", "rows", 1, 20], ["gridCols", "cols", 1, 20], ["gridW", "w", 16, 16000], ["gridH", "h", 16, 16000], ["gridSeed", "seed", 0, 999999]].forEach(function (f) {
            ui[f[0]].addEventListener("change", function () { setGrid(f[1], gridInt(ui[f[0]].value, f[2], f[3], orbit.grid[f[1]])); });
            ui[f[0]].addEventListener("keydown", function (e) { if (e.key === "Enter") { setGrid(f[1], gridInt(ui[f[0]].value, f[2], f[3], orbit.grid[f[1]])); } });
        });
        [["gridGap", "gap"], ["gridGapV", "gapV"], ["gridRound", "round"], ["gridRand", "rand"]].forEach(function (s) {
            ui[s[0]].addEventListener("input", function () { setGrid(s[1], Math.round(Number(ui[s[0]].value))); });
        });
        ui.gridFit.addEventListener("click", function () { setGrid("fit", !orbit.grid.fit); });
        ui.gridSplit.addEventListener("change", function () { setGrid("split", ui.gridSplit.checked); });
        ui.gridNumbers.addEventListener("change", function () { setGrid("numbers", ui.gridNumbers.checked); });
        ui.gridInBtn.addEventListener("click", function () { grOpenPop("in"); });
        ui.gridOutBtn.addEventListener("click", function () { grOpenPop("out"); });
        [[ui.gridInBtn, ui.gridInMini], [ui.gridOutBtn, ui.gridOutMini]].forEach(function (pr) {
            pr[0].addEventListener("mouseenter", function () { pr[1].classList.add("gr-live"); grKick(); });
            pr[0].addEventListener("mouseleave", function () { pr[1].classList.remove("gr-live"); grMiniStill(pr[1], pr[1].getAttribute("data-fx"), pr[1].getAttribute("data-mode") === "out"); });
        });
        Array.prototype.forEach.call(ui.gridTabs.querySelectorAll("button[data-v]"), function (b) {
            b.addEventListener("click", function () { grFillPop(b.getAttribute("data-v")); });
        });
        ui.gridPopList.addEventListener("mouseover", function (e) {
            var b = e.target.closest ? e.target.closest(".gr-opt") : null;
            if (b && (!grPlaying || grPlaying.fx !== b.getAttribute("data-v") || !grPlaying.loop)) { grPlay(b.getAttribute("data-v"), grPop, true); }
        });
        ui.gridPopList.addEventListener("mouseleave", function () { if (grPlaying && grPlaying.loop) { grPlaying.loop = false; } });
        ui.gridPopList.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest(".gr-opt") : null, fx, mode = grPop;
            if (!b) { return; }
            fx = b.getAttribute("data-v");
            grClosePop();
            setGrid(mode === "in" ? "appear" : "disappear", fx);
            grPlay(fx, mode, false);
        });
        ui.gridDur.addEventListener("input", function () { setGrid("dur", Math.round(Number(ui.gridDur.value) * 100) / 100); });
        ui.gridStep.addEventListener("input", function () { setGrid("step", Math.round(Number(ui.gridStep.value) * 100) / 100); });
        document.addEventListener("mousedown", function (e) {
            if (grPop && !ui.gridPop.contains(e.target) && !ui.gridAnim.contains(e.target)) { grClosePop(); }
        });
        document.addEventListener("keydown", function (e) { if (grPop && e.key === "Escape") { grClosePop(); } });
        ui.gridDice.addEventListener("click", function () { setGrid("seed", Math.floor(Math.random() * 99999) + 1); });
        Array.prototype.forEach.call(ui.gridMode.querySelectorAll("button[data-v]"), function (b) {
            b.addEventListener("click", function () { setGrid("mode", b.getAttribute("data-v")); });
        });
        ui.gridBtn.addEventListener("click", onGrid);
        drawGrid();
    }

    // Блоки раздела «Макеты» сворачиваются щелчком по заголовку; ширина у них постоянная, в широкой панели они встают рядом.
    function drawMkFolds() {
        var folded = (orbit.fold || "").split(",");
        Array.prototype.forEach.call(document.querySelectorAll("#orbitPane .mk-card"), function (c) {
            var on = folded.indexOf(c.getAttribute("data-mk")) >= 0, b = c.querySelector(".mk-fold");
            c.classList.toggle("mk-folded", on);
            if (b) { b.setAttribute("aria-expanded", String(!on)); b.setAttribute("aria-label", on ? "Развернуть" : "Свернуть"); }
        });
        if (ui.orbitPane) { ui.orbitPane.classList.toggle("mk-wide", ui.orbitPane.clientWidth >= 664); }
        mkMasonry();
    }

    // Несколько колонок «Макетов» — как кирпичная кладка: каждый блок встаёт в самую короткую колонку,
    // так под свёрнутым блоком не остаётся пустого места рядом с высоким. В одну колонку — обычный порядок.
    var mkLaying = false;
    function mkMasonry() {
        var pane = ui.orbitPane, cards, cs, padL, padT, W, gap = 12, n, cw, hs, i;
        if (!pane || pane.hidden || mkLaying) { return; }
        cards = Array.prototype.slice.call(pane.querySelectorAll(":scope > .mk-card"));
        cs = getComputedStyle(pane);
        padL = parseFloat(cs.paddingLeft) || 0; padT = parseFloat(cs.paddingTop) || 0;
        W = pane.clientWidth - padL - (parseFloat(cs.paddingRight) || 0);
        if (!(W > 0)) { return; }
        n = Math.max(1, Math.floor((W + gap) / (320 + gap)));
        mkLaying = true;
        if (n === 1) {
            pane.classList.remove("mk-masonry");
            if (pane.mkSpacer) { pane.mkSpacer.style.height = "0px"; }
            cards.forEach(function (c) { c.style.position = c.style.left = c.style.top = c.style.width = ""; });
            mkLaying = false;
            return;
        }
        pane.classList.add("mk-masonry");
        cw = Math.min(420, (W - gap * (n - 1)) / n);
        hs = [];
        for (i = 0; i < n; i++) { hs.push(0); }
        cards.forEach(function (c) {
            var k = 0, j;
            for (j = 1; j < n; j++) { if (hs[j] < hs[k] - 1) { k = j; } }
            c.style.position = "absolute";
            c.style.width = cw + "px";
            c.style.left = (padL + k * (cw + gap)) + "px";
            c.style.top = (padT + hs[k]) + "px";
            hs[k] += c.offsetHeight + gap;
        });
        // Блоки стоят поверх потока; распорка внизу держит высоту раздела (и прокрутку).
        if (!pane.mkSpacer) { pane.mkSpacer = document.createElement("div"); pane.mkSpacer.className = "mk-spacer"; pane.mkSpacer.setAttribute("aria-hidden", "true"); }
        pane.appendChild(pane.mkSpacer);
        pane.mkSpacer.style.height = Math.max(0, Math.max.apply(null, hs) - gap) + "px";
        mkLaying = false;
    }
    var mkLayAt = 0;
    function mkMasonrySoon() {
        if (mkLayAt) { return; }
        mkLayAt = requestAnimationFrame(function () { mkLayAt = 0; mkMasonry(); });
    }

    // Порядок блоков «Макетов»: блок перетаскивают за заголовок, порядок запоминается.
    function sortMkCards() {
        var pane = ui.orbitPane;
        if (!pane) { return; }
        (orbit.sort || "").split(",").forEach(function (name) {
            var c = name && pane.querySelector('.mk-card[data-mk="' + name + '"]');
            if (c) { pane.appendChild(c); }
        });
    }

    function enableMkDrag() {
        var pane = ui.orbitPane, drag = null;
        if (!pane) { return; }
        function onMove(e) {
            var over, r, before, side;
            if (!drag) { return; }
            if (!drag.on) {
                if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) { return; }
                drag.on = true;
                drag.card.classList.add("mk-drag");
                pane.classList.add("mk-sorting");
            }
            e.preventDefault();
            over = document.elementFromPoint(e.clientX, e.clientY);
            over = over && over.closest ? over.closest(".mk-card") : null;
            if (!over || over === drag.card || over.parentNode !== pane) { return; }
            r = over.getBoundingClientRect();
            // Рядом (в одной строке) решает левая/правая половина, одна под другой — верхняя/нижняя.
            side = pane.classList.contains("mk-masonry") ? Math.abs(r.left - drag.card.getBoundingClientRect().left) >= 4 : Math.abs(r.top - drag.card.getBoundingClientRect().top) < 4;
            before = side ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
            pane.insertBefore(drag.card, before ? over : over.nextSibling);
            mkMasonry();
        }
        function onUp() {
            var d = drag;
            drag = null;
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("mouseup", onUp, true);
            if (!d || !d.on) { return; }
            d.card.classList.remove("mk-drag");
            pane.classList.remove("mk-sorting");
            orbit.sort = Array.prototype.map.call(pane.querySelectorAll(".mk-card"), function (c) { return c.getAttribute("data-mk"); }).join(",");
            storeOrbit();
            drawOrbitPreview();
            drawGridPreview();
            // Отпустили — это не щелчок: блок не сворачивается.
            function eat(ev) { ev.stopPropagation(); ev.preventDefault(); }
            document.addEventListener("click", eat, true);
            setTimeout(function () { document.removeEventListener("click", eat, true); }, 0);
        }
        // Mouse events, not pointer events: pointer events pass the browser tests but do not fire in After Effects.
        // The press is cancelled (preventDefault) so the browser does not start its own drag or text selection.
        pane.addEventListener("dragstart", function (e) { e.preventDefault(); });
        pane.addEventListener("mousedown", function (e) {
            var head = e.button === 0 && e.target.closest ? e.target.closest(".mk-head") : null;
            if (!head || e.target.closest(".mk-fold")) { return; }
            e.preventDefault();
            drag = { card: head.parentNode, x: e.clientX, y: e.clientY, on: false };
            document.addEventListener("mousemove", onMove, true);
            document.addEventListener("mouseup", onUp, true);
        });
    }

    function enableMkFolds() {
        sortMkCards();
        enableMkDrag();
        Array.prototype.forEach.call(document.querySelectorAll("#orbitPane .mk-card"), function (c) {
            var name = c.getAttribute("data-mk");
            c.querySelector(".mk-head").addEventListener("click", function () {
                var list = (orbit.fold || "").split(",").filter(function (x) { return x && x !== name; });
                if (!c.classList.contains("mk-folded")) { list.push(name); }
                orbit.fold = list.join(",");
                storeOrbit();
                drawMkFolds();
                drawOrbitPreview();
                drawGridPreview();
            });
        });
        window.addEventListener("resize", function () { if (ui.orbitPane && !ui.orbitPane.hidden) { drawMkFolds(); drawOrbitPreview(); drawGridPreview(); } });
        // Блок стал выше или ниже (переключили режим, показалась строка) или панель открылась — кладка заново.
        if (typeof ResizeObserver === "function" && ui.orbitPane) {
            var ro = new ResizeObserver(mkMasonrySoon);
            ro.observe(ui.orbitPane);
            Array.prototype.forEach.call(ui.orbitPane.querySelectorAll(":scope > .mk-card"), function (c) { ro.observe(c); });
        }
        drawMkFolds();
    }

    // ---- Раздел «Макеты»: карусель. Настройки хранятся отдельно; превью — те же карточки в CSS 3D, его можно крутить мышкой.
    var ORBIT_KEY = "sayframe.orbit.v1";
    var ORBIT_DEFAULTS = { layout: "ring", shape: "rect", corners: 20, mode: "precomp", count: 8, radius: 600, w: 400, h: 560, numbers: true, camera: true, backColor: "card", backHex: "#3d6bff" };
    var ORBIT_LAYOUT_NAMES = { ring: "кольцо", half: "полукруг", spiral: "спираль", wave: "волна" };
    var ORBIT_SIDES = { rect: 4, circle: 0, tri: 3, hex: 6 };
    var orbit = loadOrbit(), orbitSpin = -24, orbitDrag = null;

    function loadOrbit() {
        var s, out = {}, k;
        try { s = JSON.parse(window.localStorage.getItem(ORBIT_KEY) || "{}"); } catch (e) { s = {}; }
        if (!s || typeof s !== "object") { s = {}; }
        for (k in ORBIT_DEFAULTS) {
            if (ORBIT_DEFAULTS.hasOwnProperty(k)) { out[k] = typeof s[k] === typeof ORBIT_DEFAULTS[k] ? s[k] : ORBIT_DEFAULTS[k]; }
        }
        if (!ORBIT_LAYOUT_NAMES[out.layout]) { out.layout = "ring"; }
        if (!ORBIT_SIDES.hasOwnProperty(out.shape)) { out.shape = "rect"; }
        out.mode = "precomp";   // карточки всегда композиции: внутрь кладут фото
        if (["card", "white", "black", "custom"].indexOf(out.backColor) < 0) { out.backColor = "card"; }
        if (!/^#[0-9a-f]{6}$/i.test(out.backHex)) { out.backHex = "#3d6bff"; }
        out.corners = Math.max(0, Math.min(100, Math.round(out.corners) || 0));
        out.count = Math.max(2, Math.min(36, Math.round(out.count) || 8));
        out.radius = Math.max(100, Math.min(3000, Math.round(out.radius) || 600));
        out.w = Math.max(50, Math.min(2000, Math.round(out.w) || 400));
        out.h = Math.max(50, Math.min(2000, Math.round(out.h) || 560));
        out.fold = typeof s.fold === "string" ? s.fold : "";
        out.sort = typeof s.sort === "string" ? s.sort : "";
        out.grid = {};
        var g = s.grid && typeof s.grid === "object" ? s.grid : {};
        for (k in GRID_DEFAULTS) {
            if (GRID_DEFAULTS.hasOwnProperty(k)) { out.grid[k] = typeof g[k] === typeof GRID_DEFAULTS[k] ? g[k] : GRID_DEFAULTS[k]; }
        }
        g = out.grid;
        g.rows = gridInt(g.rows, 1, 20, 4); g.cols = gridInt(g.cols, 1, 20, 5);
        g.gap = gridInt(g.gap, 0, 200, 20); g.gapV = gridInt(g.gapV, 0, 200, 20); g.round = gridInt(g.round, 0, 200, 20);
        g.rand = gridInt(g.rand, 0, 100, 100); g.seed = gridInt(g.seed, 0, 999999, 12345);
        g.w = gridInt(g.w, 16, 16000, 1920); g.h = gridInt(g.h, 16, 16000, 1080);
        if (g.mode !== "precomp") { g.mode = "shape"; }
        // «По очереди» was a switch before: off means the tiles are simply there.
        if (typeof s.grid === "object" && s.grid && s.grid.appear === undefined && s.grid.stagger === false) { g.appear = "none"; }
        if (!GRFX_NAMES.hasOwnProperty(g.appear)) { g.appear = "seq"; }
        if (!GRFX_NAMES.hasOwnProperty(g.disappear)) { g.disappear = "none"; }
        g.dur = Math.max(0.2, Math.min(2, Math.round((Number(g.dur) || 0.6) * 100) / 100));
        g.step = Math.max(0, Math.min(0.3, Math.round((Number(g.step) >= 0 ? Number(g.step) : 0.05) * 100) / 100));
        return out;
    }

    function storeOrbit() { try { window.localStorage.setItem(ORBIT_KEY, JSON.stringify(orbit)); } catch (e) {} }

    // Те же формулы, что в host.jsx (orbitSpot, orbitColor, orbitPoly): превью совпадает с тем, что появится в After Effects.
    function orbitSpot(i, n, layout, radius, h) {
        var a, y = 0, r;
        if (layout === "half") { a = n > 1 ? -90 + 180 * i / (n - 1) : 0; }
        else if (layout === "spiral") { a = i * 540 / n; y = (i - (n - 1) / 2) * h * 0.3; }
        else {
            a = i * 360 / n;
            if (layout === "wave") { y = Math.sin(a * 2 * Math.PI / 180) * h * 0.25; }
        }
        r = a * Math.PI / 180;
        return { x: radius * Math.sin(r), y: y, z: -radius * Math.cos(r), ry: a };
    }

    function orbitHue(i) { return (250 + i * 22) % 360; }

    // Правильный многоугольник (вершиной вверх) со скруглёнными углами: t = 0 — острые, 1 — вписанный круг.
    // Путь в рамке w x h (растянут по острому контуру), как в After Effects.
    function orbitPolyPath(sides, t, w, h) {
        var V = [], i, a, r, d, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, sx, sy, cx, cy, out = "", P, C, N, L, ua, ub;
        for (i = 0; i < sides; i++) {
            a = -Math.PI / 2 + i * 2 * Math.PI / sides;
            V.push([Math.cos(a), Math.sin(a)]);
            minX = Math.min(minX, V[i][0]); maxX = Math.max(maxX, V[i][0]); minY = Math.min(minY, V[i][1]); maxY = Math.max(maxY, V[i][1]);
        }
        sx = w / (maxX - minX); sy = h / (maxY - minY); cx = (minX + maxX) / 2; cy = (minY + maxY) / 2;
        r = Math.max(0, Math.min(1, t)) * Math.cos(Math.PI / sides);
        d = r * Math.tan(Math.PI / sides);
        function pt(p) { return ((p[0] - cx) * sx + w / 2).toFixed(2) + " " + ((p[1] - cy) * sy + h / 2).toFixed(2); }
        for (i = 0; i < sides; i++) {
            P = V[(i + sides - 1) % sides]; C = V[i]; N = V[(i + 1) % sides];
            L = Math.sqrt((P[0] - C[0]) * (P[0] - C[0]) + (P[1] - C[1]) * (P[1] - C[1]));
            ua = [(P[0] - C[0]) / L, (P[1] - C[1]) / L];
            ub = [(N[0] - C[0]) / L, (N[1] - C[1]) / L];
            if (r <= 0) { out += (i ? "L" : "M") + pt(C); continue; }
            out += (i ? "L" : "M") + pt([C[0] + ua[0] * d, C[1] + ua[1] * d]) +
                "A" + (r * sx).toFixed(2) + " " + (r * sy).toFixed(2) + " 0 0 1 " + pt([C[0] + ub[0] * d, C[1] + ub[1] * d]);
        }
        return out + "Z";
    }

    function orbitShapeSvg(kind, t, w, h, fill) {
        var body;
        if (kind === "circle") { body = "<ellipse cx=\"" + w / 2 + "\" cy=\"" + h / 2 + "\" rx=\"" + w / 2 + "\" ry=\"" + h / 2 + "\""; }
        else if (kind === "rect") { body = "<rect x=\"0\" y=\"0\" width=\"" + w + "\" height=\"" + h + "\" rx=\"" + (t * Math.min(w, h) / 2).toFixed(2) + "\""; }
        else { body = "<path d=\"" + orbitPolyPath(ORBIT_SIDES[kind], t, w, h) + "\""; }
        return "<svg viewBox=\"0 0 " + w + " " + h + "\" aria-hidden=\"true\">" + body + " fill=\"" + fill + "\" stroke=\"rgba(255,255,255,.25)\" stroke-width=\"" + (Math.min(w, h) / 60).toFixed(2) + "\"/></svg>";
    }

    function orbitBackCss() { return orbit.backColor === "white" ? "#f4f4f4" : orbit.backColor === "black" ? "#151515" : orbit.backHex; }
    function orbitHexRgb(h) { return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]; }

    function drawOrbitPreview() {
        var n = orbit.count, ring = ui.orbitRing, i, sp, d, k, w, h, t = orbit.corners / 100, html = "", front, ext;
        if (!ring) { return; }
        // Масштаб: вся карусель (радиус + половина карточки) помещается в превью.
        ext = Math.max(orbit.radius + orbit.w / 2, orbit.h * (orbit.layout === "spiral" ? 1.4 + n * 0.15 : 1.2));
        k = Math.min(0.3, 125 / ext);
        w = Math.max(6, orbit.w * k); h = Math.max(6, orbit.h * k);
        for (i = 0; i < n; i++) {
            sp = orbitSpot(i, n, orbit.layout, orbit.radius * k, h);
            front = Math.cos((sp.ry + orbitSpin) * Math.PI / 180) > 0.15;
            html += "<div class=\"kr-it\" style=\"width:" + w.toFixed(1) + "px;height:" + h.toFixed(1) + "px;left:" + (-w / 2).toFixed(1) + "px;top:" + (-h / 2).toFixed(1) +
                "px;transform:translate3d(" + sp.x.toFixed(1) + "px," + sp.y.toFixed(1) + "px," + (-sp.z).toFixed(1) + "px) rotateY(" + sp.ry + "deg)\">" +
                orbitShapeSvg(orbit.shape, t, Math.round(orbit.w), Math.round(orbit.h), front || orbit.backColor === "card" ? "hsl(" + orbitHue(i) + ",80%,62%)" : orbitBackCss()) +
                (orbit.numbers && front && h > 18 ? "<span style=\"font-size:" + Math.max(9, Math.round(Math.min(w, h) * 0.32)) + "px\">" + (i + 1) + "</span>" : "") + "</div>";
        }
        d = ring;
        d.innerHTML = html;
        d.style.transform = "rotateX(-14deg) rotateY(" + orbitSpin + "deg)";
    }

    function drawOrbit() {
        var corner = orbit.shape !== "circle";
        pressGroupV(ui.orbitLayout, orbit.layout);
        pressGroupV(ui.orbitShape, orbit.shape);
        pressGroupV(ui.orbitBackC, orbit.backColor);
        ui.orbitBackDot.style.background = orbit.backHex;
        ui.orbitBackHex.value = orbit.backHex;
        ui.orbitCornerRow.hidden = !corner;
        if (corner) { ui.orbitCornerIco.innerHTML = ui.orbitShape.querySelector("button[data-v=\"" + orbit.shape + "\"] svg").outerHTML; }
        ui.orbitCorners.value = String(orbit.corners);
        ui.orbitCornersVal.textContent = orbit.corners + "%";
        ui.orbitCount.value = String(orbit.count);
        ui.orbitRadius.value = String(orbit.radius); ui.orbitRadiusVal.textContent = String(orbit.radius);
        ui.orbitW.value = String(orbit.w); ui.orbitWVal.textContent = String(orbit.w);
        ui.orbitH.value = String(orbit.h); ui.orbitHVal.textContent = String(orbit.h);
        ui.orbitNumbers.checked = orbit.numbers;
        ui.orbitCamera.checked = orbit.camera;
        drawOrbitPreview();
    }

    function setOrbit(k, v) { orbit[k] = v; storeOrbit(); drawOrbit(); mkTouched("carousel"); }

    function setOrbitCount(v) {
        v = Math.round(Number(v));
        if (isNaN(v)) { v = orbit.count; }
        setOrbit("count", Math.max(2, Math.min(36, v)));
    }

    async function onOrbit() {
        var res;
        if (busy) { return; }
        setBusy(true);
        setStatus("Строю карусель…", "busy");
        try {
            res = await host("orbitMake", [{ count: orbit.count, layout: orbit.layout, shape: orbit.shape, corners: orbit.corners, mode: "precomp",
                radius: orbit.radius, w: orbit.w, h: orbit.h, numbers: orbit.numbers, camera: orbit.camera, back: false,
                backColor: orbit.backColor === "white" ? [0.96, 0.96, 0.96] : orbit.backColor === "black" ? [0.08, 0.08, 0.08] : orbit.backColor === "custom" ? orbitHexRgb(orbit.backHex) : null },
                { ctrl: "Карусель: управление", card: "Карточка ", number: "Номер ", camera: "Карусель: камера", camRig: "Карусель: управление камерой", folder: "Карусель", shape: "Форма", back: "обратная сторона", backFx: "Обратная сторона",
                    fxCount: "Карточек", fxRadius: "Радиус", fxW: "Ширина", fxH: "Высота", fxCorners: "Углы %" }, mkArg("carousel")]);
            setBusy(false);
            setStatus("Карусель готова: " + plural(res.cards, "карточка", "карточки", "карточек") + ", " + ORBIT_LAYOUT_NAMES[res.layout] + ". " +
                "Крутите её слоем «" + res.ctrl + "» (Y Rotation); там же, в Effect Controls, — сколько карточек (до " + (res.cards + (res.spare || 0)) + "), радиус, размер и углы." +
                (res.precomp ? " Каждая карточка — композиция в папке «" + res.folder + "»: положите внутрь фото (или нажмите «Фото в карточки») — оно обрежется по форме карточки, сзади будет просто цвет." : "") +
                (res.camera ? " Добавлена камера «" + res.camera + "»" + (res.camRig ? " на 3D-нуле «" + res.camRig + "»: крутите или двигайте его, чтобы облететь карусель." : ".") : (res.hadCamera ? " Камера в композиции уже была." : "")) +
                " Отменить — Cmd/Ctrl+Z.", "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    // Фото, выделенные в окне Project, по одному в каждую карточку карусели (выделенной или единственной в композиции).
    async function onOrbitPhotos() {
        var res;
        if (busy) { return; }
        setBusy(true);
        setStatus("Кладу фото в карточки…", "busy");
        try {
            res = await host("orbitPhotos", [{ card: "Карточка ", ctrl: "Карусель: управление", photo: "Фото" }]);
            setBusy(false);
            setStatus("Готово: " + plural(res.placed, "фото", "фото", "фото") + " в карточках 1–" + res.placed + "." +
                (res.extra ? " Ещё " + res.extra + " не поместились: карточек всего " + res.cards + "." : "") + " Отменить — Cmd/Ctrl+Z.", "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    function enableOrbit() {
        if (!ui.orbitPane) { return; }
        [["orbitLayout", "layout"], ["orbitShape", "shape"], ["orbitBackC", "backColor"]].forEach(function (g) {
            Array.prototype.forEach.call(ui[g[0]].querySelectorAll("button[data-v]"), function (b) {
                b.addEventListener("click", function () { setOrbit(g[1], b.getAttribute("data-v")); });
            });
        });
        [["orbitCorners", "corners"], ["orbitRadius", "radius"], ["orbitW", "w"], ["orbitH", "h"]].forEach(function (s) {
            ui[s[0]].addEventListener("input", function () { setOrbit(s[1], Math.round(Number(ui[s[0]].value))); });
        });
        ui.orbitLess.addEventListener("click", function () { setOrbitCount(orbit.count - 1); });
        ui.orbitMore.addEventListener("click", function () { setOrbitCount(orbit.count + 1); });
        ui.orbitCount.addEventListener("change", function () { setOrbitCount(ui.orbitCount.value); });
        ui.orbitCount.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { setOrbitCount(ui.orbitCount.value); }
            if (e.key === "ArrowUp") { e.preventDefault(); setOrbitCount(orbit.count + 1); }
            if (e.key === "ArrowDown") { e.preventDefault(); setOrbitCount(orbit.count - 1); }
        });
        ui.orbitNumbers.addEventListener("change", function () { setOrbit("numbers", ui.orbitNumbers.checked); });
        ui.orbitCamera.addEventListener("change", function () { setOrbit("camera", ui.orbitCamera.checked); });
        // «Свой» цвет: щелчок по уже выбранному «Свой» открывает выбор цвета.
        ui.orbitBackC.querySelector('[data-v="custom"]').addEventListener("click", function () { try { ui.orbitBackHex.click(); } catch (e) {} });
        ui.orbitBackHex.addEventListener("input", function () { orbit.backColor = "custom"; setOrbit("backHex", ui.orbitBackHex.value); });
        ui.orbitBtn.addEventListener("click", onOrbit);
        ui.orbitPhotos.addEventListener("click", onOrbitPhotos);
        // Крутить превью мышкой. События мыши, не указателя: указательные в After Effects не приходят.
        ui.orbitStage.addEventListener("mousedown", function (e) {
            if (e.button !== 0) { return; }
            e.preventDefault();
            orbitDrag = { x: e.clientX, spin: orbitSpin };
            ui.orbitStage.classList.add("dragging");
        });
        document.addEventListener("mousemove", function (e) {
            if (!orbitDrag) { return; }
            orbitSpin = orbitDrag.spin + (e.clientX - orbitDrag.x) * 0.6;
            drawOrbitPreview();
        }, true);
        document.addEventListener("mouseup", function () {
            if (!orbitDrag) { return; }
            orbitDrag = null;
            ui.orbitStage.classList.remove("dragging");
        }, true);
        drawOrbit();
    }

    function enableAc() {
        AC_SECTIONS.forEach(function (s) {
            var b = document.createElement("button");
            b.className = "ac-tab";
            b.setAttribute("role", "tab");
            b.setAttribute("data-sec", s.id);
            b.textContent = s.label;
            // В «Студии» подсказки под карточками нет — она всплывает при наведении на название раздела.
            if (s.id !== "orbit") { b.setAttribute("data-info", s.label + "|" + acHintText(s.id)); }
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
            // «Изменить» — в строке поиска, рядом с «Авто / Наведение» и ★.
            b.id = "acEdit";
            b.type = "button";
            b.className = "ac-edit-btn";
            b.setAttribute("aria-pressed", "false");
            b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg><span>Изменить</span>';
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
            ui.acFavOnly.parentNode.insertBefore(b, ui.acFavOnly);
        })();
        // Превью анимаций: «Авто» — играют сами, «Наведение» — только под курсором. Сохраняется в настройках.
        el("acPlay").addEventListener("click", function (e) {
            var b = e.target && e.target.closest ? e.target.closest("button[data-value]") : null;
            var v = b ? b.getAttribute("data-value") : null;
            if (v !== "always" && v !== "hover") { return; }
            settings.previewPlay = v;
            if (draft) { draft.previewPlay = v; pressGroup(ui.previewPlay, v); }
            storeSettings(settings);
            renderAc();
        });
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
        var r;
        if (busy || !ui.modal.hidden) { return; }
        try {
            r = await host("fxPopup", [pos.x, pos.y, fxState.fav, fxState.recent]);
            if (r && r.shown) {
                showFxWhereState("Последний вызов: мышь " + pos.x + ", " + pos.y + " (" + (pos.from || "помощник") + "), окно поставлено в " +
                    (r.at ? r.at.join(", ") : "?") + (r.asked && r.at && (r.asked[0] !== r.at[0] || r.asked[1] !== r.at[1]) ? " вместо " + r.asked.join(", ") : "") +
                    "; экраны: " + (r.screens || []).map(function (x) { return x.join(","); }).join(" | ") + ".");
            }
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

    // ---- Быстрый экспорт: MP4 для площадок. Окно-плашка под шапкой, кнопка ⤓ в шапке.
    var EXPORT_KEY = "sayframe.export.v1";
    // Окошки качества: размер видео = размер композиции, отличается только качество (битрейт H.264 из host.jsx).
    var EX_LEVELS = { light: { label: "Низкое", mbps: 5 }, normal: { label: "Среднее", mbps: 15 }, max: { label: "Высокое", mbps: 40 }, custom: { label: "Своё" } };
    var EX_ORDER = ["light", "normal", "max", "custom"];
    // Битрейт каждого качества меняется − и + на выбранном окошке, шагами EX_RATES. Выше 40 нет: у AE нет шаблона лучше.
    var EX_RATES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40];
    // H.264 в AE сжимает «по нужде»: простая графика выходит заметно меньше битрейта. Начинаем с 0,6 от битрейта,
    // после каждого сохранения подстраиваемся под настоящий размер файла.
    var EX_K = 0.6;
    var exState = { levels: ["normal"], quality: "normal", span: "all", fit: "blur", folder: "", ame: true, cw: 1080, ch: 1080, rates: {}, k: EX_K, kq: {} };
    var exInfo = null, exPollBusy = false, exPollKey = "", exFolderNow = "", exDefaultNow = "";
    // Название из окна «Сохранить как» — только для той композиции, для которой его дали.
    var exName = "", exNameComp = "";

    function exNameNow() { return exName && exInfo && exInfo.comp && exInfo.comp.name === exNameComp ? exName : ""; }
    try {
        (function () {
            var v = JSON.parse(window.localStorage.getItem(EXPORT_KEY) || "{}") || {};
            // Можно выбрать несколько окошек сразу — по видео на каждое.
            if (Object.prototype.toString.call(v.levels) === "[object Array]") {
                exState.levels = EX_ORDER.filter(function (k) { return v.levels.indexOf(k) >= 0; });
            } else if (EX_LEVELS[v.level]) { exState.levels = [v.level]; }
            if (!exState.levels.length) { exState.levels = ["normal"]; }
            if (/^(light|normal|max)$/.test(v.quality)) { exState.quality = v.quality; }
            if (/^(all|work)$/.test(v.span)) { exState.span = v.span; }
            if (/^(blur|black|crop)$/.test(v.fit)) { exState.fit = v.fit; }
            if (typeof v.folder === "string") { exState.folder = v.folder; }
            if (typeof v.ame === "boolean") { exState.ame = v.ame; }
            if (v.cw > 0) { exState.cw = Math.round(v.cw); }
            if (v.ch > 0) { exState.ch = Math.round(v.ch); }
            if (v.k >= 0.1 && v.k <= 1.3) { exState.k = v.k; }
            if (v.kq && typeof v.kq === "object") {
                ["light", "normal", "max"].forEach(function (q) { if (v.kq[q] >= 0.1 && v.kq[q] <= 1.3) { exState.kq[q] = v.kq[q]; } });
            }
            if (v.rates && typeof v.rates === "object") {
                ["light", "normal", "max"].forEach(function (k) { if (EX_RATES.indexOf(v.rates[k]) >= 0) { exState.rates[k] = v.rates[k]; } });
            }
        })();
    } catch (e) {}

    function storeExport() { try { window.localStorage.setItem(EXPORT_KEY, JSON.stringify(exState)); } catch (e) {} }

    // Размер видео: как у композиции, у «Своего» — введённый.
    function exPicked(id) { return exState.levels.indexOf(id) >= 0; }

    function exSize(id) {
        var c = exInfo ? exInfo.comp : { w: 1920, h: 1080 };
        if (id === "custom") { return { w: exState.cw, h: exState.ch }; }
        return { w: Math.round(c.w / 2) * 2, h: Math.round(c.h / 2) * 2 };
    }

    function exShape(w, h) { return Math.abs(w / h - 1) < 0.02 ? "квадратн" : (w > h ? "горизонтальн" : "вертикальн"); }

    function exQualityOf(level) { return level === "custom" ? exState.quality : level; }

    // Битрейт (Мбит/с) окошка: свой, если меняли − и +, иначе стандартный.
    function exRate(level) { var q = exQualityOf(level); return exState.rates[q] || EX_LEVELS[q].mbps; }

    function exStepRate(level, d) {
        var q = exQualityOf(level), r = exRate(level), i, next = r;
        if (d > 0) { for (i = 0; i < EX_RATES.length; i++) { if (EX_RATES[i] > r) { next = EX_RATES[i]; break; } } }
        else { for (i = EX_RATES.length - 1; i >= 0; i--) { if (EX_RATES[i] < r) { next = EX_RATES[i]; break; } } }
        if (next === EX_LEVELS[q].mbps) { delete exState.rates[q]; } else { exState.rates[q] = next; }
    }

    // Длина того, что сохраняем: вся композиция или рабочая область.
    function exDur() {
        var c = exInfo && exInfo.comp;
        if (!c) { return 0; }
        return exState.span === "work" && c.waDur > 0 ? c.waDur : c.dur;
    }

    // Примерный размер файла: битрейт видео × поправка по прошлым сохранениям + звук (~320 кбит/с), × длина.
    function exMBn(level) {
        return (exRate(level) * exK(exQualityOf(level)) + 0.32) * exDur() / 8;
    }

    // Узнали настоящий размер сохранённого видео — запоминаем, во сколько раз он меньше битрейта.
    // Поправка для качества: своя, если это качество уже сохраняли, иначе общая по всем сохранениям.
    function exK(q) { return exState.kq[q] || exState.k; }

    function exLearn(bytes, mbps, dur, q) {
        var k;
        if (!(bytes > 0 && mbps > 0 && dur > 0.5)) { return; }
        k = (bytes * 8 / 1e6 / dur - 0.32) / mbps;
        k = Math.max(0.1, Math.min(1.3, k));
        exState.k = Math.round((exState.k === EX_K ? k : (exState.k + k) / 2) * 1000) / 1000;
        // У каждого качества своя поправка: на низком битрейте After Effects экономит меньше, чем на высоком.
        if (EX_LEVELS[q] && q !== "custom") { exState.kq[q] = Math.round((exState.kq[q] ? (exState.kq[q] + k) / 2 : k) * 1000) / 1000; }
        storeExport();
    }

    function exMBText(mb) {
        if (!exInfo) { return ""; }
        return mb < 1 ? "< 1 МБ" : "≈ " + (mb < 10 ? (Math.round(mb * 10) / 10).toString().replace(".", ",") : Math.round(mb)) + " МБ";
    }

    function exMB(level) { return exMBText(exMBn(level)); }

    function exMismatch() {
        var c = exInfo && exInfo.comp, s = exSize("custom");
        return c && exPicked("custom") && Math.abs(s.w / s.h - c.w / c.h) > 0.01;
    }

    function showExFolder(path) {
        var parts = String(path || "").split(/[\\\/]/).filter(Boolean);
        exFolderNow = path;
        var nm = exNameNow();
        ui.exFolder.textContent = (path === exDefaultNow && exInfo && exInfo.projectFolder ? "Рядом с проектом / Экспорт" :
            "📁 " + (parts.length > 2 ? "…/" : "/") + parts.slice(-2).join("/")) + (nm ? "/" + nm + ".mp4" : "");
        ui.exFolder.title = path + (nm ? "/" + nm + ".mp4" : "");
    }

    function drawExport() {
        var c = exInfo && exInfo.comp, s, ar = c ? c.w / c.h : 16 / 9, mb = exMBText(exState.levels.reduce(function (a, id) { return a + exMBn(id); }, 0)), custom = exPicked("custom"), n = exState.levels.length;
        ui.exTargets.classList.toggle("ex-h", ar > 1.02);
        ui.exTargets.classList.toggle("ex-v", ar < 0.98);
        ui.exTargets.classList.toggle("ex-sq", ar >= 0.98 && ar <= 1.02);
        ui.exTargets.style.setProperty("--ar", String(Math.max(9 / 16, Math.min(16 / 9, ar))));
        Array.prototype.forEach.call(ui.exTargets.querySelectorAll(".ex-t"), function (b) {
            var id = b.getAttribute("data-t");
            b.setAttribute("aria-pressed", exPicked(id) ? "true" : "false");
            b.querySelector(".ex-mb").textContent = id === "custom" ? (custom ? exState.cw + "×" + exState.ch : "") : exMB(id);
            if (id !== "custom") {
                b.querySelector(".ex-rate em").textContent = String(exRate(id));
                b.querySelector('.ex-rate [data-d="-1"]').classList.toggle("off", exRate(id) <= EX_RATES[0]);
                b.querySelector('.ex-rate [data-d="1"]').classList.toggle("off", exRate(id) >= EX_RATES[EX_RATES.length - 1]);
            }
        });
        ui.exCustom.hidden = ui.exQualRow.hidden = !custom;
        if (document.activeElement !== ui.exW) { ui.exW.value = exState.cw; }
        if (document.activeElement !== ui.exH) { ui.exH.value = exState.ch; }
        [["exQuality", "quality"], ["exSpan", "span"], ["exFit", "fit"]].forEach(function (p) {
            Array.prototype.forEach.call(ui[p[0]].querySelectorAll("button[data-v]"), function (b) {
                b.setAttribute("aria-pressed", b.getAttribute("data-v") === exState[p[1]] ? "true" : "false");
            });
        });
        ui.exFitRow.hidden = !exMismatch();
        if (exMismatch()) {
            s = exSize("custom");
            ui.exFitText.textContent = "Композиция " + exShape(c.w, c.h) + "ая, а видео " + s.w + "×" + s.h + " — " + exShape(s.w, s.h) + "ое. Как сделать?";
        }
        ui.exAmeRow.hidden = !(exInfo && exInfo.ame);
        ui.exAme.checked = exState.ame;
        ui.exGo.textContent = (n > 1 ? "Сохранить " + n + " видео" : "Сохранить видео") + (mb ? " · " + mb : "");
        ui.exGo.disabled = busy || !exInfo;
    }

    async function onExport() {
        if (busy) { return; }
        if (!ui.exportBar.hidden) { closeExport(); return; }
        closeFxConsole();
        closeSnapBar();
        ui.exportBar.hidden = false;
        ui.exSetup.hidden = false;
        ui.exResults.hidden = true;
        exInfo = null;
        ui.exCompName.textContent = "Композиция";
        ui.exCompMeta.textContent = "";
        drawExport();
        await exLoadInfo();
        try { ui.exGo.focus(); } catch (e2) {}
    }

    // Что за композиция открыта и куда сохранять по умолчанию.
    async function exLoadInfo() {
        var res, c;
        try {
            res = await host("exportInfo", []);
            exInfo = res;
            c = res.comp;
            exPollKey = JSON.stringify(c);
            ui.exCompName.textContent = c.name;
            ui.exCompMeta.textContent = c.w + "×" + c.h + " · " + (Math.round(c.dur * 10) / 10) + " с";
            exDefaultNow = res.projectFolder ? platform.join(res.projectFolder, "Экспорт") : platform.join(platform.homedir(), "Desktop", "Sayframe Экспорт");
        } catch (e) {
            exInfo = null;
            exPollKey = JSON.stringify({ error: e && e.message });
            ui.exCompName.textContent = e && (e.message === "NO_ACTIVE_COMP" || e.message === "NO_SEQUENCE") ? (IS_PR ? "Откройте секвенцию, которую сохранить" : "Откройте композицию, которую сохранить") : "Нет связи с " + APP_NAME;
            exDefaultNow = platform.join(platform.homedir(), "Desktop", "Sayframe Экспорт");
        }
        showExFolder(exState.folder || exDefaultNow);
        drawExport();
    }

    // Пока окно открыто, следим за After Effects: сменили композицию или рабочую область — окошки и МБ обновляются сами.
    async function exPoll() {
        var res, key;
        if (ui.exportBar.hidden || busy || exPollBusy || ui.exSetup.hidden) { return; }
        exPollBusy = true;
        try {
            try { res = await host("exportInfo", []); } catch (e) { res = { error: e && e.message }; }
            key = JSON.stringify(res && res.comp ? res.comp : res);
            if (key !== exPollKey && !busy && !ui.exportBar.hidden) {
                exPollKey = key;
                await exLoadInfo();
            }
        } finally { exPollBusy = false; }
    }
    setInterval(exPoll, 1000);

    // В отдельном окне «Экспорт» закрывать нечего: окно и есть экспорт.
    function closeExport() { if (SOLO && !SOLO.tool && !SOLO.tab) { return; } ui.exportBar.hidden = true; }

    async function onExBrowse() {
        var res, start = exFolderNow || exDefaultNow;
        if (busy) { return; }
        try {
            if (start === exDefaultNow) { try { await platform.mkdirp(start); } catch (e1) {} }
            // Обычное окно «Сохранить как»: папка и название сразу, как в самом After Effects.
            res = await host("exportPickFile", [start, exNameNow() || (exInfo && exInfo.comp ? exInfo.comp.name : "Video"), "Сохранить видео"]);
            if (res.folder) {
                exState.folder = res.folder;
                storeExport();
                exName = res.name || "";
                exNameComp = exName && exInfo && exInfo.comp ? exInfo.comp.name : "";
                showExFolder(res.folder);
            }
        } catch (e) {
            setStatus("Не удалось выбрать папку: " + humanError(e), "error");
        }
    }

    function exSizeText(b) {
        if (!(b > 0)) { return ""; }
        return b >= 1048576 ? (Math.round(b / 104857.6) / 10).toString().replace(".", ",") + " МБ" : Math.max(1, Math.round(b / 1024)) + " КБ";
    }

    function exRow(job) {
        var row = document.createElement("div"), st = document.createElement("span"), nm = document.createElement("span"), sm = document.createElement("small");
        row.className = "ex-row";
        st.className = "ex-st"; st.textContent = "○";
        nm.className = "ex-nm"; nm.textContent = (exNameNow() || exInfo.comp.name) + (job.label ? " — " + job.label : "") + ".mp4";
        sm.textContent = "ждёт";
        row.appendChild(st); row.appendChild(nm); row.appendChild(sm);
        job.row = row; job.st = st; job.nm = nm; job.sm = sm;
        return row;
    }

    async function runExport() {
        var jobs, folder, name, now, bar, i, j, r, done = 0, failed = 0, ame = false, again, back, last = null, jobDur = exDur();
        if (busy || !exInfo) { return; }
        folder = exFolderNow || exDefaultNow;
        name = exNameNow();
        jobs = exState.levels.map(function (id) {
            var s = exSize(id);
            // Своё название и одно видео — файл ровно с этим названием; несколько — к названию добавляется качество.
            return { id: id, w: s.w, h: s.h, label: name && exState.levels.length === 1 ? "" : id === "custom" ? s.w + "x" + s.h : EX_LEVELS[id].label, quality: exQualityOf(id), mbps: exRate(id) };
        });
        setBusy(true);
        ui.exSetup.hidden = true;
        ui.exResults.hidden = false;
        ui.exResults.textContent = "";
        ui.exResults.classList.remove("finished");
        now = document.createElement("div"); now.className = "ex-now";
        bar = document.createElement("div"); bar.className = "ex-bar-track"; bar.appendChild(document.createElement("i"));
        ui.exResults.appendChild(now); ui.exResults.appendChild(bar);
        jobs.forEach(function (job) { ui.exResults.appendChild(exRow(job)); });
        setStatus("Сохраняю видео…", "busy");
        try {
            if (!(await host("info", [])).fileAccess) { throw new Error(FILE_ACCESS_HINT); }
            await platform.mkdirp(folder);
        } catch (e0) {
            jobs.forEach(function (job) { job.row.classList.add("fail"); job.st.textContent = "!"; job.sm.textContent = ""; });
            now.textContent = "Не получилось начать";
            ui.exResults.classList.add("finished");
            setBusy(false);
            exBackRow();
            setStatus("Не удалось сохранить видео: " + humanError(e0), "error");
            return;
        }
        for (i = 0; i < jobs.length; i++) {
            j = jobs[i];
            now.textContent = "Сохраняю «" + (name || exInfo.comp.name) + "»" + (j.label ? " — " + j.label : "") + (jobs.length > 1 ? " (" + (i + 1) + " из " + jobs.length + ")" : "");
            j.st.textContent = "●"; j.sm.textContent = "сохраняю…";
            bar.firstChild.style.width = Math.round(i / jobs.length * 100) + "%";
            try {
                r = await host("exportOne", [{ w: j.w, h: j.h, label: j.label, name: name, fit: exState.fit, quality: j.quality, mbps: j.mbps, span: exState.span,
                    folder: folder, ame: !!(exInfo.ame && exState.ame), bin: "Sayframe Экспорт" }]);
                done++;
                last = r.path;
                j.row.classList.add("done");
                j.st.textContent = "✓";
                j.nm.textContent = r.name || platform.basename(r.path);
                j.nm.title = r.path;
                if (r.mode === "ame") { ame = true; j.sm.textContent = "в Media Encoder"; } else { j.sm.textContent = exSizeText(r.size); exLearn(r.size, r.mbps || j.mbps, jobDur, j.quality); }
                // Битрейт, с которым сохранили; без Media Encoder — ближайший шаблон AE (5, 15 или 40).
                if (r.mbps > 0) {
                    j.sm.textContent += " · " + r.mbps + " Мбит/с";
                    if (j.mbps && r.mbps !== j.mbps) { j.sm.title = "Без Media Encoder After Effects умеет только 5, 15 и 40 Мбит/с — взят ближайший"; }
                }
                j.row.appendChild(exShowBtn(r.path));
            } catch (e) {
                failed++;
                j.row.classList.add("fail");
                j.st.textContent = "!";
                j.sm.textContent = "";
                j.nm.title = humanError(e);
                j.nm.textContent = j.label + ": " + humanError(e);
                if (e && (e.message === "NO_ACTIVE_COMP" || e.message === "HOST_ERROR")) { break; }
            }
        }
        ui.exResults.classList.add("finished");
        setBusy(false);
        now.textContent = failed ? (done ? "Сохранено " + done + " из " + jobs.length : "Не получилось сохранить") :
            (ame ? "Отправлено в Media Encoder — он сохранит видео в фоне" : (done > 1 ? "Готово, " + done + " видео" : "Готово"));
        exBackRow();
        setStatus(failed ? "Сохранить получилось не всё — причина в строке с ошибкой." :
            (ame ? "Видео ушли в Media Encoder. Папка: " + platform.basename(folder) + "." : "Видео сохранены в папку «" + platform.basename(folder) + "»."), failed ? "error" : "done");
    }

    function exShowBtn(path) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "ghost"; b.textContent = "Показать"; b.title = "Открыть папку с видео";
        b.addEventListener("click", function () {
            host("exportReveal", [path]).catch(function (e) { setStatus("Не удалось открыть папку: " + humanError(e), "error"); });
        });
        return b;
    }

    function exBackRow() {
        var row = document.createElement("div"), b = document.createElement("button");
        row.className = "ex-again";
        b.type = "button"; b.className = "ghost"; b.textContent = "Назад к настройкам";
        b.addEventListener("click", function () { ui.exResults.hidden = true; ui.exSetup.hidden = false; drawExport(); try { ui.exGo.focus(); } catch (e) {} });
        row.appendChild(b);
        ui.exResults.appendChild(row);
    }

    function enableExport() {
        ui.exportBtn.addEventListener("click", onExport);
        ui.exClose.addEventListener("click", closeExport);
        ui.exBrowse.addEventListener("click", onExBrowse);
        ui.exGo.addEventListener("click", runExport);
        ui.exTargets.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest(".ex-t") : null, st = e.target.closest ? e.target.closest(".ex-rate [data-d]") : null, id;
            if (!b) { return; }
            if (st && b.getAttribute("aria-pressed") === "true") {
                if (!st.classList.contains("off")) { exStepRate(b.getAttribute("data-t"), Number(st.getAttribute("data-d"))); }
                storeExport();
                drawExport();
                return;
            }
            // Клик добавляет окошко или убирает его; одно всегда остаётся.
            id = b.getAttribute("data-t");
            if (!exPicked(id)) {
                exState.levels = EX_ORDER.filter(function (k) { return k === id || exPicked(k); });
            } else if (exState.levels.length > 1) {
                exState.levels = exState.levels.filter(function (k) { return k !== id; });
            }
            storeExport();
            drawExport();
        });
        [["exQuality", "quality"], ["exSpan", "span"], ["exFit", "fit"]].forEach(function (p) {
            ui[p[0]].addEventListener("click", function (e) {
                var b = e.target.closest ? e.target.closest("button[data-v]") : null;
                if (!b) { return; }
                exState[p[1]] = b.getAttribute("data-v");
                storeExport();
                drawExport();
            });
        });
        ["exW", "exH"].forEach(function (id) {
            ui[id].addEventListener("input", function () {
                var v = Math.round(Number(ui[id].value));
                if (v >= 16 && v <= 8192) { exState[id === "exW" ? "cw" : "ch"] = v; storeExport(); drawExport(); }
            });
        });
        ui.exAme.addEventListener("change", function () { exState.ame = ui.exAme.checked; storeExport(); });
        // Esc закрывает окно, пока фокус в нём или нигде (например, после «Назад к настройкам»).
        document.addEventListener("keydown", function (e) {
            var a = document.activeElement;
            if (e.key !== "Escape" || ui.exportBar.hidden || busy) { return; }
            if (a && a !== document.body && !ui.exportBar.contains(a)) { return; }
            e.preventDefault(); e.stopPropagation(); closeExport();
        }, true);
        drawExport();
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
        { id: "split", label: "Разделить / объединить шейпы", def: "" },
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
        else if (id === "split") { onSplitMerge(); }
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
        // Сочетания по всему After Effects слушает только большой Sayframe, иначе одно нажатие сработает в каждом окне.
        if (SOLO || IS_PR) { return; }
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
        // Поиск у курсора: After Effects не говорит, где мышь. Даём наблюдателю время прислать нажатие
        // с местом мыши; если он молчит (на Mac без «Мониторинга ввода» он нажатий не видит) — спрашиваем
        // место мыши у системы сами, на это разрешение не нужно.
        if (id === "console" && src === "host" && !pos && settings.fxWhere === "cursor" && !fxOpen()) {
            clearTimeout(hostConsoleWait);
            hostConsoleWait = setTimeout(function () {
                hostConsoleWait = 0;
                if (lastPanelHotkey.id === id && Date.now() - lastPanelHotkey.at < 800) { return; }
                mousePosition().then(function (at) { outsideHotkey(id, "host", at || { none: true }); });
            }, keyWatch && keyWatch.ready ? WATCH_WAIT_MS : 0);
            return;
        }
        if (pos && pos.none) { pos = null; }
        if (id === "console" && src === "watch" && hostConsoleWait) { clearTimeout(hostConsoleWait); hostConsoleWait = 0; }
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

    // Что произошло при последнем поиске «у курсора» — видно в настройках, под выбором места поиска.
    function showFxWhereState(text) {
        ui.fxWhereState.textContent = text;
        ui.fxWhereState.hidden = !text;
    }

    var WATCH_WAIT_MS = 250;
    var hostConsoleWait = 0;

    // Где сейчас мышь, в точках экрана от левого верхнего угла главного экрана (как у окон After Effects).
    async function mousePosition() {
        var r, m;
        if (!platform.available || typeof platform.exec !== "function") { return null; }
        try {
            r = platform.isWindows() ?
                await platform.exec("powershell", ["-NoProfile", "-Command",
                    "Add-Type -AssemblyName System.Windows.Forms; $m = [System.Windows.Forms.Cursor]::Position; [Console]::Out.WriteLine('' + $m.X + ' ' + $m.Y)"], 5000) :
                await platform.exec("osascript", ["-l", "JavaScript", "-e",
                    'ObjC.import("AppKit"); var m = $.NSEvent.mouseLocation, h = $.NSScreen.screens.objectAtIndex(0).frame.size.height; Math.round(m.x) + " " + Math.round(h - m.y)'], 5000);
        } catch (e) { showFxWhereState("Последний вызов: система не сказала, где мышь (" + String(e && e.message || e).slice(0, 160) + "), поиск открыт в панели."); return null; }
        m = /(-?\d+)\s+(-?\d+)/.exec(r && r.code === 0 ? r.stdout : "");
        if (!m) { showFxWhereState("Последний вызов: система не сказала, где мышь (" + String(r && (r.stderr || r.stdout) || "").replace(/\s+/g, " ").slice(0, 160) + "), поиск открыт в панели."); return null; }
        return { x: +m[1], y: +m[2], from: "система" };
    }

    function listenHostHotkeys() {
        var cep = window.__adobe_cep__;
        if (cep && typeof cep.addEventListener === "function") {
            if (!SOLO && !IS_PR) {
                try { cep.addEventListener(HOST_KEY_EVENT, onHostHotkey); } catch (e) {}
                try { cep.addEventListener(FX_EVENT, onFxPopupApplied); } catch (e2) {}
            }
            // В After Effects поменяли яркость интерфейса — тема «After Effects» перекрашивается сразу.
            try { cep.addEventListener("com.adobe.csxs.events.ThemeColorChanged", function () { applyHostSkin(document.documentElement.getAttribute("data-design") === "ae"); }); } catch (e3) {}
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
        showSetPane("keys");
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

    var SM_NOTES = { "3d": "3D слоя не перенесено (группы плоские)", effects: "эффекты слоёв не перенесены", masks: "маски слоёв не перенесены",
        separated: "у положения с раздельными X и Y взято только значение, без ключей" };

    function splitReport(r) {
        var s = r.split, m = r.merged, list, notes = [];
        if (s) {
            list = s.names.length > 8 ? s.names.slice(0, 8).join(", ") + " и ещё " + (s.names.length - 8) : s.names.join(", ");
            return "Разделено: «" + s.name + "» → " + plural(s.count, "слой", "слоя", "слоёв") +
                (s.kind === "masks" ? " (по маскам)" : "") + ": " + list + ". Отменить — Cmd/Ctrl+Z.";
        }
        (m.notes || []).forEach(function (n) { if (SM_NOTES[n] && notes.indexOf(SM_NOTES[n]) < 0) { notes.push(SM_NOTES[n]); } });
        return "Собрано в один шейп: «" + m.name + "» из " + m.count + " слоёв, каждый стал группой." +
            (m.skipped.length ? " Не шейпы, пропущены: " + m.skipped.join(", ") + "." : "") +
            (notes.length ? " Учтите: " + notes.join("; ") + "." : "") + " Отменить — Cmd/Ctrl+Z.";
    }

    async function onSplitMerge() {
        var res;
        if (busy) { return; }
        setBusy(true);
        try {
            res = await host("shapeSplitMerge", []);
            setBusy(false);
            setStatus(splitReport(res), "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    // ---- «Плашка под текстом» (вкладка «Шейп»): шейп-слой под текстом, который подстраивается под текст.
    // Превью в блоке рисуется CSS и меняется сразу; в After Effects то же самое делают выражения (host textBox).
    var TB_KEY = "sayframe.textbox.v1";
    var TB_DEFAULTS = { per: "line", look: "fill", style: "box", color: "#3a0f63", strokeColor: "#ffffff", px: 18, py: 6, round: 0, stroke: 4, skew: 0, opacity: 100, shadow: false, glow: false };
    // Готовый стиль задаёт всё сразу (то, чего в нём нет, — как в TB_BASE), чтобы от прошлого стиля ничего не оставалось.
    var TB_BASE = { look: "fill", style: "box", strokeColor: "#ffffff", stroke: 4, round: 0, skew: 0, opacity: 100, shadow: false, glow: false };
    var TB_PRESETS = {
        news: { per: "line", color: "#111111", px: 16, py: 4 },
        sport: { per: "line", color: "#ff4f6d", px: 22, py: 6, skew: 14 },
        sticker: { per: "all", color: "#ffffff", px: 26, py: 12, round: 18, shadow: true },
        pill: { per: "all", color: "#3a0f63", px: 34, py: 12, round: 100 },
        frame: { per: "all", look: "stroke", strokeColor: "#ffffff", stroke: 4, px: 28, py: 14, round: 40 },
        marker: { per: "line", style: "marker", color: "#ffcc33", px: 6, py: 0 },
        neon: { per: "all", look: "stroke", strokeColor: "#39ff88", stroke: 6, px: 30, py: 12, round: 100, glow: true },
        caption: { per: "line", color: "#ffffff", px: 14, py: 6, round: 12 },
        comic: { per: "all", look: "both", color: "#ffe14d", strokeColor: "#111111", stroke: 6, px: 22, py: 10, round: 6, skew: -6, shadow: true },
        cinema: { per: "all", color: "#000000", px: 40, py: 10, opacity: 70 },
        soft: { per: "line", color: "#ff7ab6", px: 20, py: 4, round: 100 },
        slant: { per: "line", color: "#1e90ff", px: 26, py: 6, skew: 25 },
        brutal: { per: "all", look: "both", color: "#ffffff", strokeColor: "#111111", stroke: 4, px: 22, py: 10, shadow: true },
        glass: { per: "all", look: "both", color: "#ffffff", strokeColor: "#ffffff", stroke: 2, px: 26, py: 12, round: 24, opacity: 30 },
        price: { per: "all", color: "#ff3b30", px: 22, py: 8, round: 8, skew: -10, shadow: true }
    };
    function tbPreset(k) { var o = {}, j; for (j in TB_BASE) { if (TB_BASE.hasOwnProperty(j)) { o[j] = TB_BASE[j]; } } for (j in TB_PRESETS[k]) { if (TB_PRESETS[k].hasOwnProperty(j)) { o[j] = TB_PRESETS[k][j]; } } return o; }
    var TB_RANGES = { px: [0, 120], py: [0, 80], round: [0, 100], stroke: [1, 30], skew: [-40, 40], opacity: [0, 100] };
    var TB_CHOICES = { per: ["all", "line"], look: ["fill", "stroke", "both"], style: ["box", "marker"] };

    function tbClean(src) {
        var o = {}, k;
        for (k in TB_DEFAULTS) { if (TB_DEFAULTS.hasOwnProperty(k)) { o[k] = TB_DEFAULTS[k]; } }
        if (src && typeof src === "object") {
            for (k in TB_DEFAULTS) {
                if (TB_DEFAULTS.hasOwnProperty(k) && typeof src[k] === typeof TB_DEFAULTS[k]) { o[k] = src[k]; }
            }
        }
        for (k in TB_RANGES) { if (TB_RANGES.hasOwnProperty(k)) { o[k] = Math.max(TB_RANGES[k][0], Math.min(TB_RANGES[k][1], Math.round(Number(o[k]) || 0))); } }
        for (k in TB_CHOICES) { if (TB_CHOICES.hasOwnProperty(k) && TB_CHOICES[k].indexOf(o[k]) < 0) { o[k] = TB_DEFAULTS[k]; } }
        if (!parseHex(o.color)) { o.color = TB_DEFAULTS.color; }
        if (!parseHex(o.strokeColor)) { o.strokeColor = TB_DEFAULTS.strokeColor; }
        o.color = parseHex(o.color).hex; o.strokeColor = parseHex(o.strokeColor).hex;
        return o;
    }

    var tb = (function () { try { return tbClean(JSON.parse(window.localStorage.getItem(TB_KEY) || "null")); } catch (e) { return tbClean(null); } })();

    function storeTb() { try { window.localStorage.setItem(TB_KEY, JSON.stringify(tb)); } catch (e) {} }

    // Превью плашки o на элементе t; z — масштаб (плитки стилей маленькие).
    function tbLook(t, o, z) {
        var s = t.style, fill = o.look !== "stroke", line = o.look !== "fill", k, glow;
        z = z || 1;
        t.classList.toggle("tb-all", o.per === "all");
        t.classList.toggle("tb-marker", o.style === "marker");
        s.setProperty("--px", o.px * z + "px");
        s.setProperty("--py", o.py * z + "px");
        s.setProperty("--r", o.round * z + "px");
        s.setProperty("--fill", fill ? o.color : "transparent");
        s.setProperty("--stroke", o.strokeColor);
        s.setProperty("--sw", line ? Math.max(1, Math.round(o.stroke / 2 * z)) + "px" : "0px");
        s.setProperty("--skew", String(o.skew));
        s.setProperty("--op", String(o.opacity / 100));
        glow = line ? o.strokeColor : o.color;
        s.setProperty("--shadow", [o.shadow ? 6 * z + "px " + 6 * z + "px 0 rgba(0,0,0,.45)" : "", o.glow ? "0 0 " + 12 * z + "px " + glow + ", inset 0 0 " + 6 * z + "px " + glow : ""].filter(Boolean).join(", ") || "none");
        // Светлая плотная плашка — тёмный текст, чтобы его было видно.
        k = parseHex(o.color);
        s.color = fill && o.style === "box" && o.opacity >= 60 && k && (0.299 * k.r + 0.587 * k.g + 0.114 * k.b) / 255 > 0.6 ? "#3a0f63" : "#fff";
    }

    function drawTb() {
        var t = ui.tbText, k, cur = "";
        if (!t) { return; }
        tbLook(t, tb, 1);
        // Какой готовый стиль сейчас (если ничего не меняли после него) — подсвечен.
        for (k in TB_PRESETS) { if (TB_PRESETS.hasOwnProperty(k) && !cur && tbSame(tbPreset(k))) { cur = k; } }
        Array.prototype.forEach.call(ui.tbPresets.querySelectorAll("button[data-v]"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === cur)); });
        ["per", "look", "style"].forEach(function (key) { pressGroupV(ui["tb" + key.charAt(0).toUpperCase() + key.slice(1)], tb[key]); });
        Array.prototype.forEach.call(ui.tbSwatches.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-v") === tb.color ? "true" : "false"); });
        ui.tbColor.value = tb.color;
        ui.tbStrokeColor.value = tb.strokeColor;
        ui.tbStrokeRow.hidden = ui.tbStrokeWRow.hidden = tb.look === "fill";
        [["Px", "px", ""], ["Py", "py", ""], ["Round", "round", ""], ["Stroke", "stroke", ""], ["Skew", "skew", "°"], ["Opacity", "opacity", "%"]].forEach(function (d) {
            ui["tb" + d[0]].value = String(tb[d[1]]);
            ui["tb" + d[0] + "Val"].textContent = tb[d[1]] + d[2];
        });
        ui.tbShadow.checked = tb.shadow;
        ui.tbGlow.checked = tb.glow;
    }
    function tbSame(o) { var k; for (k in o) { if (o.hasOwnProperty(k) && String(o[k]).toLowerCase() !== String(tb[k]).toLowerCase()) { return false; } } return true; }

    function setTb(changes) {
        var k;
        for (k in changes) { if (changes.hasOwnProperty(k)) { tb[k] = changes[k]; } }
        tb = tbClean(tb);
        storeTb();
        drawTb();
        mkTouched("textbox");
    }

    function tbRgb(hex) { var c = parseHex(hex); return [c.r / 255, c.g / 255, c.b / 255]; }

    async function onTextBox() {
        var res, r, n;
        if (busy) { return; }
        setBusy(true);
        try {
            res = await host("textBox", [{ per: tb.per, look: tb.look, style: tb.style, color: tbRgb(tb.color), strokeColor: tbRgb(tb.strokeColor),
                px: tb.px, py: tb.py, round: tb.round, stroke: tb.stroke, skew: tb.skew, opacity: tb.opacity, shadow: tb.shadow, glow: tb.glow },
                { box: "Плашка", helper: "Плашка: строка", part: "Плашка", side: "По бокам", vert: "Сверху/снизу", round: "Скругление", color: "Цвет",
                    fillOn: "Заливка", strokeOn: "Обводка", strokeW: "Толщина обводки", strokeColor: "Цвет обводки", skew: "Наклон", defaultText: "Ваш текст" }, mkArg("textbox")]);
            setBusy(false);
            r = res.textBox.boxes;
            n = r.length;
            setStatus((res.textBox.made ? "Текст не был выделен — создал «" + res.textBox.made + "». " : "") + "Плашка готова: " + (n === 1 ? "«" + r[0].box + "»" : plural(n, "слой", "слоя", "слоёв")) + ". Она подстраивается под текст сама; " +
                "цвет, отступы, скругление, обводка и наклон — в Effect Controls плашки." + (r[0].lines ? " Под каждую строку своя плашка (и запас на две новые строки)." : "") +
                " Отменить — Cmd/Ctrl+Z.", "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    function enableTextBox() {
        if (!ui.tbText) { return; }
        ["per", "look", "style"].forEach(function (key) {
            var box = ui["tb" + key.charAt(0).toUpperCase() + key.slice(1)];
            box.addEventListener("click", function (e) {
                var b = e.target.closest ? e.target.closest("button[data-v]") : null, ch = {};
                if (!b) { return; }
                ch[key] = b.getAttribute("data-v");
                setTb(ch);
            });
        });
        ui.tbPresets.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest("button[data-v]") : null;
            if (b && TB_PRESETS[b.getAttribute("data-v")]) { setTb(tbPreset(b.getAttribute("data-v"))); }
        });
        ui.tbSwatches.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest("button[data-v]") : null;
            if (b) { setTb({ color: b.getAttribute("data-v"), look: tb.look === "stroke" ? "fill" : tb.look }); }
        });
        ui.tbColor.addEventListener("input", function () { setTb({ color: ui.tbColor.value }); });
        ui.tbStrokeColor.addEventListener("input", function () { setTb({ strokeColor: ui.tbStrokeColor.value }); });
        [["Px", "px"], ["Py", "py"], ["Round", "round"], ["Stroke", "stroke"], ["Skew", "skew"], ["Opacity", "opacity"]].forEach(function (d) {
            ui["tb" + d[0]].addEventListener("input", function () { var ch = {}; ch[d[1]] = Number(ui["tb" + d[0]].value); setTb(ch); });
        });
        ui.tbShadow.addEventListener("change", function () { setTb({ shadow: ui.tbShadow.checked }); });
        ui.tbGlow.addEventListener("change", function () { setTb({ glow: ui.tbGlow.checked }); });
        Array.prototype.forEach.call(ui.tbPresets.querySelectorAll("button[data-v]"), function (b) {
            var tx = b.querySelector(".tb-text");
            if (tx && TB_PRESETS[b.getAttribute("data-v")]) { tbLook(tx, tbClean(tbPreset(b.getAttribute("data-v"))), 0.5); }
        });
        ui.tbBtn.addEventListener("click", onTextBox);
        drawTb();
    }

    // ---- Жидкое стекло (Анимация › Макеты): с текстом (кнопка, карточка, плашка, пуш) или без — фигура; вид стекла и обводка отдельно.
    // «Добавить в кадр» собирает выбранное в композиции, «Сделать стеклом» делает стеклом свою выделенную фигуру (host glassMake).
    var GL_KEY = "sayframe.glass.v1";
    var GL_DEFAULTS = { mode: "text", text: "Подписаться", form: "btn", shape: "heart", kind: "clear", edge: "std", blur: 25, light: 70, size: 40 };
    var GL_FORMS = [["btn", "Кнопка"], ["card", "Карточка"], ["box", "Плашка"], ["note", "Пуш"]];
    var GL_SHAPES = [["circle", "Круг"], ["square", "Квадрат"], ["round", "Скруглённый"], ["heart", "Сердце"], ["star", "Звезда"], ["pill", "Капсула"], ["tri", "Треугольник"], ["hex", "6-угольник"]];
    var GL_KINDS = [["clear", "Прозрачное", "rgba(255,255,255,.08)", 15], ["frost", "Матовое", "rgba(255,255,255,.22)", 60], ["tint", "Цветное", "rgba(122,90,245,.38)", 30], ["dark", "Тёмное", "rgba(10,10,14,.5)", 35]];
    var GL_EDGES = [["std", "Обычная"], ["thin", "Тонкая"], ["run", "Бегущая"], ["dash", "Пунктир"], ["none", "Без обводки"], ["glow", "Свечение"]];
    var GL_HEART = [[[50, 90], [16, -14], [-16, -14]], [[6, 36], [0, 18], [0, -14]], [[28, 10], [-12, 0], [12, 0]],
        [[50, 24], [-3, -9], [3, -9]], [[72, 10], [-12, 0], [12, 0]], [[94, 36], [0, -14], [0, 18]]];
    var GL_BG = "<i class=\"gl-b1\"></i><i class=\"gl-b2\"></i><i class=\"gl-b3\"></i><i class=\"gl-b4\"></i>";

    function glClean(src) {
        var o = {}, k, ids = function (list) { return list.map(function (x) { return x[0]; }); };
        for (k in GL_DEFAULTS) { if (GL_DEFAULTS.hasOwnProperty(k)) { o[k] = src && typeof src === "object" && typeof src[k] === typeof GL_DEFAULTS[k] ? src[k] : GL_DEFAULTS[k]; } }
        if (["text", "shape"].indexOf(o.mode) < 0) { o.mode = "text"; }
        if (ids(GL_FORMS).indexOf(o.form) < 0) { o.form = "btn"; }
        if (ids(GL_SHAPES).indexOf(o.shape) < 0) { o.shape = "heart"; }
        if (ids(GL_KINDS).indexOf(o.kind) < 0) { o.kind = "clear"; }
        if (ids(GL_EDGES).indexOf(o.edge) < 0) { o.edge = "std"; }
        o.text = String(o.text).slice(0, 40);
        o.blur = Math.max(0, Math.min(100, Math.round(o.blur))); if (isNaN(o.blur)) { o.blur = 25; }
        o.light = Math.max(0, Math.min(100, Math.round(o.light))); if (isNaN(o.light)) { o.light = 70; }
        o.size = Math.max(10, Math.min(100, Math.round(o.size))); if (isNaN(o.size)) { o.size = 40; }
        return o;
    }

    var glass = (function () { try { return glClean(JSON.parse(window.localStorage.getItem(GL_KEY) || "null")); } catch (e) { return glClean(null); } })();

    // Контур фигуры в квадрате 100×100 — тот же, что строит After Effects.
    function glPath(id) {
        var d = "", i, a, r, pts = [], h = GL_HEART;
        var poly = function (n, r1, r2) { var o = [], k; for (k = 0; k < n * (r2 ? 2 : 1); k++) { a = -Math.PI / 2 + k * Math.PI * 2 / (n * (r2 ? 2 : 1)); r = r2 && k % 2 ? r2 : r1; o.push((50 + Math.cos(a) * r).toFixed(1) + " " + (52 + Math.sin(a) * r).toFixed(1)); } return "M" + o.join("L") + "Z"; };
        switch (id) {
        case "circle": return "M50 6a44 44 0 1 0 0.01 0Z";
        case "square": return "M8 8H92V92H8Z";
        case "round": return "M30 8H70A22 22 0 0 1 92 30V70A22 22 0 0 1 70 92H30A22 22 0 0 1 8 70V30A22 22 0 0 1 30 8Z";
        case "pill": return "M28 30H72A20 20 0 0 1 72 70H28A20 20 0 0 1 28 30Z";
        case "star": return poly(5, 46, 20);
        case "tri": return poly(3, 48);
        case "hex": return poly(6, 46);
        case "heart":
            for (i = 0; i < h.length; i++) { pts.push(h[i]); }
            d = "M" + h[0][0].join(" ");
            for (i = 0; i < h.length; i++) {
                var A = h[i], B = h[(i + 1) % h.length];
                d += "C" + (A[0][0] + A[2][0]) + " " + (A[0][1] + A[2][1]) + " " + (B[0][0] + B[1][0]) + " " + (B[0][1] + B[1][1]) + " " + B[0][0] + " " + B[0][1];
            }
            return d + "Z";
        }
        return "";
    }

    function glEsc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

    function glFormHtml(form, text) {
        var t = glEsc(text || "Ваш текст");
        if (form === "btn") { return "<div class=\"gl-g gl-btn\">" + t + "</div>"; }
        if (form === "box") { return "<div class=\"gl-g gl-box\">" + glEsc((text || "Ваш текст").toUpperCase()) + "</div>"; }
        if (form === "card") { return "<div class=\"gl-g gl-card\"><b>" + t + "</b><small>Пара строк текста</small></div>"; }
        return "<div class=\"gl-g gl-note\"><i></i><span><b>Sayframe</b><small>" + t + "</small></span></div>";
    }

    function drawGlass() {
        var k, kind;
        if (!ui.glForms) { return; }
        kind = GL_KINDS.filter(function (x) { return x[0] === glass.kind; })[0];
        ui.glPane.style.setProperty("--glt", kind[2]);
        ui.glPane.style.setProperty("--glb", Math.round(glass.blur * 0.16) + "px");
        ui.glPane.setAttribute("data-edge", glass.edge);
        pressGroupV(ui.glMode, glass.mode);
        ui.glTextPart.hidden = glass.mode !== "text";
        ui.glShapePart.hidden = glass.mode !== "shape";
        ui.glSizeRow.hidden = glass.mode !== "shape";
        if (document.activeElement !== ui.glText) { ui.glText.value = glass.text; }
        Array.prototype.forEach.call(ui.glForms.querySelectorAll(".gl-tile"), function (b) {
            b.querySelector(".gl-in").innerHTML = glFormHtml(b.getAttribute("data-v"), glass.text);
            b.setAttribute("aria-pressed", b.getAttribute("data-v") === glass.form ? "true" : "false");
        });
        k = glPath(glass.shape);
        ui.glStage.querySelector(".gl-shape").style.setProperty("-webkit-mask-image", "url(\"data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><path d='" + k + "'/></svg>") + "\")");
        ui.glStage.querySelector(".gl-line").setAttribute("d", k);
        ui.glStage.style.setProperty("--gls", (40 + glass.size * 0.9) + "px");
        pressGroupV(ui.glShapes, glass.shape);
        pressGroupV(ui.glKinds, glass.kind);
        pressGroupV(ui.glEdges, glass.edge);
        ui.glKindName.textContent = kind[1];
        ui.glBlur.value = String(glass.blur); ui.glBlurVal.textContent = String(glass.blur);
        ui.glLight.value = String(glass.light); ui.glLightVal.textContent = String(glass.light);
        ui.glSize.value = String(glass.size); ui.glSizeVal.textContent = glass.size + "%";
        ui.glAdd.querySelector("span").textContent = glass.mode === "text" ? "Добавить " + { btn: "кнопку", card: "карточку", box: "плашку", note: "пуш" }[glass.form] : "Добавить в кадр";
    }

    function setGlass(changes) {
        var k;
        for (k in changes) { if (changes.hasOwnProperty(k)) { glass[k] = changes[k]; } }
        glass = glClean(glass);
        try { window.localStorage.setItem(GL_KEY, JSON.stringify(glass)); } catch (e) {}
        drawGlass();
        mkTouched("glass");
    }

    function glLabels() {
        return { glass: "Жидкое стекло", edge: "Стекло: блик", shape: "Стекло", stroke: "Стекло: обводка",
            strokeWidth: "Толщина обводки", strokeColor: "Цвет обводки", strokeOpacity: "Прозрачность обводки",
            btn: "Стекло: кнопка", card: "Стекло: карточка", box: "Стекло: плашка", note: "Стекло: пуш",
            circle: "Стекло: круг", square: "Стекло: квадрат", round: "Стекло: скруглённый", heart: "Стекло: сердце", star: "Стекло: звезда",
            pill: "Стекло: капсула", tri: "Стекло: треугольник", hex: "Стекло: 6-угольник",
            title: "Заголовок", sub: "Пара строк текста", subName: "Текст", icon: "Иконка", app: "Sayframe", appName: "Название", noteText: "Текст",
            defaultText: "Ваш текст" };
    }

    async function onGlass(mine) {
        var res, g, what;
        if (busy) { return; }
        setBusy(true);
        if (!mkEdit || mkEdit.kind !== "glass") { mkGlassMine = !!mine; }
        setStatus(mine ? "Делаю фигуру стеклянной…" : "Собираю стекло…", "busy");
        try {
            res = await host("glassMake", [{ mode: mine ? "mine" : glass.mode, text: glass.text, form: glass.form, shape: glass.shape, kind: glass.kind,
                edge: glass.edge, blur: glass.blur, light: glass.light, size: glass.size }, glLabels(), mkArg("glass")]);
            setBusy(false);
            g = res.glass;
            what = mine ? "Фигура «" + g.shape + "» стала стеклом." : "Стекло «" + g.shape + "» готово" + (g.texts && g.texts.length ? ", текст — слой «" + g.texts[g.texts.length - 1] + "»" : "") + ".";
            setStatus(what + (g.free ? " Стекло само подстраивается под текст: меняйте и двигайте текст." : " Двигайте «" + g.shape + "» — стекло, блик и текст идут за ней.") +
                " Размытие и яркость — в Effect Controls слоя «" + g.name + "». Отменить — Cmd/Ctrl+Z.", "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    function enableGlass() {
        if (!ui.glForms) { return; }
        ui.glForms.innerHTML = GL_FORMS.map(function (f) {
            return "<button type=\"button\" class=\"gl-tile\" data-v=\"" + f[0] + "\" aria-label=\"" + f[1] + "\"><span class=\"gl-stage\">" + GL_BG + "<span class=\"gl-in\"></span></span><span class=\"gl-nm\">" + f[1] + "</span></button>";
        }).join("");
        ui.glStage.innerHTML = GL_BG + "<i class=\"gl-shape\"></i><svg class=\"gl-out\" viewBox=\"0 0 100 100\" aria-hidden=\"true\"><path class=\"gl-line\"/></svg>";
        ui.glShapes.innerHTML = GL_SHAPES.map(function (f) {
            return "<button type=\"button\" class=\"kr-b\" data-v=\"" + f[0] + "\"><svg viewBox=\"0 0 100 100\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"7\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"" + glPath(f[0]) + "\"/></svg><span>" + f[1] + "</span></button>";
        }).join("");
        ui.glKinds.innerHTML = GL_KINDS.map(function (f) {
            return "<button type=\"button\" data-v=\"" + f[0] + "\" style=\"--k:" + f[2] + "\" title=\"" + f[1] + "\" aria-label=\"" + f[1] + "\"></button>";
        }).join("");
        ui.glEdges.innerHTML = GL_EDGES.map(function (f) {
            return "<button type=\"button\" class=\"gl-edge\" data-v=\"" + f[0] + "\"><i class=\"gl-e gl-e-" + f[0] + "\"></i><span>" + f[1] + "</span></button>";
        }).join("");
        [["glMode", "mode"], ["glForms", "form"], ["glShapes", "shape"], ["glEdges", "edge"]].forEach(function (d) {
            ui[d[0]].addEventListener("click", function (e) {
                var b = e.target.closest ? e.target.closest("button[data-v]") : null, ch = {};
                if (!b) { return; }
                ch[d[1]] = b.getAttribute("data-v");
                setGlass(ch);
            });
        });
        ui.glKinds.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest("button[data-v]") : null, k;
            if (!b) { return; }
            k = GL_KINDS.filter(function (x) { return x[0] === b.getAttribute("data-v"); })[0];
            setGlass({ kind: k[0], blur: k[3] });
        });
        ui.glText.addEventListener("input", function () { setGlass({ text: ui.glText.value }); });
        [["glBlur", "blur"], ["glLight", "light"], ["glSize", "size"]].forEach(function (d) {
            ui[d[0]].addEventListener("input", function () { var ch = {}; ch[d[1]] = Number(ui[d[0]].value); setGlass(ch); });
        });
        ui.glAdd.addEventListener("click", function () { onGlass(false); });
        ui.glMine.addEventListener("click", function () { onGlass(true); });
        drawGlass();
    }

    // ---- Мокап телефона (Анимация › Макеты): iPhone или Android из шейпов, экран — прекомп настоящего размера или выделенный слой.
    var PH_KEY = "sayframe.phone.v1";
    var PH_DEFAULTS = { model: "iphone", color: "black", pose: "flat", size: 80, round: 100, screen: "precomp", shadow: true, appear: false };
    var PH_CHOICES = { model: ["iphone", "android"], color: ["black", "silver", "gold", "blue", "pink"], pose: ["flat", "tilt", "lie"], screen: ["precomp", "layer"] };
    var PH_BODY = { black: ["#222224", "#6d6d75"], silver: ["#d6d6d1", "#f0f0ec"], gold: ["#bda88c", "#dccbb0"], blue: ["#3d4a61", "#76839a"], pink: ["#e8c7cc", "#f6e2e5"] };

    function phClean(src) {
        var o = {}, k;
        for (k in PH_DEFAULTS) { if (PH_DEFAULTS.hasOwnProperty(k)) { o[k] = src && typeof src === "object" && typeof src[k] === typeof PH_DEFAULTS[k] ? src[k] : PH_DEFAULTS[k]; } }
        for (k in PH_CHOICES) { if (PH_CHOICES.hasOwnProperty(k) && PH_CHOICES[k].indexOf(o[k]) < 0) { o[k] = PH_DEFAULTS[k]; } }
        o.size = Math.max(10, Math.min(100, Math.round(o.size) || 80));
        o.round = Math.max(0, Math.min(150, Math.round(o.round)));
        if (isNaN(o.round)) { o.round = 100; }
        return o;
    }

    var phone = (function () { try { return phClean(JSON.parse(window.localStorage.getItem(PH_KEY) || "null")); } catch (e) { return phClean(null); } })();

    function drawPhone() {
        var p = ui.phPhone, rk = phone.round / 100;
        if (!p) { return; }
        p.classList.toggle("ph-android", phone.model === "android");
        p.classList.toggle("ph-tilt", phone.pose === "tilt");
        p.classList.toggle("ph-lie", phone.pose === "lie");
        p.classList.toggle("ph-shadow", phone.shadow);
        p.style.setProperty("--body", PH_BODY[phone.color][0]);
        p.style.setProperty("--edge", PH_BODY[phone.color][1]);
        p.style.setProperty("--r", String(Math.min(0.5, (phone.model === "android" ? 0.12 : 0.19) * rk)));
        p.style.setProperty("--w", Math.round(40 + phone.size * 0.45) + "px");
        ["model", "pose", "screen"].forEach(function (key) { pressGroupV(ui["ph" + key.charAt(0).toUpperCase() + key.slice(1)], phone[key]); });
        Array.prototype.forEach.call(ui.phColors.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-v") === phone.color ? "true" : "false"); });
        ui.phSize.value = String(phone.size); ui.phSizeVal.textContent = phone.size + "%";
        ui.phRound.value = String(phone.round); ui.phRoundVal.textContent = phone.round === 100 ? "Авто" : phone.round + "%";
        ui.phShadow.checked = phone.shadow;
        ui.phAppear.checked = phone.appear;
    }

    function setPhone(changes) {
        var k;
        for (k in changes) { if (changes.hasOwnProperty(k)) { phone[k] = changes[k]; } }
        phone = phClean(phone);
        try { window.localStorage.setItem(PH_KEY, JSON.stringify(phone)); } catch (e) {}
        drawPhone();
        mkTouched("phone");
    }

    async function onPhone() {
        var res, r, name;
        if (busy) { return; }
        setBusy(true);
        setStatus("Собираю мокап…", "busy");
        try {
            res = await host("phoneMake", [{ model: phone.model, color: phone.color, pose: phone.pose, size: phone.size, round: phone.round,
                shadow: phone.shadow, appear: phone.appear, screen: phone.screen },
                { ctrl: "Телефон: управление", body: "Корпус", screen: "Экран", screenMask: "Экран", island: "Островок", camera: "Камера",
                    iphone: "iPhone", android: "Android", bg: "Фон", video: "Ваше видео" }, mkArg("phone")]);
            setBusy(false);
            r = res.phoneMake || res;
            name = r.model === "android" ? "Android" : "iPhone";
            setStatus("Мокап " + name + " готов. " + (r.screenComp ? "Экран — композиция «" + r.screenComp + "» (" + r.res.join("×") + "): откройте её и положите своё видео. " :
                "На экран встал слой «" + r.used + "». ") + (r.fallback ? "Слой не был выделен, поэтому экран — композиция. " : "") +
                "Двигайте и крутите телефон слоем «" + r.ctrl + "». Отменить — Cmd/Ctrl+Z.", "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    function enablePhone() {
        if (!ui.phPhone) { return; }
        ["model", "pose", "screen"].forEach(function (key) {
            ui["ph" + key.charAt(0).toUpperCase() + key.slice(1)].addEventListener("click", function (e) {
                var b = e.target.closest ? e.target.closest("button[data-v]") : null, ch = {};
                if (!b) { return; }
                ch[key] = b.getAttribute("data-v");
                setPhone(ch);
            });
        });
        ui.phColors.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest("button[data-v]") : null;
            if (b) { setPhone({ color: b.getAttribute("data-v") }); }
        });
        ui.phSize.addEventListener("input", function () { setPhone({ size: Number(ui.phSize.value) }); });
        ui.phRound.addEventListener("input", function () { setPhone({ round: Number(ui.phRound.value) }); });
        ui.phShadow.addEventListener("change", function () { setPhone({ shadow: ui.phShadow.checked }); });
        ui.phAppear.addEventListener("change", function () { setPhone({ appear: ui.phAppear.checked }); });
        ui.phBtn.addEventListener("click", onPhone);
        drawPhone();
    }

    // ---- Текст по ленте (Анимация › Макеты): лента с бегущим текстом по линии или 3D-кольцо из букв.
    var RB_KEY = "sayframe.ribbon.v1";
    var RB_DEFAULTS = { mode: "ribbon", form: "loops", text: "WEST LOOP", sep: "•", ribbonColor: "#3aa0e8", textColor: "#e8672c", ringColor: "#ffffff", paint: "ribbon", gAngle: 0,
        width: 120, size: 60, speed: 35, run: true, rings: 2, radius: 560, tilt: 12, ringSpeed: 40, back: true, camera: true, seed: 4127, angle: 0, dir: "fwd", overlap: false, shadow: true };
    var RB_RANGES = { gAngle: [-90, 90], width: [10, 400], size: [20, 100], speed: [0, 100], rings: [1, 5], radius: [100, 1500], tilt: [0, 60], ringSpeed: [0, 100], seed: [1, 99999], angle: [-90, 90] };
    var RB_CHOICES = { mode: ["ribbon", "ring"], form: ["path", "wave", "loops", "circle", "spiral", "random"], dir: ["fwd", "back"], paint: ["ribbon", "text"] };

    function rbClean(src) {
        var o = {}, k;
        for (k in RB_DEFAULTS) { if (RB_DEFAULTS.hasOwnProperty(k)) { o[k] = src && typeof src === "object" && typeof src[k] === typeof RB_DEFAULTS[k] ? src[k] : RB_DEFAULTS[k]; } }
        for (k in RB_RANGES) { if (RB_RANGES.hasOwnProperty(k)) { o[k] = Math.max(RB_RANGES[k][0], Math.min(RB_RANGES[k][1], Math.round(Number(o[k]) || 0))); } }
        for (k in RB_CHOICES) { if (RB_CHOICES.hasOwnProperty(k) && RB_CHOICES[k].indexOf(o[k]) < 0) { o[k] = RB_DEFAULTS[k]; } }
        ["ribbonColor", "textColor", "ringColor"].forEach(function (c) { o[c] = rbFill(o[c], c !== "ringColor") || RB_DEFAULTS[c]; });
        o.text = String(o.text).slice(0, 60);
        o.sep = String(o.sep).slice(0, 2);
        return o;
    }

    // Цвет ленты или текста: "#rrggbb" или градиент "#rrggbb>#rrggbb".
    function rbFill(v, grad) {
        var p = String(v || "").split(">"), a = parseHex(p[0]), b = p.length === 2 ? parseHex(p[1]) : null;
        if (!a || p.length > 2 || (p.length === 2 && (!b || !grad))) { return ""; }
        return b ? a.hex + ">" + b.hex : a.hex;
    }
    function rbStops(v) { var p = String(v).split(">"); return [p[0], p[1] || p[0]]; }
    // Краска для SVG превью: цвет или ссылка на градиент поперёк кадра (как Gradient Ramp в host.jsx).
    function rbGradDefs() {
        var a = rb.gAngle * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), r = Math.abs(dx) * 960 + Math.abs(dy) * 540, out = "";
        [["rbGR", rb.ribbonColor], ["rbGT", rb.textColor]].forEach(function (d) {
            var st = rbStops(d[1]);
            if (d[1].indexOf(">") < 0) { return; }
            out += "<linearGradient id=\"" + d[0] + "\" gradientUnits=\"userSpaceOnUse\" x1=\"" + (-dx * r).toFixed(1) + "\" y1=\"" + (-dy * r).toFixed(1) + "\" x2=\"" + (dx * r).toFixed(1) + "\" y2=\"" + (dy * r).toFixed(1) +
                "\"><stop offset=\"0\" stop-color=\"" + st[0] + "\"/><stop offset=\"1\" stop-color=\"" + st[1] + "\"/></linearGradient>";
        });
        return out ? "<defs>" + out + "</defs>" : "";
    }
    function rbPaintOf(which) { var v = which === "text" ? rb.textColor : rb.ribbonColor; return v.indexOf(">") < 0 ? v : "url(#" + (which === "text" ? "rbGT" : "rbGR") + ")"; }
    function rbCss(v) { return v.indexOf(">") < 0 ? v : "linear-gradient(135deg," + v.replace(">", ",") + ")"; }

    var rb = (function () { try { return rbClean(JSON.parse(window.localStorage.getItem(RB_KEY) || "null")); } catch (e) { return rbClean(null); } })();

    // Те же формы, что в host.jsx (ribSample + плавные кривые ribShape): превью совпадает с композицией.
    function rbRng(seed) {
        var s = Math.floor(Math.abs(Number(seed) || 1)) % 2147483646 + 1;
        return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }

    // «Random»: one of many figures (spiral, zigzag, straight line, heart, diamond, square, wave, triangle, arc),
    // each with its own random size and bends. The same number gives the same figure. Few points, so it is easy
    // to bend by hand; corners stay sharp.
    function rbRandom(seed, W, H) {
        var r = rbRng(Math.floor(Math.abs(Number(seed) || 1)) * 7919 % 2147483629 + 17), kinds = ["spiral", "zigzag", "line", "heart", "diamond", "square", "wave", "triangle", "arc"];
        var kind, M = Math.min(W, H), pts = [], corners = {}, i, n, t, a, rr, s, w, h, amp, turns, cnt, k, a0;
        function poly(list) { for (var j = 0; j < list.length; j++) { pts.push(list[j]); corners[j] = true; } }
        r(); r(); r();
        kind = kinds[Math.floor(r() * kinds.length) % kinds.length];
        if (kind === "spiral") {
            turns = 2 + r() * 2; n = Math.ceil(turns * 16); a0 = r() * 2 * Math.PI;
            for (i = 0; i <= n; i++) { t = a0 + i / n * turns * 2 * Math.PI; rr = M * 0.44 * (0.1 + 0.9 * i / n); pts.push([rr * Math.cos(t), rr * Math.sin(t)]); }
            return { pts: pts, closed: false, step: 4, kind: kind };
        }
        if (kind === "zigzag") {
            cnt = 4 + Math.floor(r() * 5); amp = H * (0.12 + r() * 0.16);
            for (i = 0; i <= cnt; i++) { pts.push([(i / cnt - 0.5) * W * 1.1, (i % 2 ? -1 : 1) * amp]); corners[i] = true; }
            return { pts: pts, closed: false, step: 1, corners: corners, kind: kind };
        }
        if (kind === "line") {
            s = (r() - 0.5) * 0.6;
            for (i = 0; i <= 2; i++) { t = (i / 2 - 0.5) * W * 1.1; pts.push([t, t * s * H / W]); }
            return { pts: pts, closed: false, step: 1, kind: kind };
        }
        if (kind === "heart") {
            n = 48; s = M * (0.36 + r() * 0.1) / 17;
            for (i = 0; i < n; i++) { t = i / n * 2 * Math.PI; pts.push([16 * Math.pow(Math.sin(t), 3) * s, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t) + 2.5) * s]); }
            corners[0] = true; corners[24] = true;
            return { pts: pts, closed: true, step: 4, corners: corners, kind: kind };
        }
        if (kind === "diamond") {
            w = M * (0.24 + r() * 0.1); h = Math.min(w * (1.25 + r() * 0.35), M * 0.44);
            poly([[0, -h], [w, 0], [0, h], [-w, 0]]);
            return { pts: pts, closed: true, step: 1, corners: corners, kind: kind };
        }
        if (kind === "square") {
            w = M * (0.28 + r() * 0.12); a = (r() - 0.5) * 0.4;
            for (i = 0; i < 4; i++) { t = a + Math.PI / 4 + i * Math.PI / 2; pts.push([w * Math.SQRT2 * Math.cos(t), w * Math.SQRT2 * Math.sin(t)]); corners[i] = true; }
            return { pts: pts, closed: true, step: 1, corners: corners, kind: kind };
        }
        if (kind === "triangle") {
            w = M * (0.36 + r() * 0.1); a = (r() - 0.5) * 0.5;
            for (i = 0; i < 3; i++) { t = a - Math.PI / 2 + i * 2 * Math.PI / 3; pts.push([w * Math.cos(t), w * Math.sin(t) + w * 0.18]); corners[i] = true; }
            return { pts: pts, closed: true, step: 1, corners: corners, kind: kind };
        }
        if (kind === "arc") {
            a = (0.6 + r() * 0.45) * Math.PI; rr = W * 0.5 / Math.max(0.5, Math.sin(a / 2)); k = r() < 0.5 ? 1 : -1; n = 24;
            for (i = 0; i <= n; i++) { t = -a / 2 + i / n * a; pts.push([rr * Math.sin(t), -k * rr * Math.cos(t)]); }
            // Centred, and small enough to stay inside the frame.
            w = 0; h = 1e9; for (i = 0; i <= n; i++) { w = Math.max(w, pts[i][1]); h = Math.min(h, pts[i][1]); }
            s = Math.min(1, H * 0.7 / Math.max(1, w - h), W * 1.0 / Math.max(1, 2 * rr * (a > Math.PI ? 1 : Math.sin(a / 2))));
            for (i = 0; i <= n; i++) { pts[i] = [pts[i][0] * s, (pts[i][1] - (w + h) / 2) * s]; }
            return { pts: pts, closed: false, step: 6, kind: kind };
        }
        // wave: one to three waves
        cnt = 1 + Math.floor(r() * 3); amp = H * (0.1 + r() * 0.16); n = cnt * 16; a0 = r() < 0.5 ? 1 : -1;
        for (i = 0; i <= n; i++) { t = i / n; pts.push([(t - 0.5) * W * 1.1, -a0 * Math.sin(t * cnt * 2 * Math.PI) * amp]); }
        return { pts: pts, closed: false, step: 4, kind: "wave" };
    }

    // A line with few points, easy to bend by hand: every step-th point of the dense line is kept, its handles
    // point along the dense line and are a third of the way to the next kept point. At a corner the two handles
    // point at their own neighbours, so it stays sharp.
    function rbBez(sm) {
        var p = sm.pts, n = p.length, st = sm.step || 1, cr = sm.corners || {}, keep = [], i, k, a, b, dx, dy, d, ex, ey, lenTo, ins = [], outs = [], v = [];
        for (i = 0; i < n; i += st) { keep.push(i); }
        if (!sm.closed && keep[keep.length - 1] !== n - 1) { if (n - 1 - keep[keep.length - 1] < st / 2 && keep.length > 1) { keep.pop(); } keep.push(n - 1); }
        function at(j) { return p[((j % n) + n) % n]; }
        function arc(i0, i1) {
            var L = 0, j, q, r;
            for (j = i0; j < i1; j++) { q = at(j); r = at(j + 1); L += Math.sqrt((r[0] - q[0]) * (r[0] - q[0]) + (r[1] - q[1]) * (r[1] - q[1])); }
            return L;
        }
        function unit(x, y) { var l = Math.sqrt(x * x + y * y) || 1; return [x / l, y / l]; }
        for (k = 0; k < keep.length; k++) {
            i = keep[k];
            a = sm.closed ? at(i - 1) : p[Math.max(0, i - 1)];
            b = sm.closed ? at(i + 1) : p[Math.min(n - 1, i + 1)];
            if (cr[i]) { d = unit(p[i][0] - a[0], p[i][1] - a[1]); dx = d[0]; dy = d[1]; d = unit(b[0] - p[i][0], b[1] - p[i][1]); ex = d[0]; ey = d[1]; }
            else { d = unit(b[0] - a[0], b[1] - a[1]); dx = ex = d[0]; dy = ey = d[1]; }
            lenTo = (k > 0 || sm.closed) ? arc(k > 0 ? keep[k - 1] : keep[keep.length - 1] - n, i) / 3 : 0;
            ins.push([-dx * lenTo, -dy * lenTo]);
            lenTo = (k < keep.length - 1 || sm.closed) ? arc(i, k < keep.length - 1 ? keep[k + 1] : keep[0] + n) / 3 : 0;
            outs.push([ex * lenTo, ey * lenTo]);
            v.push([p[i][0], p[i][1]]);
        }
        return { vertices: v, inTangents: ins, outTangents: outs, closed: !!sm.closed };
    }

    // Направление линии: форма строится для повёрнутого кадра и поворачивается (как ribSample в host.jsx).
    function rbSample(form, W, H, o) {
        var a = (o && Number(o.angle)) || 0, sm, c, sn, rw, rh;
        if (form === "circle" || form === "path" || !a) { return rbSample0(form, W, H, o); }
        c = Math.cos(a * Math.PI / 180); sn = Math.sin(a * Math.PI / 180);
        rw = Math.min(Math.abs(c) * W + Math.abs(sn) * H, Math.sqrt(W * W + H * H));
        rh = H + Math.abs(sn) * (W - H);
        sm = rbSample0(form, rw, rh, o);
        sm.pts = sm.pts.map(function (p) { return [p[0] * c - p[1] * sn, p[0] * sn + p[1] * c]; });
        return sm;
    }

    function rbSample0(form, W, H, o) {
        var pts = [], i, n, t, u, m = Math.min(W, H), r, xs = [], ys = [], s, x0, x1, y0, y1;
        if (form === "random") { return rbRandom(o && o.seed, W, H); }
        if (form === "circle") { r = m * 0.3; for (i = 0; i < 24; i++) { t = i / 24 * 2 * Math.PI; pts.push([r * Math.sin(t), -r * Math.cos(t)]); } return { pts: pts, closed: true }; }
        if (form === "spiral") { n = 44; for (i = 0; i <= n; i++) { t = i / n * 5 * Math.PI; r = m * 0.4 * (0.12 + 0.88 * i / n); pts.push([r * Math.cos(t), r * Math.sin(t)]); } return { pts: pts, closed: false }; }
        if (form === "loops" || form === "path") {
            n = 54;
            for (i = 0; i <= n; i++) { t = -0.5 * Math.PI + i / n * 7 * Math.PI; xs.push(t - 3.2 * Math.sin(t)); ys.push(3.2 * Math.cos(t)); }
            x0 = Math.min.apply(null, xs); x1 = Math.max.apply(null, xs); y0 = Math.min.apply(null, ys); y1 = Math.max.apply(null, ys);
            s = Math.min(W * 0.9 / (x1 - x0), H * 0.62 / (y1 - y0));
            for (i = 0; i <= n; i++) { pts.push([(xs[i] - (x0 + x1) / 2) * s, (ys[i] - (y0 + y1) / 2) * s]); }
            return { pts: pts, closed: false };
        }
        n = 32;
        for (i = 0; i <= n; i++) { u = i / n; pts.push([(u - 0.5) * W * 1.1, -Math.sin(u * 4 * Math.PI) * H * 0.18]); }
        return { pts: pts, closed: false };
    }

    function rbSvgPath(sm) {
        if (sm.step >= 1) {
            var bz = rbBez(sm), v = bz.vertices, m = v.length, out = "M" + v[0][0].toFixed(1) + " " + v[0][1].toFixed(1), q, e;
            for (q = 0; q < (bz.closed ? m : m - 1); q++) {
                e = (q + 1) % m;
                out += " C" + (v[q][0] + bz.outTangents[q][0]).toFixed(1) + " " + (v[q][1] + bz.outTangents[q][1]).toFixed(1) + " " + (v[e][0] + bz.inTangents[e][0]).toFixed(1) + " " + (v[e][1] + bz.inTangents[e][1]).toFixed(1) + " " + v[e][0].toFixed(1) + " " + v[e][1].toFixed(1);
            }
            return out + (bz.closed ? " Z" : "");
        }
        var p = sm.pts, n = p.length, d = "M" + p[0][0].toFixed(1) + " " + p[0][1].toFixed(1), i, segs = sm.closed ? n : n - 1;
        function tan(i) {
            var a = sm.closed ? p[(i - 1 + n) % n] : p[Math.max(0, i - 1)], b = sm.closed ? p[(i + 1) % n] : p[Math.min(n - 1, i + 1)];
            return [(b[0] - a[0]) / 6, (b[1] - a[1]) / 6];
        }
        for (i = 0; i < segs; i++) {
            var a = p[i], b = p[(i + 1) % n], ta = tan(i), tb = tan((i + 1) % n);
            d += " C" + (a[0] + ta[0]).toFixed(1) + " " + (a[1] + ta[1]).toFixed(1) + " " + (b[0] - tb[0]).toFixed(1) + " " + (b[1] - tb[1]).toFixed(1) + " " + b[0].toFixed(1) + " " + b[1].toFixed(1);
        }
        return d + (sm.closed ? " Z" : "");
    }

    function rbEsc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    function rbUnit() { return rb.text + " " + (rb.sep ? rb.sep + " " : ""); }

    // «Перекрытия 3D» в превью: лента режется по словам, каждый кусок рисуется поверх предыдущих вместе со своими буквами.
    function rbOverlapPreview(svg, txt, fs) {
        var NS = "http://www.w3.org/2000/svg", P = svg.querySelector("path"), W = rb.width, L, tmp, n, adv = [], x = 0, j, w, cuts = [0], groups = [], g, defs, sh;
        try { L = P.getTotalLength(); } catch (e) { return; }
        if (!(L > 0)) { return; }
        txt = txt.replace(/\s+$/, "");
        tmp = document.createElementNS(NS, "text");
        tmp.setAttribute("style", "font-size:" + fs + "px");
        tmp.textContent = txt;
        svg.appendChild(tmp);
        try { n = Math.min(txt.length, tmp.getNumberOfChars()); for (j = 0; j < n; j++) { w = tmp.getSubStringLength(j, 1); adv.push([x, w]); x += w; } } catch (e2) { n = 0; }
        svg.removeChild(tmp);
        if (!n) { return; }
        for (j = 1; j < n; j++) { if (txt.charAt(j - 1) === " ") { cuts.push(j); } }
        for (j = 0; j < cuts.length; j++) {
            var s0 = cuts[j], e0 = j + 1 < cuts.length ? cuts[j + 1] : n, a = s0 ? adv[s0][0] - adv[s0 - 1][1] / 2 : 0, b = e0 < n ? adv[e0][0] - adv[e0 - 1][1] / 2 : x;
            if (a >= L) { break; }
            groups.push([s0, e0, a, Math.min(b, L)]);
        }
        if (groups.length) { groups[groups.length - 1][3] = L; }
        ["stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"].forEach(function (a) { P.removeAttribute(a); });
        svg.querySelector("text").remove();
        defs = document.createElementNS(NS, "defs");
        defs.innerHTML = "<filter id=\"rbSh\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"" + Math.round(W * 0.18) + "\"/></filter>";
        svg.appendChild(defs);
        g = document.createElementNS(NS, "g");
        g.setAttribute("class", "rb-pieces");
        svg.appendChild(g);
        groups.forEach(function (G, k) {
            var len = G[3] - G[2], sp = "", q, el;
            if (rb.shadow && k > 0) {
                // Тень только на ленте под куском: маска — вся лента минус сам кусок с запасом.
                sh = document.createElementNS(NS, "mask");
                sh.setAttribute("id", "rbM" + k); sh.setAttribute("maskUnits", "userSpaceOnUse");
                sh.setAttribute("x", "-1200"); sh.setAttribute("y", "-700"); sh.setAttribute("width", "2400"); sh.setAttribute("height", "1400");
                sh.innerHTML = "<use href=\"#rbPrevPath\" fill=\"none\" stroke=\"#fff\" stroke-width=\"" + W + "\"/><use href=\"#rbPrevPath\" fill=\"none\" stroke=\"#000\" stroke-width=\"" + (W + 8) + "\" stroke-dasharray=\"0 " + Math.max(0, G[2] - W * 1.6) + " " + (len + W * 3.2) + " " + L * 3 + "\"/>";
                defs.appendChild(sh);
                el = document.createElementNS(NS, "g");
                el.setAttribute("mask", "url(#rbM" + k + ")");
                el.innerHTML = "<use href=\"#rbPrevPath\" fill=\"none\" stroke=\"#000\" stroke-opacity=\".55\" stroke-width=\"" + (W + 10) + "\" stroke-dasharray=\"0 " + G[2] + " " + len + " " + L * 3 + "\" filter=\"url(#rbSh)\"/>";
                g.appendChild(el);
            }
            for (q = 0; q < n; q++) { sp += q >= G[0] && q < G[1] ? rbEsc(txt.charAt(q)) : "<tspan fill-opacity=\"0\">" + rbEsc(txt.charAt(q)) + "</tspan>"; }
            el = document.createElementNS(NS, "g");
            el.setAttribute("class", "rb-piece");
            el.innerHTML = "<use href=\"#rbPrevPath\" fill=\"none\" stroke=\"" + rbPaintOf("ribbon") + "\" stroke-width=\"" + W + "\" stroke-linecap=\"" + (k === 0 || k === groups.length - 1 ? "round" : "butt") + "\" stroke-dasharray=\"0 " + G[2] + " " + (len + 0.8) + " " + L * 3 + "\"/>" +
                "<text fill=\"" + rbPaintOf("text") + "\" style=\"font-size:" + fs + "px\"><textPath href=\"#rbPrevPath\">" + sp + "</textPath></text>";
            g.appendChild(el);
        });
    }

    function drawRibbonPreview() {
        var st = ui.rbStage, unit = rbUnit(), txt = "", i, fs, html = "", n, R, rows, j, k, a, back;
        if (!st) { return; }
        st.classList.toggle("rb-ring", rb.mode === "ring");
        if (rb.mode === "ribbon") {
            for (i = 0; i < 60; i++) { txt += unit; }
            fs = Math.max(6, Math.round(rb.width * rb.size / 100));
            st.innerHTML = "<svg viewBox=\"-1100 -560 2200 1120\" preserveAspectRatio=\"xMidYMid meet\">" + rbGradDefs() + "<path id=\"rbPrevPath\" class=\"rb-hit-r\" d=\"" + rbSvgPath(rbSample(rb.form, 1920, 1080, { seed: rb.seed, angle: rb.angle })) + "\" fill=\"none\" stroke=\"" + rbPaintOf("ribbon") +
                "\" stroke-width=\"" + rb.width + "\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><text class=\"rb-hit-t\" fill=\"" + rbPaintOf("text") + "\" style=\"font-size:" + fs + "px\"><textPath href=\"#rbPrevPath\">" + rbEsc(txt) + "</textPath></text></svg>";
            if (rb.overlap) { rbOverlapPreview(st.querySelector("svg"), txt, fs); }
            return;
        }
        // Кольцо: буквы по кругу в CSS 3D, задняя сторона — зеркально и бледнее.
        R = Math.round(60 + rb.radius / 1500 * 70);
        n = Math.max(12, Math.round(2 * Math.PI * R / 15));
        rows = rb.rings;
        html = "<div class=\"rb-ringbox\" style=\"--c:" + rb.ringColor + ";transform:rotateX(" + (-rb.tilt) + "deg)\">";
        for (j = 0; j < rows; j++) {
            html += "<div class=\"rb-ringrow\" style=\"transform:translateY(" + ((j - (rows - 1) / 2) * 26 - 11) + "px)\">";
            txt = ""; while (txt.length < n) { txt += unit; }
            txt = txt.slice(0, n);
            for (k = 0; k < n; k++) {
                a = k * 360 / n - 50;
                back = Math.cos(a * Math.PI / 180) < 0;
                html += "<span style=\"transform:rotateY(" + a.toFixed(1) + "deg) translateZ(" + R + "px)" + (back && rb.back ? ";opacity:.32" : "") + "\">" + rbEsc(txt.charAt(k)) + "</span>";
            }
            html += "</div>";
        }
        st.innerHTML = html + "</div>";
    }

    function drawRibbon() {
        var ring = rb.mode === "ring";
        if (!ui.rbStage) { return; }
        pressGroupV(ui.rbMode, rb.mode);
        Array.prototype.forEach.call(ui.rbForm.querySelectorAll("button[data-v]"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-v") === rb.form ? "true" : "false"); });
        ui.rbRibbonOpts.hidden = ui.rbRibbonSl.hidden = ui.rbRibbonSw.hidden = ui.rbRibColorRow.hidden = ui.rbPairs.hidden = ui.rbPaint.hidden = ring;
        ui.rbRingColorRow.hidden = !ring;
        ui.rbRingSl.hidden = ui.rbRingSw.hidden = !ring;
        if (document.activeElement !== ui.rbText) { ui.rbText.value = rb.text; }
        if (document.activeElement !== ui.rbSep) { ui.rbSep.value = rb.sep; }
        var cur = rb.paint === "text" ? rb.textColor : rb.ribbonColor, st = rbStops(cur);
        pressGroupV(ui.rbPaint, rb.paint);
        Array.prototype.forEach.call(ui.rbRibColors.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-v") === cur ? "true" : "false"); });
        Array.prototype.forEach.call(ui.rbTextColors.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-v") === rb.ringColor ? "true" : "false"); });
        Array.prototype.forEach.call(ui.rbPairs.querySelectorAll("button"), function (b) {
            b.setAttribute("aria-pressed", b.getAttribute("data-r") === rb.ribbonColor && b.getAttribute("data-t") === rb.textColor ? "true" : "false");
            b.querySelector("span").textContent = String(rb.text || "TEXT").split(" ")[0].slice(0, 9).toUpperCase() + (rb.sep ? " " + rb.sep : "");
        });
        ui.rbGradRow.hidden = ring || cur.indexOf(">") < 0;
        ui.rbCustom.value = st[0]; ui.rbGradA.value = st[0]; ui.rbGradB.value = st[1];
        ui.rbGradBar.style.background = "linear-gradient(90deg," + st[0] + "," + st[1] + ")";
        Array.prototype.forEach.call(ui.rbGradDir.querySelectorAll("button[data-v]"), function (b) { b.setAttribute("aria-pressed", Number(b.getAttribute("data-v")) === rb.gAngle ? "true" : "false"); });
        [["Width", "width", ""], ["Size", "size", "%"], ["Speed", "speed", ""], ["Rings", "rings", ""], ["Radius", "radius", ""], ["Tilt", "tilt", "°"], ["RingSpeed", "ringSpeed", ""]].forEach(function (d) {
            ui["rb" + d[0]].value = String(rb[d[1]]);
            ui["rb" + d[0] + "Val"].textContent = rb[d[1]] + d[2];
        });
        ui.rbRun.checked = rb.run; ui.rbOverlap.checked = rb.overlap; ui.rbShadow.checked = rb.shadow; ui.rbShadowRow.hidden = !rb.overlap; ui.rbBack.checked = rb.back; ui.rbCamera.checked = rb.camera;
        ui.rbSeedRow.hidden = ring || rb.form !== "random";
        ui.rbDirRow.hidden = ring || rb.form === "path" || rb.form === "circle";
        ui.rbRunDir.hidden = ring || !rb.run;
        if (document.activeElement !== ui.rbSeed) { ui.rbSeed.value = String(rb.seed); }
        ui.rbAngle.value = String(rb.angle);
        ui.rbAngleVal.textContent = rb.angle + "°";
        Array.prototype.forEach.call(ui.rbDir.querySelectorAll("button[data-v]"), function (b) { b.setAttribute("aria-pressed", Number(b.getAttribute("data-v")) === rb.angle ? "true" : "false"); });
        pressGroupV(ui.rbRunDir, rb.dir);
        ui.rbBtn.textContent = ring ? "Создать кольцо" : "Создать ленту";
        drawRibbonPreview();
    }

    function setRibbon(changes) {
        var k;
        for (k in changes) { if (changes.hasOwnProperty(k)) { rb[k] = changes[k]; } }
        rb = rbClean(rb);
        try { window.localStorage.setItem(RB_KEY, JSON.stringify(rb)); } catch (e) {}
        drawRibbon();
        mkTouched("ribbon");
    }

    async function onRibbon() {
        var res, r, ring = rb.mode === "ring";
        if (busy) { return; }
        setBusy(true);
        setStatus(ring ? "Собираю кольцо…" : "Собираю ленту…", "busy");
        try {
            res = await host("ribbonMake", [{ mode: rb.mode, form: rb.form, text: rb.text || "TEXT", sep: rb.sep, width: rb.width, textSize: rb.size, speed: ring ? rb.ringSpeed : rb.speed, run: rb.run, seed: rb.seed, angle: rb.angle, dir: rb.dir, overlap: rb.overlap, shadow: rb.shadow,
                ribbonColor: tbRgb(rbStops(rb.ribbonColor)[0]), textColor: tbRgb(ring ? rb.ringColor : rbStops(rb.textColor)[0]),
                ribbonGrad: !ring && rb.ribbonColor.indexOf(">") > 0 ? { a: tbRgb(rbStops(rb.ribbonColor)[0]), b: tbRgb(rbStops(rb.ribbonColor)[1]), angle: rb.gAngle } : null,
                textGrad: !ring && rb.textColor.indexOf(">") > 0 ? { a: tbRgb(rbStops(rb.textColor)[0]), b: tbRgb(rbStops(rb.textColor)[1]), angle: rb.gAngle } : null, rings: rb.rings, radius: rb.radius, tilt: rb.tilt,
                backDark: rb.back, camera: rb.camera },
                { ribbon: "Лента", path: "Линия", text: "Текст ленты", width: "Толщина ленты", speed: "Скорость", color: "Цвет ленты",
                    piece: "кусок", shadow: "тень", grad: "Градиент", gradMatte: "Градиент: форма", ring: "Кольцо", tilt: "Кольцо: наклон", spin: "Кольцо: вращение", camera: "Камера кольца" }, mkArg("ribbon")]);
            setBusy(false);
            r = res.ribbonMake || res;
            if (r.mode === "ring") {
                setStatus("Кольцо готово: " + plural(r.rings, "кольцо", "кольца", "колец") + ". Наклон — слоем «" + r.ctrl + "», скорость вращения — в Effect Controls слоя «" + r.spin + "»." +
                    (r.camera ? " Добавлена камера «" + r.camera + "»." : "") + " Отменить — Cmd/Ctrl+Z.", "done");
            } else {
                setStatus("Лента готова" + (r.from ? " по линии «" + r.from + "» (сама линия выключена)" : "") + (rb.overlap ? (r.pieces > 1 ? ", " + plural(r.pieces, "кусок", "куска", "кусков") + " для перекрытий" : ", перекрёстков нет — перекрытия не понадобились") : "") + ". Текст — слой «" + r.text + "»: поменяйте слова прямо в нём. Толщина, цвет ленты и скорость — в Effect Controls текста. Отменить — Cmd/Ctrl+Z.", "done");
            }
        } catch (e) {
            toolFailed(e);
        }
    }

    // ---- «Макеты»: менять уже созданное. Выделили в After Effects то, что сделал блок, — блок показывает
    // его настройки и меняет его (пересобирает на месте; то, что вы сдвинули или анимировали, остаётся).
    var mkEdit = null, mkSkip = "", mkTimer = null, mkLoading = false, mkApplying = false, mkGlassMine = false;
    var MK_UI_KEYS = { paint: 1, fold: 1, sort: 1 };
    var MK = {
        glass: { btns: ["glAdd", "glMine"], go: "glAdd", fresh: "+ Новое стекло", done: "Стекло",
            state: function () { var s = mkCopy(glass); s._mine = !!mkGlassMine; return s; },
            load: function (s) { mkGlassMine = !!s._mine; delete s._mine; setGlass(s); },
            apply: function () { return onGlass(mkGlassMine); } },
        carousel: { btns: ["orbitBtn"], go: "orbitBtn", fresh: "+ Новая карусель", done: "Карусель",
            state: function () { var s = mkCopy(orbit); delete s.grid; return s; },
            load: function (s) { var k; for (k in s) { if (s.hasOwnProperty(k) && ORBIT_DEFAULTS.hasOwnProperty(k) && !MK_UI_KEYS[k]) { orbit[k] = s[k]; } } storeOrbit(); drawOrbit(); },
            apply: function () { return onOrbit(); } },
        grid: { btns: ["gridBtn"], go: "gridBtn", fresh: "+ Новая сетка", done: "Сетка",
            state: function () { return mkCopy(orbit.grid); },
            load: function (s) { var k; for (k in s) { if (s.hasOwnProperty(k) && GRID_DEFAULTS.hasOwnProperty(k)) { orbit.grid[k] = s[k]; } } storeOrbit(); drawGrid(); },
            apply: function () { return onGrid(); } },
        textbox: { btns: ["tbBtn"], go: "tbBtn", fresh: "+ Новая плашка", done: "Плашка",
            state: function () { return mkCopy(tb); }, load: function (s) { setTb(s); }, apply: function () { return onTextBox(); } },
        phone: { btns: ["phBtn"], go: "phBtn", fresh: "+ Новый мокап", done: "Мокап",
            state: function () { return mkCopy(phone); }, load: function (s) { setPhone(s); }, apply: function () { return onPhone(); } },
        ribbon: { btns: ["rbBtn"], go: "rbBtn", fresh: "+ Новая лента", done: "Лента",
            state: function () { return mkCopy(rb); }, load: function (s) { setRibbon(s); }, apply: function () { return onRibbon(); } }
    };

    function mkCopy(o) { var s = {}, k; for (k in o) { if (o.hasOwnProperty(k) && !MK_UI_KEYS[k]) { s[k] = o[k]; } } return JSON.parse(JSON.stringify(s)); }
    function mkStateStr(kind) { return JSON.stringify(MK[kind].state()); }

    // Последний аргумент для host(…Make): что за блок и, если меняем, какую сборку.
    function mkArg(kind) { return { gid: mkEdit && mkEdit.kind === kind ? mkEdit.gid : "", state: mkStateStr(kind) }; }

    function mkCard(kind) { return document.querySelector('#orbitPane .mk-card[data-mk="' + kind + '"]'); }

    function mkPaint() {
        Object.keys(MK).forEach(function (kind) {
            var card = mkCard(kind), bar, on = !!(mkEdit && mkEdit.kind === kind), K = MK[kind];
            if (!card) { return; }
            bar = card.querySelector(".mk-edit");
            if (!bar) {
                bar = document.createElement("div");
                bar.className = "mk-edit";
                bar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
                    '<span class="mk-edit-name"></span><button type="button" class="mk-edit-new"></button>';
                card.querySelector(".mk-body").insertBefore(bar, card.querySelector(".mk-body").firstChild);
                bar.querySelector(".mk-edit-new").addEventListener("click", mkNew);
            }
            bar.hidden = !on;
            card.classList.toggle("mk-editing", on);
            bar.querySelector(".mk-edit-new").textContent = kind === "ribbon" && rb.mode === "ring" ? "+ Новое кольцо" : K.fresh;
            if (on) { bar.querySelector(".mk-edit-name").textContent = "Изменяется: «" + mkEdit.name + "»"; }
            K.btns.forEach(function (id) {
                var b = document.getElementById(id);
                if (!b) { return; }
                if (on) {
                    if (b.getAttribute("data-mk-text") === null) { b.setAttribute("data-mk-text", b.textContent); }
                    if (id === K.go) { b.textContent = "Готово"; b.hidden = false; } else { b.hidden = true; }
                } else if (b.getAttribute("data-mk-text") !== null) {
                    b.textContent = b.getAttribute("data-mk-text");
                    b.removeAttribute("data-mk-text");
                    b.hidden = false;
                }
            });
        });
        // Блоки сами переписывают текст кнопки при отрисовке (лента/кольцо): обновляем запомненный.
    }

    // Вызывают сеттеры блоков: настройки поменялись. В режиме изменения — пересобрать чуть погодя.
    function mkTouched(kind) {
        if (!MK[kind]) { return; }
        if (mkEdit && mkEdit.kind === kind) {
            var b = document.getElementById(MK[kind].go);
            if (b && b.textContent !== "Готово") { b.setAttribute("data-mk-text", b.textContent); b.textContent = "Готово"; }
        }
        if (mkLoading || !mkEdit || mkEdit.kind !== kind) { return; }
        if (mkStateStr(kind) === mkEdit.last) { return; }
        clearTimeout(mkTimer);
        mkTimer = setTimeout(mkApply, 450);
    }

    async function mkApply() {
        var e = mkEdit, st;
        mkTimer = null;
        if (!e) { return; }
        if (busy || mkApplying) { mkTimer = setTimeout(mkApply, 300); return; }
        st = mkStateStr(e.kind);
        if (st === e.last) { return; }
        e.last = st;
        mkApplying = true;
        try { await MK[e.kind].apply(); } finally { mkApplying = false; }
        if (/\bdone\b/.test(ui.statusBox.className) && mkEdit === e) {
            setStatus("«" + e.name + "» изменена. Отменить — Cmd/Ctrl+Z.", "done");
        } else if (/Этого уже нет в композиции/.test(ui.status.textContent)) {
            mkEdit = null; mkPaint();
        }
    }

    function mkLoad(r) {
        var s = null;
        try { s = r.state ? JSON.parse(r.state) : null; } catch (e) { s = null; }
        mkLoading = true;
        try { if (s && typeof s === "object") { MK[r.kind].load(s); } } catch (e2) {} finally { mkLoading = false; }
        mkEdit = { kind: r.kind, gid: r.gid, name: r.name, last: mkStateStr(r.kind) };
        mkPaint();
        var card = mkCard(r.kind);
        if (card && card.classList.contains("mk-folded")) { var f = card.querySelector(".mk-fold"); if (f) { f.click(); } }
    }

    function mkNew() {
        if (!mkEdit) { return; }
        mkSkip = mkEdit.gid;
        clearTimeout(mkTimer); mkTimer = null;
        mkEdit = null;
        mkPaint();
    }

    async function mkDone() {
        var e = mkEdit;
        if (mkTimer) { clearTimeout(mkTimer); mkTimer = null; await mkApply(); }
        while (mkApplying) { await new Promise(function (r) { setTimeout(r, 100); }); }
        try { await host("mkDeselect", []); } catch (err) {}
        mkEdit = null;
        mkPaint();
        if (e) { setStatus("Готово: «" + e.name + "». Чтобы снова поменять — выделите её в After Effects.", "done"); }
    }

    // Раз в секунду, пока открыты «Макеты»: не выделено ли то, что сделал блок.
    async function mkPoll() {
        var r;
        if (window.__SAYFRAME_TEST_NO_MK_POLL__ || IS_PR || busy || mkApplying || mkTimer || document.hidden || !ui.orbitPane || ui.orbitPane.offsetParent === null) { return; }
        try { r = await host("mkSelected", []); } catch (e) { return; }
        if (busy || mkApplying || mkTimer) { return; }
        if (r.kind && MK[r.kind] && r.gid !== mkSkip) {
            mkSkip = "";
            if (!mkEdit || mkEdit.gid !== r.gid) { mkLoad(r); }
            else if (mkEdit.name !== r.name) { mkEdit.name = r.name; mkPaint(); }
            return;
        }
        if (!r.kind) { mkSkip = ""; }
        if (mkEdit) { mkEdit = null; mkPaint(); }
    }

    function enableMk() {
        if (!ui.orbitPane || IS_PR) { return; }
        Object.keys(MK).forEach(function (kind) {
            var card = mkCard(kind);
            if (!card) { return; }
            // В режиме изменения главная кнопка — «Готово»: снимает выделение, блок снова создаёт новое.
            card.addEventListener("click", function (ev) {
                var b = ev.target.closest ? ev.target.closest("button") : null;
                if (!b || !mkEdit || mkEdit.kind !== kind || MK[kind].btns.indexOf(b.id) < 0) { return; }
                ev.stopImmediatePropagation(); ev.preventDefault();
                mkDone();
            }, true);
        });
        mkPaint();
        setInterval(mkPoll, 1000);
    }

    function enableRibbon() {
        if (!ui.rbStage) { return; }
        ui.rbMode.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest("button[data-v]") : null; if (b) { setRibbon({ mode: b.getAttribute("data-v") }); } });
        ui.rbForm.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest("button[data-v]") : null; if (b) { setRibbon({ form: b.getAttribute("data-v") }); } });
        // Красим то, что выбрано на превью: ленту или текст.
        function paintSet(v) { var ch = {}; ch[rb.paint === "text" ? "textColor" : "ribbonColor"] = v; setRibbon(ch); }
        function paintCur() { return rb.paint === "text" ? rb.textColor : rb.ribbonColor; }
        ui.rbRibColors.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest("button[data-v]") : null; if (b) { paintSet(b.getAttribute("data-v")); } });
        ui.rbTextColors.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest("button[data-v]") : null; if (b) { setRibbon({ ringColor: b.getAttribute("data-v") }); } });
        ui.rbPaint.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest("button[data-v]") : null; if (b) { setRibbon({ paint: b.getAttribute("data-v") }); } });
        ui.rbStage.addEventListener("click", function (e) {
            if (rb.mode !== "ribbon" || !e.target.closest) { return; }
            if (e.target.closest("text")) { setRibbon({ paint: "text" }); }
            else if (e.target.closest("path, use")) { setRibbon({ paint: "ribbon" }); }
        });
        ui.rbPairs.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest("button[data-r]") : null; if (b) { setRibbon({ ribbonColor: b.getAttribute("data-r"), textColor: b.getAttribute("data-t") }); } });
        ui.rbCustom.addEventListener("input", function () { paintSet(ui.rbCustom.value); });
        ui.rbGradA.addEventListener("input", function () { paintSet(ui.rbGradA.value + ">" + rbStops(paintCur())[1]); });
        ui.rbGradB.addEventListener("input", function () { paintSet(rbStops(paintCur())[0] + ">" + ui.rbGradB.value); });
        ui.rbGradDir.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest("button[data-v]") : null; if (b) { setRibbon({ gAngle: Number(b.getAttribute("data-v")) }); } });
        ui.rbText.addEventListener("input", function () { setRibbon({ text: ui.rbText.value }); });
        ui.rbSep.addEventListener("input", function () { setRibbon({ sep: ui.rbSep.value }); });
        [["Width", "width"], ["Size", "size"], ["Speed", "speed"], ["Rings", "rings"], ["Radius", "radius"], ["Tilt", "tilt"], ["RingSpeed", "ringSpeed"]].forEach(function (d) {
            ui["rb" + d[0]].addEventListener("input", function () { var ch = {}; ch[d[1]] = Number(ui["rb" + d[0]].value); setRibbon(ch); });
        });
        ui.rbRun.addEventListener("change", function () { setRibbon({ run: ui.rbRun.checked }); });
        ui.rbBack.addEventListener("change", function () { setRibbon({ back: ui.rbBack.checked }); });
        ui.rbOverlap.addEventListener("change", function () { setRibbon({ overlap: ui.rbOverlap.checked }); });
        ui.rbShadow.addEventListener("change", function () { setRibbon({ shadow: ui.rbShadow.checked }); });
        ui.rbCamera.addEventListener("change", function () { setRibbon({ camera: ui.rbCamera.checked }); });
        ui.rbDice.addEventListener("click", function () {
            var v = rb.seed;
            while (v === rb.seed) { v = 1 + Math.floor(Math.random() * 99999); }
            setRibbon({ form: "random", seed: v });
        });
        ui.rbSeed.addEventListener("change", function () { setRibbon({ seed: Number(ui.rbSeed.value) || 1 }); });
        ui.rbDir.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest("button[data-v]") : null; if (b) { setRibbon({ angle: Number(b.getAttribute("data-v")) }); } });
        ui.rbAngle.addEventListener("input", function () { setRibbon({ angle: Number(ui.rbAngle.value) }); });
        ui.rbRunDir.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest("button[data-v]") : null; if (b) { setRibbon({ dir: b.getAttribute("data-v") }); } });
        ui.rbBtn.addEventListener("click", onRibbon);
        drawRibbon();
    }

    // ---- Pathfinder (вкладка «Шейп»): как Shape Modes в Illustrator, через Merge Paths.
    var PF_MODES = { unite: ["Объединить", "Все фигуры сливаются в одну"], front: ["Вычесть верхнюю", "Верхние фигуры вырезаются из нижней"],
        intersect: ["Пересечение", "Остаётся только общая часть"], exclude: ["Исключить", "Общая часть вырезается, остальное остаётся"],
        back: ["Вычесть нижнюю", "Нижние фигуры вырезаются из верхней"] };

    function showPfMode(v) {
        var mode = PF_MODES[v] ? v : shape.pfLast;
        ui.pfName.textContent = PF_MODES[mode][0];
        ui.pfSub.textContent = PF_MODES[mode][1];
        Array.prototype.forEach.call(ui.pfModes.querySelectorAll("button[data-v]"), function (b) {
            b.setAttribute("aria-pressed", b.getAttribute("data-v") === shape.pfLast ? "true" : "false");
        });
    }

    async function onPathfinder(mode) {
        var res, r;
        if (busy || !PF_MODES[mode]) { return; }
        shape.pfLast = mode;
        storeShape();
        showPfMode(mode);
        setBusy(true);
        try {
            res = await host("pathfinder", [mode, !!shape.pfKeep]);
            setBusy(false);
            r = res.pathfinder;
            setStatus("Pathfinder «" + PF_MODES[mode][0] + "»: " + plural(r.count, "слой", "слоя", "слоёв") + " → «" + r.name + "». " +
                (r.kept ? "Исходные слои спрятаны (выключен глаз)." : "Исходные слои убраны.") +
                (r.skipped.length ? " Не шейпы, пропущены: " + r.skipped.join(", ") + "." : "") + " Отменить — Cmd/Ctrl+Z.", "done");
        } catch (e) {
            toolFailed(e);
        }
    }

    function enablePathfinder() {
        Array.prototype.forEach.call(ui.pfModes.querySelectorAll("button[data-v]"), function (b) {
            var v = b.getAttribute("data-v");
            b.addEventListener("click", function () { onPathfinder(v); });
            b.addEventListener("mouseenter", function () { showPfMode(v); });
            b.addEventListener("focus", function () { showPfMode(v); });
            b.addEventListener("mouseleave", function () { showPfMode(null); });
            b.addEventListener("blur", function () { showPfMode(null); });
        });
        ui.pfKeep.checked = !!shape.pfKeep;
        ui.pfKeep.addEventListener("change", function () { shape.pfKeep = ui.pfKeep.checked; storeShape(); });
        showPfMode(null);
    }

    async function onRemoveUnused() {
        var r, list;
        if (busy) { return; }
        setBusy(true);
        setStatus("Ищу неиспользуемые файлы…", "busy");
        try {
            r = await host("removeUnused", ["Не используется"]);
            setBusy(false);
            if (IS_PR) {
                if (!r.removed) { setStatus("Лишних файлов нет: всё в проекте где-то используется.", ""); return; }
                list = r.names.length > 10 ? r.names.slice(0, 10).join(", ") + " и ещё " + (r.names.length - 10) : r.names.join(", ");
                setStatus("Файлов, которых нет ни в одной секвенции: " + r.removed + " (" + list + "). Они сложены в корзину «" + r.bin + "» — проверьте и удалите её одной клавишей Delete. Скрипт в Premiere удалять не может.", "done");
                return;
            }
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
        shareSoon();
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
        // Сверху — одна строка: разделы, «Поделиться» и ⋯. Карточка над брендбуком видна, только пока вводят название,
        // спрашивают про импорт или просят нажать «Удалить» ещё раз.
        ui.brandPickRow.hidden = true;
        ui.brandShareRow.hidden = true;
        ui.brandAsk.hidden = !brandPending;
        ui.brandTop.hidden = brandNaming === null && !brandPending && !brandDelAt;
        ui.brandExport.hidden = !has;
        ui.brandRename.hidden = ui.brandDelete.hidden = !has;
        ui.brandNameRow.hidden = brandNaming === null;
        ui.brandEmpty.hidden = has || brandNaming !== null;
        ui.brandBody.hidden = !b;
        ui.brandDeleteNote.hidden = !brandDelAt;
        ui.brandSubs.hidden = !brands.items.length;   // пока проектов нет, хватает большой кнопки «Создать первый проект»
        ui.brandBar.hidden = ui.brandSubs.hidden;
        renderBrandSubs();
        renderBrandSubChips(pr);
        renderBrandHits();
        if (!b) { return; }
        renderBrandLogos(b);
        renderBrandIcons(b);
        renderBrandColors(b);
        renderBrandGrads(b);
        if (document.activeElement !== ui.brandFontHead) { ui.brandFontHead.value = b.fonts.head; }
        if (document.activeElement !== ui.brandFontBody) { ui.brandFontBody.value = b.fonts.body; }
        renderBrandTexts(b);
        renderBrandPreviews(b);
    }

    // Подбренды раздела (Alif, Alif Shop, Alif Business…) — кнопки в «Логотипах»; «+» создаёт новый.
    function renderBrandSubChips(pr) {
        var box = ui.brandSubChips, add;
        box.innerHTML = "";
        (pr ? pr.subs : []).forEach(function (sb) {
            var on = sb.id === pr.active, c = mkEl("button", "brand-subb", sb.name);
            c.type = "button";
            c.setAttribute("role", "tab");
            c.setAttribute("data-sub", sb.id);
            c.setAttribute("aria-selected", on ? "true" : "false");
            c.title = on ? "Двойной щелчок — переименовать" : "Открыть «" + sb.name + "»";
            c.addEventListener("click", function () {
                if (pr.active === sb.id) { return; }
                pr.active = sb.id; brandDelAt = 0; brandNaming = null; storeBrands(); renderBrand();
            });
            c.addEventListener("dblclick", function () { if (pr.active === sb.id) { brandAskName("rename"); } });
            box.appendChild(c);
        });
        add = mkEl("button", "brand-subb brand-subb-add", "+");
        add.type = "button";
        add.title = "Новый подбренд";
        add.setAttribute("aria-label", add.title);
        add.addEventListener("click", function () { brandAskName("new"); });
        box.appendChild(add);
    }

    // Свёрнутый раздел — одна строка: название, маленькое превью и число.
    function renderBrandPreviews(b) {
        var pv = {}, n = {}, i;
        function sw(css) { var e = mkEl("i"); e.style.background = css; return e; }
        function txt(t) { return mkEl("span", "brand-pv-t", t); }
        pv.logos = []; n.logos = b.logos.length;
        pv.icons = b.icons.length ? [] : [txt("пусто")]; n.icons = b.icons.length;
        pv.colors = b.colors.slice(0, 6).map(function (c) { return sw(c.hex); }); n.colors = b.colors.length;
        pv.grads = b.gradients.slice(0, 2).map(function (g) { var e = sw(gradientCss(g)); e.className = "brand-pv-grad"; return e; });
        if (!b.gradients.length) { pv.grads = [txt("пусто")]; }
        n.grads = b.gradients.length;
        pv.fonts = b.fonts.head || b.fonts.body ? [mkEl("b", "", "Aa"), txt([b.fonts.head, b.fonts.body].filter(Boolean).map(function (f) { return f.replace(/-.*$/, ""); }).join(" · "))] : [txt("не выбраны")];
        n.fonts = (b.fonts.head ? 1 : 0) + (b.fonts.body ? 1 : 0);
        pv.texts = [txt(b.texts.length ? b.texts.slice(0, 3).map(function (t) { return t.text; }).join(" · ") : "пусто")]; n.texts = b.texts.length;
        pv.formats = [txt("16:9 · 9:16 · 1:1 · 4:5")]; n.formats = "";
        brandSecs().forEach(function (sec) {
            var id = sec.getAttribute("data-sec"), box = sec.querySelector(".brand-pv"), cnt = sec.querySelector(".brand-n");
            if (!box) { return; }
            box.innerHTML = "";
            for (i = 0; pv[id] && i < pv[id].length; i++) { box.appendChild(pv[id][i]); }
            cnt.textContent = n[id] === undefined ? "" : String(n[id]);
        });
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

    // Фон плитки под логотип: светлая клетка, а под белый (светлый) логотип — тёмная, чтобы любой было видно.
    // Сначала смотрим на пиксели; если картинку нельзя прочитать — по варианту логотипа («Белый…»).
    function logoTone(img, pic, variant) {
        var guess = /white/.test(variant || "");
        pic.classList.toggle("on-dark", guess);
        img.addEventListener("load", function () {
            var c, x, d, i, a, sum = 0, n = 0;
            try {
                c = document.createElement("canvas"); c.width = 48; c.height = 48;
                x = c.getContext("2d");
                x.drawImage(img, 0, 0, 48, 48);
                d = x.getImageData(0, 0, 48, 48).data;
                for (i = 0; i < d.length; i += 4) {
                    a = d[i + 3] / 255;
                    if (a > 0.3) { sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++; }
                }
                if (n > 20) { pic.classList.toggle("on-dark", sum / n > 0.62); }
            } catch (e) { pic.classList.toggle("on-dark", guess); }
        });
    }

    function renderBrandLogos(b) {
        var box = ui.brandLogos;
        box.innerHTML = "";
        ui.brandLogoCap.textContent = b.logos.length ? b.logos[0].name : "";
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
                logoTone(img, pic, l.variant);
                img.src = fileUrl(l.file);
                pic.appendChild(img);
            } else {
                pic.appendChild(mkEl("span", "", (l.file.match(/\.([a-z0-9]+)$/i) || ["", "file"])[1]));
            }
            pic.addEventListener("click", function () { brandPlaceLogo(l); });
            pic.addEventListener("mouseenter", function () { ui.brandLogoCap.textContent = l.name; });
            pic.addEventListener("focus", function () { ui.brandLogoCap.textContent = l.name; });
            LOGO_VARIANTS.forEach(function (v) {
                var o = mkEl("option", "", v[1]);
                o.value = v[0];
                sel.appendChild(o);
            });
            sel.value = logoVariant(l.variant)[0];
            sel.setAttribute("aria-label", "Вариант логотипа «" + l.name + "»");
            sel.addEventListener("change", function () { l.variant = sel.value; storeBrands(); if (img && !img.naturalWidth) { pic.classList.toggle("on-dark", /white/.test(l.variant)); } });
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
                logoTone(img, pic, "");
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
        if (!brandArmDelete("project", "Нажмите «Удалить подбренд» ещё раз, чтобы удалить «" + b.name + "» вместе с его логотипами.")) { return; }
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
            if (IS_PR) {
                return r.comp ? "Иконка «" + l.name + "» вставлена в «" + r.comp + "» под указателем. Файл — в корзине «" + brandBin(b) + "»."
                    : "Иконка «" + l.name + "» добавлена в проект, в корзину «" + brandBin(b) + "». Откройте секвенцию — и щелчок вставит её туда.";
            }
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
            if (IS_PR) {
                return r.comp ? "Логотип «" + l.name + "» вставлен в «" + r.comp + "» под указателем" + (r.track ? ", дорожка " + r.track : "") + ". Файл — в корзине «" + brandBin(b) + "»."
                    : "Логотип «" + l.name + "» добавлен в проект, в корзину «" + brandBin(b) + "». Откройте секвенцию — и щелчок вставит его туда.";
            }
            return r.comp ? "Логотип «" + l.name + "» вставлен в «" + r.comp + "» прекомпозицией «" + r.pre + "»: внутри логотип в масштабе 100 %, а сама прекомпозиция — " + r.scale + " %. Файл и прекомпозиция лежат в папке «" + brandBin(b) + "»."
                : "Логотип «" + l.name + "» добавлен в проект, в папку «" + brandBin(b) + "». Откройте композицию — и щелчок вставит его в неё.";
        });
    }

    // Premiere не красит клипы и не делает текстовых слоёв скриптом: цвет и текст бренда копируются в буфер обмена.
    function copyText(text) {
        var ta = document.createElement("textarea"), ok = false;
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        return ok;
    }

    function brandPaint(c) {
        if (IS_PR) {
            setStatus(copyText(c.hex) ? "«" + c.name + "» " + c.hex + " скопирован — вставьте его в цвет в Essential Graphics или Lumetri." : "Не получилось скопировать " + c.hex + ".", "done");
            return;
        }
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
        if (IS_PR) {
            setStatus(copyText(t.text) ? "Текст скопирован — вставьте его в титр (Essential Graphics)." : "Не получилось скопировать текст.", "done");
            return;
        }
        brandCall("brandText", [t.text, b.fonts.head || b.fonts.body || "", b.colors.length ? b.colors[0].hex : ""], function (r) {
            return "Текстовый слой «" + r.name + "» создан в «" + r.comp + "»" + (r.missing ? ", но шрифта бренда нет на этом компьютере — стоит замена." : ".");
        });
    }

    function brandMakeComp(w, h) {
        var b = activeBrand();
        if (!b) { return; }
        brandCall("brandComp", [b.name + " " + w + "x" + h, w, h, 30, 10, brandBgHex(b), brandBin(b)], function (r) {
            if (IS_PR) { return "Секвенция «" + r.name + "» " + w + "×" + h + " создана и открыта. Она — в корзине «" + brandBin(b) + "»."; }
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

    // Разделы сворачиваются в строку (щелчок по заголовку); какие открыты — запоминается. Сначала открыты только «Логотипы».
    var BRAND_OPEN_KEY = "sayframe.brandOpen.v1";
    function brandOpenList() {
        var v = null;
        try { v = JSON.parse(window.localStorage.getItem(BRAND_OPEN_KEY) || "null"); } catch (e) {}
        return v instanceof Array ? v : ["logos"];
    }
    function brandSetOpen(sec, on) {
        var id = sec.getAttribute("data-sec"), list = brandOpenList().filter(function (x) { return x !== id; });
        sec.classList.toggle("open", on);
        sec.querySelector(".brand-fold").setAttribute("aria-expanded", on ? "true" : "false");
        if (on) { list.push(id); }
        try { window.localStorage.setItem(BRAND_OPEN_KEY, JSON.stringify(list)); } catch (e) {}
    }
    function brandFoldInit(sec, head, name) {
        var title = head.querySelector("b"), hint = sec.querySelector(":scope > small.hint"), fold = mkEl("button", "brand-fold"), add;
        var pv = mkEl("span", "brand-pv"), n = mkEl("span", "brand-n");
        head.insertBefore(pv, title.nextSibling);
        head.insertBefore(n, pv.nextSibling);
        // Пояснение — не серым текстом в блоке, а подсказкой при наведении на название.
        if (hint) { title.title = hint.textContent; title.setAttribute("data-info", name + "|" + hint.textContent); }
        add = head.querySelector(".brand-add");
        if (add) { add.setAttribute("aria-label", add.title); add.textContent = "+"; }
        if (!add) {
            // «+» у раздела без своей кнопки: раскрывает раздел и ставит курсор в первое поле.
            add = mkEl("button", "ghost brand-add brand-plus", "+");
            add.type = "button";
            add.title = "Добавить: " + name.toLowerCase();
            add.setAttribute("aria-label", add.title);
            add.addEventListener("click", function (e) {
                var f;
                e.stopPropagation();
                brandSetOpen(sec, true);
                f = sec.querySelector(".brand-addrow input:not([type=color]), .brand-font input");
                if (f) { f.focus(); }
            });
            if (sec.getAttribute("data-sec") !== "formats") { head.appendChild(add); }
        }
        fold.type = "button";
        fold.setAttribute("aria-label", "Свернуть или раскрыть раздел «" + name + "»");
        fold.title = "Свернуть / раскрыть";
        fold.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5L6 7.5 9 4.5"/></svg>';
        fold.addEventListener("click", function (e) { e.stopPropagation(); brandSetOpen(sec, !sec.classList.contains("open")); });
        head.appendChild(fold);
        head.addEventListener("click", function (e) {
            if (e.target.closest("button, input, select")) { return; }
            brandSetOpen(sec, !sec.classList.contains("open"));
        });
        sec.classList.toggle("open", brandOpenList().indexOf(sec.getAttribute("data-sec")) >= 0);
        fold.setAttribute("aria-expanded", sec.classList.contains("open") ? "true" : "false");
    }

    function brandMenu(on) {
        ui.brandMenu.hidden = !on;
        ui.brandMore.setAttribute("aria-expanded", on ? "true" : "false");
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
            brandFoldInit(sec, head, name);
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
    function styleThumb(st) {
        var t = mkEl("i", "style-thumb");
        t.setAttribute("aria-hidden", "true");
        t.setAttribute("data-style", st.base ? "custom" : st.id);
        if (st.palette && st.palette.length) { t.style.background = "linear-gradient(135deg, " + (st.palette.length > 1 ? st.palette.slice(0, 4).join(", ") : st.palette[0] + ", " + st.palette[0]) + ")"; }
        return t;
    }
    function renderMotionStyles() {
        var st = motionStyleOf(settings.motionStyle) || MOTION_STYLES[0];
        aiEls();
        Array.prototype.forEach.call(ui.styleRow.querySelectorAll(".style-chip"), function (b) {
            b.setAttribute("aria-checked", b.getAttribute("data-style") === settings.motionStyle ? "true" : "false");
        });
        if (ui.aiStyleBtn) {
            ui.aiStyleBtn.textContent = st.label + " ▾";
            ui.aiStyleBtn.insertBefore(styleThumb(st), ui.aiStyleBtn.firstChild);
        }
        if (ui.aiStyleTricks) {
            ui.aiStyleTricks.textContent = "";
            (st.tricks || []).forEach(function (t) { ui.aiStyleTricks.appendChild(mkEl("span", "pf-trick", t)); });
            if (st.base) {
                var del = mkEl("button", "pf-trick-del", "Удалить стиль");
                del.type = "button";
                del.setAttribute("data-del", st.id);
                ui.aiStyleTricks.appendChild(del);
            }
            ui.aiStyleTricksBox.hidden = !(st.tricks && st.tricks.length) && !st.base;
        }
    }
    var STYLE_NOTES = { normal: "аккуратно, как сейчас", smooth: "мягко, без отскоков", energetic: "быстро и резко", minimal: "мало движения", corporate: "строго и чисто",
        playful: "отскоки и задор", collage: "рваная бумага, на двойках", archival: "ч/б, зерно, свечение", kinetic: "текст в ритм",
        neon: "светящиеся трубки", glitch: "цифровые сбои", vhs: "кассета 90-х", swiss: "строгая сетка", sketch: "рисунок от руки" };
    function buildStyleChips() {
        Array.prototype.forEach.call(ui.styleRow.querySelectorAll(".style-chip"), function (b) { b.parentNode.removeChild(b); });
        MOTION_STYLES.concat(CUSTOM_STYLES).forEach(function (st) {
            var b = mkEl("button", "style-chip" + (st.pack ? " style-pack" : "") + (st.base ? " style-mine" : "")), nm = mkEl("span", "style-name", st.label);
            b.type = "button";
            b.setAttribute("role", "radio");
            b.setAttribute("data-style", st.id);
            b.title = st.id === "normal" ? "Без особого стиля: аккуратные плавности и очерёдность" : st.base ? "Ваш стиль из рефа: " + st.label : "Стиль движения: " + st.label.toLowerCase();
            b.appendChild(styleThumb(st));
            b.appendChild(nm);
            b.appendChild(mkEl("small", "style-note", st.base ? "ваш стиль" : (STYLE_NOTES[st.id] || "")));
            b.addEventListener("click", function () {
                settings.motionStyle = st.id;
                storeSettings(settings);
                renderMotionStyles();
                aiPop(null);
                setStatus(st.id === "normal" ? "Стиль анимации: обычный." : "Стиль анимации: «" + st.label + "» — для всех следующих запросов.", "");
            });
            ui.styleRow.appendChild(b);
        });
        renderMotionStyles();
    }
    function initMotionStyles() {
        buildStyleChips();
    }

    function initBrand() {
        initBrandOrder();
        initMentions();
        ui.brandMore.addEventListener("click", function (e) { e.stopPropagation(); brandMenu(ui.brandMenu.hidden); });
        document.addEventListener("mousedown", function (e) { if (!ui.brandMenu.hidden && !e.target.closest(".brand-tools")) { brandMenu(false); } });
        [ui.brandNew, ui.brandRename, ui.brandImport].forEach(function (b) { b.addEventListener("click", function () { brandMenu(false); }); });
        ui.brandNew.addEventListener("click", function () { brandAskName("new"); });
        ui.brandFirst.addEventListener("click", function () { brandAskName("new"); });
        ui.brandRename.addEventListener("click", function () { if (activeBrand()) { brandAskName("rename"); } });
        ui.brandDelete.addEventListener("click", brandDelete);
        ui.brandDelete.addEventListener("click", function () { if (!brandDelAt) { brandMenu(false); } });   // удалено — меню закрывается
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
        var hint = m === "NO_ACTIVE_COMP" || m === "NO_KEYS_SELECTED" || m === "NO_LAYERS_SELECTED" || m === "DC_NO_PRECOMP" || m === "CO_NOT_PHOTO" || m === "CO_NOT_STILL" || m === "BR_NO_TEXT" || m === "ALIGN_NEEDS_TWO" || m === "DISTRIBUTE_NEEDS_THREE" || m === "STAGGER_NEEDS_TWO" || m === "STAGGER_NO_KEYS" || m === "KA_NO_KEYS" || m === "KA_NEED_TWO" || /^SM_/.test(m) || m === "PF_NEED_SHAPES" || m === "GRID_TOO_TIGHT" || m === "RB_NO_PATH" || m === "NO_TEXT_LAYER" || m === "GL_NO_SHAPE" || m === "OR_NO_CAROUSEL" || m === "OR_NO_PHOTOS";
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
            setStatus(prWords(parts.join(" ")) + (res.moved ? "\nОтменить: Cmd/Ctrl+Z." : ""), res.moved ? "done" : res.failed ? "error" : "");
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
            setStatus(prWords(parts.join(" ")) + (res.moved ? "\nОтменить: Cmd/Ctrl+Z." : ""), res.moved ? "done" : res.failed ? "error" : "");
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
            setStatus(prWords(parts.join(" ")) + (res.moved ? "\nОтменить: Cmd/Ctrl+Z." : ""), res.moved ? "done" : res.failed ? "error" : "");
        }).catch(toolFailed);
    }

    // ---- сдвиг во времени: появление, исчезновение или слой целиком

    var ORDER_NAMES = { asc: "сверху вниз", desc: "снизу вверх", selection: "как выделяли", random: "случайно", align: "к указателю времени" };

    function pressGroupV(group, v) {
        Array.prototype.forEach.call(group.querySelectorAll("button[data-v]"), function (b) {
            b.setAttribute("aria-pressed", b.getAttribute("data-v") === v ? "true" : "false");
        });
    }

    // Значки порядка «Лесенки»: три ступеньки — полоски слоёв или пары ключей, смотря что расставляем.
    var STAIR_STEPS = { asc: [0, 1, 2], random: [1, 0, 2], desc: [2, 1, 0] };

    function stairIcon(order, keys) {
        var svg = "", i, x, y;
        if (order === "align") {
            // Розовая линия — указатель времени; всё начинается на ней.
            for (i = 0; i < 3; i++) {
                y = 4 + i * 8;
                if (keys) {
                    x = 21 + i * 3;
                    svg += "<path class=\"st-key-line\" d=\"M7 " + y + "H" + x + "\"/>" +
                        "<path d=\"M7 " + (y - 3) + "l3 3-3 3-3-3z\"/><path d=\"M" + x + " " + (y - 3) + "l3 3-3 3-3-3z\"/>";
                } else {
                    svg += "<rect x=\"7\" y=\"" + (y - 2.6) + "\" width=\"" + (26 - i * 4) + "\" height=\"5.2\" rx=\"1.8\"/>";
                }
            }
            svg += "<path class=\"st-playhead\" d=\"M7 1V23\"/>";
            return "<svg viewBox=\"0 0 40 24\" aria-hidden=\"true\">" + svg + "</svg>";
        }
        for (i = 0; i < 3; i++) {
            x = 3 + STAIR_STEPS[order][i] * 7;
            y = 4 + i * 8;
            if (keys) {
                svg += "<path class=\"st-key-line\" d=\"M" + (x + 3) + " " + y + "H" + (x + 17) + "\"/>" +
                    "<path d=\"M" + (x + 3) + " " + (y - 3) + "l3 3-3 3-3-3z\"/><path d=\"M" + (x + 17) + " " + (y - 3) + "l3 3-3 3-3-3z\"/>";
            } else {
                svg += "<rect x=\"" + x + "\" y=\"" + (y - 2.6) + "\" width=\"22\" height=\"5.2\" rx=\"1.8\"/>";
            }
        }
        return "<svg viewBox=\"0 0 40 24\" aria-hidden=\"true\">" + svg + "</svg>";
    }

    // Значки пяти действий «Ключей»: ромбики, розовый указатель времени с «шапкой», как у кнопок порядка.
    function keyActIcon(mode) {
        function k(x, y, o) { return "<path d=\"M" + x + " " + (y - 3) + "l3 3-3 3-3-3z\"" + (o ? " opacity=\"" + o + "\"" : "") + "/>"; }
        function bar(x, y, w) { return "<rect x=\"" + x + "\" y=\"" + (y - 2) + "\" width=\"" + w + "\" height=\"4\" rx=\"1.6\"/>"; }
        function ph(x) { return "<path class=\"st-playhead\" d=\"M" + x + " 4V23\"/><path class=\"st-playhead-cap\" d=\"M" + (x - 2.6) + " 0.5h5.2v2.6l-2.6 2.2-2.6-2.2z\"/>"; }
        var svg = {
            mirror: k(8, 9) + k(14, 15) + ph(20) + k(26, 15, 0.6) + k(32, 9, 0.6),
            reverse: k(9, 18) + k(31, 18) + "<path class=\"st-arc\" d=\"M12 10C16 4 24 4 28 10M12 10l-.4-3.3M12 10l3.1-1.2M28 10l.4-3.3M28 10l-3.1-1.2\"/>",
            first: ph(8) + k(8, 9) + k(8, 17) + k(19, 9, 0.6) + k(26, 17, 0.6),
            last: ph(32) + k(32, 9) + k(32, 17) + k(21, 9, 0.6) + k(14, 17, 0.6),
            clone: k(6, 9) + k(12, 15) + ph(22) + k(22, 9, 0.6) + k(28, 15, 0.6),
            // «Слои»: полоски слоёв начинаются (или заканчиваются) на указателе.
            start: ph(8) + bar(9, 8, 18) + bar(9, 14, 24) + bar(9, 20, 13),
            end: ph(32) + bar(13, 8, 18) + bar(7, 14, 24) + bar(18, 20, 13)
        }[mode];
        return "<svg viewBox=\"0 0 40 24\" aria-hidden=\"true\">" + svg + "</svg>";
    }

    function drawStaggerPreview() {
        var keys = motion.staggerWhat === "keys", order = motion.staggerOrder, n = motion.staggerStep;
        Array.prototype.forEach.call(ui.staggerOrder.querySelectorAll("button[data-v]"), function (b) {
            b.innerHTML = stairIcon(b.getAttribute("data-v"), keys);
            // У ключей «К указателю» нет: это делает действие «По первому» внизу.
            // В «Слоях» вместо него две кнопки внизу: «Начало» и «Конец» к указателю (в Premiere — как было).
            if (b.getAttribute("data-v") === "align") { b.hidden = !IS_PR; }
        });
        ui.staggerOrder.classList.toggle("no-align", !IS_PR);
        if (ui.staggerActs) { ui.staggerActs.hidden = !keys || IS_PR; }
        if (ui.staggerLayerActs) { ui.staggerLayerActs.hidden = keys || IS_PR; }
        var align = order === "align";
        var stepRow = ui.staggerBtn.closest(".tool-card").querySelector(".shift-row-step");
        if (stepRow) { stepRow.hidden = align; }
        ui.staggerBtn.textContent = align ? "Выровнять" : "Расставить";
        ui.staggerPrevText.textContent = align
            ? (keys ? "Первый ключ каждого слоя встанет на указатель времени, остальные ключи сдвинутся вместе с ним." : "Все выделенные слои начнутся там, где стоит указатель времени.")
            : (keys ? "Ключи каждого следующего слоя — на " : "Каждый следующий слой — на ") + plural(n, "кадр", "кадра", "кадров") + " позже предыдущего.";
        ui.staggerBtn.title = ui.staggerPrevText.textContent;
        ui.staggerOrderName.textContent = ORDER_NAMES[order].charAt(0).toUpperCase() + ORDER_NAMES[order].slice(1);
    }

    function drawShift() {
        if (motion.staggerOrder === "align" && !IS_PR) { motion.staggerOrder = "asc"; }
        pressGroupV(ui.staggerWhat, motion.staggerWhat);
        pressGroupV(ui.staggerOrder, motion.staggerOrder);
        ui.staggerStep.value = String(motion.staggerStep);
        drawStaggerPreview();
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
        if (res.skipped) { parts.push("Пропущено: " + plural(res.skipped, "слой", "слоя", "слоёв") + (what === "keys" ? " (у слоя нет ключей)." : " (нет ключей " + (what === "out" ? "во второй" : "в первой") + " половине слоя).")); }
        if (res.failed) { parts.push("Не получилось: " + plural(res.failed, "слой", "слоя", "слоёв") + " (слой заблокирован?)."); }
        if (res.keysFailed && !res.failed) { parts.push("Не удалось перенести: " + plural(res.keysFailed, "ключ", "ключа", "ключей") + "."); }
        if (!parts.length) { parts.push("Нечего сдвигать."); }
        setStatus(prWords(parts.join(" ")) + (res.moved ? "\nОтменить: Cmd/Ctrl+Z." : ""), res.moved ? "done" : res.failed ? "error" : "");
    }

    // Premiere: в отчётах инструментов вместо слоёв — клипы.
    function prWords(t) {
        if (!IS_PR) { return t; }
        return t.replace(" (камера, свет или слой с ключами)", " (у клипа есть ключи положения или привязки)").replace(" (слой заблокирован?)", "")
            .replace(/слоёв/g, "клипов").replace(/слоя/g, "клипа").replace(/слой/g, "клип").replace(/Слои/g, "Клипы");
    }

    function onStagger() {
        var what = motion.staggerWhat;
        var frames = motion.staggerStep;
        if (busy) { return; }
        setBusy(true);
        setStatus("Делаю лесенку…", "busy");
        host("stagger", [what, frames, motion.staggerOrder]).then(function (res) {
            setBusy(false);
            if (res.aligned) {
                showShiftResult(res, what, prWords("К указателю времени: " + plural(res.moved, "слой", "слоя", "слоёв") + "."));
                return;
            }
            showShiftResult(res, what, prWords("Лесенка: " + plural(res.steps, "слой", "слоя", "слоёв") + ", шаг " + plural(frames, "кадр", "кадра", "кадров") + "."));
        }).catch(toolFailed);
    }

    // «Слои»: начало или конец всех выделенных слоёв — на указатель времени.
    function onLayerAlign(end) {
        if (busy) { return; }
        setBusy(true);
        setStatus("Двигаю слои…", "busy");
        host("stagger", ["layer", 1, end ? "alignEnd" : "align"]).then(function (res) {
            setBusy(false);
            showShiftResult(res, "layer", (end ? "Конец к указателю: " : "Начало к указателю: ") + plural(res.moved, "слой", "слоя", "слоёв") + ".");
        }).catch(toolFailed);
    }

    var KEY_ACT_DONE = { mirror: "Отразил", reverse: "Развернул", first: "По первому", last: "По последнему", clone: "Клон" };

    function onKeyAct(mode) {
        if (busy) { return; }
        setBusy(true);
        setStatus("Меняю ключи…", "busy");
        host("keyAct", [mode]).then(function (res) {
            var parts = [], scope = res.selected ? "" : " (ключи не выделены — взял все ключи слоя)";
            setBusy(false);
            if (res.keys) {
                if (mode === "first" || mode === "last") { parts.push(KEY_ACT_DONE[mode] + ": " + plural(res.layers, "слой", "слоя", "слоёв") + " — " + (mode === "first" ? "первые" : "последние") + " ключи на указателе времени" + scope + "."); }
                else { parts.push(KEY_ACT_DONE[mode] + ": " + plural(res.keys, "ключ", "ключа", "ключей") + scope + "."); }
            } else if (mode === "first" || mode === "last") { parts.push("Уже на месте: ключи и так стоят на указателе времени."); }
            if (res.few) { parts.push("Пропущено: " + plural(res.few, "свойство", "свойства", "свойств") + " с одним ключом."); }
            if (res.failed) { parts.push("Не получилось: " + plural(res.failed, "ключ", "ключа", "ключей") + " (слой заблокирован?)."); }
            setStatus(parts.join(" ") + (res.keys ? "\nОтменить: Cmd/Ctrl+Z." : ""), res.keys ? "done" : res.failed ? "error" : "");
        }).catch(toolFailed);
    }

    function enableShiftTool() {
        var infos = ui.motionTools.querySelectorAll(".tool-info");
        var i;
        function pick(group, key, allowed) {
            Array.prototype.forEach.call(group.querySelectorAll("button[data-v]"), function (btn) {
                btn.addEventListener("click", function () {
                    var v = btn.getAttribute("data-v");
                    motion[key] = allowed.indexOf(v) >= 0 ? v : MOTION_DEFAULTS[key];
                    storeMotion();
                    drawShift();
                    // «Ключи» добавляет ряд кнопок — блоку в сетке нужно больше клеток.
                    if (key === "staggerWhat") { relayoutTools(); }
                });
            });
        }
        drawShift();
        pick(ui.staggerWhat, "staggerWhat", STAGGER_TARGETS);
        pick(ui.staggerOrder, "staggerOrder", STAGGER_ORDERS);
        ui.staggerStep.addEventListener("change", function () { onStepNumber(ui.staggerStep, "staggerStep"); drawShift(); });
        ui.staggerLess.addEventListener("click", function () { motion.staggerStep = clampStep(motion.staggerStep - 1); storeMotion(); drawShift(); });
        ui.staggerMore.addEventListener("click", function () { motion.staggerStep = clampStep(motion.staggerStep + 1); storeMotion(); drawShift(); });
        [ui.staggerStep].forEach(function (input) {
            input.addEventListener("keydown", function (e) {
                if (e.key === "Enter") { input.blur(); }
                if (e.key === "Escape") { input.value = String(motion.staggerStep); input.blur(); }
            });
            input.addEventListener("focus", function () { input.select(); });
        });
        ui.staggerBtn.addEventListener("click", onStagger);
        if (ui.staggerLayerActs) {
            Array.prototype.forEach.call(ui.staggerLayerActs.querySelectorAll("button[data-a]"), function (b) {
                b.innerHTML = keyActIcon(b.getAttribute("data-a"));
                b.addEventListener("click", function () { onLayerAlign(b.getAttribute("data-a") === "end"); });
            });
        }
        if (ui.staggerActs) {
            Array.prototype.forEach.call(ui.staggerActs.querySelectorAll("button[data-a]"), function (b) {
                b.innerHTML = keyActIcon(b.getAttribute("data-a"));
                b.addEventListener("click", function () { onKeyAct(b.getAttribute("data-a")); });
            });
            // В узком блоке пять кнопок не помещаются с понятными иконками — по три в ряд.
            if (typeof window.ResizeObserver === "function") {
                new window.ResizeObserver(function () {
                    var w = ui.staggerActs.clientWidth, narrow = w > 0 && w < 224;
                    if (w > 0 && narrow !== ui.staggerActs.classList.contains("narrow")) {
                        ui.staggerActs.classList.toggle("narrow", narrow);
                        relayoutTools();
                    }
                }).observe(ui.staggerActs);
            }
        }
        // «i» рядом со списком: объяснение появляется в строке состояния (и во всплывающей подсказке).
        for (i = 0; i < infos.length; i++) {
            infos[i].addEventListener("click", function () {
                if (!busy) { setStatus(this.getAttribute("data-info"), ""); }
            });
        }
    }

    // ---- сетка блоков раздела «Инструменты»

    function toolCards() {
        return Array.prototype.slice.call(G.el.querySelectorAll(".tool-card:not(.tool-off)"));
    }

    // ---- какие блоки показывать: Настройки → Общие → «Какие инструменты показывать»

    var toolsHidden = [];

    function hiddenToolList(text) {
        var all = TOOL_NAMES.concat(SHAPE_TOOL_NAMES), out = [];
        String(text || "").split(",").forEach(function (n) {
            n = n.replace(/\s/g, "");
            if (all.indexOf(n) >= 0 && out.indexOf(n) < 0) { out.push(n); }
        });
        return out;
    }

    function toolPickerName(card) {
        var b = card.querySelector(".tool-head b");
        var name = card.getAttribute("aria-label") || (b ? b.textContent : "") || card.getAttribute("data-tool");
        return name.replace(/^\s+|\s+$/g, "");
    }

    // Список строится один раз: заголовок раздела и кнопки-«галочки» его инструментов.
    function buildToolPicker() {
        [["Инструменты", "motionTools", TOOL_NAMES], ["Шейп", "shapeTools", SHAPE_TOOL_NAMES]].forEach(function (g) {
            var head = document.createElement("small"), box = document.getElementById(g[1]), row = document.createElement("div");
            head.className = "tool-picker-head";
            head.textContent = g[0];
            row.className = "tool-picker-row";
            g[2].forEach(function (name) {
                var card = box && box.querySelector('.tool-card[data-tool="' + name + '"]'), b;
                if (!card) { return; }
                b = document.createElement("button");
                b.type = "button";
                b.setAttribute("data-tool", name);
                b.innerHTML = "<span class=\"tool-picker-mark\" aria-hidden=\"true\"></span><span></span>";
                b.lastChild.textContent = toolPickerName(card);
                b.addEventListener("click", function () {
                    var list;
                    if (!draft) { return; }
                    list = hiddenToolList(draft.hiddenTools);
                    if (list.indexOf(name) >= 0) { list.splice(list.indexOf(name), 1); } else { list.push(name); }
                    draft.hiddenTools = list.join(",");
                    showToolPicker();
                    applyTheme(draft);
                });
                row.appendChild(b);
            });
            ui.toolPicker.appendChild(head);
            ui.toolPicker.appendChild(row);
        });
    }

    function showToolPicker() {
        var list = hiddenToolList((draft || settings).hiddenTools);
        Array.prototype.forEach.call(ui.toolPicker.querySelectorAll("button[data-tool]"), function (b) {
            var on = list.indexOf(b.getAttribute("data-tool")) < 0;
            b.setAttribute("aria-pressed", on ? "true" : "false");
            b.title = on ? "Показан. Щёлкните, чтобы спрятать" : "Спрятан. Щёлкните, чтобы показать";
        });
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
            card.classList.toggle("tool-off", toolsHidden.indexOf(names[i]) >= 0);
            if (toolsHidden.indexOf(names[i]) >= 0) { continue; }
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
        // Отдельное окно блока: блок один, сетка не нужна.
        if (SOLO && SOLO.tool) { return; }
        GRIDS.forEach(function (g) {
            G = g;
            if (g.flowOrder && flowOn()) { layoutFlow(g); return; }
            unflow(g);
            layoutTools(placesNow(), null);
        });
        G = keep;
    }

    // ---- «Студия»: раздел «Инструменты» без сетки. Сверху кнопки «в один клик» по четыре в ряд,
    // ниже блоки с настройками друг под другом (в широкой панели — в две или три колонки).
    // Блок сворачивается в одну строку щелчком по заголовку. Плитки и блоки можно перетащить на другое место
    // (блок — за заголовок); порядок запоминается. Растягивания здесь нет.
    var FLOW_TILES = { paste: "Картинка", organize: "По папкам", unused: "Лишнее", cache: "Кэш", nullp: "Null", decompose: "Декомпоз", cutout: "Вырезка", split: "Разделить" };
    var FLOW_ICONS = {
        ease: '<path d="M4 19C11 19 13 5 20 5"/><circle cx="4" cy="19" r="1.5"/><circle cx="20" cy="5" r="1.5"/>',
        easecopy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
        stagger: '<path d="M4 6h8M8 12h8M12 18h8"/>',
        anchor: '<circle cx="12" cy="12" r="6"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
        align: '<path d="M5 4v16M9 8h10M9 16h6"/>',
        pathfinder: '<rect x="3" y="3" width="12" height="12" rx="1"/><rect x="9" y="9" width="12" height="12" rx="1"/>',
        textbox: '<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M8 10h8M12 10v5"/>'
    };

    var FLOW_ORDER = ["paste", "organize", "unused", "cache", "nullp", "decompose", "cutout", "ease", "easecopy", "stagger", "anchor", "align"];
    var FLOW_SHAPE_ORDER = ["split", "pathfinder"];

    function flowOn() { return document.documentElement.getAttribute("data-design") === "studio"; }

    // ---- Раздел AI в «Студии»: режимы Создать / Выражение / Мои, пример и стиль внутри поля, быстрые задачи плитками внизу.
    var AI_MODE_KEY = "sayframe.aiMode.v1";
    var aiMode = (function () { var m = ""; try { m = window.localStorage.getItem(AI_MODE_KEY) || ""; } catch (e) {} return ["create", "expr", "mine"].indexOf(m) >= 0 ? m : "create"; })();

    function aiPop(which) {
        [[ui.aiExample, ui.aiExampleMenu], [ui.aiStyleBtn, ui.aiStylePop], [ui.aiMore, ui.aiMoreMenu]].forEach(function (d) {
            if (!d[0]) { return; }
            d[1].hidden = d[1] !== which;
            d[0].setAttribute("aria-expanded", d[1] === which ? "true" : "false");
        });
    }

    function setAiMode(m) {
        aiMode = m;
        try { window.localStorage.setItem(AI_MODE_KEY, m); } catch (e) {}
        ui.viewClaude.setAttribute("data-ai", m);
        Array.prototype.forEach.call(ui.aiModes.querySelectorAll(".ai-mode"), function (b) {
            b.setAttribute("aria-selected", b.getAttribute("data-m") === m ? "true" : "false");
        });
        if (ui.aiHead) {
            ui.aiBack.hidden = m === "create";
            ui.aiTitle.textContent = m === "expr" ? "Экспрешен" : m === "mine" ? "Мои скрипты" : "Что анимируем?";
            ui.aiSub.textContent = m === "expr" ? "Формула для выделенного свойства" : m === "mine" ? "Запускаются одной кнопкой, без AI" :
                (IS_PR ? "Опишите словами — AI сделает в Premiere" : "Опишите словами — AI сделает в AE");
        }
        aiPop(null);
    }

    function aiEls() {
        if (ui.aiHead) { return; }
        ["aiHead", "aiBack", "aiTitle", "aiSub", "aiMore", "aiMoreMenu", "aiModelSeg", "aiStyleTail", "aiStyleNew", "aiStyleTricksBox", "aiStyleTricks",
            "planCard", "planTotal", "planCount", "planBar", "planList", "planEditRow", "planEdit", "planBuild", "planChange",
            "styleCard", "styleCardClose", "styleCardRef", "styleCardPal", "styleCardRows", "styleCardName", "styleCardSave"].forEach(function (id) { ui[id] = document.getElementById(id); });
    }

    function aiLayout() {
        var on, composer, main, wrap;
        if (!ui || !ui.aiModes || !ui.prompt) { return; }
        aiEls();
        on = flowOn(); composer = ui.prompt.closest(".composer"); main = ui.viewClaude.querySelector(".claude-main"); wrap = ui.prompt.parentNode;
        if (!composer || !main) { return; }
        ui.viewClaude.classList.toggle("ai-v3", on);
        ui.aiModes.hidden = true;
        ui.aiHead.hidden = !on;
        ui.promptFoot.hidden = !on;
        ui.quickTitle = ui.quickTitle || ui.quickToggle.querySelector("span");
        if (!ui.quickTitle.getAttribute("data-t")) { ui.quickTitle.setAttribute("data-t", ui.quickTitle.textContent); }
        ui.quickTitle.textContent = on ? "Попробуйте" : ui.quickTitle.getAttribute("data-t");
        if (!ui.runBtn.getAttribute("data-t")) { ui.runBtn.setAttribute("data-t", ui.runBtn.textContent); }
        if (on) {
            if (ui.runBtn.parentNode !== ui.promptFoot) { ui.promptFoot.appendChild(ui.runBtn); }
            ui.runBtn.textContent = "↑";
            ui.runBtn.title = planMode() ? "Составить план" : "Выполнить";
            ui.runBtn.setAttribute("aria-label", ui.runBtn.title);
        } else {
            if (ui.runBtn.parentNode !== composer) { composer.appendChild(ui.runBtn); }
            ui.runBtn.textContent = ui.runBtn.getAttribute("data-t");
            ui.runBtn.removeAttribute("title"); ui.runBtn.removeAttribute("aria-label");
            hidePlan();
            ui.styleCard.hidden = true;
        }
        if (!ui.prompt.getAttribute("data-ph")) { ui.prompt.setAttribute("data-ph", ui.prompt.placeholder); }
        ui.prompt.placeholder = on ? (IS_PR ? "Что сделать в секвенции?" : "Что сделать в композиции?") : ui.prompt.getAttribute("data-ph");
        if (on) {
            if (ui.styleRow.parentNode !== ui.aiStylePop) { ui.aiStylePop.insertBefore(ui.styleRow, ui.aiStyleTail); }
            if (ui.quickBox.parentNode !== main) { main.appendChild(ui.quickBox); }
            setAiMode(aiMode || "create");
        } else {
            if (ui.styleRow.parentNode !== composer) { composer.insertBefore(ui.styleRow, wrap); }
            if (ui.quickBox.parentNode !== composer) { composer.insertBefore(ui.quickBox, composer.firstChild); }
            ui.viewClaude.removeAttribute("data-ai");
            aiPop(null);
        }
        if (quick && ui.quickList) { drawQuick(); }
    }

    function initAiModes() {
        if (!ui.aiModes) { return; }
        aiEls();
        ui.aiMore.addEventListener("click", function (e) { e.stopPropagation(); renderModelSeg(); aiPop(ui.aiMoreMenu.hidden ? ui.aiMoreMenu : null); });
        ui.aiMoreMenu.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest("[data-mm]") : null, q = e.target.closest ? e.target.closest("[data-q]") : null;
            if (q) { setModelQ(q.getAttribute("data-q")); return; }
            if (!b) { return; }
            aiPop(null);
            switch (b.getAttribute("data-mm")) {
                case "expr": setAiMode("expr"); break;
                case "mine": setAiMode("mine"); break;
                case "newstyle": onStyleFromRef(); break;
                case "examples":
                    setAiMode("create");
                    quickEditing = !quickEditing;
                    if (!quick.open) { quick.open = true; storeQuick(); }
                    drawQuick();
                    setStatus(quickEditing ? "Примеры: нажмите на пример, чтобы изменить его, × — удалить, «Своя задача» — добавить. Ещё раз «Изменить примеры» — готово." : "", "");
                    break;
            }
        });
        ui.aiBack.addEventListener("click", function () { setAiMode("create"); });
        ui.aiStyleNew.addEventListener("click", function (e) { e.stopPropagation(); aiPop(null); onStyleFromRef(); });
        ui.aiStyleTricksBox.addEventListener("click", function (e) { var d = e.target.closest ? e.target.closest("[data-del]") : null; if (d) { e.stopPropagation(); deleteCustomStyle(d.getAttribute("data-del")); } });
        ui.planBuild.addEventListener("click", onPlanBuild);
        ui.planChange.addEventListener("click", onPlanChange);
        ui.planEdit.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onPlanChange(); } });
        ui.styleCardClose.addEventListener("click", closeStyleCard);
        ui.styleCardSave.addEventListener("click", saveStyleCard);
        if (IS_PR) { ui.aiMoreMenu.querySelector('[data-mm="expr"]').hidden = true; ui.aiMoreMenu.querySelector('[data-mm="newstyle"]').hidden = true; }
        ui.aiModes.addEventListener("click", function (e) { var b = e.target.closest ? e.target.closest(".ai-mode") : null; if (b) { setAiMode(b.getAttribute("data-m")); } });
        ui.aiExample.addEventListener("click", function (e) { e.stopPropagation(); aiPop(ui.aiExampleMenu.hidden ? ui.aiExampleMenu : null); });
        ui.aiStyleBtn.addEventListener("click", function (e) { e.stopPropagation(); aiPop(ui.aiStylePop.hidden ? ui.aiStylePop : null); });
        ui.aiExampleMenu.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest("[data-ex]") : null;
            if (!b) { return; }
            aiPop(null);
            (b.getAttribute("data-ex") === "link" ? ui.refLinkBtn : ui.refBtn).click();
        });
        document.addEventListener("mousedown", function (e) {
            if (e.target.closest && e.target.closest(".pf-pop-wrap")) { return; }
            aiPop(null);
        });
        aiLayout();
    }


    // ---- «Студия»: модель Быстро / Качественно, план по секундам, стили-паки и свой стиль из рефа.

    function planMode() { return flowOn() && !IS_PR; }

    function modelQ() {
        var p = providerOf();
        return settings[p.modelField] === p.models[1].id ? "best" : "fast";
    }
    function renderModelSeg() {
        if (!ui.aiModelSeg) { return; }
        Array.prototype.forEach.call(ui.aiModelSeg.querySelectorAll("[data-q]"), function (b) { b.setAttribute("aria-checked", b.getAttribute("data-q") === modelQ() ? "true" : "false"); });
    }
    function setModelQ(q) {
        var p = providerOf(), m = p.models[q === "best" ? 1 : 0];
        settings[p.modelField] = m.id;
        storeSettings(settings);
        renderModelSeg();
        setStatus(q === "best" ? "Модель: качественно — " + m.name + ". Умнее в моушне и стилях, но дороже и чуть дольше." : "Модель: быстро — " + m.name + ".", "");
    }

    var PLAN_PROMPT = [
        "You plan motion design for After Effects before it is built. The user describes an animation in plain words; another step will build it from your plan.",
        "First decide: is this a creative animation task that benefits from a timed plan (an intro, a title, a logo reveal, a lower third, a scene, a promo, a transition)? Or a simple command or a question (rename or organise layers, change one value, delete keys, a question about After Effects)?",
        "For a simple command or a question reply with ONLY: {\"direct\": true}",
        "Otherwise reply with ONLY this JSON, no code block, no other text; every text in the user's language:",
        "{\"total\": 5, \"steps\": [{\"from\": 0, \"to\": 1, \"what\": \"...\", \"tool\": \"...\"}]}",
        "- 2 to 7 steps covering the whole animation from 0 to total seconds, in order, no gaps. Each 'what' is one short sentence (at most 90 characters) that a non-designer understands: what appears, how it moves.",
        "- tool (optional): the main recipe of the step, one of: Плавность, Лесенка, Отскок, Шторка-маска, Текст по буквам, Текст по словам, Наезд, Падение, Удар заголовка, На двойках, Рваные края, Зерно и свечение, Дрожь. Leave it out when none fits.",
        "- Follow the motion style in the message, if there is one, and professional timing: entrances 0.4-0.9 s, text readable for at least 1.5 s, nothing static for more than about 1.5 s, a clear ending.",
        "- If the user gave no length, choose a sensible one (usually 3-10 s). If the message has reference images, plan what they show."
    ].join("\n");

    var planState = null;   // { text, content, sent, info, plan }

    function parseStepPlan(text) {
        var m = /\{[\s\S]*\}/.exec(String(text || "")), d, steps = [], i, a, b, prev = 0, total;
        if (!m) { return null; }
        try { d = JSON.parse(m[0]); } catch (e) { return null; }
        if (!d || d.direct) { return null; }
        if (!(d.steps instanceof Array) || !d.steps.length) { return null; }
        for (i = 0; i < d.steps.length && steps.length < 8; i++) {
            a = Number(d.steps[i].from); b = Number(d.steps[i].to);
            if (!isFinite(a)) { a = prev; }
            if (!isFinite(b) || b <= a) { continue; }
            steps.push({ from: Math.max(0, a), to: b, what: String(d.steps[i].what || "").replace(/\s+/g, " ").substring(0, 160), tool: String(d.steps[i].tool || "").substring(0, 30) });
            prev = b;
        }
        if (!steps.length) { return null; }
        total = Number(d.total);
        if (!isFinite(total) || total < steps[steps.length - 1].to) { total = steps[steps.length - 1].to; }
        return { total: total, steps: steps };
    }

    function secs(v) { return (Math.round(v * 10) / 10).toString().replace(".", ","); }
    function stepPlanText(plan) {
        return "Total " + plan.total + " s.\n" + plan.steps.map(function (st, i) { return (i + 1) + ") " + st.from + "-" + st.to + " s: " + st.what + (st.tool ? " [" + st.tool + "]" : ""); }).join("\n");
    }

    function hidePlan() {
        if (!ui.planCard) { return; }
        ui.planCard.hidden = true;
        ui.planEditRow.hidden = true;
        ui.planChange.textContent = "Изменить";
    }

    function showPlan() {
        var plan = planState.plan, colors = ["a", "b", "c", "d", "e", "f", "g", "h"];
        ui.planTotal.textContent = secs(plan.total) + " с";
        ui.planCount.textContent = plan.steps.length + " " + (plan.steps.length < 5 ? "шага" : "шагов");
        ui.planBar.textContent = "";
        ui.planList.textContent = "";
        plan.steps.forEach(function (st, i) {
            var seg = mkEl("i", "pb-" + colors[i]), li = mkEl("li", "pl-" + colors[i]), tm = mkEl("span", "pl-t", secs(st.from) + "–" + secs(st.to) + " с"), wh = mkEl("span", "pl-w", st.what);
            seg.style.flex = String(Math.max(0.05, st.to - st.from));
            ui.planBar.appendChild(seg);
            li.appendChild(mkEl("i", "pl-dot"));
            li.appendChild(tm);
            if (st.tool) { wh.appendChild(mkEl("em", "pl-tool", st.tool)); }
            li.appendChild(wh);
            ui.planList.appendChild(li);
        });
        ui.planEdit.value = "";
        ui.planEditRow.hidden = true;
        ui.planChange.textContent = "Изменить";
        ui.planCard.hidden = false;
        ui.planBuild.disabled = false;
        ui.planChange.disabled = false;
    }

    function withText(content, add) {
        return typeof content === "string" ? content + add : content.concat([{ type: "text", text: add }]);
    }

    // Просит план. Возвращает "plan" (план показан), "direct" (простая команда — строить сразу) или "fail".
    async function requestPlan(st, change) {
        var reply, plan, content = st.content;
        if (change) { content = withText(content, "\n\n[Previous plan]\n" + stepPlanText(st.plan) + "\n\n[What the user wants changed in the plan]\n" + change); }
        setBusy(true);
        lastError = null;
        hidePlan();
        setStatus(change ? aiName() + " переделывает план…" : aiName() + " составляет план по секундам…", "busy");
        reply = await callAI([{ role: "user", content: content }], 2048, PLAN_PROMPT);
        setBusy(false);
        if (!reply.ok) { setStatus(reply.error, "error"); if (change) { showPlan(); } return "fail"; }
        plan = parseStepPlan(reply.text);
        if (!plan) {
            if (change) { showPlan(); setStatus(aiName() + " не прислал новый план. Попробуйте сказать иначе — или нажмите «Строить».", "error"); return "fail"; }
            return "direct";
        }
        st.plan = plan;
        planState = st;
        showPlan();
        setStatus("План готов: " + secs(plan.total) + " с. Всё так — «Строить». Не так — «Изменить» и напишите, что поменять.", "done");
        return "plan";
    }

    async function onPlanBuild() {
        var st = planState, content;
        if (!st || busy) { return; }
        planState = null;
        hidePlan();
        content = withText(st.content, "\n\n[Approved plan] The user approved this timed plan. Build exactly this, with these timings and the named recipes:\n" + stepPlanText(st.plan));
        history.push({ role: "user", content: content });
        if (st.sent) { pendingRef = null; refSentNote = true; showRef(); }
        closeMention();
        trimHistory();
        beginRun(st.text);
        await askAndRun(st.text.length > 40 ? st.text.substring(0, 40) + "…" : st.text, st.sent, st.info.fileAccess);
        endRun();
    }

    async function onPlanChange() {
        var st = planState, wish;
        if (!st || busy) { return; }
        if (ui.planEditRow.hidden) {
            ui.planEditRow.hidden = false;
            ui.planChange.textContent = "Переделать план";
            ui.planEdit.focus();
            return;
        }
        wish = ui.planEdit.value.replace(/^\s+|\s+$/g, "");
        if (!wish) { ui.planEdit.focus(); setStatus("Напишите, что поменять в плане.", ""); return; }
        await requestPlan(st, wish);
    }

    // ---- стили-паки в окошке стиля: карточки, приёмы выбранного, свои стили
    function storeCustomStyles() { try { window.localStorage.setItem(STYLES_KEY, JSON.stringify(CUSTOM_STYLES)); } catch (e) {} }

    function deleteCustomStyle(id) {
        CUSTOM_STYLES = CUSTOM_STYLES.filter(function (x) { return x.id !== id; });
        storeCustomStyles();
        if (settings.motionStyle === id) { settings.motionStyle = "normal"; storeSettings(settings); }
        buildStyleChips();
        setStatus("Свой стиль удалён.", "");
    }

    var STYLE_PROMPT = [
        "You are a senior motion designer. The images are frames sampled in order from a reference video (or one picture). Measure its motion STYLE so that new, different animations can be made in the same style in After Effects. Do not describe its story or content.",
        "Reply with ONLY this JSON, no code block, no other text:",
        "{\"name\": \"short style name in the user's language (2-4 words)\", \"base\": \"collage|archival|kinetic|smooth|energetic|minimal|corporate|playful|normal\",",
        " \"rows\": {\"rhythm\": \"...\", \"appear\": \"...\", \"transitions\": \"...\", \"text\": \"...\", \"font\": \"...\"},",
        " \"palette\": [\"#hex\", \"#hex\", \"#hex\", \"#hex\"], \"tricks\": [\"...\", \"...\", \"...\"],",
        " \"rules\": \"precise rules in English for an animator, with numbers\"}",
        "- base: the closest ready style. rows (short, in Russian, at most 40 characters each, with numbers where you can): rhythm (frame rate feel: smooth 24-30 fps or stop-motion on twos, and the beat), appear (how things enter, frames, bounce %), transitions (how scenes change), text (how text animates), font (closest common font family).",
        "- palette: 3-6 main colours as hex. tricks: 3-6 signature devices, 2-4 Russian words each.",
        "- rules: 6-10 numbered rules, each concrete and measurable: durations in seconds or frames, eases (strong ease-out, no overshoot, spring %), distances in % of the frame, stagger steps, holds, colour roles (hex), typography (family, weight, case, size), textures and effects, what never happens. Mention SF recipes where they fit (SF.dropIn, SF.pushIn, SF.slam, SF.onTwos, SF.boil, SF.torn, SF.textIn, SF.wipe, SF.grain, SF.bloom, SF.bw)."
    ].join("\n");

    var styleDraft = null;

    async function onStyleFromRef() {
        var ref, reply, d, m, intro;
        if (busy) { return; }
        if (!aiKey()) { setStatus("Нужен " + providerOf().keyLabel.replace(/^Ключ/, "ключ") + ". Вставьте его в настройках.", "error"); openSettings(); return; }
        if (!pendingRef) {
            setStatus("Выберите видео или картинку — AI разберёт, в каком она стиле.", "");
            await onAttachReference();
            if (!pendingRef) { return; }
        }
        ref = pendingRef;
        setBusy(true);
        setStatus(aiName() + " разбирает стиль «" + ref.name + "» по кадрам…", "busy");
        intro = "[Style from reference] " + (ref.isStill ? "One picture \"" + ref.name + "\"." : "Frames of \"" + ref.name + "\" (" + ref.duration.toFixed(1) + " s) at " + timesOf(ref.frames) + " s.");
        reply = await callAI([{ role: "user", content: framesWithTimes(ref.frames, intro) }], 2048, STYLE_PROMPT);
        setBusy(false);
        if (!reply.ok) { setStatus(reply.error, "error"); return; }
        m = /\{[\s\S]*\}/.exec(reply.text || "");
        try { d = m ? JSON.parse(m[0]) : null; } catch (e) { d = null; }
        if (!d || !d.rules) { setStatus(aiName() + " не смог разобрать стиль. Попробуйте другой пример.", "error"); return; }
        styleDraft = {
            name: String(d.name || "Мой стиль").substring(0, 40), base: motionStyleOf(String(d.base)) && !motionStyleOf(String(d.base)).base ? String(d.base) : "normal",
            rows: d.rows && typeof d.rows === "object" ? d.rows : {}, rules: String(d.rules).substring(0, 3000), ref: ref.name,
            palette: (d.palette instanceof Array ? d.palette : []).filter(function (h) { return /^#[0-9a-f]{6}$/i.test(String(h)); }).slice(0, 6),
            tricks: (d.tricks instanceof Array ? d.tricks : []).map(function (t) { return String(t).substring(0, 30); }).slice(0, 6),
            frames: ref.isStill ? 1 : ref.frames.length, duration: ref.duration, still: ref.isStill
        };
        showStyleCard();
        setStatus("Стиль разобран. Проверьте, дайте название и нажмите «Сохранить стиль».", "done");
    }

    function showStyleCard() {
        var d = styleDraft, labels = [["rhythm", "Ритм"], ["appear", "Появление"], ["transitions", "Переходы"], ["text", "Текст"], ["font", "Шрифт"]];
        ui.styleCardRef.textContent = d.ref + (d.still ? " · картинка" : " · " + d.duration.toFixed(1) + " с · AI разобрал " + d.frames + " кадров");
        ui.styleCardPal.textContent = "";
        d.palette.forEach(function (h) { var sw = mkEl("i", "sc-sw"); sw.style.background = h; sw.title = h; ui.styleCardPal.appendChild(sw); });
        ui.styleCardRows.textContent = "";
        labels.forEach(function (l) {
            var row;
            if (!d.rows[l[0]]) { return; }
            row = mkEl("div", "sc-row");
            row.appendChild(mkEl("span", "", l[1]));
            row.appendChild(mkEl("em", "", String(d.rows[l[0]]).substring(0, 60)));
            ui.styleCardRows.appendChild(row);
        });
        ui.styleCardName.value = d.name;
        ui.styleCard.hidden = false;
    }

    function closeStyleCard() {
        ui.styleCard.hidden = true;
        styleDraft = null;
    }

    function saveStyleCard() {
        var d = styleDraft, name, st;
        if (!d) { return; }
        name = ui.styleCardName.value.replace(/^\s+|\s+$/g, "") || d.name;
        st = { id: "my-" + Date.now().toString(36), label: name.substring(0, 40), base: d.base, palette: d.palette, tricks: d.tricks, rows: d.rows,
            note: "Style pack \"" + name + "\" (the user's own, measured from their reference \"" + d.ref + "\"; follow it closely): " + d.rules +
                (d.palette.length ? " Palette: " + d.palette.join(", ") + "." : "") };
        CUSTOM_STYLES.push(st);
        storeCustomStyles();
        settings.motionStyle = st.id;
        storeSettings(settings);
        buildStyleChips();
        closeStyleCard();
        pendingRef = null;
        refSentNote = false;
        showRef();
        setStatus("Стиль «" + st.label + "» сохранён и выбран. Он в кнопке стиля под полем — для всех следующих запросов.", "done");
    }

    function flowFolded(g) {
        return String(g.st.flowFold || "").split(",").filter(function (n) { return !!FLOW_ICONS[n]; });
    }

    function setFlowFold(g, name, folded) {
        var list = flowFolded(g).filter(function (n) { return n !== name; });
        if (folded) { list.push(name); }
        g.st.flowFold = list.join(",");
        g.store();
        relayoutTools();
    }

    // Порядок блоков: сохранённый, а блоки, которых в нём нет (новые), — в конце, как по умолчанию.
    function flowSorted(g) {
        var saved = String(g.st.flowSort || "").split(",").filter(function (n, i, a) { return g.flowOrder.indexOf(n) >= 0 && a.indexOf(n) === i; });
        return saved.concat(g.flowOrder.filter(function (n) { return saved.indexOf(n) < 0; }));
    }

    // Перетаскивание: плитку — за любое место, блок — за заголовок. Двигаются только среди своих
    // (плитки среди плиток, блоки среди блоков). Короткий щелчок работает как раньше.
    function enableFlowDrag(g) {
        var drag = null;
        function cardName(card) { return card.getAttribute("data-tool"); }
        function onMove(e) {
            var over, rect, before, box;
            if (!drag) { return; }
            if (!drag.on) {
                if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) { return; }
                drag.on = true;
                drag.card.classList.add("flow-drag");
                g.el.classList.add("flow-sorting");
            }
            e.preventDefault();
            box = drag.card.parentNode;
            over = document.elementFromPoint(e.clientX, e.clientY);
            over = over && over.closest ? over.closest(".tool-card") : null;
            if (!over || over === drag.card || over.parentNode !== box) { return; }
            rect = over.getBoundingClientRect();
            before = drag.tile ? (e.clientY < rect.top || (e.clientY <= rect.bottom && e.clientX < rect.left + rect.width / 2))
                : e.clientY < rect.top + rect.height / 2;
            box.insertBefore(drag.card, before ? over : over.nextSibling);
        }
        function onUp() {
            var d = drag, names;
            drag = null;
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("mouseup", onUp, true);
            if (!d || !d.on) { return; }
            d.card.classList.remove("flow-drag");
            g.el.classList.remove("flow-sorting");
            names = Array.prototype.map.call(g.flowBox.tiles.querySelectorAll(".tool-card"), cardName)
                .concat(Array.prototype.map.call(g.flowBox.cols.querySelectorAll(".tool-card"), cardName));
            g.st.flowSort = names.join(",");
            g.store();
            // Отпустили — это не щелчок: плитка не срабатывает, блок не сворачивается.
            function eat(e) { e.stopPropagation(); e.preventDefault(); }
            document.addEventListener("click", eat, true);
            setTimeout(function () { document.removeEventListener("click", eat, true); }, 0);
        }
        // Mouse events, not pointer events: pointer events pass the browser tests but do not fire in After Effects.
        g.el.addEventListener("mousedown", function (e) {
            var card, tile;
            if (!g.flow || e.button !== 0 || !e.target.closest) { return; }
            card = e.target.closest(".tool-card");
            if (!card || !g.flowBox || (card.parentNode !== g.flowBox.tiles && card.parentNode !== g.flowBox.cols)) { return; }
            tile = card.parentNode === g.flowBox.tiles;
            if (!tile && (!e.target.closest(".tool-head") || e.target.closest(".flow-fold"))) { return; }
            e.preventDefault();
            drag = { card: card, tile: tile, x: e.clientX, y: e.clientY, on: false };
            document.addEventListener("mousemove", onMove, true);
            document.addEventListener("mouseup", onUp, true);
        });
    }

    function buildFlow(g) {
        var box = {};
        [["tilesCap", "small", "flow-cap", "В один клик"], ["tiles", "div", "flow-tiles", ""], ["colsCap", "small", "flow-cap", "С настройками"], ["cols", "div", "flow-cols", ""]].forEach(function (d) {
            var el = document.createElement(d[1]);
            el.className = "flow-part " + d[2];
            el.textContent = d[3];
            g.el.appendChild(el);
            box[d[0]] = el;
        });
        g.flowOrder.filter(function (n) { return !!FLOW_TILES[n]; }).forEach(function (name) {
            var card = cardByName(name), btn = card && card.querySelector(".paste-do");
            if (!btn) { return; }
            btn.setAttribute("data-short", FLOW_TILES[name]);
            // Плитка нажимается целиком, не только кнопка в ней.
            card.addEventListener("click", function (e) {
                if (g.flow && !btn.contains(e.target) && !btn.disabled) { btn.click(); }
            });
        });
        g.flowOrder.filter(function (n) { return !!FLOW_ICONS[n]; }).forEach(function (name) {
            var card = cardByName(name), head = card && card.querySelector(".tool-head"), b;
            if (!head) { return; }
            head.insertAdjacentHTML("afterbegin", '<span class="flow-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + FLOW_ICONS[name] + "</svg></span>");
            b = document.createElement("button");
            b.type = "button";
            b.className = "flow-fold";
            b.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';
            b.addEventListener("click", function (e) { e.stopPropagation(); setFlowFold(g, name, !card.classList.contains("flow-folded")); });
            head.addEventListener("click", function () { if (g.flow) { setFlowFold(g, name, !card.classList.contains("flow-folded")); } });
            card.appendChild(b);
        });
        g.flowBox = box;
        enableFlowDrag(g);
    }

    function drawAnchorOpts() {
        Array.prototype.forEach.call(document.querySelectorAll("#anchorOpts button[data-v]"), function (b) {
            b.setAttribute("aria-pressed", b.getAttribute("data-v") === motion.anchorKeys ? "true" : "false");
        });
    }
    var FLOW_COL = 280, FLOW_GAP = 12;
    function layoutFlow(g) {
        var folded = flowFolded(g), n;
        var k = Number(document.documentElement.getAttribute("data-tools")) / 100;
        var w = g.el.clientWidth, tiles = 0, sets = 0;
        if (!g.flowBox) { buildFlow(g); }
        if (!g.flow) {
            g.flow = true;
            g.el.classList.add("tool-flow");
            if (arranging) { setArranging(false); }
        }
        if (!(k > 0 && k <= 1)) { k = 1; }
        g.el.style.gridTemplateColumns = "";
        g.el.style.gridAutoRows = "";
        g.el.style.gap = "";
        g.line.hidden = true;
        flowSorted(g).forEach(function (name) {
            var card = cardByName(name), off, isTile, f;
            if (!card) { return; }
            off = toolsHidden.indexOf(name) >= 0;
            isTile = !!FLOW_TILES[name];
            card.classList.toggle("tool-off", off);
            card.removeAttribute("data-icons");
            card.style.setProperty("--kz", String(k));
            (isTile ? g.flowBox.tiles : g.flowBox.cols).appendChild(card);
            if (isTile) { if (!off) { tiles++; } return; }
            if (!off) { sets++; }
            f = folded.indexOf(name) >= 0;
            card.classList.toggle("flow-folded", f);
            card.querySelector(".flow-fold").setAttribute("aria-expanded", f ? "false" : "true");
            card.querySelector(".flow-fold").title = f ? "Развернуть" : "Свернуть";
        });
        g.flowBox.tilesCap.hidden = g.flowBox.tiles.hidden = !tiles;
        g.flowBox.colsCap.hidden = g.flowBox.cols.hidden = !sets;
        // Блоки узкие (280 px) и не тянутся за панелью: сколько влезает, столько колонок.
        n = w >= 2 * FLOW_COL + FLOW_GAP ? Math.floor((w + FLOW_GAP) / (FLOW_COL + FLOW_GAP)) : 1;
        g.flowBox.cols.setAttribute("data-cols", String(n));
        g.flowBox.cols.style.columnCount = n > 1 ? String(n) : "";
        g.flowBox.cols.style.width = n > 1 ? (n * FLOW_COL + (n - 1) * FLOW_GAP) + "px" : "";
        g.flowBox.tiles.setAttribute("data-wide", w >= 980 ? "true" : "false");
        showFoldParts();
        showEcFold();
    }

    // Обратно к сетке (дизайн сменили на другой): блоки снова прямо в разделе, сетка их расставит.
    function unflow(g) {
        if (!g.flow) { return; }
        g.flow = false;
        g.el.classList.remove("tool-flow");
        Array.prototype.forEach.call(g.el.querySelectorAll(".tool-card"), function (card) {
            card.classList.remove("flow-folded");
            g.el.appendChild(card);
        });
        showFoldParts();
        showEcFold();
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
                // Спрятанный блок помнит своё место: вернётся туда же.
                else if (toolsHidden.indexOf(G.names[i]) >= 0 && placesNow() && placesNow()[G.names[i]]) { places[G.names[i]] = placesNow()[G.names[i]]; }
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
            if (g.flow) { return; }
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
            if (g.flow) { return; }
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
            if (g.flow) { return; }
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
            if (g.flow) { return; }
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
            if (g.flow) { return; }
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
    var SHAPE_DEFAULTS = { order: "", sizes: "", places: "", pins: "", grid: GRID_VERSION, flowFold: "", flowSort: "", pfKeep: false, pfLast: "unite" };

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
            ui.ecClip.setAttribute("data-short", "Буфер пуст");
            ui.ecClip.title = ui.ecClip.textContent;
            ui.ecClip.classList.remove("has");
            return;
        }
        n = 0;
        names = [];
        ecClip.groups.forEach(function (g) { n += g.keys.length; if (names.indexOf(g.name) < 0) { names.push(g.name); } });
        ui.ecClip.textContent = "В буфере: " + plural(n, "ключ", "ключа", "ключей") + " · " + names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
        ui.ecClip.setAttribute("data-short", plural(n, "ключ", "ключа", "ключей") + " · " + names[0] + (names.length > 1 ? " +" + (names.length - 1) : ""));
        ui.ecClip.title = ui.ecClip.textContent;
        ui.ecClip.classList.add("has");
    }

    function showEcFold() {
        var open = motion.ecOpts !== false || ui.motionTools.classList.contains("tool-flow"), label = open ? "Скрыть настройку" : "Показать настройку";
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
                (IS_PR ? " клипа «" + res.clip + "». Выделите другие клипы и нажмите «Вставить значения» (те же ключи) или «Плавность» (те же места ключей)." :
                ". Выделите другие ключи и нажмите «Вставить плавность» или «Вставить значения»."), "done");
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
            if (IS_PR) {
                setStatus((mode === "value" ? "Ключи вставлены: " : "Места ключей вставлены: ") + plural(res.keys, "ключ", "ключа", "ключей") + " на " +
                    plural(res.clips, "клип", "клипа", "клипов") + ". Видно в Effect Controls.", "done");
                return;
            }
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
        var sg = { name: "shape", flowOrder: FLOW_SHAPE_ORDER, el: ui.shapeTools, cells: ui.shapeGridCells, line: ui.shapePinLine, names: SHAPE_TOOL_NAMES, st: shape, store: storeShape, defOrder: SHAPE_DEFAULTS.order, last: null };
        GRIDS.push(sg);
        enableToolReordering(sg);
        enableToolResizing(sg);
        enablePins(sg);
        watchToolGrid(sg);
        if (!PF_MODES[shape.pfLast]) { shape.pfLast = "unite"; }
        enablePathfinder();
        enableTextBox();
        enableGlass();
        enablePhone();
        enableRibbon();
        enableMk();
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
        var mg = { name: "motion", flowOrder: FLOW_ORDER, el: ui.motionTools, cells: ui.gridCells, line: ui.pinLine, names: TOOL_NAMES, st: motion, store: storeMotion, defOrder: MOTION_DEFAULTS.order,
            defPlaces: MOTION_DEFAULTS.places, defSizes: MOTION_DEFAULTS.sizes, defPins: MOTION_DEFAULTS.pins, last: null };
        GRIDS.push(mg);
        G = mg;
        enableToolReordering(mg);
        enableToolResizing(mg);
        ui.anchorKeys.value = motion.anchorKeys;
        drawEase();
        Array.prototype.forEach.call(ui.easeView.querySelectorAll("button[data-v]"), function (b) {
            b.addEventListener("click", function () { motion.easeView = b.getAttribute("data-v") === "value" ? "value" : "speed"; storeMotion(); drawEase(); });
        });
        setInterval(pollEaseState, 1000);
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
            drawAnchorOpts();
        });
        // «Студия»: вместо списка три кнопки рядом с сеткой. Они просто меняют тот же список.
        Array.prototype.forEach.call(document.querySelectorAll("#anchorOpts button[data-v]"), function (b) {
            b.addEventListener("click", function () {
                ui.anchorKeys.value = b.getAttribute("data-v");
                ui.anchorKeys.dispatchEvent(new Event("change"));
            });
        });
        drawAnchorOpts();
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
            // Premiere: у его расширения свой manifest.xml — это manifest-pr.xml из выпуска. Манифест After Effects не нужен.
            if (IS_PR && f.path === "CSXS/manifest.xml") { continue; }
            plan.push({
                url: httpsUrl(f.path + "?v=" + String(f.sha256).slice(0, 12), base),
                sha: String(f.sha256).toLowerCase(),
                tmp: platform.join(tmp, "file" + i),
                bak: platform.join(tmp, "old" + i),
                dest: platform.join.apply(null, [ext].concat((IS_PR && f.path === "CSXS/manifest-pr.xml" ? "CSXS/manifest.xml" : f.path).split("/"))),
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
            return evalScript("$.evalFile(" + asciiJSON(ext + HOST_JSX) + "); 1").catch(function () {});
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
    buildToolPicker();
    showRef();
    setupPremiere();
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
    ui.splitBtn.addEventListener("click", onSplitMerge);
    ui.unusedBtn.addEventListener("click", onRemoveUnused);
    ui.cutoutBtn.addEventListener("click", onCutout);
    enableCutout();
    initBrand();
    ui.fxBtn.addEventListener("click", openFxConsole);
    ui.fxClose.addEventListener("click", closeFxConsole);
    ui.fxSnap.addEventListener("click", onSnapshot);
    ui.snapBtn.addEventListener("click", onSnapshot);
    enableSnapBar();
    enableExport();
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
    Array.prototype.forEach.call(ui.setTabs.querySelectorAll("button[data-pane]"), function (b) {
        b.addEventListener("click", function () { showSetPane(b.getAttribute("data-pane")); });
    });
    window.addEventListener("resize", fitSettings);
    document.addEventListener("keydown", onHotkeyDown, true);
    enableAc();
    enableOrbit();
    enableGrid();
    enableMkFolds();
    listenHostHotkeys();
    fitTabs();
    if (typeof window.ResizeObserver === "function") { new window.ResizeObserver(fitTabs).observe(ui.tabs); }
    if (document.fonts && document.fonts.ready) { document.fonts.ready.then(fitTabs); }
    registerHotkeys();
    window.addEventListener("unload", stopKeyWatch);
    hotkeyHint();
    ui.settingsBtn.addEventListener("click", openSettings);
    ui.settingsClose.addEventListener("click", function () { closeSettings(); });
    ui.sheet.addEventListener("click", function () { scheduleCommit(0); });
    ui.sheet.addEventListener("change", function () { scheduleCommit(0); });
    ui.sheet.addEventListener("input", function () { scheduleCommit(400); });
    ui.testKey.addEventListener("click", onTestKey);
    ui.updateNow.addEventListener("click", onUpdateNow);
    ui.updateLater.addEventListener("click", onUpdateLater);
    ui.updateDownload.addEventListener("click", onOpenDownload);
    ui.checkUpdate.addEventListener("click", onCheckUpdate);
    ui.versionText.textContent = "Sayframe " + VERSION;
    document.addEventListener("paste", onPasteEvent);
    initMotionStyles();
    initAiModes();
    ui.prompt.addEventListener("keydown", function (e) {
        // Cmd/Ctrl+Enter запускает задачу.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onRun(); }
    });

    if (!aiKey() && !SOLO) {
        setStatus("Сначала откройте настройки (значок шестерёнки) и вставьте " + providerOf().keyLabel.replace(/^Ключ/, "ключ") + ".", "");
    }
    buildWindowPicker();
    if (SOLO) {
        startSolo();
    } else {
        addWindowButtons();
        announceUpdate();
        syncWindowsManifest().catch(function () {});
    }
    ensureHost().catch(function (e) { setStatus(humanError(e), "error"); });
    // Настройки и Проекты из другой программы (After Effects ↔ Premiere Pro): новее — перезапускаемся с ними.
    readShared().then(function (fresh) {
        if (fresh && platform.reload) { platform.reload(); return; }
        setTimeout(function () { offerPremiere().catch(function () {}); }, 2500);
    });
    // Обе программы открыты сразу: вернулись в панель — подхватываем то, что поменяли в другой.
    // Проекты обновляются на месте; настройки (ключ, тема) — перезапуском панели.
    if (!SOLO) {
        window.addEventListener("focus", function () {
            if (!sharedRead || busy) { return; }
            readShared().then(function (changed) {
                if (!changed) { return; }
                if (changed.indexOf(SETTINGS_KEY) >= 0 && platform.reload) { platform.reload(); return; }
                brands = loadBrands();
                renderBrand();
            });
        });
    }
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
    if (!SOLO) { setTimeout(backgroundUpdateCheck, 1200); }

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
    // Отдельные окна не проверяют обновления и не шлют статистику: это делает большой Sayframe.
    if (!SOLO) {
        setTimeout(statsPing, 4000);
        setInterval(backgroundUpdateCheck, UPDATE_CHECK_EVERY_MS);
        window.addEventListener("focus", backgroundUpdateCheck);
    }
})();
