#!/bin/bash
# Проверяет установщик для Windows настолько, насколько это возможно без Windows:
# логику установки (go test), сборку под Windows, содержимое готового файла из downloads/
# и полный сценарий на копии той же программы, собранной для этой системы.
# Окна и запись в реестр Windows здесь не выполняются. Нужен Go.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/installer/windows/src"
EXE="$ROOT/downloads/Install-Sayframe-Windows.exe"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; failc=0
ok(){ if eval "$2"; then pass=$((pass+1)); echo "  ok   $1"; else failc=$((failc+1)); echo "  FAIL $1"; fi; }
if ! command -v go >/dev/null 2>&1; then echo "Go не найден — проверка установщика для Windows пропущена"; exit 0; fi

cd "$SRC" || exit 2
ok "code is formatted" '[ -z "$(gofmt -l .)" ]'
go vet ./... >"$T/vet1" 2>&1; ok "go vet (this system)" '[ $? = 0 ]'
GOOS=windows GOARCH=amd64 go vet ./... >"$T/vet2" 2>&1; ok "go vet (Windows)" '[ $? = 0 ]'
SAYFRAME_REAL_EXE="$EXE" SAYFRAME_PANEL_DIR="$ROOT/Sayframe" go test -count=1 -v ./... >"$T/test" 2>&1; ok "go test, including the released installer" '[ $? = 0 ] && grep -q "^--- PASS: TestReleasedInstallerCarriesThePanel" "$T/test" && ! grep -q "^--- SKIP" "$T/test"'
[ $failc = 0 ] || tail -30 "$T/test"

GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "-H=windowsgui -s -w -buildid=" -o "$T/stub.exe" . 2>"$T/build"
ok "builds for Windows" '[ $? = 0 ] && [ -s "$T/stub.exe" ]'
if cmp -s "$T/stub.exe" "$ROOT/installer/windows/stub.exe"; then
  ok "stub.exe in the project is built from this source" true
else
  echo "  note stub.exe differs from a fresh build (другая версия Go?) — пересоберите: tools/build-windows-stub.sh"
fi
ok "released installer starts with stub.exe" 'cmp -s -n "$(stat -c %s "$ROOT/installer/windows/stub.exe")" "$ROOT/installer/windows/stub.exe" "$EXE"'

# Полный сценарий: та же программа, собранная для этой системы, с тем же способом упаковки.
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
ok "install: exit code 0, files identical to the panel" '[ $RC = 0 ] && diff -r "$ROOT/Sayframe" "$E/Sayframe" >/dev/null'
ok "install: asks first, then sets PlayerDebugMode, then reports" 'grep -q "CONFIRM" "$T/out1" && grep -q "SETTING PlayerDebugMode" "$T/out1" && grep -q "Sayframe установлен" "$T/out1"'
ok "install: window title carries the version" 'grep -q "^\[Sayframe [0-9.]* для After Effects\] CONFIRM" "$T/out1"'
echo stale > "$E/Sayframe/stale.txt"
SAYFRAME_EXT_DIR="$E" SAYFRAME_ANSWER=cancel "$T/installer" >"$T/out2" 2>&1
ok "already installed + cancel: nothing changes" '[ -f "$E/Sayframe/stale.txt" ] && grep -q "CHOOSE" "$T/out2" && ! grep -q SETTING "$T/out2"'
SAYFRAME_EXT_DIR="$E" SAYFRAME_ANSWER=install "$T/installer" >"$T/out3" 2>&1
ok "reinstall: old files replaced" '[ ! -e "$E/Sayframe/stale.txt" ] && diff -r "$ROOT/Sayframe" "$E/Sayframe" >/dev/null'
SAYFRAME_EXT_DIR="$E" SAYFRAME_ANSWER=remove "$T/installer" >"$T/out4" 2>&1
ok "remove: folder gone, nothing left behind" '[ ! -e "$E/Sayframe" ] && [ -z "$(ls -A "$E")" ] && grep -q "Sayframe удалён" "$T/out4"'
cp "$T/native" "$T/empty"; SAYFRAME_EXT_DIR="$T/e2" SAYFRAME_ANSWER=install "$T/empty" >"$T/out5" 2>&1; RC=$?
ok "program without the panel inside: error, nothing touched" '[ $RC = 1 ] && grep -q "Установщик повреждён" "$T/out5" && [ ! -e "$T/e2" ]'
echo "$pass passed, $failc failed"
[ "$failc" = 0 ]
