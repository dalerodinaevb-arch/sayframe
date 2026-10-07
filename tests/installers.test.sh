#!/bin/bash
# Проверяет установщики настолько, насколько это возможно без Mac и Windows:
#   - общую логику установки (go test), сборку под Windows и под Mac (Apple-чип и Intel);
#   - что готовые файлы в downloads/ собраны из этих исходников и несут текущую панель;
#   - полный сценарий на копии той же программы, собранной для этой системы;
#   - запасной скрипт install.sh в песочнице (curl, defaults и xattr заменены заглушками).
# Окна macOS и Windows, реестр Windows и запуск на настоящей системе здесь не выполняются. Нужен Go.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/installer/src"
EXE="$ROOT/downloads/Install-Sayframe-Windows.exe"
MACZIP="$ROOT/downloads/Install-Sayframe-Mac.zip"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; failc=0
ok(){ if eval "$2"; then pass=$((pass+1)); echo "  ok   $1"; else failc=$((failc+1)); echo "  FAIL $1"; fi; }
if ! command -v go >/dev/null 2>&1; then echo "Go не найден — проверка установщиков пропущена"; exit 0; fi

cd "$SRC" || exit 2
ok "code is formatted" '[ -z "$(gofmt -l .)" ]'
go vet ./... >"$T/vet1" 2>&1; ok "go vet (this system)" '[ $? = 0 ]'
GOOS=windows GOARCH=amd64 go vet ./... >"$T/vet2" 2>&1; ok "go vet (Windows)" '[ $? = 0 ]'
GOOS=darwin GOARCH=arm64 go vet ./... >"$T/vet3" 2>&1; ok "go vet (Mac, Apple chip)" '[ $? = 0 ]'
GOOS=darwin GOARCH=amd64 go vet ./... >"$T/vet4" 2>&1; ok "go vet (Mac, Intel)" '[ $? = 0 ]'
SAYFRAME_REAL_EXE="$EXE" SAYFRAME_PANEL_DIR="$ROOT/Sayframe" go test -count=1 -v ./... >"$T/test" 2>&1
ok "go test, including the released Windows installer" '[ $? = 0 ] && grep -q "^--- PASS: TestReleasedInstallerCarriesThePanel" "$T/test" && grep -q "^--- PASS: TestMacInstallFromFolder" "$T/test" && ! grep -q "^--- SKIP" "$T/test"'
[ $failc = 0 ] || tail -30 "$T/test"

# ---- the programs committed to the project are built from this source
FLAGS=(-trimpath -buildvcs=false)
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build "${FLAGS[@]}" -ldflags "-H=windowsgui -s -w -buildid=" -o "$T/stub.exe" . 2>"$T/build"
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build "${FLAGS[@]}" -ldflags "-s -w -buildid=" -o "$T/arm64" . 2>>"$T/build"
GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build "${FLAGS[@]}" -ldflags "-s -w -buildid=" -o "$T/x86_64" . 2>>"$T/build"
ok "builds for Windows and for both kinds of Mac" '[ -s "$T/stub.exe" ] && [ -s "$T/arm64" ] && [ -s "$T/x86_64" ]'
python3 "$ROOT/tools/make_universal.py" "$T/arm64" "$T/x86_64" "$T/launcher" 2>>"$T/build"
ok "Mac launcher is a universal program" 'file "$T/launcher" | grep -q "universal binary with 2 architectures" && file "$T/launcher" | grep -q arm64 && file "$T/launcher" | grep -q x86_64'
if cmp -s "$T/stub.exe" "$ROOT/installer/windows/stub.exe" && cmp -s "$T/launcher" "$ROOT/installer/mac/launcher"; then
  ok "stub.exe and launcher in the project are built from this source" true
else
  echo "  note программы в проекте отличаются от свежей сборки (другая версия Go?) — пересоберите: tools/build-installers.sh"
fi
python3 "$ROOT/tools/make_universal.py" "$T/x86_64" "$T/arm64" "$T/bad" >"$T/swap" 2>&1
ok "universal tool refuses slices given in the wrong order" '[ $? != 0 ] && [ ! -e "$T/bad" ]'
cp "$T/x86_64" "$T/notsigned"; python3 "$ROOT/tools/make_universal.py" "$T/stub.exe" "$T/x86_64" "$T/bad2" >/dev/null 2>&1
ok "universal tool refuses a file that is not a Mac program" '[ $? != 0 ] && [ ! -e "$T/bad2" ]'

# ---- released files
ok "released Windows installer starts with stub.exe" 'cmp -s -n "$(stat -c %s "$ROOT/installer/windows/stub.exe")" "$ROOT/installer/windows/stub.exe" "$EXE"'
mkdir "$T/mac" && unzip -q "$MACZIP" -d "$T/mac"
APP="$T/mac/Install Sayframe.app/Contents"
ok "released Mac app: its program is the universal launcher and is executable" 'cmp -s "$APP/MacOS/install-sayframe" "$ROOT/installer/mac/launcher" && [ -x "$APP/MacOS/install-sayframe" ] && head -c 2 "$APP/MacOS/install-sayframe" | grep -qv "#!"'
ok "released Mac app carries the current panel" 'diff -r "$ROOT/Sayframe" "$APP/Resources/Sayframe" >/dev/null && [ -s "$APP/Resources/AppIcon.icns" ]'
ok "released Mac app: Info.plist names the program and the panel version" 'grep -q "<string>install-sayframe</string>" "$APP/Info.plist" && grep -q "<string>$(sed -n "s/.*ExtensionBundleVersion=\"\([0-9.]*\)\".*/\1/p" "$ROOT/Sayframe/CSXS/manifest.xml")</string>" "$APP/Info.plist"'
ok "no file in the released archives is dated in the future" 'python3 - "$MACZIP" "$EXE" "$ROOT/downloads/Sayframe-Windows.zip" <<PY
import sys, zipfile, datetime
limit = datetime.datetime.now() - datetime.timedelta(hours=14)   # still in the past for every time zone
sys.exit(0 if all(datetime.datetime(*i.date_time) <= limit for p in sys.argv[1:] for i in zipfile.ZipFile(p).infolist()) else 1)
PY'

# ---- the whole scenario on this system: Windows-style (panel inside the file) and Mac-style (panel in a folder)
go build -o "$T/native" . 2>>"$T/build"; ok "builds for this system" '[ $? = 0 ]'
python3 - "$ROOT" "$T/native" "$T/installer" <<'PY'
import sys, importlib.util
root, native, out = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("release", root + "/tools/release.py"); r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
files = r.panel_files()
open(out, "wb").write(r.make_zip([("Sayframe/" + rel, data, 0o644) for rel, data in files], (2026, 1, 1, 12, 0, 0), prefix=open(native, "rb").read()))
PY
chmod +x "$T/installer"
E="$T/ext/Adobe/CEP/extensions"
SAYFRAME_EXT_DIR="$E" SAYFRAME_ANSWER=install "$T/installer" >"$T/out1" 2>&1; RC=$?
ok "Windows-style install: exit code 0, files identical to the panel" '[ $RC = 0 ] && diff -r "$ROOT/Sayframe" "$E/Sayframe" >/dev/null'
ok "Windows-style install: asks first, then sets PlayerDebugMode, then reports" 'grep -q "CONFIRM" "$T/out1" && grep -q "SETTING PlayerDebugMode" "$T/out1" && grep -q "Sayframe установлен" "$T/out1" && grep -q "профиле Windows" "$T/out1"'
ok "window title carries the version" 'grep -q "^\[Sayframe [0-9.]* для After Effects\] CONFIRM" "$T/out1"'
echo stale > "$E/Sayframe/stale.txt"
SAYFRAME_EXT_DIR="$E" SAYFRAME_ANSWER=cancel "$T/installer" >"$T/out2" 2>&1
ok "already installed + cancel: nothing changes" '[ -f "$E/Sayframe/stale.txt" ] && grep -q "CHOOSE" "$T/out2" && ! grep -q SETTING "$T/out2"'
SAYFRAME_EXT_DIR="$E" SAYFRAME_ANSWER=install "$T/installer" >"$T/out3" 2>&1
ok "reinstall: old files replaced" '[ ! -e "$E/Sayframe/stale.txt" ] && diff -r "$ROOT/Sayframe" "$E/Sayframe" >/dev/null'
SAYFRAME_EXT_DIR="$E" SAYFRAME_ANSWER=remove "$T/installer" >"$T/out4" 2>&1
ok "remove: folder gone, nothing left behind" '[ ! -e "$E/Sayframe" ] && [ -z "$(ls -A "$E")" ] && grep -q "Sayframe удалён" "$T/out4"'
cp "$T/native" "$T/empty"; SAYFRAME_EXT_DIR="$T/e2" SAYFRAME_ANSWER=install "$T/empty" >"$T/out5" 2>&1; RC=$?
ok "program without the panel inside: error, nothing touched" '[ $RC = 1 ] && grep -q "Установщик повреждён" "$T/out5" && [ ! -e "$T/e2" ]'

M="$T/home/Library/Application Support/Adobe/CEP/extensions"
SAYFRAME_PAYLOAD_DIR="$APP/Resources/Sayframe" SAYFRAME_EXT_DIR="$M" SAYFRAME_ANSWER=install "$T/native" >"$T/out6" 2>&1; RC=$?
ok "Mac-style install from the released app's folder: files identical to the panel" '[ $RC = 0 ] && diff -r "$ROOT/Sayframe" "$M/Sayframe" >/dev/null'
ok "Mac-style install: Mac wording, quarantine hook, setting" 'grep -q "домашней папке" "$T/out6" && grep -q "Settings > Scripting" "$T/out6" && grep -q "^INSTALLED .*extensions/Sayframe$" "$T/out6" && grep -q "SETTING PlayerDebugMode" "$T/out6"'
mkdir -p "$M/ClaudePanel"; SAYFRAME_PAYLOAD_DIR="$APP/Resources/Sayframe" SAYFRAME_EXT_DIR="$M" SAYFRAME_ANSWER=install "$T/native" >"$T/out7" 2>&1
ok "Mac-style reinstall also removes the old ClaudePanel folder" '[ ! -e "$M/ClaudePanel" ] && diff -r "$ROOT/Sayframe" "$M/Sayframe" >/dev/null'
SAYFRAME_PAYLOAD_DIR="$T/nothing-here" SAYFRAME_EXT_DIR="$T/e3" SAYFRAME_ANSWER=install "$T/native" >"$T/out8" 2>&1; RC=$?
ok "Mac-style: missing panel folder -> error, nothing touched" '[ $RC = 1 ] && grep -q "Установщик повреждён" "$T/out8" && [ ! -e "$T/e3" ]'

# ---- install.sh in a sandbox
mkdir -p "$T/bin" "$T/shome"
cat > "$T/bin/curl" <<STUB
#!/bin/bash
# stub: "downloads" the released archive from the project folder
out=""; url=""
while [ \$# -gt 0 ]; do case "\$1" in -o) out="\$2"; shift 2;; -*) shift;; *) url="\$1"; shift;; esac; done
echo "\$url" >> "$T/curl.log"
[ "\${STUB_CURL_FAIL:-0}" = 1 ] && exit 22
case "\$url" in */downloads/Install-Sayframe-Mac.zip) cp "$MACZIP" "\$out";; *) exit 22;; esac
STUB
printf '#!/bin/bash\necho "defaults $*" >> "%s/sys.log"\n' "$T" > "$T/bin/defaults"
printf '#!/bin/bash\necho "xattr $*" >> "%s/sys.log"\n' "$T" > "$T/bin/xattr"
chmod +x "$T/bin/"*
SE="$T/shome/Library/Application Support/Adobe/CEP/extensions"
mkdir -p "$SE/Sayframe" "$SE/ClaudePanel"; echo old > "$SE/Sayframe/old.txt"
HOME="$T/shome" PATH="$T/bin:$PATH" bash "$ROOT/install.sh" >"$T/sh1" 2>&1 </dev/null; RC=$?
ok "install.sh: installs the released panel over an old one" '[ $RC = 0 ] && diff -r "$ROOT/Sayframe" "$SE/Sayframe" >/dev/null && [ ! -e "$SE/ClaudePanel" ] && [ ! -e "$SE/.Sayframe.installing" ]'
ok "install.sh: downloads from the project address and sets PlayerDebugMode for 8 engine versions" 'grep -q "^https://raw.githubusercontent.com/.*/downloads/Install-Sayframe-Mac.zip$" "$T/curl.log" && [ "$(grep -c "^defaults write com.adobe.CSXS" "$T/sys.log")" = 8 ] && grep -q "^xattr -dr com.apple.quarantine" "$T/sys.log"'
ok "install.sh: reports the installed version" 'grep -q "^Sayframe [0-9][0-9.]* установлен\.$" "$T/sh1"'
echo keep > "$SE/Sayframe/keep.txt"; : > "$T/sys.log"
HOME="$T/shome" PATH="$T/bin:$PATH" STUB_CURL_FAIL=1 bash "$ROOT/install.sh" >"$T/sh2" 2>&1 </dev/null; RC=$?
ok "install.sh: download fails -> installed panel untouched, no setting written" '[ $RC != 0 ] && [ -f "$SE/Sayframe/keep.txt" ] && [ ! -s "$T/sys.log" ]'
ok "install.sh is piped-safe: works when read from standard input" 'rm -rf "$SE/Sayframe" && HOME="$T/shome" PATH="$T/bin:$PATH" bash < "$ROOT/install.sh" >"$T/sh3" 2>&1 && diff -r "$ROOT/Sayframe" "$SE/Sayframe" >/dev/null'

echo "$pass passed, $failc failed"
[ "$failc" = 0 ]
