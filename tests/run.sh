#!/bin/bash
# Запускает все проверки. Нужны: python3, node, openssl, пакет playwright с браузером Chromium
# и Go (без него пропускается только проверка установщиков).
cd "$(dirname "$0")/.." || exit 2
status=0
echo "== выпуск ==";            python3 tools/release.py --check || status=1
echo "== установщики ==";       bash tests/installers.test.sh </dev/null | tail -1; [ "${PIPESTATUS[0]}" = 0 ] || status=1
echo "== сеть ==";              node tests/network.test.js </dev/null | tail -1; [ "${PIPESTATUS[0]}" = 0 ] || status=1
echo "== панель ==";            node tests/panel.test.js </dev/null | grep -E "FAIL|passed"; [ "${PIPESTATUS[0]}" = 0 ] || status=1
[ $status = 0 ] && echo "ВСЁ ПРОШЛО" || echo "ЕСТЬ ОШИБКИ"
exit $status
