#!/bin/bash
# Собирает installer/windows/stub.exe — программу-установщик для Windows без панели внутри.
# Панель к ней приписывает tools/release.py. Нужен Go (1.21 или новее); сборка идёт на любой системе.
# Запускать нужно только после изменений в installer/windows/src.
set -eu
cd "$(dirname "$0")/../installer/windows/src"
go vet ./...
GOOS=windows GOARCH=amd64 go vet ./...
go test ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -buildvcs=false \
    -ldflags "-H=windowsgui -s -w -buildid=" -o ../stub.exe .
echo "Собрано: installer/windows/stub.exe. Теперь запустите: python3 tools/release.py --build"
