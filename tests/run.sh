#!/bin/bash
# Запускает все проверки. Нужны: python3, node, openssl, пакет playwright с браузером Chromium
# и Go (без него пропускается только проверка установщика для Windows).
cd "$(dirname "$0")/.." || exit 2
status=0
echo "== выпуск ==";            python3 tools/release.py --check || status=1
echo "== установщик для Mac =="; bash tests/installer.test.sh </dev/null | tail -1; [ "${PIPESTATUS[0]}" = 0 ] || status=1
echo "== установщик для Windows =="; bash tests/windows-installer.test.sh </dev/null | tail -1; [ "${PIPESTATUS[0]}" = 0 ] || status=1
echo "== сеть ==";              node tests/network.test.js </dev/null | tail -1; [ "${PIPESTATUS[0]}" = 0 ] || status=1
echo "== панель ==";            node tests/panel.test.js </dev/null | grep -E "FAIL|passed"; [ "${PIPESTATUS[0]}" = 0 ] || status=1
[ $status = 0 ] && echo "ВСЁ ПРОШЛО" || echo "ЕСТЬ ОШИБКИ"
exit $status
