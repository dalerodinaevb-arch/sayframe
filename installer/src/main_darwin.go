//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Окна показывает системная программа osascript. Аргументы: текст, заголовок, значок,
// название кнопки отмены (или пусто), остальные — кнопки; последняя кнопка главная.
const dialogWithIcon = `on run argv
	set msg to item 1 of argv
	set ttl to item 2 of argv
	set ico to item 3 of argv
	set cancelName to item 4 of argv
	set btns to items 5 thru -1 of argv
	if cancelName is not "" then set btns to {cancelName} & btns
	try
		activate
	end try
	try
		if cancelName is "" then
			set r to display dialog msg with title ttl buttons btns default button (count of btns) with icon (POSIX file ico)
		else
			set r to display dialog msg with title ttl buttons btns default button (count of btns) cancel button 1 with icon (POSIX file ico)
		end if
		return button returned of r
	on error number -128
		return cancelName
	end try
end run
`

// То же без значка: если файл значка не прочитался.
const dialogPlain = `on run argv
	set msg to item 1 of argv
	set ttl to item 2 of argv
	set cancelName to item 4 of argv
	set btns to items 5 thru -1 of argv
	if cancelName is not "" then set btns to {cancelName} & btns
	try
		if cancelName is "" then
			set r to display dialog msg with title ttl buttons btns default button (count of btns)
		else
			set r to display dialog msg with title ttl buttons btns default button (count of btns) cancel button 1
		end if
		return button returned of r
	on error number -128
		return cancelName
	end try
end run
`

// Самое простое окно на случай, если первые два не открылись: одна или две кнопки.
const dialogMinimal = `on run argv
	try
		if (count of argv) > 2 then
			return button returned of (display dialog (item 1 of argv) buttons {item 2 of argv, item 3 of argv} default button 2)
		else
			return button returned of (display dialog (item 1 of argv) buttons {item 2 of argv} default button 1)
		end if
	on error number -128
		return item 2 of argv
	end try
end run
`

func osascript(script string, args ...string) (string, error) {
	cmd := exec.Command("/usr/bin/osascript", append([]string{"-"}, args...)...)
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.Output()
	return strings.TrimRight(string(out), "\r\n"), err
}

type macDialogs struct {
	title, icon string
	broken      bool // ни одно окно не открылось
}

// show возвращает название нажатой кнопки.
func (d *macDialogs) show(text, cancel string, buttons ...string) string {
	args := append([]string{text, d.title, d.icon, cancel}, buttons...)
	for _, script := range []string{dialogWithIcon, dialogPlain} {
		if out, err := osascript(script, args...); err == nil {
			return out
		}
	}
	last := buttons[len(buttons)-1]
	minimal := []string{text, last}
	if cancel != "" {
		minimal = []string{text, cancel, last}
	}
	out, err := osascript(dialogMinimal, minimal...)
	if err != nil {
		d.broken = true
		return ""
	}
	return out
}

func (d *macDialogs) confirmInstall(text string) bool {
	answer := d.show(text, "Отмена", "Установить")
	// Если окна не открываются совсем, запуск «Install Sayframe» и есть согласие на установку.
	return answer == "Установить" || d.broken
}

func (d *macDialogs) chooseInstalled(text string) choice {
	switch d.show(text, "Отмена", "Удалить", "Переустановить") {
	case "Переустановить":
		return choiceInstall
	case "Удалить":
		return choiceRemove
	}
	if d.broken {
		return choiceInstall
	}
	return choiceCancel
}

func (d *macDialogs) info(text string) { d.show(text, "", "Готово") }
func (d *macDialogs) fail(text string) { d.show(text, "", "Закрыть") }

type macMachine struct{}

func (macMachine) extensionsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "Application Support", "Adobe", "CEP", "extensions"), nil
}

// installed снимает с файлов панели метку «скачано из интернета».
func (macMachine) installed(dest string) {
	exec.Command("/usr/bin/xattr", "-dr", "com.apple.quarantine", dest).Run()
}

// enableUnsignedPanels включает PlayerDebugMode для всех версий движка панелей CSXS.
func (macMachine) enableUnsignedPanels() error {
	var firstErr error
	for v := 9; v <= 16; v++ {
		err := exec.Command("/usr/bin/defaults", "write", fmt.Sprintf("com.adobe.CSXS.%d", v), "PlayerDebugMode", "1").Run()
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func main() {
	d := &macDialogs{title: titleFor("")}
	exe, err := os.Executable()
	if err == nil {
		if real, e := filepath.EvalSymlinks(exe); e == nil {
			exe = real
		}
	}
	// Программа лежит в Install Sayframe.app/Contents/MacOS, панель — в Contents/Resources/Sayframe.
	resources := filepath.Join(filepath.Dir(exe), "..", "Resources")
	d.icon = filepath.Join(resources, "AppIcon.icns")
	p, perr := openDirPayload(filepath.Join(resources, "Sayframe"))
	if err != nil || perr != nil {
		d.fail(macWords.damaged)
		os.Exit(1)
	}
	d.title = titleFor(p.version())
	m := macMachine{}
	code := run(d, m, p, macWords)
	if d.broken && code == 0 {
		// Окна не открылись: показываем результат, открыв папку с панелью в Finder.
		if dir, e := m.extensionsDir(); e == nil {
			exec.Command("/usr/bin/open", dir).Run()
		}
	}
	os.Exit(code)
}
