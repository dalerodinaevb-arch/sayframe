// Установщик Sayframe. Этот файл — общая логика для Windows и Mac без системных вызовов;
// её проверяют тесты на любой системе.
//
// Windows: один exe, к концу которого приписан zip с панелью (main_windows.go).
// Mac: программа внутри «Install Sayframe.app», панель лежит рядом в Contents/Resources (main_darwin.go).
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

// payload — файлы панели, которые несёт установщик.
type payload interface {
	extract(dest string) (int, error) // раскладывает файлы панели в папку dest, возвращает их число
	version() string                  // номер версии панели или пустая строка
}

// ---- панель в zip-архиве, приписанном к файлу установщика (Windows)

type zipPayload struct{ zr *zip.Reader }

// openPayload открывает zip, приписанный к файлу установщика.
func openPayload(exePath string) (payload, io.Closer, error) {
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
	return zipPayload{zr}, f, nil
}

func findFile(zr *zip.Reader, name string) *zip.File {
	for _, f := range zr.File {
		if f.Name == name {
			return f
		}
	}
	return nil
}

func versionIn(manifest []byte) string {
	m := versionRe.FindSubmatch(manifest)
	if m == nil {
		return ""
	}
	return string(m[1])
}

func (p zipPayload) version() string {
	f := findFile(p.zr, payloadPrefix+"CSXS/manifest.xml")
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
	return versionIn(data)
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

func (p zipPayload) extract(dest string) (int, error) {
	count := 0
	for _, f := range p.zr.File {
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
	return writeFile(rc, target, f.UncompressedSize64, f.Name)
}

func writeFile(src io.Reader, target string, size uint64, name string) error {
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(src, maxFileSize+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && uint64(n) != size {
		err = fmt.Errorf("size mismatch: %q", name)
	}
	return err
}

// ---- панель в папке рядом с программой (Mac: Contents/Resources/Sayframe)

type dirPayload struct{ dir string }

var skipNames = map[string]bool{".DS_Store": true, "Thumbs.db": true, "desktop.ini": true}

func openDirPayload(dir string) (payload, error) {
	if !exists(filepath.Join(dir, "CSXS", "manifest.xml")) {
		return nil, errNoPayload
	}
	return dirPayload{dir}, nil
}

func (p dirPayload) version() string {
	data, err := os.ReadFile(filepath.Join(p.dir, "CSXS", "manifest.xml"))
	if err != nil || len(data) > 1<<20 {
		return ""
	}
	return versionIn(data)
}

func (p dirPayload) extract(dest string) (int, error) {
	count := 0
	err := filepath.Walk(p.dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || skipNames[info.Name()] {
			return nil
		}
		rel, err := filepath.Rel(p.dir, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !info.Mode().IsRegular() || !safeRel(rel) {
			return fmt.Errorf("unsafe path in payload: %q", rel)
		}
		if info.Size() > maxFileSize {
			return fmt.Errorf("file too large: %q", rel)
		}
		target := filepath.Join(dest, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		defer src.Close()
		if err := writeFile(src, target, uint64(info.Size()), rel); err != nil {
			return err
		}
		count++
		return nil
	})
	if err != nil {
		return count, err
	}
	if count == 0 {
		return 0, errNoPayload
	}
	return count, nil
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// installPanel ставит панель в папку расширений. Сначала распаковывает во временную папку,
// затем подменяет установленную версию; при сбое прежняя версия остаётся на месте.
func installPanel(p payload, extDir string) error {
	dest := filepath.Join(extDir, panelName)
	staging := filepath.Join(extDir, stagingName)
	backup := filepath.Join(extDir, backupName)

	if err := os.MkdirAll(extDir, 0o755); err != nil {
		return err
	}
	os.RemoveAll(staging)
	if _, err := p.extract(staging); err != nil {
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
	confirmInstall(text string) bool
	chooseInstalled(text string) choice
	info(text string)
	fail(text string)
}

// machine — то, что зависит от операционной системы.
type machine interface {
	extensionsDir() (string, error)
	enableUnsignedPanels() error // PlayerDebugMode
	installed(dest string)       // панель уже на месте: можно, например, снять метку «скачано из интернета»
}

// wording — тексты окон: кнопки и названия меню на Windows и Mac разные.
type wording struct {
	noExtDir      string
	alreadyAsk    string // панель уже стоит: переустановить, удалить или ничего
	removeInUse   string
	removed       string
	confirm       string // %s — строка про прежнюю панель или пусто
	oldPanelLine  string
	inUse         string
	damaged       string
	copyFailed    string // %s — папка, второй %s — текст ошибки
	settingFailed string
	done          string
}

var windowsWords = wording{
	noExtDir: "Не удалось найти папку расширений Adobe в вашем профиле Windows.",
	alreadyAsk: "Sayframe уже установлен.\n\n" +
		"Да — переустановить (заменить установленную версию этой)\n" +
		"Нет — удалить панель\n" +
		"Отмена — ничего не делать",
	removeInUse: "Не удалось удалить папку панели: её использует After Effects или другая программа.\n\nЗакройте After Effects и запустите установщик ещё раз.",
	removed:     "Sayframe удалён.\n\nНастройка PlayerDebugMode не тронута: она может быть нужна другим панелям.",
	confirm: "Установить панель Sayframe в After Effects?\n\n" +
		"Установщик:\n" +
		"• скопирует панель в папку расширений Adobe в вашем профиле Windows\n" +
		"• разрешит After Effects загружать панели без подписи Adobe (настройка PlayerDebugMode)%s\n\n" +
		"Права администратора не нужны. Нажмите «ОК», чтобы установить.",
	oldPanelLine: "\n• удалит прежнюю версию этой панели (папку ClaudePanel)",
	inUse: "Не удалось заменить файлы панели: их использует After Effects или другая программа.\n\n" +
		"Закройте After Effects и окно Проводника с папкой панели, затем запустите установщик ещё раз. Установленная версия не изменена.",
	damaged:    "Установщик повреждён: внутри нет файлов панели. Скачайте его заново.",
	copyFailed: "Не удалось скопировать панель в папку:\n%s\n\nНичего не изменено.\n\n%s",
	settingFailed: "Панель скопирована, но не удалось включить настройку PlayerDebugMode, без неё After Effects панель не покажет.\n\n" +
		"Откройте «Командную строку» и выполните:\n" +
		`reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f`,
	done: "Sayframe установлен.\n\n" +
		"Если After Effects открыт, сохраните проект, закройте программу и откройте снова.\n" +
		"Панель находится в меню:\nWindow > Extensions > Sayframe\n\n" +
		"Для референсов и вставки картинок включите в After Effects:\n" +
		"Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network",
}

var macWords = wording{
	noExtDir:    "Не удалось найти вашу домашнюю папку, чтобы установить панель.",
	alreadyAsk:  "Sayframe уже установлен.\n\nПереустановить (заменить установленную версию этой) или удалить панель?",
	removeInUse: "Не удалось удалить папку панели.\n\nЗакройте After Effects и запустите установщик ещё раз.",
	removed:     "Sayframe удалён.\n\nПерезапустите After Effects, чтобы панель исчезла из меню. Настройка PlayerDebugMode не тронута: она может быть нужна другим панелям.",
	confirm: "Установить панель Sayframe в After Effects?\n\n" +
		"Установщик:\n" +
		"• скопирует панель в папку расширений Adobe в вашей домашней папке\n" +
		"• разрешит After Effects загружать панели без подписи Adobe (настройка PlayerDebugMode)%s\n\n" +
		"Пароль не потребуется.",
	oldPanelLine: "\n• удалит прежнюю версию этой панели (папку ClaudePanel)",
	inUse: "Не удалось заменить файлы панели.\n\n" +
		"Закройте After Effects и запустите установщик ещё раз. Установленная версия не изменена.",
	damaged:    "Установщик повреждён: внутри нет файлов панели. Скачайте его заново.",
	copyFailed: "Не удалось скопировать панель в папку:\n%s\n\nНичего не изменено.\n\n%s",
	settingFailed: "Панель скопирована, но не удалось включить настройку PlayerDebugMode, без неё After Effects панель не покажет.\n\n" +
		"Откройте «Терминал» и выполните:\n" +
		"defaults write com.adobe.CSXS.12 PlayerDebugMode 1",
	done: "Sayframe установлен.\n\n" +
		"Если After Effects открыт, сохраните проект, полностью закройте программу и откройте снова.\n" +
		"Панель находится в меню:\nWindow > Extensions > Sayframe\n\n" +
		"Для референсов и вставки картинок включите в After Effects:\n" +
		"Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network",
}

// run — весь сценарий установщика. Возвращает код выхода.
func run(d dialogs, m machine, p payload, w wording) int {
	extDir, err := m.extensionsDir()
	if err != nil || extDir == "" {
		d.fail(w.noExtDir)
		return 1
	}
	dest := filepath.Join(extDir, panelName)

	if exists(dest) {
		switch d.chooseInstalled(w.alreadyAsk) {
		case choiceInstall:
			// ниже
		case choiceRemove:
			if err := removePanel(extDir); err != nil {
				d.fail(w.removeInUse)
				return 1
			}
			d.info(w.removed)
			return 0
		default:
			return 0
		}
	} else {
		extra := ""
		if exists(filepath.Join(extDir, oldPanelName)) {
			extra = w.oldPanelLine
		}
		if !d.confirmInstall(fmt.Sprintf(w.confirm, extra)) {
			return 0
		}
	}

	if err := installPanel(p, extDir); err != nil {
		if errors.Is(err, errInUse) {
			d.fail(w.inUse)
		} else if errors.Is(err, errNoPayload) {
			d.fail(w.damaged)
		} else {
			d.fail(fmt.Sprintf(w.copyFailed, extDir, err.Error()))
		}
		return 1
	}
	m.installed(dest)
	if err := m.enableUnsignedPanels(); err != nil {
		d.fail(w.settingFailed)
		return 1
	}
	d.info(w.done)
	return 0
}

func titleFor(version string) string {
	if version == "" {
		return "Sayframe для After Effects"
	}
	return "Sayframe " + version + " для After Effects"
}
