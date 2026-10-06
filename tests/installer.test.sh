#!/bin/bash
# Проверяет логику установщика для Mac в песочнице: команды macOS (osascript, defaults,
# xattr, pgrep) заменены заглушками, домашняя папка — временная. Настоящую систему не трогает.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/MacOS" "$T/Resources"
cat > "$T/bin/osascript" <<'STUB'
#!/bin/bash
# Записывает показанное окно и «нажимает» очередную кнопку из $STUB_BUTTONS.
if [ "$1" = "-" ]; then
  cat >/dev/null
  [ "${STUB_RICH_FAIL:-0}" = "1" ] && { echo "syntax error" >&2; exit 1; }
  shift
  printf 'DIALOG buttons=[%s] cancel=[%s]\n%s\n---\n' "$(printf '%s|' "${@:5}")" "$4" "$1" >> "$STUB_LOG"
else
  while [ "$1" = "-e" ]; do shift 2; done
  printf 'SIMPLE buttons=[%s]\n%s\n---\n' "$(printf '%s|' "${@:2}")" "$1" >> "$STUB_LOG"
fi
n=$(cat "$STUB_STATE" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STUB_STATE"
btn=$(echo "$STUB_BUTTONS" | cut -d, -f$n)
[ -n "$btn" ] && echo "$btn"
exit 0
STUB
printf '#!/bin/bash\n[ "${STUB_DEFAULTS_FAIL:-0}" = "1" ] && exit 1\necho "defaults $*" >> "$STUB_LOG"\n' > "$T/bin/defaults"
printf '#!/bin/bash\necho "xattr $*" >> "$STUB_LOG"\n' > "$T/bin/xattr"
printf '#!/bin/bash\n[ "${STUB_AE_RUNNING:-0}" = "1" ] && exit 0\nexit 1\n' > "$T/bin/pgrep"
chmod +x "$T/bin/"*
sed -e 's#/usr/bin/osascript#osascript#' -e "s#^export PATH=.*#export PATH=\"$T/bin:\$PATH\"#" "$ROOT/installer/mac/install-sayframe" > "$T/MacOS/run.sh"
cp -R "$ROOT/Sayframe" "$T/Resources/Sayframe"

pass=0; failc=0
ok(){ if eval "$2"; then pass=$((pass+1)); echo "  ok   $1"; else failc=$((failc+1)); echo "  FAIL $1"; fi; }
run(){ local h="$1" b="$2"; shift 2; : > "$T/log"; rm -f "$T/state"; env HOME="$h" STUB_LOG="$T/log" STUB_STATE="$T/state" STUB_BUTTONS="$b" "$@" bash "$T/MacOS/run.sh" </dev/null; RC=$?; }
EXT="Library/Application Support/Adobe/CEP/extensions"

bash -n "$ROOT/installer/mac/install-sayframe"; ok "script has no syntax errors" '[ $? = 0 ]'
H="$T/h1"; mkdir -p "$H"; run "$H" "Установить"
ok "fresh install: exit code 0" '[ $RC = 0 ]'
ok "fresh install: files identical to the panel" 'diff -r "$T/Resources/Sayframe" "$H/$EXT/Sayframe" >/dev/null'
ok "fresh install: PlayerDebugMode for 8 engine versions" '[ $(grep -c "^defaults write com.adobe.CSXS" "$T/log") = 8 ]'
ok "fresh install: confirm + done dialogs" '[ $(grep -c "^DIALOG" "$T/log") = 2 ] && ! grep -q "^SIMPLE" "$T/log"'
ok "fresh install: no temp folder left" '[ ! -e "$H/$EXT/.Sayframe.installing" ]'
ok "fresh install: quarantine flag cleared" 'grep -q "^xattr -dr com.apple.quarantine" "$T/log"'
H="$T/h2"; mkdir -p "$H"; run "$H" "Отмена"
ok "cancel: nothing touched" '[ $RC = 0 ] && [ ! -e "$H/Library" ] && ! grep -q "^defaults" "$T/log"'
H="$T/h2b"; mkdir -p "$H"; run "$H" ""
ok "dialog closed without an answer: nothing touched" '[ $RC = 0 ] && [ ! -e "$H/Library" ]'
H="$T/h1"; echo stale > "$H/$EXT/Sayframe/stale.txt"; run "$H" "Переустановить" STUB_AE_RUNNING=1
ok "reinstall: old files replaced" '[ ! -e "$H/$EXT/Sayframe/stale.txt" ] && [ -f "$H/$EXT/Sayframe/CSXS/manifest.xml" ]'
ok "reinstall: offers remove / reinstall / cancel" 'grep -q "buttons=\[Удалить|Переустановить|\] cancel=\[Отмена\]" "$T/log"'
ok "reinstall: warns that After Effects is open" 'grep -q "сейчас открыт" "$T/log"'
run "$H" "Отмена"; ok "installed + cancel: panel kept" '[ -f "$H/$EXT/Sayframe/index.html" ]'
run "$H" "Удалить"; ok "remove: folder gone, setting untouched" '[ $RC = 0 ] && [ ! -e "$H/$EXT/Sayframe" ] && grep -q "Sayframe удалён" "$T/log" && ! grep -q "^defaults" "$T/log"'
H="$T/h3"; mkdir -p "$H/$EXT/ClaudePanel"; echo x > "$H/$EXT/ClaudePanel/a"; run "$H" "Установить"
ok "old ClaudePanel removed and announced" '[ ! -e "$H/$EXT/ClaudePanel" ] && [ -d "$H/$EXT/Sayframe" ] && grep -q "папку ClaudePanel" "$T/log"'
H="$T/h3b"; mkdir -p "$H/$EXT/ClaudePanel"; run "$H" "Отмена"; ok "old ClaudePanel kept on cancel" '[ -d "$H/$EXT/ClaudePanel" ]'
H="$T/h4"; mkdir -p "$H"; run "$H" "Установить" STUB_DEFAULTS_FAIL=1
ok "setting cannot be written: error, no 'installed' message" '[ $RC = 1 ] && grep -q "не удалось включить настройку PlayerDebugMode" "$T/log" && ! grep -q "Sayframe установлен" "$T/log"'
H="$T/h5"; mkdir -p "$H/$EXT/Sayframe/CSXS"; echo keep > "$H/$EXT/Sayframe/CSXS/manifest.xml"
sed 's#cp -R "\$SRC" "\$TMP_DEST"#false#' "$T/MacOS/run.sh" > "$T/MacOS/run2.sh"; : > "$T/log"; rm -f "$T/state"
env HOME="$H" STUB_LOG="$T/log" STUB_STATE="$T/state" STUB_BUTTONS="Переустановить" bash "$T/MacOS/run2.sh" </dev/null; RC=$?
ok "copy fails: previous version left intact" '[ $RC = 1 ] && [ "$(cat "$H/$EXT/Sayframe/CSXS/manifest.xml")" = keep ] && grep -q "Ничего не изменено" "$T/log" && [ ! -e "$H/$EXT/.Sayframe.installing" ]'
mv "$T/Resources/Sayframe" "$T/Resources/S.bak"; H="$T/h6"; mkdir -p "$H"; run "$H" "Установить"; mv "$T/Resources/S.bak" "$T/Resources/Sayframe"
ok "installer without the panel inside: error, nothing touched" '[ $RC = 1 ] && grep -q "Установщик повреждён" "$T/log" && [ ! -e "$H/Library" ]'
H="$T/h 7 с пробелом"; mkdir -p "$H"; run "$H" "" SAYFRAME_YES=1
ok "no-dialog mode, home path with spaces" '[ $RC = 0 ] && [ -f "$H/$EXT/Sayframe/jsx/host.jsx" ] && ! grep -q "^DIALOG" "$T/log"'
run "$H" "" SAYFRAME_YES=1 SAYFRAME_ACTION=remove; ok "no-dialog remove" '[ $RC = 0 ] && [ ! -e "$H/$EXT/Sayframe" ]'
H="$T/h8"; mkdir -p "$H"; run "$H" "Установить" STUB_RICH_FAIL=1
ok "styled dialog fails: plain dialog is used, install completes" '[ $RC = 0 ] && [ -f "$H/$EXT/Sayframe/index.html" ] && [ $(grep -c "^SIMPLE" "$T/log") = 2 ]'
H="$T/h9"; mkdir -p "$H"; run "$H" "Отмена" STUB_RICH_FAIL=1; ok "plain dialog cancel: nothing touched" '[ $RC = 0 ] && [ ! -e "$H/Library" ]'
echo "$pass passed, $failc failed"
[ "$failc" = 0 ]
