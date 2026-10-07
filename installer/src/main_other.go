//go:build !windows && !darwin

// Сборка для остальных систем нужна только для проверки: тот же сценарий, но без окон и
// системных настроек. Ответы на вопросы берутся из переменной SAYFRAME_ANSWER (install, remove
// или cancel), папка расширений — из SAYFRAME_EXT_DIR. Если задана SAYFRAME_PAYLOAD_DIR, панель
// берётся из этой папки и тексты — как на Mac; иначе из архива в самом файле, тексты как на Windows.
package main

import (
	"errors"
	"fmt"
	"io"
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

func (testMachine) installed(dest string) { fmt.Println("INSTALLED " + dest) }

func (testMachine) enableUnsignedPanels() error {
	fmt.Println("SETTING PlayerDebugMode")
	return nil
}

func main() {
	var p payload
	var closer io.Closer
	var err error
	words := windowsWords
	if dir := os.Getenv("SAYFRAME_PAYLOAD_DIR"); dir != "" {
		words = macWords
		p, err = openDirPayload(dir)
	} else {
		var exe string
		if exe, err = os.Executable(); err == nil {
			p, closer, err = openPayload(exe)
		}
	}
	if err != nil {
		consoleDialogs{titleFor("")}.fail(words.damaged)
		os.Exit(1)
	}
	code := run(consoleDialogs{titleFor(p.version())}, testMachine{}, p, words)
	if closer != nil {
		closer.Close()
	}
	os.Exit(code)
}
