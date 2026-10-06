#!/usr/bin/env python3
"""Готовит выпуск Sayframe.

  python3 tools/release.py 1.2.0 "Что нового, первая строка" "Вторая строка"
      Ставит новый номер версии во все файлы, собирает установщики в downloads/
      и записывает version.json. После этого остаётся закоммитить и запушить.

  python3 tools/release.py --build
      Пересобирает установщики и version.json для текущей версии (номер и описание не меняются).

  python3 tools/release.py --check
      Ничего не меняет. Проверяет, что номера версий совпадают, а version.json и установщики
      соответствуют файлам панели. Код выхода 1, если что-то разошлось.

Как пользователи получают обновление: панель читает version.json из репозитория
(адрес собирается из tools/config.json). Если там версия новее установленной, панель
показывает плашку и по кнопке скачивает файлы из папки Sayframe/, сверяя sha256.
"""
import hashlib
import io
import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "Sayframe"
PANEL_JS = EXT / "js" / "panel.js"
MANIFEST = EXT / "CSXS" / "manifest.xml"
PLIST = ROOT / "installer" / "mac" / "Info.plist"
VERSION_JSON = ROOT / "version.json"
MAC_ZIP = ROOT / "downloads" / "Install-Sayframe-Mac.zip"
WIN_ZIP = ROOT / "downloads" / "Sayframe-Windows.zip"
WIN_EXE = ROOT / "downloads" / "Install-Sayframe-Windows.exe"
WIN_STUB = ROOT / "installer" / "windows" / "stub.exe"  # собирается tools/build-windows-stub.sh
SKIP = {".DS_Store", "Thumbs.db", "desktop.ini"}

VERSION_RE = re.compile(r'(var VERSION = ")(\d+\.\d+\.\d+)(";)')
URL_RE = re.compile(r'(__SAYFRAME_TEST_UPDATE_URL__ : ")([^"]*)(";)')
BUNDLE_RE = re.compile(r'(ExtensionBundleVersion=")(\d+\.\d+\.\d+)(")')
EXT_RE = re.compile(r'(<Extension Id="com\.sayframe\.ae\.panel" Version=")(\d+\.\d+\.\d+)(")')
PLIST_RE = re.compile(r'(<key>CFBundleShortVersionString</key>\s*<string>)(\d+\.\d+\.\d+)(</string>)')


def fail(msg):
    print("ОШИБКА: " + msg)
    sys.exit(1)


def read(p):
    return p.read_bytes().decode("utf-8")


def write(p, text):
    p.write_bytes(text.encode("utf-8"))  # без преобразования переводов строк


def parse(v):
    if not re.fullmatch(r"\d+\.\d+\.\d+", v):
        fail("номер версии должен выглядеть как 1.2.0, получено: " + v)
    return tuple(int(x) for x in v.split("."))


def config():
    c = json.loads(read(ROOT / "tools" / "config.json"))
    for k in ("owner", "repo", "branch"):
        if not re.fullmatch(r"[A-Za-z0-9._-]+", c.get(k, "")):
            fail("tools/config.json: поле %s пустое или содержит лишние символы" % k)
    return c


def update_url(c):
    return "https://raw.githubusercontent.com/%s/%s/%s/version.json" % (c["owner"], c["repo"], c["branch"])


def one(regex, text, where):
    found = regex.findall(text)
    if len(found) != 1:
        fail("%s: ожидалась ровно одна строка с %s, найдено %d" % (where, regex.pattern, len(found)))
    return found[0][1]


def current_versions():
    return {
        "Sayframe/js/panel.js": one(VERSION_RE, read(PANEL_JS), "panel.js"),
        "Sayframe/CSXS/manifest.xml (ExtensionBundleVersion)": one(BUNDLE_RE, read(MANIFEST), "manifest.xml"),
        "Sayframe/CSXS/manifest.xml (Extension)": one(EXT_RE, read(MANIFEST), "manifest.xml"),
        "installer/mac/Info.plist": one(PLIST_RE, read(PLIST), "Info.plist"),
    }


def set_everywhere(version, url):
    t = read(PANEL_JS)
    one(VERSION_RE, t, "panel.js"); one(URL_RE, t, "panel.js")
    t = VERSION_RE.sub(lambda m: m.group(1) + version + m.group(3), t)
    t = URL_RE.sub(lambda m: m.group(1) + url + m.group(3), t)
    write(PANEL_JS, t)
    t = read(MANIFEST)
    t = BUNDLE_RE.sub(lambda m: m.group(1) + version + m.group(3), t)
    t = EXT_RE.sub(lambda m: m.group(1) + version + m.group(3), t)
    write(MANIFEST, t)
    write(PLIST, PLIST_RE.sub(lambda m: m.group(1) + version + m.group(3), read(PLIST)))


def panel_files():
    out = []
    for p in sorted(EXT.rglob("*")):
        if p.is_symlink():
            fail("в папке панели не должно быть ссылок: %s" % p)
        if p.is_file() and p.name not in SKIP:
            rel = p.relative_to(EXT).as_posix()
            if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*", rel):
                fail("имя файла панели содержит пробел, кириллицу или спецсимвол: " + rel)
            out.append((rel, p.read_bytes()))
    if not any(rel == "CSXS/manifest.xml" for rel, _ in out):
        fail("нет Sayframe/CSXS/manifest.xml")
    return out


def make_zip(entries, stamp, prefix=b""):
    """entries: [(имя, байты, права)]. Одинаковый вход даёт одинаковый архив.

    prefix — байты перед архивом (программа-установщик для Windows): архив приписывается
    к ней, и смещения внутри него считаются от начала всего файла.
    """
    buf = io.BytesIO()
    buf.write(prefix)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        dirs = set()
        for name, data, mode in entries:
            parts = name.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                d = "/".join(parts[:i]) + "/"
                if d not in dirs:
                    dirs.add(d)
                    zi = zipfile.ZipInfo(d, stamp)
                    zi.create_system = 3
                    zi.external_attr = (0o40755 << 16) | 0x10
                    z.writestr(zi, b"")
            zi = zipfile.ZipInfo(name, stamp)
            zi.create_system = 3
            zi.external_attr = (0o100000 | mode) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data)
    return buf.getvalue()


def build_mac(files, stamp):
    app = "Install Sayframe.app/Contents/"
    mac = ROOT / "installer" / "mac"
    entries = [
        (app + "Info.plist", (mac / "Info.plist").read_bytes(), 0o644),
        (app + "PkgInfo", b"APPL????", 0o644),
        (app + "MacOS/install-sayframe", (mac / "install-sayframe").read_bytes(), 0o755),
        (app + "Resources/AppIcon.icns", (mac / "AppIcon.icns").read_bytes(), 0o644),
    ]
    entries += [(app + "Resources/Sayframe/" + rel, data, 0o644) for rel, data in files]
    return make_zip(entries, stamp)


def build_win(files, stamp):
    win = ROOT / "installer" / "windows"
    top = "Sayframe-Windows/"
    entries = [
        (top + "Install-Windows.bat", (win / "Install-Windows.bat").read_bytes(), 0o644),
        (top + "README.txt", (win / "README.txt").read_bytes(), 0o644),
    ]
    entries += [(top + "Sayframe/" + rel, data, 0o644) for rel, data in files]
    return make_zip(entries, stamp)


def build_win_exe(files, stamp):
    """Один файл для Windows: программа-установщик, к которой приписан архив с панелью."""
    stub = WIN_STUB.read_bytes()
    if stub[:2] != b"MZ":
        fail("installer/windows/stub.exe не похож на программу Windows")
    return make_zip([("Sayframe/" + rel, data, 0o644) for rel, data in files], stamp, prefix=stub)


def info_for(version, day, notes, c):
    files = panel_files()
    return files, {
        "version": version,
        "date": day,
        "notes": notes,
        "download": "https://github.com/%s/%s#readme" % (c["owner"], c["repo"]),
        "moved": "",
        "base": "Sayframe/",
        "files": [{"path": rel, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)} for rel, data in files],
    }


def dump(info):
    return json.dumps(info, ensure_ascii=False, indent=2) + "\n"


def stamp_of(day):
    y, m, d = (int(x) for x in day.split("-"))
    return (y, m, d, 12, 0, 0)


def build(version, day, notes, c):
    set_everywhere(version, update_url(c))
    files, info = info_for(version, day, notes, c)
    MAC_ZIP.parent.mkdir(exist_ok=True)
    MAC_ZIP.write_bytes(build_mac(files, stamp_of(day)))
    WIN_ZIP.write_bytes(build_win(files, stamp_of(day)))
    WIN_EXE.write_bytes(build_win_exe(files, stamp_of(day)))
    write(VERSION_JSON, dump(info))
    return info


def check(c):
    problems = []
    versions = current_versions()
    info = json.loads(read(VERSION_JSON)) if VERSION_JSON.exists() else None
    if info is None:
        problems.append("нет version.json — запустите tools/release.py с номером версии")
    else:
        versions["version.json"] = info.get("version", "?")
    if len(set(versions.values())) != 1:
        problems.append("номера версий расходятся: " + ", ".join("%s = %s" % kv for kv in versions.items()))
    url = one(URL_RE, read(PANEL_JS), "panel.js")
    if url != update_url(c):
        problems.append("адрес обновлений в panel.js (%s) не совпадает с tools/config.json (%s)" % (url or "пусто", update_url(c)))
    if info is not None and len(set(versions.values())) == 1:
        files, fresh = info_for(info["version"], info.get("date", ""), info.get("notes", []), c)
        if fresh["files"] != info.get("files"):
            changed = sorted({f["path"] for f in fresh["files"] if f not in info.get("files", [])} |
                             {f["path"] for f in info.get("files", []) if f not in fresh["files"]})
            problems.append("файлы панели изменились после выпуска (%s) — нужен новый выпуск с новым номером версии" % ", ".join(changed))
        else:
            try:
                st = stamp_of(info["date"])
                if not MAC_ZIP.exists() or MAC_ZIP.read_bytes() != build_mac(files, st):
                    problems.append("downloads/Install-Sayframe-Mac.zip не соответствует текущим файлам — запустите --build")
                if not WIN_ZIP.exists() or WIN_ZIP.read_bytes() != build_win(files, st):
                    problems.append("downloads/Sayframe-Windows.zip не соответствует текущим файлам — запустите --build")
                if not WIN_EXE.exists() or WIN_EXE.read_bytes() != build_win_exe(files, st):
                    problems.append("downloads/Install-Sayframe-Windows.exe не соответствует текущим файлам — запустите --build")
            except (KeyError, ValueError):
                problems.append("в version.json нет правильной даты")
    return problems


def main(argv):
    c = config()
    if argv == ["--check"]:
        problems = check(c)
        for p in problems:
            print("НЕ В ПОРЯДКЕ: " + p)
        if problems:
            sys.exit(1)
        print("Всё в порядке: версия %s, адрес обновлений %s" % (one(VERSION_RE, read(PANEL_JS), "panel.js"), update_url(c)))
        return
    if argv == ["--build"]:
        if not VERSION_JSON.exists():
            fail("нет version.json — первый раз запустите с номером версии и описанием")
        old = json.loads(read(VERSION_JSON))
        info = build(old["version"], old["date"], old["notes"], c)
    else:
        if len(argv) < 2 or argv[0].startswith("-"):
            print(__doc__)
            sys.exit(2)
        version, notes = argv[0], [n.strip() for n in argv[1:] if n.strip()]
        new = parse(version)
        if not notes:
            fail("добавьте хотя бы одну строку «что нового»")
        if VERSION_JSON.exists():
            released = json.loads(read(VERSION_JSON))["version"]
            if new <= parse(released):
                fail("новая версия %s должна быть больше выпущенной %s" % (version, released))
        info = build(version, date.today().isoformat(), notes, c)
    problems = check(c)
    if problems:
        fail("после сборки проверка не прошла: " + "; ".join(problems))
    print("Готов выпуск %s (%d файлов панели)." % (info["version"], len(info["files"])))
    print("Пользователи увидят его после: git add -A && git commit -m \"Sayframe %s\" && git push" % info["version"])


if __name__ == "__main__":
    main(sys.argv[1:])
