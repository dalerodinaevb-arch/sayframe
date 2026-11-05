/*
 * host_pr.jsx - the Premiere Pro side of Sayframe (ExtendScript, ES3, ASCII only).
 * The same panel runs in Premiere Pro; it loads this file instead of host.jsx and calls these
 * functions through evalScript. Every function returns a JSON string, like host.jsx.
 *
 * Premiere keeps time in ticks: 254016000000 per second. Sequences, tracks and clips replace
 * After Effects' compositions and layers. PR (below) is a small helper library that the scripts
 * Claude writes for Premiere may use.
 */
var TICKS_PER_SECOND = 254016000000;

var PR = (function () {

    function seq() {
        var s = app.project ? app.project.activeSequence : null;
        if (!s) { throw new Error("NO_SEQUENCE"); }
        return s;
    }

    function ticks(sec) { return String(Math.round(Number(sec) * TICKS_PER_SECOND)); }
    function secs(t) {
        if (t === null || t === undefined) { return 0; }
        if (typeof t === "object") {
            if (t.seconds !== undefined) { return Number(t.seconds); }
            if (t.ticks !== undefined) { return Number(t.ticks) / TICKS_PER_SECOND; }
        }
        return Number(t) / TICKS_PER_SECOND;
    }
    // A Time object at sec seconds.
    function time(sec) { var t = new Time(); t.ticks = ticks(sec); return t; }

    function fps(s) {
        var tb = Number((s || seq()).timebase);
        return tb > 0 ? Math.round(TICKS_PER_SECOND / tb * 1000) / 1000 : 30;
    }
    function duration(s) { return secs((s || seq()).end); }
    function playhead(s) { return secs((s || seq()).getPlayerPosition()); }

    // kind "V" or "A", n from 1 (V1 is the lowest video track).
    function track(kind, n, s) {
        var list = (kind === "A" || kind === "a") ? (s || seq()).audioTracks : (s || seq()).videoTracks;
        if (!list || n < 1 || n > list.numTracks) { throw new Error("NO_TRACK"); }
        return list[n - 1];
    }

    function clips(t) {
        var out = [], i;
        for (i = 0; i < t.clips.numItems; i++) { out.push(t.clips[i]); }
        return out;
    }

    // Selected clips of the active sequence (video and audio).
    function selected(s) {
        var sel = (s || seq()).getSelection(), out = [], i;
        if (!sel) { return out; }
        for (i = 0; i < sel.length; i++) { out.push(sel[i]); }
        return out;
    }

    // A bin in the project root with that name (made when missing).
    function bin(name) {
        var root = app.project.rootItem, i, it;
        for (i = 0; i < root.children.numItems; i++) {
            it = root.children[i];
            if (it && it.type === ProjectItemType.BIN && String(it.name) === String(name)) { return it; }
        }
        return root.createBin(String(name));
    }

    // Project item by name (first match, bins searched too).
    function findItem(name, under) {
        var root = under || app.project.rootItem, i, it, r;
        for (i = 0; i < root.children.numItems; i++) {
            it = root.children[i];
            if (!it) { continue; }
            if (String(it.name) === String(name) && it.type !== ProjectItemType.BIN) { return it; }
            if (it.type === ProjectItemType.BIN) { r = findItem(name, it); if (r) { return r; } }
        }
        return null;
    }

    // Imports a file into a bin and returns its project item.
    function importFile(path, binName) {
        var b = binName ? bin(binName) : app.project.getInsertionBin(), before = {}, i, it, f = new File(path), nm;
        for (i = 0; i < b.children.numItems; i++) { before[b.children[i].nodeId] = true; }
        if (!app.project.importFiles([f.fsName], true, b, false)) { throw new Error("IMPORT_FAILED"); }
        for (i = b.children.numItems - 1; i >= 0; i--) {
            it = b.children[i];
            if (it && !before[it.nodeId]) { return it; }
        }
        nm = decodeURI(f.name);
        for (i = 0; i < b.children.numItems; i++) { if (String(b.children[i].name) === nm) { return b.children[i]; } }
        throw new Error("IMPORT_FAILED");
    }

    // Is the track free between a and b seconds?
    function freeAt(t, a, b) {
        var i, c, s, e;
        for (i = 0; i < t.clips.numItems; i++) {
            c = t.clips[i];
            s = secs(c.start); e = secs(c.end);
            if (s < b - 0.0005 && e > a + 0.0005) { return false; }
        }
        return true;
    }

    // The lowest video track that is free from sec for len seconds; a new track on top when none is.
    function freeVideoTrack(sec, len, s) {
        var sq = s || seq(), i, q;
        for (i = 0; i < sq.videoTracks.numTracks; i++) {
            if (!sq.videoTracks[i].isLocked || !sq.videoTracks[i].isLocked()) {
                if (freeAt(sq.videoTracks[i], sec, sec + len)) { return sq.videoTracks[i]; }
            }
        }
        try {
            app.enableQE();
            q = qe.project.getActiveSequence();
            q.addTracks(1, sq.videoTracks.numTracks, 0);
        } catch (e) {}
        if (sq.videoTracks.numTracks > i && freeAt(sq.videoTracks[sq.videoTracks.numTracks - 1], sec, sec + len)) {
            return sq.videoTracks[sq.videoTracks.numTracks - 1];
        }
        throw new Error("NO_FREE_TRACK");
    }

    // Puts a project item on the timeline at sec (default: the playhead), on a free video track.
    function place(item, sec, s) {
        var sq = s || seq(), at = (sec === undefined || sec === null) ? playhead(sq) : Number(sec), len = 5, t;
        try { len = Math.max(0.1, secs(item.getOutPoint()) - secs(item.getInPoint())); } catch (e) {}
        t = freeVideoTrack(at, len, sq);
        t.overwriteClip(item, at);
        return t;
    }

    // A component (effect) of a clip by its display name or match name, e.g. "Motion", "Opacity", "Lumetri Color".
    function component(clip, name) {
        var i, c;
        for (i = 0; i < clip.components.numItems; i++) {
            c = clip.components[i];
            if (String(c.displayName) === name || String(c.matchName) === name) { return c; }
        }
        return null;
    }

    // A parameter of a component by its display name, e.g. param(clip, "Motion", "Scale").
    function param(clip, comp, name) {
        var c = component(clip, comp), i;
        if (!c) { return null; }
        for (i = 0; i < c.properties.numItems; i++) {
            if (String(c.properties[i].displayName) === name) { return c.properties[i]; }
        }
        return null;
    }

    return { seq: seq, ticks: ticks, secs: secs, time: time, fps: fps, duration: duration, playhead: playhead,
        track: track, clips: clips, selected: selected, bin: bin, findItem: findItem, importFile: importFile,
        freeAt: freeAt, freeVideoTrack: freeVideoTrack, place: place, component: component, param: param };
})();

var sayframeHost = (function () {

    // ---------------------------------------------------------------- json

    function jsonString(s) {
        s = String(s);
        var out = ['"'];
        var i, c, code, hex;
        for (i = 0; i < s.length; i++) {
            c = s.charAt(i);
            code = s.charCodeAt(i);
            if (c === '"') { out.push('\\"'); }
            else if (c === "\\") { out.push("\\\\"); }
            else if (code === 10) { out.push("\\n"); }
            else if (code === 13) { out.push("\\r"); }
            else if (code === 9) { out.push("\\t"); }
            else if (code < 32 || code > 126) {
                hex = code.toString(16);
                while (hex.length < 4) { hex = "0" + hex; }
                out.push("\\u" + hex);
            } else { out.push(c); }
        }
        out.push('"');
        return out.join("");
    }

    function toJSON(v) {
        var parts, i, k;
        if (v === null || v === undefined) { return "null"; }
        if (typeof v === "string") { return jsonString(v); }
        if (typeof v === "number") { return isFinite(v) ? String(v) : "null"; }
        if (typeof v === "boolean") { return v ? "true" : "false"; }
        if (v instanceof Array) {
            parts = [];
            for (i = 0; i < v.length; i++) { parts.push(toJSON(v[i])); }
            return "[" + parts.join(",") + "]";
        }
        parts = [];
        for (k in v) {
            if (v.hasOwnProperty(k)) { parts.push(jsonString(k) + ":" + toJSON(v[k])); }
        }
        return "{" + parts.join(",") + "}";
    }

    function reply(fn) {
        var r;
        try {
            r = fn();
            if (!r) { r = {}; }
            r.ok = true;
            return toJSON(r);
        } catch (e) {
            return toJSON({ ok: false, error: (e && e.message) ? e.message : String(e), line: (e && e.line) ? e.line : null });
        }
    }

    function r2(n) { return Math.round(Number(n) * 100) / 100; }

    // ------------------------------------------------------- project state

    var SNAP_MAX_CLIPS = 40;

    function clipLine(c) {
        var sel = false;
        try { sel = !!c.isSelected(); } catch (e) {}
        return "    \"" + c.name + "\" " + r2(PR.secs(c.start)) + "-" + r2(PR.secs(c.end)) + " s" + (sel ? " [selected]" : "");
    }

    function tracksLines(list, kind, lines) {
        var i, j, t, n;
        for (i = 0; i < list.numTracks; i++) {
            t = list[i];
            n = t.clips.numItems;
            lines.push("  " + kind + (i + 1) + (t.name ? " \"" + t.name + "\"" : "") + ": " + n + " clip(s)" +
                ((t.isMuted && t.isMuted()) ? " [muted]" : "") + ((t.isLocked && t.isLocked()) ? " [locked]" : ""));
            for (j = 0; j < n && j < SNAP_MAX_CLIPS; j++) { lines.push(clipLine(t.clips[j])); }
            if (n > SNAP_MAX_CLIPS) { lines.push("    ... " + (n - SNAP_MAX_CLIPS) + " more"); }
        }
    }

    function projectSnapshot() {
        var lines = [], proj = app.project, s, i, root, it, names = [];
        lines.push("Premiere Pro version: " + app.version);
        if (!proj) { lines.push("No project is open."); return lines.join("\n"); }
        lines.push("Project: \"" + proj.name + "\"");
        root = proj.rootItem;
        for (i = 0; root && i < root.children.numItems && i < 30; i++) {
            it = root.children[i];
            names.push((it.type === ProjectItemType.BIN ? "[bin] " : "") + "\"" + it.name + "\"");
        }
        lines.push("Project root: " + (names.length ? names.join(", ") : "empty"));
        lines.push("Sequences: " + proj.sequences.numSequences);
        s = proj.activeSequence;
        if (!s) { lines.push("No sequence is open."); return lines.join("\n"); }
        lines.push("Active sequence: \"" + s.name + "\" " + s.frameSizeHorizontal + "x" + s.frameSizeVertical + ", " + PR.fps(s) + " fps, " +
            r2(PR.duration(s)) + " s long, playhead at " + r2(PR.playhead(s)) + " s");
        try { lines.push("In/out: " + r2(PR.secs(s.getInPointAsTime())) + " - " + r2(PR.secs(s.getOutPointAsTime())) + " s"); } catch (e) {}
        lines.push("Video tracks (V1 is the lowest):");
        tracksLines(s.videoTracks, "V", lines);
        lines.push("Audio tracks:");
        tracksLines(s.audioTracks, "A", lines);
        return lines.join("\n");
    }

    function syntaxError(code) {
        try {
            var f = new Function(code);
            f = null;
            return null;
        } catch (e) {
            return e.toString() + (e.line ? " (line " + e.line + ")" : "");
        }
    }

    // Kept separate so the script's variables do not mix with this file's.
    function executeGenerated(__sayframeCode) {
        var SAYFRAME_CHECK_TIMES;
        eval(__sayframeCode);
        return SAYFRAME_CHECK_TIMES;
    }

    // ------------------------------------------------------- export

    var exEprBase = null;

    function exSafe(s) { return String(s).replace(/[\\\/:\*\?"<>\|]/g, "_").replace(/^\s+|\s+$/g, ""); }

    function exFreeFile(folder, base, ext) {
        var f = new File(folder + "/" + base + ext), n = 2;
        while (f.exists && n < 500) { f = new File(folder + "/" + base + " " + n + ext); n++; }
        return f;
    }

    function exReadText(f) {
        var t = "";
        try { f.encoding = "UTF-8"; if (f.open("r")) { t = f.read(); f.close(); } } catch (e) {}
        return t;
    }

    function exIsH264Epr(t) {
        return t.indexOf("<ParamIdentifier>ADBEVideoTargetBitrate</ParamIdentifier>") >= 0 && t.indexOf("<ExporterClassID>1313424203</ExporterClassID>") >= 0;
    }

    // Premiere's own presets first, then Media Encoder's.
    function exEprDirs() {
        var out = [], p = "", roots = [], i, j, k, ames, apps;
        try { p = String(app.path || ""); } catch (e) {}
        if (p) {
            out.push(new Folder(p + "/MediaIO/systempresets"), new Folder(p + "/Contents/MediaIO/systempresets"),
                new Folder(p + "/../MediaIO/systempresets"));
        }
        roots.push(new Folder("/Applications"), new Folder("C:/Program Files/Adobe"));
        for (i = 0; i < roots.length; i++) {
            if (!roots[i].exists) { continue; }
            ames = roots[i].getFiles(function (f) { return f instanceof Folder && /^Adobe (Media Encoder|Premiere Pro)/i.test(decodeURI(f.name)); }) || [];
            ames.sort(function (a, b) { return decodeURI(a.name) < decodeURI(b.name) ? 1 : -1; });
            for (j = 0; j < ames.length; j++) {
                out.push(new Folder(ames[j].fsName + "/MediaIO/systempresets"));
                apps = ames[j].getFiles(function (f) { return f instanceof Folder && /\.app$/i.test(decodeURI(f.name)); }) || [];
                for (k = 0; k < apps.length; k++) { out.push(new Folder(apps[k].fsName + "/Contents/MediaIO/systempresets")); }
            }
        }
        return out;
    }

    function exFindEpr() {
        var dirs = exEprDirs(), best = null, any = null, seen = 0, i;
        function walk(d, depth) {
            var list, n, f, t, nm;
            if (best || depth > 4 || seen > 600 || !d.exists) { return; }
            list = d.getFiles() || [];
            for (n = 0; n < list.length && !best; n++) {
                f = list[n];
                if (f instanceof Folder) { walk(f, depth + 1); continue; }
                nm = decodeURI(f.name);
                if (!/\.epr$/i.test(nm)) { continue; }
                seen++;
                t = exReadText(f);
                if (!exIsH264Epr(t)) { continue; }
                if (/match source/i.test(nm) && /high bitrate/i.test(nm)) { best = { path: f.fsName, text: t }; }
                else if (!any) { any = { path: f.fsName, text: t }; }
            }
        }
        for (i = 0; i < dirs.length && !best; i++) { walk(dirs[i], 0); }
        return best || any;
    }

    function exEprSet(t, id, val) {
        var k = t.indexOf("<ParamIdentifier>" + id + "</ParamIdentifier>"), a, b, next;
        if (k < 0) { return t; }
        next = t.indexOf("</ExporterParam>", k);
        a = t.indexOf("<ParamValue>", k);
        b = a >= 0 ? t.indexOf("</ParamValue>", a) : -1;
        if (a < 0 || b < 0 || (next >= 0 && a > next)) { return t; }
        return t.substring(0, a + 12) + val + t.substring(b);
    }

    function exHex(n) { var s = "", i; for (i = 0; i < n; i++) { s += "0123456789abcdef".charAt(Math.floor(Math.random() * 16)); } return s; }

    // An H.264 preset with this bitrate and frame size, in the temp folder.
    function exMakeEpr(mbps, w, h, same) {
        var t, f, dir, num = function (v) { return Math.round(v) === v ? v + "." : String(v); };
        if (!exEprBase) { exEprBase = exFindEpr() || false; }
        if (!exEprBase) { return ""; }
        t = exEprBase.text;
        t = exEprSet(t, "ADBEVideoTargetBitrate", num(mbps));
        t = exEprSet(t, "ADBEVideoMaxBitrate", num(Math.round(mbps * 1.25 * 10) / 10));
        t = exEprSet(t, "ADBEVideoMinBitrate", num(Math.max(0.5, Math.round(mbps * 0.5 * 10) / 10)));
        t = exEprSet(t, "ADBEVideoMatchSource", same ? "true" : "false");
        t = exEprSet(t, "ADBEVideoWidth", String(w));
        t = exEprSet(t, "ADBEVideoHeight", String(h));
        t = t.replace(/<PresetID>[^<]*<\/PresetID>/, "<PresetID>" + exHex(8) + "-" + exHex(4) + "-" + exHex(4) + "-" + exHex(4) + "-" + exHex(12) + "</PresetID>");
        t = t.replace(/<PresetName>[^<]*<\/PresetName>/, "<PresetName>Sayframe " + mbps + " Mbps</PresetName>");
        dir = new Folder(Folder.temp.fsName + "/Sayframe");
        if (!dir.exists) { dir.create(); }
        f = new File(dir.fsName + "/Sayframe " + mbps + " Mbps " + w + "x" + h + ".epr");
        f.encoding = "UTF-8";
        if (!f.open("w")) { return ""; }
        f.write(t);
        f.close();
        return f.fsName;
    }

    // The quality levels of the export sheet, as in After Effects' H.264 templates.
    var EX_RATE = { light: 5, normal: 15, max: 40 };

    // ------------------------------------------------------- sequence presets

    function findSqPreset() {
        var p = "", dirs = [], i, found = null, seen = 0;
        try { p = String(app.path || ""); } catch (e) {}
        if (!p) { return null; }
        dirs.push(new Folder(p + "/Settings/SequencePresets"), new Folder(p + "/Contents/Settings/SequencePresets"));
        function walk(d, depth) {
            var list, n, f;
            if (found || depth > 4 || seen > 400 || !d.exists) { return; }
            list = d.getFiles() || [];
            for (n = 0; n < list.length && !found; n++) {
                f = list[n];
                if (f instanceof Folder) { walk(f, depth + 1); continue; }
                seen++;
                if (/\.sqpreset$/i.test(decodeURI(f.name))) { found = f.fsName; }
            }
        }
        for (i = 0; i < dirs.length && !found; i++) { walk(dirs[i], 0); }
        return found;
    }

    function seqByName(name) {
        var list = app.project.sequences, i;
        for (i = list.numSequences - 1; i >= 0; i--) { if (String(list[i].name) === String(name)) { return list[i]; } }
        return null;
    }

    return {

        info: function () {
            return reply(function () {
                var proj = app.project, s = proj ? proj.activeSequence : null;
                return {
                    snapshot: projectSnapshot(),
                    projectPath: (proj && proj.path) ? String(proj.path) : null,
                    activeComp: s ? String(s.name) : null,
                    app: "PPRO",
                    fileAccess: true
                };
            });
        },

        syntax: function (code) {
            return reply(function () { return { error: syntaxError(code) }; });
        },

        // Runs a generated script. Premiere has no undo groups for scripts: each change is its own
        // step in Edit > Undo. Frames of the result are not captured in Premiere yet.
        run: function (code, label, wantFrames, tmpDir) {
            return reply(function () {
                var out = { runError: null, frames: null, compName: null, captureError: null, undone: false };
                try {
                    executeGenerated(code);
                } catch (e) {
                    out.runError = e.toString() + (e.line ? " (line " + e.line + ")" : "");
                }
                try { if (app.project.activeSequence) { out.compName = String(app.project.activeSequence.name); } } catch (e2) {}
                return out;
            });
        },

        reference: function () {
            return reply(function () { throw new Error("REF_NOT_IN_PREMIERE"); });
        },

        // ---- Projects (brand book)

        // Imports a logo into the brand's bin and puts it at the playhead of the open sequence.
        brandLogo: function (path, binName, logoName) {
            return reply(function () {
                var item = PR.importFile(path, binName), s = app.project.activeSequence, t;
                if (!s) { return { comp: null, bin: binName }; }
                t = PR.place(item);
                return { comp: String(s.name), track: String(t.name || ""), bin: binName, pre: "", scale: 100 };
            });
        },

        brandIcon: function (path, binName) {
            return reply(function () {
                var item = PR.importFile(path, binName), s = app.project.activeSequence, t;
                if (!s) { return { comp: null }; }
                t = PR.place(item);
                return { comp: String(s.name), track: String(t.name || "") };
            });
        },

        // A new sequence of the brand's format (w x h, fps). bgHex is not used in Premiere.
        brandComp: function (name, w, h, fps, dur, bgHex, binName) {
            return reply(function () {
                var preset = findSqPreset(), s = null, st, ft;
                if (preset) {
                    app.enableQE();
                    qe.project.newSequence(String(name), preset);
                    s = seqByName(name);
                }
                if (!s) { s = app.project.createNewSequence(String(name), "sayframe-" + new Date().getTime()); }
                if (!s) { throw new Error("NO_NEW_SEQUENCE"); }
                st = s.getSettings();
                st.videoFrameWidth = Number(w);
                st.videoFrameHeight = Number(h);
                try { st.videoPixelAspectRatio = "1"; } catch (e0) {}
                try { ft = new Time(); ft.ticks = String(Math.round(TICKS_PER_SECOND / (Number(fps) || 30))); st.videoFrameRate = ft; } catch (e1) {}
                s.setSettings(st);
                try { if (binName) { s.projectItem.moveBin(PR.bin(binName)); } } catch (e2) {}
                try { app.project.openSequence(s.sequenceID); } catch (e3) {}
                return { name: String(s.name), bg: false };
            });
        },

        brandFilesInUse: function (paths) {
            return reply(function () {
                var used = [], want = {}, i;
                function walk(b) {
                    var j, it, p;
                    for (j = 0; j < b.children.numItems; j++) {
                        it = b.children[j];
                        if (!it) { continue; }
                        if (it.type === ProjectItemType.BIN) { walk(it); continue; }
                        try { p = String(it.getMediaPath() || ""); } catch (e) { p = ""; }
                        if (p && want[p] && used.indexOf(p) < 0) { used.push(p); }
                    }
                }
                for (i = 0; i < (paths || []).length; i++) { want[new File(paths[i]).fsName] = true; want[paths[i]] = true; }
                if (app.project) { walk(app.project.rootItem); }
                return { used: used };
            });
        },

        brandSaveDialog: function (fileName, prompt) {
            return reply(function () {
                var f = new File(Folder.myDocuments.fsName + "/" + fileName), picked = f.saveDlg(prompt);
                return { path: picked ? picked.fsName : null };
            });
        },

        // ---- Quick export

        exportInfo: function () {
            return reply(function () {
                var s = PR.seq(), proj = app.project, folder = "", ame = false, a = 0, b = 0;
                try { folder = new File(String(proj.path)).parent.fsName; } catch (e0) {}
                try { ame = !!(app.encoder && app.encoder.encodeSequence); } catch (e1) {}
                try { a = PR.secs(s.getInPointAsTime()); b = PR.secs(s.getOutPointAsTime()); } catch (e2) {}
                return { comp: { name: String(s.name), w: Number(s.frameSizeHorizontal), h: Number(s.frameSizeVertical), dur: PR.duration(s), fps: PR.fps(s),
                    waStart: a, waDur: Math.max(0, b - a) }, projectFolder: folder, ame: ame, app: "PPRO" };
            });
        },

        // Saves the open sequence as one MP4 (H.264). o = { w, h, label, quality, mbps, span: all|work, folder, ame }.
        // Premiere renders it here (blocks until done); with ame it goes to Media Encoder's queue.
        exportOne: function (o) {
            return reply(function () {
                var s = PR.seq(), w, h, dir, base, file, rate, epr, same, mode, size = 0, span;
                if (!o || typeof o !== "object") { throw new Error("BAD_EXPORT"); }
                w = Math.round(Number(o.w) || s.frameSizeHorizontal); h = Math.round(Number(o.h) || s.frameSizeVertical);
                w -= w % 2; h -= h % 2;
                if (w < 16 || h < 16 || w > 16384 || h > 16384) { throw new Error("BAD_EXPORT_SIZE"); }
                dir = new Folder(String(o.folder));
                if (!dir.exists) { try { dir.create(); } catch (e0) {} }
                if (!dir.exists) { throw new Error("EXPORT_NO_FOLDER"); }
                base = exSafe(String(s.name) + (o.label ? " \u2014 " + o.label : ""));
                rate = Number(o.mbps) > 0 ? Number(o.mbps) : (EX_RATE[o.quality] || 15);
                same = w === Number(s.frameSizeHorizontal) && h === Number(s.frameSizeVertical);
                epr = exMakeEpr(rate, w, h, same);
                if (!epr) { throw new Error("NO_H264"); }
                file = exFreeFile(dir.fsName, base, ".mp4");
                // 0 = the whole sequence, 1 = from the in point to the out point.
                span = o.span === "work" ? 1 : 0;
                if (o.ame && app.encoder && app.encoder.encodeSequence) {
                    try { app.encoder.launchEncoder(); } catch (e1) {}
                    app.encoder.encodeSequence(s, file.fsName, epr, span, 1);
                    try { app.encoder.startBatch(); } catch (e2) {}
                    mode = "ame";
                } else {
                    s.exportAsMediaDirect(file.fsName, epr, span);
                    mode = "ae";
                    try { size = new File(file.fsName).length; } catch (e3) {}
                }
                return { path: file.fsName, name: decodeURI(file.name), size: size, mode: mode, w: w, h: h, wrapped: !same, template: "", mbps: rate };
            });
        },

        exportReveal: function (path) {
            return reply(function () {
                var f = new File(String(path)), d = f.parent;
                if (!d || !d.exists) { throw new Error("EXPORT_NO_FOLDER"); }
                d.execute();
                return {};
            });
        }
    };
})();
