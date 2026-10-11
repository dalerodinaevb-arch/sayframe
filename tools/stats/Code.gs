/**
 * Sayframe — счётчик установок и уведомления в Telegram.
 *
 * Работает внутри Google-таблицы (Расширения → Apps Script). Панель Sayframe один раз
 * после установки присылает сюда анонимный сигнал «install», а потом не чаще раза в день — «day».
 * В сигнале только случайный номер установки, версия Sayframe, система и версия After Effects.
 *
 * Токен бота хранится в «Свойствах скрипта» (Настройки проекта → Свойства скрипта → TG_TOKEN),
 * а не в коде и не в панели: его никто, кроме вас, не видит.
 */

var SHEET_INSTALLS = "Установки";
var SHEET_DAYS = "Запуски";
var MAX_MESSAGES_PER_HOUR = 30;   // защита от спама: больше сообщений в час бот не пришлёт
var MAX_ROWS_PER_HOUR = 300;      // и больше строк в час таблица не примет

// ---------- приём сигналов от панели ----------

function doPost(e) {
  var out = ContentService.createTextOutput("ok");
  try {
    var d = JSON.parse(e.postData.contents);
    var id = String(d.id || "");
    if (!/^[0-9a-f]{32}$/.test(id)) { return out; }
    var info = { v: clip(d.v, 16), os: clip(d.os, 12), ae: clip(d.ae, 16) };
    if (!allow("rows", MAX_ROWS_PER_HOUR)) { return out; }
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (d.ev === "install") { onInstall(id, info); }
      onDay(id, info);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
  }
  return out;
}

function doGet() {
  return ContentService.createTextOutput("Sayframe stats: работает");
}

function onInstall(id, info) {
  var sh = sheet(SHEET_INSTALLS, ["Дата", "ID установки", "Версия", "Система", "After Effects"]);
  if (sh.getLastRow() > 1 && sh.getRange(2, 2, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext()) {
    return; // эта установка уже записана
  }
  sh.appendRow([new Date(), id, info.v, info.os, info.ae]);
  var n = sh.getLastRow() - 1;
  if (allow("tg", MAX_MESSAGES_PER_HOUR)) {
    telegram("🎉 Новая установка Sayframe №" + n + "\n" + [info.os, info.ae ? "AE " + info.ae : "", info.v ? "v" + info.v : ""].filter(String).join(" · "));
  }
}

function onDay(id, info) {
  var sh = sheet(SHEET_DAYS, ["Дата", "ID установки", "Версия", "Система", "After Effects", "Ключ"]);
  var key = today() + "|" + id;
  if (sh.getLastRow() > 1 && sh.getRange(2, 6, sh.getLastRow() - 1, 1).createTextFinder(key).matchEntireCell(true).findNext()) {
    return; // сегодня эта установка уже открывала панель
  }
  sh.appendRow([new Date(), id, info.v, info.os, info.ae, key]);
}

// ---------- ежедневная сводка ----------

function dailyReport() {
  var y = new Date(Date.now() - 24 * 3600 * 1000);
  var day = Utilities.formatDate(y, Session.getScriptTimeZone(), "yyyy-MM-dd");
  var inst = sheet(SHEET_INSTALLS, ["Дата", "ID установки", "Версия", "Система", "After Effects"]);
  var days = sheet(SHEET_DAYS, ["Дата", "ID установки", "Версия", "Система", "After Effects", "Ключ"]);
  var total = Math.max(0, inst.getLastRow() - 1);
  var newOnes = countDay(inst, day), active = countDay(days, day);
  telegram("📊 Sayframe за " + Utilities.formatDate(y, Session.getScriptTimeZone(), "dd.MM") +
    "\nОткрывали панель: " + active + "\nНовых установок: " + newOnes + "\nВсего установок: " + total);
}

function countDay(sh, day) {
  if (sh.getLastRow() < 2) { return 0; }
  var tz = Session.getScriptTimeZone();
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().filter(function (r) {
    return r[0] instanceof Date && Utilities.formatDate(r[0], tz, "yyyy-MM-dd") === day;
  }).length;
}

// ---------- настройка: запустите один раз ----------

function setup() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("TG_TOKEN");
  if (!token) {
    throw new Error("Сначала добавьте TG_TOKEN: Настройки проекта (шестерёнка слева) → Свойства скрипта → Добавить свойство.");
  }
  var r = JSON.parse(UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/getUpdates", { muteHttpExceptions: true }).getContentText());
  if (!r.ok) { throw new Error("Telegram не принял токен. Проверьте TG_TOKEN."); }
  var chat = null;
  r.result.forEach(function (u) { var m = u.message || u.channel_post; if (m && m.chat) { chat = m.chat.id; } });
  if (!chat) { throw new Error("Откройте своего бота в Telegram, нажмите «Старт» (или напишите ему любое сообщение) и запустите setup ещё раз."); }
  props.setProperty("TG_CHAT", String(chat));
  sheet(SHEET_INSTALLS, ["Дата", "ID установки", "Версия", "Система", "After Effects"]);
  sheet(SHEET_DAYS, ["Дата", "ID установки", "Версия", "Система", "After Effects", "Ключ"]);
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "dailyReport"; });
  if (!has) { ScriptApp.newTrigger("dailyReport").timeBased().everyDays(1).atHour(9).create(); }
  telegram("✅ Sayframe подключён. Сюда будут приходить новые установки и сводка каждое утро.");
}

// ---------- помощники ----------

function telegram(text) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("TG_TOKEN"), chat = props.getProperty("TG_CHAT");
  if (!token || !chat) { return; }
  UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "post", payload: { chat_id: chat, text: text }, muteHttpExceptions: true
  });
}

function sheet(name, head) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight("bold");
  }
  return sh;
}

function allow(what, max) {
  var c = CacheService.getScriptCache(), k = what + Utilities.formatDate(new Date(), "UTC", "yyyyMMddHH");
  var n = Number(c.get(k) || 0);
  if (n >= max) { return false; }
  c.put(k, String(n + 1), 3700);
  return true;
}

function today() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"); }
function clip(s, n) { return String(s == null ? "" : s).replace(/[^\w .\-]/g, "").slice(0, n); }
