package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const manifestXML = `<ExtensionManifest ExtensionBundleId="com.sayframe.ae" ExtensionBundleVersion="3.4.5">`

func goodFiles() map[string]string {
	return map[string]string{
		"Sayframe/CSXS/manifest.xml": manifestXML,
		"Sayframe/index.html":        "<html>панель</html>",
		"Sayframe/js/panel.js":       "var a = 1;",
		"Sayframe/jsx/host.jsx":      "var sayframeHost = {};",
	}
}

func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(body))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func reader(t *testing.T, files map[string]string) payload {
	t.Helper()
	b := zipBytes(t, files)
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	return zipPayload{zr}
}

// folder writes the files into a temporary folder, as the panel lies inside the Mac app, and returns it as a payload.
func folder(t *testing.T, files map[string]string) payload {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		target := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(name, payloadPrefix)))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p, err := openDirPayload(dir)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

type fakeDialogs struct {
	answer            choice
	confirms, chooses []string
	infos, fails      []string
}

func (f *fakeDialogs) confirmInstall(text string) bool {
	f.confirms = append(f.confirms, text)
	return f.answer == choiceInstall
}
func (f *fakeDialogs) chooseInstalled(text string) choice {
	f.chooses = append(f.chooses, text)
	return f.answer
}
func (f *fakeDialogs) info(text string) { f.infos = append(f.infos, text) }
func (f *fakeDialogs) fail(text string) { f.fails = append(f.fails, text) }

type fakeMachine struct {
	dir      string
	dirErr   error
	regErr   error
	regCalls int
	prepared []string
}

func (m *fakeMachine) extensionsDir() (string, error) { return m.dir, m.dirErr }
func (m *fakeMachine) enableUnsignedPanels() error    { m.regCalls++; return m.regErr }
func (m *fakeMachine) installed(dest string)          { m.prepared = append(m.prepared, dest) }

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(b)
}

func leftovers(dir string) []string {
	var out []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".Sayframe") {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestFreshInstall(t *testing.T) {
	ext := filepath.Join(t.TempDir(), "Adobe", "CEP", "extensions")
	d, m := &fakeDialogs{answer: choiceInstall}, &fakeMachine{dir: ext}
	if code := run(d, m, reader(t, goodFiles()), windowsWords); code != 0 {
		t.Fatalf("exit code %d, fails %v", code, d.fails)
	}
	for name, body := range goodFiles() {
		if got := read(t, filepath.Join(ext, filepath.FromSlash(name))); got != body {
			t.Errorf("%s: got %q", name, got)
		}
	}
	if len(d.confirms) != 1 || len(d.chooses) != 0 || len(d.infos) != 1 || len(d.fails) != 0 {
		t.Errorf("dialogs: %+v", d)
	}
	if !strings.Contains(d.infos[0], "Sayframe установлен") || strings.Contains(d.confirms[0], "ClaudePanel") {
		t.Errorf("texts: %q / %q", d.infos[0], d.confirms[0])
	}
	if m.regCalls != 1 {
		t.Errorf("setting written %d times", m.regCalls)
	}
	if len(m.prepared) != 1 || m.prepared[0] != filepath.Join(ext, panelName) {
		t.Errorf("installed hook: %v", m.prepared)
	}
	if l := leftovers(ext); len(l) != 0 {
		t.Errorf("leftovers: %v", l)
	}
}

func TestCancelTouchesNothing(t *testing.T) {
	root := t.TempDir()
	ext := filepath.Join(root, "ext")
	d, m := &fakeDialogs{answer: choiceCancel}, &fakeMachine{dir: ext}
	if code := run(d, m, reader(t, goodFiles()), windowsWords); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if exists(ext) || m.regCalls != 0 || len(d.infos)+len(d.fails) != 0 {
		t.Errorf("something happened after cancel: exists=%v reg=%d", exists(ext), m.regCalls)
	}
}

func installed(t *testing.T) (string, string) {
	t.Helper()
	ext := filepath.Join(t.TempDir(), "ext")
	dest := filepath.Join(ext, panelName)
	os.MkdirAll(filepath.Join(dest, "CSXS"), 0o755)
	os.WriteFile(filepath.Join(dest, "CSXS", "manifest.xml"), []byte("old"), 0o644)
	os.WriteFile(filepath.Join(dest, "stale.txt"), []byte("stale"), 0o644)
	return ext, dest
}

func TestReinstallReplacesOldFiles(t *testing.T) {
	ext, dest := installed(t)
	d, m := &fakeDialogs{answer: choiceInstall}, &fakeMachine{dir: ext}
	if code := run(d, m, reader(t, goodFiles()), windowsWords); code != 0 {
		t.Fatalf("exit code %d, fails %v", code, d.fails)
	}
	if exists(filepath.Join(dest, "stale.txt")) || read(t, filepath.Join(dest, "CSXS", "manifest.xml")) != manifestXML {
		t.Error("old files were not replaced")
	}
	if len(d.chooses) != 1 || len(d.confirms) != 0 || len(leftovers(ext)) != 0 {
		t.Errorf("dialogs %+v leftovers %v", d, leftovers(ext))
	}
}

func TestInstalledCancelKeepsPanel(t *testing.T) {
	ext, dest := installed(t)
	d, m := &fakeDialogs{answer: choiceCancel}, &fakeMachine{dir: ext}
	if code := run(d, m, reader(t, goodFiles()), windowsWords); code != 0 || !exists(filepath.Join(dest, "stale.txt")) || m.regCalls != 0 {
		t.Errorf("code %d, panel kept %v, reg %d", code, exists(dest), m.regCalls)
	}
}

func TestRemove(t *testing.T) {
	ext, dest := installed(t)
	d, m := &fakeDialogs{answer: choiceRemove}, &fakeMachine{dir: ext}
	if code := run(d, m, reader(t, goodFiles()), windowsWords); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if exists(dest) || m.regCalls != 0 || len(d.infos) != 1 || !strings.Contains(d.infos[0], "Sayframe удалён") || len(leftovers(ext)) != 0 {
		t.Errorf("exists=%v reg=%d infos=%v leftovers=%v", exists(dest), m.regCalls, d.infos, leftovers(ext))
	}
}

func TestOldClaudePanelRemovedAndAnnounced(t *testing.T) {
	ext := filepath.Join(t.TempDir(), "ext")
	old := filepath.Join(ext, oldPanelName)
	os.MkdirAll(old, 0o755)
	os.WriteFile(filepath.Join(old, "a"), []byte("x"), 0o644)
	d, m := &fakeDialogs{answer: choiceInstall}, &fakeMachine{dir: ext}
	if code := run(d, m, reader(t, goodFiles()), windowsWords); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if exists(old) || !strings.Contains(d.confirms[0], "ClaudePanel") {
		t.Errorf("old panel exists=%v, text %q", exists(old), d.confirms[0])
	}
	// отмена не трогает прежнюю панель
	ext2 := filepath.Join(t.TempDir(), "ext")
	os.MkdirAll(filepath.Join(ext2, oldPanelName), 0o755)
	run(&fakeDialogs{answer: choiceCancel}, &fakeMachine{dir: ext2}, reader(t, goodFiles()), windowsWords)
	if !exists(filepath.Join(ext2, oldPanelName)) {
		t.Error("old panel removed on cancel")
	}
}

func TestUnsafePathsRejected(t *testing.T) {
	for _, evil := range []string{"Sayframe/../evil.js", "Sayframe/js/../../evil.js", "Sayframe//etc/evil", "Sayframe/.hidden",
		`Sayframe/js\evil.js`, "Sayframe/C:/evil.js", "Sayframe/a b.js", "Sayframe/ф.js"} {
		root := t.TempDir()
		ext, dest := filepath.Join(root, "ext"), filepath.Join(root, "ext", panelName)
		os.MkdirAll(filepath.Join(dest, "CSXS"), 0o755)
		os.WriteFile(filepath.Join(dest, "CSXS", "manifest.xml"), []byte("old"), 0o644)
		files := goodFiles()
		files[evil] = "evil"
		d, m := &fakeDialogs{answer: choiceInstall}, &fakeMachine{dir: ext}
		if code := run(d, m, reader(t, files), windowsWords); code != 1 || len(d.fails) != 1 {
			t.Errorf("%q: code %d fails %v", evil, code, d.fails)
		}
		if read(t, filepath.Join(dest, "CSXS", "manifest.xml")) != "old" || len(leftovers(ext)) != 0 || m.regCalls != 0 {
			t.Errorf("%q: installed panel changed or leftovers %v", evil, leftovers(ext))
		}
		if exists(filepath.Join(root, "evil.js")) || exists(filepath.Join(ext, "evil.js")) {
			t.Errorf("%q: file escaped the panel folder", evil)
		}
	}
}

func TestSafeRel(t *testing.T) {
	for _, ok := range []string{"index.html", "CSXS/manifest.xml", "js/panel.js", "a/b/c/d-e_f.g.h"} {
		if !safeRel(ok) {
			t.Errorf("%q should be allowed", ok)
		}
	}
	for _, bad := range []string{"", "/a", "a/", "a//b", "..", "a/../b", ".a", "a/.b", `a\b`, "C:a", "a b", strings.Repeat("a", 201)} {
		if safeRel(bad) {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestSettingFailureIsReported(t *testing.T) {
	ext := filepath.Join(t.TempDir(), "ext")
	d, m := &fakeDialogs{answer: choiceInstall}, &fakeMachine{dir: ext, regErr: errors.New("denied")}
	if code := run(d, m, reader(t, goodFiles()), windowsWords); code != 1 || len(d.fails) != 1 || len(d.infos) != 0 || !strings.Contains(d.fails[0], "PlayerDebugMode") {
		t.Errorf("code %d fails %v infos %v", code, d.fails, d.infos)
	}
}

func TestNoExtensionsFolder(t *testing.T) {
	d := &fakeDialogs{answer: choiceInstall}
	if code := run(d, &fakeMachine{dirErr: errors.New("no appdata")}, reader(t, goodFiles()), windowsWords); code != 1 || len(d.fails) != 1 {
		t.Errorf("code %d fails %v", code, d.fails)
	}
}

func TestPanelInUseKeepsInstalledVersion(t *testing.T) {
	ext, dest := installed(t)
	rename = func(a, b string) error { return errors.New("sharing violation") }
	defer func() { rename = os.Rename }()
	d, m := &fakeDialogs{answer: choiceInstall}, &fakeMachine{dir: ext}
	if code := run(d, m, reader(t, goodFiles()), windowsWords); code != 1 || len(d.fails) != 1 || !strings.Contains(d.fails[0], "Закройте After Effects") {
		t.Fatalf("code %d fails %v", code, d.fails)
	}
	if read(t, filepath.Join(dest, "stale.txt")) != "stale" || len(leftovers(ext)) != 0 || m.regCalls != 0 {
		t.Errorf("installed version changed; leftovers %v", leftovers(ext))
	}
	d = &fakeDialogs{answer: choiceRemove}
	if code := run(d, m, reader(t, goodFiles()), windowsWords); code != 1 || !exists(dest) || len(d.fails) != 1 {
		t.Errorf("remove while in use: code %d exists %v", code, exists(dest))
	}
}

func TestFailureWhilePlacingRestoresOldVersion(t *testing.T) {
	ext, dest := installed(t)
	calls := 0
	rename = func(a, b string) error {
		calls++
		if calls == 2 { // второй шаг: временная папка -> место панели
			return errors.New("disk error")
		}
		return os.Rename(a, b)
	}
	defer func() { rename = os.Rename }()
	d := &fakeDialogs{answer: choiceInstall}
	if code := run(d, &fakeMachine{dir: ext}, reader(t, goodFiles()), windowsWords); code != 1 || len(d.fails) != 1 {
		t.Fatalf("code %d fails %v", code, d.fails)
	}
	if read(t, filepath.Join(dest, "stale.txt")) != "stale" || len(leftovers(ext)) != 0 {
		t.Errorf("old version not restored; leftovers %v", leftovers(ext))
	}
}

func TestOpenPayloadAppendedToProgram(t *testing.T) {
	dir := t.TempDir()
	stub := bytes.Repeat([]byte("MZ\x90\x00stub-bytes"), 5000)
	exe := filepath.Join(dir, "installer.exe")
	os.WriteFile(exe, append(append([]byte{}, stub...), zipBytes(t, goodFiles())...), 0o755)
	zr, c, err := openPayload(exe)
	if err != nil {
		t.Fatalf("payload not found: %v", err)
	}
	defer c.Close()
	if v := zr.version(); v != "3.4.5" {
		t.Errorf("version %q", v)
	}
	if titleFor("3.4.5") != "Sayframe 3.4.5 для After Effects" || titleFor("") != "Sayframe для After Effects" {
		t.Error("title")
	}
	n, err := zr.extract(filepath.Join(dir, "out"))
	if err != nil || n != 4 || read(t, filepath.Join(dir, "out", "index.html")) != "<html>панель</html>" {
		t.Errorf("extract: n=%d err=%v", n, err)
	}

	bare := filepath.Join(dir, "bare.exe")
	os.WriteFile(bare, stub, 0o755)
	if _, _, err := openPayload(bare); !errors.Is(err, errNoPayload) {
		t.Errorf("program without payload: %v", err)
	}
	other := filepath.Join(dir, "other.exe")
	os.WriteFile(other, append(append([]byte{}, stub...), zipBytes(t, map[string]string{"readme.txt": "x"})...), 0o755)
	if _, _, err := openPayload(other); !errors.Is(err, errNoPayload) {
		t.Errorf("zip without the panel: %v", err)
	}
	if _, _, err := openPayload(filepath.Join(dir, "missing.exe")); err == nil {
		t.Error("missing file should fail")
	}
}

// Проверка готового установщика из downloads/: путь к нему и к папке панели задаёт tests/windows-installer.test.sh.
func TestReleasedInstallerCarriesThePanel(t *testing.T) {
	exe, panel := os.Getenv("SAYFRAME_REAL_EXE"), os.Getenv("SAYFRAME_PANEL_DIR")
	if exe == "" || panel == "" {
		t.Skip("SAYFRAME_REAL_EXE / SAYFRAME_PANEL_DIR are not set")
	}
	zr, c, err := openPayload(exe)
	if err != nil {
		t.Fatalf("released installer has no payload: %v", err)
	}
	defer c.Close()
	if v := zr.version(); v == "" {
		t.Error("no version in the payload manifest")
	}
	ext := filepath.Join(t.TempDir(), "ext")
	d := &fakeDialogs{answer: choiceInstall}
	if code := run(d, &fakeMachine{dir: ext}, zr, windowsWords); code != 0 {
		t.Fatalf("install from the released file failed: %v", d.fails)
	}
	want := 0
	err = filepath.Walk(panel, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(panel, p)
		want++
		if read(t, filepath.Join(ext, panelName, rel)) != read(t, p) {
			t.Errorf("%s differs from the panel source", rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got := 0
	filepath.Walk(filepath.Join(ext, panelName), func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			got++
		}
		return nil
	})
	if got != want || want == 0 {
		t.Errorf("installed %d files, the panel has %d", got, want)
	}
}

// ---- Mac: the panel is a folder next to the program, and the wording differs

func TestMacInstallFromFolder(t *testing.T) {
	ext := filepath.Join(t.TempDir(), "Library", "Application Support", "Adobe", "CEP", "extensions")
	files := goodFiles()
	p := folder(t, files)
	os.WriteFile(filepath.Join(p.(dirPayload).dir, ".DS_Store"), []byte("finder"), 0o644) // Finder litter must not be installed
	if p.version() != "3.4.5" {
		t.Errorf("version %q", p.version())
	}
	d, m := &fakeDialogs{answer: choiceInstall}, &fakeMachine{dir: ext}
	if code := run(d, m, p, macWords); code != 0 {
		t.Fatalf("exit code %d, fails %v", code, d.fails)
	}
	for name, body := range files {
		if got := read(t, filepath.Join(ext, filepath.FromSlash(name))); got != body {
			t.Errorf("%s: got %q", name, got)
		}
	}
	if exists(filepath.Join(ext, panelName, ".DS_Store")) || len(leftovers(ext)) != 0 {
		t.Error(".DS_Store or temp folders were left in the extensions folder")
	}
	if !strings.Contains(d.confirms[0], "домашней папке") || strings.Contains(d.confirms[0], "Windows") || strings.Contains(d.confirms[0], "%") {
		t.Errorf("confirm text: %q", d.confirms[0])
	}
	if !strings.Contains(d.infos[0], "Settings > Scripting & Expressions") || strings.Contains(d.infos[0], "Edit > Preferences") {
		t.Errorf("done text: %q", d.infos[0])
	}
	// reinstall over it, then remove
	os.WriteFile(filepath.Join(ext, panelName, "stale.txt"), []byte("x"), 0o644)
	d = &fakeDialogs{answer: choiceInstall}
	if code := run(d, m, p, macWords); code != 0 || exists(filepath.Join(ext, panelName, "stale.txt")) || len(d.chooses) != 1 {
		t.Errorf("reinstall: code %d", code)
	}
	d = &fakeDialogs{answer: choiceRemove}
	if code := run(d, m, p, macWords); code != 0 || exists(filepath.Join(ext, panelName)) || !strings.Contains(d.infos[0], "Sayframe удалён") {
		t.Errorf("remove: code %d infos %v", code, d.infos)
	}
}

func TestMacWordingForFailures(t *testing.T) {
	ext, _ := installed(t)
	rename = func(a, b string) error { return errors.New("busy") }
	d := &fakeDialogs{answer: choiceInstall}
	code := run(d, &fakeMachine{dir: ext}, folder(t, goodFiles()), macWords)
	rename = os.Rename
	if code != 1 || !strings.Contains(d.fails[0], "Закройте After Effects") || strings.Contains(d.fails[0], "Проводник") {
		t.Errorf("in use: %d %v", code, d.fails)
	}
	d = &fakeDialogs{answer: choiceInstall}
	code = run(d, &fakeMachine{dir: filepath.Join(t.TempDir(), "e"), regErr: errors.New("x")}, folder(t, goodFiles()), macWords)
	if code != 1 || !strings.Contains(d.fails[0], "defaults write com.adobe.CSXS.12 PlayerDebugMode 1") || strings.Contains(d.fails[0], "reg add") {
		t.Errorf("setting failure: %d %v", code, d.fails)
	}
	d = &fakeDialogs{answer: choiceInstall}
	if code := run(d, &fakeMachine{dirErr: errors.New("no home")}, folder(t, goodFiles()), macWords); code != 1 || len(d.fails) != 1 {
		t.Errorf("no home: %d %v", code, d.fails)
	}
}

func TestFolderPayloadRejectsBadContent(t *testing.T) {
	if _, err := openDirPayload(t.TempDir()); !errors.Is(err, errNoPayload) {
		t.Errorf("empty folder: %v", err)
	}
	if _, err := openDirPayload(filepath.Join(t.TempDir(), "missing")); !errors.Is(err, errNoPayload) {
		t.Errorf("missing folder: %v", err)
	}
	for _, evil := range []string{"Sayframe/a b.js", "Sayframe/.hidden", "Sayframe/ф.js"} {
		root := t.TempDir()
		ext := filepath.Join(root, "ext")
		files := goodFiles()
		files[evil] = "evil"
		d, m := &fakeDialogs{answer: choiceInstall}, &fakeMachine{dir: ext}
		if code := run(d, m, folder(t, files), macWords); code != 1 || len(d.fails) != 1 || exists(filepath.Join(ext, panelName)) || len(leftovers(ext)) != 0 || m.regCalls != 0 {
			t.Errorf("%q: code %d fails %v", evil, code, d.fails)
		}
	}
	// a symlink inside the panel folder is refused rather than followed
	files := goodFiles()
	p := folder(t, files)
	if err := os.Symlink("/etc/hosts", filepath.Join(p.(dirPayload).dir, "link.txt")); err == nil {
		ext := filepath.Join(t.TempDir(), "ext")
		d := &fakeDialogs{answer: choiceInstall}
		if code := run(d, &fakeMachine{dir: ext}, p, macWords); code != 1 || exists(filepath.Join(ext, panelName)) {
			t.Errorf("symlink: code %d", code)
		}
	}
}

func TestWordingIsComplete(t *testing.T) {
	for name, w := range map[string]wording{"windows": windowsWords, "mac": macWords} {
		for field, text := range map[string]string{"noExtDir": w.noExtDir, "alreadyAsk": w.alreadyAsk, "removeInUse": w.removeInUse, "removed": w.removed,
			"confirm": w.confirm, "oldPanelLine": w.oldPanelLine, "inUse": w.inUse, "damaged": w.damaged, "copyFailed": w.copyFailed, "settingFailed": w.settingFailed, "done": w.done} {
			if strings.TrimSpace(text) == "" {
				t.Errorf("%s wording: %s is empty", name, field)
			}
		}
		if strings.Count(w.confirm, "%s") != 1 || strings.Count(w.copyFailed, "%s") != 2 {
			t.Errorf("%s wording: placeholders are wrong", name)
		}
	}
}
