//go:build !windows

// Сборка не для Windows нужна только для проверки: тот же сценарий, но без окон и реестра.
// Ответы на вопросы берутся из переменной SAYFRAME_ANSWER (install, remove или cancel),
// папка расширений — из SAYFRAME_EXT_DIR.
package main

import (
	"errors"
	"fmt"
	"os"
)

type consoleDialogs struct{ title string }

func answer() string { return os.Getenv("SAYFRAME_ANSWER") }

func (c consoleDialogs) confirmInstall(text string) bool {
	fmt.Printf("[%s] CONFIRM\n%s\n", c.title, text)
	return answer() == "install"
}

func (c consoleDialogs) chooseInstalled(text string) choice {
	fmt.Printf("[%s] CHOOSE\n%s\n", c.title, text)
	switch answer() {
	case "install":
		return choiceInstall
	case "remove":
		return choiceRemove
	}
	return choiceCancel
}

func (c consoleDialogs) info(text string) { fmt.Printf("[%s] INFO\n%s\n", c.title, text) }
func (c consoleDialogs) fail(text string) { fmt.Printf("[%s] FAIL\n%s\n", c.title, text) }

type testMachine struct{}

func (testMachine) extensionsDir() (string, error) {
	if d := os.Getenv("SAYFRAME_EXT_DIR"); d != "" {
		return d, nil
	}
	return "", errors.New("SAYFRAME_EXT_DIR is not set")
}

func (testMachine) enableUnsignedPanels() error {
	fmt.Println("SETTING PlayerDebugMode")
	return nil
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Println("FAIL cannot find own file")
		os.Exit(1)
	}
	zr, closer, err := openPayload(exe)
	if err != nil {
		consoleDialogs{titleFor("")}.fail("Установщик повреждён: внутри нет файлов панели. Скачайте его заново.")
		os.Exit(1)
	}
	code := run(consoleDialogs{titleFor(payloadVersion(zr))}, testMachine{}, zr)
	closer.Close()
	os.Exit(code)
}
