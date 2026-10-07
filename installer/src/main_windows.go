//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	user32              = syscall.NewLazyDLL("user32.dll")
	advapi32            = syscall.NewLazyDLL("advapi32.dll")
	procMessageBoxW     = user32.NewProc("MessageBoxW")
	procRegCreateKeyExW = advapi32.NewProc("RegCreateKeyExW")
	procRegSetValueExW  = advapi32.NewProc("RegSetValueExW")
)

const (
	mbOK             = 0x00000000
	mbOKCancel       = 0x00000001
	mbYesNoCancel    = 0x00000003
	mbIconError      = 0x00000010
	mbIconQuestion   = 0x00000020
	mbIconInfo       = 0x00000040
	mbSetForeground  = 0x00010000
	idOK             = 1
	idYes            = 6
	idNo             = 7
	keySetValue      = 0x0002
	createNoWindow   = 0x08000000
	firstEngine      = 9 // версии движка панелей CSXS, для которых включаем настройку
	lastEngine       = 16
	debugValueName   = "PlayerDebugMode"
	debugValueWanted = "1"
)

func messageBox(text, title string, flags uintptr) int {
	t, err1 := syscall.UTF16PtrFromString(text)
	c, err2 := syscall.UTF16PtrFromString(title)
	if err1 != nil || err2 != nil {
		return 0
	}
	r, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags|mbSetForeground)
	return int(r)
}

type winDialogs struct{ title string }

func (w winDialogs) confirmInstall(text string) bool {
	return messageBox(text, w.title, mbOKCancel|mbIconQuestion) == idOK
}

func (w winDialogs) chooseInstalled(text string) choice {
	switch messageBox(text, w.title, mbYesNoCancel|mbIconQuestion) {
	case idYes:
		return choiceInstall
	case idNo:
		return choiceRemove
	}
	return choiceCancel
}

func (w winDialogs) info(text string) { messageBox(text, w.title, mbOK|mbIconInfo) }
func (w winDialogs) fail(text string) { messageBox(text, w.title, mbOK|mbIconError) }

type winMachine struct{}

func (winMachine) extensionsDir() (string, error) {
	base, err := os.UserConfigDir() // %AppData%
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "Adobe", "CEP", "extensions"), nil
}

func engineKey(v int) string { return fmt.Sprintf(`Software\Adobe\CSXS.%d`, v) }

// regWrite пишет PlayerDebugMode = "1" в HKEY_CURRENT_USER напрямую через Windows API.
func regWrite(v int) error {
	path, err := syscall.UTF16PtrFromString(engineKey(v))
	if err != nil {
		return err
	}
	name, err := syscall.UTF16PtrFromString(debugValueName)
	if err != nil {
		return err
	}
	data, err := syscall.UTF16FromString(debugValueWanted) // с завершающим нулём
	if err != nil {
		return err
	}
	var h syscall.Handle
	var disposition uint32
	r, _, _ := procRegCreateKeyExW.Call(
		uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(path)), 0, 0, 0,
		keySetValue, 0, uintptr(unsafe.Pointer(&h)), uintptr(unsafe.Pointer(&disposition)))
	if r != 0 {
		return syscall.Errno(r)
	}
	defer syscall.RegCloseKey(h)
	r, _, _ = procRegSetValueExW.Call(
		uintptr(h), uintptr(unsafe.Pointer(name)), 0, syscall.REG_SZ,
		uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	if r != 0 {
		return syscall.Errno(r)
	}
	return nil
}

// regRead возвращает текущее значение PlayerDebugMode или пустую строку.
func regRead(v int) string {
	path, err := syscall.UTF16PtrFromString(engineKey(v))
	if err != nil {
		return ""
	}
	name, err := syscall.UTF16PtrFromString(debugValueName)
	if err != nil {
		return ""
	}
	var h syscall.Handle
	if syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, path, 0, syscall.KEY_QUERY_VALUE, &h) != nil {
		return ""
	}
	defer syscall.RegCloseKey(h)
	buf := make([]uint16, 32)
	size := uint32(len(buf) * 2)
	var typ uint32
	if syscall.RegQueryValueEx(h, name, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &size) != nil || typ != syscall.REG_SZ {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

// regWriteWithTool делает то же системной программой reg.exe — запасной путь.
func regWriteWithTool(v int) error {
	tool := "reg.exe"
	if root := os.Getenv("SystemRoot"); root != "" {
		tool = filepath.Join(root, "System32", "reg.exe")
	}
	cmd := exec.Command(tool, "add", `HKCU\`+engineKey(v), "/v", debugValueName, "/t", "REG_SZ", "/d", debugValueWanted, "/f")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd.Run()
}

func (winMachine) installed(dest string) {}

func (winMachine) enableUnsignedPanels() error {
	var firstErr error
	for v := firstEngine; v <= lastEngine; v++ {
		if regWrite(v) == nil && regRead(v) == debugValueWanted {
			continue
		}
		if err := regWriteWithTool(v); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func main() {
	title := titleFor("")
	exe, err := os.Executable()
	if err != nil {
		winDialogs{title}.fail("Не удалось прочитать файл установщика.")
		os.Exit(1)
	}
	p, closer, err := openPayload(exe)
	if err != nil {
		winDialogs{title}.fail(windowsWords.damaged)
		os.Exit(1)
	}
	code := run(winDialogs{titleFor(p.version())}, winMachine{}, p, windowsWords)
	closer.Close()
	os.Exit(code)
}
