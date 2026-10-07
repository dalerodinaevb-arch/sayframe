#!/bin/bash
# Собирает программы-установщики из installer/src (нужен Go 1.21 или новее, сборка идёт на любой системе):
#   installer/windows/stub.exe — установщик для Windows без панели внутри; панель к нему приписывает tools/release.py
#   installer/mac/launcher     — программа внутри «Install Sayframe.app», для Apple-чипа и Intel сразу
# Запускать нужно только после изменений в installer/src; потом: python3 tools/release.py --build
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/installer/src"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FLAGS=(-trimpath -buildvcs=false)

[ -z "$(gofmt -l .)" ] || { echo "Код не отформатирован: запустите gofmt -w ."; exit 1; }
go vet ./...
GOOS=windows GOARCH=amd64 go vet ./...
GOOS=darwin GOARCH=arm64 go vet ./...
go test -count=1 ./...

GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build "${FLAGS[@]}" -ldflags "-H=windowsgui -s -w -buildid=" -o "$ROOT/installer/windows/stub.exe" .
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build "${FLAGS[@]}" -ldflags "-s -w -buildid=" -o "$T/arm64" .
GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build "${FLAGS[@]}" -ldflags "-s -w -buildid=" -o "$T/x86_64" .
python3 "$ROOT/tools/make_universal.py" "$T/arm64" "$T/x86_64" "$ROOT/installer/mac/launcher"
echo "Собрано: installer/windows/stub.exe и installer/mac/launcher. Теперь запустите: python3 tools/release.py --build"
