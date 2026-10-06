// Установщик Sayframe для Windows: один exe, к концу которого приписан zip с панелью.
// Этот файл — общая логика без вызовов Windows; её проверяют тесты на любой системе.
package main

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	panelName     = "Sayframe"
	oldPanelName  = "ClaudePanel" // прежнее название панели
	stagingName   = ".Sayframe.installing"
	backupName    = ".Sayframe.previous"
	payloadPrefix = "Sayframe/"
	maxFileSize   = 50 << 20
)

// rename вынесен в переменную, чтобы тесты могли изобразить занятые файлы.
var rename = os.Rename

var (
	errNoPayload = errors.New("no payload")
	errInUse     = errors.New("panel folder is in use")
	segmentRe    = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`)
	versionRe    = regexp.MustCompile(`ExtensionBundleVersion="(\d+\.\d+\.\d+)"`)
)

// openPayload открывает zip, приписанный к файлу установщика.
func openPayload(exePath string) (*zip.Reader, io.Closer, error) {
	f, err := os.Open(exePath)
	if err != nil {
		return nil, nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	zr, err := zip.NewReader(f, st.Size())
	if err != nil {
		f.Close()
		return nil, nil, errNoPayload
	}
	if findFile(zr, payloadPrefix+"CSXS/manifest.xml") == nil {
		f.Close()
		return nil, nil, errNoPayload
	}
	return zr, f, nil
}

func findFile(zr *zip.Reader, name string) *zip.File {
	for _, f := range zr.File {
		if f.Name == name {
			return f
		}
	}
	return nil
}

// payloadVersion возвращает номер версии панели из её манифеста или пустую строку.
func payloadVersion(zr *zip.Reader) string {
	f := findFile(zr, payloadPrefix+"CSXS/manifest.xml")
	if f == nil {
		return ""
	}
	rc, err := f.Open()
	if err != nil {
		return ""
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, 1<<20))
	if err != nil {
		return ""
	}
	m := versionRe.FindSubmatch(data)
	if m == nil {
		return ""
	}
	return string(m[1])
}

// safeRel проверяет путь файла внутри панели: только обычные имена, без «..» и абсолютных путей.
func safeRel(rel string) bool {
	if rel == "" || len(rel) > 200 {
		return false
	}
	for _, seg := range strings.Split(rel, "/") {
		if !segmentRe.MatchString(seg) {
			return false
		}
	}
	return true
}

// extract распаковывает файлы панели в папку dest и возвращает их число.
func extract(zr *zip.Reader, dest string) (int, error) {
	count := 0
	for _, f := range zr.File {
		if !strings.HasPrefix(f.Name, payloadPrefix) || strings.HasSuffix(f.Name, "/") {
			continue
		}
		rel := strings.TrimPrefix(f.Name, payloadPrefix)
		if !safeRel(rel) {
			return count, fmt.Errorf("unsafe path in payload: %q", f.Name)
		}
		if f.UncompressedSize64 > maxFileSize {
			return count, fmt.Errorf("file too large: %q", f.Name)
		}
		target := filepath.Join(dest, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return count, err
		}
		if err := writeEntry(f, target); err != nil {
			return count, err
		}
		count++
	}
	if count == 0 {
		return 0, errNoPayload
	}
	return count, nil
}

func writeEntry(f *zip.File, target string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(rc, maxFileSize+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && uint64(n) != f.UncompressedSize64 {
		err = fmt.Errorf("size mismatch: %q", f.Name)
	}
	return err
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// installPanel ставит панель в папку расширений. Сначала распаковывает во временную папку,
// затем подменяет установленную версию; при сбое прежняя версия остаётся на месте.
func installPanel(zr *zip.Reader, extDir string) error {
	dest := filepath.Join(extDir, panelName)
	staging := filepath.Join(extDir, stagingName)
	backup := filepath.Join(extDir, backupName)

	if err := os.MkdirAll(extDir, 0o755); err != nil {
		return err
	}
	os.RemoveAll(staging)
	if _, err := extract(zr, staging); err != nil {
		os.RemoveAll(staging)
		return err
	}
	if !exists(filepath.Join(staging, "CSXS", "manifest.xml")) {
		os.RemoveAll(staging)
		return errNoPayload
	}
	hadOld := exists(dest)
	if hadOld {
		os.RemoveAll(backup)
		// Переименование не проходит, если After Effects держит файлы панели открытыми:
		// тогда установленная версия остаётся нетронутой.
		if err := rename(dest, backup); err != nil {
			os.RemoveAll(staging)
			return errInUse
		}
	}
	if err := rename(staging, dest); err != nil {
		if hadOld {
			rename(backup, dest)
		}
		os.RemoveAll(staging)
		return err
	}
	os.RemoveAll(backup)
	os.RemoveAll(filepath.Join(extDir, oldPanelName))
	return nil
}

func removePanel(extDir string) error {
	dest := filepath.Join(extDir, panelName)
	backup := filepath.Join(extDir, backupName)
	if !exists(dest) {
		return nil
	}
	os.RemoveAll(backup)
	if err := rename(dest, backup); err != nil {
		return errInUse
	}
	os.RemoveAll(backup)
	return nil
}

// ---------------------------------------------------------------- сценарий

type choice int

const (
	choiceCancel choice = iota
	choiceInstall
	choiceRemove
)

// dialogs — окна, которые видит пользователь.
type dialogs interface {
	confirmInstall(text string) bool // «ОК» / «Отмена»
	chooseInstalled(text string) choice
	info(text string)
	fail(text string)
}

// machine — то, что зависит от Windows.
type machine interface {
	extensionsDir() (string, error)
	enableUnsignedPanels() error // PlayerDebugMode
}

const doneText = "Sayframe установлен.\n\n" +
	"Если After Effects открыт, сохраните проект, закройте программу и откройте снова.\n" +
	"Панель находится в меню:\nWindow > Extensions > Sayframe\n\n" +
	"Для референсов и вставки картинок включите в After Effects:\n" +
	"Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network"

const inUseText = "Не удалось заменить файлы панели: их использует After Effects или другая программа.\n\n" +
	"Закройте After Effects и окно Проводника с папкой панели, затем запустите установщик ещё раз. Установленная версия не изменена."

// run — весь сценарий установщика. Возвращает код выхода.
func run(d dialogs, m machine, zr *zip.Reader) int {
	extDir, err := m.extensionsDir()
	if err != nil || extDir == "" {
		d.fail("Не удалось найти папку расширений Adobe в вашем профиле Windows.")
		return 1
	}
	dest := filepath.Join(extDir, panelName)

	if exists(dest) {
		switch d.chooseInstalled("Sayframe уже установлен.\n\n" +
			"Да — переустановить (заменить установленную версию этой)\n" +
			"Нет — удалить панель\n" +
			"Отмена — ничего не делать") {
		case choiceInstall:
			// ниже
		case choiceRemove:
			if err := removePanel(extDir); err != nil {
				d.fail("Не удалось удалить папку панели: её использует After Effects или другая программа.\n\nЗакройте After Effects и запустите установщик ещё раз.")
				return 1
			}
			d.info("Sayframe удалён.\n\nНастройка PlayerDebugMode не тронута: она может быть нужна другим панелям.")
			return 0
		default:
			return 0
		}
	} else {
		extra := ""
		if exists(filepath.Join(extDir, oldPanelName)) {
			extra = "\n• удалит прежнюю версию этой панели (папку ClaudePanel)"
		}
		if !d.confirmInstall("Установить панель Sayframe в After Effects?\n\n" +
			"Установщик:\n" +
			"• скопирует панель в папку расширений Adobe в вашем профиле Windows\n" +
			"• разрешит After Effects загружать панели без подписи Adobe (настройка PlayerDebugMode)" +
			extra + "\n\n" +
			"Права администратора не нужны. Нажмите «ОК», чтобы установить.") {
			return 0
		}
	}

	if err := installPanel(zr, extDir); err != nil {
		if errors.Is(err, errInUse) {
			d.fail(inUseText)
		} else if errors.Is(err, errNoPayload) {
			d.fail("Установщик повреждён: внутри нет файлов панели. Скачайте его заново.")
		} else {
			d.fail("Не удалось скопировать панель в папку:\n" + extDir + "\n\nНичего не изменено.\n\n" + err.Error())
		}
		return 1
	}
	if err := m.enableUnsignedPanels(); err != nil {
		d.fail("Панель скопирована, но не удалось включить настройку PlayerDebugMode, без неё After Effects панель не покажет.\n\n" +
			"Откройте «Командную строку» и выполните:\n" +
			`reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f`)
		return 1
	}
	d.info(doneText)
	return 0
}

func titleFor(version string) string {
	if version == "" {
		return "Sayframe для After Effects"
	}
	return "Sayframe " + version + " для After Effects"
}
