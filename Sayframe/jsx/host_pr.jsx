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
        var dirs = exEprDirs(), best = null, any = null, seen = 0, i, j, h264;
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
        // H.264 presets live in a folder named after the exporter (4E49434B = 1313424203): look there first,
        // so the hundreds of other presets cannot use up the search before it reaches them.
        for (i = 0; i < dirs.length && !best; i++) {
            if (!dirs[i].exists) { continue; }
            h264 = dirs[i].getFiles(function (f) { return f instanceof Folder && /^4E49434B/i.test(decodeURI(f.name)); }) || [];
            for (j = 0; j < h264.length && !best; j++) { walk(h264[j], 0); }
        }
        seen = 0;
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

    // ------------------------------------------------------- Montage tab (sounds, motions, transitions)
    // Premiere has no expressions: motions and our transitions are baked into keys on the clips' own
    // Motion and Opacity (and a Gaussian Blur added through QE when the look needs blur). Key times of a
    // clip's parameter are in the clip's media time, so a sequence time t is clip.inPoint + (t - clip.start).

    function mtComp(clip, names) {
        var i, c, j, dn, mn;
        for (i = 0; i < clip.components.numItems; i++) {
            c = clip.components[i];
            dn = String(c.displayName); mn = String(c.matchName);
            for (j = 0; j < names.length; j++) { if (dn === names[j] || mn === names[j]) { return c; } }
        }
        return null;
    }

    // A parameter by one of its display names (English or the localized one), else by its place.
    function mtParam(comp, names, index) {
        var i, j, p;
        if (!comp) { return null; }
        for (i = 0; i < comp.properties.numItems; i++) {
            p = comp.properties[i];
            for (j = 0; j < names.length; j++) { if (String(p.displayName) === names[j]) { return p; } }
        }
        return index < comp.properties.numItems ? comp.properties[index] : null;
    }

    var MT_MOTION = ["AE.ADBE Motion", "Motion", "\u0414\u0432\u0438\u0436\u0435\u043d\u0438\u0435"];
    var MT_OPACITY = ["AE.ADBE Opacity", "Opacity", "\u041d\u0435\u043f\u0440\u043e\u0437\u0440\u0430\u0447\u043d\u043e\u0441\u0442\u044c"];
    var MT_BLUR = ["AE.ADBE Gaussian Blur 2", "Gaussian Blur", "\u0420\u0430\u0437\u043c\u044b\u0442\u0438\u0435 \u043f\u043e \u0413\u0430\u0443\u0441\u0441\u0443"];

    // { pos, scale, scaleW, uniform, rot, op } of a video clip.
    function mtProps(clip) {
        var m = mtComp(clip, MT_MOTION), o = mtComp(clip, MT_OPACITY);
        return {
            pos: mtParam(m, ["Position", "\u041f\u043e\u043b\u043e\u0436\u0435\u043d\u0438\u0435"], 0),
            scale: mtParam(m, ["Scale", "Scale Height", "\u041c\u0430\u0441\u0448\u0442\u0430\u0431"], 1),
            scaleW: mtParam(m, ["Scale Width", "\u0428\u0438\u0440\u0438\u043d\u0430 \u043c\u0430\u0441\u0448\u0442\u0430\u0431\u0430"], 2),
            uniform: mtParam(m, ["Uniform Scale", "\u0420\u0430\u0432\u043d\u043e\u043c\u0435\u0440\u043d\u043e\u0435 \u043c\u0430\u0441\u0448\u0442\u0430\u0431\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435"], 3),
            rot: mtParam(m, ["Rotation", "\u041f\u043e\u0432\u043e\u0440\u043e\u0442"], 4),
            op: mtParam(o, ["Opacity", "\u041d\u0435\u043f\u0440\u043e\u0437\u0440\u0430\u0447\u043d\u043e\u0441\u0442\u044c"], 0)
        };
    }

    function mtMediaTime(clip, t) { return PR.secs(clip.inPoint) + (t - PR.secs(clip.start)); }

    // The parameter's value at sequence time t (its own keys respected).
    function mtBase(p, clip, t) {
        var v;
        try { v = p.isTimeVarying() ? p.getValueAtTime(PR.time(mtMediaTime(clip, t))) : p.getValue(); } catch (e) { v = p.getValue(); }
        return v;
    }

    function mtClear(p, clip, a, b) {
        if (!p) { return; }
        try { if (p.isTimeVarying()) { p.removeKeyRange(PR.time(mtMediaTime(clip, a) - 0.0001), PR.time(mtMediaTime(clip, b) + 0.0001), true); } } catch (e) {}
    }

    // Writes keys [[seqTime, value], ...] on p (linear between them).
    function mtKeys(p, clip, keys) {
        var i, tm;
        if (!p || !keys.length) { return; }
        if (!p.isTimeVarying()) { p.setTimeVarying(true); }
        for (i = 0; i < keys.length; i++) {
            tm = PR.time(mtMediaTime(clip, keys[i][0]));
            p.addKey(tm);
            p.setValueAtKey(tm, keys[i][1], true);
            try { p.setInterpolationTypeAtKey(tm, 0, true); } catch (e) {}
        }
    }

    // Is a Position value normalized (0..1 of the frame, Premiere 2015+) or in pixels?
    function mtNormalized(v) { return v && v.length >= 2 && Math.abs(v[0]) <= 2 && Math.abs(v[1]) <= 2; }

    function mtTrackIndex(list, clip) {
        var i, j, t, c;
        for (i = 0; i < list.numTracks; i++) {
            t = list[i];
            for (j = 0; j < t.clips.numItems; j++) {
                c = t.clips[j];
                if (c === clip || (String(c.name) === String(clip.name) && Math.abs(PR.secs(c.start) - PR.secs(clip.start)) < 0.0005)) { return i; }
            }
        }
        return -1;
    }

    function qeSecs(x) {
        if (x === null || x === undefined) { return NaN; }
        if (typeof x === "object") {
            if (x.ticks !== undefined) { return Number(x.ticks) / TICKS_PER_SECOND; }
            if (x.secs !== undefined) { return Number(x.secs); }
        }
        return Number(x);
    }

    // The QE item of a video clip (QE lists the gaps too, so it is found by name and start).
    function qeItem(trackIndex, clip) {
        var q, tr, i, it;
        app.enableQE();
        q = qe.project.getActiveSequence();
        tr = q.getVideoTrackAt(trackIndex);
        for (i = 0; i < tr.numItems; i++) {
            it = tr.getItemAt(i);
            if (!it || String(it.type) === "Empty") { continue; }
            if (String(it.name) === String(clip.name) && Math.abs(qeSecs(it.start) - PR.secs(clip.start)) < 0.02) { return it; }
        }
        return null;
    }

    function qeByNames(kind, names) {
        var i, x;
        for (i = 0; i < names.length; i++) {
            try { x = kind === "fx" ? qe.project.getVideoEffectByName(names[i]) : qe.project.getVideoTransitionByName(names[i]); } catch (e) { x = null; }
            if (x) { return x; }
        }
        return null;
    }

    // The Blurriness parameter of the clip's Gaussian Blur (added through QE when missing), or null.
    function mtBlur(clip, trackIndex) {
        var c = mtComp(clip, MT_BLUR), it, fx;
        if (!c) {
            try {
                it = qeItem(trackIndex, clip);
                fx = qeByNames("fx", MT_BLUR.slice(1));
                if (it && fx) { it.addVideoEffect(fx); }
            } catch (e) {}
            c = mtComp(clip, MT_BLUR);
        }
        return c ? mtParam(c, ["Blurriness", "\u0420\u0430\u0437\u043c\u044b\u0442\u0438\u0435"], 0) : null;
    }

    function mtSelectedVideo(s) {
        var sel = PR.selected(s), out = [], i, ti;
        for (i = 0; i < sel.length; i++) {
            ti = mtTrackIndex(s.videoTracks, sel[i]);
            if (ti >= 0) { out.push({ clip: sel[i], track: ti }); }
        }
        return out;
    }

    function mtSelectedAudio(s) {
        var sel = PR.selected(s), out = [], i, ti;
        for (i = 0; i < sel.length; i++) {
            ti = mtTrackIndex(s.audioTracks, sel[i]);
            if (ti >= 0) { out.push({ clip: sel[i], track: ti }); }
        }
        return out;
    }

    // ---- Sounds

    var MT_VOLUME = ["Volume", "\u0413\u0440\u043e\u043c\u043a\u043e\u0441\u0442\u044c"];

    // Premiere keeps clip volume as a gain: 0 dB = 0.1778 (= 10^(-15/20)).
    function dbToLevel(db) { return Math.pow(10, (Number(db) - 15) / 20); }
    function levelToDb(v) { return Number(v) > 0 ? Math.round((20 * Math.log(Number(v)) / Math.LN10 + 15) * 10) / 10 : -96; }

    function mtLevel(clip) {
        var c = mtComp(clip, MT_VOLUME), i;
        if (!c) {
            for (i = 0; i < clip.components.numItems; i++) {
                if (/volume/i.test(String(clip.components[i].matchName))) { c = clip.components[i]; break; }
            }
        }
        return c ? mtParam(c, ["Level", "\u0423\u0440\u043e\u0432\u0435\u043d\u044c"], 1) : null;
    }

    function itemByMedia(path, binName) {
        var b = PR.bin(binName), i, it, want = new File(path).fsName;
        for (i = 0; i < b.children.numItems; i++) {
            it = b.children[i];
            try { if (it && new File(String(it.getMediaPath())).fsName === want) { return it; } } catch (e) {}
        }
        return null;
    }

    // The lowest audio track free from sec for len seconds; a new one when none is.
    function freeAudioTrack(sec, len, s) {
        var i, q;
        for (i = 0; i < s.audioTracks.numTracks; i++) {
            if (!(s.audioTracks[i].isLocked && s.audioTracks[i].isLocked()) && PR.freeAt(s.audioTracks[i], sec, sec + len)) { return s.audioTracks[i]; }
        }
        try {
            app.enableQE();
            q = qe.project.getActiveSequence();
            q.addTracks(0, 0, 1, 1, s.audioTracks.numTracks);
        } catch (e) {}
        if (s.audioTracks.numTracks > i && PR.freeAt(s.audioTracks[s.audioTracks.numTracks - 1], sec, sec + len)) {
            return s.audioTracks[s.audioTracks.numTracks - 1];
        }
        throw new Error("NO_FREE_TRACK");
    }

    function clipAt(track, item, at) {
        var i, c;
        for (i = track.clips.numItems - 1; i >= 0; i--) {
            c = track.clips[i];
            if (Math.abs(PR.secs(c.start) - at) < 0.02) { return c; }
        }
        return null;
    }

    function putSound(s, track, path, binName, at, vol, name) {
        var item = itemByMedia(path, binName), reused = !!item, len = 1, c, lv;
        if (!item) { item = PR.importFile(path, binName); }
        try { len = Math.max(0.05, PR.secs(item.getOutPoint()) - PR.secs(item.getInPoint())); } catch (e) {}
        if (!track) { track = freeAudioTrack(at, len, s); }
        track.overwriteClip(item, at);
        c = clipAt(track, item, at);
        if (c) {
            try { if (name) { c.name = name; } } catch (e1) {}
            lv = mtLevel(c);
            if (lv) { try { lv.setValue(dbToLevel(vol), true); } catch (e2) {} }
        }
        return { track: track, reused: reused };
    }

    // ---- Motions: the same shapes and curves as in After Effects (host.jsx SF_MOTIONS).

    var MT_MOTIONS = {
        "fade": { op: 0 }, "from-bottom": { op: 0, dy: 1 }, "from-top": { op: 0, dy: -1 }, "from-left": { op: 0, dx: -1 }, "from-right": { op: 0, dx: 1 },
        "scale-up": { op: 0, sc: 0 }, "scale-down": { op: 0, sc: 200 }, "rotate": { op: 0, rot: -90 }, "spin": { op: 0, rot: -360, sc: 0 },
        "blur": { op: 0, blur: 40 }, "blur-scale": { op: 0, blur: 30, sc: 130 }, "rise-rotate": { op: 0, dy: 1, rot: -20 },
        "rise-scale": { op: 0, dy: 1, sc: 60 }, "stretch": { op: 0, scx: 300, scy: 20 }, "drop": { dy: -1, far: true }
    };

    function mtCurve(p, c) {
        var s, q, n, d;
        p = Math.min(1, Math.max(0, p));
        if (c === "linear") { return p; }
        if (c === "over") { s = 1.70158; q = p - 1; return 1 + (s + 1) * q * q * q + s * q * q; }
        if (c === "bounce") {
            n = 7.5625; d = 2.75;
            if (p < 1 / d) { return n * p * p; }
            if (p < 2 / d) { p -= 1.5 / d; return n * p * p + 0.75; }
            if (p < 2.5 / d) { p -= 2.25 / d; return n * p * p + 0.9375; }
            p -= 2.625 / d; return n * p * p + 0.984375;
        }
        if (c === "elastic") { if (p <= 0 || p >= 1) { return p; } return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * 2 * Math.PI / 3) + 1; }
        return 1 - Math.pow(1 - p, 3);
    }

    // Sample times of one window: every frame (two keys for a straight line).
    function mtTimes(a, b, curve, fd) {
        var out = [], n, i;
        if (curve === "linear") { return [a, b]; }
        n = Math.max(2, Math.round((b - a) / fd));
        for (i = 0; i <= n; i++) { out.push(a + (b - a) * i / n); }
        return out;
    }

    function mtMotionOnClip(s, clip, track, m, curve, mode, dur) {
        var P = mtProps(clip), a0 = PR.secs(clip.start), b0 = PR.secs(clip.end), fd = 1 / PR.fps(s), len = b0 - a0;
        var W = Number(s.frameSizeHorizontal) || 1920, H = Number(s.frameSizeVertical) || 1080, wins = [], w, i, j, ts, k, p;
        var dist = H * (m.far ? 0.6 : 0.2), keys, base, kAt, put, blurP = null, noBlur = false, norm;
        var d = Math.min(Number(dur) || 0.6, mode === "both" ? len / 2 : len);
        if (mode === "in" || mode === "both") { wins.push({ a: a0, b: a0 + d, dir: "in" }); }
        if (mode === "out" || mode === "both") { wins.push({ a: b0 - d, b: b0, dir: "out" }); }
        if (m.blur) { blurP = mtBlur(clip, track); noBlur = !blurP; }
        if (m.scx !== undefined && P.uniform) { try { P.uniform.setValue(false, true); } catch (e0) {} }
        for (i = 0; i < wins.length; i++) {
            w = wins[i];
            ts = mtTimes(w.a, w.b, curve, fd);
            kAt = function (t) {
                p = (t - w.a) / Math.max(w.b - w.a, fd);
                return w.dir === "in" ? 1 - mtCurve(p, curve) : 1 - mtCurve(1 - p, curve);
            };
            put = function (prop, fn) {
                if (!prop) { return; }
                base = mtBase(prop, clip, w.dir === "in" ? w.b : w.a);
                mtClear(prop, clip, w.a, w.b);
                keys = [];
                for (j = 0; j < ts.length; j++) { k = kAt(ts[j]); keys.push([ts[j], fn(base, k)]); }
                mtKeys(prop, clip, keys);
            };
            if (m.op !== undefined) { put(P.op, function (b, k) { return Number(b) * (1 - k) + m.op * k; }); }
            if (m.dx || m.dy) {
                put(P.pos, function (b, k) {
                    norm = mtNormalized(b);
                    return [Number(b[0]) + (m.dx || 0) * dist * k / (norm ? W : 1), Number(b[1]) + (m.dy || 0) * dist * k / (norm ? H : 1)];
                });
            }
            if (m.sc !== undefined) { put(P.scale, function (b, k) { return Number(b) * ((1 - k) + m.sc / 100 * k); }); }
            if (m.scy !== undefined) { put(P.scale, function (b, k) { return Number(b) * ((1 - k) + m.scy / 100 * k); }); }
            if (m.scx !== undefined) { put(P.scaleW, function (b, k) { return Number(b) * ((1 - k) + m.scx / 100 * k); }); }
            if (m.rot !== undefined) { put(P.rot, function (b, k) { return Number(b) + m.rot * k; }); }
            if (blurP) { put(blurP, function (b, k) { return Number(b) * (1 - k) + m.blur * k; }); }
        }
        return noBlur;
    }

    // ---- Transitions: the looks are the panel's previews (trLook in panel.js), baked per frame.

    function trIn(x) { return x <= 0 ? 0 : Math.pow(2, 10 * x - 10); }
    function trOut(x) { return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); }
    function trCut(t, a, b) { return t < 0.5 ? a * trIn(t * 2) : b * (1 - trOut(t * 2 - 1)); }

    function trLook(id, t) {
        var bell = Math.pow(Math.sin(Math.PI * t), 2), peak = t < 0.5 ? trIn(t * 2) : trIn(2 - t * 2);
        var after = t < 0.5 ? 0 : Math.pow(1 - (t * 2 - 1), 2);
        var o = { s: 1, r: 0, x: 0, y: 0, blur: 0 };
        if (id === "zoom-in") { o.s = 1 + trCut(t, 2, -0.67); o.blur = 5 * peak; }
        if (id === "zoom-out") { o.s = 1 + trCut(t, -0.67, 2); o.blur = 5 * peak; }
        if (id === "zoom-in-out") { o.s = 1 + trCut(t, 2, 2); o.blur = 5 * peak; }
        if (id === "zoom-hit") { o.s = 1 + trCut(t, 3, -0.75) + 0.12 * after * Math.sin(t * 40); o.x = Math.sin(t * 90) * 0.05 * after; o.blur = 6 * peak; }
        if (id === "pan-left") { o.x = trCut(t, -1, 1); o.blur = 4 * peak; }
        if (id === "pan-right") { o.x = trCut(t, 1, -1); o.blur = 4 * peak; }
        if (id === "pan-up") { o.y = trCut(t, -1, 1); o.blur = 4 * peak; }
        if (id === "pan-down") { o.y = trCut(t, 1, -1); o.blur = 4 * peak; }
        if (id === "rotate") { o.s = 1 + 0.2 * bell; o.r = trCut(t, 90, -90); o.blur = 3 * peak; }
        if (id === "roll") { o.s = 1 + 0.3 * bell; o.r = trCut(t, 180, -180); o.blur = 4 * peak; }
        if (id === "zoom-rotate") { o.s = 1 + trCut(t, 2, -0.6); o.r = trCut(t, 120, -120); o.blur = 5 * peak; }
        if (id === "shake") { o.s = 1 + 0.25 * bell; o.x = Math.sin(t * 90) * 0.07 * bell; o.y = Math.cos(t * 71) * 0.05 * bell; o.r = Math.sin(t * 57) * 10 * bell; o.blur = 2 * bell; }
        if (id === "blur-dissolve") { o.s = 1 + 0.15 * bell; o.blur = 10 * bell; }
        return o;
    }

    // Premiere's own transitions: English names first, then the Russian ones.
    var TR_BUILTIN = {
        "pr-cross-dissolve": ["Cross Dissolve", "\u041f\u0435\u0440\u0435\u043a\u0440\u0435\u0441\u0442\u043d\u044b\u0439 \u043d\u0430\u043f\u043b\u044b\u0432", "\u041f\u0435\u0440\u0435\u043a\u0440\u0451\u0441\u0442\u043d\u044b\u0439 \u043d\u0430\u043f\u043b\u044b\u0432"],
        "pr-film-dissolve": ["Film Dissolve", "\u041d\u0430\u043f\u043b\u044b\u0432 \u043f\u043b\u0435\u043d\u043a\u0438", "\u041d\u0430\u043f\u043b\u044b\u0432 \u043f\u043b\u0451\u043d\u043a\u0438"],
        "pr-dip-black": ["Dip to Black", "\u041f\u0435\u0440\u0435\u0445\u043e\u0434 \u0447\u0435\u0440\u0435\u0437 \u0447\u0435\u0440\u043d\u044b\u0439", "\u041f\u043e\u0433\u0440\u0443\u0436\u0435\u043d\u0438\u0435 \u0432 \u0447\u0435\u0440\u043d\u044b\u0439"],
        "pr-dip-white": ["Dip to White", "\u041f\u0435\u0440\u0435\u0445\u043e\u0434 \u0447\u0435\u0440\u0435\u0437 \u0431\u0435\u043b\u044b\u0439", "\u041f\u043e\u0433\u0440\u0443\u0436\u0435\u043d\u0438\u0435 \u0432 \u0431\u0435\u043b\u044b\u0439"],
        "pr-push": ["Push", "\u0421\u0434\u0432\u0438\u0433", "\u0412\u044b\u0442\u0430\u043b\u043a\u0438\u0432\u0430\u043d\u0438\u0435"],
        "pr-cross-zoom": ["Cross Zoom", "\u041f\u0435\u0440\u0435\u043a\u0440\u0435\u0441\u0442\u043d\u043e\u0435 \u043c\u0430\u0441\u0448\u0442\u0430\u0431\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435"]
    };

    // The cut nearest the playhead (within reach seconds): two clips on one video track, end to start.
    // Selected clips win: a selected pair, or the cut at either end of one selected clip.
    function findCut(s, reach) {
        var best = null, ph = PR.playhead(s), fd = 1 / PR.fps(s), i, j, t, a, b, cut, d, score, selA, selB;
        for (i = 0; i < s.videoTracks.numTracks; i++) {
            t = s.videoTracks[i];
            for (j = 0; j + 1 < t.clips.numItems; j++) {
                a = t.clips[j]; b = t.clips[j + 1];
                if (Math.abs(PR.secs(a.end) - PR.secs(b.start)) > fd / 2) { continue; }
                cut = PR.secs(b.start);
                d = Math.abs(cut - ph);
                selA = false; selB = false;
                try { selA = !!a.isSelected(); selB = !!b.isSelected(); } catch (e) {}
                score = (selA && selB) ? -2 : ((selA || selB) ? -1 + d / 1000 : d);
                if (!(selA || selB) && d > reach) { continue; }
                if (!best || score < best.score) { best = { a: a, b: b, cut: cut, track: i, score: score }; }
            }
        }
        if (!best) { throw new Error("NO_CUT"); }
        return best;
    }

    function timecode(frames, fps) {
        var f = Math.round(fps), ff = frames % f, sec = Math.floor(frames / f), p2 = function (n) { return (n < 10 ? "0" : "") + n; };
        return "00:" + p2(Math.floor(sec / 60)) + ":" + p2(sec % 60) + ":" + p2(ff);
    }

    // ------------------------------------------------------- Tools tab
    // Premiere does not tell scripts which keys are selected: the tools work on the selected clips.

    // Selected clips, video first (top track first), then audio: [{clip, kind, track}]
    function toolClips(s) {
        var v = mtSelectedVideo(s), a = mtSelectedAudio(s), out = [], i;
        v.sort(function (x, y) { return y.track - x.track || PR.secs(x.clip.start) - PR.secs(y.clip.start); });
        for (i = 0; i < v.length; i++) { out.push({ clip: v[i].clip, kind: "V", track: v[i].track }); }
        for (i = 0; i < a.length; i++) { out.push({ clip: a[i].clip, kind: "A", track: a[i].track }); }
        return out;
    }

    function clipKey(s, it) {
        return String(s.sequenceID || s.name) + "|" + it.kind + it.track + "|" + String(it.clip.start.ticks !== undefined ? it.clip.start.ticks : PR.secs(it.clip.start)) + "|" + String(it.clip.name);
    }

    function keyTimes(p) {
        var k, out = [], i;
        try { k = p.getKeys(); } catch (e) { k = null; }
        if (!k) { return out; }
        for (i = 0; i < k.length; i++) { out.push(PR.secs(k[i])); }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    function animatable(v) {
        var i;
        if (typeof v === "number") { return true; }
        if (v && v.length !== undefined && typeof v !== "string") {
            for (i = 0; i < v.length; i++) { if (typeof v[i] !== "number") { return false; } }
            return v.length > 0;
        }
        return false;
    }

    // Every keyed parameter of a clip: [{p, ci, pi, name}]
    function keyedParams(clip) {
        var out = [], i, j, c, p;
        for (i = 0; i < clip.components.numItems; i++) {
            c = clip.components[i];
            for (j = 0; j < c.properties.numItems; j++) {
                p = c.properties[j];
                try { if (p.isTimeVarying() && keyTimes(p).length) { out.push({ p: p, ci: i, pi: j, comp: String(c.matchName), name: String(p.displayName) }); } } catch (e) {}
            }
        }
        return out;
    }

    function near(list, t) {
        var i;
        for (i = 0; i < list.length; i++) { if (Math.abs(list[i] - t) < 0.0005) { return true; } }
        return false;
    }

    // Keys our baking added earlier go away; the originals stay.
    function unbake(p, originals) {
        var cur = keyTimes(p), i;
        if (!originals || !originals.length) { return false; }
        for (i = 0; i < originals.length; i++) { if (!near(cur, originals[i])) { return false; } }
        for (i = 0; i < cur.length; i++) {
            if (!near(originals, cur[i]) && cur[i] > originals[0] && cur[i] < originals[originals.length - 1]) {
                try { p.removeKey(PR.time(cur[i])); } catch (e) {}
            }
        }
        return true;
    }

    function lerpVal(a, b, f) {
        var out, i;
        if (typeof a === "number") { return a + (b - a) * f; }
        out = [];
        for (i = 0; i < a.length; i++) { out.push(a[i] + (b[i] - a[i]) * f); }
        return out;
    }

    var EASE_NATIVE = { ease: 5, lin: 0, hold: 4 };
    var EASE_F = {
        inn: function (t) { return t * t * t; },
        out: function (t) { return 1 - Math.pow(1 - t, 3); },
        auto: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
        cont: function (t) { return t * t * (3 - 2 * t); },
        over: function (t) { return mtCurve(t, "over"); },
        bounce: function (t) { return mtCurve(t, "bounce"); },
        elastic: function (t) { return mtCurve(t, "elastic"); },
        sharp: function (t) { return t <= 0 ? 0 : (t >= 1 ? 1 : (t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2)); },
        soft: function (t) { return t < 0.5 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2; },
        slow: function (t) { return t <= 0 ? 0 : Math.pow(2, 10 * t - 10); },
        stop: function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); },
        back: function (t) {
            var c = 2.5949095;
            return t < 0.5 ? (Math.pow(2 * t, 2) * ((c + 1) * 2 * t - c)) / 2 : (Math.pow(2 * t - 2, 2) * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
        }
    };

    // ---- Align / anchor geometry. Premiere keeps Position and Anchor Point normalized (0..1) in new versions.

    function mediaSize(clip, s) {
        var md = "", m;
        try { md = String(clip.projectItem.getProjectMetadata()); } catch (e) {}
        m = /VideoInfo[^>]*>\s*(\d+)\s*x\s*(\d+)/.exec(md);
        if (m) { return [Number(m[1]), Number(m[2])]; }
        return [Number(s.frameSizeHorizontal) || 1920, Number(s.frameSizeVertical) || 1080];
    }

    function anchorParam(clip) {
        var m = mtComp(clip, MT_MOTION);
        return mtParam(m, ["Anchor Point", "\u041e\u043f\u043e\u0440\u043d\u0430\u044f \u0442\u043e\u0447\u043a\u0430"], 5);
    }

    // Box of a video clip in sequence pixels: {x0, y0, x1, y1}, plus what is needed to move it.
    function clipBox(clip, s) {
        var P = mtProps(clip), A = anchorParam(clip), W = Number(s.frameSizeHorizontal) || 1920, H = Number(s.frameSizeVertical) || 1080;
        var ms = mediaSize(clip, s), pos = P.pos.getValue(), an = A ? A.getValue() : [0.5, 0.5], sc = Number(P.scale.getValue()) / 100, scw = sc;
        var uni = true, px, py, ax, ay, w, h;
        try { uni = P.uniform ? P.uniform.getValue() !== false : true; } catch (e) {}
        if (!uni && P.scaleW) { scw = Number(P.scaleW.getValue()) / 100; }
        px = mtNormalized(pos) ? pos[0] * W : Number(pos[0]); py = mtNormalized(pos) ? pos[1] * H : Number(pos[1]);
        ax = mtNormalized(an) ? an[0] * ms[0] : Number(an[0]); ay = mtNormalized(an) ? an[1] * ms[1] : Number(an[1]);
        w = ms[0] * scw; h = ms[1] * sc;
        return { x0: px - ax * scw, y0: py - ay * sc, x1: px - ax * scw + w, y1: py - ay * sc + h, P: P, norm: mtNormalized(pos), W: W, H: H };
    }

    function moveBox(b, dx, dy) {
        var v = b.P.pos.getValue();
        if (b.norm) { b.P.pos.setValue([Number(v[0]) + dx / b.W, Number(v[1]) + dy / b.H], true); }
        else { b.P.pos.setValue([Number(v[0]) + dx, Number(v[1]) + dy], true); }
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
                var used = [], want = {}, seen = {}, i;
                function walk(b) {
                    var j, it, p;
                    for (j = 0; j < b.children.numItems; j++) {
                        it = b.children[j];
                        if (!it) { continue; }
                        if (it.type === ProjectItemType.BIN) { walk(it); continue; }
                        try { p = String(it.getMediaPath() || ""); } catch (e) { p = ""; }
                        if (p && want[p] && !seen[p]) { seen[p] = true; used.push(p); }
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

        // ---- Montage tab

        // Puts a sound at the playhead on a free audio track (a new one when all are busy). The panel has
        // already made the file with the pitch and length asked; vol is in dB.
        acSound: function (path, binName, len, vol, name) {
            return reply(function () {
                var s = PR.seq(), r = putSound(s, null, path, binName, PR.playhead(s), vol, name);
                return { track: String(r.track.name || ""), reused: r.reused };
            });
        },

        // Selected audio clips: their files and volume, for the pitch / length / volume sliders.
        sndTargets: function () {
            return reply(function () {
                var s = PR.seq(), list = mtSelectedAudio(s), out = [], i, c, lv, v = 0, path = "";
                for (i = 0; i < list.length; i++) {
                    c = list[i].clip;
                    lv = mtLevel(c);
                    try { v = lv ? levelToDb(lv.getValue()) : 0; } catch (e) { v = 0; }
                    try { path = c.projectItem ? String(c.projectItem.getMediaPath()) : ""; } catch (e2) { path = ""; }
                    if (!path) { continue; }
                    out.push({ index: i, path: path, volume: v, name: String(c.name) });
                }
                return { list: out };
            });
        },

        // Swaps the selected audio clips for new files (same track, same start) and sets their volume.
        sndApplyFiles: function (list) {
            return reply(function () {
                var s = PR.seq(), sel = mtSelectedAudio(s), n = 0, i, it, c, track, at, name = "";
                for (i = 0; i < list.length; i++) {
                    it = list[i];
                    if (!sel[it.index]) { continue; }
                    c = sel[it.index].clip;
                    track = s.audioTracks[sel[it.index].track];
                    at = PR.secs(c.start);
                    name = String(c.name);
                    if (String(c.projectItem ? c.projectItem.getMediaPath() : "") !== String(it.file)) {
                        c.remove(false, false);
                        putSound(s, track, it.file, "Sayframe SFX", at, it.volume, name);
                    } else {
                        c = mtLevel(c);
                        if (c) { c.setValue(dbToLevel(it.volume), true); }
                    }
                    n++;
                }
                return { count: n, name: name };
            });
        },

        // Motions on the selected video clips, as keys at their start (in), end (out) or both.
        sfApply: function (motion, curve, mode, dur) {
            return reply(function () {
                var s = PR.seq(), list = mtSelectedVideo(s), m = MT_MOTIONS[motion], i, noBlur = 0;
                if (!m) { throw new Error("UNKNOWN_PRESET"); }
                if (!list.length) { throw new Error("NO_CLIPS"); }
                for (i = 0; i < list.length; i++) {
                    if (mtMotionOnClip(s, list[i].clip, list[i].track, m, curve, mode, dur)) { noBlur++; }
                }
                return { applied: list.length, skipped: [], state: [], noBlur: noBlur };
            });
        },

        sfState: function () {
            return reply(function () { return { state: [] }; });
        },

        // A transition on the cut nearest the playhead: Premiere's own (pr-...) through QE, ours as keys
        // on both clips, half before the cut and half after.
        trApply: function (id, dur) {
            return reply(function () {
                var s = PR.seq(), fps = PR.fps(s), fd = 1 / fps, d = Math.max(fd * 2, Number(dur) || 0.8), cut = findCut(s, Math.max(1, d));
                var W = Number(s.frameSizeHorizontal) || 1920, a0 = cut.cut - d / 2, n, i, t, tt, o, sides, side, P, base, bp, blurOn = false, noBlur = false, j;
                var tr, item, frames;
                if (TR_BUILTIN[id]) {
                    app.enableQE();
                    tr = qeByNames("tr", TR_BUILTIN[id]);
                    if (!tr) { throw new Error("NO_TRANSITION"); }
                    item = qeItem(cut.track, cut.b);
                    if (!item) { throw new Error("NO_CUT"); }
                    frames = Math.max(2, Math.round(d * fps));
                    item.addTransition(tr, true, timecode(frames, fps), "00:00:00:00", 0.5, false, true);
                    return { cut: cut.cut, dur: frames / fps, a: String(cut.a.name), b: String(cut.b.name), builtin: true };
                }
                n = Math.max(2, Math.round(d * fps));
                for (i = 0; i <= n; i++) { if (trLook(id, i / n).blur > 0.01) { blurOn = true; break; } }
                // A ends at the cut, B starts there; each one gets the half of the look on its side.
                sides = [{ clip: cut.a, from: 0, to: Math.ceil(n / 2) - 1 }, { clip: cut.b, from: Math.ceil(n / 2), to: n }];
                for (j = 0; j < sides.length; j++) {
                    side = sides[j];
                    P = mtProps(side.clip);
                    side.keys = { s: [], r: [], p: [], b: [] };
                    side.base = {
                        s: P.scale ? Number(mtBase(P.scale, side.clip, j ? cut.cut + d / 2 : a0)) : 100,
                        r: P.rot ? Number(mtBase(P.rot, side.clip, j ? cut.cut + d / 2 : a0)) : 0,
                        p: P.pos ? mtBase(P.pos, side.clip, j ? cut.cut + d / 2 : a0) : null
                    };
                    side.P = P;
                    bp = blurOn ? mtBlur(side.clip, cut.track) : null;
                    if (blurOn && !bp) { noBlur = true; }
                    side.blurP = bp;
                    for (i = side.from; i <= side.to; i++) {
                        t = i / n;
                        // The first clip's last frame is just before the cut, the second one's first frame is on it.
                        tt = j ? Math.max(cut.cut, a0 + t * d) : Math.min(cut.cut - fd, a0 + t * d);
                        o = trLook(id, t);
                        side.keys.s.push([tt, side.base.s * o.s]);
                        side.keys.r.push([tt, side.base.r + o.r]);
                        base = side.base.p;
                        if (base) {
                            side.keys.p.push([tt, mtNormalized(base) ? [Number(base[0]) + o.x, Number(base[1]) + o.y] :
                                [Number(base[0]) + o.x * W, Number(base[1]) + o.y * (Number(s.frameSizeVertical) || 1080)]]);
                        }
                        side.keys.b.push([tt, o.blur * 12]);
                    }
                }
                for (j = 0; j < sides.length; j++) {
                    side = sides[j];
                    if (!side.keys.s.length) { continue; }
                    o = side.keys.s;
                    mtClear(side.P.scale, side.clip, o[0][0], o[o.length - 1][0]);
                    mtClear(side.P.rot, side.clip, o[0][0], o[o.length - 1][0]);
                    mtClear(side.P.pos, side.clip, o[0][0], o[o.length - 1][0]);
                    if (side.blurP) { mtClear(side.blurP, side.clip, o[0][0], o[o.length - 1][0]); }
                    mtKeys(side.P.scale, side.clip, side.keys.s);
                    if (/rotate|roll|shake/.test(id)) { mtKeys(side.P.rot, side.clip, side.keys.r); }
                    if (/pan|shake|hit/.test(id) && side.keys.p.length) { mtKeys(side.P.pos, side.clip, side.keys.p); }
                    if (side.blurP) { mtKeys(side.blurP, side.clip, side.keys.b); }
                }
                return { cut: cut.cut, dur: d, a: String(cut.a.name), b: String(cut.b.name), builtin: false, noBlur: noBlur };
            });
        },

        // ---- Tools tab

        // Ease on every keyed parameter of the selected clips. kind: ease | lin | hold (Premiere's own key types)
        // or one of EASE_F (baked: a key on every frame between two keys). baked: {clipKey: {"ci:pi": [original key times]}}
        // from earlier bakes, so they can be taken back first. Returns the new record of originals.
        easePR: function (kind, baked) {
            return reply(function () {
                var s = PR.seq(), list = toolClips(s), fd = 1 / PR.fps(s), f = EASE_F[kind], rec = {}, keys = 0, params = 0, clips = 0;
                var i, j, n, k, it, ck, ps, q, times, vals, a, b, m, tm, old;
                if (!list.length) { throw new Error("NO_CLIPS"); }
                if (!f && EASE_NATIVE[kind] === undefined) { throw new Error("UNKNOWN_PRESET"); }
                baked = baked || {};
                for (i = 0; i < list.length; i++) {
                    it = list[i];
                    ck = clipKey(s, it);
                    ps = keyedParams(it.clip);
                    if (!ps.length) { continue; }
                    clips++;
                    for (j = 0; j < ps.length; j++) {
                        q = ps[j];
                        old = baked[ck] ? baked[ck][q.ci + ":" + q.pi] : null;
                        if (old) { unbake(q.p, old); }
                        times = keyTimes(q.p);
                        vals = [];
                        for (k = 0; k < times.length; k++) { vals.push(q.p.getValueAtKey(PR.time(times[k]))); }
                        if (!f) {
                            for (k = 0; k < times.length; k++) { try { q.p.setInterpolationTypeAtKey(PR.time(times[k]), EASE_NATIVE[kind], true); keys++; } catch (e1) {} }
                            params++;
                            continue;
                        }
                        if (!animatable(vals[0]) || times.length < 2) { continue; }
                        params++;
                        for (k = 0; k + 1 < times.length; k++) {
                            a = times[k]; b = times[k + 1];
                            try { q.p.setInterpolationTypeAtKey(PR.time(a), 0, true); } catch (e2) {}
                            n = Math.floor((b - a) / fd + 0.0001);
                            for (m = 1; m < n; m++) {
                                tm = PR.time(a + m * fd);
                                q.p.addKey(tm);
                                q.p.setValueAtKey(tm, lerpVal(vals[k], vals[k + 1], f(m / n)), true);
                                try { q.p.setInterpolationTypeAtKey(tm, 0, true); } catch (e3) {}
                                keys++;
                            }
                        }
                        try { q.p.setInterpolationTypeAtKey(PR.time(times[times.length - 1]), 0, true); } catch (e4) {}
                        if (!rec[ck]) { rec[ck] = {}; }
                        rec[ck][q.ci + ":" + q.pi] = times;
                    }
                }
                if (!clips) { throw new Error("NO_KEYS_ON_CLIPS"); }
                return { clips: clips, params: params, keys: keys, baked: rec, isNative: !f };
            });
        },

        // Copy: the keys of the first selected clip, relative to its start.
        ecCopy: function () {
            return reply(function () {
                var s = PR.seq(), list = toolClips(s), groups = [], n = 0, ps, i, k, q, times, keys;
                if (!list.length) { throw new Error("NO_CLIPS"); }
                ps = keyedParams(list[0].clip);
                if (!ps.length) { throw new Error("NO_KEYS_ON_CLIPS"); }
                for (i = 0; i < ps.length; i++) {
                    q = ps[i];
                    times = keyTimes(q.p);
                    keys = [];
                    for (k = 0; k < times.length; k++) {
                        keys.push({ t: times[k] - PR.secs(list[0].clip.inPoint), v: q.p.getValueAtKey(PR.time(times[k])) });
                    }
                    n += keys.length;
                    groups.push({ name: q.name, comp: q.comp, pi: q.pi, keys: keys });
                }
                return { groups: groups, keys: n, clip: String(list[0].clip.name) };
            });
        },

        // Paste onto the other selected clips: "value" puts the same keys there (from each clip's start),
        // "ease" puts the copied key timing (where the keys sit) on the values the clip already has.
        ecPaste: function (clip, mode) {
            return reply(function () {
                var s = PR.seq(), list = toolClips(s), keys = 0, props = 0, i, g, it, c, comp, p, k, cur, tm, j, base, v;
                if (!list.length) { throw new Error("NO_CLIPS"); }
                for (i = 0; i < list.length; i++) {
                    it = list[i];
                    for (g = 0; g < clip.groups.length; g++) {
                        comp = mtComp(it.clip, [clip.groups[g].comp]);
                        if (!comp || clip.groups[g].pi >= comp.properties.numItems) { continue; }
                        p = comp.properties[clip.groups[g].pi];
                        cur = keyTimes(p);
                        base = p.getValue();
                        if (mode !== "value" && cur.length) { base = p.getValueAtKey(PR.time(cur[0])); }
                        for (j = 0; j < cur.length; j++) { try { p.removeKey(PR.time(cur[j])); } catch (e1) {} }
                        if (!p.isTimeVarying()) { p.setTimeVarying(true); }
                        for (k = 0; k < clip.groups[g].keys.length; k++) {
                            c = clip.groups[g].keys[k];
                            tm = PR.time(PR.secs(it.clip.inPoint) + c.t);
                            v = mode === "value" ? c.v : base;
                            p.addKey(tm);
                            p.setValueAtKey(tm, v, true);
                            keys++;
                        }
                        props++;
                    }
                }
                return { keys: keys, properties: props, clips: list.length };
            });
        },

        // Stagger: clips one after another by frames (or all to the playhead), or their keys.
        stagger: function (what, frames, order) {
            return reply(function () {
                var s = PR.seq(), list = toolClips(s), fd = 1 / PR.fps(s), moved = 0, steps = 0, skipped = 0, i, it, base, want, d, ps, j, q, times, vals, k, tm, first, all, shuffled, r;
                if (list.length < (order === "align" ? 1 : 2)) { throw new Error(order === "align" ? "NO_CLIPS" : "STAGGER_NEEDS_TWO"); }
                if (order === "desc") { list.reverse(); }
                if (order === "random") {
                    shuffled = [];
                    while (list.length) { r = Math.floor(Math.random() * list.length); shuffled.push(list[r]); list.splice(r, 1); }
                    list = shuffled;
                }
                base = order === "align" ? PR.playhead(s) : null;
                for (i = 0; i < list.length; i++) {
                    it = list[i];
                    if (what === "keys") {
                        ps = keyedParams(it.clip);
                        if (!ps.length) { skipped++; continue; }
                        all = [];
                        for (j = 0; j < ps.length; j++) { all = all.concat(keyTimes(ps[j].p)); }
                        first = Math.min.apply(null, all);
                        // first key on the playhead, or the first clip's first key + i steps (in sequence time)
                        if (base === null) { base = PR.secs(it.clip.start) + (first - PR.secs(it.clip.inPoint)); }
                        want = order === "align" ? base : base + i * frames * fd;
                        d = want - (PR.secs(it.clip.start) + (first - PR.secs(it.clip.inPoint)));
                        if (Math.abs(d) < fd / 2) { steps++; continue; }
                        for (j = 0; j < ps.length; j++) {
                            q = ps[j].p;
                            times = keyTimes(q);
                            vals = [];
                            for (k = 0; k < times.length; k++) { vals.push(q.getValueAtKey(PR.time(times[k]))); }
                            for (k = 0; k < times.length; k++) { q.removeKey(PR.time(times[k])); }
                            if (!q.isTimeVarying()) { q.setTimeVarying(true); }
                            for (k = 0; k < times.length; k++) { tm = PR.time(times[k] + d); q.addKey(tm); q.setValueAtKey(tm, vals[k], true); }
                        }
                        moved++; steps++;
                        continue;
                    }
                    if (base === null) { base = PR.secs(it.clip.start); }
                    want = order === "align" ? base : base + i * frames * fd;
                    d = want - PR.secs(it.clip.start);
                    steps++;
                    if (Math.abs(d) < fd / 2) { continue; }
                    it.clip.move(PR.time(d));
                    moved++;
                }
                return { moved: moved, steps: steps, skipped: skipped, unchanged: 0, failed: 0, aligned: order === "align" };
            });
        },

        // Anchor point to a corner, an edge middle or the centre (fx, fy in 0..1); the picture stays where it is.
        anchor: function (fx, fy, withKeys) {
            return reply(function () {
                var s = PR.seq(), list = mtSelectedVideo(s), moved = 0, skipped = 0, unchanged = 0, i, c, P, A, an, ms, sc, scw, dx, dy, pos, W, H, norm, uni;
                if (!list.length) { throw new Error("NO_CLIPS"); }
                W = Number(s.frameSizeHorizontal) || 1920; H = Number(s.frameSizeVertical) || 1080;
                for (i = 0; i < list.length; i++) {
                    c = list[i].clip; P = mtProps(c); A = anchorParam(c);
                    if (!A || !P.pos) { skipped++; continue; }
                    if ((A.isTimeVarying() || P.pos.isTimeVarying()) && !withKeys) { skipped++; continue; }
                    an = A.getValue(); ms = mediaSize(c, s); norm = mtNormalized(an);
                    sc = Number(P.scale.getValue()) / 100; scw = sc; uni = true;
                    try { uni = P.uniform ? P.uniform.getValue() !== false : true; } catch (e) {}
                    if (!uni && P.scaleW) { scw = Number(P.scaleW.getValue()) / 100; }
                    dx = (fx - (norm ? an[0] : an[0] / ms[0])) * ms[0] * scw;
                    dy = (fy - (norm ? an[1] : an[1] / ms[1])) * ms[1] * sc;
                    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) { unchanged++; continue; }
                    A.setValue(norm ? [fx, fy] : [fx * ms[0], fy * ms[1]], true);
                    pos = P.pos.getValue();
                    P.pos.setValue(mtNormalized(pos) ? [Number(pos[0]) + dx / W, Number(pos[1]) + dy / H] : [Number(pos[0]) + dx, Number(pos[1]) + dy], true);
                    moved++;
                }
                return { moved: moved, unchanged: unchanged, skipped: skipped, failed: 0 };
            });
        },

        // Align to the frame ("comp") or to the selection's box.
        align: function (edge, to) {
            return reply(function () {
                var s = PR.seq(), list = mtSelectedVideo(s), boxes = [], moved = 0, unchanged = 0, i, b, R, dx, dy;
                if (!list.length) { throw new Error("NO_CLIPS"); }
                for (i = 0; i < list.length; i++) { boxes.push(clipBox(list[i].clip, s)); }
                if (to === "selection" && boxes.length < 2) { throw new Error("ALIGN_NEEDS_TWO"); }
                R = { x0: 0, y0: 0, x1: boxes[0].W, y1: boxes[0].H };
                if (to === "selection") {
                    R = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
                    for (i = 0; i < boxes.length; i++) {
                        R.x0 = Math.min(R.x0, boxes[i].x0); R.y0 = Math.min(R.y0, boxes[i].y0); R.x1 = Math.max(R.x1, boxes[i].x1); R.y1 = Math.max(R.y1, boxes[i].y1);
                    }
                }
                for (i = 0; i < boxes.length; i++) {
                    b = boxes[i]; dx = 0; dy = 0;
                    if (edge === "left") { dx = R.x0 - b.x0; }
                    if (edge === "right") { dx = R.x1 - b.x1; }
                    if (edge === "hcenter") { dx = (R.x0 + R.x1) / 2 - (b.x0 + b.x1) / 2; }
                    if (edge === "top") { dy = R.y0 - b.y0; }
                    if (edge === "bottom") { dy = R.y1 - b.y1; }
                    if (edge === "vcenter") { dy = (R.y0 + R.y1) / 2 - (b.y0 + b.y1) / 2; }
                    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) { unchanged++; continue; }
                    moveBox(b, dx, dy);
                    moved++;
                }
                return { moved: moved, unchanged: unchanged, skipped: 0, failed: 0 };
            });
        },

        distribute: function (edge) {
            return reply(function () {
                var s = PR.seq(), list = mtSelectedVideo(s), boxes = [], moved = 0, i, b, n, key, a, z, d, horiz = /^(left|hcenter|right)$/.test(edge);
                if (list.length < 3) { throw new Error("DISTRIBUTE_NEEDS_THREE"); }
                for (i = 0; i < list.length; i++) { boxes.push(clipBox(list[i].clip, s)); }
                key = function (bx) {
                    if (edge === "left") { return bx.x0; } if (edge === "right") { return bx.x1; } if (edge === "hcenter") { return (bx.x0 + bx.x1) / 2; }
                    if (edge === "top") { return bx.y0; } if (edge === "bottom") { return bx.y1; } return (bx.y0 + bx.y1) / 2;
                };
                boxes.sort(function (x, y) { return key(x) - key(y); });
                n = boxes.length; a = key(boxes[0]); z = key(boxes[n - 1]);
                for (i = 1; i < n - 1; i++) {
                    b = boxes[i]; d = a + (z - a) * i / (n - 1) - key(b);
                    if (Math.abs(d) < 0.01) { continue; }
                    moveBox(b, horiz ? d : 0, horiz ? 0 : d);
                    moved++;
                }
                return { moved: moved, spread: n, skipped: 0, failed: 0 };
            });
        },

        // A picture from the clipboard (saved by the panel) into a bin and at the playhead.
        placeImage: function (path, choice, binName) {
            return reply(function () {
                var item = PR.importFile(path, binName), s = app.project.activeSequence, t;
                if (!s) { return { placed: "project" }; }
                t = PR.place(item);
                return { placed: "seq", compName: String(s.name), track: String(t.name || "") };
            });
        },

        // Project items into bins by kind.
        organizeProject: function () {
            return reply(function () {
                var root = app.project.rootItem, counts = {}, created = [], moved = 0, total = 0, i, j, b, it, kind, path, bins = {};
                var NAMES = { Compositions: "\u0421\u0435\u043a\u0432\u0435\u043d\u0446\u0438\u0438", Videos: "\u0412\u0438\u0434\u0435\u043e", Audio: "\u0410\u0443\u0434\u0438\u043e",
                    Images: "\u041a\u0430\u0440\u0442\u0438\u043d\u043a\u0438", Other: "\u041f\u0440\u043e\u0447\u0435\u0435" };
                var items = [];
                for (i = 0; i < root.children.numItems; i++) { items.push(root.children[i]); }
                for (i = 0; i < items.length; i++) {
                    it = items[i];
                    if (!it || it.type === ProjectItemType.BIN) { continue; }
                    total++;
                    path = "";
                    try { path = String(it.getMediaPath() || ""); } catch (e) {}
                    kind = "Other";
                    try { if (it.isSequence && it.isSequence()) { kind = "Compositions"; } } catch (e1) {}
                    if (kind === "Other" && !path) { kind = "Compositions"; }
                    if (/\.(mp4|mov|mxf|avi|m4v|mkv|webm|r3d|braw)$/i.test(path)) { kind = "Videos"; }
                    if (/\.(wav|mp3|aif|aiff|m4a|aac|flac|ogg)$/i.test(path)) { kind = "Audio"; }
                    if (/\.(png|jpe?g|gif|tiff?|psd|ai|svg|webp|heic|bmp|exr)$/i.test(path)) { kind = "Images"; }
                    if (!bins[kind]) {
                        b = null;
                        for (j = 0; j < root.children.numItems; j++) {
                            if (root.children[j].type === ProjectItemType.BIN && String(root.children[j].name) === NAMES[kind]) { b = root.children[j]; }
                        }
                        if (!b) { b = root.createBin(NAMES[kind]); created.push(NAMES[kind]); }
                        bins[kind] = b;
                    }
                    it.moveBin(bins[kind]);
                    counts[kind] = (counts[kind] || 0) + 1;
                    moved++;
                }
                return { organized: { total: total, moved: moved, counts: counts, created: created } };
            });
        },

        // Files used in no sequence go to the bin "Not used" (scripts cannot delete project items in Premiere).
        removeUnused: function (binName) {
            return reply(function () {
                var used = {}, names = [], list = [], i, j, k, s, t, c, b = null;
                for (i = 0; i < app.project.sequences.numSequences; i++) {
                    s = app.project.sequences[i];
                    try { used[s.projectItem.nodeId] = true; } catch (e0) {}
                    for (j = 0; j < s.videoTracks.numTracks; j++) { t = s.videoTracks[j]; for (k = 0; k < t.clips.numItems; k++) { c = t.clips[k]; if (c.projectItem) { used[c.projectItem.nodeId] = true; } } }
                    for (j = 0; j < s.audioTracks.numTracks; j++) { t = s.audioTracks[j]; for (k = 0; k < t.clips.numItems; k++) { c = t.clips[k]; if (c.projectItem) { used[c.projectItem.nodeId] = true; } } }
                }
                function walk(bin) {
                    var n, it;
                    for (n = 0; n < bin.children.numItems; n++) {
                        it = bin.children[n];
                        if (!it) { continue; }
                        if (it.type === ProjectItemType.BIN) { if (String(it.name) !== String(binName)) { walk(it); } continue; }
                        if (!used[it.nodeId]) { list.push(it); }
                    }
                }
                walk(app.project.rootItem);
                if (list.length) { b = PR.bin(binName); }
                for (i = 0; i < list.length; i++) { names.push(String(list[i].name)); list[i].moveBin(b); }
                return { removed: list.length, names: names, bin: binName };
            });
        },

        // Cut out: the photo of the selected clip (a still).
        cutoutSource: function () {
            return reply(function () {
                var s = PR.seq(), list = mtSelectedVideo(s), c, path = "", f;
                if (!list.length) { throw new Error("NO_CLIPS"); }
                list.sort(function (x, y) { return y.track - x.track; });
                c = list[0].clip;
                try { path = String(c.projectItem.getMediaPath()); } catch (e) {}
                if (!/\.(png|jpe?g|tiff?|bmp|webp|heic|gif)$/i.test(path)) { throw new Error("CO_NOT_PHOTO"); }
                f = new File(path);
                return { path: f.fsName, layer: String(c.name), index: 0, item: decodeURI(f.name), comp: String(s.name), many: list.length > 1,
                    dir: app.project.path ? new File(String(app.project.path)).parent.fsName : "", track: list[0].track, start: PR.secs(c.start) };
            });
        },

        // "above": the cut-out photo on a free track over the clip, same length, the original switched off.
        // "replace": the cut-out photo takes the clip's place.
        cutoutApply: function (path, index, mode, binName, newName, at) {
            return reply(function () {
                var s = PR.seq(), list = mtSelectedVideo(s), c, item, t, a, b, nc, i, ti;
                list.sort(function (x, y) { return y.track - x.track; });
                c = list.length ? list[0].clip : null;
                if (!c) { throw new Error("CO_LAYER_GONE"); }
                ti = list[0].track;
                a = PR.secs(c.start); b = PR.secs(c.end);
                item = PR.importFile(path, binName);
                if (mode === "above") {
                    t = PR.freeVideoTrack(a, b - a, s);
                    try { c.disabled = true; } catch (e0) {}
                } else {
                    t = s.videoTracks[ti];
                    c.remove(false, false);
                }
                t.overwriteClip(item, a);
                for (i = 0; i < t.clips.numItems; i++) {
                    if (Math.abs(PR.secs(t.clips[i].start) - a) < 0.02) { nc = t.clips[i]; }
                }
                if (nc) {
                    try { nc.end = PR.time(b); } catch (e1) {}
                    try { nc.name = newName; } catch (e2) {}
                }
                return { mode: mode, layer: newName, original: String(c.name) };
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
