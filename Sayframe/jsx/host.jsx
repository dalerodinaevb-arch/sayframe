/*
 * host.jsx - the After Effects side of Sayframe (ExtendScript, ES3, ASCII only).
 * The HTML panel calls these functions through evalScript; every function returns a JSON string.
 */
var sayframeHost = (function () {

    var REF_MAX_SIDE = 640;   // frames are scaled down to this side before they are saved
    var MAX_CHECK_FRAMES = 6;

    // ---------------------------------------------------------------- json

    function jsonString(s) {
        s = String(s);
        var out = ['"'];
        var i, c, code, hex;
        for (i = 0; i < s.length; i++) {
            c = s.charAt(i);
            code = s.charCodeAt(i);
            if (c === '"') {
                out.push('\\"');
            } else if (c === "\\") {
                out.push("\\\\");
            } else if (code === 10) {
                out.push("\\n");
            } else if (code === 13) {
                out.push("\\r");
            } else if (code === 9) {
                out.push("\\t");
            } else if (code < 32 || code > 126) {
                hex = code.toString(16);
                while (hex.length < 4) { hex = "0" + hex; }
                out.push("\\u" + hex);
            } else {
                out.push(c);
            }
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

    // Runs fn and turns its result, or the error it throws, into a JSON string.
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

    // ------------------------------------------------------- project state

    function fileAccessAllowed() {
        try {
            return app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1;
        } catch (e) {
            return true;
        }
    }

    function layerKind(layer) {
        try {
            if (layer instanceof TextLayer) { return "text"; }
            if (layer instanceof ShapeLayer) { return "shape"; }
            if (layer instanceof CameraLayer) { return "camera"; }
            if (layer instanceof LightLayer) { return "light"; }
            if (layer.nullLayer) { return "null"; }
            if (layer.adjustmentLayer) { return "adjustment"; }
            if (layer.source instanceof CompItem) { return "precomp"; }
            if (layer.source && layer.source.mainSource instanceof SolidSource) { return "solid"; }
            if (layer.source && layer.source.hasVideo === false && layer.source.hasAudio) { return "audio"; }
            return "footage";
        } catch (e) {
            return "layer";
        }
    }

    function projectSnapshot() {
        var lines = [];
        var proj = app.project;
        var item, i, n, layer, line, count;
        lines.push("After Effects version: " + app.version);
        if (!proj) {
            lines.push("No project is open.");
            return lines.join("\n");
        }
        lines.push("Project items: " + proj.numItems);
        item = proj.activeItem;
        if (item && item instanceof CompItem) {
            lines.push('Active composition: "' + item.name + '", ' + item.width + "x" + item.height +
                ", duration " + item.duration.toFixed(2) + " s, " + item.frameRate + " fps, current time " +
                item.time.toFixed(2) + " s, layers: " + item.numLayers);
            n = Math.min(item.numLayers, 60);
            for (i = 1; i <= n; i++) {
                layer = item.layer(i);
                line = "  #" + i + " [" + layerKind(layer) + '] "' + layer.name + '"';
                if (layer.selected) { line += " SELECTED"; }
                if (!layer.enabled) { line += " hidden"; }
                if (layer.threeDLayer) { line += " 3D"; }
                if (layer.parent) { line += " parent=#" + layer.parent.index; }
                line += " in=" + layer.inPoint.toFixed(2) + " out=" + layer.outPoint.toFixed(2);
                lines.push(line);
            }
            if (item.numLayers > n) { lines.push("  ... and " + (item.numLayers - n) + " more layers"); }
        } else {
            lines.push("No composition is active.");
            count = 0;
            for (i = 1; i <= proj.numItems && count < 20; i++) {
                if (proj.item(i) instanceof CompItem) {
                    lines.push('  composition in project: "' + proj.item(i).name + '"');
                    count++;
                }
            }
        }
        return lines.join("\n");
    }

    // -------------------------------------------------------------- frames

    function restoreActive(prevActive) {
        try {
            if (prevActive && prevActive instanceof CompItem && app.project.activeItem !== prevActive) {
                prevActive.openInViewer();
            }
        } catch (e) {}
    }

    // After Effects may still be writing the PNG after saveFrameToPng returns.
    function waitForFile(path, timeoutMs) {
        var start = new Date().getTime();
        var last = -1;
        var f, len;
        while (new Date().getTime() - start < timeoutMs) {
            f = new File(path);
            if (f.exists) {
                len = f.length;
                if (len > 0 && len === last) { return true; }
                last = len;
            }
            $.sleep(150);
        }
        f = new File(path);
        return f.exists && f.length > 0;
    }

    // Saves scaled-down PNG frames of a project item (footage or composition) into tmpDir.
    // Builds a small temporary composition for that and removes it again. Returns [{ time, path }].
    function captureFrames(item, times, tmpDir) {
        var stamp = String(new Date().getTime());
        var frames = [];
        var comp = null;
        var fps = item.frameRate > 0 ? Math.min(Math.max(item.frameRate, 1), 120) : 30;
        var dur = item.duration > 0 ? Math.max(item.duration, 1 / fps) : 1;
        var scale = Math.min(1, REF_MAX_SIDE / Math.max(item.width, item.height));
        var cw = Math.max(16, Math.round(item.width * scale));
        var ch = Math.max(16, Math.round(item.height * scale));
        var layer, i, png;

        try {
            comp = app.project.items.addComp("__sayframe_frames_tmp", cw, ch, 1, dur, fps);
            layer = comp.layers.add(item);
            layer.property("ADBE Transform Group").property("ADBE Scale").setValue([scale * 100, scale * 100]);
            for (i = 0; i < times.length; i++) {
                png = new File(tmpDir + "/sayframe_frame_" + stamp + "_" + i + ".png");
                comp.saveFrameToPng(times[i], png);
                if (!waitForFile(png.fsName, 20000)) { throw new Error("FRAME_NOT_SAVED"); }
                frames.push({ time: times[i], path: png.fsName });
            }
        } finally {
            try { if (comp) { comp.remove(); } } catch (e2) {}
        }
        return frames;
    }

    // Times at which to look at the result: the ones the script named (SAYFRAME_CHECK_TIMES),
    // otherwise four points across the work area.
    function pickCheckTimes(comp, requested) {
        var frameDur = 1 / (comp.frameRate > 0 ? comp.frameRate : 30);
        var maxT = Math.max(0, comp.duration - frameDur);
        var times = [];
        var fractions = [0.05, 0.35, 0.65, 0.95];
        var i, t, start, len;
        if (requested instanceof Array) {
            for (i = 0; i < requested.length && times.length < MAX_CHECK_FRAMES; i++) {
                t = Number(requested[i]);
                if (!isNaN(t) && isFinite(t)) { times.push(Math.min(Math.max(t, 0), maxT)); }
            }
        }
        if (times.length === 0) {
            start = comp.workAreaStart > 0 ? comp.workAreaStart : 0;
            len = comp.workAreaDuration > 0 ? comp.workAreaDuration : comp.duration;
            for (i = 0; i < fractions.length; i++) {
                times.push(Math.min(Math.max(start + len * fractions[i], 0), maxT));
            }
        }
        return times;
    }

    // ----------------------------------------------------------- execution

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
    // Returns SAYFRAME_CHECK_TIMES when the script declares it.
    function executeGenerated(__sayframeCode) {
        var SAYFRAME_CHECK_TIMES;
        eval(__sayframeCode);
        return SAYFRAME_CHECK_TIMES;
    }

    function projectBin(name) {
        var proj = app.project;
        var i, it;
        for (i = 1; i <= proj.numItems; i++) {
            it = proj.item(i);
            if (it instanceof FolderItem && it.name === name && it.parentFolder === proj.rootFolder) { return it; }
        }
        return proj.items.addFolder(name);
    }

    function baseName(name) {
        return String(name).replace(/\.[A-Za-z0-9]+$/, "");
    }

    // ---------------------------------------------------------- public API

    return {

        // Current project state for the next request.
        info: function () {
            return reply(function () {
                var proj = app.project;
                var active = proj ? proj.activeItem : null;
                return {
                    snapshot: projectSnapshot(),
                    projectPath: (proj && proj.file) ? proj.file.fsName : null,
                    activeComp: (active && active instanceof CompItem) ? active.name : null,
                    fileAccess: fileAccessAllowed()
                };
            });
        },

        // ES3 syntax check without running anything.
        syntax: function (code) {
            return reply(function () {
                return { error: syntaxError(code) };
            });
        },

        // Runs a generated script inside one undo group and, when asked, saves frames of the result.
        run: function (code, label, wantFrames, tmpDir) {
            return reply(function () {
                var out = { runError: null, frames: null, compName: null, captureError: null };
                var times = null;
                var target;
                app.beginUndoGroup("Sayframe: " + label);
                try {
                    try {
                        times = executeGenerated(code);
                    } catch (e) {
                        out.runError = e.toString() + (e.line ? " (line " + e.line + ")" : "");
                    }
                    if (out.runError === null && wantFrames) {
                        try {
                            target = app.project.activeItem;
                            if (target && target instanceof CompItem) {
                                out.compName = target.name;
                                out.frames = captureFrames(target, pickCheckTimes(target, times), tmpDir);
                                restoreActive(target);
                            }
                        } catch (e2) {
                            out.frames = null;
                            out.captureError = (e2 && e2.message) ? e2.message : String(e2);
                        }
                    }
                } finally {
                    app.endUndoGroup();
                }
                return out;
            });
        },

        // Imports a picture or video, saves frames of it and removes it from the project again.
        reference: function (path, maxFrames, tmpDir) {
            return reply(function () {
                var proj = app.project;
                var prevActive = proj.activeItem;
                var file = new File(path);
                var item = null;
                var ref = { name: "", isStill: false, duration: 0, width: 0, height: 0, frames: [] };
                var times = [];
                var fps, n, i;

                try { ref.name = decodeURI(file.name); } catch (e0) { ref.name = String(file.name); }
                app.beginUndoGroup("Sayframe: reference frames");
                try {
                    item = proj.importFile(new ImportOptions(file));
                    if (!item || !item.width || !item.height) { throw new Error("NO_PICTURE_IN_FILE"); }
                    ref.width = item.width;
                    ref.height = item.height;
                    ref.isStill = !!(item.mainSource && item.mainSource.isStill);
                    ref.duration = ref.isStill ? 0 : item.duration;
                    fps = item.frameRate > 0 ? item.frameRate : 30;
                    n = ref.isStill ? 1 : Math.max(1, Math.min(maxFrames, Math.floor(ref.duration * fps)));
                    for (i = 0; i < n; i++) {
                        times.push(ref.isStill ? 0 : ref.duration * (i + 0.5) / n);
                    }
                    ref.frames = captureFrames(item, times, tmpDir);
                } finally {
                    try { if (item) { item.remove(); } } catch (e3) {}
                    app.endUndoGroup();
                    restoreActive(prevActive);
                }
                return { ref: ref };
            });
        },

        // Imports an image file and places it: mode "precomp" or "plain".
        // Returns how it was placed: "comp-precomp", "comp-plain", "new-comp" or "project".
        placeImage: function (path, mode, binName) {
            return reply(function () {
                var proj = app.project;
                var prevActive = proj.activeItem;
                var comp = (prevActive && prevActive instanceof CompItem) ? prevActive : null;
                var out = { placed: "", compName: comp ? comp.name : null, preName: null, width: 0, height: 0 };
                var item, layer, pre, name;

                app.beginUndoGroup("Sayframe: paste image");
                try {
                    item = proj.importFile(new ImportOptions(new File(path)));
                    if (!item || !item.width || !item.height) {
                        try { if (item) { item.remove(); } } catch (e2) {}
                        throw new Error("NOT_AN_IMAGE");
                    }
                    item.parentFolder = projectBin(binName);
                    out.width = item.width;
                    out.height = item.height;
                    name = baseName(item.name);
                    if (comp) {
                        layer = comp.layers.add(item);
                        if (mode === "precomp") {
                            // "Leave all attributes": the precomp gets the size of the picture.
                            pre = comp.layers.precompose([layer.index], name + " Comp", false);
                            out.preName = pre.name;
                            out.placed = "comp-precomp";
                        } else {
                            out.placed = "comp-plain";
                        }
                        restoreActive(comp);
                    } else if (mode === "precomp") {
                        pre = proj.items.addComp(name + " Comp", item.width, item.height, 1, 10, 30);
                        pre.layers.add(item);
                        pre.openInViewer();
                        out.preName = pre.name;
                        out.placed = "new-comp";
                    } else {
                        out.placed = "project";
                    }
                } finally {
                    app.endUndoGroup();
                }
                return out;
            });
        }
    };
})();
