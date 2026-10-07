#!/bin/bash
# Sayframe для After Effects: установка на Mac одной командой в Терминале.
# Запасной способ на случай, если macOS не даёт открыть программу «Install Sayframe».
#
#   curl -fsSL https://raw.githubusercontent.com/dalerodinaevb-arch/sayframe/main/install.sh | bash
#
# Делает то же, что установщик: скачивает панель, кладёт её в папку расширений Adobe
# в вашей домашней папке и включает PlayerDebugMode (так After Effects загружает панели без подписи Adobe).
# Этот файл создаёт tools/release.py, править его вручную не нужно.
set -eu

BASE="${SAYFRAME_BASE:-https://raw.githubusercontent.com/dalerodinaevb-arch/sayframe/main}"
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$EXT_DIR/Sayframe"
STAGING="$EXT_DIR/.Sayframe.installing"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Sayframe: скачиваю панель…"
curl -fsSL "$BASE/downloads/Install-Sayframe-Mac.zip" -o "$TMP/sayframe.zip"
unzip -q "$TMP/sayframe.zip" -d "$TMP/unpacked"
SRC="$TMP/unpacked/Install Sayframe.app/Contents/Resources/Sayframe"
if [ ! -f "$SRC/CSXS/manifest.xml" ]; then
    echo "Не удалось скачать панель. Проверьте интернет и попробуйте ещё раз."
    exit 1
fi

mkdir -p "$EXT_DIR"
rm -rf "$STAGING"
cp -R "$SRC" "$STAGING"
rm -rf "$DEST"
mv "$STAGING" "$DEST"
rm -rf "$EXT_DIR/ClaudePanel"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

for v in 9 10 11 12 13 14 15 16; do
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done

VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([0-9.]*\)".*/\1/p' "$DEST/CSXS/manifest.xml" | head -1)"
echo "Sayframe $VERSION установлен."
echo "Если After Effects открыт, полностью закройте его и откройте снова."
echo "Панель находится в меню: Window > Extensions > Sayframe"
echo "Для референсов и вставки картинок включите в After Effects:"
echo "Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network"
