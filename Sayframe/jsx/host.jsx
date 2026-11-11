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

    // Edit > Undo. After Effects keeps no step for an empty undo group, so before undoing a failed script
    // markUndoStep() makes sure its group holds a change: otherwise Undo would take back the user's own last step.
    var UNDO_COMMAND = 16;

    function markUndoStep() {
        var f;
        try {
            f = app.project.items.addFolder("Sayframe undo");
            f.remove();
            return true;
        } catch (e) {
            return false;
        }
    }

    function undoLastStep() {
        try {
            if (typeof app.executeCommand !== "function") { return false; }
            app.executeCommand(UNDO_COMMAND);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Kept separate so the script's variables do not mix with this file's.
    // Returns SAYFRAME_CHECK_TIMES when the script declares it.
    function executeGenerated(__sayframeCode) {
        var SAYFRAME_CHECK_TIMES;
        try { SF.style("normal"); } catch (eSF) {}
        eval(__sayframeCode);
        return SAYFRAME_CHECK_TIMES;
    }

    // Sends an event to the panel (CSXSEvent needs the PlugPlug library).
    function sayframeDispatch(type, data) {
        var ev;
        try {
            if (!$.global.__sayframePlugPlug) { $.global.__sayframePlugPlug = new ExternalObject("lib:PlugPlugExternalObject"); }
            ev = new CSXSEvent();
            ev.type = type;
            ev.data = String(data);
            ev.dispatch();
        } catch (e) {}
    }

    // ---- Animation library (the "Animation" tab): presets built from keyframes, effects, text animators
    // and shape layers. Everything is generated here; nothing is copied from other products.

    // Walks a property path from a layer: names, match names or indices. Fresh lookup every time,
    // because adding a property in After Effects can invalidate older references.
    function acP(root, path) {
        var p = root, i;
        for (i = 0; i < path.length; i++) {
            if (!p) { return null; }
            p = p.property(path[i]);
        }
        return p;
    }

    function acAdd(root, path, matchName) {
        var g = acP(root, path);
        var p = g.addProperty(matchName);
        return p.propertyIndex;
    }

    function acDims(prop) {
        var v = prop.value;
        if (typeof PropertyValueType !== "undefined" &&
                (prop.propertyValueType === PropertyValueType.TwoD_SPATIAL || prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL)) { return 1; }
        return (v && typeof v === "object" && v.length !== undefined) ? v.length : 1;
    }

    // Puts keys at the given times and eases them: "ease" stops softly at every key.
    // While a preset is applied, acRec collects what it added (keys, effects, text animators),
    // so the Edit view can take exactly that back out later.
    var acRec = null;

    function acPathOf(prop) {
        var path = [], p = prop, guard = 0;
        while (p && p.propertyDepth > 0 && guard < 20) {
            if (p.matchName === "ADBE Effect Parade" || p.matchName === "ADBE Text Animators") { return null; }
            path.unshift(p.matchName);
            p = p.parentProperty;
            guard++;
        }
        return path.length ? path : null;
    }

    function acRecordKeys(prop, times) {
        var path;
        if (!acRec) { return; }
        path = acPathOf(prop);
        if (path) { acRec.keys.push({ p: path, t: times.slice(0) }); }
    }

    function acKeys(prop, times, values, influence) {
        var i, idx, n, e;
        acRecordKeys(prop, times);
        for (i = 0; i < times.length; i++) {
            idx = prop.addKey(times[i]);
            prop.setValueAtKey(idx, values[i]);
        }
        n = acDims(prop);
        for (i = 0; i < times.length; i++) {
            try {
                idx = prop.nearestKeyIndex(times[i]);
                prop.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                e = easeList(n, influence || 75);
                prop.setTemporalEaseAtKey(idx, e, easeList(n, influence || 75));
            } catch (e1) {}
        }
    }

    function acMix(a, b, m) {
        var out, i;
        if (a && typeof a === "object" && a.length !== undefined) {
            out = [];
            for (i = 0; i < a.length; i++) { out.push(a[i] + (b[i] - a[i]) * m); }
            return out;
        }
        return a + (b - a) * m;
    }

    // Animates prop between "hidden" (m = 1 of the offset) and its resting value (m = 0).
    // frames: [[f, m], ...] with f from 0 (start of the move) to 1 (end); for "out" time runs backwards.
    function acMove(w, prop, offsetOf, frames) {
        var tRest = w.dir === "in" ? w.t1 : w.t0;
        var rest = prop.valueAtTime(tRest, false);
        var k = (w.strength === undefined || w.noStrength) ? 1 : w.strength;
        var times = [], values = [], i, f, t, v;
        for (i = 0; i < frames.length; i++) {
            f = frames[i][0];
            t = w.dir === "in" ? w.t0 + f * (w.t1 - w.t0) : w.t1 - f * (w.t1 - w.t0);
            times.push(t);
            v = offsetOf(rest, frames[i][1]);
            values.push(k === 1 ? v : acMix(rest, v, k));
        }
        acKeys(prop, times, values, w.influence);
    }

    function acTransform(layer, name) { return acP(layer, ["ADBE Transform Group", name]); }

    function acFade(w) {
        var keep = w.noStrength;
        w.noStrength = true;
        acMove(w, acTransform(w.layer, "ADBE Opacity"), function (r, m) { return r * (1 - m); }, [[0, 1], [1, 0]]);
        w.noStrength = keep;
    }

    function acScaleBy(w, frames) {
        acMove(w, acTransform(w.layer, "ADBE Scale"), function (r, m) {
            var out = [], i;
            for (i = 0; i < r.length; i++) { out.push(r[i] * m); }
            return out;
        }, frames);
        acNoNegativeScale(w.layer);
    }

    // A strong setting must not flip the layer inside out.
    function acNoNegativeScale(layer) {
        var p = acTransform(layer, "ADBE Scale"), i, j, v, bad;
        for (i = 1; i <= p.numKeys; i++) {
            v = p.keyValue(i);
            bad = false;
            for (j = 0; j < v.length; j++) { if (v[j] < 0) { v[j] = 0; bad = true; } }
            if (bad) { p.setValueAtKey(i, v); }
        }
    }

    function acScaleXY(w, sx, sy) {
        acMove(w, acTransform(w.layer, "ADBE Scale"), function (r, m) {
            var out = r.slice(0);
            out[0] = r[0] * (1 + (sx - 1) * m);
            out[1] = r[1] * (1 + (sy - 1) * m);
            return out;
        }, [[0, 1], [1, 0]]);
    }

    function acRotate(w, deg, frames) {
        acMove(w, acTransform(w.layer, "ADBE Rotate Z"), function (r, m) { return r + deg * m; }, frames || [[0, 1], [1, 0]]);
    }

    // Moves the layer by (dx, dy) * m; works with separated X/Y position too.
    function acSlide(w, dx, dy, frames) {
        var pos = acTransform(w.layer, "ADBE Position");
        frames = frames || [[0, 1], [1, 0]];
        if (pos.dimensionsSeparated) {
            if (dx) { acMove(w, acTransform(w.layer, "ADBE Position_0"), function (r, m) { return r + dx * m; }, frames); }
            if (dy) { acMove(w, acTransform(w.layer, "ADBE Position_1"), function (r, m) { return r + dy * m; }, frames); }
            return;
        }
        acMove(w, pos, function (r, m) {
            var out = r.slice(0);
            out[0] = r[0] + dx * m;
            out[1] = r[1] + dy * m;
            return out;
        }, frames);
    }

    // Adds an effect and returns a getter for one of its parameters (by match name, then by index).
    var acUid = 0;

    function acTag(prop, kind) {
        var name = "Sayframe " + kind + " " + (new Date().getTime() % 100000) + "-" + (++acUid);
        try { prop.name = name; } catch (e0) { name = prop.name; }
        return name;
    }

    function acEffect(layer, matchName) {
        var idx = acAdd(layer, ["ADBE Effect Parade"], matchName);
        var tag = acTag(acP(layer, ["ADBE Effect Parade", idx]), "fx");
        if (acRec) { acRec.fx.push(tag); }
        return function (paramMatch, paramIndex) {
            var fx = acP(layer, ["ADBE Effect Parade", idx]);
            var p = null;
            try { p = fx.property(paramMatch); } catch (e0) {}
            if (!p) { p = fx.property(paramIndex); }
            return p;
        };
    }

    function acEffectMove(w, matchName, paramMatch, paramIndex, hidden, shown) {
        var param = acEffect(w.layer, matchName)(paramMatch, paramIndex);
        if (shown !== undefined) { param.setValue(shown); }
        acMove(w, param, function (r, m) { return r + (hidden - r) * m; }, [[0, 1], [1, 0]]);
    }

    var AC_MOTION = {
        // ---- animation
        "fade": function (w) { acFade(w); },
        "scale-up": function (w) { acScaleBy(w, [[0, 0], [1, 1]]); },
        "pop": function (w) { acSoft(w, 50); acScaleBy(w, [[0, 0], [0.6, 1.12], [0.82, 0.96], [1, 1]]); acFade(w); },
        "slide-left": function (w) { acSlide(w, -w.comp.width * 0.3, 0); acFade(w); },
        "slide-right": function (w) { acSlide(w, w.comp.width * 0.3, 0); acFade(w); },
        "slide-up": function (w) { acSlide(w, 0, w.comp.height * 0.3); acFade(w); },
        "slide-down": function (w) { acSlide(w, 0, -w.comp.height * 0.3); acFade(w); },
        "rotate-in": function (w) { acRotate(w, -90); acFade(w); },
        "spin-scale": function (w) { acRotate(w, -180); acScaleBy(w, [[0, 0], [1, 1]]); },
        "blur-in": function (w) { acEffectMove(w, "ADBE Gaussian Blur 2", "ADBE Gaussian Blur 2-0001", 1, 60); acFade(w); },
        "drop-bounce": function (w) {
            acSoft(w, 40);
            acSlide(w, 0, -w.comp.height * 0.5, [[0, 1], [0.55, 0], [0.72, 0.12], [0.86, 0], [0.94, 0.03], [1, 0]]);
        },
        "swing": function (w) { acSoft(w, 50); acRotate(w, 35, [[0, 1], [0.45, -0.45], [0.75, 0.2], [1, 0]]); acFade(w); },
        "squash": function (w) { acSoft(w, 50); acScaleXY(w, 1.6, 0.4); acFade(w); },
        // ---- transitions
        "zoom-blur": function (w) { acScaleBy(w, [[0, 3], [1, 1]]); acEffectMove(w, "ADBE Gaussian Blur 2", "ADBE Gaussian Blur 2-0001", 1, 80); acFade(w); },
        "spin-zoom": function (w) { acRotate(w, 360); acScaleBy(w, [[0, 0], [1, 1]]); acFade(w); },
        "push-left": function (w) { acPush(w, w.comp.width, 0); },
        "push-right": function (w) { acPush(w, -w.comp.width, 0); },
        "push-up": function (w) { acPush(w, 0, w.comp.height); },
        "wipe": function (w) {
            var get = acEffect(w.layer, "ADBE Linear Wipe");
            try { get("ADBE Linear Wipe-0003", 3).setValue(Math.round(w.comp.width * 0.08)); } catch (e0) {}
            acMove(w, get("ADBE Linear Wipe-0001", 1), function (r, m) { return r + (100 - r) * m; }, [[0, 1], [1, 0]]);
        },
        "clock-wipe": function (w) {
            var get = acEffect(w.layer, "ADBE Radial Wipe");
            acMove(w, get("ADBE Radial Wipe-0001", 1), function (r, m) { return r + (100 - r) * m; }, [[0, 1], [1, 0]]);
        },
        "flash": function (w) {
            acEffectMove(w, "ADBE Brightness & Contrast 2", "ADBE Brightness & Contrast 2-0001", 1, 150);
            acFade(w);
        },
        "glitch": function (w) { acGlitch(w); },
        "stretch": function (w) { acScaleXY(w, 4, 0.15); acFade(w); },
        "blur": function (w) { acEffectMove(w, "ADBE Gaussian Blur 2", "ADBE Gaussian Blur 2-0001", 1, 120); }
    };

    function acSoft(w, influence) { if (!w.userEase) { w.influence = influence; } }

    function acPush(w, dx, dy) {
        try { w.layer.motionBlur = true; w.comp.motionBlur = true; } catch (e0) {}
        acSoft(w, 85);
        acSlide(w, dx, dy);
    }

    // Short jumps sideways and blinking, frame by frame; held keys make it look digital.
    function acGlitch(w) {
        var pos = acTransform(w.layer, "ADBE Position");
        var op = acTransform(w.layer, "ADBE Opacity");
        var fd = w.comp.frameDuration || (1 / 30);
        var steps = Math.max(4, Math.round((w.t1 - w.t0) / fd));
        var restPos = pos.valueAtTime(w.dir === "in" ? w.t1 : w.t0, false);
        var restOp = op.valueAtTime(w.dir === "in" ? w.t1 : w.t0, false);
        var seed = 7, i, t, p, k, rnd;
        rnd = function () { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
        for (i = 0; i <= steps; i++) {
            t = w.t0 + i * (w.t1 - w.t0) / steps;
            k = w.dir === "in" ? 1 - i / steps : i / steps;   // strength: strong at the hidden end
            if (!pos.dimensionsSeparated) {
                p = restPos.slice(0);
                p[0] += (rnd() - 0.5) * w.comp.width * 0.12 * k;
                p[1] += (rnd() - 0.5) * w.comp.height * 0.03 * k;
                pos.setValueAtTime(t, i === (w.dir === "in" ? steps : 0) ? restPos : p);
            }
            op.setValueAtTime(t, i === (w.dir === "in" ? steps : 0) ? restOp : (rnd() < 0.35 * k ? 0 : restOp));
        }
        var all = [];
        for (i = 0; i <= steps; i++) { all.push(w.t0 + i * (w.t1 - w.t0) / steps); }
        acRecordKeys(op, all);
        if (!pos.dimensionsSeparated) { acRecordKeys(pos, all); }
        try {
            for (i = 1; i <= op.numKeys; i++) { op.setInterpolationTypeAtKey(i, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); }
            for (i = 1; i <= pos.numKeys; i++) { pos.setInterpolationTypeAtKey(i, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); }
        } catch (e1) {}
    }

    // Time window of the move on one layer: right after it appears ("in") or right before it ends ("out").
    function acWindow(layer, comp, dir, dur, both, delay) {
        var len = layer.outPoint - layer.inPoint;
        var room, d;
        delay = Math.max(0, Math.min(delay || 0, len * (both ? 0.5 : 1) - (comp.frameDuration || 0.01)));
        room = (both ? len / 2 : len) - delay;
        d = Math.max(Math.min(dur, room), comp.frameDuration || 0.01);
        return dir === "in" ? { t0: layer.inPoint + delay, t1: layer.inPoint + delay + d } : { t0: layer.outPoint - delay - d, t1: layer.outPoint - delay };
    }

    // ---- what Sayframe put on a layer is remembered in the layer's comment, after the user's own text.
    var AC_MARK = "[Sayframe presets] ";

    function acLoad(layer) {
        var c = "", at, list;
        try { c = String(layer.comment || ""); } catch (e0) {}
        at = c.indexOf(AC_MARK);
        if (at < 0) { return []; }
        try { list = eval("(" + c.substring(at + AC_MARK.length) + ")"); } catch (e1) { list = []; }
        return (list instanceof Array) ? list : [];
    }

    function acSave(layer, list) {
        var c = "", at;
        try { c = String(layer.comment || ""); } catch (e0) {}
        at = c.indexOf(AC_MARK);
        if (at >= 0) { c = c.substring(0, at).replace(/\s+$/, ""); }
        if (list.length) { c = (c ? c + "\n" : "") + AC_MARK + toJSON(list); }
        try { layer.comment = c; } catch (e1) {}
    }

    // Returns "" when every direction went on, otherwise the first error (shown to the user as is).
    var acLastError = "";

    function acApplyAll(l, comp, id, dirs, dur) {
        var list = acLoad(l), ok = true, j;
        for (j = 0; j < dirs.length; j++) {
            try { list.push(acApplyOne(l, comp, id, dirs[j], { dur: dur, half: dirs.length > 1 })); } catch (e0) {
                ok = false;
                if (!acLastError) { acLastError = String(e0 && e0.message ? e0.message : e0) + (e0 && e0.line ? " (line " + e0.line + ")" : ""); }
            }
        }
        acSave(l, list);
        return ok;
    }

    function acSectionOf(id) { return AC_TEXT[id] ? "text" : (AC_MOTION[id] ? "motion" : ""); }

    // Applies one preset in one direction and returns the record of what it added.
    function acApplyOne(layer, comp, id, dir, prm) {
        var w = acWindow(layer, comp, dir, prm.dur, !!prm.half, prm.delay);
        var rec = { id: id, dir: dir, dur: prm.dur, delay: prm.delay || 0, strength: prm.strength === undefined ? 1 : prm.strength,
            ease: prm.ease || 0, half: !!prm.half, keys: [], fx: [], an: [] };
        w.layer = layer; w.comp = comp; w.dir = dir;
        w.influence = rec.ease || (AC_TEXT[id] ? 60 : 75);
        w.userEase = !!rec.ease;
        w.strength = rec.strength;
        acRec = rec;
        try {
            if (AC_TEXT[id]) { AC_TEXT[id](layer, w); } else { AC_MOTION[id](w); }
        } finally {
            acRec = null;
        }
        // A preset that sets its own softness (springs, bounces) keeps it unless the user picked one.
        return rec;
    }

    // Takes back exactly what a record added: its keys (at their times), effects and text animators.
    function acTakeOut(layer, rec) {
        var i, j, k, prop, idx, parade, anims;
        for (i = 0; i < rec.keys.length; i++) {
            prop = acP(layer, rec.keys[i].p);
            if (!prop) { continue; }
            for (j = rec.keys[i].t.length - 1; j >= 0; j--) {
                for (k = prop.numKeys; k >= 1; k--) {
                    if (Math.abs(prop.keyTime(k) - rec.keys[i].t[j]) < 0.0005) { prop.removeKey(k); break; }
                }
            }
        }
        parade = acP(layer, ["ADBE Effect Parade"]);
        for (i = 0; parade && i < rec.fx.length; i++) {
            for (k = parade.numProperties; k >= 1; k--) {
                if (parade.property(k).name === rec.fx[i]) { parade.property(k).remove(); break; }
            }
        }
        anims = null;
        try { anims = acP(layer, ["ADBE Text Properties", "ADBE Text Animators"]); } catch (e0) {}
        for (i = 0; anims && i < rec.an.length; i++) {
            for (k = anims.numProperties; k >= 1; k--) {
                if (anims.property(k).name === rec.an[i]) { anims.property(k).remove(); break; }
            }
        }
    }

    function acEditLayer() {
        var comp = activeComp();
        var layers = comp.selectedLayers;
        if (!layers || !layers.length) { throw new Error("NO_LAYERS_SELECTED"); }
        return { comp: comp, layer: layers[0] };
    }

    function acPublic(list) {
        var out = [], i;
        for (i = 0; i < list.length; i++) {
            out.push({ id: list[i].id, dir: list[i].dir, dur: list[i].dur, delay: list[i].delay, strength: list[i].strength, ease: list[i].ease });
        }
        return out;
    }

    // ---- text presets: text animators with a range selector

    function acTextAnim(layer, props, w, opts) {
        var root = ["ADBE Text Properties", "ADBE Text Animators"];
        var ai = acAdd(layer, root, "ADBE Text Animator");
        var a = root.concat([ai]);
        var i, pi, si, sel, startP, endP, tag = acTag(acP(layer, a), "text");
        if (acRec) { acRec.an.push(tag); }
        for (i = 0; i < props.length; i++) {
            pi = acAdd(layer, a.concat(["ADBE Text Animator Properties"]), props[i][0]);
            acP(layer, a.concat(["ADBE Text Animator Properties", pi])).setValue(props[i][1]);
        }
        si = acAdd(layer, a.concat(["ADBE Text Selectors"]), "ADBE Text Selector");
        sel = a.concat(["ADBE Text Selectors", si]);
        opts = opts || {};
        try { if (opts.basedOn) { acP(layer, sel.concat(["ADBE Text Range Advanced", "ADBE Text Range Type2"])).setValue(opts.basedOn); } } catch (e0) {}
        try { if (opts.random) { acP(layer, sel.concat(["ADBE Text Range Advanced", "ADBE Text Randomize Order"])).setValue(1); } } catch (e1) {}
        try { if (opts.smooth !== undefined) { acP(layer, sel.concat(["ADBE Text Range Advanced", "ADBE Text Selector Smoothness"])).setValue(opts.smooth); } } catch (e2) {}
        startP = acP(layer, sel.concat(["ADBE Text Percent Start"]));
        endP = acP(layer, sel.concat(["ADBE Text Percent End"]));
        if (w.dir === "in") {
            acKeys(startP, [w.t0, w.t1], [0, 100], w.userEase ? w.influence : 40);
        } else {
            startP.setValue(0);
            acKeys(endP, [w.t0, w.t1], [0, 100], w.userEase ? w.influence : 40);
        }
    }

    var AC_TEXT = {
        "typewriter": function (l, w) { acTextAnim(l, [["ADBE Text Opacity", 0]], w, { smooth: 0 }); },
        "fade-letters": function (l, w) { acTextAnim(l, [["ADBE Text Opacity", 0]], w, { smooth: 100 }); },
        "slide-letters": function (l, w) { acTextAnim(l, [["ADBE Text Position 3D", [0, 80, 0]], ["ADBE Text Opacity", 0]], w, { smooth: 100 }); },
        "pop-letters": function (l, w) { acTextAnim(l, [["ADBE Text Scale 3D", [0, 0, 100]], ["ADBE Text Opacity", 0]], w, { smooth: 100 }); },
        "blur-letters": function (l, w) { acTextAnim(l, [["ADBE Text Blur", [30, 30]], ["ADBE Text Opacity", 0]], w, { smooth: 100 }); },
        "rotate-letters": function (l, w) { acTextAnim(l, [["ADBE Text Rotation", 90], ["ADBE Text Opacity", 0]], w, { smooth: 100 }); },
        "words": function (l, w) { acTextAnim(l, [["ADBE Text Position 3D", [0, 40, 0]], ["ADBE Text Opacity", 0]], w, { basedOn: 3, smooth: 100 }); },
        "random": function (l, w) { acTextAnim(l, [["ADBE Text Opacity", 0]], w, { random: true, smooth: 0 }); },
        "tracking": function (l, w) {
            var root = ["ADBE Text Properties", "ADBE Text Animators"];
            var ai = acAdd(l, root, "ADBE Text Animator");
            var tag = acTag(acP(l, root.concat([ai])), "text");
            var pi = acAdd(l, root.concat([ai, "ADBE Text Animator Properties"]), "ADBE Text Tracking Amount");
            if (acRec) { acRec.an.push(tag); }
            var tr = acP(l, root.concat([ai, "ADBE Text Animator Properties", pi]));
            acMove(w, tr, function (r, m) { return r + 60 * m; }, [[0, 1], [1, 0]]);
            acFade(w);
        }
    };

    // ---- graphics: new shape and text layers built at the time indicator

    function acShapeLayer(comp, name, total) {
        var l = comp.layers.addShape();
        l.name = name;
        acPlace(l, comp, total);
        return l;
    }

    function acPlace(l, comp, total) {
        var t = comp.time;
        try {
            l.startTime = t;
            l.inPoint = t;
            l.outPoint = Math.min(comp.duration, t + total);
        } catch (e0) {}
    }

    function acGroup(l) {
        return acAdd(l, ["ADBE Root Vectors Group"], "ADBE Vector Group");
    }

    function acIn(l, gi, matchName) {
        return acAdd(l, ["ADBE Root Vectors Group", gi, "ADBE Vectors Group"], matchName);
    }

    function acGP(l, gi, path) { return acP(l, ["ADBE Root Vectors Group", gi].concat(path)); }

    function acColor(c) { return [c[0], c[1], c[2], 1]; }

    function acStroke(l, gi, color, width) {
        var si = acIn(l, gi, "ADBE Vector Graphic - Stroke");
        acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Color"]).setValue(acColor(color));
        acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Width"]).setValue(width);
        try { acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Line Cap"]).setValue(2); } catch (e0) {}
        return si;
    }

    function acFill(l, gi, color) {
        var fi = acIn(l, gi, "ADBE Vector Graphic - Fill");
        acGP(l, gi, ["ADBE Vectors Group", fi, "ADBE Vector Fill Color"]).setValue(acColor(color));
        return fi;
    }

    function acPath(l, gi, points, closed) {
        var pi = acIn(l, gi, "ADBE Vector Shape - Group");
        var s = new Shape();
        s.vertices = points;
        s.closed = !!closed;
        acGP(l, gi, ["ADBE Vectors Group", pi, "ADBE Vector Shape"]).setValue(s);
        return pi;
    }

    function acTrimOn(l, gi, w, tail) {
        var ti = acIn(l, gi, "ADBE Vector Filter - Trim");
        acKeys(acGP(l, gi, ["ADBE Vectors Group", ti, "ADBE Vector Trim End"]), [w.t0, w.t0 + w.d], [0, 100], 80);
        if (tail) { acKeys(acGP(l, gi, ["ADBE Vectors Group", ti, "ADBE Vector Trim Start"]), [w.end - w.d, w.end], [0, 100], 80); }
    }

    function acGroupKeys(l, gi, name, times, values, infl) {
        acKeys(acGP(l, gi, ["ADBE Vector Transform Group", name]), times, values, infl);
    }

    function acTextLayer(comp, text, name, total, color) {
        var l = comp.layers.addText(text);
        var p, doc;
        l.name = name;
        acPlace(l, comp, total);
        try {
            p = acP(l, ["ADBE Text Properties", "ADBE Text Document"]);
            doc = p.value;
            doc.fontSize = Math.round(comp.height / 8);
            doc.fillColor = [color[0], color[1], color[2]];
            doc.justification = ParagraphJustification.CENTER_JUSTIFY;
            p.setValue(doc);
        } catch (e0) {}
        return l;
    }

    var AC_GRAPHIC = {
        "ring": function (comp, w, c) {
            var l = acShapeLayer(comp, "Ring", w.total), gi = acGroup(l);
            acIn(l, gi, "ADBE Vector Shape - Ellipse");
            acGP(l, gi, ["ADBE Vectors Group", 1, "ADBE Vector Ellipse Size"]).setValue([comp.height * 0.4, comp.height * 0.4]);
            var si = acStroke(l, gi, c, 16);
            acGroupKeys(l, gi, "ADBE Vector Scale", [w.t0, w.t0 + w.d * 1.5], [[0, 0], [100, 100]], 80);
            acKeys(acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Width"]), [w.t0, w.t0 + w.d * 1.5], [30, 0], 60);
            return l;
        },
        "burst": function (comp, w, c) {
            var l = acShapeLayer(comp, "Burst", w.total), gi = acGroup(l), ri, rp;
            ri = acIn(l, gi, "ADBE Vector Shape - Rect");
            acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Size"]).setValue([10, comp.height * 0.08]);
            acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Roundness"]).setValue(5);
            acFill(l, gi, c);
            rp = acIn(l, gi, "ADBE Vector Filter - Repeater");
            acGP(l, gi, ["ADBE Vectors Group", rp, "ADBE Vector Repeater Copies"]).setValue(8);
            acGP(l, gi, ["ADBE Vectors Group", rp, "ADBE Vector Repeater Transform", "ADBE Vector Repeater Position"]).setValue([0, 0]);
            acGP(l, gi, ["ADBE Vectors Group", rp, "ADBE Vector Repeater Transform", "ADBE Vector Repeater Rotation"]).setValue(45);
            acKeys(acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Position"]), [w.t0, w.t0 + w.d * 1.5], [[0, -comp.height * 0.06], [0, -comp.height * 0.22]], 80);
            acGroupKeys(l, gi, "ADBE Vector Group Opacity", [w.t0 + w.d * 0.6, w.t0 + w.d * 1.5], [100, 0], 60);
            return l;
        },
        "underline": function (comp, w, c) {
            var l = acShapeLayer(comp, "Underline", w.total), gi = acGroup(l), half = comp.width * 0.2;
            acPath(l, gi, [[-half, 0], [half, 0]], false);
            acStroke(l, gi, c, Math.max(4, Math.round(comp.height / 90)));
            acTrimOn(l, gi, w, true);
            return l;
        },
        "lower-third": function (comp, w, c) {
            var l = acShapeLayer(comp, "Lower Third", w.total), gi = acGroup(l), ri, bw = comp.width * 0.36, bh = comp.height * 0.1;
            ri = acIn(l, gi, "ADBE Vector Shape - Rect");
            acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Size"]).setValue([bw, bh]);
            acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Roundness"]).setValue(bh * 0.18);
            acFill(l, gi, c);
            acGP(l, gi, ["ADBE Vector Transform Group", "ADBE Vector Anchor"]).setValue([-bw / 2, 0]);
            acGP(l, gi, ["ADBE Vector Transform Group", "ADBE Vector Position"]).setValue([-bw / 2, 0]);
            try { acTransform(l, "ADBE Position").setValue([comp.width * 0.3, comp.height * 0.82]); } catch (e0) {}
            acGroupKeys(l, gi, "ADBE Vector Scale", [w.t0, w.t0 + w.d, w.end - w.d, w.end], [[0, 100], [100, 100], [100, 100], [0, 100]], 85);
            return l;
        },
        "arrow": function (comp, w, c) {
            var l = acShapeLayer(comp, "Arrow", w.total), gi = acGroup(l), s = comp.height * 0.15;
            acPath(l, gi, [[-s * 1.6, 0], [s * 1.6, 0]], false);
            acPath(l, gi, [[s * 1.1, -s * 0.5], [s * 1.6, 0], [s * 1.1, s * 0.5]], false);
            acStroke(l, gi, c, Math.max(6, Math.round(comp.height / 70)));
            acTrimOn(l, gi, w, false);
            return l;
        },
        "progress": function (comp, w, c) {
            var l = acShapeLayer(comp, "Progress Bar", w.total), bw = comp.width * 0.4, bh = Math.max(8, comp.height * 0.025), g1, g2, ri;
            g1 = acGroup(l);
            ri = acIn(l, g1, "ADBE Vector Shape - Rect");
            acGP(l, g1, ["ADBE Vectors Group", ri, "ADBE Vector Rect Size"]).setValue([bw, bh]);
            acGP(l, g1, ["ADBE Vectors Group", ri, "ADBE Vector Rect Roundness"]).setValue(bh / 2);
            acFill(l, g1, c);
            acGP(l, g1, ["ADBE Vector Transform Group", "ADBE Vector Group Opacity"]).setValue(25);
            g2 = acGroup(l);
            ri = acIn(l, g2, "ADBE Vector Shape - Rect");
            acGP(l, g2, ["ADBE Vectors Group", ri, "ADBE Vector Rect Size"]).setValue([bw, bh]);
            acGP(l, g2, ["ADBE Vectors Group", ri, "ADBE Vector Rect Roundness"]).setValue(bh / 2);
            acFill(l, g2, c);
            acGP(l, g2, ["ADBE Vector Transform Group", "ADBE Vector Anchor"]).setValue([-bw / 2, 0]);
            acGP(l, g2, ["ADBE Vector Transform Group", "ADBE Vector Position"]).setValue([-bw / 2, 0]);
            acGroupKeys(l, g2, "ADBE Vector Scale", [w.t0, w.end - w.d], [[0, 100], [100, 100]], 40);
            return l;
        },
        "ripples": function (comp, w, c) {
            var l = acShapeLayer(comp, "Ripples", w.total), gi = acGroup(l), rp;
            acIn(l, gi, "ADBE Vector Shape - Ellipse");
            acGP(l, gi, ["ADBE Vectors Group", 1, "ADBE Vector Ellipse Size"]).setValue([comp.height * 0.5, comp.height * 0.5]);
            acStroke(l, gi, c, 6);
            rp = acIn(l, gi, "ADBE Vector Filter - Repeater");
            acGP(l, gi, ["ADBE Vectors Group", rp, "ADBE Vector Repeater Copies"]).setValue(3);
            acGP(l, gi, ["ADBE Vectors Group", rp, "ADBE Vector Repeater Transform", "ADBE Vector Repeater Position"]).setValue([0, 0]);
            acGP(l, gi, ["ADBE Vectors Group", rp, "ADBE Vector Repeater Transform", "ADBE Vector Repeater Scale"]).setValue([70, 70]);
            acGroupKeys(l, gi, "ADBE Vector Scale", [w.t0, w.end], [[0, 0], [130, 130]], 50);
            acGroupKeys(l, gi, "ADBE Vector Group Opacity", [w.end - w.d, w.end], [100, 0], 50);
            return l;
        },
        "star": function (comp, w, c) {
            var l = acShapeLayer(comp, "Star", w.total), gi = acGroup(l), si, r = comp.height * 0.16;
            si = acIn(l, gi, "ADBE Vector Shape - Star");
            try {
                acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Star Type"]).setValue(1);
                acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Star Points"]).setValue(5);
                acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Star Outer Radius"]).setValue(r);
                acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Star Inner Radius"]).setValue(r * 0.45);
                acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Star Outer Roundess"]).setValue(10);
            } catch (e0) {}
            acFill(l, gi, c);
            acGroupKeys(l, gi, "ADBE Vector Scale", [w.t0, w.t0 + w.d * 0.6, w.t0 + w.d], [[0, 0], [115, 115], [100, 100]], 50);
            acGroupKeys(l, gi, "ADBE Vector Rotation", [w.t0, w.t0 + w.d], [-90, 0], 70);
            return l;
        },
        "counter": function (comp, w, c) {
            var l = acTextLayer(comp, "0%", "Counter", w.total, c);
            acP(l, ["ADBE Text Properties", "ADBE Text Document"]).expression =
                "Math.round(linear(time, inPoint, inPoint + " + Math.max(0.5, w.total - w.d).toFixed(2) + ", 0, 100)) + \"%\"";
            return l;
        },
        "timer": function (comp, w, c) {
            var l = acTextLayer(comp, "00:10", "Timer", Math.max(w.total, 10), c);
            acP(l, ["ADBE Text Properties", "ADBE Text Document"]).expression =
                "var s = Math.max(0, Math.ceil(10 - (time - inPoint)));\nvar m = Math.floor(s / 60), r = s % 60;\n" +
                "(m < 10 ? \"0\" : \"\") + m + \":\" + (r < 10 ? \"0\" : \"\") + r";
            return l;
        }
    };

    // ---- Motion presets, built the way Animation Composer works: nothing is baked into keys.
    // A preset puts three things on the layer:
    //   - one layer marker per direction ("IN" at the start of the layer, "OUT" at its end). Its length
    //     is the duration, and its comment carries the presets' tags, e.g. {sf:from-bottom:in:over};
    //   - Slider / Angle Control effects with the preset's settings (and a Gaussian Blur for blur presets);
    //   - expressions on the layer's own Position, Scale, Rotation and Opacity that read both.
    // So the motion lies on top of the layer's own keys, travels with the layer, stretching the marker
    // changes the duration, and taking a preset off leaves the layer exactly as it was.

    var SF_MOTIONS = {
        "fade": { op: 0 },
        "from-bottom": { op: 0, dy: 1 },
        "from-top": { op: 0, dy: -1 },
        "from-left": { op: 0, dx: -1 },
        "from-right": { op: 0, dx: 1 },
        "scale-up": { op: 0, sc: 0 },
        "scale-down": { op: 0, sc: 200 },
        "rotate": { op: 0, rot: -90 },
        "spin": { op: 0, rot: -360, sc: 0 },
        "blur": { op: 0, blur: 40 },
        "blur-scale": { op: 0, blur: 30, sc: 130 },
        "rise-rotate": { op: 0, dy: 1, rot: -20 },
        "rise-scale": { op: 0, dy: 1, sc: 60 },
        "stretch": { op: 0, scx: 300, scy: 20 },
        "drop": { dy: -1, far: true }
    };
    var SF_CURVES = { "ease": true, "linear": true, "over": true, "bounce": true, "elastic": true };
    var SF_KEYS = ["dist", "sc", "scx", "scy", "rot", "op"];

    var SF_HEAD = [
        "// Sayframe: written by the Sayframe panel. It reads the IN/OUT layer markers and the preset controls in Effect Controls.",
        "function sfM(t){var m=thisLayer.marker,i;for(i=1;i<=m.numKeys;i++){if(m.key(i).comment==t)return m.key(i);}return null;}",
        "function sfF(p,c){p=Math.min(1,Math.max(0,p));if(c==\"linear\")return p;" +
            "if(c==\"over\"){var s=1.70158,q=p-1;return 1+(s+1)*q*q*q+s*q*q;}" +
            "if(c==\"bounce\"){var n=7.5625,d=2.75;if(p<1/d)return n*p*p;if(p<2/d){p-=1.5/d;return n*p*p+0.75;}" +
            "if(p<2.5/d){p-=2.25/d;return n*p*p+0.9375;}p-=2.625/d;return n*p*p+0.984375;}" +
            "if(c==\"elastic\"){if(p<=0||p>=1)return p;return Math.pow(2,-10*p)*Math.sin((p*10-0.75)*2*Math.PI/3)+1;}" +
            "return 1-Math.pow(1-p,3);}",
        "function sfK(t,d,c){var k=sfM(t);if(!k)return 0;var u=Math.max(k.duration,thisComp.frameDuration),p=(time-k.time)/u;" +
            "return d==\"in\"?1-sfF(p,c):1-sfF(1-p,c);}",
        "function sfS(n,v){try{return effect(n)(1);}catch(e){return v;}}"
    ].join("\n");

    function sfParamKeys(m) {
        var out = [], i;
        for (i = 0; i < SF_KEYS.length; i++) {
            if (SF_KEYS[i] === "dist" ? (m.dx || m.dy) : m[SF_KEYS[i]] !== undefined) { out.push(SF_KEYS[i]); }
        }
        return out;
    }

    function sfDefault(m, key, comp) {
        if (key === "dist") { return Math.round(comp.height * (m.far ? 0.6 : 0.2)); }
        return m[key];
    }

    function sfMarkerProp(layer) { return layer.property("ADBE Marker"); }

    // Like Animation Composer, the markers carry very short names ("In", "Out"); which presets sit on them
    // and the names of their controls are kept in the marker's hidden parameters.
    var SF_MARK = { "in": "In", "out": "Out" };

    // The Sayframe marker of one direction: {index, time, dur, presets: [{motion, curve}], names}.
    function sfReadMarker(layer, dir) {
        var mk = sfMarkerProp(layer), i, mv, re, m, out, params;
        if (!mk) { return null; }
        for (i = 1; i <= mk.numKeys; i++) {
            mv = mk.keyValue(i);
            out = { index: i, time: mk.keyTime(i), dur: mv.duration, presets: [], names: {} };
            try { params = mv.getParameters() || {}; } catch (e1) { params = {}; }
            if (String(mv.comment) === SF_MARK[dir] && params.sfp) {
                try { out.presets = eval("(" + params.sfp + ")"); } catch (e2) { out.presets = []; }
            } else {
                // markers written by earlier versions carry the presets as tags in the comment
                re = /\{sf:([a-z0-9\-]+):(in|out):([a-z]+)\}/g;
                while ((m = re.exec(String(mv.comment))) !== null) {
                    if (m[2] === dir) { out.presets.push({ motion: m[1], curve: m[3] }); }
                }
            }
            if (!out.presets || !out.presets.length) { continue; }
            try {
                out.names = params.sf ? eval("(" + params.sf + ")") : {};
            } catch (e0) { out.names = {}; }
            if (!out.names || typeof out.names !== "object") { out.names = {}; }
            return out;
        }
        return null;
    }

    // Writes (or removes, when no presets are left) the marker of one direction.
    function sfWriteMarker(layer, dir, data, fd) {
        var mk = sfMarkerProp(layer), old = sfReadMarker(layer, dir), mv, i, p, n, parts = [], tags = [], keep = {}, t, k;
        if (old) { mk.removeKey(old.index); }
        if (!data.presets.length) { return; }
        for (i = 0; i < data.presets.length; i++) {
            p = data.presets[i];
            n = data.names[p.motion] || {};
            parts.push((n.title || p.motion) + (n.curveLabel ? " (" + n.curveLabel + ")" : ""));
            tags.push("{sf:" + p.motion + ":" + dir + ":" + p.curve + "}");
            keep[p.motion] = n;
        }
        mv = new MarkerValue(SF_MARK[dir]);
        mv.duration = Math.max(data.dur, fd || 0.01);
        try { mv.setParameters({ sf: toJSON(keep), sfp: toJSON(data.presets) }); } catch (e0) {}
        // Two markers cannot share a time: a marker of the user's own there keeps its place.
        t = data.time;
        for (k = 1; k <= mk.numKeys; k++) {
            if (Math.abs(mk.keyTime(k) - t) < 0.0001) { t += fd || 0.01; k = 0; }
        }
        mk.setValueAtTime(t, mv);
    }

    function sfAllPresets(layer) {
        var out = [], dirs = ["in", "out"], d, mk, j;
        for (d = 0; d < dirs.length; d++) {
            mk = sfReadMarker(layer, dirs[d]);
            if (!mk) { continue; }
            for (j = 0; j < mk.presets.length; j++) {
                out.push({ motion: mk.presets[j].motion, curve: mk.presets[j].curve, dir: dirs[d], names: mk.names[mk.presets[j].motion] || {} });
            }
        }
        return out;
    }

    function sfFx(layer, name) {
        var parade = layer.property("ADBE Effect Parade"), i;
        if (!parade || !name) { return null; }
        for (i = 1; i <= parade.numProperties; i++) {
            if (parade.property(i).name === name) { return parade.property(i); }
        }
        return null;
    }

    function sfRemoveFx(layer, name) {
        var fx = sfFx(layer, name);
        while (fx) { fx.remove(); fx = sfFx(layer, name); }
    }

    function sfOurs(prop) { return String(prop.expression || "").indexOf("// Sayframe:") === 0; }

    // An expression of the user's own is never overwritten: that property is left out and reported.
    function sfSetExpr(prop, body, skipped) {
        if (!prop) { return; }
        if (prop.expression && !sfOurs(prop)) {
            if (body) { skipped.push(prop.name); }
            return;
        }
        if (!body) {
            if (prop.expression) { prop.expression = ""; }
            return;
        }
        prop.expression = SF_HEAD + "\n" + body;
    }

    // Writes every Sayframe expression of the layer from its markers; returns the properties it had to skip.
    function sfRebuild(layer) {
        var list = sfAllPresets(layer), tr = layer.property("ADBE Transform Group");
        var pos = [], sc = [], rot = [], op = [], skipped = [], i, it, m, fx, tag, a, soft, posProp, bx, by, bp, j, blurFx;
        var q = jsonString;
        for (i = 0; i < list.length; i++) {
            it = list[i];
            if (sfTextId(it.motion)) { sftExpr(layer, it, skipped); continue; }
            m = SF_MOTIONS[it.motion];
            if (!m) { continue; }
            fx = it.names.fx || {};
            tag = q(SF_MARK[it.dir]);
            a = "sfK(" + tag + "," + q(it.dir) + "," + q(it.curve) + ")";
            soft = "sfK(" + tag + "," + q(it.dir) + "," + q(it.curve === "linear" ? "linear" : "ease") + ")";
            if (m.dx || m.dy) { pos.push({ a: a, s: "sfS(" + q(fx.dist || "") + ",0)", dx: m.dx || 0, dy: m.dy || 0 }); }
            if (m.sc !== undefined) {
                sc.push("f=1+" + a + "*(sfS(" + q(fx.sc || "") + "," + m.sc + ")/100-1);v[0]*=f;v[1]*=f;if(v.length>2)v[2]*=f;");
            }
            if (m.scx !== undefined) {
                sc.push("v[0]*=1+" + a + "*(sfS(" + q(fx.scx || "") + "," + m.scx + ")/100-1);" +
                    "v[1]*=1+" + a + "*(sfS(" + q(fx.scy || "") + "," + m.scy + ")/100-1);");
            }
            if (m.rot !== undefined) { rot.push("v+=sfS(" + q(fx.rot || "") + "," + m.rot + ")*" + a + ";"); }
            if (m.op !== undefined) { op.push("v*=1-" + soft + "*(1-sfS(" + q(fx.op || "") + "," + m.op + ")/100);"); }
            if (m.blur !== undefined) {
                blurFx = sfFx(layer, fx.blur);
                if (blurFx) { sfSetExpr(blurFx.property(1), "value*" + soft, skipped); }
            }
        }
        posProp = tr.property("ADBE Position");
        if (posProp.dimensionsSeparated) {
            bx = []; by = [];
            for (j = 0; j < pos.length; j++) {
                if (pos[j].dx) { bx.push("v+=" + pos[j].dx + "*" + pos[j].s + "*" + pos[j].a + ";"); }
                if (pos[j].dy) { by.push("v+=" + pos[j].dy + "*" + pos[j].s + "*" + pos[j].a + ";"); }
            }
            sfSetExpr(tr.property("ADBE Position_0"), bx.length ? "var v=value;\n" + bx.join("\n") + "\nv" : "", skipped);
            sfSetExpr(tr.property("ADBE Position_1"), by.length ? "var v=value;\n" + by.join("\n") + "\nv" : "", skipped);
        } else {
            bp = [];
            for (j = 0; j < pos.length; j++) {
                bp.push((pos[j].dx ? "v[0]+=" + pos[j].dx + "*" + pos[j].s + "*" + pos[j].a + ";" : "") +
                    (pos[j].dy ? "v[1]+=" + pos[j].dy + "*" + pos[j].s + "*" + pos[j].a + ";" : ""));
            }
            sfSetExpr(posProp, bp.length ? "var v=value.slice(0);\n" + bp.join("\n") + "\nv" : "", skipped);
        }
        sfSetExpr(tr.property("ADBE Scale"), sc.length ? "var v=value.slice(0),f;\n" + sc.join("\n") + "\nv" : "", skipped);
        sfSetExpr(tr.property("ADBE Rotate Z"), rot.length ? "var v=value;\n" + rot.join("\n") + "\nv" : "", skipped);
        sfSetExpr(tr.property("ADBE Opacity"), op.length ? "var v=value;\n" + op.join("\n") + "\nv" : "", skipped);
        return skipped;
    }

    function sfAddControl(layer, key, name, value) {
        var idx = acAdd(layer, ["ADBE Effect Parade"], key === "rot" ? "ADBE Angle Control" : "ADBE Slider Control");
        acP(layer, ["ADBE Effect Parade", idx]).name = name;
        acP(layer, ["ADBE Effect Parade", idx, 1]).setValue(value);
    }

    function sfAddBlur(layer, name, value) {
        var idx = acAdd(layer, ["ADBE Effect Parade"], "ADBE Gaussian Blur 2");
        acP(layer, ["ADBE Effect Parade", idx]).name = name;
        acP(layer, ["ADBE Effect Parade", idx, 1]).setValue(value);
        try { acP(layer, ["ADBE Effect Parade", idx, "ADBE Gaussian Blur 2-0003"]).setValue(1); } catch (e0) {}
    }

    function sfPrefix(dir, title) { return (dir === "in" ? "IN " : "OUT ") + title + " \u00b7 "; }

    // Puts one preset on one direction of the layer (its controls, and its tag on the marker).
    function sfAdd(layer, comp, motion, curve, dir, dur, both, labels) {
        var m = SF_MOTIONS[motion] || {}, mk = sfReadMarker(layer, dir), fd = comp.frameDuration || 0.01;
        var title = labels.title || motion, keys = sfTextId(motion) ? [] : sfParamKeys(m), names, i, nm, w, data, end;
        names = sfTextId(motion) ? sftAdd(layer, motion, dir, labels) : { title: title, curveLabel: labels.curve || "", fx: {} };
        for (i = 0; i < keys.length; i++) {
            nm = sfPrefix(dir, title) + (labels[keys[i]] || keys[i]);
            sfRemoveFx(layer, nm);
            sfAddControl(layer, keys[i], nm, sfDefault(m, keys[i], comp));
            names.fx[keys[i]] = nm;
        }
        if (m.blur !== undefined) {
            nm = sfPrefix(dir, title) + (labels.blur || "Blur");
            sfRemoveFx(layer, nm);
            sfAddBlur(layer, nm, m.blur);
            names.fx.blur = nm;
        }
        w = acWindow(layer, comp, dir, dur, both, 0);
        if (mk) {
            // The direction already has presets: they now share the chosen duration; OUT keeps its end.
            end = mk.time + mk.dur;
            data = { time: dir === "in" ? mk.time : Math.max(layer.inPoint, end - (w.t1 - w.t0)), dur: w.t1 - w.t0, presets: mk.presets, names: mk.names };
        } else {
            data = { time: w.t0, dur: w.t1 - w.t0, presets: [], names: {} };
        }
        data.presets.push({ motion: motion, curve: curve });
        data.names[motion] = names;
        sfWriteMarker(layer, dir, data, fd);
    }

    // Takes one preset off one direction: its controls, its tag, the marker when it was the last one.
    function sfTake(layer, comp, dir, motion) {
        var mk = sfReadMarker(layer, dir), rest = [], i, fx, k;
        if (!mk) { return false; }
        fx = (mk.names[motion] && mk.names[motion].fx) || {};
        for (k in fx) { if (fx.hasOwnProperty(k)) { sfRemoveFx(layer, fx[k]); } }
        fx = (mk.names[motion] && mk.names[motion].anim) || [];
        for (i = 0; i < fx.length; i++) { sftRemove(layer, fx[i].name); }
        for (i = 0; i < mk.presets.length; i++) { if (mk.presets[i].motion !== motion) { rest.push(mk.presets[i]); } }
        delete mk.names[motion];
        sfWriteMarker(layer, dir, { time: mk.time, dur: mk.dur, presets: rest, names: mk.names }, comp.frameDuration);
        return rest.length !== mk.presets.length;
    }

    function sfFind(mk, motion) {
        var i;
        for (i = 0; mk && i < mk.presets.length; i++) { if (mk.presets[i].motion === motion) { return mk.presets[i]; } }
        return null;
    }

    function sfSetCurve(layer, comp, dir, motion, curve, label) {
        var mk = sfReadMarker(layer, dir), p = sfFind(mk, motion);
        if (!p) { throw new Error("PRESET_GONE"); }
        p.curve = curve;
        if (mk.names[motion]) { mk.names[motion].curveLabel = label || ""; }
        sfWriteMarker(layer, dir, mk, comp.frameDuration);
    }

    function sfLayerState(layer) {
        var list = sfAllPresets(layer), out = [], i;
        for (i = 0; i < list.length; i++) { out.push(list[i].motion + ":" + list[i].dir + ":" + list[i].curve); }
        return out;
    }

    function sfLayers(comp) {
        var sel = comp.selectedLayers || [], out = [], i;
        for (i = 0; i < sel.length; i++) {
            if (!(sel[i] instanceof CameraLayer) && !(sel[i] instanceof LightLayer)) { out.push(sel[i]); }
        }
        return out;
    }

    // What the Edit view shows for the first selected layer.
    function sfDescribe(layer) {
        var out = [], dirs = ["in", "out"], d, mk, j, p, fx, keys, k, e, params;
        for (d = 0; d < dirs.length; d++) {
            mk = sfReadMarker(layer, dirs[d]);
            if (!mk) { continue; }
            var group = { dir: dirs[d], dur: mk.dur, delay: dirs[d] === "in" ? mk.time - layer.inPoint : layer.outPoint - (mk.time + mk.dur), presets: [] };
            for (j = 0; j < mk.presets.length; j++) {
                p = mk.presets[j];
                fx = (mk.names[p.motion] && mk.names[p.motion].fx) || {};
                params = sfTextId(p.motion) ? sftDescribe(layer, p.motion, mk.names[p.motion] || {}) : [];
                keys = sfTextId(p.motion) ? [] : sfParamKeys(SF_MOTIONS[p.motion] || {});
                if (SF_MOTIONS[p.motion] && SF_MOTIONS[p.motion].blur !== undefined) { keys.push("blur"); }
                for (k = 0; k < keys.length; k++) {
                    e = sfFx(layer, fx[keys[k]]);
                    if (e) { params.push({ key: keys[k], name: fx[keys[k]], value: e.property(1).value }); }
                }
                group.delay = Math.max(0, Math.round(group.delay * 1000) / 1000);
                group.presets.push({ motion: p.motion, curve: p.curve, params: params });
            }
            out.push(group);
        }
        return out;
    }


    // ---- Text presets, Animation Composer style. Same IN/OUT markers as the motions (one marker per direction
    // holds every preset of that direction), but a text preset is a text animator named after it
    // (e.g. "IN From bottom by letter") whose own properties hold the hidden state, plus an Expression Selector that
    // walks the letters, words or lines through the marker one after another. Nothing is baked into keys:
    // the marker's length is the duration, the animator's values are the settings, and the order of the
    // letters ("stagger") is a setting too.
    var SFT = {
        "fade": { op: 0 },
        "from-bottom": { op: 0, pos: [0, 80] },
        "from-top": { op: 0, pos: [0, -80] },
        "from-left": { op: 0, pos: [-80, 0] },
        "from-right": { op: 0, pos: [80, 0] },
        "scale-up": { op: 0, scale: 0 },
        "scale-down": { op: 0, scale: 300 },
        "rotate": { op: 0, rot: -90 },
        "blur": { op: 0, blur: 40 },
        "tracking": { op: 0, track: 60 },
        "skew": { op: 0, skew: 40, pos: [0, 40] },
        "typewriter": { op: 0, type: true }
    };
    var SFT_BASED = { c: 2, w: 3, l: 4 };
    var SFT_STAGGER = { c: 0.6, w: 0.5, l: 0.4 };
    var SFT_PROPS = [
        ["pos", "ADBE Text Position 3D"], ["scale", "ADBE Text Scale 3D"], ["rot", "ADBE Text Rotation"],
        ["blur", "ADBE Text Blur"], ["track", "ADBE Text Tracking Amount"], ["skew", "ADBE Text Skew"], ["op", "ADBE Text Opacity"]
    ];

    function sfTextId(motion) {
        var m = /^tx-([a-z\-]+)-([cwl])$/.exec(String(motion));
        return m && SFT[m[1]] ? { fx: m[1], unit: m[2], def: SFT[m[1]] } : null;
    }

    function sfKnown(motion) { return !!(SF_MOTIONS[motion] || sfTextId(motion)); }

    function sftValue(key, def) {
        if (key === "pos") { return [def.pos[0], def.pos[1], 0]; }
        if (key === "scale") { return [def.scale, def.scale, 100]; }
        if (key === "blur") { return [def.blur, def.blur]; }
        return def[key];
    }

    function sftAnimators(layer) {
        var tp = layer.property("ADBE Text Properties");
        return tp ? tp.property("ADBE Text Animators") : null;
    }

    function sftFind(layer, name) {
        var a = sftAnimators(layer), i;
        if (!a || !name) { return null; }
        for (i = 1; i <= a.numProperties; i++) { if (a.property(i).name === name) { return a.property(i); } }
        return null;
    }

    function sftRemove(layer, name) {
        var a = sftFind(layer, name);
        while (a) { a.remove(); a = sftFind(layer, name); }
    }

    function sftAmount(anim) {
        var sels = anim.property("ADBE Text Selectors"), i, sel;
        for (i = 1; sels && i <= sels.numProperties; i++) {
            sel = sels.property(i);
            if (sel.matchName === "ADBE Text Expressible Selector") { return sel.property("ADBE Text Expressible Amount"); }
        }
        return null;
    }

    // One animator with the given properties and an Expression Selector based on letters, words or lines.
    function sftMake(layer, name, keys, def, unit) {
        var root = ["ADBE Text Properties", "ADBE Text Animators"], ai, a, i, pi, si;
        sftRemove(layer, name);
        ai = acAdd(layer, root, "ADBE Text Animator");
        a = root.concat([ai]);
        acP(layer, a).name = name;
        for (i = 0; i < keys.length; i++) {
            pi = acAdd(layer, a.concat(["ADBE Text Animator Properties"]), SFT_MATCH[keys[i]]);
            acP(layer, a.concat(["ADBE Text Animator Properties", pi])).setValue(sftValue(keys[i], def));
        }
        si = acAdd(layer, a.concat(["ADBE Text Selectors"]), "ADBE Text Expressible Selector");
        try { acP(layer, a.concat(["ADBE Text Selectors", si, "ADBE Text Range Type2"])).setValue(SFT_BASED[unit]); } catch (e0) {}
    }

    var SFT_MATCH = {};
    (function () { var i; for (i = 0; i < SFT_PROPS.length; i++) { SFT_MATCH[SFT_PROPS[i][0]] = SFT_PROPS[i][1]; } })();

    function sftKeys(def) {
        var out = [], i;
        for (i = 0; i < SFT_PROPS.length; i++) { if (SFT_PROPS[i][0] !== "op" && def[SFT_PROPS[i][0]] !== undefined) { out.push(SFT_PROPS[i][0]); } }
        return out;
    }

    function sftAdd(layer, motion, dir, labels) {
        var t = sfTextId(motion), title = labels.title || motion, keys = sftKeys(t.def);
        var names = { title: title, curveLabel: labels.curve || "", text: true, anim: [], stagger: t.def.type ? 0.97 : SFT_STAGGER[t.unit] };
        var base = (dir === "in" ? "IN " : "OUT ") + title;
        if (keys.length) {
            sftMake(layer, base, keys, t.def, t.unit);
            names.anim.push({ name: base, soft: false });
            if (t.def.op !== undefined) {
                sftMake(layer, base + " \u00b7 " + (labels.fade || "opacity"), ["op"], t.def, t.unit);
                names.anim.push({ name: base + " \u00b7 " + (labels.fade || "opacity"), soft: true });
            }
        } else {
            sftMake(layer, base, ["op"], t.def, t.unit);
            names.anim.push({ name: base, soft: false });
        }
        return names;
    }

    // The Amount of each animator's selector: 100 = hidden, 0 = at rest; every unit gets its own slice of the marker.
    function sftExpr(layer, it, skipped) {
        var anims = it.names.anim || [], i, a, amt, curve, q = jsonString;
        var st = Math.max(0, Math.min(0.97, Number(it.names.stagger) || 0));
        for (i = 0; i < anims.length; i++) {
            a = sftFind(layer, anims[i].name);
            if (!a) { continue; }
            amt = sftAmount(a);
            if (!amt) { continue; }
            curve = anims[i].soft ? (it.curve === "linear" ? "linear" : "ease") : it.curve;
            sfSetExpr(amt, "var r=0,k=sfM(" + q(SF_MARK[it.dir]) + ");\n" +
                "if(k){var d=Math.max(k.duration,thisComp.frameDuration),s=" + st + ",n=Math.max(1,textTotal),u=textIndex-1;" +
                "var st=(n>1?u/(n-1):0)*s*d,w=Math.max(d*(1-s),thisComp.frameDuration),p=(time-k.time-st)/w;" +
                "r=100*(" + q(it.dir) + "==\"in\"?1-sfF(p," + q(curve) + "):1-sfF(1-p," + q(curve) + "));}\nr", skipped);
        }
    }

    // What the Edit view shows for a text preset: the main animator's values as single numbers, and the stagger.
    function sftDescribe(layer, motion, names) {
        var t = sfTextId(motion), out = [], keys, a, i, prop, v, anims = names.anim || [];
        if (!t) { return out; }
        a = anims.length ? sftFind(layer, anims[0].name) : null;
        keys = sftKeys(t.def);
        if (!keys.length) { keys = ["op"]; }
        for (i = 0; a && i < keys.length; i++) {
            prop = a.property("ADBE Text Animator Properties").property(SFT_MATCH[keys[i]]);
            if (!prop) { continue; }
            v = prop.value;
            if (keys[i] === "pos") { v = t.def.pos[0] !== 0 ? v[0] : v[1]; }
            if (keys[i] === "scale" || keys[i] === "blur") { v = v[0]; }
            out.push({ key: "t" + keys[i], name: "anim:" + anims[0].name + "|" + keys[i] + "|" + motion, value: v });
        }
        out.push({ key: "stagger", name: "stagger", value: Math.round((Number(names.stagger) || 0) * 100) });
        return out;
    }

    function sftSetParam(layer, spec, value) {
        var parts = spec.substring(5).split("|"), a = sftFind(layer, parts[0]), t = sfTextId(parts[2]), prop, v;
        if (!a || !t) { throw new Error("PRESET_GONE"); }
        prop = a.property("ADBE Text Animator Properties").property(SFT_MATCH[parts[1]]);
        if (!prop) { throw new Error("PRESET_GONE"); }
        value = Number(value);
        if (parts[1] === "pos") {
            v = prop.value.slice(0);
            if (t.def.pos[0] !== 0) { v[0] = value; } else { v[1] = value; }
        } else if (parts[1] === "scale") {
            v = [value, value, 100];
        } else if (parts[1] === "blur") {
            v = [value, value];
        } else {
            v = value;
        }
        prop.setValue(v);
    }


    // ---- Sounds: pitch the way a sampler does it (and the way Animation Composer's sound pitch sounds): the
    // layer is played faster or slower, so it gets higher and shorter, or lower and longer. In After Effects
    // that is the layer's Stretch: +12 semitones = 50%, -12 = 200%. Volume is the layer's Audio Levels.
    function sndIs(layer) {
        try { return !!(layer.source && layer.source.mainSource && layer.source.mainSource.file &&
            String(layer.source.mainSource.file.fsName).indexOf("Sayframe SFX") >= 0); } catch (e0) { return false; }
    }

    function sndSetLayer(layer, len, volume) {
        var lv;
        layer.stretch = Math.max(10, Math.min(1000, len));
        try {
            lv = layer.property("ADBE Audio Group").property("ADBE Audio Levels");
            lv.setValue([volume, volume]);
        } catch (e0) {}
    }

    function sndApply(layer, pitch, volume) {
        var lv;
        pitch = Math.max(-24, Math.min(24, pitch));
        layer.stretch = 100 / Math.pow(2, pitch / 12);
        try {
            lv = layer.property("ADBE Audio Group").property("ADBE Audio Levels");
            lv.setValue([volume, volume]);
        } catch (e0) {}
    }

    // What the sound bar did to a layer: the original file, the pitch (semitones) and the length (percent), in the
    // layer's comment, on a line of its own. The audio itself may be a file the panel rendered (pitch without the length).
    var SND_MARK = "[Sayframe sound] ";

    function sndLoad(layer) {
        var c = "", at, end, o = null;
        try { c = String(layer.comment || ""); } catch (e0) {}
        at = c.indexOf(SND_MARK);
        if (at < 0) { return null; }
        end = c.indexOf("\n", at);
        try { o = eval("(" + c.substring(at + SND_MARK.length, end < 0 ? c.length : end) + ")"); } catch (e1) { o = null; }
        return o && typeof o === "object" ? o : null;
    }

    function sndSave(layer, o) {
        var c = "", lines, out = [], i;
        try { c = String(layer.comment || ""); } catch (e0) {}
        lines = c ? c.split("\n") : [];
        for (i = 0; i < lines.length; i++) { if (lines[i].indexOf(SND_MARK) !== 0) { out.push(lines[i]); } }
        out.push(SND_MARK + toJSON(o));
        try { layer.comment = out.join("\n"); } catch (e1) {}
    }

    function sndFilePath(layer) {
        try { return String(layer.source.mainSource.file.fsName); } catch (e0) { return ""; }
    }

    // A sound-only layer the bar can work on: not locked, audio and no picture.
    function sndTarget(layer) {
        try { return !layer.locked && layer.hasAudio && layer.source && layer.source.hasVideo === false && layer.source.hasAudio && !!sndFilePath(layer); } catch (e0) { return false; }
    }

    // The original file, the pitch you hear and the length, as the bar shows them. A layer the bar never touched:
    // its own file, and the Stretch it has (After Effects plays a stretched layer lower, so that is its pitch).
    function sndState(layer) {
        var m = sndLoad(layer), v = 0, lv, len = layer.stretch || 100;
        try { lv = layer.property("ADBE Audio Group").property("ADBE Audio Levels").value; v = lv[0]; } catch (e0) {}
        if (m && m.src) { return { src: String(m.src), pitch: Number(m.p) || 0, len: Number(m.l) || len, volume: Math.round(v * 10) / 10 }; }
        return { src: sndFilePath(layer), pitch: Math.round(12 * Math.log(100 / len) / Math.LN2 * 10) / 10, len: Math.round(len * 10) / 10, volume: Math.round(v * 10) / 10 };
    }

    function sndFindItem(file) {
        var proj = app.project, i, it;
        for (i = 1; i <= proj.numItems; i++) {
            it = proj.item(i);
            try { if (it.mainSource && it.mainSource.file && it.mainSource.file.fsName === file.fsName) { return it; } } catch (e0) {}
        }
        return null;
    }

    function sndDescribe(layer) {
        var v = 0, lv;
        if (!sndIs(layer)) { return null; }
        try { lv = layer.property("ADBE Audio Group").property("ADBE Audio Levels").value; v = lv[0]; } catch (e0) {}
        var st = sndState(layer);
        return { name: String(layer.name), pitch: st.pitch, len: st.len, volume: st.volume };
    }

    // ---- Graphics, the way Animation Composer's graphic components work: a new layer at the time indicator
    // (over the selected layer, or in the middle of the comp) whose animation is driven by expressions from the
    // layer's own length, with Color, Size and Thickness controls in Effect Controls. Nothing is baked into keys:
    // stretch the layer to change the duration, change a control to restyle it.

    function grHead(n) {
        return [
            "// Sayframe graphic: written by the Sayframe panel. Its length is the duration; colour, size and thickness are in Effect Controls.",
            "function gT(){return time-thisLayer.inPoint;}",
            "function gL(){return Math.max(thisLayer.outPoint-thisLayer.inPoint,thisComp.frameDuration);}",
            "function gP(){return Math.min(1,Math.max(0,gT()/gL()));}",
            "function gC(n,d){try{return effect(n)(1);}catch(e){return d;}}",
            "function gE(x){x=Math.min(1,Math.max(0,x));return 1-Math.pow(1-x,3);}",
            "function gB(x){x=Math.min(1,Math.max(0,x));var s=1.70158,q=x-1;return 1+(s+1)*q*q*q+s*q*q;}",
            "function gIn(d){return gE(gT()/d);}",
            "function gOut(d){return gE((thisLayer.outPoint-time)/d);}",
            "function gS(){return gC(" + jsonString(n.size) + ",100)/100;}",
            "function gW(){return gC(" + jsonString(n.thick) + ",8);}",
            "function gK(){return gC(" + jsonString(n.color) + ",[1,1,1,1]);}"
        ].join("\n");
    }

    // A small toolkit over shape layers: everything is addressed by group index from the root.
    function grCtx(l, comp, names) {
        var c = { l: l, comp: comp, n: names };
        c.x = function (prop, body) { prop.expression = grHead(names) + "\n" + body; return prop; };
        c.g = function (name) {
            var gi = acGroup(l);
            try { acP(l, ["ADBE Root Vectors Group", gi]).name = name; } catch (e0) {}
            return gi;
        };
        c.p = function (gi, path) { return acP(l, ["ADBE Root Vectors Group", gi].concat(path)); };
        c.add = function (gi, mn) { return acIn(l, gi, mn); };
        c.ell = function (gi, size, posExpr) {
            var i = c.add(gi, "ADBE Vector Shape - Ellipse");
            c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Ellipse Size"]).setValue([size, size]);
            if (posExpr) { c.x(c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Ellipse Position"]), posExpr); }
            return i;
        };
        c.rect = function (gi, w, h, round, posExpr) {
            var i = c.add(gi, "ADBE Vector Shape - Rect");
            c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Rect Size"]).setValue([w, h]);
            if (round) { c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Rect Roundness"]).setValue(round); }
            if (posExpr) { c.x(c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Rect Position"]), posExpr); }
            return i;
        };
        c.star = function (gi, points, outer, inner, polygon) {
            var i = c.add(gi, "ADBE Vector Shape - Star");
            try { c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Star Type"]).setValue(polygon ? 2 : 1); } catch (e0) {}
            c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Star Points"]).setValue(points);
            c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Star Outer Radius"]).setValue(outer);
            if (!polygon) { c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Star Inner Radius"]).setValue(inner); }
            return i;
        };
        c.path = function (gi, pts, closed) { return acPath(l, gi, pts, closed); };
        c.trim = function (gi, startExpr, endExpr) {
            var i = c.add(gi, "ADBE Vector Filter - Trim");
            if (startExpr) { c.x(c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Trim Start"]), startExpr); }
            if (endExpr) { c.x(c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Trim End"]), endExpr); }
            return i;
        };
        c.wiggle = function (gi, size) {
            try {
                var i = c.add(gi, "ADBE Vector Filter - Wiggler");
                c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Wiggler Size"]).setValue(size);
                c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Temporal Freq"]).setValue(6);
            } catch (e0) {}
        };
        c.stroke = function (gi, widthExpr, colorExpr) {
            var i = c.add(gi, "ADBE Vector Graphic - Stroke");
            c.x(c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Stroke Color"]), colorExpr || "gK()");
            c.x(c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Stroke Width"]), widthExpr || "gW()");
            try { c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Stroke Line Cap"]).setValue(2); } catch (e0) {}
            try { c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Stroke Line Join"]).setValue(2); } catch (e1) {}
            return i;
        };
        c.fill = function (gi, colorExpr) {
            var i = c.add(gi, "ADBE Vector Graphic - Fill");
            c.x(c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Fill Color"]), colorExpr || "gK()");
            return i;
        };
        c.repeat = function (gi, copies, rot, pos) {
            var i = c.add(gi, "ADBE Vector Filter - Repeater");
            c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Repeater Copies"]).setValue(copies);
            c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Repeater Transform", "ADBE Vector Repeater Position"]).setValue(pos || [0, 0]);
            if (rot) { c.p(gi, ["ADBE Vectors Group", i, "ADBE Vector Repeater Transform", "ADBE Vector Repeater Rotation"]).setValue(rot); }
            return i;
        };
        c.t = function (gi, prop, expr) {
            var mn = { pos: "ADBE Vector Position", scale: "ADBE Vector Scale", rot: "ADBE Vector Rotation", op: "ADBE Vector Group Opacity", anchor: "ADBE Vector Anchor" }[prop];
            return c.x(c.p(gi, ["ADBE Vector Transform Group", mn]), expr);
        };
        c.lt = function (prop, expr) {
            var mn = { pos: "ADBE Position", scale: "ADBE Scale", rot: "ADBE Rotate Z", op: "ADBE Opacity" }[prop];
            return c.x(acP(l, ["ADBE Transform Group", mn]), expr);
        };
        return c;
    }

    function grPoly(n, fn) { var out = [], i; for (i = 0; i <= n; i++) { out.push(fn(i / n)); } return out; }

    // One-shot pops: in for most of the layer, then fade at its end.
    var GR_POP = "[100*gB(gT()/0.45)*gS(),100*gB(gT()/0.45)*gS()]";
    var GR_FADE = "100*gOut(0.25)";

    function grBurstLines(c, copies, r1, r2, width) {
        var gi = c.g("Rays");
        c.path(gi, [[0, -r1], [0, -r2]], false);
        c.trim(gi, "100*gE(gP()*1.6-0.3)", "100*gE(gP()*1.6)");
        c.stroke(gi, "gW()*" + (width || 1));
        c.repeat(gi, copies, 360 / copies);
        return gi;
    }

    function grParticles(c, count, body) {
        var i, gi;
        for (i = 0; i < count; i++) { gi = c.g("Particle " + (i + 1)); body(gi, i); }
    }

    var GR_BUILD = {
        // ---- shape elements (one-shot)
        "ring-burst": function (c) {
            var gi = c.g("Ring");
            c.ell(gi, 200);
            c.stroke(gi, "gW()*(1-gE(gP()))*2");
            c.t(gi, "scale", "var s=gE(gP()*1.2)*120;[s,s]");
        },
        "ring-double": function (c) {
            var a = c.g("Ring 1"), b = c.g("Ring 2");
            c.ell(a, 200); c.stroke(a, "gW()*(1-gE(gP()))*2"); c.t(a, "scale", "var s=gE(gP()*1.2)*120;[s,s]");
            c.ell(b, 200); c.stroke(b, "gW()*(1-gE(gP()-0.15))*1.4"); c.t(b, "scale", "var s=gE(gP()*1.2-0.18)*90;[s,s]");
        },
        "lines-burst": function (c) { grBurstLines(c, 12, 60, 150, 1); },
        "dots-burst": function (c) {
            var gi = c.g("Dots");
            c.ell(gi, 22, "[0,-gE(gP()*1.3)*170]");
            c.fill(gi);
            c.repeat(gi, 10, 36);
            c.t(gi, "scale", "var s=100*(1-gE(gP()*1.3-0.4));[s,s]");
        },
        // The shape itself flies out (its own Position), so the Repeater after it fans the copies into a ring;
        // moving the whole group instead would stack every copy in one place.
        "star-burst": function (c) {
            var gi = c.g("Stars");
            var si = c.star(gi, 5, 18, 8);
            c.x(c.p(gi, ["ADBE Vectors Group", si, "ADBE Vector Star Position"]), "[0,-gE(gP()*1.3)*170]");
            c.fill(gi);
            c.t(gi, "rot", "gP()*180");
            c.repeat(gi, 8, 45);
            c.t(gi, "op", "100*(1-gE(gP()*1.3-0.5))");
        },
        "circle-pop": function (c) {
            var gi = c.g("Circle");
            c.ell(gi, 160); c.fill(gi);
            c.t(gi, "scale", "var s=100*gB(gT()/0.4)*gOut(0.3);[s,s]");
        },
        "square-spin": function (c) {
            var gi = c.g("Square");
            c.rect(gi, 140, 140, 18); c.stroke(gi);
            c.t(gi, "scale", "var s=100*gB(gT()/0.5)*gOut(0.3);[s,s]");
            c.t(gi, "rot", "gE(gP())*180");
        },
        "triangle-burst": function (c) {
            var gi = c.g("Triangles");
            var si = c.star(gi, 3, 16, 0, true); c.fill(gi);
            c.x(c.p(gi, ["ADBE Vectors Group", si, "ADBE Vector Star Position"]), "[0,-gE(gP()*1.3)*160]");
            c.t(gi, "rot", "gP()*240");
            c.repeat(gi, 6, 60);
            c.t(gi, "op", "100*(1-gE(gP()*1.3-0.5))");
        },
        "plus-burst": function (c) {
            var gi = c.g("Plus"), at = "[0,-gE(gP()*1.3)*150]";
            var h = c.rect(gi, 24, 6, 0, at), v = c.rect(gi, 6, 24, 0, at);
            c.x(c.p(gi, ["ADBE Vectors Group", h, "ADBE Vector Rect Size"]), "[24,gW()*0.7]");
            c.x(c.p(gi, ["ADBE Vectors Group", v, "ADBE Vector Rect Size"]), "[gW()*0.7,24]");
            c.fill(gi);
            c.repeat(gi, 6, 60);
            c.t(gi, "op", "100*(1-gE(gP()*1.3-0.5))");
        },
        "zigzag": function (c) {
            var gi = c.g("Zigzag");
            c.path(gi, grPoly(8, function (u) { return [-240 + 480 * u, (Math.round(u * 8) % 2 ? -30 : 30)]; }), false);
            c.trim(gi, "100*gE(gP()*1.5-0.5)", "100*gE(gP()*1.5)");
            c.stroke(gi);
        },
        "ripples": function (c) {
            var i, gi;
            for (i = 0; i < 3; i++) {
                gi = c.g("Ripple " + (i + 1));
                c.ell(gi, 200);
                c.stroke(gi, "var q=(gT()/1.2+" + (i / 3) + ")%1;gW()*(1-q)");
                c.t(gi, "scale", "var q=(gT()/1.2+" + (i / 3) + ")%1;[q*130,q*130]");
            }
        },
        "sparkle": function (c) {
            var gi = c.g("Sparkle");
            c.star(gi, 4, 70, 14); c.fill(gi);
            c.t(gi, "scale", "var s=100*gB(gT()/0.35)*gOut(0.3)*(1+0.12*Math.sin(gT()*12));[s,s]");
            c.t(gi, "rot", "gT()*40");
        },
        "confetti": function (c) {
            grParticles(c, 18, function (gi, i) {
                c.rect(gi, 14, 22, 2);
                c.fill(gi, "seedRandom(" + (i + 1) + ",true);var k=gK();var m=0.55+random()*0.45;[k[0]*m,k[1]*m,k[2]*m,1]");
                c.t(gi, "pos", "seedRandom(" + (i + 1) + ",true);var a=random(-Math.PI,0),v=random(250,520),t=gT();[Math.cos(a)*v*t*0.9,Math.sin(a)*v*t+500*t*t]");
                c.t(gi, "rot", "seedRandom(" + (i + 1) + ",true);random(-1,1)*720*gT()");
                c.t(gi, "op", GR_FADE);
            });
        },
        // ---- 2D special effects
        "speed-lines": function (c) {
            grParticles(c, 20, function (gi, i) {
                var ang = i * 18;
                c.path(gi, [[0, -520], [0, -900]], false);
                c.trim(gi, "posterizeTime(12);seedRandom(" + (i + 1) + ",false);random(0,40)", "posterizeTime(12);seedRandom(" + (i + 1) + ",false);random(50,100)");
                c.stroke(gi, "gW()*0.6");
                c.t(gi, "rot", String(ang));
                c.t(gi, "op", "100*gIn(0.15)*gOut(0.2)");
            });
        },
        "smoke-puff": function (c) {
            grParticles(c, 7, function (gi, i) {
                c.ell(gi, 90);
                c.fill(gi, "var k=gK();[k[0]*0.8,k[1]*0.8,k[2]*0.8,1]");
                c.t(gi, "pos", "seedRandom(" + (i + 1) + ",true);var a=random(0,Math.PI*2),r=gE(gP())*random(60,140);[Math.cos(a)*r,Math.sin(a)*r-gP()*60]");
                c.t(gi, "scale", "seedRandom(" + (i + 1) + ",true);var s=(0.4+gE(gP())*random(0.8,1.4))*100;[s,s]");
                c.t(gi, "op", "80*(1-gP())");
            });
        },
        "explosion-burst": function (c) {
            var a = c.g("Spikes"), b = c.g("Core");
            c.star(a, 12, 180, 90); c.fill(a);
            c.t(a, "scale", "var s=100*gB(gT()/0.3)*(1-gE(gP()*1.2-0.3));[s,s]");
            c.ell(b, 140); c.fill(b, "[1,1,1,1]");
            c.t(b, "scale", "var s=100*gE(gT()/0.25)*(1-gE(gP()*1.2-0.2));[s,s]");
        },
        "lightning": function (c) {
            var gi = c.g("Bolt");
            c.path(gi, [[-20, -320], [30, -120], [-30, -40], [40, 140], [-10, 320]], false);
            c.stroke(gi, "gW()*1.2");
            c.t(gi, "op", "posterizeTime(15);seedRandom(1,false);random()<0.75?100*gOut(0.2):0");
        },
        "sunburst": function (c) {
            var gi = c.g("Rays");
            c.path(gi, [[0, 0], [-40, -400], [40, -400]], true);
            c.fill(gi);
            c.repeat(gi, 12, 30);
            c.t(gi, "rot", "gT()*25");
            c.t(gi, "scale", "var s=100*gE(gT()/0.5)*gOut(0.4);[s,s]");
            c.t(gi, "op", "70");
        },
        "glitch-blocks": function (c) {
            grParticles(c, 10, function (gi, i) {
                c.rect(gi, 120, 24, 0, "posterizeTime(12);seedRandom(" + (i + 1) + ",false);[random(-400,400),random(-220,220)]");
                c.fill(gi);
                c.t(gi, "op", "posterizeTime(12);seedRandom(" + (i + 20) + ",false);random()<0.5?100*gOut(0.15):0");
            });
        },
        "shockwave": function (c) {
            var a = c.g("Wave"), b = c.g("Wave thin");
            c.ell(a, 200); c.stroke(a, "gW()*3*(1-gE(gP()))"); c.t(a, "scale", "var s=gE(gP()*1.1)*250;[s,s]");
            c.ell(b, 200); c.stroke(b, "gW()*0.5*(1-gE(gP()))"); c.t(b, "scale", "var s=gE(gP()*1.1-0.1)*320;[s,s]");
        },
        "swirl": function (c) {
            var gi = c.g("Swirl");
            c.path(gi, grPoly(60, function (u) { var a = u * Math.PI * 5, r = 10 + 160 * u; return [Math.cos(a) * r, Math.sin(a) * r]; }), false);
            c.trim(gi, "100*gE(gP()*1.4-0.4)", "100*gE(gP()*1.4)");
            c.stroke(gi);
            c.t(gi, "rot", "gT()*120");
        },
        // ---- hand drawn (a little wiggle on the path makes them look drawn)
        "underline": function (c) {
            var gi = c.g("Underline");
            c.path(gi, grPoly(30, function (u) { return [-300 + 600 * u, Math.sin(u * Math.PI * 3) * 10]; }), false);
            c.trim(gi, "100*(1-gOut(0.4))", "100*gIn(0.6)");
            c.wiggle(gi, 3); c.stroke(gi);
        },
        "circle-scribble": function (c) {
            var gi = c.g("Scribble");
            c.path(gi, grPoly(70, function (u) { var a = -Math.PI / 2 + u * Math.PI * 2.3, k = 1 + 0.06 * u; return [Math.cos(a) * 280 * k, Math.sin(a) * 130 * k]; }), false);
            c.trim(gi, "100*(1-gOut(0.4))", "100*gIn(0.7)");
            c.wiggle(gi, 4); c.stroke(gi);
        },
        "arrow": function (c) {
            var a = c.g("Arrow line"), b = c.g("Arrow head");
            c.path(a, grPoly(20, function (u) { return [-260 + 500 * u, -120 * Math.sin(u * Math.PI) + 40 * u]; }), false);
            c.trim(a, "100*(1-gOut(0.4))", "100*gIn(0.6)"); c.wiggle(a, 2); c.stroke(a);
            c.path(b, [[200, 0], [240, 40], [190, 70]], false);
            c.trim(b, "100*(1-gOut(0.4))", "100*gE((gT()-0.5)/0.25)"); c.stroke(b);
        },
        "cross-out": function (c) {
            var a = c.g("Stroke 1"), b = c.g("Stroke 2");
            c.path(a, [[-200, -120], [200, 120]], false); c.trim(a, "100*(1-gOut(0.3))", "100*gIn(0.35)"); c.wiggle(a, 3); c.stroke(a);
            c.path(b, [[200, -120], [-200, 120]], false); c.trim(b, "100*(1-gOut(0.3))", "100*gE((gT()-0.3)/0.35)"); c.wiggle(b, 3); c.stroke(b);
        },
        "check": function (c) {
            var gi = c.g("Check");
            c.path(gi, [[-120, 0], [-40, 90], [140, -120]], false);
            c.trim(gi, "100*(1-gOut(0.3))", "100*gIn(0.5)"); c.wiggle(gi, 2); c.stroke(gi, "gW()*1.4");
        },
        "highlight": function (c) {
            var gi = c.g("Marker");
            c.path(gi, [[-300, 0], [300, -6]], false);
            c.trim(gi, "100*(1-gOut(0.3))", "100*gIn(0.5)");
            c.stroke(gi, "gW()*6", "var k=gK();[k[0],k[1],k[2],1]");
            c.t(gi, "op", "55");
        },
        "bracket": function (c) {
            var a = c.g("Left"), b = c.g("Right");
            c.path(a, [[-260, -140], [-300, -140], [-300, 140], [-260, 140]], false); c.trim(a, "100*(1-gOut(0.3))", "100*gIn(0.5)"); c.wiggle(a, 2); c.stroke(a);
            c.path(b, [[260, -140], [300, -140], [300, 140], [260, 140]], false); c.trim(b, "100*(1-gOut(0.3))", "100*gIn(0.5)"); c.wiggle(b, 2); c.stroke(b);
        },
        "star-doodle": function (c) {
            var gi = c.g("Star"), i, pts = [];
            for (i = 0; i <= 5; i++) { pts.push([Math.cos(-Math.PI / 2 + i * 4 * Math.PI / 5) * 150, Math.sin(-Math.PI / 2 + i * 4 * Math.PI / 5) * 150]); }
            c.path(gi, pts, false);
            c.trim(gi, "100*(1-gOut(0.3))", "100*gIn(0.7)"); c.wiggle(gi, 3); c.stroke(gi);
        },
        "exclaim": function (c) {
            var gi = c.g("Accent");
            c.path(gi, [[0, -70], [0, -130]], false);
            c.trim(gi, "100*(1-gOut(0.3))", "100*gIn(0.3)");
            c.stroke(gi);
            c.repeat(gi, 5, 30);
            c.t(gi, "rot", "-60");
        },
        // ---- backgrounds (full frame; a soft fade in and out)
        "bg-grid": function (c) {
            var w = c.comp.width, h = c.comp.height, a = c.g("Vertical"), b = c.g("Horizontal");
            c.path(a, [[-w / 2 - 80, -h], [-w / 2 - 80, h]], false); c.stroke(a, "gW()*0.25"); c.repeat(a, Math.ceil(w / 80) + 3, 0, [80, 0]);
            c.t(a, "pos", "[(gT()*30)%80,0]");
            c.path(b, [[-w, -h / 2 - 80], [w, -h / 2 - 80]], false); c.stroke(b, "gW()*0.25"); c.repeat(b, Math.ceil(h / 80) + 3, 0, [0, 80]);
            c.t(b, "pos", "[0,(gT()*30)%80]");
            c.lt("op", "60*gIn(0.5)*gOut(0.5)");
        },
        "bg-dots": function (c) {
            var w = c.comp.width, h = c.comp.height, gi = c.g("Dots");
            c.ell(gi, 10, "[-" + (w / 2) + ",-" + (h / 2) + "]"); c.fill(gi);
            c.repeat(gi, Math.ceil(w / 60) + 1, 0, [60, 0]);
            c.repeat(gi, Math.ceil(h / 60) + 1, 0, [0, 60]);
            c.t(gi, "scale", "var s=100+20*Math.sin(gT()*3);[s,s]");
            c.lt("op", "50*gIn(0.5)*gOut(0.5)");
        },
        "bg-stripes": function (c) {
            var w = c.comp.width, h = c.comp.height, gi = c.g("Stripes");
            c.rect(gi, 40, h * 3, 0, "[-" + (w * 1.2) + ",0]"); c.fill(gi);
            c.repeat(gi, Math.ceil(w * 2.4 / 100) + 2, 0, [100, 0]);
            c.t(gi, "pos", "[(gT()*60)%100,0]");
            c.t(gi, "rot", "30");
            c.lt("op", "35*gIn(0.5)*gOut(0.5)");
        },
        "bg-rays": function (c) {
            var gi = c.g("Rays"), r = Math.ceil(Math.sqrt(c.comp.width * c.comp.width + c.comp.height * c.comp.height));
            // 16 rays every 22.5 degrees, each about 10 degrees wide: gaps between them stay visible.
            c.path(gi, [[0, 0], [-r * 0.09, -r], [r * 0.09, -r]], true); c.fill(gi);
            c.repeat(gi, 16, 22.5);
            c.t(gi, "rot", "gT()*8");
            c.lt("op", "40*gIn(0.5)*gOut(0.5)");
        },
        "bg-circles": function (c) {
            var i, gi;
            for (i = 0; i < 6; i++) {
                gi = c.g("Circle " + (i + 1));
                c.ell(gi, 300);
                c.stroke(gi, "gW()*0.5");
                c.t(gi, "scale", "var q=(gT()/4+" + (i / 6) + ")%1;[q*700,q*700]");
                c.t(gi, "op", "var q=(gT()/4+" + (i / 6) + ")%1;100*(1-q)");
            }
            c.lt("op", "70*gIn(0.5)*gOut(0.5)");
        },
        // ---- overlays (shape ones; solid ones are in grSolid)
        "letterbox": function (c) {
            var w = c.comp.width, h = c.comp.height, a = c.g("Top bar"), b = c.g("Bottom bar");
            c.rect(a, w + 20, h * 0.12, 0, "[0,-" + (h / 2) + "+" + (h * 0.06) + "-(1-gIn(0.6)*gOut(0.6))*" + (h * 0.13) + "]");
            c.fill(a, "[0,0,0,1]");
            c.rect(b, w + 20, h * 0.12, 0, "[0," + (h / 2) + "-" + (h * 0.06) + "+(1-gIn(0.6)*gOut(0.6))*" + (h * 0.13) + "]");
            c.fill(b, "[0,0,0,1]");
        },
        "frame": function (c) {
            var gi = c.g("Frame");
            c.rect(gi, c.comp.width * 0.9, c.comp.height * 0.86, 12);
            c.trim(gi, "0", "100*gIn(0.8)*gOut(0.5)");
            c.stroke(gi, "gW()*0.6");
        },
        "scanlines": function (c) {
            var w = c.comp.width, h = c.comp.height, gi = c.g("Lines");
            c.path(gi, [[-w, -h / 2 - 8], [w, -h / 2 - 8]], false);
            c.stroke(gi, "2", "[0,0,0,1]");
            c.repeat(gi, Math.ceil(h / 6) + 3, 0, [0, 6]);
            c.t(gi, "pos", "[0,(gT()*12)%6]");
            c.lt("op", "35*gIn(0.3)*gOut(0.3)");
        },
        // ---- titles and labels (text is a separate layer parented to the graphic)
        "lower-third": function (c) {
            var a = c.g("Bar"), b = c.g("Accent");
            c.rect(a, 640, 110, 6, "[320,0]"); c.fill(a, "[0.08,0.08,0.1,0.9]");
            c.t(a, "scale", "[100*gE(gT()/0.5)*gOut(0.4),100]");
            c.rect(b, 12, 110, 0, "[0,0]"); c.fill(b);
            c.t(b, "scale", "[100,100*gB(gT()/0.4)*gOut(0.3)]");
        },
        "callout": function (c) {
            var a = c.g("Dot"), b = c.g("Line");
            c.ell(a, 24); c.fill(a);
            c.t(a, "scale", "var s=100*gB(gT()/0.3)*gOut(0.3);[s,s]");
            c.path(b, [[0, 0], [120, -120], [420, -120]], false);
            c.trim(b, "100*(1-gOut(0.4))", "100*gE((gT()-0.15)/0.5)");
            c.stroke(b, "gW()*0.5");
        },
        "label": function (c) {
            var a = c.g("Pill");
            c.rect(a, 360, 90, 45); c.fill(a);
            c.t(a, "scale", "var s=100*gB(gT()/0.4)*gOut(0.3);[s,s]");
        },
        "progress": function (c) {
            var a = c.g("Track"), b = c.g("Fill");
            c.rect(a, 600, 36, 18); c.stroke(a, "gW()*0.4");
            c.path(b, [[-282, 0], [282, 0]], false);
            c.trim(b, "0", "100*gE(gP())");
            c.stroke(b, "22");
            c.lt("op", "100*gIn(0.3)*gOut(0.3)");
        }
    };

    // Layers that are not shape layers: solids with an effect, and text that counts.
    var GR_SOLID = {
        "bg-gradient": function (l, c) {
            var g = acAdd(l, ["ADBE Effect Parade"], "ADBE 4ColorGradient"), i;
            var cols = ["gK()", "var k=gK();[k[0]*0.3,k[1]*0.3,k[2]*0.45,1]", "var k=gK();[k[2],k[0],k[1],1]", "[0.03,0.03,0.06,1]"];
            for (i = 0; i < 4; i++) { c.x(acP(l, ["ADBE Effect Parade", g, "ADBE 4ColorGradient-000" + (2 + i * 2)]), cols[i]); }
            c.x(acP(l, ["ADBE Effect Parade", g, "ADBE 4ColorGradient-0001"]), "[value[0]+Math.sin(time*0.7)*thisComp.width*0.2,value[1]+Math.cos(time*0.5)*thisComp.height*0.2]");
            c.x(acP(l, ["ADBE Effect Parade", g, "ADBE 4ColorGradient-0007"]), "[value[0]+Math.cos(time*0.6)*thisComp.width*0.2,value[1]+Math.sin(time*0.8)*thisComp.height*0.2]");
            c.lt("op", "100*gIn(0.5)*gOut(0.5)");
        },
        "vignette": function (l, c) {
            var g = acAdd(l, ["ADBE Effect Parade"], "ADBE Ramp");
            try {
                acP(l, ["ADBE Effect Parade", g, "ADBE Ramp-0001"]).setValue([c.comp.width / 2, c.comp.height / 2]);
                acP(l, ["ADBE Effect Parade", g, "ADBE Ramp-0002"]).setValue([1, 1, 1, 1]);
                acP(l, ["ADBE Effect Parade", g, "ADBE Ramp-0003"]).setValue([0, 0]);
                acP(l, ["ADBE Effect Parade", g, "ADBE Ramp-0004"]).setValue([0, 0, 0, 1]);
                acP(l, ["ADBE Effect Parade", g, "ADBE Ramp-0005"]).setValue(2);
            } catch (e0) {}
            try { l.blendingMode = BlendingMode.MULTIPLY; } catch (e1) {}
            c.lt("op", "100*gIn(0.5)*gOut(0.5)*gS()");
        },
        "grain": function (l, c) {
            var g = acAdd(l, ["ADBE Effect Parade"], "ADBE Noise");
            c.x(acP(l, ["ADBE Effect Parade", g, "ADBE Noise-0001"]), "12*gS()*gIn(0.3)*gOut(0.3)");
        },
        "flicker": function (l, c) {
            try { l.blendingMode = BlendingMode.ADD; } catch (e0) {}
            c.lt("op", "posterizeTime(12);seedRandom(1,false);(random()<0.3?random(10,35):random(0,6))*gS()*gIn(0.2)*gOut(0.2)");
        },
        "counter": function (l, c) {
            c.x(acP(l, ["ADBE Text Properties", "ADBE Text Document"]), "Math.round(gC(" + jsonString(c.n.size) + ",100)*gE(gP()/0.9))+\"%\"");
            c.lt("op", "100*gIn(0.2)*gOut(0.2)");
        },
        "timer": function (l, c) {
            c.x(acP(l, ["ADBE Text Properties", "ADBE Text Document"]),
                "var s=Math.max(0,Math.ceil(thisLayer.outPoint-time));var m=Math.floor(s/60),r=s%60;(m<10?\"0\":\"\")+m+\":\"+(r<10?\"0\":\"\")+r");
            c.lt("op", "100*gIn(0.2)*gOut(0.2)");
        }
    };
    var GR_KIND = { "bg-gradient": "solid", "vignette": "solid", "grain": "adj", "flicker": "solid", "counter": "text", "timer": "text" };
    var GR_STROKE = { "ring-burst": 1, "ring-double": 1, "lines-burst": 1, "square-spin": 1, "plus-burst": 1, "zigzag": 1, "ripples": 1, "speed-lines": 1,
        "lightning": 1, "shockwave": 1, "swirl": 1, "underline": 1, "circle-scribble": 1, "arrow": 1, "cross-out": 1, "check": 1, "highlight": 1,
        "bracket": 1, "star-doodle": 1, "exclaim": 1, "bg-grid": 1, "bg-circles": 1, "frame": 1, "callout": 1, "progress": 1 };
    var GR_FULL = { "bg-gradient": 1, "bg-grid": 1, "bg-dots": 1, "bg-stripes": 1, "bg-rays": 1, "bg-circles": 1, "vignette": 1, "grain": 1,
        "flicker": 1, "letterbox": 1, "frame": 1, "scanlines": 1 };
    var GR_TEXT = { "lower-third": [50, -12, 0], "callout": [440, -150, 0], "label": [0, 0, 1] };

    function grRead(layer) {
        var mk = layer.property("ADBE Marker"), i, mv, m, params;
        if (!mk) { return null; }
        for (i = 1; i <= mk.numKeys; i++) {
            mv = mk.keyValue(i);
            try { params = mv.getParameters() || {}; } catch (e0) { params = {}; }
            m = /\{sfg:([a-z0-9\-]+)\}/.exec(String(mv.comment));
            if (params.gid) { m = [0, params.gid]; }
            if (!m) { continue; }
            return { id: m[1], names: params.sg ? eval("(" + params.sg + ")") : {} };
        }
        return null;
    }

    function grHex(c) {
        var out = "#", i, h;
        for (i = 0; i < 3; i++) { h = Math.round(Math.max(0, Math.min(1, c[i])) * 255).toString(16); out += h.length < 2 ? "0" + h : h; }
        return out;
    }

    function grDescribe(layer) {
        var g = grRead(layer), out, fx;
        if (!g) { return null; }
        out = { id: g.id, dur: Math.round((layer.outPoint - layer.inPoint) * 1000) / 1000, names: g.names };
        fx = sfFx(layer, g.names.color); out.color = fx ? grHex(fx.property(1).value) : "#ffffff";
        fx = sfFx(layer, g.names.size); out.size = fx ? fx.property(1).value : 100;
        fx = sfFx(layer, g.names.thick); if (fx) { out.thick = fx.property(1).value; }
        return out;
    }

    // ---- Transitions, the way Animation Composer does them: a transition goes on a cut, not on a layer.
    // At the time indicator (the cut) a new layer appears on top of the comp, half before the cut and
    // half after it: an adjustment layer for camera moves and glitches, a solid for light leaks and fades,
    // a shape layer for wipes. Everything on it is driven by expressions from the layer's own length, so
    // stretching the layer in the timeline changes the duration and moving it moves the transition.
    // A "Strength" slider in Effect Controls scales the move.

    var TR_KIND = {
        "zoom-in": "adj", "zoom-out": "adj", "zoom-in-out": "adj", "zoom-distort-in": "adj", "zoom-distort-out": "adj", "zoom-hit": "adj",
        "pan-left": "adj", "pan-right": "adj", "pan-up": "adj", "pan-down": "adj",
        "rotate": "adj", "roll": "adj", "zoom-rotate": "adj", "twirl": "adj",
        "shake": "adj", "glitch": "adj", "glitch-shake": "adj", "blur-dissolve": "adj",
        "leak-warm": "solid", "leak-cool": "solid", "flash": "solid", "fade-black": "solid", "fade-white": "solid",
        "wipe-left": "shape", "wipe-up": "shape", "circle": "shape"
    };

    // The look of a "seamless" camera transition: the move is exponential (almost all of it happens in
    // the last frames before the cut and the first frames after it), mirrored Motion Tile fills the edges,
    // the Transform effect draws its own motion blur, and a zoom / spin / directional blur and lens
    // distortion peak exactly on the cut.
    function trHead(strength) {
        return [
            "// Sayframe transition: written by the Sayframe panel. The cut is in the middle of this layer; its length is the duration.",
            "function tP(){var a=thisLayer.inPoint,b=thisLayer.outPoint;return Math.min(1,Math.max(0,(time-a)/Math.max(b-a,thisComp.frameDuration)));}",
            "function tK(){try{return effect(" + jsonString(strength) + ")(1)/100;}catch(e){return 1;}}",
            "function tIn(x){return x<=0?0:Math.pow(2,10*x-10);}",
            "function tOut(x){return x>=1?1:1-Math.pow(2,-10*x);}",
            "function tPeak(){var p=tP();return p<0.5?tIn(p*2):tIn(2-p*2);}",
            "function tBell(){return Math.pow(Math.sin(Math.PI*tP()),2);}",
            "function tAfter(){var p=tP();return p<0.5?0:Math.pow(1-(p*2-1),2);}",
            "function tSplit(a,b){var p=tP();return p<0.5?a*tIn(p*2):b*(1-tOut(p*2-1));}"
        ].join("\n");
    }

    function trExpr(prop, strength, body) { prop.expression = trHead(strength) + "\n" + body; }

    function trFx(l, matchName) { return acAdd(l, ["ADBE Effect Parade"], matchName); }

    function trSet(l, fx, param, value) { try { acP(l, ["ADBE Effect Parade", fx, param]).setValue(value); } catch (e0) {} }

    function trCamera(l, k, o) {
        var tile = trFx(l, "ADBE Tile"), tr, fx;
        trSet(l, tile, "ADBE Tile-0004", 400);
        trSet(l, tile, "ADBE Tile-0005", 400);
        trSet(l, tile, "ADBE Tile-0006", 1);
        if (o.twirl) {
            fx = trFx(l, "ADBE Twirl");
            trExpr(acP(l, ["ADBE Effect Parade", fx, "ADBE Twirl-0001"]), k, o.twirl);
            trSet(l, fx, "ADBE Twirl-0002", 75);
        }
        tr = trFx(l, "ADBE Geometry2");
        trSet(l, tr, "ADBE Geometry2-0009", 0);
        trSet(l, tr, "ADBE Geometry2-0010", 360);
        if (o.scale) {
            trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0003"]), k, o.scale);
            trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0004"]), k, o.scale);
        }
        if (o.rot) { trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0007"]), k, o.rot); }
        if (o.pos) { trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0002"]), k, o.pos); }
        if (o.skew) { trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0005"]), k, o.skew); }
        if (o.lens) {
            fx = trFx(l, "ADBE Optics Compensation");
            trExpr(acP(l, ["ADBE Effect Parade", fx, "ADBE Optics Compensation-0001"]), k, o.lens);
        }
        if (o.radial) {
            fx = trFx(l, "ADBE Radial Blur");
            trExpr(acP(l, ["ADBE Effect Parade", fx, "ADBE Radial Blur-0001"]), k, o.radial);
            trSet(l, fx, "ADBE Radial Blur-0003", o.spin ? 1 : 2);
            trSet(l, fx, "ADBE Radial Blur-0004", 2);
        }
        if (o.dir) {
            fx = trFx(l, "ADBE Motion Blur");
            trSet(l, fx, "ADBE Motion Blur-0001", o.dirAngle || 0);
            trExpr(acP(l, ["ADBE Effect Parade", fx, "ADBE Motion Blur-0002"]), k, o.dir);
        }
        if (o.blur) {
            fx = trFx(l, "ADBE Box Blur2");
            trExpr(acP(l, ["ADBE Effect Parade", fx, "ADBE Box Blur2-0001"]), k, o.blur);
        }
        if (o.mosaic) {
            fx = trFx(l, "ADBE Mosaic");
            trExpr(acP(l, ["ADBE Effect Parade", fx, "ADBE Mosaic-0001"]), k, o.mosaic);
            trExpr(acP(l, ["ADBE Effect Parade", fx, "ADBE Mosaic-0002"]), k, o.mosaic);
        }
    }

    var TR_GLITCH = "posterizeTime(12);seedRandom(index,false);";
    // A short decaying shake right after the cut (the "hit").
    var TR_HIT = "var h=tAfter()*tK();";

    function trLeak(l, k, colors) {
        var g = trFx(l, "ADBE 4ColorGradient"), i, b;
        for (i = 0; i < 4; i++) { trSet(l, g, "ADBE 4ColorGradient-000" + (2 + i * 2), colors[i]); }
        trExpr(acP(l, ["ADBE Effect Parade", g, "ADBE 4ColorGradient-0001"]), k,
            "[value[0]+Math.sin(time*2.3)*thisComp.width*0.35,value[1]+Math.cos(time*1.7)*thisComp.height*0.3]");
        trExpr(acP(l, ["ADBE Effect Parade", g, "ADBE 4ColorGradient-0005"]), k,
            "[value[0]+Math.cos(time*1.9)*thisComp.width*0.3,value[1]+Math.sin(time*2.6)*thisComp.height*0.35]");
        b = trFx(l, "ADBE Gaussian Blur 2");
        trSet(l, b, "ADBE Gaussian Blur 2-0001", 80);
        try { l.blendingMode = BlendingMode.SCREEN; } catch (e1) {}
        trExpr(acP(l, ["ADBE Transform Group", "ADBE Opacity"]), k, "100*Math.pow(Math.sin(Math.PI*tP()),1.2)*Math.min(1,tK())");
    }

    function trShape(l, comp, k, id, color) {
        var gi = acGroup(l), w = comp.width, h = comp.height, si, d;
        if (id === "circle") {
            si = acIn(l, gi, "ADBE Vector Shape - Ellipse");
            d = Math.ceil(Math.sqrt(w * w + h * h)) + 4;
            acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Ellipse Size"]).setValue([d, d]);
        } else {
            si = acIn(l, gi, "ADBE Vector Shape - Rect");
            acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Rect Size"]).setValue([w + 4, h + 4]);
        }
        acFill(l, gi, color);
        acP(l, ["ADBE Transform Group", "ADBE Position"]).setValue([w / 2, h / 2]);
        if (id === "circle") {
            trExpr(acP(l, ["ADBE Transform Group", "ADBE Scale"]), k, "var p=tP(),s=p<0.5?tOut(p*2):1-tIn(p*2-1);[100*s,100*s]");
        } else if (id === "wipe-up") {
            trExpr(acP(l, ["ADBE Transform Group", "ADBE Position"]), k,
                "var p=tP(),h=thisComp.height,f=p<0.5?0.5*tOut(p*2):0.5+0.5*tIn(p*2-1);[value[0],h*1.5-2*h*f]");
        } else {
            trExpr(acP(l, ["ADBE Transform Group", "ADBE Position"]), k,
                "var p=tP(),w=thisComp.width,f=p<0.5?0.5*tOut(p*2):0.5+0.5*tIn(p*2-1);[-w/2+2*w*f,value[1]]");
        }
    }

    var TR_BUILD = {
        // camera zoom
        "zoom-in": function (l, k) { trCamera(l, k, { scale: "100*(1+tK()*tSplit(2,-0.67))", radial: "60*tPeak()*tK()" }); },
        "zoom-out": function (l, k) { trCamera(l, k, { scale: "100*(1+tK()*tSplit(-0.67,2))", radial: "60*tPeak()*tK()" }); },
        "zoom-in-out": function (l, k) { trCamera(l, k, { scale: "100*(1+tK()*tSplit(2,2))", radial: "60*tPeak()*tK()" }); },
        "zoom-distort-in": function (l, k) {
            trCamera(l, k, { scale: "100*(1+tK()*tSplit(2,-0.67))", radial: "70*tPeak()*tK()", lens: "Math.min(150,120*tPeak()*tK())" });
        },
        "zoom-distort-out": function (l, k) {
            trCamera(l, k, { scale: "100*(1+tK()*tSplit(-0.67,2))", radial: "70*tPeak()*tK()", lens: "Math.min(150,120*tPeak()*tK())" });
        },
        "zoom-hit": function (l, k) {
            trCamera(l, k, { scale: TR_HIT + "100*(1+tK()*tSplit(3,-0.75))+12*h*Math.sin(time*40)",
                pos: TR_HIT + "[value[0]+noise(time*25)*80*h,value[1]+noise(time*25+30)*60*h]",
                rot: TR_HIT + "noise(time*20+60)*5*h", radial: "80*tPeak()*tK()", lens: "Math.min(150,100*tPeak()*tK())" });
        },
        // camera pan
        "pan-left": function (l, k) { trCamera(l, k, { pos: "[value[0]+tK()*tSplit(-1,1)*thisComp.width,value[1]]", dir: "200*tPeak()*tK()", dirAngle: 90 }); },
        "pan-right": function (l, k) { trCamera(l, k, { pos: "[value[0]+tK()*tSplit(1,-1)*thisComp.width,value[1]]", dir: "200*tPeak()*tK()", dirAngle: 90 }); },
        "pan-up": function (l, k) { trCamera(l, k, { pos: "[value[0],value[1]+tK()*tSplit(-1,1)*thisComp.height]", dir: "200*tPeak()*tK()", dirAngle: 0 }); },
        "pan-down": function (l, k) { trCamera(l, k, { pos: "[value[0],value[1]+tK()*tSplit(1,-1)*thisComp.height]", dir: "200*tPeak()*tK()", dirAngle: 0 }); },
        // camera rotate
        "rotate": function (l, k) { trCamera(l, k, { scale: "100*(1+0.2*tBell()*tK())", rot: "tK()*tSplit(90,-90)", radial: "40*tPeak()*tK()", spin: true }); },
        "roll": function (l, k) { trCamera(l, k, { scale: "100*(1+0.3*tBell()*tK())", rot: "tK()*tSplit(180,-180)", radial: "60*tPeak()*tK()", spin: true }); },
        "zoom-rotate": function (l, k) {
            trCamera(l, k, { scale: "100*(1+tK()*tSplit(2,-0.6))", rot: "tK()*tSplit(120,-120)", radial: "70*tPeak()*tK()", lens: "Math.min(150,80*tPeak()*tK())" });
        },
        "twirl": function (l, k) {
            trCamera(l, k, { twirl: "tK()*tSplit(540,-540)", scale: "100*(1+tK()*tSplit(1.5,-0.5))", radial: "50*tPeak()*tK()" });
        },
        // camera shake
        "shake": function (l, k) {
            trCamera(l, k, { scale: "100*(1+0.25*tBell()*tK())", pos: "var a=tBell()*tK();[value[0]+noise(time*22)*140*a,value[1]+noise(time*22+40)*100*a]",
                rot: "noise(time*16+90)*10*tBell()*tK()", lens: "Math.min(150,90*tPeak()*tK())", dir: "120*tBell()*tK()", dirAngle: 90 });
        },
        // glitch
        "glitch": function (l, k) {
            trCamera(l, k, { pos: TR_GLITCH + "var a=tBell()*tK();[value[0]+(random()-0.5)*thisComp.width*0.2*a,value[1]+(random()-0.5)*50*a]",
                skew: TR_GLITCH + "(random()-0.5)*50*tBell()*tK()", scale: TR_GLITCH + "100*(1+random()*0.3*tBell()*tK())",
                mosaic: TR_GLITCH + "(random()<0.45*tBell()*tK())?Math.round(20+random()*60):4000" });
        },
        "glitch-shake": function (l, k) {
            trCamera(l, k, { pos: TR_GLITCH + "var a=tBell()*tK();[value[0]+(random()-0.5)*thisComp.width*0.35*a,value[1]+(random()-0.5)*140*a]",
                skew: TR_GLITCH + "(random()-0.5)*80*tBell()*tK()", scale: TR_GLITCH + "100*(1+random()*0.5*tBell()*tK())",
                rot: TR_GLITCH + "(random()-0.5)*18*tBell()*tK()", mosaic: TR_GLITCH + "(random()<0.6*tBell()*tK())?Math.round(12+random()*50):4000" });
        },
        // blurs & fades
        "blur-dissolve": function (l, k) { trCamera(l, k, { scale: "100*(1+0.15*tBell()*tK())", blur: "80*Math.pow(Math.sin(Math.PI*tP()),2)*tK()" }); },
        "leak-warm": function (l, k) { trLeak(l, k, [[1, 0.55, 0.1, 1], [1, 0.2, 0.3, 1], [1, 0.85, 0.4, 1], [0.2, 0.04, 0, 1]]); },
        "leak-cool": function (l, k) { trLeak(l, k, [[0.2, 0.6, 1, 1], [0.6, 0.3, 1, 1], [0.3, 1, 0.9, 1], [0, 0.03, 0.15, 1]]); },
        "flash": function (l, k) {
            try { l.blendingMode = BlendingMode.ADD; } catch (e0) {}
            trExpr(acP(l, ["ADBE Transform Group", "ADBE Opacity"]), k, "100*tPeak()*Math.min(1,tK())");
        },
        "fade-black": function (l, k) {
            trExpr(acP(l, ["ADBE Transform Group", "ADBE Opacity"]), k, "100*Math.min(1,tK())*Math.min(1,Math.sin(Math.PI*tP())*1.4)");
        },
        "fade-white": function (l, k) {
            trExpr(acP(l, ["ADBE Transform Group", "ADBE Opacity"]), k, "100*Math.min(1,tK())*Math.min(1,Math.sin(Math.PI*tP())*1.4)");
        }
    };

    function trRead(layer) {
        var mk = layer.property("ADBE Marker"), i, mv, m, params;
        if (!mk) { return null; }
        for (i = 1; i <= mk.numKeys; i++) {
            mv = mk.keyValue(i);
            try { params = mv.getParameters() || {}; } catch (e0) { params = {}; }
            m = /\{sft:([a-z0-9\-]+)\}/.exec(String(mv.comment));
            if (params.tid) { m = [0, params.tid]; }
            if (!m) { continue; }
            return { id: m[1], cut: mk.keyTime(i), strength: params.sk || "" };
        }
        return null;
    }

    function trDescribe(layer) {
        var t = trRead(layer), fx;
        if (!t) { return null; }
        fx = sfFx(layer, t.strength);
        return { id: t.id, dur: Math.round((layer.outPoint - layer.inPoint) * 1000) / 1000, strengthName: t.strength,
            strength: fx ? fx.property(1).value : 100 };
    }

    // ---- FX Console helpers

    function fxSelectedLayers() {
        var comp = activeComp();
        var layers = comp.selectedLayers;
        if (!layers || !layers.length) { throw new Error("NO_LAYERS_SELECTED"); }
        return layers;
    }

    function fxApplyEffect(matchName, label) {
        var layers = fxSelectedLayers();
        var applied = 0, skipped = 0, i, fx;
        app.beginUndoGroup("Sayframe: " + (label || "effect"));
        try {
            for (i = 0; i < layers.length; i++) {
                fx = null;
                try { fx = layers[i].property("ADBE Effect Parade"); } catch (e0) {}
                if (fx && fx.canAddProperty(matchName)) { fx.addProperty(matchName); applied++; } else { skipped++; }
            }
        } finally {
            app.endUndoGroup();
        }
        return { applied: applied, skipped: skipped };
    }

    function fxApplyPreset(path, label) {
        var layers = fxSelectedLayers();
        var file = new File(path);
        var applied = 0, skipped = 0, i;
        if (!file.exists) { throw new Error("PRESET_NOT_FOUND"); }
        app.beginUndoGroup("Sayframe: " + (label || "preset"));
        try {
            for (i = 0; i < layers.length; i++) {
                if (layers[i] instanceof CameraLayer || layers[i] instanceof LightLayer) { skipped++; continue; }
                try { layers[i].applyPreset(file); applied++; } catch (e1) { skipped++; }
            }
        } finally {
            app.endUndoGroup();
        }
        return { applied: applied, skipped: skipped };
    }

    // Search items for the popup, built once per session: { id, kind, name, cat, key, catKey, m | p }.
    function fxPopupItems() {
        var g = $.global, cat, items = [], i, e, pr;
        if (g.__sayframeFxItems) { return g.__sayframeFxItems; }
        cat = fxCatalogData();
        for (i = 0; i < cat.effects.length; i++) {
            e = cat.effects[i];
            items.push({ id: "e:" + e.m, kind: "effect", name: e.n, cat: e.c, m: e.m, key: e.n.toLowerCase(), catKey: e.c.toLowerCase() });
        }
        for (i = 0; i < cat.presets.length; i++) {
            pr = cat.presets[i];
            items.push({ id: "p:" + pr.p, kind: "preset", name: pr.n, cat: pr.u ? "\u041c\u043e\u0438 \u043f\u0440\u0435\u0441\u0435\u0442\u044b" : pr.g, p: pr.p, key: pr.n.toLowerCase(), catKey: String(pr.g).toLowerCase() });
        }
        g.__sayframeFxItems = items;
        return items;
    }

    // Same order as the panel's search: start of the name, start of a word, anywhere, the category.
    function fxPopupSearch(items, query, favMap) {
        var whole = String(query).toLowerCase().replace(/^\s+|\s+$/g, "");
        var words = whole ? whole.split(/\s+/) : [];
        var found = [], i, j, it, sc, w, at, ok;
        for (i = 0; i < items.length; i++) {
            it = items[i];
            sc = 0;
            ok = true;
            for (j = 0; j < words.length && ok; j++) {
                w = words[j];
                at = it.key.indexOf(w);
                if (at === 0) { sc += 0; }
                else if (at > 0 && /[\s\-_(]/.test(it.key.charAt(at - 1))) { sc += 1; }
                else if (at > 0) { sc += 3; }
                else if (it.catKey.indexOf(w) >= 0) { sc += 6; }
                else { ok = false; }
            }
            if (!ok) { continue; }
            if (it.key === whole) { sc -= 5; }
            if (favMap[it.id]) { sc -= 2; }
            if (it.kind === "preset") { sc += 1; }
            found.push({ it: it, sc: sc });
        }
        found.sort(function (a, b) { return a.sc - b.sc || a.it.name.length - b.it.name.length || (a.it.name < b.it.name ? -1 : 1); });
        return found;
    }

    var FX_ROW = 22;
    var FX_NO_LAYER = "\u0421\u043b\u043e\u0439 \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d \u2014 \u0432\u044b\u0434\u0435\u043b\u0438\u0442\u0435 \u0441\u043b\u043e\u0439, \u0447\u0442\u043e\u0431\u044b \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u044d\u0444\u0444\u0435\u043a\u0442.";
    var FX_PICK_LAYER = "\u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043b\u043e\u0439";

    function fxPopupShow(x, y, fav, recent) {
        var g = $.global, items, byId = {}, favMap = {}, shown = [], w, q, list, note, i, scr, b, left, top, up = false;
        if (g.__sayframeFxWin) {
            try { g.__sayframeFxWin.close(); } catch (e0) {}
            g.__sayframeFxWin = null;
            return { closed: true };
        }
        items = fxPopupItems();
        for (i = 0; i < items.length; i++) { byId[items[i].id] = items[i]; }
        for (i = 0; i < fav.length; i++) { favMap[fav[i]] = true; }

        w = new Window("palette", "Sayframe FX", undefined, { closeButton: true });
        w.orientation = "column";
        w.alignChildren = ["fill", "top"];
        w.margins = 8;
        w.spacing = 6;
        q = w.add("edittext", undefined, "");
        q.preferredSize = [340, 24];
        list = w.add("listbox", undefined, [], { numberOfColumns: 2, showHeaders: false, columnWidths: [230, 100] });
        list.preferredSize = [340, FX_ROW * 3 + 4];
        // One short line, only when no layer is selected; otherwise it takes no room. It is made with its text
        // (ScriptUI sizes a static text by the text it is born with: an empty one stays invisible later).
        note = w.add("statictext", undefined, FX_NO_LAYER);
        note.preferredSize = [340, 18];

        // With no layers selected the window still opens: search works, and the note says no layer is selected.
        function layerCount() {
            var c = app.project ? app.project.activeItem : null;
            return c instanceof CompItem && c.selectedLayers ? c.selectedLayers.length : 0;
        }
        // The window is as tall as its results (up to 8 rows): no big empty box under a short list.
        function fit() {
            var n = Math.max(1, Math.min(8, list.items.length));
            list.preferredSize = [340, FX_ROW * n + 4];
            try { list.size = [340, FX_ROW * n + 4]; } catch (eS) {}
            try { w.layout.layout(true); if (w.layout.resize) { w.layout.resize(); } } catch (eL) {}
        }
        function hint() {
            var none = !layerCount();
            note.text = none ? FX_NO_LAYER : "";
            note.preferredSize = [340, none ? 18 : 0];
            try { note.visible = none; } catch (eV) {}
            try { w.text = none ? "Sayframe FX \u2014 " + FX_PICK_LAYER : "Sayframe FX"; } catch (eT) {}
            fit();
        }

        function fill() {
            var r, k, row, it;
            list.removeAll();
            shown = [];
            if (q.text.replace(/\s/g, "") === "") {
                for (k = 0; k < fav.length; k++) { if (byId[fav[k]]) { shown.push(byId[fav[k]]); } }
                for (k = 0; k < recent.length; k++) { if (byId[recent[k]] && !favMap[recent[k]]) { shown.push(byId[recent[k]]); } }
            } else {
                r = fxPopupSearch(items, q.text, favMap);
                for (k = 0; k < r.length && k < 40; k++) { shown.push(r[k].it); }
            }
            for (k = 0; k < shown.length; k++) {
                it = shown[k];
                row = list.add("item", (favMap[it.id] ? "\u2605 " : "") + it.name);
                row.subItems[0].text = it.kind === "effect" ? it.cat : "\u043f\u0440\u0435\u0441\u0435\u0442 \u00b7 " + it.cat;
            }
            if (list.items.length) { list.selection = 0; }
            fit();
        }
        function move(d) {
            var n = list.items.length, at;
            if (!n) { return; }
            at = list.selection ? list.selection.index + d : 0;
            if (at < 0) { at = 0; }
            if (at >= n) { at = n - 1; }
            list.selection = at;
        }
        function close() {
            g.__sayframeFxWin = null;
            try { w.close(); } catch (e1) {}
        }
        function apply() {
            var it = list.selection ? shown[list.selection.index] : null, res, msg;
            if (!it) { return; }
            if (!layerCount()) { hint(); return; }
            close();
            try {
                res = it.kind === "effect" ? fxApplyEffect(it.m, it.name) : fxApplyPreset(it.p, it.name);
                msg = { id: it.id, name: it.name, kind: it.kind, applied: res.applied, skipped: res.skipped };
            } catch (e2) {
                msg = { id: it.id, name: it.name, kind: it.kind, error: (e2 && e2.message) ? e2.message : String(e2) };
            }
            sayframeDispatch("com.sayframe.fx", toJSON(msg));
        }
        function onKey(e) {
            if (e.keyName === "Down") { move(1); e.preventDefault(); }
            else if (e.keyName === "Up") { move(-1); e.preventDefault(); }
            else if (e.keyName === "Enter" || e.keyName === "Return") { apply(); e.preventDefault(); }
            else if (e.keyName === "Escape") { close(); e.preventDefault(); }
        }
        q.onChanging = fill;
        q.addEventListener("keydown", onKey);
        list.addEventListener("keydown", onKey);
        list.onDoubleClick = apply;
        w.onClose = function () { g.__sayframeFxWin = null; };
        w.onActivate = hint;
        // A click anywhere outside (After Effects gets the focus back) closes the window, like a menu.
        // Only once it is up: on macOS the palette can lose the focus for a moment while it is being shown.
        w.onDeactivate = function () { if (up) { close(); } };
        fill();
        hint();
        w.layout.layout(true);

        // At the mouse, but fully on the screen it is on. On macOS a palette placed before show() can be
        // put back where After Effects likes, so the place is set again once the window is up.
        function place() {
            var k;
            b = w.frameBounds || w.bounds;
            left = Math.round(x - 30);
            top = Math.round(y - 20);
            scr = $.screens || [];
            for (k = 0; k < scr.length; k++) {
                if (x >= scr[k].left && x < scr[k].right && y >= scr[k].top && y < scr[k].bottom && b) {
                    left = Math.max(scr[k].left, Math.min(left, scr[k].right - (b.right - b.left)));
                    top = Math.max(scr[k].top, Math.min(top, scr[k].bottom - (b.bottom - b.top)));
                }
            }
            w.location = [left, top];
        }
        place();
        g.__sayframeFxWin = w;
        w.show();
        try { place(); } catch (e4) {}
        try { w.active = true; q.active = true; } catch (e3) {}
        up = true;
        // For the panel's settings: where the window was asked to go and where it actually is.
        var real = null, scrList = [];
        try { real = [Math.round(w.location[0]), Math.round(w.location[1])]; } catch (e5) {}
        try { for (i = 0; i < (($.screens || []).length); i++) { scrList.push([$.screens[i].left, $.screens[i].top, $.screens[i].right, $.screens[i].bottom]); } } catch (e6) {}
        return { shown: true, count: items.length, asked: [left, top], at: real, screens: scrList };
    }

    function fxCatalogData() {
        var list = app.effects || [];
        var effects = [], presets = [], seen = {}, roots = [], i, e, f;
        for (i = 0; i < list.length; i++) {
            e = list[i];
            if (!e || !e.displayName || !e.matchName) { continue; }
            effects.push({ n: String(e.displayName), m: String(e.matchName), c: String(e.category || "") });
        }
        f = Folder.appPackage;
        if (f) {
            roots.push({ dir: new Folder(f.fsName + "/Presets"), user: false });
            if (f.parent) { roots.push({ dir: new Folder(f.parent.fsName + "/Presets"), user: false }); }
        }
        f = new Folder(Folder.myDocuments.fsName + "/Adobe");
        if (f.exists) {
            list = f.getFiles();
            for (i = 0; i < list.length; i++) {
                if (list[i] instanceof Folder && /^After Effects/.test(decodeURI(list[i].name))) {
                    roots.push({ dir: new Folder(list[i].fsName + "/User Presets"), user: true });
                }
            }
        }
        for (i = 0; i < roots.length; i++) {
            if (roots[i].dir.exists && !seen[roots[i].dir.fsName]) {
                seen[roots[i].dir.fsName] = true;
                fxScanPresets(roots[i].dir, roots[i].user, presets, 0);
            }
        }
        return { effects: effects, presets: presets };
    }

    function fxScanPresets(dir, user, out, depth) {
        var list, i, name;
        if (depth > 6 || out.length > 4000) { return; }
        list = dir.getFiles();
        for (i = 0; i < list.length; i++) {
            if (list[i] instanceof Folder) {
                fxScanPresets(list[i], user, out, depth + 1);
            } else {
                try { name = decodeURI(list[i].name); } catch (e0) { name = String(list[i].name); }
                if (/\.ffx$/i.test(name)) {
                    out.push({ n: name.replace(/\.ffx$/i, ""), p: list[i].fsName, g: decodeURI(dir.name), u: user });
                }
            }
        }
    }

    // ---- brand helpers

    var BR_RIG = "Brand Colors";
    var BR_LOGO_SCALE = 10;     // percent: the logo precomp layer in the user's comp

    function brHex(hex) {
        var m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex));
        var n = m ? parseInt(m[1], 16) : 0;
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }

    function brRigLayer(comp) {
        var i, l;
        for (i = 1; i <= comp.numLayers; i++) {
            l = comp.layer(i);
            if (l && l.name === BR_RIG) { return l; }
        }
        return null;
    }

    // The expression that reads this color from the Brand Colors layer, or "" when there is none.
    function brLink(comp, name) {
        var rig = brRigLayer(comp), fx, j;
        if (!rig) { return ""; }
        fx = rig.property("ADBE Effect Parade");
        for (j = 1; fx && j <= fx.numProperties; j++) {
            if (fx.property(j).name === name && fx.property(j).matchName === "ADBE Color Control") {
                return "thisComp.layer(\"" + BR_RIG + "\").effect(\"" + String(name).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\")(1)";
            }
        }
        return "";
    }

    function brSet(prop, rgb, link) {
        if (link && prop.canSetExpression) {
            prop.expression = link;
        } else {
            if (prop.numKeys > 0) {
                for (var k = 1; k <= prop.numKeys; k++) { prop.setValueAtKey(k, rgb); }
            } else {
                prop.setValue(rgb);
            }
        }
    }

    function brFills(group, out) {
        var i, p;
        for (i = 1; i <= group.numProperties; i++) {
            p = group.property(i);
            if (p.matchName === "ADBE Vector Graphic - Fill") { out.push(p.property("ADBE Vector Fill Color")); }
            else if (p.numProperties) { brFills(p, out); }
        }
        return out;
    }

    function brFillEffect(l) {
        var fx = l.property("ADBE Effect Parade"), i, ef;
        for (i = 1; i <= fx.numProperties; i++) {
            if (fx.property(i).matchName === "ADBE Fill" && fx.property(i).name === "Brand Fill") { return fx.property(i); }
        }
        ef = fx.addProperty("ADBE Fill");
        ef.name = "Brand Fill";
        return ef;
    }

    // Text: fill color (or a Fill effect when linked - text color takes no expression); shapes: every fill;
    // solids: the solid color; anything else: a Fill effect.
    function brPaint(l, rgb, link) {
        var prop, td, fills, i, locked = l.locked;
        if (locked) { l.locked = false; }
        try {
            if (l instanceof TextLayer && !link) {
                prop = l.property("ADBE Text Properties").property("ADBE Text Document");
                td = prop.value;
                td.applyFill = true;
                td.fillColor = rgb;
                prop.setValue(td);
            } else if (l instanceof ShapeLayer && (fills = brFills(l.property("ADBE Root Vectors Group"), [])).length) {
                for (i = 0; i < fills.length; i++) { brSet(fills[i], rgb, link); }
            } else if (!link && l.source && l.source.mainSource && l.source.mainSource instanceof SolidSource) {
                l.source.mainSource.color = rgb;
            } else if (l.property("ADBE Effect Parade")) {
                brSet(brFillEffect(l).property("ADBE Fill-0002"), rgb, link);
            } else {
                return false;
            }
        } finally {
            if (locked) { l.locked = true; }
        }
        return true;
    }

    function brRound(v) { return Math.round(v * 1000) / 1000; }

    function brRamp(l, g, comp) {
        var fx, ef, r = null, w, h, cx, cy, a, dx, dy, len, rad, locked = l.locked;
        fx = l.property("ADBE Effect Parade");
        if (!fx) { return false; }
        if (locked) { l.locked = false; }
        try {
            try { r = l.sourceRectAtTime(comp.time, false); } catch (e0) { r = null; }
            if (!r || !(r.width > 0) || !(r.height > 0)) {
                r = { left: 0, top: 0, width: l.width || comp.width, height: l.height || comp.height };
            }
            w = r.width; h = r.height;
            cx = r.left + w / 2; cy = r.top + h / 2;
            ef = fx.addProperty("ADBE Ramp");
            try { ef.name = String(g.name); } catch (e1) {}
            if (g.type === "radial") {
                rad = Math.sqrt(w * w + h * h) / 2;
                ef.property("ADBE Ramp-0001").setValue([cx, cy]);
                ef.property("ADBE Ramp-0003").setValue([cx + rad, cy]);
                ef.property("ADBE Ramp-0005").setValue(2);
            } else {
                a = (Number(g.angle) || 0) * Math.PI / 180;
                dx = Math.sin(a); dy = -Math.cos(a);
                len = Math.abs(w / 2 * dx) + Math.abs(h / 2 * dy);
                ef.property("ADBE Ramp-0001").setValue([brRound(cx - dx * len), brRound(cy - dy * len)]);
                ef.property("ADBE Ramp-0003").setValue([brRound(cx + dx * len), brRound(cy + dy * len)]);
                ef.property("ADBE Ramp-0005").setValue(1);
            }
            ef.property("ADBE Ramp-0002").setValue(brHex(g.from));
            ef.property("ADBE Ramp-0004").setValue(brHex(g.to));
        } finally {
            if (locked) { l.locked = true; }
        }
        return true;
    }

    function brFontMissing(font) {
        var list;
        try {
            if (app.fonts && app.fonts.getFontsByPostScriptName) {
                list = app.fonts.getFontsByPostScriptName(font);
                return !list || !list.length;
            }
        } catch (e) {}
        return false;
    }

    // ---- null / parent helpers

    function npChildren(comp, L) {
        var names = [], kids = [], i, c, nul = false;
        for (i = 1; i <= comp.numLayers; i++) {
            c = comp.layer(i);
            if (c && c.parent && c.parent.index === L.index) { kids.push(c); names.push(c.name); }
        }
        try { nul = L.nullLayer === true; } catch (eN) {}
        if (kids.length) {
            L.selected = false;
            for (i = 0; i < kids.length; i++) { try { kids[i].selected = true; } catch (eS) {} }
        }
        return { name: L.name, isNull: nul, names: names };
    }

    function npPos(L) {
        var tr = L.property("ADBE Transform Group");
        var p = tr ? tr.property("ADBE Position") : null;
        return p ? p.value : null;
    }

    // ---- Kit (the Animation tab): ready-made set-ups for editors, built from AE's own effects.
    // Liquid glass: the selected layer is the glass shape (none - a rounded rectangle is made). Under it an
    // adjustment layer matted to the shape bulges, blurs and brightens what is below; above it a copy of the
    // shape in Overlay with Bevel Alpha draws the light on the edges. Both follow the shape (expressions, parent).
    function kitSet(l, fx, param, v) {
        try { acP(l, ["ADBE Effect Parade", fx, param]).setValue(v); return true; } catch (e) { return false; }
    }

    function kitExpr(l, fx, param, code) {
        try { acP(l, ["ADBE Effect Parade", fx, param]).expression = code; return true; } catch (e) { return false; }
    }

    function kitControl(l, matchName, name, value) {
        var fx = acAdd(l, ["ADBE Effect Parade"], matchName);
        try { acP(l, ["ADBE Effect Parade", fx]).name = name; } catch (e0) {}
        kitSet(l, fx, matchName + "-0001", value);
        return fx;
    }

    function kitGlassShape(comp, name) {
        var l = comp.layers.addShape(), gi, w = Math.round(comp.width * 0.42), h = Math.round(comp.height * 0.3), ri;
        l.name = name;
        gi = acGroup(l);
        ri = acIn(l, gi, "ADBE Vector Shape - Rect");
        acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Size"]).setValue([w, h]);
        acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Roundness"]).setValue(Math.round(Math.min(w, h) * 0.22));
        ri = acIn(l, gi, "ADBE Vector Graphic - Fill");
        acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Fill Color"]).setValue([1, 1, 1, 1]);
        acP(l, ["ADBE Transform Group", "ADBE Position"]).setValue([comp.width / 2, comp.height / 2]);
        return l;
    }

    // o (optional, the Maketi block): { shape: a layer made by the block, free: the shape moves by expressions, so the
    // edge and the outline are not parented to it, edge: "std"|"thin"|"run"|"dash"|"none"|"glow" }.
    function kitLiquidGlass(comp, labels, o) {
        var sel = comp.selectedLayers || [], shape = null, made = false, i, adj, edge, fx, ref, legacy, stroke = null, ti;
        o = o || {};
        if (o.shape) {
            shape = o.shape;
        } else {
            for (i = 0; i < sel.length; i++) {
                if (!(sel[i] instanceof CameraLayer) && !(sel[i] instanceof LightLayer) && !sel[i].adjustmentLayer) { shape = sel[i]; break; }
            }
        }
        if (shape && shape.locked) { throw new Error("SM_LOCKED"); }
        for (i = 0; i < sel.length; i++) { try { sel[i].selected = false; } catch (e0) {} }
        if (!shape) {
            if (o.need) { throw new Error("GL_NO_SHAPE"); }
            shape = kitGlassShape(comp, labels.shape || "Glass"); made = true;
        }
        // The expressions find the shape by name; After Effects keeps them right when it is renamed.
        ref = "thisComp.layer(\"" + String(shape.name).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\")";
        adj = comp.layers.addSolid([1, 1, 1], labels.glass || "Liquid Glass", comp.width, comp.height, comp.pixelAspect || 1, comp.duration);
        adj.adjustmentLayer = true;
        adj.name = labels.glass || "Liquid Glass";
        try { adj.inPoint = shape.inPoint; adj.outPoint = shape.outPoint; } catch (e1) {}
        // Bulge: a lens the size of the shape, in its middle.
        fx = acAdd(adj, ["ADBE Effect Parade"], "ADBE Bulge");
        kitExpr(adj, fx, "ADBE Bulge-0001", "var L = " + ref + ", r = L.sourceRectAtTime(time, false);\nr.width * Math.abs(L.transform.scale[0]) / 200;");
        kitExpr(adj, fx, "ADBE Bulge-0002", "var L = " + ref + ", r = L.sourceRectAtTime(time, false);\nr.height * Math.abs(L.transform.scale[1]) / 200;");
        kitExpr(adj, fx, "ADBE Bulge-0003", "var L = " + ref + ", r = L.sourceRectAtTime(time, false);\nL.toComp([r.left + r.width / 2, r.top + r.height / 2]);");
        kitSet(adj, fx, "ADBE Bulge-0004", 0.7);
        fx = acAdd(adj, ["ADBE Effect Parade"], "ADBE Gaussian Blur 2");
        kitSet(adj, fx, "ADBE Gaussian Blur 2-0001", 12);
        kitSet(adj, fx, "ADBE Gaussian Blur 2-0003", 1);
        fx = acAdd(adj, ["ADBE Effect Parade"], "ADBE Brightness & Contrast 2");
        kitSet(adj, fx, "ADBE Brightness & Contrast 2-0001", 10);
        // The edge light: a copy of the shape, grey in Overlay (the grey itself disappears), beveled.
        edge = shape.duplicate();
        edge.name = labels.edge || "Glass Edge";
        edge.enabled = true;
        fx = acAdd(edge, ["ADBE Effect Parade"], "ADBE Fill");
        kitSet(edge, fx, "ADBE Fill-0002", [0.5, 0.5, 0.5, 1]);
        fx = acAdd(edge, ["ADBE Effect Parade"], "ADBE Bevel Alpha");
        kitSet(edge, fx, "ADBE Bevel Alpha-0001", 6);
        kitSet(edge, fx, "ADBE Bevel Alpha-0004", 0.8);
        try { if (BlendingMode.OVERLAY !== undefined) { edge.blendingMode = BlendingMode.OVERLAY; } } catch (e2) {}
        // The outline (shape layers only): a copy of the shape with its own paint off and one Stroke on top,
        // driven by three controls in Effect Controls of that layer: width, colour, opacity.
        if (shape instanceof ShapeLayer) {
            stroke = shape.duplicate();
            stroke.name = labels.stroke || "Glass Stroke";
            stroke.enabled = true;
            pfMutePaint(stroke.property("ADBE Root Vectors Group"));
            kitControl(stroke, "ADBE Slider Control", labels.strokeWidth || "Stroke Width", 2);
            kitControl(stroke, "ADBE Color Control", labels.strokeColor || "Stroke Color", [1, 1, 1, 1]);
            kitControl(stroke, "ADBE Slider Control", labels.strokeOpacity || "Stroke Opacity", 70);
            // Running outline: a short piece of the line goes round and round (Trim Paths before the Stroke).
            if (o.edge === "run") {
                ti = acAdd(stroke, ["ADBE Root Vectors Group"], "ADBE Vector Filter - Trim");
                try {
                    acP(stroke, ["ADBE Root Vectors Group", ti, "ADBE Vector Trim End"]).setValue(25);
                    acP(stroke, ["ADBE Root Vectors Group", ti, "ADBE Vector Trim Offset"]).expression = "time * 120;";
                } catch (e6) {}
            }
            fx = acAdd(stroke, ["ADBE Root Vectors Group"], "ADBE Vector Graphic - Stroke");
            try {
                acP(stroke, ["ADBE Root Vectors Group", fx, "ADBE Vector Stroke Width"]).expression = "Math.max(0, effect(1)(1));";
                acP(stroke, ["ADBE Root Vectors Group", fx, "ADBE Vector Stroke Color"]).expression = "effect(2)(1);";
                acP(stroke, ["ADBE Root Vectors Group", fx, "ADBE Vector Stroke Opacity"]).expression = "Math.max(0, Math.min(100, effect(3)(1)));";
            } catch (e4) {}
        }
        // Order, top to bottom: outline, edge, glass (matted to the shape), shape (hidden: it only gives the outline).
        legacy = typeof adj.setTrackMatte !== "function";
        if (legacy) {
            adj.moveAfter(shape);
            edge.moveBefore(shape);
            adj.trackMatteType = TrackMatteType.ALPHA;
        } else {
            adj.moveBefore(shape);
            edge.moveBefore(adj);
            adj.setTrackMatte(shape, TrackMatteType.ALPHA);
        }
        if (stroke) {
            stroke.moveBefore(edge);
            if (!o.free) { try { stroke.parent = shape; } catch (e5) {} }
            stroke.selected = false;
        }
        shape.enabled = false;
        if (!o.free) { try { edge.parent = shape; } catch (e3) {} }
        edge.selected = false;
        shape.selected = true;
        return { glass: { name: adj.name, shape: shape.name, edge: edge.name, stroke: stroke ? stroke.name : "", created: made, legacy: legacy },
            layers: { adj: adj, edge: edge, stroke: stroke, shape: shape } };
    }

    // ---- Liquid glass block (Animation tab, Maketi section): with a text (button / card / text box / notification) or a plain
    // shape (circle ... star), a glass kind and an outline style; or the user's own selected shape becomes the glass.
    var GL_FORMS = { btn: 1, card: 1, box: 1, note: 1 };
    var GL_SHAPES = { circle: 1, square: 1, round: 1, heart: 1, star: 1, pill: 1, tri: 1, hex: 1 };
    var GL_KINDS = { clear: [0, 6], frost: [0, 18], tint: [1, 8], dark: [0, -40] };
    var GL_EDGES = { std: [2, 70], thin: [1, 100], run: [3, 100], dash: [2, 90], none: [2, 0], glow: [2, 100] };
    // A heart in a 100 x 100 box: points with their bezier handles (in, out), clockwise from the bottom tip.
    var GL_HEART = [[[50, 90], [16, -14], [-16, -14]], [[6, 36], [0, 18], [0, -14]], [[28, 10], [-12, 0], [12, 0]],
        [[50, 24], [-3, -9], [3, -9]], [[72, 10], [-12, 0], [12, 0]], [[94, 36], [0, -14], [0, 18]]];

    function glUniq(comp, base) {
        var names = {}, i, n = 2, out = base;
        for (i = 1; i <= comp.numLayers; i++) { try { names[comp.layer(i).name] = 1; } catch (e) {} }
        while (names[out]) { out = base + " " + n; n++; }
        return out;
    }

    function glText(comp, str, name, size, just, color) {
        var nm = glUniq(comp, name), t = comp.layers.addText(str), p, doc;
        try {
            p = acP(t, ["ADBE Text Properties", "ADBE Text Document"]);
            doc = p.value;
            doc.fontSize = Math.max(8, Math.round(size));
            doc.fillColor = color || [1, 1, 1];
            try { doc.applyFill = true; doc.applyStroke = false; } catch (e2) {}
            try { doc.justification = just === "left" ? ParagraphJustification.LEFT_JUSTIFY : ParagraphJustification.CENTER_JUSTIFY; } catch (e1) {}
            p.setValue(doc);
        } catch (e0) {}
        t.name = nm;
        return t;
    }

    // A shape layer with one group: a Rect / Ellipse / Star / path and a white fill (the fill only gives the matte).
    function glShapeLayer(comp, name, kind, w, h, round) {
        var l = comp.layers.addShape(), gi = acGroup(l), ri, s, pts = [], ins = [], outs = [], i, k = w / 100;
        l.name = glUniq(comp, name);
        if (kind === "circle") {
            ri = acIn(l, gi, "ADBE Vector Shape - Ellipse");
            acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Ellipse Size"]).setValue([w, w]);
        } else if (kind === "star" || kind === "tri" || kind === "hex") {
            ri = acIn(l, gi, "ADBE Vector Shape - Star");
            try {
                acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Star Type"]).setValue(kind === "star" ? 1 : 2);
                acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Star Points"]).setValue(kind === "star" ? 5 : (kind === "tri" ? 3 : 6));
                acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Star Outer Radius"]).setValue(w / 2);
                if (kind === "star") { acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Star Inner Radius"]).setValue(w * 0.22); }
            } catch (e0) {}
        } else if (kind === "heart") {
            for (i = 0; i < GL_HEART.length; i++) {
                pts.push([(GL_HEART[i][0][0] - 50) * k, (GL_HEART[i][0][1] - 50) * k]);
                ins.push([GL_HEART[i][1][0] * k, GL_HEART[i][1][1] * k]);
                outs.push([GL_HEART[i][2][0] * k, GL_HEART[i][2][1] * k]);
            }
            ri = acIn(l, gi, "ADBE Vector Shape - Group");
            s = new Shape();
            s.vertices = pts; s.inTangents = ins; s.outTangents = outs; s.closed = true;
            acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Shape"]).setValue(s);
        } else {
            ri = acIn(l, gi, "ADBE Vector Shape - Rect");
            acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Size"]).setValue([w, h]);
            acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Roundness"]).setValue(round || 0);
        }
        ri = acIn(l, gi, "ADBE Vector Graphic - Fill");
        acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Fill Color"]).setValue([1, 1, 1, 1]);
        acP(l, ["ADBE Transform Group", "ADBE Position"]).setValue([comp.width / 2, comp.height / 2]);
        l.glGroup = gi;
        return l;
    }

    // The glass under a text (button, text box): the rectangle takes the size of the text plus padding and stands
    // on its middle, by expressions, so it follows the text when it is retyped or moved.
    function glFollow(l, t, px, py, pill) {
        var ref = "thisComp.layer(\"" + String(t.name).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\")";
        var gi = l.glGroup;
        try {
            acGP(l, gi, ["ADBE Vectors Group", "ADBE Vector Shape - Rect", "ADBE Vector Rect Size"]).expression =
                "var t = " + ref + ", r = t.sourceRectAtTime(time, false), s = t.transform.scale;\n[r.width * Math.abs(s[0]) / 100 + " + px * 2 + ", r.height * Math.abs(s[1]) / 100 + " + py * 2 + "];";
            if (pill) {
                acGP(l, gi, ["ADBE Vectors Group", "ADBE Vector Shape - Rect", "ADBE Vector Rect Roundness"]).expression =
                    "var t = " + ref + ", r = t.sourceRectAtTime(time, false);\n(r.height * Math.abs(t.transform.scale[1]) / 100 + " + py * 2 + ") / 2;";
            }
            acP(l, ["ADBE Transform Group", "ADBE Position"]).expression =
                "var t = " + ref + ", r = t.sourceRectAtTime(time, false);\nt.toComp([r.left + r.width / 2, r.top + r.height / 2]);";
        } catch (e) {}
    }

    function glStyle(made, o) {
        var adj = made.layers.adj, edge = made.layers.edge, stroke = made.layers.stroke, kind = GL_KINDS[o.kind] || GL_KINDS.clear, ed = GL_EDGES[o.edge] || GL_EDGES.std, fx, sp;
        kitSet(adj, 2, "ADBE Gaussian Blur 2-0001", Math.round(Math.max(0, Math.min(100, Number(o.blur) || 0)) * 0.6));
        kitSet(adj, 3, "ADBE Brightness & Contrast 2-0001", kind[1]);
        if (kind[0]) {
            fx = acAdd(adj, ["ADBE Effect Parade"], "ADBE Tint");
            kitSet(adj, fx, "ADBE Tint-0002", o.tint || [0.48, 0.35, 0.96, 1]);
            kitSet(adj, fx, "ADBE Tint-0003", 45);
        }
        kitSet(edge, 2, "ADBE Bevel Alpha-0004", Math.max(0, Math.min(100, Number(o.light) || 0)) / 100);
        if (!stroke) { return; }
        kitSet(stroke, 1, "ADBE Slider Control-0001", ed[0]);
        kitSet(stroke, 3, "ADBE Slider Control-0001", ed[1]);
        if (o.edge === "dash") {
            try {
                sp = acP(stroke, ["ADBE Root Vectors Group", "ADBE Vector Graphic - Stroke", "ADBE Vector Stroke Dashes"]);
                sp.addProperty("ADBE Vector Stroke Dash 1");
                sp.addProperty("ADBE Vector Stroke Gap 1");
                acP(stroke, ["ADBE Root Vectors Group", "ADBE Vector Graphic - Stroke", "ADBE Vector Stroke Dashes", "ADBE Vector Stroke Dash 1"]).setValue(14);
                acP(stroke, ["ADBE Root Vectors Group", "ADBE Vector Graphic - Stroke", "ADBE Vector Stroke Dashes", "ADBE Vector Stroke Gap 1"]).setValue(10);
            } catch (e0) {}
        }
        if (o.edge === "glow") { try { acAdd(stroke, ["ADBE Effect Parade"], "ADBE Glo2"); } catch (e1) {} }
    }

    // o = { mode: "text"|"shape"|"mine", text, form, shape, kind, edge, blur, light, size }; lab - names in the panel's language.
    function glBuild(comp, o, lab) {
        var W = comp.width, H = comp.height, m = Math.min(W, H), shape = null, texts = [], made, i, free = false, t, t2, ic, w, h, gi;
        var text = String(o.text || "").replace(/^\s+|\s+$/g, "") || (lab.defaultText || "Text"), k, L = {};
        // Every new glass gets its own layer names (a second one in the comp: "... 2").
        for (k in lab) { if (lab.hasOwnProperty(k)) { L[k] = lab[k]; } }
        L.glass = glUniq(comp, lab.glass || "Liquid Glass");
        L.edge = glUniq(comp, lab.edge || "Glass Edge");
        L.stroke = glUniq(comp, lab.stroke || "Glass Stroke");
        lab = L;
        if (o.mode === "mine") {
            made = kitLiquidGlass(comp, lab, { need: true, edge: o.edge });
        } else {
            if (o.mode === "shape") {
                if (!GL_SHAPES[o.shape]) { throw new Error("BAD_GLASS"); }
                w = Math.round(m * Math.max(10, Math.min(100, Number(o.size) || 40)) / 100);
                h = o.shape === "pill" ? Math.round(w * 0.44) : w;
                shape = glShapeLayer(comp, lab[o.shape] || lab.shape || "Glass", o.shape, w, h, o.shape === "round" ? Math.round(w * 0.22) : (o.shape === "pill" ? h / 2 : 0));
            } else {
                if (!GL_FORMS[o.form]) { throw new Error("BAD_GLASS"); }
                if (o.form === "btn" || o.form === "box") {
                    t = glText(comp, o.form === "box" ? text.toUpperCase() : text, text, m * (o.form === "box" ? 0.09 : 0.055), "center");
                    try { acP(t, ["ADBE Transform Group", "ADBE Position"]).setValue([W / 2, H / 2 + m * 0.02]); } catch (eP) {}
                    shape = glShapeLayer(comp, lab[o.form] || "Glass", "rect", 100, 100, o.form === "box" ? Math.round(m * 0.02) : 0);
                    glFollow(shape, t, Math.round(m * (o.form === "box" ? 0.035 : 0.05)), Math.round(m * (o.form === "box" ? 0.02 : 0.03)), o.form === "btn");
                    texts.push(t);
                    free = true;
                } else if (o.form === "card") {
                    w = Math.round(W * 0.46); h = Math.round(H * 0.42);
                    shape = glShapeLayer(comp, lab.card || "Glass", "rect", w, h, Math.round(m * 0.05));
                    t = glText(comp, text, lab.title || "Title", m * 0.06, "left");
                    t2 = glText(comp, lab.sub || "Text", lab.subName || "Text", m * 0.032, "left", [0.92, 0.92, 0.95]);
                    try {
                        acP(t, ["ADBE Transform Group", "ADBE Position"]).setValue([W / 2 - w / 2 + m * 0.045, H / 2 + h / 2 - m * 0.1]);
                        acP(t2, ["ADBE Transform Group", "ADBE Position"]).setValue([W / 2 - w / 2 + m * 0.045, H / 2 + h / 2 - m * 0.045]);
                    } catch (eC) {}
                    texts.push(t2, t);
                } else {
                    w = Math.round(W * 0.5); h = Math.round(m * 0.15);
                    shape = glShapeLayer(comp, lab.note || "Glass", "rect", w, h, Math.round(h * 0.3));
                    try { acP(shape, ["ADBE Transform Group", "ADBE Position"]).setValue([W / 2, h / 2 + m * 0.06]); } catch (eN) {}
                    ic = glShapeLayer(comp, lab.icon || "Icon", "rect", Math.round(h * 0.6), Math.round(h * 0.6), Math.round(h * 0.15));
                    try {
                        gi = ic.glGroup;
                        acGP(ic, gi, ["ADBE Vectors Group", "ADBE Vector Graphic - Fill", "ADBE Vector Fill Color"]).setValue([0.48, 0.35, 0.96, 1]);
                        acP(ic, ["ADBE Transform Group", "ADBE Position"]).setValue([W / 2 - w / 2 + h * 0.5, h / 2 + m * 0.06]);
                    } catch (eI) {}
                    t = glText(comp, lab.app || "Sayframe", lab.appName || "Title", h * 0.24, "left");
                    t2 = glText(comp, text, lab.noteText || "Text", h * 0.21, "left", [0.92, 0.92, 0.95]);
                    try {
                        acP(t, ["ADBE Transform Group", "ADBE Position"]).setValue([W / 2 - w / 2 + h * 0.95, m * 0.06 + h * 0.44]);
                        acP(t2, ["ADBE Transform Group", "ADBE Position"]).setValue([W / 2 - w / 2 + h * 0.95, m * 0.06 + h * 0.74]);
                    } catch (eT) {}
                    texts.push(t2, t, ic);
                }
            }
            made = kitLiquidGlass(comp, lab, { shape: shape, free: free, edge: o.edge });
        }
        glStyle(made, o);
        // The texts (and the icon) stand above the glass; on a card or a notification they hang on the glass shape.
        for (i = 0; i < texts.length; i++) {
            try { texts[i].moveToBeginning(); } catch (e0) {}
            if (!free) { try { texts[i].parent = made.layers.shape; } catch (e1) {} }
            try { texts[i].selected = false; } catch (e2) {}
        }
        if (free && texts.length) { try { texts[0].selected = true; made.layers.shape.selected = false; } catch (e3) {} }
        made.glass.texts = [];
        for (i = 0; i < texts.length; i++) { made.glass.texts.push(texts[i].name); }
        made.glass.free = free;
        return { glass: made.glass };
    }

    // ---- Carousel (the Animation tab, section 3D): N cards around a 3D controller null, like a gallery ring.
    // Card shapes: rect (Rectangle with roundness), circle (Ellipse), tri / hex (a path: a regular polygon whose
    // corners are rounded by "corners" percent; 100 turns it into its inscribed circle). The cards are 3D layers
    // parented to the null, so turning the null turns the whole ring.
    var ORBIT_LAYOUTS = { ring: 1, half: 1, spiral: 1, wave: 1 };
    var ORBIT_SIDES = { rect: 4, circle: 0, tri: 3, hex: 6 };

    function orbitNum(v, lo, hi, def) {
        v = Number(v);
        if (isNaN(v)) { v = def; }
        return Math.max(lo, Math.min(hi, v));
    }

    // Where card i of n stands, relative to the null: x, y, z and its Y rotation (it faces out of the ring).
    function orbitSpot(i, n, layout, radius, h) {
        var a, y = 0, r;
        if (layout === "half") { a = n > 1 ? -90 + 180 * i / (n - 1) : 0; }
        else if (layout === "spiral") { a = i * 540 / n; y = (i - (n - 1) / 2) * h * 0.3; }
        else {
            a = i * 360 / n;
            if (layout === "wave") { y = Math.sin(a * 2 * Math.PI / 180) * h * 0.25; }
        }
        r = a * Math.PI / 180;
        // A layer looks along -Z; a Y rotation of +q turns that to (-sin q, 0, -cos q). The card at angle a must look
        // out of the ring, along (sin a, 0, -cos a), so it turns by -a (checked in After Effects: +a faced inward).
        return { x: radius * Math.sin(r), y: y, z: -radius * Math.cos(r), ry: a === 0 ? 0 : -a };
    }

    // The same colours as the preview in the panel: a purple-to-pink run.
    function orbitColor(i) {
        var hue = (250 + i * 22) % 360, s = 0.8, l = 0.62, c = (1 - Math.abs(2 * l - 1)) * s, hp = hue / 60;
        var x = c * (1 - Math.abs(hp % 2 - 1)), m = l - c / 2, rgb;
        if (hp < 1) { rgb = [c, x, 0]; } else if (hp < 2) { rgb = [x, c, 0]; } else if (hp < 3) { rgb = [0, c, x]; }
        else if (hp < 4) { rgb = [0, x, c]; } else if (hp < 5) { rgb = [x, 0, c]; } else { rgb = [c, 0, x]; }
        return [rgb[0] + m, rgb[1] + m, rgb[2] + m, 1];
    }

    // A regular polygon (pointy top) with rounded corners, stretched to w x h by its sharp outline.
    function orbitPoly(sides, t, w, h) {
        var V = [], i, a, inr, r, d, k, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, sx, sy, cx, cy;
        var verts = [], ins = [], outs = [], P, C, N, ua, ub, L, sP, eP;
        for (i = 0; i < sides; i++) {
            a = -Math.PI / 2 + i * 2 * Math.PI / sides;
            V.push([Math.cos(a), Math.sin(a)]);
            minX = Math.min(minX, V[i][0]); maxX = Math.max(maxX, V[i][0]);
            minY = Math.min(minY, V[i][1]); maxY = Math.max(maxY, V[i][1]);
        }
        sx = w / (maxX - minX); sy = h / (maxY - minY); cx = (minX + maxX) / 2; cy = (minY + maxY) / 2;
        inr = Math.cos(Math.PI / sides);
        r = Math.max(0, Math.min(1, t)) * inr;
        d = r * Math.tan(Math.PI / sides);
        k = 4 / 3 * Math.tan(Math.PI / sides / 2) * r;
        function pt(p) { return [(p[0] - cx) * sx, (p[1] - cy) * sy]; }
        function vec(p) { return [p[0] * sx, p[1] * sy]; }
        for (i = 0; i < sides; i++) {
            P = V[(i + sides - 1) % sides]; C = V[i]; N = V[(i + 1) % sides];
            L = Math.sqrt((P[0] - C[0]) * (P[0] - C[0]) + (P[1] - C[1]) * (P[1] - C[1]));
            ua = [(P[0] - C[0]) / L, (P[1] - C[1]) / L];
            ub = [(N[0] - C[0]) / L, (N[1] - C[1]) / L];
            if (r <= 0) {
                verts.push(pt(C)); ins.push([0, 0]); outs.push([0, 0]);
                continue;
            }
            sP = [C[0] + ua[0] * d, C[1] + ua[1] * d];
            eP = [C[0] + ub[0] * d, C[1] + ub[1] * d];
            verts.push(pt(sP)); ins.push([0, 0]); outs.push(vec([-ua[0] * k, -ua[1] * k]));
            verts.push(pt(eP)); ins.push(vec([-ub[0] * k, -ub[1] * k])); outs.push([0, 0]);
        }
        return { vertices: verts, inTangents: ins, outTangents: outs };
    }

    // One card's look inside a shape layer: a group with the shape and its fill, centred on the layer's origin.
    function orbitCardShape(l, kind, t, w, h, color) {
        var gi = acGroup(l), si, s, pl;
        try { acP(l, ["ADBE Root Vectors Group", gi]).name = "Card"; } catch (e0) {}
        if (kind === "rect") {
            si = acIn(l, gi, "ADBE Vector Shape - Rect");
            acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Rect Size"]).setValue([w, h]);
            acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Rect Roundness"]).setValue(Math.round(t * Math.min(w, h) / 2 * 10) / 10);
        } else if (kind === "circle") {
            si = acIn(l, gi, "ADBE Vector Shape - Ellipse");
            acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Ellipse Size"]).setValue([w, h]);
        } else {
            pl = orbitPoly(ORBIT_SIDES[kind], t, w, h);
            si = acIn(l, gi, "ADBE Vector Shape - Group");
            s = new Shape();
            s.vertices = pl.vertices;
            s.inTangents = pl.inTangents;
            s.outTangents = pl.outTangents;
            s.closed = true;
            acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Shape"]).setValue(s);
        }
        acFill(l, gi, color);
    }

    function orbitNumber(comp, text, size) {
        var l = comp.layers.addText(text), p, doc;
        try {
            p = acP(l, ["ADBE Text Properties", "ADBE Text Document"]);
            doc = p.value;
            doc.fontSize = size;
            doc.fillColor = [1, 1, 1];
            try { doc.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (e1) {}
            p.setValue(doc);
        } catch (e0) {}
        return l;
    }

    function orbitSet(l, name, v) {
        acP(l, ["ADBE Transform Group", name]).setValue(v);
    }

    // The camera steps back and a little up, like the panel's preview: the whole carousel in the frame with room
    // around it. Zoom (px) and the comp size give how far the camera has to be for the widest part and the nearest card.
    function orbitFrame(comp, camL, spots, w, h, cx, cy, tiltDeg) {
        var zoom = 0, ex = 0, ey = 0, near = 0, i, d, tilt = (tiltDeg === undefined ? 18 : tiltDeg) * Math.PI / 180;
        try { zoom = Number(acP(camL, ["ADBE Camera Options Group", "ADBE Camera Zoom"]).value); } catch (e0) { zoom = 0; }
        if (!(zoom > 0)) { zoom = comp.width * 1.389; }
        for (i = 0; i < spots.length; i++) {
            ex = Math.max(ex, Math.abs(spots[i].x) + w / 2);
            ey = Math.max(ey, Math.abs(spots[i].y) + h / 2);
            near = Math.max(near, -spots[i].z);
        }
        d = Math.max(zoom * 1.6 * ex / (comp.width / 2), zoom * 2.2 * ey / (comp.height / 2) + near, zoom);
        d = Math.round(d);
        orbitSet(camL, "ADBE Position", [cx, Math.round(cy - d * Math.sin(tilt)), -Math.round(d * Math.cos(tilt))]);
        try { orbitSet(camL, "ADBE Camera Point of Interest", [cx, cy, 0]); } catch (e1) {}
        return d;
    }

    // The number shows only from the front of its card: from behind (the card turned away from the camera) it is hidden.
    // Dan Ebberts' two-sided layer test: the layer's own Z axis in comp space points away from the camera when facing it.
    // A mask of the card's shape on the card comp layer, in the layer's own pixels (the comp is w x h).
    function orbitCardMask(L, kind, t, w, h) {
        var m, s, pl, i, k = 0.5523;
        try {
            if (kind === "rect") {
                s = gridMaskShape(w / 2, h / 2, w, h, t * Math.min(w, h) / 2);
            } else if (kind === "circle") {
                s = new Shape();
                s.vertices = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
                s.inTangents = [[-w / 2 * k, 0], [0, -h / 2 * k], [w / 2 * k, 0], [0, h / 2 * k]];
                s.outTangents = [[w / 2 * k, 0], [0, h / 2 * k], [-w / 2 * k, 0], [0, -h / 2 * k]];
                s.closed = true;
            } else {
                pl = orbitPoly(ORBIT_SIDES[kind], t, w, h);
                s = new Shape();
                s.vertices = [];
                for (i = 0; i < pl.vertices.length; i++) { s.vertices.push([pl.vertices[i][0] + w / 2, pl.vertices[i][1] + h / 2]); }
                s.inTangents = pl.inTangents; s.outTangents = pl.outTangents; s.closed = true;
            }
            m = acAdd(L, ["ADBE Mask Parade"], "ADBE Mask Atom");
            try { acP(L, ["ADBE Mask Parade", m]).name = "Card"; } catch (e0) {}
            acP(L, ["ADBE Mask Parade", m, "ADBE Mask Shape"]).setValue(s);
        } catch (eM) {}
    }

    function orbitHideBack(numLayer, cardRef) {
        try {
            acP(numLayer, ["ADBE Transform Group", "ADBE Opacity"]).expression =
                "var L=" + cardRef + ";L.toCompVec([0,0,1])[2]>0?value:0";
        } catch (e0) {}
    }


    // ---- Live carousel: settings in Effect Controls of the controller null. Expressions read them, so after
    // "Create carousel" the count, ring radius, card size, corners and the back side still change.
    // Expressions are plain JavaScript run by After Effects (not this ES3 file), so they may use createPath.
    function orbitFx(ctrlName, labels) {
        var c = "thisComp.layer(" + tbQ(ctrlName) + ")";
        return { c: c, n: c + ".effect(" + tbQ(labels.fxCount || "Cards") + ")(1)", r: c + ".effect(" + tbQ(labels.fxRadius || "Radius") + ")(1)",
            w: c + ".effect(" + tbQ(labels.fxW || "Width") + ")(1)", h: c + ".effect(" + tbQ(labels.fxH || "Height") + ")(1)",
            t: c + ".effect(" + tbQ(labels.fxCorners || "Corners %") + ")(1)/100", b: c + ".effect(" + tbQ(labels.fxBack || "Back visible") + ")(1)" };
    }

    // The angle (and height) of card i on the ring, the same as orbitSpot.
    function orbitSpotExpr(F, i, layout) {
        var e = "var n=Math.max(1,Math.round(" + F.n + ")),R=" + F.r + ",H=" + F.h + ",i=" + i + ",a,y=0;";
        if (layout === "half") { e += "a=n>1?-90+180*i/(n-1):0;"; }
        else if (layout === "spiral") { e += "a=i*540/n;y=(i-(n-1)/2)*H*0.3;"; }
        else { e += "a=i*360/n;"; if (layout === "wave") { e += "y=Math.sin(a*2*Math.PI/180)*H*0.25;"; } }
        return e;
    }

    // A card's outline as an expression path: rounded rect, ellipse or rounded polygon (orbitPoly), w x h, centred on ox, oy.
    function orbitPathExpr(kind, wE, hE, tE, ox, oy) {
        if (kind === "rect") {
            return "var w=" + wE + ",h=" + hE + ",r=Math.max(0,Math.min(1," + tE + "))*Math.min(w,h)/2,c=r*0.5523,x0=" + ox + "-w/2,x1=" + ox + "+w/2,y0=" + oy + "-h/2,y1=" + oy + "+h/2;" +
                "r<0.01?createPath([[x0,y0],[x1,y0],[x1,y1],[x0,y1]],[],[],true):createPath([[x0+r,y0],[x1-r,y0],[x1,y0+r],[x1,y1-r],[x1-r,y1],[x0+r,y1],[x0,y1-r],[x0,y0+r]]," +
                "[[-c,0],[0,0],[0,-c],[0,0],[c,0],[0,0],[0,c],[0,0]],[[0,0],[c,0],[0,0],[0,c],[0,0],[-c,0],[0,0],[0,-c]],true)";
        }
        if (kind === "circle") {
            return "var w=" + wE + ",h=" + hE + ",k=0.5523;createPath([[" + ox + "," + oy + "-h/2],[" + ox + "+w/2," + oy + "],[" + ox + "," + oy + "+h/2],[" + ox + "-w/2," + oy + "]]," +
                "[[-w/2*k,0],[0,-h/2*k],[w/2*k,0],[0,h/2*k]],[[w/2*k,0],[0,h/2*k],[-w/2*k,0],[0,-h/2*k]],true)";
        }
        return "var S=" + ORBIT_SIDES[kind] + ",w=" + wE + ",h=" + hE + ",t=Math.max(0,Math.min(1," + tE + ")),V=[],i,mnx=1e9,mxx=-1e9,mny=1e9,mxy=-1e9;" +
            "for(i=0;i<S;i++){var q=-Math.PI/2+i*2*Math.PI/S;V.push([Math.cos(q),Math.sin(q)]);mnx=Math.min(mnx,V[i][0]);mxx=Math.max(mxx,V[i][0]);mny=Math.min(mny,V[i][1]);mxy=Math.max(mxy,V[i][1]);}" +
            "var sx=w/(mxx-mnx),sy=h/(mxy-mny),cx=(mnx+mxx)/2,cy=(mny+mxy)/2,r=t*Math.cos(Math.PI/S),d=r*Math.tan(Math.PI/S),k=4/3*Math.tan(Math.PI/S/2)*r,P=[],I=[],O=[];" +
            "function pt(p){return [(p[0]-cx)*sx+" + ox + ",(p[1]-cy)*sy+" + oy + "];}function vc(p){return [p[0]*sx,p[1]*sy];}" +
            "for(i=0;i<S;i++){var A=V[(i+S-1)%S],B=V[i],N=V[(i+1)%S],L=Math.sqrt((A[0]-B[0])*(A[0]-B[0])+(A[1]-B[1])*(A[1]-B[1])),ua=[(A[0]-B[0])/L,(A[1]-B[1])/L],ub=[(N[0]-B[0])/L,(N[1]-B[1])/L];" +
            "if(r<=0){P.push(pt(B));I.push([0,0]);O.push([0,0]);continue;}" +
            "P.push(pt([B[0]+ua[0]*d,B[1]+ua[1]*d]));I.push([0,0]);O.push(vc([-ua[0]*k,-ua[1]*k]));" +
            "P.push(pt([B[0]+ub[0]*d,B[1]+ub[1]*d]));I.push(vc([-ub[0]*k,-ub[1]*k]));O.push([0,0]);}createPath(P,I,O,true)";
    }

    // The card group's outline in a shape layer follows the controls: rect size and roundness, ellipse size or the polygon path.
    function orbitLiveShape(l, kind, F, wE, hE) {
        var g = acP(l, ["ADBE Root Vectors Group", 1, "ADBE Vectors Group"]), p;
        try {
            if (kind === "rect") {
                g.property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size").expression = "[" + wE + "," + hE + "]";
                g.property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Roundness").expression = "Math.max(0,Math.min(1," + F.t + "))*Math.min(" + wE + "," + hE + ")/2";
            } else if (kind === "circle") {
                g.property("ADBE Vector Shape - Ellipse").property("ADBE Vector Ellipse Size").expression = "[" + wE + "," + hE + "]";
            } else {
                p = g.property("ADBE Vector Shape - Group").property("ADBE Vector Shape");
                p.expression = orbitPathExpr(kind, wE, hE, F.t, 0, 0);
            }
        } catch (e0) {}
    }

    function orbitExpr(l, name, e) { try { acP(l, ["ADBE Transform Group", name]).expression = e; } catch (e0) {} }

    // ---- Maketi: change what was made. Every layer a Maketi block makes carries a tag in its comment:
    // "Sayframe|kind|gid|role|transform|state". role: main (holds the block's settings), part, keep (the user's
    // own layer the block was used on: a text, a drawn line, a shape). transform: the layer's transform as it
    // was made, so a change can tell what the user moved afterwards; for a keep layer, "on"/"off" (was it on).
    var MK_TAG = "Sayframe|";
    var MK_TR = ["ADBE Anchor Point", "ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Position_2", "ADBE Scale",
        "ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z", "ADBE Opacity"];
    // While a block is rebuilt: its old precomps by name, reused so whatever was put inside them stays.
    var mkReuse = null;

    function mkTagOf(L) {
        var c = "", p;
        try { c = String(L.comment || ""); } catch (e) { return null; }
        if (c.indexOf(MK_TAG) !== 0) { return null; }
        p = c.split("|");
        if (p.length < 4) { return null; }
        return { kind: p[1], gid: p[2], role: p[3], tr: p[4] || "", state: p.length > 5 ? p.slice(5).join("|") : "" };
    }
    function mkAll(comp) { var out = [], i; for (i = 1; i <= comp.numLayers; i++) { out.push(comp.layer(i)); } return out; }
    function mkIdOf(L) { var v; try { v = L.id; } catch (e) { v = undefined; } return v === undefined || v === null ? null : String(v); }
    function mkVal(v) {
        var out = [], i;
        if (typeof v === "number") { return String(Math.round(v * 10000) / 10000); }
        if (v && typeof v.length === "number") { for (i = 0; i < v.length; i++) { out.push(Math.round(Number(v[i]) * 10000) / 10000); } return out.join(","); }
        return "";
    }
    function mkTrOf(L) {
        var out = [], i, P;
        for (i = 0; i < MK_TR.length; i++) {
            try { P = acTransform(L, MK_TR[i]); } catch (e) { P = null; }
            if (!P) { continue; }
            // Keys the block made itself (an appear animation) are written as their times: "@0.5/0.8".
            try { out.push(MK_TR[i] + "=" + (P.numKeys > 0 ? mkKeySig(P) : mkVal(P.value))); } catch (e2) {}
        }
        try { out.push("st=" + mkVal(L.startTime)); } catch (e3) {}
        return out.join(";");
    }
    function mkKeySig(P) {
        var t = [], j;
        for (j = 1; j <= P.numKeys; j++) { t.push(Math.round(P.keyTime(j) * 1000) / 1000); }
        return "@" + t.join("/");
    }
    function mkTrParse(s) {
        var out = {}, a = String(s || "").split(";"), i, k;
        for (i = 0; i < a.length; i++) { k = a[i].indexOf("="); if (k > 0) { out[a[i].slice(0, k)] = a[i].slice(k + 1); } }
        return out;
    }
    // What the user changed on a made layer: keys, or a value other than the one the block set.
    function mkCarryOf(L, tag) {
        var made = mkTrParse(tag.tr), out = { props: [], dt: 0 }, i, P, j, keys, k;
        for (i = 0; i < MK_TR.length; i++) {
            try { P = acTransform(L, MK_TR[i]); } catch (e) { P = null; }
            if (!P) { continue; }
            try {
                // The block's own keys, untouched by the user: the new build makes its own.
                if (P.numKeys > 0 && made[MK_TR[i]] === mkKeySig(P)) { continue; }
                if (P.numKeys > 0) {
                    keys = [];
                    for (j = 1; j <= P.numKeys; j++) {
                        k = { t: P.keyTime(j), v: P.keyValue(j) };
                        try { k.ii = P.keyInInterpolationType(j); k.oi = P.keyOutInterpolationType(j); } catch (eI) {}
                        try { k.ie = P.keyInTemporalEase(j); k.oe = P.keyOutTemporalEase(j); } catch (eE) {}
                        keys.push(k);
                    }
                    out.props.push({ mn: MK_TR[i], keys: keys });
                } else if (made[MK_TR[i]] !== undefined && mkVal(P.value) !== made[MK_TR[i]]) {
                    out.props.push({ mn: MK_TR[i], value: P.value });
                }
            } catch (e2) {}
        }
        try { if (made.st !== undefined) { out.dt = Number(L.startTime) - Number(made.st); } } catch (e3) {}
        try { out.sep = acTransform(L, "ADBE Position").dimensionsSeparated; } catch (e4) {}
        return out;
    }
    function mkCarryTo(L, c) {
        var i, j, P, d, k;
        if (c.sep) { try { acTransform(L, "ADBE Position").dimensionsSeparated = true; } catch (eS) {} }
        for (i = 0; i < c.props.length; i++) {
            d = c.props[i];
            try { P = acTransform(L, d.mn); } catch (e) { P = null; }
            if (!P) { continue; }
            try {
                if (d.keys) {
                    while (P.numKeys > 0) { P.removeKey(1); }
                    for (j = 0; j < d.keys.length; j++) { P.setValueAtTime(d.keys[j].t, d.keys[j].v); }
                    for (j = 0; j < d.keys.length; j++) {
                        k = P.nearestKeyIndex ? P.nearestKeyIndex(d.keys[j].t) : j + 1;
                        try { if (d.keys[j].ii !== undefined) { P.setInterpolationTypeAtKey(k, d.keys[j].ii, d.keys[j].oi); } } catch (eI) {}
                        try { if (d.keys[j].ie) { P.setTemporalEaseAtKey(k, d.keys[j].ie, d.keys[j].oe); } } catch (eE) {}
                    }
                } else {
                    if (P.numKeys > 0) { continue; }
                    P.setValue(d.value);
                }
            } catch (e2) {}
        }
        if (c.dt) { try { L.startTime = Number(L.startTime) + c.dt; } catch (eT) {} }
    }
    function mkGroupOf(comp, gid) {
        var all = mkAll(comp), out = { made: [], keep: [], main: null, top: -1 }, i, t;
        for (i = 0; i < all.length; i++) {
            t = mkTagOf(all[i]);
            if (!t || t.gid !== gid) { continue; }
            if (t.role === "keep") { out.keep.push({ L: all[i], tag: t }); continue; }
            out.made.push({ L: all[i], tag: t });
            if (t.role === "main") { out.main = { L: all[i], tag: t }; }
            if (out.top < 0) { out.top = i; }
        }
        return out;
    }
    function mkNewGid() { return "g" + new Date().getTime().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

    // A precomp for a Maketi block: on a rebuild the old one of that name comes back with what was put inside.
    function mkShiftAll(c, dx, dy) {
        var j, L, P, k, v, sh = function (a) { var o = [Number(a[0]) + dx, Number(a[1]) + dy]; if (a.length > 2) { o.push(a[2]); } return o; };
        for (j = 1; j <= c.numLayers; j++) {
            L = c.layer(j);
            try {
                if (L.parent) { continue; }
                P = acTransform(L, "ADBE Position");
                if (!P || P.dimensionsSeparated) { continue; }
                if (P.numKeys > 0) {
                    for (k = 1; k <= P.numKeys; k++) { v = P.keyValue(k); P.setValueAtKey(k, sh(v)); }
                } else {
                    P.setValue(sh(P.value));
                }
            } catch (e) {}
        }
    }
    function mkComp(name, w, h, par, dur, fps) {
        var c = mkReuse && mkReuse.comps[name], dx, dy;
        if (c) {
            delete mkReuse.comps[name];
            mkReuse.used.push(c);
            dx = (w - c.width) / 2; dy = (h - c.height) / 2;
            try { if (c.width !== w) { c.width = w; } if (c.height !== h) { c.height = h; } } catch (e) {}
            // A new size: everything inside moves with the middle, so a photo put in stays centred.
            if (dx || dy) { mkShiftAll(c, dx, dy); }
            return c;
        }
        return app.project.items.addComp(name, w, h, par, dur, fps);
    }
    function mkReused(c) { var i; if (!mkReuse) { return false; } for (i = 0; i < mkReuse.used.length; i++) { if (mkReuse.used[i] === c) { return true; } } return false; }
    function mkFolder(name) {
        if (mkReuse && mkReuse.folder) { return mkReuse.folder; }
        return app.project.items.addFolder(name);
    }

    // Runs a Maketi build; mk = { gid, state }. With a gid it first takes the old build away (keeping the user's
    // own layers, the precomps' contents and whatever the user moved or animated), then builds in its place.
    // opt.keepSel: the block works on the selected layers (they are the user's, not the block's).
    // opt.cleanKeep(L): undoes on such a layer what the build put on it, before it is built again.
    function mkWrap(comp, kind, mk, build, opt) {
        var gid = mk && mk.gid ? String(mk.gid) : "", state = mk && mk.state ? String(mk.state).replace(/[\r\n|]/g, " ") : "";
        var old = null, carry = {}, above = null, before = {}, all, made = [], keep = [], res, i, j, L, t, id, main = null, sel, wasOn = [], src, nm;
        opt = opt || {};
        if (!mk) { return build(); }
        if (gid) {
            old = mkGroupOf(comp, gid);
            if (!old.made.length) { throw new Error("MK_GONE"); }
            all = mkAll(comp);
            if (old.top > 0 && !mkTagOf(all[old.top - 1])) { above = all[old.top - 1]; }
            mkReuse = { comps: {}, used: [], folder: null };
            for (i = 0; i < old.made.length; i++) {
                L = old.made[i].L;
                carry[L.name] = mkCarryOf(L, old.made[i].tag);
                try {
                    src = L.source;
                    if (src && typeof CompItem !== "undefined" && src instanceof CompItem) {
                        mkReuse.comps[src.name] = src;
                        if (!mkReuse.folder && src.parentFolder && src.parentFolder !== app.project.rootFolder) { mkReuse.folder = src.parentFolder; }
                    }
                } catch (eS) {}
            }
            for (i = 0; i < all.length; i++) { try { all[i].selected = false; } catch (eD) {} }
            for (i = 0; i < old.made.length; i++) {
                L = old.made[i].L;
                try { L.locked = false; } catch (eL) {}
                L.remove();
            }
            for (i = 0; i < old.keep.length; i++) {
                L = old.keep[i].L;
                try { L.enabled = old.keep[i].tag.tr !== "off"; } catch (eE) {}
                if (opt.cleanKeep) { try { opt.cleanKeep(L); } catch (eC) {} }
                try { L.selected = true; } catch (eK) {}
            }
        } else {
            gid = mkNewGid();
        }
        all = mkAll(comp);
        sel = comp.selectedLayers || [];
        // Layer ids (After Effects 22+) tell the new layers from the old ones; without them nothing is tagged.
        if (all.length && mkIdOf(all[0]) === null) { mkReuse = null; return build(); }
        for (i = 0; i < all.length; i++) { id = mkIdOf(all[i]); if (id !== null) { before[id] = true; } }
        for (i = 0; opt.keepSel && i < sel.length; i++) { if (opt.keepSel === true || opt.keepSel(sel[i])) { wasOn.push({ L: sel[i], on: sel[i].enabled !== false }); } }
        try {
            res = build();
        } finally {
            if (mkReuse) {
                // Precomps of the old build nothing uses any more (fewer cards): gone, unless something was put inside.
                for (nm in mkReuse.comps) {
                    if (mkReuse.comps.hasOwnProperty(nm)) {
                        try { if (!mkReuse.comps[nm].usedIn.length && mkReuse.comps[nm].numLayers <= 2) { mkReuse.comps[nm].remove(); } } catch (eR) {}
                    }
                }
            }
            mkReuse = null;
        }
        all = mkAll(comp);
        if (all.length && mkIdOf(all[0]) === null) { return res; }
        for (i = 0; i < all.length; i++) {
            id = mkIdOf(all[i]);
            if (!before[id]) { made.push(all[i]); }
        }
        for (i = 0; i < wasOn.length; i++) { keep.push(wasOn[i]); }
        // A text the block made for itself (no text was selected) is the user's from now on: it is kept too.
        if (opt.keepNames) {
            for (i = made.length - 1; i >= 0; i--) {
                for (j = 0; j < opt.keepNames.length; j++) {
                    if (made[i].name === opt.keepNames[j]) { keep.push({ L: made[i], on: true }); made.splice(i, 1); break; }
                }
            }
        }
        for (i = 0; i < made.length && !main; i++) { try { if (made[i].selected && !made[i].adjustmentLayer) { main = made[i]; } } catch (eM) {} }
        for (i = 0; i < made.length && !main; i++) { try { if (!made[i].parent && !made[i].adjustmentLayer) { main = made[i]; } } catch (eM2) {} }
        if (!main && made.length) { main = made[0]; }
        for (i = 0; i < made.length; i++) {
            L = made[i];
            if (carry[L.name]) { mkCarryTo(L, carry[L.name]); }
            try { L.comment = MK_TAG + kind + "|" + gid + "|" + (L === main ? "main" : "part") + "|" + mkTrOf(L) + "|" + (L === main ? state : ""); } catch (eT) {}
        }
        for (i = 0; i < keep.length; i++) {
            t = mkTagOf(keep[i].L);
            try { keep[i].L.comment = MK_TAG + kind + "|" + gid + "|keep|" + (t && t.gid === gid ? t.tr : (keep[i].on ? "on" : "off")) + "|"; } catch (eK2) {}
        }
        // Back to where the old build stood in the layer stack, in the same order.
        if (above && !keep.length) {
            for (i = made.length - 1; i >= 0; i--) { try { made[i].moveAfter(above); } catch (eO) {} }
        }
        if (res && typeof res === "object") { res.mk = { gid: gid, name: main ? main.name : "", kind: kind }; }
        return res;
    }

    function orbitBuild(comp, o, labels) {
        var n = Math.round(orbitNum(o.count, 2, 36, 8)), layout = ORBIT_LAYOUTS[o.layout] ? o.layout : "ring";
        var kind = ORBIT_SIDES.hasOwnProperty(o.shape) ? o.shape : "rect", t = orbitNum(o.corners, 0, 100, 20) / 100;
        var radius = orbitNum(o.radius, 0, 10000, 600), w = Math.round(orbitNum(o.w, 4, 8000, 400)), h = Math.round(orbitNum(o.h, 4, 8000, 560));
        var pre = o.mode !== "shape", cx = comp.width / 2, cy = comp.height / 2, fs = Math.round(Math.min(w, h) * 0.32);
        var ctrl, cam = "", had = false, cards = [], nums = [], backs = [], bk, i, j, sp, L, txt, cc, inner, folder = null, base, camL, rig = null;
        var showBack = o.back !== false, ctrlName = labels.ctrl || "Carousel Control", F, Fin, an, sx, face, k;
        // A few spare cards past the chosen count, hidden: the "Cards" control can show them later without building again.
        var nAll = Math.min(36, Math.max(n, 12));
        base = labels.card || "Card ";
        var spots = [];
        if (pre) {
            try { folder = mkFolder(labels.folder || "Carousel"); } catch (eF) { folder = null; }
        }
        F = orbitFx(ctrlName, labels);
        Fin = orbitFx(ctrlName, labels);
        for (k in Fin) { if (Fin.hasOwnProperty(k)) { Fin[k] = Fin[k].replace("thisComp.layer(", "comp(" + tbQ(comp.name) + ").layer("); } }
        for (i = nAll - 1; i >= 0; i--) {
            sp = orbitSpot(i, i < n ? n : nAll, layout, radius, h);
            if (i < n) { spots.push(sp); }
            if (pre) {
                cc = mkComp(base + (i + 1), w, h, comp.pixelAspect || 1, comp.duration, comp.frameRate);
                if (folder) { try { cc.parentFolder = folder; } catch (eP) {} }
                if (!mkReused(cc)) {
                inner = cc.layers.addShape();
                inner.name = labels.shape || "Shape";
                orbitCardShape(inner, kind, t, w, h, orbitColor(i));
                orbitLiveShape(inner, kind, Fin, String(w), String(h));
                orbitSet(inner, "ADBE Position", [w / 2, h / 2]);
                }
                if (o.numbers && !mkReused(cc)) {
                    txt = orbitNumber(cc, String(i + 1), fs);
                    orbitSet(txt, "ADBE Position", [w / 2, h / 2 + fs * 0.35]);
                }
                L = comp.layers.add(cc);
                // Whatever is put inside the card comp (a photo, a video) gets the card's own shape and corners.
                orbitCardMask(L, kind, t, w, h);
                try { acP(L, ["ADBE Mask Parade", 1, "ADBE Mask Shape"]).expression = orbitPathExpr(kind, w, h, F.t, w / 2, h / 2); } catch (eMx) {}
            } else {
                L = comp.layers.addShape();
                orbitCardShape(L, kind, t, w, h, orbitColor(i));
                orbitLiveShape(L, kind, F, F.w, F.h);
            }
            L.name = base + (i + 1);
            L.threeDLayer = true;
            orbitSet(L, "ADBE Position", [cx + sp.x, cy + sp.y, sp.z]);
            orbitSet(L, "ADBE Rotate Y", sp.ry);
            cards.unshift(L);
            if (pre) {
                // From behind a card shows only its back: a Fill effect on the card itself paints it plain, in the card's colour,
                // when it faces away (the "Back visible" checkbox decides). No extra layer.
                bk = null;
                try {
                    bk = L.property("ADBE Effect Parade").addProperty("ADBE Fill");
                    bk.name = labels.backFx || "Back side";
                    bk.property("ADBE Fill-0002").setValue(o.backColor && o.backColor.length === 3 ? [Number(o.backColor[0]), Number(o.backColor[1]), Number(o.backColor[2])] : orbitColor(i));
                } catch (eBk) { bk = null; }
                backs.unshift(bk);
            } else {
                backs.unshift(null);
            }
            if (o.numbers && !pre) {
                txt = orbitNumber(comp, String(i + 1), fs);
                txt.name = (labels.number || "Number ") + (i + 1);
                txt.threeDLayer = true;
                orbitSet(txt, "ADBE Position", [cx + sp.x, cy + sp.y + fs * 0.35, sp.z]);
                orbitSet(txt, "ADBE Rotate Y", sp.ry);
                nums.unshift(txt);
            }
        }
        ctrl = comp.layers.addNull(comp.duration);
        ctrl.name = ctrlName;
        ctrl.threeDLayer = true;
        orbitSet(ctrl, "ADBE Position", [cx, cy, 0]);
        kitControl(ctrl, "ADBE Slider Control", labels.fxCount || "Cards", n);
        kitControl(ctrl, "ADBE Slider Control", labels.fxRadius || "Radius", radius);
        kitControl(ctrl, "ADBE Slider Control", labels.fxW || "Width", w);
        kitControl(ctrl, "ADBE Slider Control", labels.fxH || "Height", h);
        kitControl(ctrl, "ADBE Slider Control", labels.fxCorners || "Corners %", Math.round(t * 100));
        if (labels.fxBack) { kitControl(ctrl, "ADBE Checkbox Control", labels.fxBack, showBack ? 1 : 0); }
        an = [0, 0, 0];
        try { an = acP(ctrl, ["ADBE Transform Group", "ADBE Anchor Point"]).value; } catch (eA) {}
        an = [Number(an && an[0]) || 0, Number(an && an[1]) || 0, Number(an && an[2]) || 0];
        face = "thisLayer.toCompVec([0,0,1])[2]>0";
        for (i = 0; i < cards.length; i++) {
            if (nums[i]) { nums[i].parent = cards[i]; }
            cards[i].parent = ctrl;
            sx = orbitSpotExpr(F, i, layout);
            orbitExpr(cards[i], "ADBE Position", sx + "var q=degreesToRadians(a);[R*Math.sin(q)+" + an[0] + ",y+" + an[1] + ",-R*Math.cos(q)+" + an[2] + "]");
            orbitExpr(cards[i], "ADBE Rotate Y", sx + "a===0?0:-a");
            if (pre) {
                orbitExpr(cards[i], "ADBE Scale", "[" + F.w + "/" + w + "*100," + F.h + "/" + h + "*100,100]");
                orbitExpr(cards[i], "ADBE Opacity", "var n=Math.max(1,Math.round(" + F.n + "));" + i + "<n?value:0");
                if (backs[i]) { try { backs[i].property("ADBE Fill-0005").expression = (labels.fxBack ? F.b + "!=1&&" : "") + "!(" + face + ")?value:0"; } catch (eBx) {} }
            } else {
                orbitExpr(cards[i], "ADBE Opacity", "var n=Math.max(1,Math.round(" + F.n + "));" + i + "<n?value:0");
            }
            if (nums[i]) { orbitExpr(nums[i], "ADBE Opacity", "var n=Math.max(1,Math.round(" + F.n + "));" + i + "<n&&(" + F.b + "==1||" + face + ")?value:0"); }
        }
        if (o.camera) {
            for (j = 1; j <= comp.numLayers; j++) { if (comp.layer(j) instanceof CameraLayer) { had = true; break; } }
            if (!had) {
                // The camera hangs on its own 3D null in the middle: turn or move the null to fly around the carousel.
                camL = comp.layers.addCamera(labels.camera || "Carousel Camera", [cx, cy]);
                cam = camL.name;
                orbitFrame(comp, camL, spots, w, h, cx, cy);
                rig = comp.layers.addNull(comp.duration);
                rig.name = labels.camRig || "Camera Control";
                rig.threeDLayer = true;
                orbitSet(rig, "ADBE Position", [cx, cy, 0]);
                camL.parent = rig;
                try { rig.selected = false; camL.selected = false; } catch (eC) {}
            }
        }
        for (i = 0; i < cards.length; i++) { try { cards[i].selected = false; } catch (eS) {} }
        for (i = 0; i < nums.length; i++) { try { nums[i].selected = false; } catch (eT) {} }
        ctrl.selected = true;
        return { cards: n, spare: nAll - n, layout: layout, shape: kind, ctrl: ctrl.name, camera: cam, camRig: rig ? rig.name : "", hadCamera: had, precomp: pre, folder: folder ? folder.name : "" };
    }

    // ---- Grid (section "Layouts"): a bento grid of rounded tiles. rows x cols cells; with "rand" some
    // neighbouring cells merge into bigger tiles. The same seed always gives the same layout (the panel
    // draws its preview with the very same code), so what is in the preview is what gets built.
    // Math.imul is not in ExtendScript (ES3): the same 32-bit multiply by halves.
    function gridImul(a, b) {
        var ah = (a >>> 16) & 0xffff, al = a & 0xffff, bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
        return ((al * bl) + ((((ah * bl + al * bh) & 0xffff) << 16) >>> 0)) | 0;
    }

    function gridRng(seed) {
        var a = Math.floor(Number(seed) || 0) >>> 0;
        return function () {
            var t;
            a = (a + 0x6D2B79F5) >>> 0;
            t = a;
            t = gridImul(t ^ (t >>> 15), t | 1);
            t ^= t + gridImul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function gridLayout(rows, cols, rand, seed) {
        var rng = gridRng(seed), occ = [], boxes = [], r, c, w, h, i, j, free, p = Math.max(0, Math.min(100, rand)) / 100;
        var maxW = Math.max(1, Math.min(cols, 1 + Math.round(p * 2))), maxH = Math.max(1, Math.min(rows, 1 + Math.round(p)));
        for (r = 0; r < rows; r++) { occ.push([]); for (c = 0; c < cols; c++) { occ[r].push(false); } }
        function clear(r0, c0, ww, hh) {
            var y, x;
            if (r0 + hh > rows || c0 + ww > cols) { return false; }
            for (y = r0; y < r0 + hh; y++) { for (x = c0; x < c0 + ww; x++) { if (occ[y][x]) { return false; } } }
            return true;
        }
        for (r = 0; r < rows; r++) {
            for (c = 0; c < cols; c++) {
                if (occ[r][c]) { continue; }
                w = 1; h = 1;
                if (rng() < p * 0.6) { w = 1 + Math.floor(rng() * maxW); h = 1 + Math.floor(rng() * maxH); }
                while (w > 1 && !clear(r, c, w, 1)) { w--; }
                while (h > 1 && !clear(r, c, w, h)) { h--; }
                for (i = r; i < r + h; i++) { for (j = c; j < c + w; j++) { occ[i][j] = true; } }
                free = { r: r, c: c, w: w, h: h };
                boxes.push(free);
            }
        }
        return boxes;
    }

    function gridColor(i) {
        var hue = (250 + i * 9) % 360, s = 0.75, l = 0.6, c = (1 - Math.abs(2 * l - 1)) * s, hp = hue / 60;
        var x = c * (1 - Math.abs(hp % 2 - 1)), m = l - c / 2, rgb;
        if (hp < 1) { rgb = [c, x, 0]; } else if (hp < 2) { rgb = [x, c, 0]; } else if (hp < 3) { rgb = [0, c, x]; }
        else if (hp < 4) { rgb = [0, x, c]; } else if (hp < 5) { rgb = [x, 0, c]; } else { rgb = [c, 0, x]; }
        return [rgb[0] + m, rgb[1] + m, rgb[2] + m, 1];
    }

    function gridTileShape(l, w, h, round, color) {
        var gi = acGroup(l), si;
        try { acP(l, ["ADBE Root Vectors Group", gi]).name = "Tile"; } catch (e0) {}
        si = acIn(l, gi, "ADBE Vector Shape - Rect");
        acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Rect Size"]).setValue([w, h]);
        acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Rect Roundness"]).setValue(Math.min(round, Math.min(w, h) / 2));
        acFill(l, gi, color);
    }

    // ---- Grid tiles coming in and going out. The same code is in panel.js (the preview) and in host.jsx (the keys),
    // so the preview shows what the comp gets. o: a tile (c, r: its middle in cells; C, R: the grid; i, n: its number;
    // r1..r3, side: its own random numbers; px, py: its middle, cx, cy: the grid's middle, S: the grid's size, h: its height).
    var GRFX_WOW = ["explode", "assemble", "domino", "tetris", "spiral", "jelly", "puzzle", "glitch", "deal", "flip3d", "zoom", "snake"];
    var GRFX_SIMPLE = ["none", "seq", "up", "wave", "center", "rand", "flip", "spring", "wipe", "blur", "drop", "spin"];
    // These only ease in one go: two keys are enough. The rest overshoot or bounce: a key every second frame.
    var GRFX_SMOOTH = { seq: 1, up: 1, center: 1, wipe: 1, blur: 1, spin: 1, zoom: 1, flip: 1, deal: 1 };
    function grfxEz(x) { return 1 - Math.pow(1 - x, 3); }
    function grfxBack(x) { var c = 2.2; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); }
    function grfxBounce(x) {
        var n = 7.5625, d = 2.75;
        if (x < 1 / d) { return n * x * x; }
        if (x < 2 / d) { x -= 1.5 / d; return n * x * x + 0.75; }
        if (x < 2.5 / d) { x -= 2.25 / d; return n * x * x + 0.9375; }
        x -= 2.625 / d;
        return n * x * x + 0.984375;
    }
    function grfxCap(v) { return Math.max(0, Math.min(1, v)); }
    // Which tile comes first: the smaller, the earlier.
    function grfxOrd(fx, o) {
        var C = o.C, R = o.R, cc, rr, ring;
        switch (fx) {
        case "up": return (R - o.r) / R;
        case "wave": case "flip3d": return (o.c + o.r) / (C + R);
        case "center": case "zoom": return Math.sqrt(Math.pow(o.c - C / 2, 2) + Math.pow((o.r - R / 2) * 1.2, 2));
        case "assemble": return -Math.sqrt(Math.pow(o.c - C / 2, 2) + Math.pow(o.r - R / 2, 2));
        case "rand": case "explode": case "glitch": case "puzzle": return o.r1;
        case "flip": case "wipe": return o.c / C;
        case "drop": return o.r / R;
        case "tetris": return ((R - o.r) / R) * 0.6 + (o.c / C) * 0.4;
        case "spiral":
            cc = Math.floor(o.c); rr = Math.floor(o.r); ring = Math.min(cc, rr, C - 1 - cc, R - 1 - rr);
            return ring + (Math.atan2(rr - R / 2, cc - C / 2) + Math.PI) / (2 * Math.PI);
        case "snake": rr = Math.floor(o.r); return rr * C + (rr % 2 ? C - o.c : o.c);
        case "jelly": return o.r2 * 0.4 + (o.c / C) * 0.6;
        default: return o.i;
        }
    }
    // Each tile's delay: its place in the order times the step.
    function grfxDelays(fx, os, step) {
        var idx = [], d = [], i;
        for (i = 0; i < os.length; i++) { idx.push(i); d.push(0); }
        idx.sort(function (a, b) { var x = grfxOrd(fx, os[a]) - grfxOrd(fx, os[b]); return Math.abs(x) > 1e-9 ? x : a - b; });
        for (i = 0; i < idx.length; i++) { d[idx[i]] = i * step; }
        return d;
    }
    // How a tile looks at p (0 not there yet, 1 in its place): offsets, scale, turns (degrees), opacity 0..1, blur in px, wipe 0..1 hidden.
    function grfxAt(fx, p, o) {
        var e = grfxEz(p), S = o.S, f = { x: 0, y: 0, z: 0, sx: 1, sy: 1, rz: 0, rx: 0, ry: 0, op: 1, blur: 0, wipe: 0 }, b, w, d, k, a;
        switch (fx) {
        case "none": f.op = p > 0 ? 1 : 0; break;
        case "seq": f.op = e; f.sx = f.sy = 0.6 + 0.4 * e; break;
        case "up": f.op = e; f.y = (1 - e) * S * 0.12; break;
        case "wave": f.op = grfxCap(p * 2); f.sx = f.sy = grfxBack(p); break;
        case "center": f.op = grfxCap(p * 3); f.sx = f.sy = e; break;
        case "rand": f.op = grfxCap(p * 3); f.sx = f.sy = grfxBack(p); break;
        case "flip": f.op = p > 0 ? 1 : 0; f.ry = (1 - e) * 90; break;
        case "spring": f.op = grfxCap(p * 4); f.sx = f.sy = p <= 0 ? 0 : 1 - Math.cos(p * Math.PI * 2.5) * Math.exp(-p * 4); break;
        case "wipe": f.wipe = 1 - e; break;
        case "blur": f.op = e; f.blur = (1 - e) * S * 0.03; f.sx = f.sy = 1.15 - 0.15 * e; break;
        case "drop": f.op = grfxCap(p * 4); f.y = -(1 - grfxBounce(p)) * S * 0.35; break;
        case "spin": f.op = e; f.rz = (1 - e) * -180; f.sx = f.sy = e; break;
        case "explode":
            b = grfxBack(p); f.op = grfxCap(p * 3);
            f.x = (1 - b) * (o.r1 - 0.5) * S * 1.6; f.y = (1 - b) * (o.r2 - 0.5) * S * 1.2; f.rz = (1 - b) * (o.r3 - 0.5) * 540; f.sx = f.sy = 0.4 + 0.6 * b;
            break;
        case "assemble":
            b = grfxBack(p); f.op = grfxCap(p * 4);
            f.x = (1 - b) * (o.cx - o.px); f.y = (1 - b) * (o.cy - o.py); f.sx = f.sy = 0.15 + 0.85 * b;
            break;
        case "domino":
            // Falls forward round its top edge.
            f.op = p > 0 ? 1 : 0; f.rx = (1 - grfxBounce(p)) * -110; a = f.rx * Math.PI / 180;
            f.y = o.h / 2 * (Math.cos(a) - 1); f.z = o.h / 2 * Math.sin(a);
            break;
        case "tetris": f.op = p > 0 ? 1 : 0; f.y = -(1 - grfxBounce(p)) * S * 0.6; break;
        case "spiral": f.op = grfxCap(p * 3); f.rz = (1 - e) * 180; f.sx = f.sy = grfxBack(p); break;
        case "jelly": w = Math.sin(p * 11) * Math.exp(-4 * p) * 0.45; f.op = grfxCap(p * 5); f.sx = e * (1 + w); f.sy = e * (1 - w); break;
        case "puzzle":
            d = (1 - grfxBack(p)) * S * 0.7; f.op = grfxCap(p * 3);
            f.x = [d, -d, 0, 0][o.side]; f.y = [0, 0, d, -d][o.side];
            break;
        case "glitch":
            if (p <= 0) { f.op = 0; break; }
            if (p < 0.7) { k = Math.floor(p * 30 + o.i * 3); f.op = k % 3 ? 1 : 0.15; f.x = ((k * 7) % 5 - 2) * S * 0.012; }
            break;
        case "deal":
            f.op = p > 0 ? 1 : 0;
            f.x = (1 - e) * (o.cx - S * 0.55 - o.px); f.y = (1 - e) * (o.cy + S * 0.45 - o.py); f.rz = (1 - e) * -70; f.sx = f.sy = 0.7 + 0.3 * e;
            break;
        case "flip3d": f.op = p > 0 ? 1 : 0; f.rx = (1 - grfxBack(p)) * -90; break;
        case "zoom": f.op = grfxCap(p * 2); f.sx = f.sy = 1 + (1 - e) * 2.2; f.blur = (1 - e) * S * 0.02; break;
        }
        return f;
    }
    // Each tile's own random numbers: the same variant number gives the same ones.
    function grfxTiles(os, seed) {
        var rng = gridRng((Math.floor(Number(seed) || 0) + 99) >>> 0), i;
        for (i = 0; i < os.length; i++) { os[i].r1 = rng(); os[i].r2 = rng(); os[i].r3 = rng(); os[i].side = Math.floor(rng() * 4); os[i].i = i; os[i].n = os.length; }
        return os;
    }

    // Keys for a tile coming in (mode "in": p 0 -> 1 from t0) or going out ("out": p 1 -> 0). Only what changes gets keys:
    // position, scale, the turns, opacity, a Gaussian blur, a linear wipe. it = { L, o, pos, sc }.
    function gridAnim(comp, it, fx, mode, t0, dur, labels, fxs) {
        var fr = comp.frameDuration || 1 / 30, smooth = GRFX_SMOOTH[fx] === 1, ns, k, q, times = [], F = [], L = it.L, d3, vals, P, ef, key;
        if (fx === "none" || !(dur > 0)) { return; }
        ns = smooth ? 1 : Math.max(2, Math.round(dur / fr / 2));
        for (k = 0; k <= ns; k++) {
            q = k / ns;
            times.push(t0 + q * dur);
            F.push(grfxAt(fx, mode === "in" ? q : 1 - q, it.o));
        }
        function moves(n, rest) { var j; for (j = 0; j < F.length; j++) { if (Math.abs(F[j][n] - rest) > 1e-6) { return true; } } return false; }
        function put(prop, fn) {
            var j, vv = [];
            if (!prop) { return; }
            for (j = 0; j < F.length; j++) { vv.push(fn(F[j])); }
            if (smooth) { acKeys(prop, times, vv, 70); return; }
            for (j = 0; j < times.length; j++) { prop.setValueAtKey(prop.addKey(times[j]), vv[j]); }
        }
        d3 = moves("z", 0) || moves("rx", 0) || moves("ry", 0);
        if (d3 && !L.threeDLayer) { L.threeDLayer = true; }
        if (moves("x", 0) || moves("y", 0) || moves("z", 0)) {
            put(acTransform(L, "ADBE Position"), function (f) { return d3 || L.threeDLayer ? [it.pos[0] + f.x, it.pos[1] + f.y, (it.pos[2] || 0) + f.z] : [it.pos[0] + f.x, it.pos[1] + f.y]; });
        }
        if (moves("sx", 1) || moves("sy", 1)) { put(acTransform(L, "ADBE Scale"), function (f) { return [it.sc * f.sx, it.sc * f.sy, 100]; }); }
        if (moves("rz", 0)) { put(acTransform(L, "ADBE Rotate Z"), function (f) { return f.rz; }); }
        if (moves("rx", 0)) { put(acTransform(L, "ADBE Rotate X"), function (f) { return f.rx; }); }
        if (moves("ry", 0)) { put(acTransform(L, "ADBE Rotate Y"), function (f) { return f.ry; }); }
        if (moves("op", 1)) { put(acTransform(L, "ADBE Opacity"), function (f) { return f.op * 100; }); }
        // The effects are added once per tile, the second mode (in, then out) keys the same one.
        for (key in { blur: 1, wipe: 1 }) {
            if (!moves(key, 0)) { continue; }
            ef = fxs[key];
            if (!ef) {
                try {
                    ef = L.property("ADBE Effect Parade").addProperty(key === "blur" ? "ADBE Gaussian Blur 2" : "ADBE Linear Wipe");
                    ef.name = key === "blur" ? (labels.fxBlur || "Blur") : (labels.fxWipe || "Wipe");
                    if (key === "wipe") { try { ef.property("ADBE Linear Wipe-0002").setValue(270); } catch (eA) {} }
                    if (key === "blur") { try { ef.property("ADBE Gaussian Blur 2-0003").setValue(1); } catch (eR) {} }
                    fxs[key] = ef;
                } catch (eF) { ef = null; }
            }
            if (!ef) { continue; }
            try {
                P = ef.property(key === "blur" ? "ADBE Gaussian Blur 2-0001" : "ADBE Linear Wipe-0001");
                put(P, key === "blur" ? function (f) { return f.blur; } : function (f) { return f.wipe * 100; });
            } catch (eP) {}
        }
    }

    // A tile comp has a standard size by the tile's shape: square-ish 1000x1000, wide 1920x1080, tall 1080x1920.
    // A tile comp used again at another size: its own coloured shape fills the new size, its number sits in the middle.
    function gridRefit(cc, shapeName, std, num) {
        var j, L, P, doc, k = Math.round(Math.min(std[0], std[1]) * 0.28);
        for (j = 1; j <= cc.numLayers; j++) {
            L = cc.layer(j);
            try {
                if (L.name === shapeName) {
                    acP(L, ["ADBE Root Vectors Group", 1, "ADBE Vectors Group", 1, "ADBE Vector Rect Size"]).setValue([std[0], std[1]]);
                    orbitSet(L, "ADBE Position", [std[0] / 2, std[1] / 2]);
                    continue;
                }
                P = acP(L, ["ADBE Text Properties", "ADBE Text Document"]);
                if (num && P && String(P.value.text) === num) {
                    doc = P.value; doc.fontSize = k; P.setValue(doc);
                    orbitSet(L, "ADBE Position", [std[0] / 2, std[1] / 2 + k * 0.35]);
                }
            } catch (e) {}
        }
    }
    function gridStdSize(bw, bh) {
        var a = bw / bh;
        if (a > 1.25) { return [1920, 1080]; }
        if (a < 0.8) { return [1080, 1920]; }
        return [1000, 1000];
    }

    // A rounded rectangle as a mask path (centre cx,cy; corner radius r), clockwise from the top-left corner.
    function gridMaskShape(cx, cy, w, h, r) {
        var x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, k = 0.5523, s = new Shape(), c;
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        if (r < 0.01) {
            s.vertices = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            s.inTangents = s.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        } else {
            c = r * k;
            s.vertices = [[x0 + r, y0], [x1 - r, y0], [x1, y0 + r], [x1, y1 - r], [x1 - r, y1], [x0 + r, y1], [x0, y1 - r], [x0, y0 + r]];
            s.inTangents = [[-c, 0], [0, 0], [0, -c], [0, 0], [c, 0], [0, 0], [0, c], [0, 0]];
            s.outTangents = [[0, 0], [c, 0], [0, 0], [0, c], [0, 0], [-c, 0], [0, 0], [0, -c]];
        }
        s.closed = true;
        return s;
    }

    // The tile's own shape cuts the precomp layer: whatever is put inside (a photo, a video) gets the tile's corners.
    function gridMask(L, cw, ch, w, h, r) {
        var m = acAdd(L, ["ADBE Mask Parade"], "ADBE Mask Atom");
        try { acP(L, ["ADBE Mask Parade", m]).name = "Tile"; } catch (e0) {}
        acP(L, ["ADBE Mask Parade", m, "ADBE Mask Shape"]).setValue(gridMaskShape(cw / 2, ch / 2, w, h, r));
        return m;
    }

    function gridBuild(comp, o, labels) {
        var rows = Math.round(orbitNum(o.rows, 1, 20, 4)), cols = Math.round(orbitNum(o.cols, 1, 20, 5));
        var W = o.fit ? comp.width : Math.round(orbitNum(o.w, 16, 16000, 1920)), H = o.fit ? comp.height : Math.round(orbitNum(o.h, 16, 16000, 1080));
        var gx = orbitNum(o.gap, 0, 1000, 20), gy = o.split ? orbitNum(o.gapV, 0, 1000, 20) : gx, round = orbitNum(o.round, 0, 2000, 20);
        var boxes = gridLayout(rows, cols, orbitNum(o.rand, 0, 100, 100), o.seed), pre = o.mode === "precomp";
        var cw = (W - gx * (cols - 1)) / cols, ch = (H - gy * (rows - 1)) / rows, ox = (comp.width - W) / 2, oy = (comp.height - H) / 2;
        var tiles = [], nums = [], scales = [], geo = [], i, b, bw, bh, x, y, L, cc, inner, txt, folder = null, ctrl, fs, base = labels.tile || "Tile ", sc, std, k;
        var fxIn = o.appear || (o.stagger === false ? "none" : "seq"), fxOut = o.disappear || "none", dur = orbitNum(o.dur, 0.05, 5, 0.6), step = orbitNum(o.step, 0, 2, 0.05);
        var os = [], dIn, dOut, it, fxs, tIn, tOut, endIn, fr = comp.frameDuration || 1 / 30;
        if (cw < 1 || ch < 1) { throw new Error("GRID_TOO_TIGHT"); }
        if (pre) { try { folder = mkFolder(labels.folder || "Grid"); } catch (eF) { folder = null; } }
        for (i = boxes.length - 1; i >= 0; i--) {
            b = boxes[i];
            bw = Math.round(b.w * cw + (b.w - 1) * gx); bh = Math.round(b.h * ch + (b.h - 1) * gy);
            x = ox + b.c * (cw + gx) + bw / 2; y = oy + b.r * (ch + gy) + bh / 2;
            fs = Math.round(Math.max(12, Math.min(bw, bh) * 0.28));
            sc = 100;
            if (pre) {
                // A standard-size comp (1000x1000, 1920x1080 or 1080x1920) scaled to cover the tile; a mask in the
                // tile's shape cuts it, so a photo put inside gets the same rounded corners.
                std = gridStdSize(bw, bh);
                sc = Math.max(bw / std[0], bh / std[1]) * 100;
                cc = mkComp(base + (i + 1), std[0], std[1], comp.pixelAspect || 1, comp.duration, comp.frameRate);
                if (folder) { try { cc.parentFolder = folder; } catch (eP) {} }
                if (!mkReused(cc)) {
                inner = cc.layers.addShape();
                inner.name = labels.shape || "Shape";
                gridTileShape(inner, std[0], std[1], 0, gridColor(i));
                orbitSet(inner, "ADBE Position", [std[0] / 2, std[1] / 2]);
                }
                if (o.numbers && !mkReused(cc)) {
                    k = Math.round(Math.min(std[0], std[1]) * 0.28);
                    txt = orbitNumber(cc, String(i + 1), k);
                    orbitSet(txt, "ADBE Position", [std[0] / 2, std[1] / 2 + k * 0.35]);
                }
                if (mkReused(cc)) { gridRefit(cc, labels.shape || "Shape", std, o.numbers ? String(i + 1) : ""); }
                L = comp.layers.add(cc);
                orbitSet(L, "ADBE Scale", [sc, sc, 100]);
                gridMask(L, std[0], std[1], bw * 100 / sc, bh * 100 / sc, round * 100 / sc);
            } else {
                L = comp.layers.addShape();
                gridTileShape(L, bw, bh, round, gridColor(i));
            }
            L.name = base + (i + 1);
            orbitSet(L, "ADBE Position", [x, y]);
            tiles.unshift(L);
            scales.unshift(sc);
            geo.unshift({ c: b.c + b.w / 2, r: b.r + b.h / 2, C: cols, R: rows, px: x, py: y, cx: comp.width / 2, cy: comp.height / 2, S: Math.max(W, H), h: bh });
            if (o.numbers && !pre) {
                txt = orbitNumber(comp, String(i + 1), fs);
                txt.name = (labels.number || "Number ") + (i + 1);
                orbitSet(txt, "ADBE Position", [x, y + fs * 0.35]);
                nums.unshift(txt);
            }
        }
        ctrl = comp.layers.addNull(comp.duration);
        ctrl.name = labels.ctrl || "Grid Control";
        orbitSet(ctrl, "ADBE Position", [comp.width / 2, comp.height / 2]);
        for (i = 0; i < tiles.length; i++) {
            if (nums[i]) { nums[i].parent = tiles[i]; }
            tiles[i].parent = ctrl;
            try { tiles[i].selected = false; if (nums[i]) { nums[i].selected = false; } } catch (eS) {}
        }
        // In from the current time; out so that the last tile is gone at the end of the comp (never before all are in).
        grfxTiles(geo, o.seed);
        dIn = grfxDelays(fxIn, geo, step); dOut = grfxDelays(fxOut, geo, step);
        tIn = comp.time || 0;
        endIn = tIn + (fxIn === "none" ? 0 : dur + Math.max.apply(null, dIn.concat([0])));
        tOut = Math.max(endIn + 0.5, comp.duration - fr - dur - Math.max.apply(null, dOut.concat([0])));
        for (i = 0; i < tiles.length; i++) {
            it = { L: tiles[i], o: geo[i], sc: scales[i], pos: acTransform(tiles[i], "ADBE Position").value };
            fxs = {};
            try { gridAnim(comp, it, fxIn, "in", tIn + dIn[i], dur, labels, fxs); } catch (eI) {}
            if (fxOut !== "none") { try { gridAnim(comp, it, fxOut, "out", tOut + dOut[i], dur, labels, fxs); } catch (eO) {} }
            // A number on a shape tile is its own layer: it fades with its tile.
            if (nums[i] && (fxIn !== "none" || fxOut !== "none")) { try { acTransform(nums[i], "ADBE Opacity").expression = "parent.transform.opacity"; } catch (eN) {} }
        }
        ctrl.selected = true;
        return { tiles: tiles.length, ctrl: ctrl.name, precomp: pre, folder: folder ? folder.name : "", w: W, h: H, appear: fxIn, disappear: fxOut };
    }

    // ---- Phone mockup (section "Layouts"): an iPhone-like or an Android-like phone drawn with shapes (no brand marks).
    // The screen is a comp of the phone's real resolution (or the selected layer), cut to the screen's rounded corners.
    // Everything hangs on one null: move, scale or turn the null to move the whole phone.
    var PHONE_MODELS = {
        iphone: { aspect: 0.488, bezel: 0.045, radius: 0.19, res: [1179, 2556] },
        android: { aspect: 0.47, bezel: 0.035, radius: 0.12, res: [1080, 2340] }
    };
    var PHONE_COLORS = { black: [0.13, 0.13, 0.14], silver: [0.84, 0.84, 0.82], gold: [0.74, 0.66, 0.55], blue: [0.24, 0.29, 0.38], pink: [0.91, 0.78, 0.8] };

    function phoneRect(l, name, w, h, r, color, stroke, sw, pos) {
        var gi = acGroup(l), ri;
        try { acP(l, ["ADBE Root Vectors Group", gi]).name = name; } catch (e0) {}
        ri = acIn(l, gi, "ADBE Vector Shape - Rect");
        acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Size"]).setValue([w, h]);
        acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Roundness"]).setValue(Math.max(0, Math.min(r, w / 2, h / 2)));
        if (pos) { acGP(l, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Position"]).setValue(pos); }
        if (stroke) { acStroke(l, gi, stroke, sw); }
        acFill(l, gi, color);
        return gi;
    }

    function phoneBuild(comp, o, labels) {
        var model = PHONE_MODELS[o.model] ? o.model : "iphone", M = PHONE_MODELS[model];
        var pose = o.pose === "tilt" || o.pose === "lie" ? o.pose : "flat", lie = pose === "lie", d3 = pose === "tilt";
        var col = PHONE_COLORS[o.color] || PHONE_COLORS.black, rk = orbitNum(o.round, 0, 150, 100) / 100;
        var refH = lie ? Math.min(comp.width, comp.height / M.aspect) : comp.height;
        var H = Math.round(refH * orbitNum(o.size, 10, 100, 80) / 100), W = Math.round(H * M.aspect);
        var b = W * M.bezel, R = Math.min(W / 2, W * M.radius * rk), f = b * 0.4, cx = comp.width / 2, cy = comp.height / 2;
        var sW = W - 2 * b, sH = H - 2 * b, sR = Math.max(0, R - b), dark = acMix(col, [0, 0, 0], 0.18), light = acMix(col, [1, 1, 1], 0.3);
        var body, scr, cc = null, isl, ctrl, sel = null, used = "", fallback = false, sc, lw, lh, t, k, fx, y0, list, i, tb = W * 0.018, bx;
        var screenName = (labels.screen || "Screen") + " " + (labels[model] || model);
        if (o.screen === "layer") {
            list = comp.selectedLayers || [];
            for (i = 0; i < list.length; i++) { if (typeof AVLayer !== "undefined" ? list[i] instanceof AVLayer : list[i].width > 0) { sel = list[i]; break; } }
            if (!sel) { fallback = true; }
        }
        // Body: the coloured frame, the black glass border inside it, the side buttons.
        body = comp.layers.addShape();
        body.name = labels.body || "Body";
        phoneRect(body, "Glass", W - 2 * f, H - 2 * f, R - f, [0.04, 0.04, 0.045]);
        phoneRect(body, "Frame", W, H, R, col, light, Math.max(1, W * 0.006));
        bx = W / 2 + tb * 0.2;
        if (model === "iphone") {
            phoneRect(body, "Button", tb, H * 0.035, tb / 2, dark, null, 0, [-bx, -H * 0.3]);
            phoneRect(body, "Button", tb, H * 0.06, tb / 2, dark, null, 0, [-bx, -H * 0.22]);
            phoneRect(body, "Button", tb, H * 0.06, tb / 2, dark, null, 0, [-bx, -H * 0.14]);
            phoneRect(body, "Button", tb, H * 0.1, tb / 2, dark, null, 0, [bx, -H * 0.2]);
        } else {
            phoneRect(body, "Button", tb, H * 0.12, tb / 2, dark, null, 0, [bx, -H * 0.2]);
            phoneRect(body, "Button", tb, H * 0.06, tb / 2, dark, null, 0, [bx, -H * 0.04]);
        }
        orbitSet(body, "ADBE Position", [cx, cy]);
        if (o.shadow) {
            fx = acAdd(body, ["ADBE Effect Parade"], "ADBE Drop Shadow");
            kitSet(body, fx, "ADBE Drop Shadow-0003", 180);
            kitSet(body, fx, "ADBE Drop Shadow-0004", Math.round(H * 0.02));
            kitSet(body, fx, "ADBE Drop Shadow-0005", Math.round(H * 0.06));
        }
        // Screen: a comp of the real resolution (landscape when the phone lies), or the selected layer.
        if (sel) {
            scr = sel;
            used = sel.name;
            lw = sel.width; lh = sel.height;
        } else {
            lw = lie ? M.res[1] : M.res[0]; lh = lie ? M.res[0] : M.res[1];
            cc = mkComp(screenName, lw, lh, comp.pixelAspect || 1, comp.duration, comp.frameRate);
            if (!mkReused(cc)) {
                t = cc.layers.addSolid([0.29, 0.18, 0.6], labels.bg || "Background", lw, lh, 1);
                k = Math.round(Math.min(lw, lh) * 0.09);
                t = orbitNumber(cc, labels.video || "Video", k);
                orbitSet(t, "ADBE Position", [lw / 2, lh / 2 + k * 0.35]);
            }
            scr = comp.layers.add(cc);
        }
        // Portrait screen: the layer's width runs across the phone; lying: the layer is turned back by 90 degrees.
        var across = lie ? lh : lw, along = lie ? lw : lh;
        sc = Math.max(sW / across, sH / along) * 100;
        orbitSet(scr, "ADBE Scale", [sc, sc]);
        orbitSet(scr, "ADBE Position", [cx, cy]);
        if (lie) { orbitSet(scr, "ADBE Rotate Z", 90); }
        k = acAdd(scr, ["ADBE Mask Parade"], "ADBE Mask Atom");
        try { acP(scr, ["ADBE Mask Parade", k]).name = labels.screenMask || "Screen"; } catch (eN) {}
        acP(scr, ["ADBE Mask Parade", k, "ADBE Mask Shape"]).setValue(gridMaskShape(lw / 2, lh / 2, (lie ? sH : sW) * 100 / sc, (lie ? sW : sH) * 100 / sc, sR * 100 / sc));
        try { scr.moveBefore(body); } catch (eM) {}
        // The island (iPhone) or the punch-hole camera (Android) on top of the screen.
        isl = comp.layers.addShape();
        if (model === "iphone") {
            isl.name = labels.island || "Island";
            phoneRect(isl, "Island", W * 0.32, W * 0.09, W * 0.045, [0, 0, 0]);
            y0 = -H / 2 + b + W * 0.035 + W * 0.045;
        } else {
            isl.name = labels.camera || "Camera";
            phoneRect(isl, "Camera", W * 0.065, W * 0.065, W * 0.0325, [0, 0, 0], [0.12, 0.12, 0.13], Math.max(1, W * 0.006));
            y0 = -H / 2 + b + W * 0.05;
        }
        orbitSet(isl, "ADBE Position", [cx, cy + y0]);
        try { isl.moveBefore(scr); } catch (eI) {}
        ctrl = comp.layers.addNull(comp.duration);
        ctrl.name = labels.ctrl || "Phone Control";
        orbitSet(ctrl, "ADBE Position", [cx, cy]);
        if (d3) {
            ctrl.threeDLayer = true; body.threeDLayer = true; scr.threeDLayer = true; isl.threeDLayer = true;
            orbitSet(scr, "ADBE Position", [cx, cy, -0.5]);
            orbitSet(isl, "ADBE Position", [cx, cy + y0, -1]);
            orbitSet(ctrl, "ADBE Position", [cx, cy, 0]);
        }
        body.parent = ctrl; scr.parent = ctrl; isl.parent = ctrl;
        if (d3) {
            orbitSet(ctrl, "ADBE Rotate X", 10);
            orbitSet(ctrl, "ADBE Rotate Y", -24);
            orbitSet(ctrl, "ADBE Rotate Z", 4);
        } else if (lie) {
            orbitSet(ctrl, "ADBE Rotate Z", -90);
        }
        if (o.appear) {
            var f0 = comp.time, f1 = comp.time + Math.round(0.6 / (comp.frameDuration || 1 / 30)) * (comp.frameDuration || 1 / 30);
            try { acKeys(acTransform(ctrl, "ADBE Position"), [f0, f1], d3 ? [[cx, comp.height + H * 0.6, 0], [cx, cy, 0]] : [[cx, comp.height + H * 0.6], [cx, cy]], 80); } catch (eA) {}
        }
        try { body.selected = false; scr.selected = false; isl.selected = false; } catch (eS) {}
        ctrl.selected = true;
        return { model: model, pose: pose, ctrl: ctrl.name, screen: scr.name, screenComp: cc ? cc.name : "", used: used, fallback: fallback,
            w: Math.round(sW), h: Math.round(sH), res: cc ? [lw, lh] : [] };
    }

    // ---- Text on a ribbon (section "Layouts"). "ribbon": a thick stroke along a line with a text running on it
    // (the line is the selected mask/shape path, or a ready form); "ring": letters stand on a circle in 3D and turn.
    // The forms are sampled points joined by smooth curves (Catmull-Rom); the panel draws its preview the same way.
    // Same numbers in the panel's preview and here: a Park-Miller generator (exact in doubles, no Math.imul in ES3).
    function ribRng(seed) {
        var s = Math.floor(Math.abs(Number(seed) || 1)) % 2147483646 + 1;
        return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }

    // "Random": one of many figures (spiral, zigzag, straight line, heart, diamond, square, wave, triangle, arc),
    // each with its own random size and bends. The same number gives the same figure. Few points, so it is easy
    // to bend by hand; corners stay sharp.
    function ribRandom(seed, W, H) {
        var r = ribRng(Math.floor(Math.abs(Number(seed) || 1)) * 7919 % 2147483629 + 17), kinds = ["spiral", "zigzag", "line", "heart", "diamond", "square", "wave", "triangle", "arc"];
        var kind, M = Math.min(W, H), pts = [], corners = {}, i, n, t, a, rr, s, w, h, amp, turns, cnt, k, a0;
        function poly(list) { for (var j = 0; j < list.length; j++) { pts.push(list[j]); corners[j] = true; } }
        r(); r(); r();
        kind = kinds[Math.floor(r() * kinds.length) % kinds.length];
        if (kind === "spiral") {
            turns = 2 + r() * 2; n = Math.ceil(turns * 16); a0 = r() * 2 * Math.PI;
            for (i = 0; i <= n; i++) { t = a0 + i / n * turns * 2 * Math.PI; rr = M * 0.44 * (0.1 + 0.9 * i / n); pts.push([rr * Math.cos(t), rr * Math.sin(t)]); }
            return { pts: pts, closed: false, step: 4, kind: kind };
        }
        if (kind === "zigzag") {
            cnt = 4 + Math.floor(r() * 5); amp = H * (0.12 + r() * 0.16);
            for (i = 0; i <= cnt; i++) { pts.push([(i / cnt - 0.5) * W * 1.1, (i % 2 ? -1 : 1) * amp]); corners[i] = true; }
            return { pts: pts, closed: false, step: 1, corners: corners, kind: kind };
        }
        if (kind === "line") {
            s = (r() - 0.5) * 0.6;
            for (i = 0; i <= 2; i++) { t = (i / 2 - 0.5) * W * 1.1; pts.push([t, t * s * H / W]); }
            return { pts: pts, closed: false, step: 1, kind: kind };
        }
        if (kind === "heart") {
            n = 48; s = M * (0.36 + r() * 0.1) / 17;
            for (i = 0; i < n; i++) { t = i / n * 2 * Math.PI; pts.push([16 * Math.pow(Math.sin(t), 3) * s, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t) + 2.5) * s]); }
            corners[0] = true; corners[24] = true;
            return { pts: pts, closed: true, step: 4, corners: corners, kind: kind };
        }
        if (kind === "diamond") {
            w = M * (0.24 + r() * 0.1); h = Math.min(w * (1.25 + r() * 0.35), M * 0.44);
            poly([[0, -h], [w, 0], [0, h], [-w, 0]]);
            return { pts: pts, closed: true, step: 1, corners: corners, kind: kind };
        }
        if (kind === "square") {
            w = M * (0.28 + r() * 0.12); a = (r() - 0.5) * 0.4;
            for (i = 0; i < 4; i++) { t = a + Math.PI / 4 + i * Math.PI / 2; pts.push([w * Math.SQRT2 * Math.cos(t), w * Math.SQRT2 * Math.sin(t)]); corners[i] = true; }
            return { pts: pts, closed: true, step: 1, corners: corners, kind: kind };
        }
        if (kind === "triangle") {
            w = M * (0.36 + r() * 0.1); a = (r() - 0.5) * 0.5;
            for (i = 0; i < 3; i++) { t = a - Math.PI / 2 + i * 2 * Math.PI / 3; pts.push([w * Math.cos(t), w * Math.sin(t) + w * 0.18]); corners[i] = true; }
            return { pts: pts, closed: true, step: 1, corners: corners, kind: kind };
        }
        if (kind === "arc") {
            a = (0.6 + r() * 0.45) * Math.PI; rr = W * 0.5 / Math.max(0.5, Math.sin(a / 2)); k = r() < 0.5 ? 1 : -1; n = 24;
            for (i = 0; i <= n; i++) { t = -a / 2 + i / n * a; pts.push([rr * Math.sin(t), -k * rr * Math.cos(t)]); }
            // Centred, and small enough to stay inside the frame.
            w = 0; h = 1e9; for (i = 0; i <= n; i++) { w = Math.max(w, pts[i][1]); h = Math.min(h, pts[i][1]); }
            s = Math.min(1, H * 0.7 / Math.max(1, w - h), W * 1.0 / Math.max(1, 2 * rr * (a > Math.PI ? 1 : Math.sin(a / 2))));
            for (i = 0; i <= n; i++) { pts[i] = [pts[i][0] * s, (pts[i][1] - (w + h) / 2) * s]; }
            return { pts: pts, closed: false, step: 6, kind: kind };
        }
        // wave: one to three waves
        cnt = 1 + Math.floor(r() * 3); amp = H * (0.1 + r() * 0.16); n = cnt * 16; a0 = r() < 0.5 ? 1 : -1;
        for (i = 0; i <= n; i++) { t = i / n; pts.push([(t - 0.5) * W * 1.1, -a0 * Math.sin(t * cnt * 2 * Math.PI) * amp]); }
        return { pts: pts, closed: false, step: 4, kind: "wave" };
    }

    // A line with few points, easy to bend by hand: every step-th point of the dense line is kept, its handles
    // point along the dense line and are a third of the way to the next kept point. At a corner the two handles
    // point at their own neighbours, so it stays sharp.
    function ribBez(sm) {
        var p = sm.pts, n = p.length, st = sm.step || 1, cr = sm.corners || {}, keep = [], i, k, a, b, dx, dy, d, ex, ey, lenTo, ins = [], outs = [], v = [];
        for (i = 0; i < n; i += st) { keep.push(i); }
        if (!sm.closed && keep[keep.length - 1] !== n - 1) { if (n - 1 - keep[keep.length - 1] < st / 2 && keep.length > 1) { keep.pop(); } keep.push(n - 1); }
        function at(j) { return p[((j % n) + n) % n]; }
        function arc(i0, i1) {
            var L = 0, j, q, r;
            for (j = i0; j < i1; j++) { q = at(j); r = at(j + 1); L += Math.sqrt((r[0] - q[0]) * (r[0] - q[0]) + (r[1] - q[1]) * (r[1] - q[1])); }
            return L;
        }
        function unit(x, y) { var l = Math.sqrt(x * x + y * y) || 1; return [x / l, y / l]; }
        for (k = 0; k < keep.length; k++) {
            i = keep[k];
            a = sm.closed ? at(i - 1) : p[Math.max(0, i - 1)];
            b = sm.closed ? at(i + 1) : p[Math.min(n - 1, i + 1)];
            if (cr[i]) { d = unit(p[i][0] - a[0], p[i][1] - a[1]); dx = d[0]; dy = d[1]; d = unit(b[0] - p[i][0], b[1] - p[i][1]); ex = d[0]; ey = d[1]; }
            else { d = unit(b[0] - a[0], b[1] - a[1]); dx = ex = d[0]; dy = ey = d[1]; }
            lenTo = (k > 0 || sm.closed) ? arc(k > 0 ? keep[k - 1] : keep[keep.length - 1] - n, i) / 3 : 0;
            ins.push([-dx * lenTo, -dy * lenTo]);
            lenTo = (k < keep.length - 1 || sm.closed) ? arc(i, k < keep.length - 1 ? keep[k + 1] : keep[0] + n) / 3 : 0;
            outs.push([ex * lenTo, ey * lenTo]);
            v.push([p[i][0], p[i][1]]);
        }
        return { vertices: v, inTangents: ins, outTangents: outs, closed: !!sm.closed };
    }

    // Line forms, turned by angle (degrees, 0 = left to right, -90 = bottom to top). A turned line is drawn
    // for the frame turned with it, so a vertical wave still runs the whole height.
    function ribSample(form, W, H, o) {
        var a = (o && Number(o.angle)) || 0, sm, i, c, sn, rw, rh, p;
        if (form === "circle" || !a) { return ribSample0(form, W, H, o); }
        c = Math.cos(a * Math.PI / 180); sn = Math.sin(a * Math.PI / 180);
        rw = Math.abs(c) * W + Math.abs(sn) * H; rh = H + Math.abs(sn) * (W - H);
        rw = Math.min(rw, Math.sqrt(W * W + H * H));
        sm = ribSample0(form, rw, rh, o);
        for (i = 0; i < sm.pts.length; i++) { p = sm.pts[i]; sm.pts[i] = [p[0] * c - p[1] * sn, p[0] * sn + p[1] * c]; }
        return sm;
    }

    function ribSample0(form, W, H, o) {
        var pts = [], i, n, t, u, m = Math.min(W, H), x, y, r, xs = [], ys = [], s, x0, x1, y0, y1;
        if (form === "random") { return ribRandom(o && o.seed, W, H); }
        if (form === "circle") {
            r = m * 0.3;
            for (i = 0; i < 24; i++) { t = i / 24 * 2 * Math.PI; pts.push([r * Math.sin(t), -r * Math.cos(t)]); }
            return { pts: pts, closed: true, step: 6 };
        }
        if (form === "spiral") {
            n = 44;
            for (i = 0; i <= n; i++) { t = i / n * 5 * Math.PI; r = m * 0.4 * (0.12 + 0.88 * i / n); pts.push([r * Math.cos(t), r * Math.sin(t)]); }
            return { pts: pts, closed: false, step: 4 };
        }
        if (form === "loops") {
            // A prolate cycloid: three loops in a row.
            n = 54;
            for (i = 0; i <= n; i++) { t = -0.5 * Math.PI + i / n * 7 * Math.PI; xs.push(t - 3.2 * Math.sin(t)); ys.push(3.2 * Math.cos(t)); }
            x0 = x1 = xs[0]; y0 = y1 = ys[0];
            for (i = 0; i <= n; i++) { x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]); }
            s = Math.min(W * 0.9 / (x1 - x0), H * 0.62 / (y1 - y0));
            for (i = 0; i <= n; i++) { pts.push([(xs[i] - (x0 + x1) / 2) * s, (ys[i] - (y0 + y1) / 2) * s]); }
            return { pts: pts, closed: false, step: 3 };
        }
        // wave: two full waves across the frame
        n = 32;
        for (i = 0; i <= n; i++) { u = i / n; x = (u - 0.5) * W * 1.1; y = -Math.sin(u * 4 * Math.PI) * H * 0.18; pts.push([x, y]); }
        return { pts: pts, closed: false, step: 4 };
    }

    function ribShape(sm) {
        var p = sm.pts, n = p.length, s = new Shape(), ins = [], outs = [], i, a, b, tx, ty;
        if (sm.step >= 1) { b = ribBez(sm); s.vertices = b.vertices; s.inTangents = b.inTangents; s.outTangents = b.outTangents; s.closed = b.closed; return s; }
        for (i = 0; i < n; i++) {
            a = sm.closed ? p[(i - 1 + n) % n] : p[Math.max(0, i - 1)];
            b = sm.closed ? p[(i + 1) % n] : p[Math.min(n - 1, i + 1)];
            tx = (b[0] - a[0]) / 6; ty = (b[1] - a[1]) / 6;
            ins.push([-tx, -ty]); outs.push([tx, ty]);
        }
        s.vertices = p; s.inTangents = ins; s.outTangents = outs; s.closed = sm.closed;
        return s;
    }

    // Length of a bezier path, 10 steps a segment: enough to know how many times the text must repeat.
    function ribLength(sh) {
        var v = sh.vertices, n = v.length, segs = sh.closed ? n : n - 1, len = 0, i, j, a, b, c1, c2, px, py, t, q, x, y;
        for (i = 0; i < segs; i++) {
            a = v[i]; b = v[(i + 1) % n];
            c1 = [a[0] + sh.outTangents[i][0], a[1] + sh.outTangents[i][1]];
            c2 = [b[0] + sh.inTangents[(i + 1) % n][0], b[1] + sh.inTangents[(i + 1) % n][1]];
            px = a[0]; py = a[1];
            for (j = 1; j <= 10; j++) {
                t = j / 10; q = 1 - t;
                x = q * q * q * a[0] + 3 * q * q * t * c1[0] + 3 * q * t * t * c2[0] + t * t * t * b[0];
                y = q * q * q * a[1] + 3 * q * q * t * c1[1] + 3 * q * t * t * c2[1] + t * t * t * b[1];
                len += Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
                px = x; py = y;
            }
        }
        return len;
    }

    // The line the user drew: the first mask of the selected layer, or the first path inside a selected shape layer.
    function ribFindPath(L) {
        var m, found = null;
        try { m = L.property("ADBE Mask Parade"); if (m && m.numProperties > 0) { return m.property(1).property("ADBE Mask Shape"); } } catch (e0) {}
        function walk(g) {
            var i, p;
            if (!g || found) { return; }
            for (i = 1; i <= g.numProperties; i++) {
                p = g.property(i);
                if (!p) { continue; }
                if (p.matchName === "ADBE Vector Shape - Group") { found = p.property("ADBE Vector Shape"); return; }
                if (p.numProperties) { walk(p); }
                if (found) { return; }
            }
        }
        try { walk(L.property("ADBE Root Vectors Group")); } catch (e1) {}
        return found;
    }

    function ribText(comp, str, size, color, name) {
        var t = comp.layers.addText(str), p, doc;
        t.name = name;
        try {
            p = acP(t, ["ADBE Text Properties", "ADBE Text Document"]);
            doc = p.value;
            doc.fontSize = size;
            try { doc.font = "Arial-BoldMT"; } catch (eF) {}
            doc.applyFill = true;
            doc.fillColor = color;
            try { doc.applyStroke = false; } catch (eS) {}
            try { doc.tracking = 40; } catch (eT) {}
            try { doc.justification = ParagraphJustification.LEFT_JUSTIFY; } catch (eJ) {}
            p.setValue(doc);
        } catch (e0) {}
        return t;
    }

    // Puts the text on its own mask (the same line), centred on the line: an animator moves the letters down by
    // a third of their size, so the line runs through their middle instead of under them.
    function ribOnPath(t, sh, size, force) {
        var mi = acAdd(t, ["ADBE Mask Parade"], "ADBE Mask Atom"), ai, pi, base = ["ADBE Text Properties", "ADBE Text Animators"];
        acP(t, ["ADBE Mask Parade", mi, "ADBE Mask Shape"]).setValue(sh);
        try { acP(t, ["ADBE Mask Parade", mi, "ADBE Mask Mode"]).setValue(MaskMode.NONE); } catch (eM) {}
        acP(t, ["ADBE Text Properties", "ADBE Text Path Options", "ADBE Text Path"]).setValue(mi);
        if (force) { try { acP(t, ["ADBE Text Properties", "ADBE Text Path Options", "ADBE Text Force Align Path"]).setValue(1); } catch (eA) {} }
        ai = acAdd(t, base, "ADBE Text Animator");
        try { acP(t, base.concat([ai])).name = "Centre"; } catch (eN) {}
        pi = acAdd(t, base.concat([ai, "ADBE Text Animator Properties"]), "ADBE Text Position 3D");
        acP(t, base.concat([ai, "ADBE Text Animator Properties", pi])).setValue([0, Math.round(size * 0.34), 0]);
        return mi;
    }

    // ---- Overlaps for the text ribbon: where the ribbon passes over itself, the later pass covers the earlier
    // one with its letters. The line is cut into pieces between the crossings; each piece is its own ribbon and
    // its own copy of the text that shows only the letters on that piece, stacked in order along the line.

    // Points along a bezier path with the distance travelled to each one.
    function ribPolyline(sh, steps) {
        var v = sh.vertices, n = v.length, segs = sh.closed ? n : n - 1, pts = [], arc = [], len = 0, i, j, a, b, c1, c2, t, q, x, y;
        if (!n) { return { pts: pts, arc: arc, len: 0 }; }
        pts.push([v[0][0], v[0][1]]); arc.push(0);
        for (i = 0; i < segs; i++) {
            a = v[i]; b = v[(i + 1) % n];
            c1 = [a[0] + sh.outTangents[i][0], a[1] + sh.outTangents[i][1]];
            c2 = [b[0] + sh.inTangents[(i + 1) % n][0], b[1] + sh.inTangents[(i + 1) % n][1]];
            for (j = 1; j <= steps; j++) {
                t = j / steps; q = 1 - t;
                x = q * q * q * a[0] + 3 * q * q * t * c1[0] + 3 * q * t * t * c2[0] + t * t * t * b[0];
                y = q * q * q * a[1] + 3 * q * q * t * c1[1] + 3 * q * t * t * c2[1] + t * t * t * b[1];
                len += Math.sqrt((x - pts[pts.length - 1][0]) * (x - pts[pts.length - 1][0]) + (y - pts[pts.length - 1][1]) * (y - pts[pts.length - 1][1]));
                pts.push([x, y]); arc.push(len);
            }
        }
        return { pts: pts, arc: arc, len: len };
    }

    // Where the ribbon (width W) runs over itself: pairs of places far apart along the line but close on screen.
    // Returns the cut points along the line: one between every two neighbouring overlap places, so the two passes
    // of every crossing end up in different pieces. Empty when the ribbon never meets itself.
    function ribCuts(sh, W) {
        var pl = ribPolyline(sh, 12), L = pl.len, step = Math.max(W / 4, L / 500), sp = [], i, j, k, d, dx, dy, far = W * 2.5, near = W * 0.85;
        var pairs = [], cl = [], c, pos = [], cuts = [], m, closed = !!sh.closed;
        if (!(L > 0)) { return { cuts: [], len: 0 }; }
        // Even steps along the line.
        for (i = 0, k = 0; i * step <= L; i++) {
            d = i * step;
            while (k < pl.arc.length - 2 && pl.arc[k + 1] < d) { k++; }
            m = pl.arc[k + 1] - pl.arc[k];
            m = m > 0 ? (d - pl.arc[k]) / m : 0;
            sp.push({ x: pl.pts[k][0] + (pl.pts[k + 1][0] - pl.pts[k][0]) * m, y: pl.pts[k][1] + (pl.pts[k + 1][1] - pl.pts[k][1]) * m, s: d });
        }
        for (i = 0; i < sp.length; i++) {
            for (j = i + 1; j < sp.length; j++) {
                d = sp[j].s - sp[i].s;
                if (closed) { d = Math.min(d, L - d); }
                if (d < far) { continue; }
                dx = sp[i].x - sp[j].x; dy = sp[i].y - sp[j].y;
                if (dx * dx + dy * dy < near * near) { pairs.push([sp[i].s, sp[j].s]); }
            }
        }
        // Neighbouring close pairs are one crossing: its middle on each pass.
        for (i = 0; i < pairs.length; i++) {
            for (k = 0; k < cl.length; k++) {
                c = cl[k];
                if (Math.abs(c.a / c.n - pairs[i][0]) < W * 1.5 && Math.abs(c.b / c.n - pairs[i][1]) < W * 1.5) { c.a += pairs[i][0]; c.b += pairs[i][1]; c.n++; break; }
            }
            if (k === cl.length) { cl.push({ a: pairs[i][0], b: pairs[i][1], n: 1 }); }
        }
        for (k = 0; k < cl.length; k++) { pos.push(cl[k].a / cl[k].n); pos.push(cl[k].b / cl[k].n); }
        pos.sort(function (p, q) { return p - q; });
        // Places close together along the line are the same spot; a cut goes halfway to the next one.
        for (i = 1; i < pos.length; i++) {
            if (pos[i] - pos[i - 1] > W) { cuts.push(Math.round((pos[i] + pos[i - 1]) / 2 * 10) / 10); }
        }
        return { cuts: cuts, len: L, crossings: cl.length };
    }

    // Where each letter of one repeat (unit) sits along the line, from the start of the repeat: measured with a
    // helper text (each prefix plus a bar), falling back to even spacing when the sizes can't be read.
    function ribAdvances(comp, unit, fs, tc, guess) {
        var n = unit.length, A = [], off = [], i, t = null, bar = 0, ok = true, p, doc;
        function w(s) {
            doc = p.value; doc.text = s; p.setValue(doc);
            return Number(t.sourceRectAtTime(comp.time, false).width) || 0;
        }
        try {
            t = ribText(comp, "|", fs, tc, "measure");
            p = acP(t, ["ADBE Text Properties", "ADBE Text Document"]);
            bar = w("|");
            A.push(0);
            for (i = 1; i <= n; i++) { A.push(w(unit.substring(0, i) + "|") - bar); }
        } catch (e0) { ok = false; }
        try { if (t) { t.remove(); } } catch (eR) {}
        for (i = 1; ok && i <= n; i++) { if (!(A[i] > A[i - 1])) { ok = false; } }
        if (!ok || !(bar > 0)) {
            A = [];
            for (i = 0; i <= n; i++) { A.push(guess * i / n); }
        }
        for (i = 0; i < n; i++) { off.push(Math.round((A[i] + A[i + 1]) / 2 * 10) / 10); }
        return { off: off, period: A[n] };
    }

    // The expression that shows only the letters whose middle is on [a, b) of the line (cut points; -1 / -1 for open ends).
    function ribPieceExpr(adv, a, b, L, closed, hideOff) {
        var e = "var m=text.pathOption.firstMargin, P=" + adv.period + ", O=[" + adv.off.join(",") + "], n=O.length, i=textIndex-1, s=m+Math.floor(i/n)*P+O[i%n], L=" + Math.round(L * 10) / 10 + ";";
        if (closed) { e += "s=((s%L)+L)%L;"; }
        e += "var on=" + (a < 0 ? "true" : "s>=" + a) + "&&" + (b < 0 ? "true" : "s<" + b) + (hideOff ? "&&s>=0&&s<=L" : "") + ";on?[0,0,0]:[100,100,100]";
        return e;
    }

    function ribPieceSel(T, expr) {
        var base = ["ADBE Text Properties", "ADBE Text Animators"], ai = acAdd(T, base, "ADBE Text Animator"), pi, si;
        try { acP(T, base.concat([ai])).name = "Piece"; } catch (eN) {}
        pi = acAdd(T, base.concat([ai, "ADBE Text Animator Properties"]), "ADBE Text Opacity");
        acP(T, base.concat([ai, "ADBE Text Animator Properties", pi])).setValue(0);
        si = acAdd(T, base.concat([ai, "ADBE Text Selectors"]), "ADBE Text Expressible Selector");
        acP(T, base.concat([ai, "ADBE Text Selectors", si, "ADBE Text Expressible Amount"])).expression = expr;
    }

    function ribTrim(R, startPct, endPct) {
        var gi = 1, ti = acIn(R, gi, "ADBE Vector Filter - Trim");
        acGP(R, gi, ["ADBE Vectors Group", ti, "ADBE Vector Trim Start"]).setValue(Math.max(0, Math.min(100, startPct)));
        acGP(R, gi, ["ADBE Vectors Group", ti, "ADBE Vector Trim End"]).setValue(Math.max(0, Math.min(100, endPct)));
    }

    // One more ribbon on the same line, reading width and colour from the text's Effect Controls like the first.
    function ribRibbonLayer(comp, name, sh, rc, width, labels, Tname) {
        var l = comp.layers.addShape(), gi = acGroup(l), i, si;
        l.name = name;
        try { acP(l, ["ADBE Root Vectors Group", gi]).name = labels.path || "Line"; } catch (eG) {}
        i = acIn(l, gi, "ADBE Vector Shape - Group");
        acGP(l, gi, ["ADBE Vectors Group", i, "ADBE Vector Shape"]).setValue(sh);
        si = acStroke(l, gi, rc, width);
        try { acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Line Join"]).setValue(2); } catch (eJ) {}
        acGP(l, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Width"]).expression = "thisComp.layer(" + tbQ(Tname) + ").effect(" + tbQ(labels.width || "Width") + ")(1)";
        return { layer: l, stroke: si };
    }

    // R and T are the ribbon and its text, already made; top is the highest layer of the ribbon so far.
    function ribOverlap(comp, o, labels, R, T, Mt, sh, ctx) {
        var W = ctx.width, fs = ctx.fs, L = ctx.len, cut = ribCuts(sh, W), cuts = cut.cuts, n = cuts.length + 1, i, a, b, Rk, Tk, Sk, top = Mt || T;
        var adv, d = W / 2 + fs / 2, sTo, s0, s1, texts = [], pieces = [], shadows = [], tf, k, gi = 1, matte = Mt && typeof Mt.enabled !== "undefined" && !Mt.enabled && typeof T.setTrackMatte === "function";
        if (n < 2) { return { pieces: 1, crossings: 0 }; }
        adv = ribAdvances(comp, ctx.unit, fs, ctx.tc, ctx.uw);
        if (ctx.closed && adv.period > 0) {
            // Around a circle the repeats are spread by tracking to fill exactly one lap.
            k = (L / ctx.reps) / adv.period;
            for (i = 0; i < adv.off.length; i++) { adv.off[i] = Math.round(adv.off[i] * k * 10) / 10; }
            adv.period = Math.round(L / ctx.reps * 100) / 100;
        }
        // Copies of the ribbon first, before the first piece is trimmed.
        for (i = 1; i < n; i++) {
            k = ribRibbonLayer(comp, (labels.ribbon || "Ribbon") + ": " + (labels.piece || "piece") + " " + (i + 1), sh, ctx.rc, W, labels, T.name);
            acGP(k.layer, gi, ["ADBE Vectors Group", k.stroke, "ADBE Vector Stroke Color"]).expression = "thisComp.layer(" + tbQ(T.name) + ").effect(" + tbQ(labels.color || "Ribbon colour") + ")(1)";
            pieces.push(k.layer);
            if (o.shadow) {
                k = ribRibbonLayer(comp, (labels.ribbon || "Ribbon") + ": " + (labels.shadow || "shadow") + " " + (i + 1), sh, [0, 0, 0], W, labels, T.name);
                shadows[i - 1] = k.layer;
            }
            for (k = 0; k < ctx.tr.length; k++) {
                try { orbitSet(pieces[i - 1], ctx.tr[k][0], ctx.tr[k][1]); if (shadows[i - 1]) { orbitSet(shadows[i - 1], ctx.tr[k][0], ctx.tr[k][1]); } } catch (eP) {}
            }
        }
        // The text of the first piece is the main text; the copies follow its words and its run.
        ribPieceSel(T, ribPieceExpr(adv, -1, cuts[0], L, ctx.closed, false));
        ribTrim(R, 0, (cuts[0] + d) / L * 100);
        for (i = 1; i < n; i++) {
            a = cuts[i - 1]; b = i < n - 1 ? cuts[i] : -1;
            Rk = pieces[i - 1];
            s0 = (a + d) / L * 100; s1 = b < 0 ? 100 : (b + d) / L * 100;
            ribTrim(Rk, s0, s1);
            Sk = shadows[i - 1] || null;
            if (Sk) {
                // A soft dark copy under the piece, kept away from the piece's own ends so no band shows at the seams;
                // the full ribbon is its matte, so the shadow falls only on the ribbon under it.
                sTo = (b < 0 ? L : b + d) - W;
                if (sTo - (a + d + W) > W * 0.5) {
                    ribTrim(Sk, (a + d + W) / L * 100, sTo / L * 100);
                    k = acAdd(Sk, ["ADBE Effect Parade"], "ADBE Gaussian Blur 2");
                    try { acP(Sk, ["ADBE Effect Parade", k, "ADBE Gaussian Blur 2-0001"]).setValue(Math.round(W * 0.3)); } catch (eB) {}
                    try { acP(Sk, ["ADBE Transform Group", "ADBE Opacity"]).setValue(55); } catch (eO) {}
                    Sk.moveBefore(top);
                    top = Sk;
                    if (matte) { try { Sk.setTrackMatte(Mt, TrackMatteType.ALPHA); } catch (eM) {} }
                } else {
                    try { Sk.remove(); } catch (eX) {}
                }
            }
            Rk.moveBefore(top);
            top = Rk;
            Tk = ribText(comp, ctx.str, fs, ctx.tc, (labels.text || "Ribbon text") + ": " + (labels.piece || "piece") + " " + (i + 1));
            try {
                tf = acP(Tk, ["ADBE Text Properties", "ADBE Text Document"]);
                var dc = tf.value; dc.tracking = ctx.track; tf.setValue(dc);
                tf.expression = "thisComp.layer(" + tbQ(T.name) + ").text.sourceText";
            } catch (eD) {}
            ribOnPath(Tk, sh, fs, false);
            acP(Tk, ["ADBE Text Properties", "ADBE Text Path Options", "ADBE Text First Margin"]).expression = "thisComp.layer(" + tbQ(T.name) + ").text.pathOption.firstMargin";
            ribPieceSel(Tk, ribPieceExpr(adv, a, b, L, ctx.closed, !ctx.closed));
            for (k = 0; k < ctx.tr.length; k++) { try { orbitSet(Tk, ctx.tr[k][0], ctx.tr[k][1]); } catch (eP) {} }
            Tk.moveBefore(top);
            top = Tk;
            texts.push(Tk);
            try { Tk.selected = false; Rk.selected = false; } catch (eS) {}
        }
        return { pieces: n, crossings: cut.crossings, ribbons: pieces, texts: texts };
    }

    // A gradient on a ribbon or text layer: a Gradient Ramp across the frame at the given angle, then
    // Set Matte with the layer's own alpha, so the colours stay inside the ribbon or the letters.
    function ribGrad(l, g, labels) {
        var e, m, a = Number(g.angle) || 0, F = ["ADBE Effect Parade"];
        var half = "var a=" + a + "*Math.PI/180, d=[Math.cos(a),Math.sin(a)], c=[thisComp.width/2,thisComp.height/2], r=Math.abs(d[0])*thisComp.width/2+Math.abs(d[1])*thisComp.height/2;";
        e = acAdd(l, F, "ADBE Ramp");
        try { acP(l, F.concat([e])).name = labels.grad || "Gradient"; } catch (eN) {}
        acP(l, F.concat([e, "ADBE Ramp-0002"])).setValue([g.a[0], g.a[1], g.a[2], 1]);
        acP(l, F.concat([e, "ADBE Ramp-0004"])).setValue([g.b[0], g.b[1], g.b[2], 1]);
        try { acP(l, F.concat([e, "ADBE Ramp-0005"])).setValue(1); } catch (eS) {}
        acP(l, F.concat([e, "ADBE Ramp-0001"])).expression = half + " fromComp(c - d*r)";
        acP(l, F.concat([e, "ADBE Ramp-0003"])).expression = half + " fromComp(c + d*r)";
        m = acAdd(l, F, "ADBE Set Matte3");
        try { acP(l, F.concat([m])).name = labels.gradMatte || "Gradient: shape"; } catch (eM) {}
        try { acP(l, F.concat([m, "ADBE Set Matte3-0001"])).setValue(l.index); } catch (eL) {}
        try { acP(l, F.concat([m, "ADBE Set Matte3-0002"])).setValue(4); } catch (eU) {}
        return e;
    }

    function ribBuild(comp, o, labels) {
        var W = comp.width, H = comp.height, cx = W / 2, cy = H / 2, src = null, srcName = "", sh, len, list, i, j;
        var width = orbitNum(o.width, 4, 1000, 120), fs = Math.max(6, Math.round(width * orbitNum(o.textSize, 10, 100, 65) / 100));
        var speed = orbitNum(o.speed, 0, 100, 35), word = String(o.text || "TEXT"), sep = String(o.sep === undefined ? "\u2022" : o.sep);
        var unit = word + " " + (sep ? sep + " " : ""), cw = fs * 0.66 + 40 * fs / 1000, need, str = "", R, T, gi, si, fx, tr, pos = null, anc = null, sc = null, rot = 0, uw, track, Mt = null;
        var rc = o.ribbonColor || [0.23, 0.63, 0.91], tc = o.textColor || [0.91, 0.4, 0.17], form = o.form || "wave", ov = null;
        if (form === "path") {
            list = comp.selectedLayers || [];
            for (i = 0; i < list.length && !sh; i++) {
                var pp = ribFindPath(list[i]);
                if (pp) { sh = pp.value; src = list[i]; srcName = src.name; }
            }
            if (!sh) { throw new Error("RB_NO_PATH"); }
            try { pos = acTransform(src, "ADBE Position").value; anc = acTransform(src, "ADBE Anchor Point").value; sc = acTransform(src, "ADBE Scale").value; rot = acTransform(src, "ADBE Rotate Z").value; } catch (eT) {}
        } else {
            sh = ribShape(ribSample(form, W, H, { seed: o.seed, angle: o.angle }));
        }
        len = ribLength(sh);
        R = comp.layers.addShape();
        R.name = labels.ribbon || "Ribbon";
        gi = acGroup(R);
        try { acP(R, ["ADBE Root Vectors Group", gi]).name = labels.path || "Line"; } catch (eG) {}
        i = acIn(R, gi, "ADBE Vector Shape - Group");
        acGP(R, gi, ["ADBE Vectors Group", i, "ADBE Vector Shape"]).setValue(sh);
        si = acStroke(R, gi, rc, width);
        try { acGP(R, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Line Join"]).setValue(2); } catch (eJ) {}
        // The text is measured first (one word with its separator), so the repeats fit the line.
        T = ribText(comp, unit, fs, tc, labels.text || "Ribbon text");
        uw = 0;
        try { uw = T.sourceRectAtTime(comp.time, false).width; } catch (eW) { uw = 0; }
        if (!(uw > 0)) { uw = unit.length * cw; }
        if (sh.closed) {
            // A closed line (a circle): exactly as many repeats as fit once around, the rest spread by tracking.
            // More text would go round a second time and pile up on the first.
            j = Math.max(1, Math.floor(len / uw));
            for (i = 0; i < j; i++) { str += unit; }
            track = 40 + (len - j * uw) / (j * unit.length) / fs * 1000;
        } else {
            // An open line: enough for the whole line and for everything that runs past during the comp.
            // Half as much again, so the line can be made longer by hand and still be full.
            need = len * 1.5 + (o.run ? speed * 10 * comp.duration : 0) + uw;
            for (j = 0; j < 400 && j * uw < need; j++) { str += unit; }
            track = 40;
        }
        try {
            var tp = acP(T, ["ADBE Text Properties", "ADBE Text Document"]), doc = tp.value;
            doc.text = str;
            try { doc.tracking = Math.round(track * 10) / 10; } catch (eT2) {}
            tp.setValue(doc);
        } catch (eD) {}
        var tmi = ribOnPath(T, sh, fs, false);
        // Settings in Effect Controls of the text: the ribbon reads its width and colour from there.
        kitControl(T, "ADBE Slider Control", labels.width || "Width", width);
        kitControl(T, "ADBE Slider Control", labels.speed || "Speed", speed);
        kitControl(T, "ADBE Color Control", labels.color || "Ribbon colour", [rc[0], rc[1], rc[2], 1]);
        acGP(R, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Width"]).expression = "thisComp.layer(" + tbQ(T.name) + ").effect(" + tbQ(labels.width || "Width") + ")(1)";
        acGP(R, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Color"]).expression = "thisComp.layer(" + tbQ(T.name) + ").effect(" + tbQ(labels.color || "Ribbon colour") + ")(1)";
        if (o.run) {
            // On a circle the text goes round and round: the margin wraps at the circle's length.
            // Backward runs the other way; on an open line it starts as far back as it will travel, so no gap opens.
            var back = o.dir === "back", sg = back ? "+" : "-", fm = acP(T, ["ADBE Text Properties", "ADBE Text Path Options", "ADBE Text First Margin"]);
            if (back && !sh.closed) { try { fm.setValue(-speed * 10 * comp.duration); } catch (eB) {} }
            fm.expression = sh.closed ?
                "var L=" + Math.round(len * 10) / 10 + ", m=value" + sg + "time*effect(" + tbQ(labels.speed || "Speed") + ")(1)*10; ((m%L)+L)%L" :
                "value" + sg + "time*effect(" + tbQ(labels.speed || "Speed") + ")(1)*10";
        }
        T.moveBefore(R);
        if (src) {
            // The new layers sit exactly where the drawn line is; the line itself is switched off.
            for (i = 0; i < 2; i++) {
                tr = i ? T : R;
                try { if (anc) { orbitSet(tr, "ADBE Anchor Point", anc); } if (pos) { orbitSet(tr, "ADBE Position", pos); } if (sc) { orbitSet(tr, "ADBE Scale", sc); } orbitSet(tr, "ADBE Rotate Z", rot); } catch (eP) {}
            }
            try { src.enabled = false; } catch (eE) {}
        } else {
            orbitSet(R, "ADBE Position", [cx, cy]);
            orbitSet(T, "ADBE Position", [cx, cy]);
        }
        // Letters that run past the ends of an open line would stick out of the ribbon: a copy of the ribbon
        // above the text is its alpha matte, so the text shows only on the ribbon.
        if (!sh.closed) {
            try {
                Mt = R.duplicate();
                Mt.name = (labels.ribbon || "Ribbon") + ": " + (labels.matte || "matte");
                Mt.moveBefore(T);
                if (typeof T.setTrackMatte === "function") { T.setTrackMatte(Mt, TrackMatteType.ALPHA); try { Mt.enabled = false; } catch (eH) {} }
                else { T.trackMatteType = TrackMatteType.ALPHA; }
            } catch (eMt) { Mt = null; }
        }
        if (o.overlap) {
            var trs = [];
            try { trs = [["ADBE Anchor Point", acTransform(T, "ADBE Anchor Point").value], ["ADBE Position", acTransform(T, "ADBE Position").value], ["ADBE Scale", acTransform(T, "ADBE Scale").value], ["ADBE Rotate Z", acTransform(T, "ADBE Rotate Z").value]]; } catch (eTr) {}
            ov = ribOverlap(comp, o, labels, R, T, Mt, sh, { width: width, fs: fs, len: len, unit: unit, uw: uw, tc: tc, rc: rc, str: str, track: Math.round(track * 10) / 10, closed: !!sh.closed, reps: j, tr: trs });
        }
        // One line for everything: the text and the matte follow the ribbon's line and move with the ribbon,
        // so bending or moving the line by hand keeps all of it together. (With overlaps the pieces are cut
        // from the line as it is now, so they stay as made.)
        var linked = !ov, lineExpr = "thisComp.layer(" + tbQ(R.name) + ").content(1).content(1).path";
        if (linked) {
            try { acP(T, ["ADBE Mask Parade", tmi, "ADBE Mask Shape"]).expression = lineExpr; } catch (eL1) { linked = false; }
            if (Mt) { try { acGP(Mt, gi, ["ADBE Vectors Group", 1, "ADBE Vector Shape"]).expression = lineExpr; Mt.parent = R; } catch (eL2) {} }
            try { T.parent = R; } catch (eL3) {}
        }
        // Gradients go on last, when every layer sits at its final index (Set Matte points at the layer itself).
        var gi2;
        if (o.ribbonGrad && o.ribbonGrad.a && o.ribbonGrad.b) {
            ribGrad(R, o.ribbonGrad, labels);
            if (ov && ov.ribbons) { for (gi2 = 0; gi2 < ov.ribbons.length; gi2++) { ribGrad(ov.ribbons[gi2], o.ribbonGrad, labels); } }
        }
        if (o.textGrad && o.textGrad.a && o.textGrad.b) {
            ribGrad(T, o.textGrad, labels);
            if (ov && ov.texts) { for (gi2 = 0; gi2 < ov.texts.length; gi2++) { ribGrad(ov.texts[gi2], o.textGrad, labels); } }
        }
        try { T.selected = false; } catch (eS) {}
        R.selected = true;
        try { acGP(R, gi, ["ADBE Vectors Group", 1, "ADBE Vector Shape"]).selected = true; } catch (eSel) {}
        return { mode: "ribbon", linked: linked, pieces: ov ? ov.pieces : 0, form: form, seed: form === "random" ? Math.floor(Number(o.seed) || 1) : 0, angle: form === "path" ? 0 : Number(o.angle) || 0, dir: o.dir === "back" ? "back" : "fwd", ribbon: R.name, text: T.name, from: srcName, length: Math.round(len), repeats: j, matte: Mt ? Mt.name : "" };
    }

    function ringBuild(comp, o, labels) {
        var cx = comp.width / 2, cy = comp.height / 2, n = Math.round(orbitNum(o.rings, 1, 5, 2)), R = orbitNum(o.radius, 50, 5000, 560);
        var fs = Math.max(8, Math.round(R * 0.2)), word = String(o.text || "TEXT"), sep = String(o.sep === undefined ? "\u2022" : o.sep);
        var unit = word + " " + (sep ? sep + " " : ""), cw = fs * 0.66, str = "", reps, tilt, spin, rings = [], i, T, k, base, ai, pi, si, cam = "", had = false, gap = fs * 1.35;
        var tc = o.textColor || [1, 1, 1], circle = new Shape(), c = R * 0.5523, spots = [], camL;
        // A circle starting at the top, clockwise: on the flat ring "top" is the far side.
        circle.vertices = [[0, -R], [R, 0], [0, R], [-R, 0]];
        circle.inTangents = [[-c, 0], [0, -c], [c, 0], [0, c]];
        circle.outTangents = [[c, 0], [0, c], [-c, 0], [0, -c]];
        circle.closed = true;
        // Measured, not guessed: as many words as fit once around (forced alignment spreads them evenly; too many would squeeze together).
        var uw = 0, tmp = ribText(comp, unit, fs, tc, "measure");
        try { uw = tmp.sourceRectAtTime(comp.time, false).width; } catch (eW) { uw = 0; }
        try { tmp.remove(); } catch (eR) {}
        if (!(uw > 0)) { uw = unit.length * cw; }
        reps = Math.max(1, Math.floor(2 * Math.PI * R / uw));
        for (i = 0; i < reps; i++) { str += unit; }
        tilt = comp.layers.addNull(comp.duration);
        tilt.name = labels.tilt || "Ring tilt";
        tilt.threeDLayer = true;
        orbitSet(tilt, "ADBE Position", [cx, cy, 0]);
        spin = comp.layers.addNull(comp.duration);
        spin.name = labels.spin || "Ring spin";
        spin.threeDLayer = true;
        orbitSet(spin, "ADBE Position", [cx, cy, 0]);
        kitControl(spin, "ADBE Slider Control", labels.speed || "Speed", orbitNum(o.speed, 0, 100, 40));
        acTransform(spin, "ADBE Rotate Y").expression = "value+time*effect(" + tbQ(labels.speed || "Speed") + ")(1)";
        for (i = 0; i < n; i++) {
            T = ribText(comp, str, fs, tc, (labels.ring || "Ring") + " " + (i + 1));
            ribOnPath(T, circle, fs, true);
            T.threeDLayer = true;
            try { T.threeDPerChar = true; } catch (e3) {}
            base = ["ADBE Text Properties", "ADBE Text Animators"];
            // The ring lies flat; each letter stands up again and faces outward.
            ai = acAdd(T, base, "ADBE Text Animator");
            try { acP(T, base.concat([ai])).name = "Stand up"; } catch (eN) {}
            pi = acAdd(T, base.concat([ai, "ADBE Text Animator Properties"]), "ADBE Text Rotation X");
            acP(T, base.concat([ai, "ADBE Text Animator Properties", pi])).setValue(-90);
            if (o.backDark) {
                // Letters on the far half are dimmer: an expression selector picks them by where they are on the ring now.
                // The path starts at the near side (the ring lies flat: layer y becomes depth), so a letter at angle
                // a on the path, with the ring turned by r, is at depth -R*cos(a - r): far when cos(a - r) < 0.
                ai = acAdd(T, base, "ADBE Text Animator");
                try { acP(T, base.concat([ai])).name = "Back side"; } catch (eB) {}
                pi = acAdd(T, base.concat([ai, "ADBE Text Animator Properties"]), "ADBE Text Opacity");
                acP(T, base.concat([ai, "ADBE Text Animator Properties", pi])).setValue(35);
                si = acAdd(T, base.concat([ai, "ADBE Text Selectors"]), "ADBE Text Expressible Selector");
                acP(T, base.concat([ai, "ADBE Text Selectors", si, "ADBE Text Expressible Amount"])).expression =
                    "var a=degreesToRadians((textIndex-0.5)/textTotal*360-thisComp.layer(" + tbQ(spin.name) + ").transform.yRotation);Math.cos(a)<0?[100,100,100]:[0,0,0]";
            }
            orbitSet(T, "ADBE Position", [cx, cy + (i - (n - 1) / 2) * gap, 0]);
            orbitSet(T, "ADBE Rotate X", 90);
            rings.push(T);
        }
        spin.parent = tilt;
        for (i = 0; i < rings.length; i++) { rings[i].parent = spin; }
        orbitSet(tilt, "ADBE Rotate X", -orbitNum(o.tilt, -80, 80, 12));
        if (o.camera) {
            for (k = 1; k <= comp.numLayers; k++) { if (comp.layer(k) instanceof CameraLayer) { had = true; break; } }
            if (!had) {
                // Far enough back that the whole ring (its near side too) is in the frame with room around it.
                camL = comp.layers.addCamera(labels.camera || "Ring camera", [cx, cy]);
                cam = camL.name;
                for (k = 0; k < 16; k++) { spots.push({ x: R * Math.sin(k * Math.PI / 8), y: 0, z: -R * Math.cos(k * Math.PI / 8) }); }
                orbitFrame(comp, camL, spots, fs * 1.2, (n - 1) * gap + fs * 1.4, cx, cy, 0);
                try { camL.selected = false; } catch (eC) {}
            }
        }
        for (i = 0; i < rings.length; i++) { try { rings[i].selected = false; } catch (eS) {} }
        try { spin.selected = false; } catch (eS2) {}
        tilt.selected = true;
        return { mode: "ring", rings: rings.length, ctrl: tilt.name, spin: spin.name, camera: cam, hadCamera: had, repeats: reps };
    }

    // ---- Text box (the Shape tab): a shape layer under a text layer that follows the text.
    // The box hangs on the text layer (parent) and reads its size with sourceRectAtTime, so it grows and
    // shrinks while the text is typed, edited or animated. Everything is set in Effect Controls of the box.
    // One box for the whole text, or one per line: each line gets an invisible helper text layer that shows
    // only that line (an expression), and its box reads the helper's size. Two spare lines are ready.
    var TB_LINE_SPLIT = "/\\r\\n|\\r|\\n|\\u0003/";

    function tbQ(s) {
        return "\"" + String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"";
    }

    function tbLines(t) {
        var s = "";
        try { s = String(acP(t, ["ADBE Text Properties", "ADBE Text Document"]).value.text); } catch (e0) { s = ""; }
        return s.split(/\r\n|\r|\n|\u0003/).length;
    }

    function tbFx(lab, key) { return "effect(" + tbQ(lab[key]) + ")(1)"; }

    // The box rectangle: size, position and the point it grows from, for the whole text (src = "parent")
    // or for one line (src = the helper layer, shifted down by the line's place).
    function tbRectCode(lab, src, line, marker) {
        var head = "var c=" + tbFx(lab, "side") + ", v=" + tbFx(lab, "vert") + ", r=" + src + ".sourceRectAtTime(time,false), dy=0;";
        if (line > 0) {
            head += "var m=parent.sourceRectAtTime(time,false), n=String(parent.text.sourceText).split(" + TB_LINE_SPLIT + ").length, ld;" +
                "try{var st=parent.text.sourceText.style; ld=st.autoLeading?st.fontSize*1.2:st.leading;}catch(e){ld=n>1?(m.height-r.height)/(n-1):0;}" +
                "dy=" + line + "*ld;";
        }
        var y = marker ? "r.top+r.height*0.79+dy" : "r.top+r.height/2+dy";
        var h = marker ? "r.height*0.42+2*v" : "r.height+2*v";
        return {
            size: head + "r.width>0?[r.width+2*c," + h + "]:[0,0];",
            pos: head + "[r.left+r.width/2," + y + "];",
            left: head + "[r.left-c," + y + "];"
        };
    }

    function tbGroup(B, comp, lab, o, src, line, k) {
        var gi = acGroup(B), ri, fi, si, code = tbRectCode(lab, src, line, o.style === "marker"), from = code.left;
        try { acP(B, ["ADBE Root Vectors Group", gi]).name = (lab.part || "Box") + " " + (line + 1); } catch (e0) {}
        ri = acIn(B, gi, "ADBE Vector Shape - Rect");
        acGP(B, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Size"]).expression = code.size;
        acGP(B, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Position"]).expression = code.pos;
        acGP(B, gi, ["ADBE Vectors Group", ri, "ADBE Vector Rect Roundness"]).expression = tbFx(lab, "round");
        si = acIn(B, gi, "ADBE Vector Graphic - Stroke");
        acGP(B, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Color"]).expression = tbFx(lab, "strokeColor");
        acGP(B, gi, ["ADBE Vectors Group", si, "ADBE Vector Stroke Width"]).expression = tbFx(lab, "strokeOn") + "?" + tbFx(lab, "strokeW") + ":0";
        fi = acIn(B, gi, "ADBE Vector Graphic - Fill");
        acGP(B, gi, ["ADBE Vectors Group", fi, "ADBE Vector Fill Color"]).expression = tbFx(lab, "color");
        acGP(B, gi, ["ADBE Vectors Group", fi, "ADBE Vector Fill Opacity"]).expression = tbFx(lab, "fillOn") + "?100:0";
        // The group's pivot is the left edge of its box; the slant leans it like a sports title. No animation.
        acGP(B, gi, ["ADBE Vector Transform Group", "ADBE Vector Anchor"]).expression = from;
        acGP(B, gi, ["ADBE Vector Transform Group", "ADBE Vector Position"]).expression = from;
        acGP(B, gi, ["ADBE Vector Transform Group", "ADBE Vector Skew"]).expression = "-" + tbFx(lab, "skew");
        return gi;
    }

    // A light filled box gets dark text (the panel preview's purple), anything else white: the new text stays readable.
    function tbTextColor(o) {
        var c = o.color || [0.23, 0.06, 0.39];
        if (o.look === "stroke" || o.style === "marker") { return [1, 1, 1]; }
        return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 0.6 ? [0.23, 0.06, 0.39] : [1, 1, 1];
    }

    function tbNewText(comp, text, color) {
        var t = comp.layers.addText(text), p, doc;
        try {
            p = acP(t, ["ADBE Text Properties", "ADBE Text Document"]);
            doc = p.value;
            doc.fontSize = Math.round(Math.min(comp.width, comp.height) * 0.08);
            doc.fillColor = color || [1, 1, 1];
            try { doc.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (e1) {}
            p.setValue(doc);
        } catch (e0) {}
        orbitSet(t, "ADBE Position", [comp.width / 2, comp.height / 2]);
        return t;
    }

    function tbBuild(comp, t, o, lab) {
        var B = comp.layers.addShape(), per = o.per === "line", n = per ? Math.min(16, tbLines(t) + 2) : 1;
        var c = o.color || [0.23, 0.06, 0.39], sc = o.strokeColor || [1, 1, 1], look = o.look || "fill", helpers = [], H, i, fx, base;
        B.name = (lab.box || "Box") + ": " + t.name;
        try { B.moveAfter(t); } catch (eM) {}
        // Controls first: the expressions below read them.
        kitControl(B, "ADBE Slider Control", lab.side, orbitNum(o.px, 0, 1000, 18));
        kitControl(B, "ADBE Slider Control", lab.vert, orbitNum(o.py, 0, 1000, 6));
        kitControl(B, "ADBE Slider Control", lab.round, orbitNum(o.round, 0, 1000, 0));
        kitControl(B, "ADBE Color Control", lab.color, [c[0], c[1], c[2], 1]);
        kitControl(B, "ADBE Checkbox Control", lab.fillOn, look === "stroke" ? 0 : 1);
        kitControl(B, "ADBE Checkbox Control", lab.strokeOn, look === "fill" ? 0 : 1);
        kitControl(B, "ADBE Slider Control", lab.strokeW, orbitNum(o.stroke, 0, 200, 4));
        kitControl(B, "ADBE Color Control", lab.strokeColor, [sc[0], sc[1], sc[2], 1]);
        kitControl(B, "ADBE Slider Control", lab.skew, orbitNum(o.skew, -60, 60, 0));
        if (o.shadow) {
            fx = acAdd(B, ["ADBE Effect Parade"], "ADBE Drop Shadow");
            kitSet(B, fx, "ADBE Drop Shadow-0004", 10);
            kitSet(B, fx, "ADBE Drop Shadow-0005", 0);
        }
        // A neon look: the box glows in its own colour.
        if (o.glow) {
            try {
                fx = acAdd(B, ["ADBE Effect Parade"], "ADBE Glo2");
                kitSet(B, fx, "ADBE Glo2-0003", 25);
                kitSet(B, fx, "ADBE Glo2-0004", 1.5);
            } catch (eG) {}
        }
        B.parent = t;
        orbitSet(B, "ADBE Anchor Point", [0, 0]);
        orbitSet(B, "ADBE Position", [0, 0]);
        orbitSet(B, "ADBE Scale", [100, 100]);
        try { orbitSet(B, "ADBE Rotate Z", 0); } catch (eR) {}
        orbitSet(B, "ADBE Opacity", orbitNum(o.opacity, 0, 100, 100));
        if (!per) {
            tbGroup(B, comp, lab, o, "parent", 0, 0);
        } else {
            base = (lab.helper || "Box line") + " " + t.name + " ";
            for (i = 0; i < n; i++) {
                H = comp.layers.addText("");
                try { acP(H, ["ADBE Text Properties", "ADBE Text Document"]).setValue(acP(t, ["ADBE Text Properties", "ADBE Text Document"]).value); } catch (eD) {}
                H.name = base + (i + 1);
                acP(H, ["ADBE Text Properties", "ADBE Text Document"]).expression =
                    "var L=String(parent.text.sourceText).split(" + TB_LINE_SPLIT + ");L.length>" + i + "?L[" + i + "]:\"\"";
                try { H.moveAfter(B); } catch (eH) {}
                H.parent = t;
                orbitSet(H, "ADBE Anchor Point", [0, 0]);
                orbitSet(H, "ADBE Position", [0, 0]);
                orbitSet(H, "ADBE Opacity", 0);
                try { H.shy = true; } catch (eS) {}
                // Helpers are shy and the comp hides shy layers: the timeline shows only the text and its box.
                try { comp.hideShyLayers = true; } catch (eY) {}
                helpers.push(H);
                tbGroup(B, comp, lab, o, "thisComp.layer(" + tbQ(H.name) + ")", i, i);
            }
        }
        try { B.selected = false; } catch (e1) {}
        return { box: B.name, lines: per ? n : 0, helpers: helpers.length };
    }

    // ---- Split / merge shapes (the Shape tab).
    // One shape layer: every group of its Contents becomes its own layer (a copy of the layer that keeps only
    // that group, so transform, effects, keys and expressions stay as they were). A layer with several masks
    // splits by masks the same way. Several shape layers: their contents go into one new shape layer, each
    // layer as a group whose transform is the layer's transform, so nothing moves.
    var SM_PATHS = { "ADBE Vector Shape - Group": 1, "ADBE Vector Shape - Rect": 1, "ADBE Vector Shape - Ellipse": 1, "ADBE Vector Shape - Star": 1 };
    var SM_TR = [["ADBE Anchor Point", "ADBE Vector Anchor"], ["ADBE Position", "ADBE Vector Position"], ["ADBE Scale", "ADBE Vector Scale"],
        ["ADBE Rotate Z", "ADBE Vector Rotation"], ["ADBE Opacity", "ADBE Vector Group Opacity"]];

    function smGroupsIn(level) {
        var out = [], i;
        if (!level) { return out; }
        for (i = 1; i <= level.numProperties; i++) { if (level.property(i).matchName === "ADBE Vector Group") { out.push(i); } }
        return out;
    }

    // Where the pieces are: the top of Contents, or inside its only group when that group holds several.
    function smPieces(layer) {
        var root = layer.property("ADBE Root Vectors Group"), top = smGroupsIn(root), inner;
        if (top.length === 1) {
            inner = smGroupsIn(root.property(top[0]).property("ADBE Vectors Group"));
            if (inner.length >= 2) { return { outer: top[0], groups: inner }; }
        }
        return { outer: 0, groups: top };
    }

    function smLevel(layer, pc) {
        var root = layer.property("ADBE Root Vectors Group");
        return pc.outer ? root.property(pc.outer).property("ADBE Vectors Group") : root;
    }

    function smSplitGroups(L, pc) {
        var made = [], names = [], level = smLevel(L, pc), k, j, copy, lv, it, keep;
        for (k = 0; k < pc.groups.length; k++) { names.push(level.property(pc.groups[k]).name); }
        for (k = 0; k < pc.groups.length; k++) {
            copy = L.duplicate();
            lv = smLevel(copy, pc);
            for (j = lv.numProperties; j >= 1; j--) {
                it = lv.property(j);
                // Fills, strokes and modifiers outside the groups apply to every piece; loose paths go to the first one.
                keep = j === pc.groups[k] || (it.matchName !== "ADBE Vector Group" && !(SM_PATHS[it.matchName] && k > 0));
                if (!keep) { it.remove(); }
            }
            copy.name = names[k];
            made.push(copy);
        }
        return { made: made, names: names };
    }

    function smSplitMasks(L) {
        var masks = L.property("ADBE Mask Parade"), n = masks.numProperties, made = [], names = [], k, j, copy, mp, m;
        for (k = 1; k <= n; k++) { names.push(masks.property(k).name); }
        for (k = 1; k <= n; k++) {
            copy = L.duplicate();
            mp = copy.property("ADBE Mask Parade");
            for (j = n; j >= 1; j--) { if (j !== k) { mp.property(j).remove(); } }
            // Alone, a Subtract or Intersect mask would show the wrong part: it becomes Add.
            m = mp.property(1);
            try {
                if (typeof MaskMode !== "undefined" && m.maskMode !== MaskMode.ADD && m.maskMode !== MaskMode.NONE) { m.maskMode = MaskMode.ADD; }
            } catch (e) {}
            copy.name = L.name + " - " + names[k - 1];
            made.push(copy);
        }
        return { made: made, names: names };
    }

    function smSplit(comp, L) {
        var pc = null, r, kind, i, masks, nm;
        if (L.locked) { throw new Error("SM_LOCKED"); }
        if (L instanceof ShapeLayer) {
            pc = smPieces(L);
            if (pc.groups.length < 2) { pc = null; }
        }
        masks = L.property("ADBE Mask Parade");
        if (pc) { kind = "groups"; r = smSplitGroups(L, pc); }
        else if (masks && masks.numProperties >= 2) { kind = "masks"; r = smSplitMasks(L); }
        else { throw new Error(L instanceof ShapeLayer ? "SM_ONE_PIECE" : "SM_NOT_SHAPE"); }
        nm = L.name;
        L.remove();
        for (i = 0; i < r.made.length; i++) { r.made[i].selected = true; }
        return { split: { kind: kind, name: nm, count: r.made.length, names: r.names } };
    }

    function smResolve(layer, path) {
        var p = layer.property("ADBE Root Vectors Group"), i;
        for (i = 0; i < path.length; i++) { p = p.property(path[i]); }
        return p;
    }

    function smSetEase(d, k, a, b) {
        var n;
        for (n = a.length; n >= 1; n--) {
            try { d.setTemporalEaseAtKey(k, a.slice(0, n), b.slice(0, n)); return; } catch (e) {}
        }
    }

    // Value, keys (with their interpolation and ease) and expression of one property.
    function smCopyValue(s, d, fix) {
        var k, n;
        if (!d) { return; }
        if (!fix) { fix = function (v) { return v; }; }
        if (typeof PropertyValueType !== "undefined" && (s.propertyValueType === PropertyValueType.NO_VALUE || s.propertyValueType === PropertyValueType.CUSTOM_VALUE)) { return; }
        try {
            n = s.numKeys || 0;
            if (n > 0) {
                for (k = 1; k <= n; k++) { d.setValueAtTime(s.keyTime(k), fix(s.keyValue(k))); }
                for (k = 1; k <= n; k++) {
                    try { d.setInterpolationTypeAtKey(k, s.keyInInterpolationType(k), s.keyOutInterpolationType(k)); } catch (e1) {}
                    try { smSetEase(d, k, s.keyInTemporalEase(k), s.keyOutTemporalEase(k)); } catch (e2) {}
                    try { if (s.isSpatial && d.isSpatial) { d.setSpatialTangentsAtKey(k, fix(s.keyInSpatialTangent(k)), fix(s.keyOutSpatialTangent(k))); } } catch (e3) {}
                }
            } else {
                d.setValue(fix(s.value));
            }
        } catch (e) {}
        try { if (s.expression) { d.expression = s.expression; d.expressionEnabled = s.expressionEnabled !== false; } } catch (e4) {}
    }

    // Copies a group's children into the group at path inside layer N. The target is found again by its path
    // after every change, because After Effects drops older references when properties are added.
    function smCopyInto(src, N, path) {
        var indexed = src.propertyType === PropertyType.INDEXED_GROUP, i, s, dst, d;
        for (i = 1; i <= src.numProperties; i++) {
            s = src.property(i);
            dst = smResolve(N, path);
            d = null;
            try {
                if (indexed) {
                    if (!dst.canAddProperty || dst.canAddProperty(s.matchName)) { d = dst.addProperty(s.matchName); }
                } else {
                    d = dst.property(s.matchName);
                }
            } catch (e) { d = null; }
            if (!d) { continue; }
            if (s.propertyType === PropertyType.PROPERTY) { smCopyValue(s, d); continue; }
            if (indexed) { try { d.name = s.name; } catch (e2) {} }
            try { if (s.enabled === false) { d.enabled = false; } } catch (e3) {}
            smCopyInto(s, N, path.concat([d.propertyIndex]));
        }
    }

    function smXY(v) { return v && typeof v === "object" && typeof v.length === "number" ? [v[0], v[1]] : v; }

    // opt.reverse - the bottom layer becomes the first group (for "minus front"); opt.keep - the merged
    // layers are switched off instead of removed (and keep their children).
    function smMerge(comp, sel, opt) {
        var shapes = [], skipped = [], notes = [], i, j, L, N, w, wi, ci, tr, gt, s, c, minIn = null, maxOut = null, cx, cy, isIn, order;
        opt = opt || {};
        for (i = 0; i < sel.length; i++) { if (sel[i] instanceof ShapeLayer) { shapes.push(sel[i]); } else { skipped.push(sel[i].name); } }
        if (shapes.length < 2) { throw new Error("SM_NEED_SHAPES"); }
        for (i = 0; i < shapes.length; i++) { if (shapes[i].locked) { throw new Error("SM_LOCKED"); } }
        shapes.sort(function (a, b) { return a.index - b.index; });
        N = comp.layers.addShape();
        N.name = shapes[0].name + " + " + (shapes.length - 1);
        // The new layer's space is the comp's space: anchor and position both in the middle.
        cx = comp.width / 2; cy = comp.height / 2;
        tr = N.property("ADBE Transform Group");
        tr.property("ADBE Anchor Point").setValue([cx, cy]);
        tr.property("ADBE Position").setValue([cx, cy]);
        order = shapes.slice();
        if (opt.reverse) { order.reverse(); }
        for (i = 0; i < order.length; i++) {
            L = order[i];
            // A parent is let go first (After Effects keeps the layer where it is), so its transform is all there is.
            if (L.parent) { L.parent = null; }
            if (L.threeDLayer) { notes.push("3d"); }
            try { if (L.property("ADBE Effect Parade").numProperties) { notes.push("effects"); } } catch (e1) {}
            try { if (L.property("ADBE Mask Parade").numProperties) { notes.push("masks"); } } catch (e2) {}
            w = smResolve(N, []).addProperty("ADBE Vector Group");
            w.name = L.name;
            wi = w.propertyIndex;
            gt = L.property("ADBE Transform Group");
            for (j = 0; j < SM_TR.length; j++) {
                s = gt.property(SM_TR[j][0]);
                if (!s) { continue; }
                if (s.dimensionsSeparated) { notes.push("separated"); }
                smCopyValue(s, smResolve(N, [wi]).property("ADBE Vector Transform Group").property(SM_TR[j][1]), smXY);
            }
            ci = smResolve(N, [wi]).property("ADBE Vectors Group").propertyIndex;
            smCopyInto(L.property("ADBE Root Vectors Group"), N, [wi, ci]);
            if (minIn === null || L.inPoint < minIn) { minIn = L.inPoint; }
            if (maxOut === null || L.outPoint > maxOut) { maxOut = L.outPoint; }
        }
        // Layers that hung on the merged ones now hang on the new layer.
        for (j = 1; !opt.keep && j <= comp.numLayers; j++) {
            c = comp.layer(j);
            if (c === N || !c.parent) { continue; }
            isIn = false;
            for (i = 0; i < shapes.length; i++) { if (c.parent.index === shapes[i].index) { isIn = true; } }
            if (isIn && !c.locked) { c.parent = N; }
        }
        N.moveBefore(shapes[0]);
        N.inPoint = minIn;
        N.outPoint = maxOut;
        for (i = shapes.length - 1; i >= 0; i--) {
            if (opt.keep) { shapes[i].enabled = false; } else { shapes[i].remove(); }
        }
        for (j = 1; j <= comp.numLayers; j++) { comp.layer(j).selected = false; }
        N.selected = true;
        opt.layer = N;
        return { merged: { name: N.name, count: shapes.length, skipped: skipped, notes: notes } };
    }

    // ---- Pathfinder (the Shape tab): the selected shape layers become one shape layer with Merge Paths,
    // like Illustrator's Shape Modes. The shapes stay live: groups can still be moved and animated.
    // Merge Paths "Subtract" keeps the first path and cuts the next ones out of it, so for "minus front"
    // the bottom layer goes first. The colour comes from the layer Illustrator would keep.
    var PF_MODES = { unite: 2, front: 3, intersect: 4, exclude: 5, back: 3 };
    var PF_NAMES = { unite: "Unite", front: "Minus Front", intersect: "Intersect", exclude: "Exclude", back: "Minus Back" };
    var PF_PAINT = { "ADBE Vector Graphic - Fill": 1, "ADBE Vector Graphic - Stroke": 1, "ADBE Vector Graphic - G-Fill": 1, "ADBE Vector Graphic - G-Stroke": 1 };

    function pfFirstFill(prop) {
        var i, it, r;
        if (!prop) { return null; }
        for (i = 1; i <= prop.numProperties; i++) {
            it = prop.property(i);
            if (it.matchName === "ADBE Vector Graphic - Fill") {
                try { return it.property("ADBE Vector Fill Color").value; } catch (e) { return null; }
            }
            if (it.numProperties && it.matchName !== "ADBE Vector Transform Group") {
                r = pfFirstFill(it);
                if (r) { return r; }
            }
        }
        return null;
    }

    // The fills and strokes inside the merged groups would paint the old shapes: they are switched off.
    function pfMutePaint(prop) {
        var i, it;
        for (i = 1; i <= prop.numProperties; i++) {
            it = prop.property(i);
            if (PF_PAINT[it.matchName]) { try { it.enabled = false; } catch (e) {} }
            else if (it.numProperties && it.matchName !== "ADBE Vector Transform Group") { pfMutePaint(it); }
        }
    }

    function pfApply(comp, sel, mode, keep) {
        var shapes = [], i, colour, res, root, merge, fill, n, opt;
        if (!PF_MODES[mode]) { throw new Error("BAD_PF_MODE"); }
        for (i = 0; i < sel.length; i++) { if (sel[i] instanceof ShapeLayer) { shapes.push(sel[i]); } }
        if (shapes.length < 2) { throw new Error("PF_NEED_SHAPES"); }
        shapes.sort(function (a, b) { return a.index - b.index; });
        colour = pfFirstFill((mode === "front" ? shapes[shapes.length - 1] : shapes[0]).property("ADBE Root Vectors Group"));
        opt = { reverse: mode === "front", keep: keep };
        res = smMerge(comp, sel, opt);
        root = opt.layer.property("ADBE Root Vectors Group");
        n = root.numProperties;
        for (i = 1; i <= n; i++) { pfMutePaint(root.property(i)); }
        merge = root.addProperty("ADBE Vector Filter - Merge");
        merge.property("ADBE Vector Merge Type").setValue(PF_MODES[mode]);
        fill = root.addProperty("ADBE Vector Graphic - Fill");
        if (colour) { fill.property("ADBE Vector Fill Color").setValue(colour); }
        opt.layer.name = shapes[0].name + " - " + PF_NAMES[mode];
        return { pathfinder: { mode: mode, name: opt.layer.name, count: res.merged.count, skipped: res.merged.skipped, kept: !!keep, notes: res.merged.notes } };
    }

    function npCreate(comp, sel) {
        var roots = [], i, j, L, inSel, top = null, minIn = null, maxOut = null, threeD = false;
        var common, sameParent = true, sum = [0, 0, 0], cnt = 0, v, n, pos, locked;
        // Only the top of each chain inside the selection gets the null: links between selected layers stay.
        for (i = 0; i < sel.length; i++) {
            L = sel[i];
            inSel = false;
            for (j = 0; j < sel.length; j++) { if (L.parent && sel[j].index === L.parent.index) { inSel = true; } }
            if (!inSel) { roots.push(L); }
            if (top === null || L.index < top.index) { top = L; }
            if (minIn === null || L.inPoint < minIn) { minIn = L.inPoint; }
            if (maxOut === null || L.outPoint > maxOut) { maxOut = L.outPoint; }
            if (L.threeDLayer) { threeD = true; }
        }
        common = roots.length ? roots[0].parent : null;
        for (i = 0; i < roots.length; i++) {
            if ((roots[i].parent ? roots[i].parent.index : 0) !== (common ? common.index : 0)) { sameParent = false; }
        }
        if (!sameParent) { common = null; }
        n = comp.layers.addNull(comp.duration);
        n.name = sel.length ? "Parent Null" : "Null";
        if (!sel.length) {
            n.selected = true;
            return { name: n.name, count: 0, parentOf: "" };
        }
        if (threeD) { n.threeDLayer = true; }
        if (common) { n.parent = common; }
        // In the middle of the layers it will carry, when they share one space.
        if (sameParent) {
            for (i = 0; i < roots.length; i++) {
                v = npPos(roots[i]);
                if (v) { sum[0] += v[0]; sum[1] += v[1]; sum[2] += v[2] || 0; cnt++; }
            }
            if (cnt) {
                pos = n.property("ADBE Transform Group").property("ADBE Position");
                pos.setValue(threeD ? [sum[0] / cnt, sum[1] / cnt, sum[2] / cnt] : [sum[0] / cnt, sum[1] / cnt]);
            }
        }
        n.moveBefore(top);
        n.inPoint = minIn;
        n.outPoint = maxOut;
        for (i = 0; i < roots.length; i++) {
            locked = roots[i].locked;
            if (locked) { roots[i].locked = false; }
            roots[i].parent = n;
            if (locked) { roots[i].locked = true; }
        }
        for (i = 0; i < sel.length; i++) { try { sel[i].selected = false; } catch (eD) {} }
        n.selected = true;
        return { name: n.name, count: roots.length, parentOf: common ? common.name : "" };
    }

    // ---- decompose helpers

    function dcNote(res, what) {
        var i;
        for (i = 0; i < res.notes.length; i++) { if (res.notes[i] === what) { return; } }
        res.notes.push(what);
    }

    // True when the precomp layer shows its comp exactly as it is: nothing moved, scaled, turned or faded,
    // no parent, not 3D. Then the inner layers need no parent to look the same outside.
    function dcPlain(P) {
        var tr = P.property("ADBE Transform Group");
        var names = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"];
        var v = {}, i, pr;
        if (P.threeDLayer || P.parent) { return false; }
        if (!tr) { return true; }
        for (i = 0; i < names.length; i++) {
            pr = tr.property(names[i]);
            if (!pr) { continue; }
            if (pr.numKeys > 0 || (pr.expressionEnabled && pr.expression)) { return false; }
            v[names[i]] = pr.value;
        }
        if (v["ADBE Anchor Point"] && v["ADBE Position"] && (Math.abs(v["ADBE Anchor Point"][0] - v["ADBE Position"][0]) > 0.001 || Math.abs(v["ADBE Anchor Point"][1] - v["ADBE Position"][1]) > 0.001)) { return false; }
        if (v["ADBE Scale"] && (Math.abs(v["ADBE Scale"][0] - 100) > 0.001 || Math.abs(v["ADBE Scale"][1] - 100) > 0.001)) { return false; }
        if (v["ADBE Rotate Z"] && Math.abs(v["ADBE Rotate Z"]) > 0.001) { return false; }
        if (v["ADBE Opacity"] !== undefined && Math.abs(v["ADBE Opacity"] - 100) > 0.001) { return false; }
        return true;
    }

    function dcJump(child, parent) {
        if (typeof child.setParentWithJump === "function") { child.setParentWithJump(parent); return true; }
        return false;
    }

    function dcCount(P, group) {
        var g = P.property(group);
        return g && g.numProperties ? g.numProperties : 0;
    }

    function dcOne(comp, P, res) {
        var S = P.source, n = S.numLayers, src = [], copies = [], locked = [];
        var off = P.startTime, pin = P.inPoint, pout = P.outPoint, T = null;
        var i, c, o, k, tm, op;
        if (P.timeRemapEnabled || Math.abs(P.stretch - 100) > 0.001) { res.skipped.push(P.name); return; }
        if (!n) { res.empty.push(P.name); return; }
        for (i = 1; i <= n; i++) { src.push(S.layer(i)); }
        // Every copy lands on top of the comp; copying from the bottom up keeps the order.
        for (i = n; i >= 1; i--) {
            src[i - 1].copyToComp(comp);
            copies[i - 1] = comp.layer(1);
        }
        for (i = 0; i < n; i++) {
            c = copies[i];
            locked[i] = c.locked;
            if (c.locked) { c.locked = false; }
            c.moveBefore(P);
        }
        // Times inside the precomp count from its start; outside only what the precomp showed stays visible.
        for (i = 0; i < n; i++) {
            c = copies[i];
            if (off) { c.startTime = c.startTime + off; }
            if (c.outPoint > pin && c.inPoint < pout) {
                o = c.outPoint;
                if (c.inPoint < pin) { c.inPoint = pin; }
                c.outPoint = Math.min(o, pout);
            }
        }
        // Parents and track mattes point at the copies, not at the layers left inside.
        for (i = 0; i < n; i++) {
            if (src[i].parent) {
                k = src[i].parent.index;
                if (!dcJump(copies[i], copies[k - 1])) { dcNote(res, "parents"); }
            }
            if (typeof copies[i].setTrackMatte === "function" && src[i].hasTrackMatte && src[i].trackMatteLayer) {
                tm = src[i].trackMatteLayer.index;
                copies[i].setTrackMatte(copies[tm - 1], src[i].trackMatteType);
            }
        }
        // Moved, scaled or turned precomp: its copy stays as an invisible parent so everything keeps its place.
        if (!dcPlain(P)) {
            T = P.duplicate();
            T.name = P.name + " [transform]";
            T.enabled = false;
            if (T.hasAudio) { T.audioEnabled = false; }
            for (i = 0; i < n; i++) {
                if (!src[i].parent && !dcJump(copies[i], T)) { dcNote(res, "parents"); }
            }
            op = P.property("ADBE Transform Group") ? P.property("ADBE Transform Group").property("ADBE Opacity") : null;
            if (op && (op.numKeys > 0 || Math.abs(op.value - 100) > 0.001)) { dcNote(res, "opacity"); }
        }
        if (dcCount(P, "ADBE Effect Parade")) { dcNote(res, "effects"); }
        if (dcCount(P, "ADBE Mask Parade")) { dcNote(res, "masks"); }
        for (i = 0; i < n; i++) {
            if (locked[i]) { copies[i].locked = true; }
        }
        res.names.push(P.name);
        P.remove();
        for (i = 0; i < n; i++) { try { copies[i].selected = true; } catch (eSel) {} }
        res.precomps++;
        res.layers += n;
        if (T) { res.transform = (res.transform || 0) + 1; }
    }

    // ---- project organizer helpers

    var ORG_FOLDERS = {
        Compositions: ["compositions", "composition", "comps", "comp"],
        Precomps: ["precomps", "precomp", "pre-comps", "pre-comp", "pre comps", "precompositions"],
        Videos: ["videos", "video"],
        Audio: ["audio", "audio / mp3", "audio/mp3", "mp3", "sound", "sounds", "music", "sfx"],
        Images: ["images", "image", "pictures", "photos", "stills"],
        Solids: ["solids", "solid"],
        Assets: ["assets", "asset", "resources"],
        Other: ["other", "misc"]
    };
    var ORG_VIDEO = ",mov,mp4,m4v,avi,mkv,webm,mxf,mpg,mpeg,m2v,m2ts,mts,ts,wmv,flv,3gp,r3d,braw,dv,ogv,gif,swf,";
    var ORG_AUDIO = ",mp3,wav,aif,aiff,aac,m4a,ogg,flac,wma,caf,";
    var ORG_IMAGE = ",png,jpg,jpeg,jpe,tif,tiff,psd,psb,ai,eps,pdf,svg,bmp,tga,exr,dpx,cin,hdr,heic,heif,webp,dng,cr2,cr3,nef,arw,raw,iff,pct,pict,sgi,";
    var ORG_ASSET = ",json,mgjson,csv,tsv,txt,obj,c4d,fbx,gltf,glb,usd,usdz,aep,aepx,prproj,mogrt,ttf,otf,";

    function orgFolderCategory(name) {
        var low = String(name).toLowerCase().replace(/^\s+|\s+$/g, "");
        var k, i;
        for (k in ORG_FOLDERS) {
            if (ORG_FOLDERS.hasOwnProperty(k)) {
                for (i = 0; i < ORG_FOLDERS[k].length; i++) {
                    if (ORG_FOLDERS[k][i] === low) { return k; }
                }
            }
        }
        return null;
    }

    function orgExt(name) {
        var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
        return m ? m[1].toLowerCase() : "";
    }

    function orgCategory(item, used) {
        var src, ext, fname = "", seq;
        if (item instanceof CompItem) { return used["i" + item.id] ? "Precomps" : "Compositions"; }
        src = item.mainSource;
        if (!src) { return "Other"; }
        if (src instanceof SolidSource) { return "Solids"; }
        if (typeof PlaceholderSource !== "undefined" && src instanceof PlaceholderSource) { return "Other"; }
        try { if (src.file) { fname = src.file.name; } } catch (e0) {}
        if (!fname) { try { fname = src.missingFootagePath || ""; } catch (e1) {} }
        try { fname = decodeURI(fname); } catch (e2) {}
        ext = orgExt(fname) || orgExt(item.name);
        seq = !src.isStill && item.duration > 0;
        if (ext && ORG_VIDEO.indexOf("," + ext + ",") >= 0) { return "Videos"; }
        if (ext && ORG_AUDIO.indexOf("," + ext + ",") >= 0) { return "Audio"; }
        if (ext && ORG_IMAGE.indexOf("," + ext + ",") >= 0) { return (seq && item.hasVideo) ? "Videos" : "Images"; }
        if (ext && ORG_ASSET.indexOf("," + ext + ",") >= 0) { return "Assets"; }
        if (item.hasVideo) { return src.isStill ? "Images" : "Videos"; }
        if (item.hasAudio) { return "Audio"; }
        if (fname && !item.footageMissing) { return "Assets"; }
        return "Other";
    }

    // Is the item already somewhere inside a folder of this category?
    function orgInside(item, cat, root) {
        var f = item.parentFolder;
        var depth = 0;
        while (f && f !== root && depth < 64) {
            if (orgFolderCategory(f.name) === cat) { return true; }
            f = f.parentFolder;
            depth++;
        }
        return false;
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

    // ----------------------------------------------------- animation tools

    function activeComp() {
        var item = app.project.activeItem;
        if (!item || !(item instanceof CompItem)) { throw new Error("NO_ACTIVE_COMP"); }
        return item;
    }

    // ------------------------------------------------------- quick export
    // H.264 template of the output module by quality: light 5, normal 15, max 40 Mbps (the names
    // After Effects 2023+ ships). Falls back to any H.264 template, then to anything MP4.
    // mbps (optional) asks for that bitrate; the nearest H.264 template wins.
    function exTemplate(list, quality, mbps) {
        var want = Number(mbps) > 0 ? Number(mbps) : (quality === "light" ? 5 : (quality === "max" ? 40 : 15)), i, m, best = "", any = "", mp4 = "", d, bestD = 1e9;
        list = list || [];
        for (i = 0; i < list.length; i++) {
            m = /H\.?264.*?(\d+)\s*Mbps/i.exec(String(list[i]));
            if (m) {
                d = Math.abs(Number(m[1]) - want);
                if (d < bestD) { bestD = d; best = String(list[i]); }
            }
            if (!any && /H\.?264/i.test(String(list[i]))) { any = String(list[i]); }
            if (!mp4 && /mp4/i.test(String(list[i]))) { mp4 = String(list[i]); }
        }
        return best || any || mp4;
    }

    function exSafe(s) { return String(s).replace(/[\\\/:\*\?"<>\|]/g, "_").replace(/^\s+|\s+$/g, ""); }

    // A file name that is not taken yet: "Name.mp4", "Name 2.mp4", ...
    function exFreeFile(folder, base, ext) {
        var f = new File(folder + "/" + base + ext), n = 2;
        while (f.exists && n < 500) { f = new File(folder + "/" + base + " " + n + ext); n++; }
        return f;
    }

    function exBin(name) {
        var proj = app.project, i;
        for (i = 1; i <= proj.numItems; i++) {
            if (proj.item(i) instanceof FolderItem && String(proj.item(i).name) === name) { return proj.item(i); }
        }
        return proj.items.addFolder(name);
    }

    function exScale(layer, s) {
        try { layer.property("ADBE Transform Group").property("ADBE Scale").setValue([s, s]); } catch (e) {}
    }

    // A comp of the platform's size with the source comp inside: fit (black bars), crop (cover),
    // or blur (fit, over a blurred cover copy that fills the edges).
    // Bitrate (Mbps) written in an H.264 template's name, 0 when none.
    function exTplRate(tpl) { var m = /H\.?264.*?(\d+)\s*Mbps/i.exec(String(tpl || "")); return m ? Number(m[1]) : 0; }

    // ---- Media Encoder at any bitrate. After Effects has H.264 templates only for 5 / 15 / 40 Mbps, so for
    // another bitrate AE renders a 40 Mbps file first and Media Encoder re-encodes it with a preset made
    // from its own H.264 preset ("Match Source - High bitrate"), the bitrate changed.
    var exEprBase = null;

    function exReadText(f) {
        var t = "";
        try { f.encoding = "UTF-8"; if (f.open("r")) { t = f.read(); f.close(); } } catch (e) {}
        return t;
    }

    function exIsH264Epr(t) {
        return t.indexOf("<ParamIdentifier>ADBEVideoTargetBitrate</ParamIdentifier>") >= 0 && t.indexOf("<ExporterClassID>1313424203</ExporterClassID>") >= 0;
    }

    // Folders that hold Media Encoder's own presets, newest version first.
    function exEprDirs() {
        var roots = [], out = [], i, j, k, ames, apps, r;
        try { r = Folder.appPackage.parent.parent; if (r && r.exists) { roots.push(r); } } catch (e0) {}
        roots.push(new Folder("/Applications"), new Folder("C:/Program Files/Adobe"));
        for (i = 0; i < roots.length; i++) {
            if (!roots[i].exists) { continue; }
            ames = roots[i].getFiles(function (f) { return f instanceof Folder && /^Adobe Media Encoder/i.test(decodeURI(f.name)); }) || [];
            ames.sort(function (a, b) { return decodeURI(a.name) < decodeURI(b.name) ? 1 : -1; });
            for (j = 0; j < ames.length; j++) {
                out.push(new Folder(ames[j].fsName + "/MediaIO/systempresets"));
                apps = ames[j].getFiles(function (f) { return f instanceof Folder && /\.app$/i.test(decodeURI(f.name)); }) || [];
                for (k = 0; k < apps.length; k++) { out.push(new Folder(apps[k].fsName + "/Contents/MediaIO/systempresets")); }
            }
        }
        return out;
    }

    // The H.264 preset to start from: "Match Source - High bitrate" if found, else any H.264 one.
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

    // Sets the value of one parameter of an .epr text (the <ParamValue> inside its <ExporterParam>).
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

    // Writes "Sayframe N Mbps.epr" into the temp folder; returns its path or "".
    function exMakeEpr(mbps, w, h) {
        var t, f, dir, num = function (v) { return Math.round(v) === v ? v + "." : String(v); };
        if (!exEprBase) { exEprBase = exFindEpr() || false; }
        if (!exEprBase) { return ""; }
        t = exEprBase.text;
        t = exEprSet(t, "ADBEVideoTargetBitrate", num(mbps));
        t = exEprSet(t, "ADBEVideoMaxBitrate", num(Math.round(mbps * 1.25 * 10) / 10));
        t = exEprSet(t, "ADBEVideoMinBitrate", num(Math.max(0.5, Math.round(mbps * 0.5 * 10) / 10)));
        t = exEprSet(t, "ADBEVideoMatchSource", "true");
        t = exEprSet(t, "ADBEVideoWidth", String(w));
        t = exEprSet(t, "ADBEVideoHeight", String(h));
        t = t.replace(/<PresetID>[^<]*<\/PresetID>/, "<PresetID>" + exHex(8) + "-" + exHex(4) + "-" + exHex(4) + "-" + exHex(4) + "-" + exHex(12) + "</PresetID>");
        t = t.replace(/<PresetName>[^<]*<\/PresetName>/, "<PresetName>Sayframe " + mbps + " Mbps</PresetName>");
        dir = new Folder(Folder.temp.fsName + "/Sayframe");
        if (!dir.exists) { dir.create(); }
        f = new File(dir.fsName + "/Sayframe " + mbps + " Mbps.epr");
        f.encoding = "UTF-8";
        if (!f.open("w")) { return ""; }
        f.write(t);
        f.close();
        return f.fsName;
    }

    function exAmeTarget() { try { return BridgeTalk.getSpecifier("ame") || ""; } catch (e) { return ""; } }

    function exJs(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }

    // Sends the file to Media Encoder with the preset and starts its queue. The source is deleted
    // after the encode. Returns true when Media Encoder took it.
    function exSendAme(target, src, epr, out) {
        var bt = new BridgeTalk(), ok = false;
        bt.target = target;
        bt.body = "var fe = app.getFrontend(), w = fe.addFileToBatch(" + exJs(src) + ", \"H.264\", " + exJs(epr) + ", " + exJs(out) + ");" +
            "if (w) { try { w.addEventListener(\"onEncodeFinished\", function () { try { new File(" + exJs(src) + ").remove(); } catch (e) {} }, false); } catch (e1) {}" +
            " app.getEncoderHost().runBatch(); \"ok\"; } else { \"fail\"; }";
        bt.onResult = function (m) { ok = String(m.body) === "ok"; };
        bt.onError = function () { ok = false; };
        try { bt.send(90); } catch (e) { return false; }
        return ok;
    }

    function exWrap(comp, w, h, fit, name, binName) {
        var proj = app.project, c, bg, L, fx, sx = w / comp.width, sy = h / comp.height;
        var fitS = Math.min(sx, sy) * 100, cover = Math.max(sx, sy) * 100;
        c = proj.items.addComp(name, w, h, 1, comp.duration, comp.frameRate);
        try { c.parentFolder = exBin(binName); } catch (e0) {}
        try { c.bgColor = [0, 0, 0]; } catch (e1) {}
        if (fit === "blur") {
            bg = c.layers.add(comp);
            try { bg.name = "Blur"; } catch (e2) {}
            exScale(bg, cover * 1.06);
            try { bg.audioEnabled = false; } catch (e3) {}
            try {
                fx = bg.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
                fx.property("ADBE Gaussian Blur 2-0001").setValue(Math.max(30, Math.round(Math.max(w, h) / 28)));
                fx.property("ADBE Gaussian Blur 2-0003").setValue(1);
            } catch (e4) {}
        }
        L = c.layers.add(comp);
        exScale(L, fit === "crop" ? cover : fitS);
        return c;
    }

    function clampInfluence(v) {
        v = Number(v);
        if (isNaN(v)) { v = 33.33; }
        if (v < 0.1) { v = 0.1; }
        if (v > 100) { v = 100; }
        return v;
    }

    // One KeyframeEase per dimension of the property; speed 0 gives a full stop at the key.
    function easeList(count, influence) {
        var list = [];
        var i;
        for (i = 0; i < count; i++) { list.push(new KeyframeEase(0, influence)); }
        return list;
    }

    // Applies easing to the selected keyframes. mode: "both", "in" (arriving side only) or "out" (leaving side only).
    function easeSelectedKeys(comp, inInfluence, outInfluence, mode) {
        var props = comp.selectedProperties;
        var out = { keys: 0, properties: 0, failed: 0 };
        var i, k, p, sel, idx, curIn, curOut, n, inType, outType, touched;
        for (i = 0; i < props.length; i++) {
            p = props[i];
            if (p.propertyType !== PropertyType.PROPERTY || !p.numKeys) { continue; }
            sel = p.selectedKeys;
            if (!sel || !sel.length) { continue; }
            touched = false;
            for (k = 0; k < sel.length; k++) {
                idx = sel[k];
                try {
                    curIn = p.keyInTemporalEase(idx);
                    curOut = p.keyOutTemporalEase(idx);
                    n = curIn.length;
                    // The side that is not being changed keeps its interpolation type (linear, hold, bezier).
                    inType = (mode === "out") ? p.keyInInterpolationType(idx) : KeyframeInterpolationType.BEZIER;
                    outType = (mode === "in") ? p.keyOutInterpolationType(idx) : KeyframeInterpolationType.BEZIER;
                    p.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                    p.setTemporalEaseAtKey(idx,
                        (mode === "out") ? curIn : easeList(n, inInfluence),
                        (mode === "in") ? curOut : easeList(n, outInfluence));
                    if (inType !== KeyframeInterpolationType.BEZIER || outType !== KeyframeInterpolationType.BEZIER) {
                        p.setInterpolationTypeAtKey(idx, inType, outType);
                    }
                    // The panel calls this many times while a slider is dragged: the keys must stay selected.
                    try { p.setSelectedAtKey(idx, true); } catch (e2) {}
                    out.keys++;
                    touched = true;
                } catch (e) {
                    out.failed++;
                }
            }
            if (touched) { out.properties++; }
        }
        return out;
    }

    // ---- Ease copy (like EaseCopy): eases apart from values, values apart from eases.
    // A speed is stored twice: as it is, and relative to the average speed of its segment (the line to the
    // neighbouring key). On paste the relative speed is scaled to the target segment, so an ease taken from
    // a short move fits a long one, from Position fits Opacity, and it flips when the target moves the other way.

    function ecGroups(comp) {
        var props = comp.selectedProperties;
        var out = [];
        var i, k, p, sel, keys;
        for (i = 0; i < props.length; i++) {
            p = props[i];
            if (p.propertyType !== PropertyType.PROPERTY || !p.numKeys) { continue; }
            sel = p.selectedKeys;
            if (!sel || !sel.length) { continue; }
            keys = [];
            for (k = 0; k < sel.length; k++) { keys.push(sel[k]); }
            out.push({ prop: p, keys: keys });
        }
        return out;
    }

    // Match names from the layer down to the property, to find "the same property" on another layer.
    function ecPath(p) {
        var out = [], q = p;
        try {
            while (q && q.propertyDepth > 0) { out.unshift(String(q.matchName)); q = q.parentProperty; }
        } catch (e) {}
        return out;
    }

    function ecFind(layer, mp) {
        var q = layer, i;
        try {
            for (i = 0; i < mp.length; i++) { q = q.property(mp[i]); if (!q) { return null; } }
        } catch (e) { return null; }
        return q && q.propertyType === PropertyType.PROPERTY ? q : null;
    }

    // Nothing selected on the timeline but layers are: the same property on each selected layer, all its keys.
    function ecLayerTargets(comp, clip) {
        var layers = comp.selectedLayers, out = [], i, g, p, k, keys, seen = {};
        for (i = 0; i < layers.length; i++) {
            for (g = 0; g < clip.groups.length; g++) {
                if (!clip.groups[g].mp || !clip.groups[g].mp.length) { continue; }
                p = ecFind(layers[i], clip.groups[g].mp);
                if (!p || seen[i + ":" + clip.groups[g].mp.join("/")]) { continue; }
                seen[i + ":" + clip.groups[g].mp.join("/")] = 1;
                keys = [];
                for (k = 1; k <= p.numKeys; k++) { keys.push(k); }
                out.push({ prop: p, keys: keys, group: g, empty: !p.numKeys });
            }
        }
        return out;
    }

    // Selected properties that have no keys yet (the stopwatch is off): the paste creates the keys.
    function ecEmptySelected(comp) {
        var props = comp.selectedProperties, out = [], i, p;
        for (i = 0; i < props.length; i++) {
            p = props[i];
            if (p.propertyType !== PropertyType.PROPERTY || p.numKeys) { continue; }
            try { if (!p.canVaryOverTime) { continue; } } catch (e) {}
            out.push({ prop: p, keys: [], empty: true });
        }
        return out;
    }

    // Creates keys on a property that had none, from the time indicator, at the copied spacing.
    // mode "value": the copied values; "ease": the property's current value (the easing is what was asked for).
    function ecCreateKeys(comp, pair, mode) {
        var p = pair.dst.prop, src = pair.src.keys, now = p.value, times = [], j, t, keys = [];
        if (mode === "value") {
            if (pair.src.vt !== p.propertyValueType) { throw new Error("EC_TYPE"); }
            for (j = 0; j < src.length; j++) { if (src[j].v === null || src[j].v === undefined) { throw new Error("EC_TYPE"); } }
        }
        for (j = 0; j < src.length; j++) {
            t = comp.time + (typeof src[j].t === "number" ? src[j].t : j * 0.5);
            times.push(t);
            p.setValueAtTime(t, mode === "value" ? ecMakeValue(src[j].v) : now);
        }
        for (j = 0; j < times.length; j++) { keys.push(p.nearestKeyIndex(times[j])); }
        pair.dst.keys = keys;
        return keys.length;
    }

    function ecNums(v) {
        var r = [];
        var i;
        if (typeof v === "number") { return [v]; }
        if (v && typeof v === "object" && typeof v.length === "number") {
            for (i = 0; i < v.length; i++) {
                if (typeof v[i] !== "number") { return null; }
                r.push(v[i]);
            }
            return r;
        }
        return null;
    }

    // Average speed between keys a and b: one number per ease dimension. A spatial value (one ease for
    // several numbers) gets its length of travel; null when the segment does not exist or is not numeric.
    function ecSegment(p, a, b, dims) {
        var v0, v1, dt, d, sum;
        var out = [];
        if (a < 1 || b > p.numKeys) { return null; }
        v0 = ecNums(p.keyValue(a));
        v1 = ecNums(p.keyValue(b));
        dt = p.keyTime(b) - p.keyTime(a);
        if (!v0 || !v1 || v0.length !== v1.length || dt <= 0) { return null; }
        if (dims === 1 && v0.length > 1) {
            sum = 0;
            for (d = 0; d < v0.length; d++) { sum += (v1[d] - v0[d]) * (v1[d] - v0[d]); }
            return [Math.sqrt(sum) / dt];
        }
        for (d = 0; d < dims; d++) { out.push(d < v0.length ? (v1[d] - v0[d]) / dt : 0); }
        return out;
    }

    function ecSide(list, seg) {
        var r = [];
        var d, sp;
        for (d = 0; d < list.length; d++) {
            sp = list[d].speed;
            r.push({ s: sp, r: (seg && Math.abs(seg[d]) > 1e-9) ? sp / seg[d] : null, f: list[d].influence });
        }
        return r;
    }

    // Numbers and arrays stay as they are, a path becomes plain data; anything else (text) is not copied.
    function ecValue(v) {
        var n = ecNums(v);
        if (typeof v === "number") { return v; }
        if (n) { return n; }
        if (v && v.vertices) { return { shape: { v: v.vertices, i: v.inTangents, o: v.outTangents, c: !!v.closed } }; }
        return null;
    }

    function ecMakeValue(x) {
        var sh;
        if (x && x.shape) {
            sh = new Shape();
            sh.vertices = x.shape.v;
            sh.inTangents = x.shape.i;
            sh.outTangents = x.shape.o;
            sh.closed = x.shape.c;
            return sh;
        }
        return x;
    }

    // Speeds for one side of a target key: the copied side scaled to the target segment.
    function ecSpeeds(side, seg, dims, numeric) {
        var out = [];
        var d, e;
        for (d = 0; d < dims; d++) {
            e = side[Math.min(d, side.length - 1)];
            if (e.r !== null && e.r !== undefined && seg) { out.push(e.r * seg[d]); }
            else if (!numeric && e.r === null) { out.push(e.s); }
            else { out.push(0); }
        }
        return out;
    }

    function ecEases(side, speeds) {
        var r = [];
        var d;
        for (d = 0; d < speeds.length; d++) {
            r.push(new KeyframeEase(speeds[d], clampInfluence(side[Math.min(d, side.length - 1)].f)));
        }
        return r;
    }

    // Which copied group goes to which target: one group to every target, or group by group.
    function ecPairs(clip, targets) {
        var n = clip.groups.length;
        var out = [];
        var i;
        if (n !== 1 && n !== targets.length) { throw new Error("EC_PROPS:" + n + ":" + targets.length); }
        for (i = 0; i < targets.length; i++) {
            out.push({ src: clip.groups[n === 1 ? 0 : i], dst: targets[i] });
            if (targets[i].keys.length % out[i].src.keys.length !== 0) {
                throw new Error("EC_COUNT:" + out[i].src.keys.length + ":" + targets[i].keys.length);
            }
        }
        return out;
    }

    function ecPasteEase(pair, through) {
        var p = pair.dst.prop;
        var keys = pair.dst.keys;
        var src = pair.src.keys;
        var numeric = !!ecNums(p.keyValue(keys[0]));
        var plan = [];
        var j, idx, r, dims, inSp, outSp, mid, d, avg;
        // Speeds are worked out for every key first: changing one key must not change the next one's segment.
        for (j = 0; j < keys.length; j++) {
            idx = keys[j];
            r = src[j % src.length];
            dims = p.keyInTemporalEase(idx).length;
            inSp = ecSpeeds(r.i, ecSegment(p, idx - 1, idx, dims), dims, numeric);
            outSp = ecSpeeds(r.o, ecSegment(p, idx, idx + 1, dims), dims, numeric);
            mid = through && j > 0 && j < keys.length - 1 && idx > 1 && idx < p.numKeys;
            if (mid) {
                for (d = 0; d < dims; d++) { avg = (inSp[d] + outSp[d]) / 2; inSp[d] = avg; outSp[d] = avg; }
            }
            plan.push({ idx: idx, r: r, inSp: inSp, outSp: outSp, mid: mid });
        }
        for (j = 0; j < plan.length; j++) {
            idx = plan[j].idx;
            r = plan[j].r;
            p.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            try { p.setTemporalAutoBezierAtKey(idx, false); } catch (e1) {}
            try { p.setTemporalContinuousAtKey(idx, plan[j].mid ? true : !!r.c); } catch (e2) {}
            p.setTemporalEaseAtKey(idx, ecEases(r.i, plan[j].inSp), ecEases(r.o, plan[j].outSp));
            if (r.it !== KeyframeInterpolationType.BEZIER || r.ot !== KeyframeInterpolationType.BEZIER) {
                try { p.setInterpolationTypeAtKey(idx, r.it, r.ot); } catch (e3) {}
            }
            try { p.setSelectedAtKey(idx, true); } catch (e4) {}
        }
        return plan.length;
    }

    function ecPasteValue(pair) {
        var p = pair.dst.prop;
        var keys = pair.dst.keys;
        var src = pair.src.keys;
        var j, idx, r, inE, outE, it, ot;
        if (pair.src.vt !== p.propertyValueType) { throw new Error("EC_TYPE"); }
        for (j = 0; j < src.length; j++) { if (src[j].v === null || src[j].v === undefined) { throw new Error("EC_TYPE"); } }
        for (j = 0; j < keys.length; j++) {
            idx = keys[j];
            r = src[j % src.length];
            // The key keeps its own easing: it is read before the value changes and put back after.
            inE = p.keyInTemporalEase(idx);
            outE = p.keyOutTemporalEase(idx);
            it = p.keyInInterpolationType(idx);
            ot = p.keyOutInterpolationType(idx);
            p.setValueAtKey(idx, ecMakeValue(r.v));
            try { p.setTemporalEaseAtKey(idx, freshEases(inE), freshEases(outE)); } catch (e1) {}
            try { p.setInterpolationTypeAtKey(idx, it, ot); } catch (e2) {}
            try { p.setSelectedAtKey(idx, true); } catch (e3) {}
        }
        return keys.length;
    }

    function copyValue(v) {
        var r = [];
        var i;
        for (i = 0; i < v.length; i++) { r.push(v[i]); }
        return r;
    }

    // Writes a new value respecting keyframes. keyMode "shift" moves every keyframe by delta,
    // anything else adds (or replaces) a keyframe at the current time. Works for arrays and plain numbers.
    function writeValue(prop, value, delta, time, keyMode) {
        var k, v, i;
        if (!prop.numKeys) { prop.setValue(value); return; }
        if (keyMode !== "shift") { prop.setValueAtTime(time, value); return; }
        for (k = 1; k <= prop.numKeys; k++) {
            v = prop.keyValue(k);
            if (typeof v === "number") {
                v = v + delta;
            } else {
                v = copyValue(v);
                for (i = 0; i < v.length && i < delta.length; i++) { v[i] = v[i] + delta[i]; }
            }
            prop.setValueAtKey(k, v);
        }
    }

    // Position of a layer as three numbers, whether or not its dimensions are separated.
    function positionOf(tr, is3D) {
        var pos = tr.property("ADBE Position");
        var info = { separated: false, props: [pos], value: null, keyed: false };
        var v, i;
        if (pos.dimensionsSeparated) {
            info.separated = true;
            info.props = [tr.property("ADBE Position_0"), tr.property("ADBE Position_1")];
            if (is3D) { info.props.push(tr.property("ADBE Position_2")); }
            info.value = [info.props[0].value, info.props[1].value, is3D ? info.props[2].value : 0];
        } else {
            v = pos.value;
            info.value = [v[0], v[1], v.length > 2 ? v[2] : 0];
        }
        for (i = 0; i < info.props.length; i++) { if (info.props[i].numKeys > 0) { info.keyed = true; } }
        return info;
    }

    // How far (in the parent's space) the layer must move so that it stays in place
    // when its anchor point moves by (dx, dy) in the layer's own space.
    function positionShift2D(tr, dx, dy) {
        var scale = tr.property("ADBE Scale").value;
        var angle = tr.property("ADBE Rotate Z").value * Math.PI / 180;
        var sx = dx * scale[0] / 100;
        var sy = dy * scale[1] / 100;
        return [sx * Math.cos(angle) - sy * Math.sin(angle), sx * Math.sin(angle) + sy * Math.cos(angle), 0];
    }

    // 3D layers: After Effects itself converts the point, through an expression on a temporary null.
    function positionShift3D(comp, layer, point, current) {
        var nul = comp.layers.addNull();
        var src = nul.source;
        var result;
        try {
            nul.threeDLayer = true;
            nul.property("ADBE Transform Group").property("ADBE Position").expression =
                "var L = thisComp.layer(" + layer.index + ");\n" +
                "var p = L.toWorld([" + point[0] + "," + point[1] + "," + point[2] + "]);\n" +
                "if (L.hasParent) { p = L.parent.fromWorld(p); }\n" +
                "[p[0], p[1], p.length > 2 ? p[2] : 0];";
            result = nul.property("ADBE Transform Group").property("ADBE Position").valueAtTime(comp.time, false);
        } finally {
            try { nul.remove(); } catch (e1) {}
            try { if (src) { src.remove(); } } catch (e2) {}
        }
        return [result[0] - current[0], result[1] - current[1], result[2] - current[2]];
    }

    // Moves the anchor point of every selected layer to a point of its bounding box
    // (fx, fy from 0 to 1) without moving the layer on screen.
    function moveAnchor(comp, fx, fy, keyMode) {
        var selected = comp.selectedLayers;
        var layers = [];
        var out = { moved: 0, skipped: 0, unchanged: 0, failed: 0, total: 0 };
        var time = comp.time;
        var i, d, layer, tr, anchor, a, rect, nx, ny, dx, dy, pos, shift, newAnchor, is3D;

        for (i = 0; i < selected.length; i++) { layers.push(selected[i]); }
        out.total = layers.length;
        for (i = 0; i < layers.length; i++) {
            layer = layers[i];
            try {
                if (layer instanceof CameraLayer || layer instanceof LightLayer) { out.skipped++; continue; }
                is3D = layer.threeDLayer === true;
                tr = layer.property("ADBE Transform Group");
                anchor = tr.property("ADBE Anchor Point");
                pos = positionOf(tr, is3D);
                if (keyMode === "skip" && (anchor.numKeys > 0 || pos.keyed)) { out.skipped++; continue; }

                rect = layer.sourceRectAtTime(time, false);
                a = anchor.value;
                nx = rect.left + rect.width * fx;
                ny = rect.top + rect.height * fy;
                dx = nx - a[0];
                dy = ny - a[1];
                if (Math.abs(dx) < 0.0005 && Math.abs(dy) < 0.0005) { out.unchanged++; continue; }

                // Work out the compensation first: nothing is changed if this step fails.
                shift = is3D ?
                    positionShift3D(comp, layer, [nx, ny, a.length > 2 ? a[2] : 0], pos.value) :
                    positionShift2D(tr, dx, dy);

                newAnchor = copyValue(a);
                newAnchor[0] = nx;
                newAnchor[1] = ny;
                writeValue(anchor, newAnchor, [dx, dy, 0], time, keyMode);

                if (pos.separated) {
                    for (d = 0; d < pos.props.length; d++) {
                        writeValue(pos.props[d], pos.value[d] + shift[d], shift[d], time, keyMode);
                    }
                } else {
                    a = copyValue(pos.props[0].value);
                    for (d = 0; d < a.length && d < 3; d++) { a[d] = pos.value[d] + shift[d]; }
                    writeValue(pos.props[0], a, shift, time, keyMode);
                }
                out.moved++;
            } catch (e) {
                out.failed++;
            }
        }
        // The temporary null used for 3D layers changes the selection; put it back.
        for (i = 0; i < layers.length; i++) { try { layers[i].selected = true; } catch (e3) {} }
        return out;
    }

    // ---- align

    // A 2D layer's transform as a matrix [a, b, c, d, tx, ty]: x' = a*x + c*y + tx, y' = b*x + d*y + ty.
    // It maps a point of the layer to the layer's parent (or to the composition when there is no parent).
    function layerMatrix(layer) {
        var tr = layer.property("ADBE Transform Group");
        var anchor = tr.property("ADBE Anchor Point").value;
        var pos = positionOf(tr, false).value;
        var scale = tr.property("ADBE Scale").value;
        var angle = tr.property("ADBE Rotate Z").value * Math.PI / 180;
        var cos = Math.cos(angle), sin = Math.sin(angle);
        var sx = scale[0] / 100, sy = scale[1] / 100;
        var a = sx * cos, b = sx * sin, c = -sy * sin, d = sy * cos;
        return [a, b, c, d, pos[0] - (a * anchor[0] + c * anchor[1]), pos[1] - (b * anchor[0] + d * anchor[1])];
    }

    // parent after child: the child's matrix is applied first.
    function matrixMul(p, c) {
        return [
            p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
            p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
            p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5]
        ];
    }

    function isFlatLayer(layer) {
        return !(layer instanceof CameraLayer) && !(layer instanceof LightLayer) && layer.threeDLayer !== true;
    }

    // Matrix from the space the layer's position lives in (its parent) to the composition.
    // Returns null when a parent is a 3D layer, a camera or a light: that needs a camera view, not this maths.
    function parentMatrix(layer) {
        var m = [1, 0, 0, 1, 0, 0];
        var chain = [];
        var par = layer.parent;
        var i;
        while (par && chain.length < 1000) {
            if (!isFlatLayer(par)) { return null; }
            chain.push(par);
            par = par.parent;
        }
        for (i = chain.length - 1; i >= 0; i--) { m = matrixMul(m, layerMatrix(chain[i])); }
        return m;
    }

    // The layer's bounds in the composition: the smallest upright box around its four corners.
    function compBox(layer, toComp, time) {
        var rect = layer.sourceRectAtTime(time, false);
        var m = matrixMul(toComp, layerMatrix(layer));
        var xs = [rect.left, rect.left + rect.width, rect.left, rect.left + rect.width];
        var ys = [rect.top, rect.top, rect.top + rect.height, rect.top + rect.height];
        var box = null;
        var i, x, y;
        for (i = 0; i < 4; i++) {
            x = m[0] * xs[i] + m[2] * ys[i] + m[4];
            y = m[1] * xs[i] + m[3] * ys[i] + m[5];
            if (!box) {
                box = { left: x, right: x, top: y, bottom: y };
            } else {
                if (x < box.left) { box.left = x; }
                if (x > box.right) { box.right = x; }
                if (y < box.top) { box.top = y; }
                if (y > box.bottom) { box.bottom = y; }
            }
        }
        return box;
    }

    // The selected layers this maths can move: 2D layers whose parents are 2D too. The rest is counted in out.
    function flatSelection(comp, out) {
        var selected = comp.selectedLayers;
        var time = comp.time;
        var items = [];
        var i, layer, toComp;
        for (i = 0; i < selected.length; i++) {
            layer = selected[i];
            try {
                if (!isFlatLayer(layer)) { out.skipped++; continue; }
                toComp = parentMatrix(layer);
                if (!toComp) { out.skipped++; continue; }
                items.push({ layer: layer, toComp: toComp, box: compBox(layer, toComp, time) });
            } catch (e) {
                out.failed++;
            }
        }
        return items;
    }

    // Moves one layer by (dx, dy) composition pixels and counts the outcome in out.
    // An animated position gets a keyframe at the current time, as After Effects' own Align does.
    function nudgeLayer(it, dx, dy, time, out) {
        var toComp, det, px, py, delta, tr, pos, v, d;
        if (Math.abs(dx) < 0.0005 && Math.abs(dy) < 0.0005) { out.unchanged++; return; }
        try {
            // The move is known in composition pixels; the position lives in the parent's space.
            toComp = it.toComp;
            det = toComp[0] * toComp[3] - toComp[1] * toComp[2];
            if (Math.abs(det) < 0.000000001) { out.failed++; return; }
            px = (toComp[3] * dx - toComp[2] * dy) / det;
            py = (-toComp[1] * dx + toComp[0] * dy) / det;
            delta = [px, py, 0];
            tr = it.layer.property("ADBE Transform Group");
            pos = positionOf(tr, false);
            if (pos.separated) {
                for (d = 0; d < 2; d++) {
                    if (Math.abs(delta[d]) >= 0.0000005) { writeValue(pos.props[d], pos.value[d] + delta[d], delta[d], time, "key"); }
                }
            } else {
                v = copyValue(pos.props[0].value);
                v[0] = pos.value[0] + px;
                v[1] = pos.value[1] + py;
                writeValue(pos.props[0], v, delta, time, "key");
            }
            out.moved++;
        } catch (e2) {
            out.failed++;
        }
    }

    // Where a box sits for the given edge: left, hcenter, right, top, vcenter or bottom.
    function edgeOf(box, edge) {
        if (edge === "left") { return box.left; }
        if (edge === "right") { return box.right; }
        if (edge === "hcenter") { return (box.left + box.right) / 2; }
        if (edge === "top") { return box.top; }
        if (edge === "bottom") { return box.bottom; }
        return (box.top + box.bottom) / 2;
    }

    function isHorizontalEdge(edge) {
        return edge === "left" || edge === "hcenter" || edge === "right";
    }

    // Aligns the selected layers. edge: left, hcenter, right, top, vcenter or bottom.
    // target "comp" aligns to the composition frame, "selection" to the box around all selected layers.
    function alignLayers(comp, edge, target) {
        var time = comp.time;
        var out = { moved: 0, unchanged: 0, skipped: 0, failed: 0, total: comp.selectedLayers.length };
        var items = flatSelection(comp, out);
        var goal = null;
        var i, box, d;

        if (target === "selection") {
            if (items.length < 2) { throw new Error("ALIGN_NEEDS_TWO"); }
            for (i = 0; i < items.length; i++) {
                box = items[i].box;
                if (!goal) {
                    goal = { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
                } else {
                    if (box.left < goal.left) { goal.left = box.left; }
                    if (box.right > goal.right) { goal.right = box.right; }
                    if (box.top < goal.top) { goal.top = box.top; }
                    if (box.bottom > goal.bottom) { goal.bottom = box.bottom; }
                }
            }
        } else {
            goal = { left: 0, top: 0, right: comp.width, bottom: comp.height };
        }

        for (i = 0; i < items.length; i++) {
            d = edgeOf(goal, edge) - edgeOf(items[i].box, edge);
            if (isHorizontalEdge(edge)) { nudgeLayer(items[i], d, 0, time, out); } else { nudgeLayer(items[i], 0, d, time, out); }
        }
        return out;
    }

    // Spreads the selected layers evenly, as After Effects' "Distribute Layers" does: the two outermost
    // layers stay where they are, the ones between them get equal steps between the chosen edges
    // (left, hcenter, right, top, vcenter or bottom). Needs at least three layers.
    function distributeLayers(comp, edge) {
        var time = comp.time;
        var out = { moved: 0, unchanged: 0, skipped: 0, failed: 0, total: comp.selectedLayers.length };
        var items = flatSelection(comp, out);
        var i, first, last, d;

        if (items.length < 3) { throw new Error("DISTRIBUTE_NEEDS_THREE"); }
        for (i = 0; i < items.length; i++) { items[i].at = edgeOf(items[i].box, edge); items[i].order = i; }
        // Equal positions keep the order the layers were selected in, so the result does not jump around.
        items.sort(function (a, b) { return a.at !== b.at ? a.at - b.at : a.order - b.order; });
        first = items[0].at;
        last = items[items.length - 1].at;
        out.spread = items.length;
        for (i = 1; i < items.length - 1; i++) {
            d = first + (last - first) * i / (items.length - 1) - items[i].at;
            if (isHorizontalEdge(edge)) { nudgeLayer(items[i], d, 0, time, out); } else { nudgeLayer(items[i], 0, d, time, out); }
        }
        return out;
    }

    // ---- shifting in time: the "in" and "out" animation of a layer, or the whole layer
    //
    // A layer's "in" animation is every keyframe and layer marker in the first half of the layer
    // (between its in point and its middle); the "out" animation is everything in the second half.
    // Moving one of them moves those keyframes. The layer's own edge goes with them when the
    // animation sits right at that edge, and is pushed out when the keyframes would leave the layer.

    var EDGE_FRAMES = 1.5;   // a first/last keyframe this close to the layer's edge counts as "at the edge"

    function layerSpan(layer) {
        var a = layer.inPoint, b = layer.outPoint;
        return a <= b ? { start: a, end: b } : { start: b, end: a };
    }

    // Calls fn for every property with keyframes inside the group (a layer is a group too).
    function eachKeyedProperty(group, fn, depth) {
        var n, i, p;
        try { n = group.numProperties; } catch (e) { return; }
        for (i = 1; i <= n; i++) {
            try {
                p = group.property(i);
                if (!p) { continue; }
                if (p.propertyType === PropertyType.PROPERTY) {
                    if (p.numKeys > 0) { fn(p); }
                } else if (depth < 40) {
                    eachKeyedProperty(p, fn, depth + 1);
                }
            } catch (e2) {}
        }
    }

    // which: "in" or "out". Returns the keyframes of that half: { list: [{ prop, times }], count, first, last }.
    function findTransition(layer, which) {
        var span = layerSpan(layer);
        var mid = (span.start + span.end) / 2;
        var out = { list: [], count: 0, first: 0, last: 0, span: span };
        eachKeyedProperty(layer, function (p) {
            var times = [];
            var k, t;
            for (k = 1; k <= p.numKeys; k++) {
                t = p.keyTime(k);
                if ((which === "in") === (t < mid)) { times.push(t); }
            }
            if (!times.length) { return; }
            if (!out.count || times[0] < out.first) { out.first = times[0]; }
            if (!out.count || times[times.length - 1] > out.last) { out.last = times[times.length - 1]; }
            out.count += times.length;
            out.list.push({ prop: p, times: times });
        }, 0);
        return out;
    }

    function freshEases(list) {
        var r = [];
        var i;
        for (i = 0; i < list.length; i++) { r.push(new KeyframeEase(list[i].speed, clampInfluence(list[i].influence))); }
        return r;
    }

    // After Effects cannot move a keyframe: it is read, removed and created again at the new time,
    // with its value, interpolation, easing, spatial tangents, selection and label.
    function moveKey(prop, idx, newTime) {
        var oldTime = prop.keyTime(idx);
        var d = { value: prop.keyValue(idx) };
        var n;
        try { d.inEase = prop.keyInTemporalEase(idx); d.outEase = prop.keyOutTemporalEase(idx); } catch (e1) { d.inEase = null; }
        try { d.inType = prop.keyInInterpolationType(idx); d.outType = prop.keyOutInterpolationType(idx); } catch (e2) { d.inType = null; }
        try { d.tCont = prop.keyTemporalContinuous(idx); d.tAuto = prop.keyTemporalAutoBezier(idx); d.hasTemporal = true; } catch (e3) {}
        try {
            if (prop.isSpatial) {
                d.inTan = prop.keyInSpatialTangent(idx);
                d.outTan = prop.keyOutSpatialTangent(idx);
                d.sCont = prop.keySpatialContinuous(idx);
                d.sAuto = prop.keySpatialAutoBezier(idx);
                d.roving = prop.keyRoving(idx);
                d.hasSpatial = true;
            }
        } catch (e4) {}
        try { d.selected = prop.keySelected(idx); } catch (e5) { d.selected = false; }
        try { d.label = prop.keyLabel(idx); } catch (e6) { d.label = null; }

        prop.removeKey(idx);
        try {
            prop.setValueAtTime(newTime, d.value);
        } catch (e7) {
            // Put it back where it was rather than lose it.
            try { prop.setValueAtTime(oldTime, d.value); newTime = oldTime; } catch (e8) { throw e7; }
        }
        n = prop.nearestKeyIndex(newTime);
        if (d.inEase) { try { prop.setTemporalEaseAtKey(n, freshEases(d.inEase), freshEases(d.outEase)); } catch (e9) {} }
        if (d.inType) { try { prop.setInterpolationTypeAtKey(n, d.inType, d.outType); } catch (e10) {} }
        if (d.hasSpatial) {
            try {
                prop.setSpatialTangentsAtKey(n, d.inTan, d.outTan);
                prop.setSpatialContinuousAtKey(n, d.sCont);
                prop.setSpatialAutoBezierAtKey(n, d.sAuto);
            } catch (e11) {}
        }
        if (d.hasTemporal) {
            try {
                prop.setTemporalContinuousAtKey(n, d.tCont);
                prop.setTemporalAutoBezierAtKey(n, d.tAuto);
            } catch (e12) {}
        }
        if (d.roving) { try { prop.setRovingAtKey(n, true); } catch (e13) {} }
        if (d.selected) { try { prop.setSelectedAtKey(n, true); } catch (e14) {} }
        if (d.label) { try { prop.setLabelAtKey(n, d.label); } catch (e15) {} }
        if (newTime === oldTime) { throw new Error("KEY_NOT_MOVED"); }
    }

    // Moves the listed keyframes of one property by dt seconds. The keys are found by their times,
    // far side first, so that a key never has to jump over one that is still waiting to move.
    function moveKeysOf(entry, dt, tolerance, out) {
        var times = entry.times;
        var i, t, idx;
        for (i = 0; i < times.length; i++) {
            t = dt > 0 ? times[times.length - 1 - i] : times[i];
            try {
                idx = entry.prop.nearestKeyIndex(t);
                if (Math.abs(entry.prop.keyTime(idx) - t) > tolerance) { out.keysFailed++; continue; }
                moveKey(entry.prop, idx, t + dt);
                out.keys++;
            } catch (e) {
                out.keysFailed++;
            }
        }
    }

    // Changes one edge of the layer and leaves the other where it was.
    function trimLayer(layer, start, end) {
        try {
            if (layer.stretch < 0) { return; }
            if (end - start <= 0) { return; }
            if (start !== layer.inPoint) { layer.inPoint = start; }
            if (end !== layer.outPoint) { layer.outPoint = end; }
        } catch (e) {}
    }

    // Returns "moved", "none" (no keyframes in that half), "same" (nothing to do) or "failed".
    function shiftTransition(layer, which, dt, frame, out) {
        var tr = findTransition(layer, which);
        var before = out.keys;
        var span = tr.span;
        var atEdge, i;
        if (!tr.count) { return "none"; }
        if (Math.abs(dt) < frame / 1000) { return "same"; }
        atEdge = which === "in" ? Math.abs(tr.first - span.start) <= frame * EDGE_FRAMES : Math.abs(tr.last - span.end) <= frame * EDGE_FRAMES;
        for (i = 0; i < tr.list.length; i++) { moveKeysOf(tr.list[i], dt, frame / 4, out); }
        if (out.keys === before) { return "failed"; }
        if (which === "in") {
            if (atEdge) { trimLayer(layer, span.start + dt, span.end); }
            else if (tr.first + dt < span.start) { trimLayer(layer, tr.first + dt, span.end); }
        } else {
            if (atEdge) { trimLayer(layer, span.start, span.end + dt); }
            else if (tr.last + dt > span.end) { trimLayer(layer, span.start, tr.last + dt + frame); }
        }
        return "moved";
    }

    function countShift(result, out) {
        if (result === "moved") { out.moved++; }
        else if (result === "none") { out.skipped++; }
        else if (result === "same") { out.unchanged++; }
        else { out.failed++; }
    }

    // Moves a whole layer (keyframes, markers, both edges) by dt seconds.
    function shiftLayer(layer, dt, frame, out) {
        if (Math.abs(dt) < frame / 1000) { out.unchanged++; return; }
        try {
            layer.startTime = layer.startTime + dt;
            out.moved++;
        } catch (e) {
            out.failed++;
        }
    }

    // Moves every keyframe of the layer by dt seconds (the "in" and the "out" animation together).
    // The layer itself stays; a key that would fall outside the layer stretches it.
    function shiftAllKeys(layer, dt, frame, out) {
        var a = findTransition(layer, "in");
        var b = findTransition(layer, "out");
        var span = a.span;
        var before = out.keys;
        var first, last, start, end, lists, i;
        if (!a.count && !b.count) { return "none"; }
        if (Math.abs(dt) < frame / 1000) { return "same"; }
        first = a.count ? a.first : b.first;
        last = b.count ? b.last : a.last;
        // Far side first, so that no key has to jump over one that is still waiting to move.
        lists = dt > 0 ? b.list.concat(a.list) : a.list.concat(b.list);
        for (i = 0; i < lists.length; i++) { moveKeysOf(lists[i], dt, frame / 4, out); }
        if (out.keys === before) { return "failed"; }
        // Only the keys move: the layer keeps its place and its edges. It grows only when a key would leave it
        // (otherwise After Effects would not play that key).
        start = Math.min(span.start, first + dt);
        end = Math.max(span.end, last + dt + frame);
        if (start < span.start - frame / 4 || end > span.end + frame / 4) { trimLayer(layer, start, end); }
        return "moved";
    }

    function shiftOne(layer, what, dt, frame, out) {
        if (what === "layer") { shiftLayer(layer, dt, frame, out); }
        else if (what === "keys") { countShift(shiftAllKeys(layer, dt, frame, out), out); }
        else { countShift(shiftTransition(layer, what, dt, frame, out), out); }
    }

    function hasKeysFor(layer, what) {
        if (what === "layer") { return true; }
        if (what === "keys") { return findTransition(layer, "in").count + findTransition(layer, "out").count > 0; }
        return findTransition(layer, what).count > 0;
    }

    function newShiftCount(total) {
        return { moved: 0, unchanged: 0, skipped: 0, failed: 0, keys: 0, keysFailed: 0, total: total };
    }

    // what: "in", "out" or "layer"; frames may be negative (earlier).
    function shiftSelected(comp, what, frames) {
        var layers = comp.selectedLayers;
        var frame = comp.frameDuration;
        var out = newShiftCount(layers.length);
        var i;
        for (i = 0; i < layers.length; i++) { shiftOne(layers[i], what, frames * frame, frame, out); }
        return out;
    }

    // Brings the start or the end of the "in"/"out" animation of every selected layer to the current time.
    // point: "inStart", "inEnd", "outStart" or "outEnd".
    function alignToTime(comp, point) {
        var layers = comp.selectedLayers;
        var frame = comp.frameDuration;
        var which = (point === "inStart" || point === "inEnd") ? "in" : "out";
        var useFirst = point === "inStart" || point === "outStart";
        var out = newShiftCount(layers.length);
        var i, tr;
        for (i = 0; i < layers.length; i++) {
            tr = findTransition(layers[i], which);
            if (!tr.count) { out.skipped++; continue; }
            countShift(shiftTransition(layers[i], which, comp.time - (useFirst ? tr.first : tr.last), frame, out), out);
        }
        return out;
    }

    // Where a layer starts for "align": the layer's in point, or its first keyframe.
    function alignPoint(layer, what) {
        var a, b;
        if (what === "layer") { return layer.inPoint; }
        a = findTransition(layer, "in");
        b = findTransition(layer, "out");
        return a.count ? a.first : b.first;
    }

    // Each next layer is moved `frames` frames further than the one before it.
    // what: "layer", "keys" (all keyframes), "in" or "out"; order: "asc" (from the top layer down), "desc" (from the bottom up), "selection" or "random".
    function staggerSelected(comp, what, frames, order) {
        var layers = comp.selectedLayers;
        var frame = comp.frameDuration;
        var out = newShiftCount(layers.length);
        var list = [];
        var i, j, tmp, step;
        for (i = 0; i < layers.length; i++) {
            // A layer with nothing to move does not take a step of the staircase.
            if (!hasKeysFor(layers[i], what)) { out.skipped++; continue; }
            list.push(layers[i]);
        }
        // "align": every layer (or its first key) to the time indicator, no staircase.
        // "alignEnd": the end of every layer (its out point) to the time indicator.
        if (order === "align" || order === "alignEnd") {
            if (!list.length) { throw new Error("STAGGER_NO_KEYS"); }
            for (i = 0; i < list.length; i++) {
                shiftOne(list[i], what, comp.time - (order === "alignEnd" ? list[i].outPoint : alignPoint(list[i], what)), frame, out);
            }
            out.aligned = true;
            if (order === "alignEnd") { out.toEnd = true; }
            return out;
        }
        if (list.length < 2) { throw new Error(layers.length < 2 ? "STAGGER_NEEDS_TWO" : "STAGGER_NO_KEYS"); }
        if (order === "asc" || order === "desc") {
            list.sort(function (a, b) { return order === "asc" ? a.index - b.index : b.index - a.index; });
        } else if (order === "random") {
            for (i = list.length - 1; i > 0; i--) {
                j = Math.floor(Math.random() * (i + 1));
                tmp = list[i]; list[i] = list[j]; list[j] = tmp;
            }
        }
        step = 0;
        for (i = 0; i < list.length; i++) {
            if (i === 0) { out.unchanged++; continue; }
            step += frames * frame;
            shiftOne(list[i], what, step, frame, out);
        }
        out.steps = list.length;
        return out;
    }

    // ---- Key actions in the stagger block, keys mode (like Animation Composer's Keyframe Actions).
    // They work on the selected keyframes of the selected layers; with no keyframe selected, on all keys of those layers.
    // mode: "mirror" (the keys again, backwards, after the last one), "reverse" (same times, values in the opposite order),
    // "first"/"last" (each layer's first/last key to the time indicator, the rest follow), "clone" (a copy at the time indicator).

    function kaIsMarker(p) {
        try { if (p.matchName === "ADBE Marker") { return true; } } catch (e) {}
        try { p.keyInTemporalEase(1); } catch (e2) { return true; }
        return false;
    }

    // [{ layer, entries: [{ prop, times, marker }] }] and whether only selected keys were taken.
    function kaCollect(comp) {
        var layers = comp.selectedLayers, out = [], selected = false, i, j, k, list, sel, all, times;
        for (i = 0; i < layers.length; i++) {
            list = [];
            eachKeyedProperty(layers[i], function (p) {
                var s = [], a = [], n;
                try { sel = p.selectedKeys; } catch (e) { sel = null; }
                for (n = 0; sel && n < sel.length; n++) { s.push(p.keyTime(sel[n])); }
                for (n = 1; n <= p.numKeys; n++) { a.push(p.keyTime(n)); }
                list.push({ prop: p, sel: s, all: a });
            }, 0);
            out.push({ layer: layers[i], list: list });
            for (j = 0; j < list.length; j++) { if (list[j].sel.length) { selected = true; } }
        }
        for (i = 0; i < out.length; i++) {
            all = [];
            for (j = 0; j < out[i].list.length; j++) {
                times = selected ? out[i].list[j].sel : out[i].list[j].all;
                if (!times.length) { continue; }
                times.sort(function (a, b) { return a - b; });
                all.push({ prop: out[i].list[j].prop, times: times, marker: kaIsMarker(out[i].list[j].prop) });
            }
            out[i].entries = all;
            delete out[i].list;
        }
        for (k = out.length - 1; k >= 0; k--) { if (!out[k].entries.length) { out.splice(k, 1); } }
        return { layers: out, selected: selected };
    }

    function kaRead(prop, t) {
        var idx = prop.nearestKeyIndex(t);
        var d = { value: prop.keyValue(idx) };
        try { d.inEase = prop.keyInTemporalEase(idx); d.outEase = prop.keyOutTemporalEase(idx); } catch (e1) { d.inEase = null; }
        try { d.inType = prop.keyInInterpolationType(idx); d.outType = prop.keyOutInterpolationType(idx); } catch (e2) { d.inType = null; }
        try { d.tCont = prop.keyTemporalContinuous(idx); d.tAuto = prop.keyTemporalAutoBezier(idx); d.hasTemporal = true; } catch (e3) {}
        try {
            if (prop.isSpatial) {
                d.inTan = prop.keyInSpatialTangent(idx); d.outTan = prop.keyOutSpatialTangent(idx);
                d.sCont = prop.keySpatialContinuous(idx); d.sAuto = prop.keySpatialAutoBezier(idx);
                d.hasSpatial = true;
            }
        } catch (e4) {}
        try { d.label = prop.keyLabel(idx); } catch (e5) { d.label = null; }
        return d;
    }

    // Puts a key with d's value and look at time t. flip: the key now plays backwards, so its two sides swap.
    function kaWrite(prop, t, d, flip) {
        var n;
        prop.setValueAtTime(t, d.value);
        n = prop.nearestKeyIndex(t);
        if (d.inEase) { try { prop.setTemporalEaseAtKey(n, freshEases(flip ? d.outEase : d.inEase), freshEases(flip ? d.inEase : d.outEase)); } catch (e1) {} }
        if (d.inType) { try { prop.setInterpolationTypeAtKey(n, flip ? d.outType : d.inType, flip ? d.inType : d.outType); } catch (e2) {} }
        if (d.hasSpatial) {
            try {
                prop.setSpatialTangentsAtKey(n, flip ? d.outTan : d.inTan, flip ? d.inTan : d.outTan);
                prop.setSpatialContinuousAtKey(n, d.sCont);
                prop.setSpatialAutoBezierAtKey(n, d.sAuto);
            } catch (e3) {}
        }
        if (d.hasTemporal) { try { prop.setTemporalContinuousAtKey(n, d.tCont); prop.setTemporalAutoBezierAtKey(n, d.tAuto); } catch (e4) {} }
        if (d.label) { try { prop.setLabelAtKey(n, d.label); } catch (e5) {} }
    }

    // A key put outside the layer would not play: the layer grows to take it in.
    function kaFit(layer, first, last, frame) {
        var span = layerSpan(layer);
        var start = Math.min(span.start, first), end = Math.max(span.end, last + frame);
        if (start < span.start - frame / 4 || end > span.end + frame / 4) { trimLayer(layer, start, end); }
    }

    function keyActSelected(comp, mode) {
        var frame = comp.frameDuration;
        var got = kaCollect(comp);
        var out = { keys: 0, layers: 0, failed: 0, few: 0, selected: got.selected, mode: mode };
        var i, j, m, e, d, list, t0, lo, hi, dt, T, made, before, move;
        if (!got.layers.length) { throw new Error("KA_NO_KEYS"); }
        // Clone: one start for all layers, so the copies keep their timing against each other.
        t0 = null;
        for (i = 0; i < got.layers.length; i++) {
            for (j = 0; j < got.layers[i].entries.length; j++) {
                e = got.layers[i].entries[j];
                if (e.marker) { continue; }
                if (t0 === null || e.times[0] < t0) { t0 = e.times[0]; }
            }
        }
        for (i = 0; i < got.layers.length; i++) {
            made = 0; lo = null; hi = null;
            if (mode === "first" || mode === "last") {
                // Markers move with the animation, as in the stagger tool.
                for (j = 0; j < got.layers[i].entries.length; j++) {
                    e = got.layers[i].entries[j];
                    if (lo === null || e.times[0] < lo) { lo = e.times[0]; }
                    if (hi === null || e.times[e.times.length - 1] > hi) { hi = e.times[e.times.length - 1]; }
                }
                dt = comp.time - (mode === "first" ? lo : hi);
                if (Math.abs(dt) < frame / 1000) { out.layers++; continue; }
                move = { keys: 0, keysFailed: 0 };
                for (j = 0; j < got.layers[i].entries.length; j++) { moveKeysOf(got.layers[i].entries[j], dt, frame / 4, move); }
                out.keys += move.keys; out.failed += move.keysFailed;
                if (move.keys) { kaFit(got.layers[i].layer, lo + dt, hi + dt, frame); out.layers++; }
                continue;
            }
            for (j = 0; j < got.layers[i].entries.length; j++) {
                e = got.layers[i].entries[j];
                if (e.marker) { continue; }
                if ((mode === "mirror" || mode === "reverse") && e.times.length < 2) { out.few++; continue; }
                try {
                    list = [];
                    for (m = 0; m < e.times.length; m++) { list.push(kaRead(e.prop, e.times[m])); }
                    if (mode === "reverse") {
                        for (m = 0; m < list.length; m++) { kaWrite(e.prop, e.times[m], list[list.length - 1 - m], true); made++; }
                    } else if (mode === "mirror") {
                        T = e.times[e.times.length - 1];
                        for (m = list.length - 2; m >= 0; m--) {
                            kaWrite(e.prop, 2 * T - e.times[m], list[m], true); made++;
                            if (hi === null || 2 * T - e.times[m] > hi) { hi = 2 * T - e.times[m]; }
                        }
                        lo = e.times[0];
                    } else {
                        for (m = 0; m < list.length; m++) {
                            d = comp.time + e.times[m] - t0;
                            kaWrite(e.prop, d, list[m], false); made++;
                            if (lo === null || d < lo) { lo = d; }
                            if (hi === null || d > hi) { hi = d; }
                        }
                    }
                } catch (err) {
                    out.failed++;
                }
            }
            if (made) {
                out.keys += made; out.layers++;
                if (lo !== null && hi !== null) { kaFit(got.layers[i].layer, lo, hi, frame); }
            }
        }
        if (!out.keys && !out.failed && out.few && mode !== "clone") { throw new Error("KA_NEED_TWO"); }
        return out;
    }

    // ---- expressions: put one on the selected properties, or find the broken ones and fix them

    var EXPR_SCAN_MAX = 60;

    // Where a property is: the layer index and the property indices from the layer down.
    function propAddress(p) {
        var path = [];
        var q = p;
        var guard = 0;
        while (q && q.propertyDepth > 0 && guard < 50) {
            path.unshift(q.propertyIndex);
            q = q.parentProperty;
            guard++;
        }
        return { layer: q ? q.index : 0, path: path };
    }

    // "Transform > Position" - the names from the layer down, for people (and for the AI).
    function propTrail(p) {
        var names = [];
        var q = p;
        var guard = 0;
        while (q && q.propertyDepth > 0 && guard < 50) {
            names.unshift(q.name);
            q = q.parentProperty;
            guard++;
        }
        return names.join(" > ");
    }

    function propAt(comp, address) {
        var obj = comp.layer(address.layer);
        var i;
        for (i = 0; i < address.path.length; i++) {
            if (!obj) { return null; }
            obj = obj.property(address.path[i]);
        }
        return obj;
    }

    function valueText(v) {
        var out = [];
        var i;
        if (typeof v === "number") { return String(Math.round(v * 1000) / 1000); }
        if (v && typeof v.length === "number" && typeof v !== "string") {
            for (i = 0; i < v.length && i < 4; i++) { out.push(typeof v[i] === "number" ? String(Math.round(v[i] * 1000) / 1000) : "?"); }
            return "[" + out.join(", ") + "]";
        }
        return null;   // text, shapes, markers: the value itself is not shown
    }

    function describeProp(p, comp) {
        var a = propAddress(p);
        var layer = comp.layer(a.layer);
        var d = { layer: a.layer, path: a.path, layerName: layer ? layer.name : "", trail: propTrail(p),
            matchName: p.matchName, value: null, keys: 0, expression: "", error: "" };
        try { d.value = valueText(p.value); } catch (e) {}
        try { d.keys = p.numKeys; } catch (e2) {}
        try { d.expression = p.expression || ""; } catch (e3) {}
        try { d.error = p.expressionError || ""; } catch (e4) {}
        return d;
    }

    function selectedExprProps(comp) {
        var props = comp.selectedProperties;
        var out = [];
        var i, p;
        for (i = 0; i < props.length; i++) {
            p = props[i];
            try {
                if (p.propertyType === PropertyType.PROPERTY && p.canSetExpression) { out.push(describeProp(p, comp)); }
            } catch (e) {}
        }
        return out;
    }

    // Every property of the open composition whose expression is switched on but does not work.
    function brokenExpressions(comp) {
        var out = [];
        var i;
        function walk(group, depth) {
            var n, k, p;
            try { n = group.numProperties; } catch (e) { return; }
            for (k = 1; k <= n && out.length < EXPR_SCAN_MAX; k++) {
                try {
                    p = group.property(k);
                    if (!p) { continue; }
                    if (p.propertyType === PropertyType.PROPERTY) {
                        if (p.canSetExpression && p.expressionEnabled && p.expression && p.expressionError) { out.push(describeProp(p, comp)); }
                    } else if (depth < 40) {
                        walk(p, depth + 1);
                    }
                } catch (e2) {}
            }
        }
        for (i = 1; i <= comp.numLayers && out.length < EXPR_SCAN_MAX; i++) { walk(comp.layer(i), 0); }
        return out;
    }

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
        // A script that fails half way is undone, so a fix starts from a clean project (out.undone).
        run: function (code, label, wantFrames, tmpDir) {
            return reply(function () {
                var out = { runError: null, frames: null, compName: null, captureError: null, undone: false };
                var times = null;
                var marked = false;
                var target;
                app.beginUndoGroup("Sayframe: " + label);
                try {
                    try {
                        times = executeGenerated(code);
                    } catch (e) {
                        out.runError = e.toString() + (e.line ? " (line " + e.line + ")" : "");
                        marked = markUndoStep();
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
                if (marked) { out.undone = undoLastStep(); }
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
                    // A long video gets more frames (2 per second, up to 30): the panel rebuilds it scene by scene and
                    // gives each scene its own frames. The setting is the least, and a larger setting wins.
                    n = ref.isStill ? 1 : Math.max(1, Math.min(Math.max(maxFrames, Math.min(30, Math.ceil(ref.duration * 2))), Math.floor(ref.duration * fps)));
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

        // ---- Graphics: a new layer at the time indicator; colour, size and thickness are controls on it.
        grApply: function (id, dur, color, labels) {
            return reply(function () {
                var comp = activeComp();
                var kind = GR_KIND[id] || "shape", t0 = comp.time, len, t1, l, c, names, sel, i, pos, name, txt, mv, doc, tp, off;
                if (!(GR_BUILD[id] || GR_SOLID[id])) { throw new Error("UNKNOWN_PRESET"); }
                labels = labels || {};
                color = color || [1, 1, 1];
                len = Math.max(0.2, Number(dur) || 2);
                t1 = Math.min(comp.duration, t0 + len);
                if (t1 - t0 < 0.2) { t0 = Math.max(0, t1 - len); }
                pos = [comp.width / 2, comp.height / 2];
                sel = comp.selectedLayers || [];
                if (!GR_FULL[id]) {
                    for (i = 0; i < sel.length; i++) {
                        try {
                            if (!(sel[i] instanceof CameraLayer) && !(sel[i] instanceof LightLayer)) {
                                tp = sel[i].property("ADBE Transform Group").property("ADBE Position").value;
                                if (tp && tp.length >= 2) { pos = [tp[0], tp[1]]; }
                                break;
                            }
                        } catch (e0) {}
                    }
                }
                name = (labels.prefix || "") + (labels.title || id);
                names = { color: labels.color || "Color", size: id === "counter" ? (labels.value || "Value") : (labels.size || "Size"),
                    thick: GR_STROKE[id] ? (labels.thick || "Thickness") : "", text: "" };
                app.beginUndoGroup("Sayframe: graphic " + id);
                try {
                    for (i = 0; i < sel.length; i++) { try { sel[i].selected = false; } catch (e1) {} }
                    if (kind === "shape") {
                        l = comp.layers.addShape();
                    } else if (kind === "text") {
                        l = acTextLayer(comp, id === "timer" ? "00:00" : "0%", name, len, color);
                    } else {
                        l = comp.layers.addSolid(id === "vignette" || id === "flicker" ? [1, 1, 1] : [0, 0, 0], name, comp.width, comp.height, comp.pixelAspect || 1, comp.duration);
                        if (kind === "adj") { l.adjustmentLayer = true; }
                    }
                    l.name = name;
                    l.startTime = 0;
                    l.inPoint = t0;
                    l.outPoint = t1;
                    try { acP(l, ["ADBE Transform Group", "ADBE Position"]).setValue(GR_FULL[id] ? [comp.width / 2, comp.height / 2] : pos); } catch (e2) {}
                    i = acAdd(l, ["ADBE Effect Parade"], "ADBE Color Control");
                    acP(l, ["ADBE Effect Parade", i]).name = names.color;
                    acP(l, ["ADBE Effect Parade", i, 1]).setValue([color[0], color[1], color[2], 1]);
                    sfAddControl(l, "size", names.size, 100);
                    if (names.thick) { sfAddControl(l, "thick", names.thick, 8); }
                    c = grCtx(l, comp, names);
                    if (kind === "shape") {
                        GR_BUILD[id](c);
                        if (!GR_FULL[id]) { c.lt("scale", "[value[0]*gS(),value[1]*gS()]"); }
                    } else {
                        GR_SOLID[id](l, c);
                    }
                    if (GR_TEXT[id]) {
                        off = GR_TEXT[id];
                        txt = acTextLayer(comp, labels.text || "Text", (labels.textPrefix || "") + (labels.title || id), len, [1, 1, 1]);
                        txt.startTime = 0; txt.inPoint = t0; txt.outPoint = t1;
                        try {
                            tp = acP(txt, ["ADBE Text Properties", "ADBE Text Document"]);
                            doc = tp.value;
                            doc.fontSize = Math.round(comp.height / 22);
                            doc.justification = off[2] ? ParagraphJustification.CENTER_JUSTIFY : ParagraphJustification.LEFT_JUSTIFY;
                            tp.setValue(doc);
                        } catch (e3) {}
                        txt.parent = l;
                        try { acP(txt, ["ADBE Transform Group", "ADBE Position"]).setValue([off[0], off[1] + (off[2] ? comp.height / 60 : 0)]); } catch (e4) {}
                        acP(txt, ["ADBE Transform Group", "ADBE Opacity"]).expression =
                            "// Sayframe graphic text\n100*Math.min(1,Math.max(0,(time-inPoint-0.25)/0.3))*Math.min(1,Math.max(0,(outPoint-time)/0.3))";
                        names.text = String(txt.name);
                        try { txt.selected = false; } catch (e5) {}
                    }
                    mv = new MarkerValue("GR");
                    try { mv.setParameters({ sg: toJSON(names), gid: id }); } catch (e6) {}
                    l.property("ADBE Marker").setValueAtTime(t0, mv);
                    try { l.selected = true; } catch (e7) {}
                } finally {
                    app.endUndoGroup();
                }
                return { name: String(l.name), dur: t1 - t0, text: names.text };
            });
        },

        // Selected graphic: key "color" ([r,g,b]), "size", "thick" or "dur" (seconds; the text that belongs to it follows).
        grSet: function (key, value) {
            return reply(function () {
                var e = acEditLayer(), g = grRead(e.layer), fx, i, ch, d;
                if (!g) { throw new Error("PRESET_GONE"); }
                app.beginUndoGroup("Sayframe: graphic");
                try {
                    if (key === "dur") {
                        d = Math.max(0.2, Number(value));
                        e.layer.outPoint = Math.min(e.comp.duration, e.layer.inPoint + d);
                        for (i = 1; i <= e.comp.numLayers; i++) {
                            ch = e.comp.layer(i);
                            try { if (ch.parent === e.layer) { ch.outPoint = e.layer.outPoint; } } catch (e0) {}
                        }
                    } else {
                        fx = sfFx(e.layer, g.names[key]);
                        if (!fx) { throw new Error("PRESET_GONE"); }
                        fx.property(1).setValue(key === "color" ? [value[0], value[1], value[2], 1] : Number(value));
                    }
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer), graphic: grDescribe(e.layer) };
            });
        },

        grRemove: function () {
            return reply(function () {
                var e = acEditLayer(), i, ch, kids = [];
                if (!grRead(e.layer)) { throw new Error("PRESET_GONE"); }
                app.beginUndoGroup("Sayframe: remove graphic");
                try {
                    for (i = 1; i <= e.comp.numLayers; i++) {
                        ch = e.comp.layer(i);
                        try { if (ch && ch.parent === e.layer) { kids.push(ch); } } catch (e0) {}
                    }
                    for (i = 0; i < kids.length; i++) { kids[i].remove(); }
                    e.layer.remove();
                } finally {
                    app.endUndoGroup();
                }
                return { removed: true };
            });
        },

        // ---- Transitions: a new layer on top at the time indicator (the cut), half before it and half after.
        trApply: function (id, dur, color, labels) {
            return reply(function () {
                var comp = activeComp();
                var kind = TR_KIND[id], cut = comp.time, d, t0, t1, l, name, k, mv, sel, i;
                if (!kind || !TR_BUILD[id] && kind !== "shape") { throw new Error("UNKNOWN_PRESET"); }
                labels = labels || {};
                d = Math.max(comp.frameDuration * 2 || 0.1, Number(dur) || 1);
                t0 = Math.max(0, cut - d / 2);
                t1 = Math.min(comp.duration, t0 + d);
                if (t1 - t0 < d) { t0 = Math.max(0, t1 - d); }
                name = (labels.prefix || "Transition: ") + (labels.title || id);
                k = labels.strength || "Strength";
                color = color || [1, 1, 1];
                app.beginUndoGroup("Sayframe: transition " + id);
                try {
                    sel = comp.selectedLayers || [];
                    for (i = 0; i < sel.length; i++) { try { sel[i].selected = false; } catch (e0) {} }
                    if (kind === "shape") {
                        l = comp.layers.addShape();
                    } else {
                        l = comp.layers.addSolid(id === "fade-black" ? [0, 0, 0] : (id === "fade-white" || id === "flash" ? [1, 1, 1] : [0.5, 0.5, 0.5]),
                            name, comp.width, comp.height, comp.pixelAspect || 1, comp.duration);
                        if (kind === "adj") { l.adjustmentLayer = true; }
                    }
                    l.name = name;
                    l.startTime = 0;
                    l.inPoint = t0;
                    l.outPoint = t1;
                    try { l.moveToBeginning(); } catch (e1) {}
                    sfAddControl(l, "k", k, 100);
                    if (kind === "shape") { trShape(l, comp, k, id, color); } else { TR_BUILD[id](l, k); }
                    mv = new MarkerValue("TR");
                    try { mv.setParameters({ sk: k, tid: id }); } catch (e2) {}
                    l.property("ADBE Marker").setValueAtTime(cut, mv);
                    try { l.selected = true; } catch (e3) {}
                } finally {
                    app.endUndoGroup();
                }
                return { name: String(l.name), cut: cut, dur: t1 - t0 };
            });
        },

        // Duration of the selected transition: the layer grows or shrinks around its middle.
        trDuration: function (dur) {
            return reply(function () {
                var e = acEditLayer(), l = e.layer, c, d;
                if (!trRead(l)) { throw new Error("PRESET_GONE"); }
                c = (l.inPoint + l.outPoint) / 2;
                d = Math.max(e.comp.frameDuration * 2 || 0.1, Number(dur));
                app.beginUndoGroup("Sayframe: transition length");
                try {
                    l.inPoint = Math.max(0, c - d / 2);
                    l.outPoint = Math.min(e.comp.duration, c + d / 2);
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(l.name), groups: sfDescribe(l), transition: trDescribe(l) };
            });
        },

        trRemove: function () {
            return reply(function () {
                var e = acEditLayer();
                if (!trRead(e.layer)) { throw new Error("PRESET_GONE"); }
                app.beginUndoGroup("Sayframe: remove transition");
                try {
                    e.layer.remove();
                } finally {
                    app.endUndoGroup();
                }
                return { removed: true };
            });
        },

        // ---- Motion presets (Animation Composer style): markers + controls + expressions.
        // Clicking a preset that is already on every selected layer in that direction takes it off.
        sfApply: function (motion, curve, mode, dur, labels) {
            return reply(function () {
                var comp = activeComp();
                var layers = sfLayers(comp);
                var dirs = mode === "both" ? ["in", "out"] : [mode === "out" ? "out" : "in"];
                var out = { applied: 0, removed: 0, skipped: [], created: false, notText: 0 }, i, j, l, all, have, sk, isText = !!sfTextId(motion), txt;
                if (!sfKnown(motion) || !SF_CURVES[curve]) { throw new Error("UNKNOWN_PRESET"); }
                if (!isText && !(comp.selectedLayers || []).length) { throw new Error("NO_LAYERS_SELECTED"); }
                labels = labels || {};
                app.beginUndoGroup("Sayframe: " + motion);
                try {
                    if (isText) {
                        // Text presets go on text layers; with none selected, a new one is made at the time indicator.
                        txt = [];
                        for (i = 0; i < layers.length; i++) { if (layers[i] instanceof TextLayer) { txt.push(layers[i]); } else { out.notText++; } }
                        if (!txt.length) {
                            for (i = 0; i < layers.length; i++) { try { layers[i].selected = false; } catch (e0) {} }
                            l = acTextLayer(comp, labels.text || "Text", labels.text || "Text", Math.max(3, Number(dur) * 2 + 1.5), [1, 1, 1]);
                            try { l.selected = true; } catch (e1) {}
                            txt.push(l);
                            out.created = true;
                        }
                        layers = txt;
                    }
                    all = layers.length > 0;
                    for (i = 0; i < layers.length && all; i++) {
                        for (j = 0; j < dirs.length; j++) {
                            have = sfFind(sfReadMarker(layers[i], dirs[j]), motion);
                            if (!have || have.curve !== curve) { all = false; }
                        }
                    }
                    for (i = 0; i < layers.length; i++) {
                        l = layers[i];
                        for (j = 0; j < dirs.length; j++) {
                            have = sfFind(sfReadMarker(l, dirs[j]), motion);
                            if (all) {
                                sfTake(l, comp, dirs[j], motion);
                            } else if (have) {
                                if (have.curve !== curve) { sfSetCurve(l, comp, dirs[j], motion, curve, labels.curve); }
                            } else {
                                sfAdd(l, comp, motion, curve, dirs[j], Math.max(0.05, Number(dur) || 0.6), dirs.length > 1, labels);
                            }
                        }
                        sk = sfRebuild(l);
                        for (j = 0; j < sk.length; j++) { out.skipped.push(sk[j]); }
                        if (all) { out.removed++; } else { out.applied++; }
                    }
                } finally {
                    app.endUndoGroup();
                }
                out.state = layers.length ? sfLayerState(layers[0]) : [];
                return out;
            });
        },

        // Which presets sit on the first selected layer ("motion:dir:curve"), for the ticks on the cards.
        sfState: function () {
            return reply(function () {
                var item = app.project.activeItem, layers;
                if (!item || !(item instanceof CompItem)) { return { state: [], layers: 0 }; }
                layers = sfLayers(item);
                return { state: layers.length ? sfLayerState(layers[0]) : [], layers: layers.length };
            });
        },

        sfList: function () {
            return reply(function () {
                var e = acEditLayer();
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer), transition: trDescribe(e.layer), sound: sndDescribe(e.layer), graphic: grDescribe(e.layer) };
            });
        },

        // Duration and delay of one direction: they move and stretch the marker; nothing else changes.
        sfTiming: function (dir, dur, delay) {
            return reply(function () {
                var e = acEditLayer(), mk = sfReadMarker(e.layer, dir), len, d, t;
                if (!mk) { throw new Error("PRESET_GONE"); }
                len = e.layer.outPoint - e.layer.inPoint;
                d = dur === undefined || dur === null ? mk.dur : Math.max(e.comp.frameDuration || 0.01, Math.min(Number(dur), len));
                if (delay === undefined || delay === null) {
                    delay = dir === "in" ? mk.time - e.layer.inPoint : e.layer.outPoint - (mk.time + mk.dur);
                }
                delay = Math.max(0, Math.min(Number(delay), len - d));
                t = dir === "in" ? e.layer.inPoint + delay : e.layer.outPoint - delay - d;
                app.beginUndoGroup("Sayframe: timing");
                try {
                    sfWriteMarker(e.layer, dir, { time: t, dur: d, presets: mk.presets, names: mk.names }, e.comp.frameDuration);
                    sfRebuild(e.layer);
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer) };
            });
        },

        sfCurve: function (dir, motion, curve, label) {
            return reply(function () {
                var e = acEditLayer();
                if (!SF_CURVES[curve]) { throw new Error("UNKNOWN_PRESET"); }
                app.beginUndoGroup("Sayframe: curve");
                try {
                    sfSetCurve(e.layer, e.comp, dir, motion, curve, label);
                    sfRebuild(e.layer);
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer) };
            });
        },

        sfParam: function (name, value) {
            return reply(function () {
                var e = acEditLayer(), isAnim = String(name).indexOf("anim:") === 0, fx = isAnim ? null : sfFx(e.layer, name);
                if (!isAnim && !fx) { throw new Error("PRESET_GONE"); }
                app.beginUndoGroup("Sayframe: setting");
                try {
                    if (isAnim) { sftSetParam(e.layer, name, value); } else { fx.property(1).setValue(Number(value)); }
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer), transition: trDescribe(e.layer) };
            });
        },

        // A sound of the library on the selected layer: pitch (semitones) and volume (dB).
        sndSet: function (pitch, volume) {
            return reply(function () {
                var e = acEditLayer();
                if (!sndIs(e.layer)) { throw new Error("PRESET_GONE"); }
                app.beginUndoGroup("Sayframe: sound");
                try {
                    sndApply(e.layer, pitch === null || pitch === undefined ? sndDescribe(e.layer).pitch : Number(pitch),
                        volume === null || volume === undefined ? sndDescribe(e.layer).volume : Number(volume));
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer), sound: sndDescribe(e.layer) };
            });
        },

        // The sound bar of the Animation tab on whatever is selected: every selected sound-only layer (a library
        // sound or any audio file). Video layers are left alone, so their picture never speeds up.
        sndTargets: function () {
            return reply(function () {
                var comp = app.project.activeItem, out = [], i, L, st;
                if (!(comp instanceof CompItem)) { return { list: [] }; }
                for (i = 0; i < comp.selectedLayers.length; i++) {
                    L = comp.selectedLayers[i];
                    if (!sndTarget(L)) { continue; }
                    st = sndState(L);
                    out.push({ index: L.index, name: String(L.name), src: st.src, pitch: st.pitch, len: st.len, volume: st.volume });
                }
                return { list: out };
            });
        },

        // list: [{index, file, len, volume, src, pitch}] - the file to play (the original or one the panel rendered),
        // the Stretch, the volume; src and pitch go into the comment so the next change starts from the original.
        sndApplyFiles: function (list) {
            return reply(function () {
                var comp = activeComp(), done = 0, i, o, L, file, item;
                app.beginUndoGroup("Sayframe: sound");
                try {
                    for (i = 0; i < list.length; i++) {
                        o = list[i];
                        L = comp.layer(o.index);
                        if (!L || !sndTarget(L)) { continue; }
                        file = new File(o.file);
                        if (!file.exists) { throw new Error("SOUND_NOT_FOUND"); }
                        if (sndFilePath(L) !== file.fsName) {
                            item = sndFindItem(file);
                            if (!item) {
                                item = app.project.importFile(new ImportOptions(file));
                                try { item.parentFolder = projectBin("Sayframe SFX"); } catch (e1) {}
                            }
                            L.replaceSource(item, false);
                            restoreActive(comp);
                        }
                        sndSetLayer(L, Number(o.len) || 100, Number(o.volume) || 0);
                        sndSave(L, { src: String(o.src), p: Number(o.pitch) || 0, l: Number(o.len) || 100 });
                        done++;
                    }
                } finally {
                    app.endUndoGroup();
                }
                return { count: done, name: list.length ? String(comp.layer(list[0].index).name) : "" };
            });
        },

        sndRemove: function () {
            return reply(function () {
                var e = acEditLayer();
                if (!sndIs(e.layer)) { throw new Error("PRESET_GONE"); }
                app.beginUndoGroup("Sayframe: remove sound");
                try { e.layer.remove(); } finally { app.endUndoGroup(); }
                return { removed: true };
            });
        },

        // Text presets: how much the letters (words, lines) follow one another, 0 = all together.
        sfStagger: function (dir, motion, value) {
            return reply(function () {
                var e = acEditLayer(), mk = sfReadMarker(e.layer, dir);
                if (!sfFind(mk, motion) || !mk.names[motion]) { throw new Error("PRESET_GONE"); }
                app.beginUndoGroup("Sayframe: stagger");
                try {
                    mk.names[motion].stagger = Math.max(0, Math.min(0.97, Number(value)));
                    sfWriteMarker(e.layer, dir, mk, e.comp.frameDuration);
                    sfRebuild(e.layer);
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer) };
            });
        },

        sfRemove: function (dir, motion) {
            return reply(function () {
                var e = acEditLayer();
                app.beginUndoGroup("Sayframe: remove " + motion);
                try {
                    if (!sfTake(e.layer, e.comp, dir, motion)) { throw new Error("PRESET_GONE"); }
                    sfRebuild(e.layer);
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer) };
            });
        },

        // ---- Animation tab: presets for the selected layers, new graphics and sounds.
        acAnimate: function (id, mode, dur) {
            return reply(function () {
                var comp = activeComp();
                var layers = comp.selectedLayers;
                var preset = AC_MOTION[id];
                var dirs = mode === "both" ? ["in", "out"] : [mode === "out" ? "out" : "in"];
                var out = { applied: 0, skipped: 0, failed: 0 };
                var i, j, l, w, ok;
                if (!preset) { throw new Error("UNKNOWN_PRESET"); }
                if (!layers || !layers.length) { throw new Error("NO_LAYERS_SELECTED"); }
                acLastError = "";
                app.beginUndoGroup("Sayframe: " + id);
                try {
                    for (i = 0; i < layers.length; i++) {
                        l = layers[i];
                        if (l instanceof CameraLayer || l instanceof LightLayer) { out.skipped++; continue; }
                        ok = acApplyAll(l, comp, id, dirs, dur);
                        if (ok) { out.applied++; } else { out.failed++; }
                    }
                } finally {
                    app.endUndoGroup();
                }
                if (acLastError) { out.error = acLastError; }
                return out;
            });
        },

        acText: function (id, mode, dur, text) {
            return reply(function () {
                var comp = activeComp();
                var preset = AC_TEXT[id];
                var dirs = mode === "both" ? ["in", "out"] : [mode === "out" ? "out" : "in"];
                var sel = comp.selectedLayers || [];
                var layers = [], out = { applied: 0, skipped: 0, failed: 0, created: false };
                var i, j, l, w, ok;
                if (!preset) { throw new Error("UNKNOWN_PRESET"); }
                acLastError = "";
                app.beginUndoGroup("Sayframe: " + id);
                try {
                    for (i = 0; i < sel.length; i++) {
                        if (sel[i] instanceof TextLayer) { layers.push(sel[i]); } else { out.skipped++; }
                    }
                    if (!layers.length) {
                        l = acTextLayer(comp, text || "Text", text || "Text", Math.max(3, dur * 2 + 1.5), [1, 1, 1]);
                        layers.push(l);
                        out.created = true;
                        out.skipped = 0;
                    }
                    for (i = 0; i < layers.length; i++) {
                        l = layers[i];
                        ok = acApplyAll(l, comp, id, dirs, dur);
                        if (ok) { out.applied++; } else { out.failed++; }
                    }
                } finally {
                    app.endUndoGroup();
                }
                if (acLastError) { out.error = acLastError; }
                return out;
            });
        },

        acGraphic: function (id, dur, color) {
            return reply(function () {
                var comp = activeComp();
                var make = AC_GRAPHIC[id];
                var d = Math.max(0.1, dur), total = Math.max(2, d * 4), l, sel, i;
                if (!make) { throw new Error("UNKNOWN_PRESET"); }
                app.beginUndoGroup("Sayframe: " + id);
                try {
                    sel = comp.selectedLayers || [];
                    for (i = 0; i < sel.length; i++) { try { sel[i].selected = false; } catch (e0) {} }
                    l = make(comp, { t0: comp.time, d: d, total: total, end: comp.time + total, influence: 75 }, color || [1, 1, 1]);
                    try { l.selected = true; } catch (e1) {}
                } finally {
                    app.endUndoGroup();
                }
                return { name: String(l.name) };
            });
        },

        // ---- Edit view: presets Sayframe put on the first selected layer, changed or taken off.
        acList: function () {
            return reply(function () {
                var e = acEditLayer();
                return { layer: String(e.layer.name), items: acPublic(acLoad(e.layer)) };
            });
        },

        acEdit: function (index, prm) {
            return reply(function () {
                var e = acEditLayer();
                var list = acLoad(e.layer);
                var old = list[index], id, rec;
                if (!old) { throw new Error("PRESET_GONE"); }
                id = prm.id && acSectionOf(prm.id) === acSectionOf(old.id) ? prm.id : old.id;
                app.beginUndoGroup("Sayframe: edit " + id);
                try {
                    acTakeOut(e.layer, old);
                    rec = acApplyOne(e.layer, e.comp, id, old.dir, {
                        dur: prm.dur === undefined ? old.dur : Math.max(0.05, prm.dur),
                        delay: prm.delay === undefined ? old.delay : Math.max(0, prm.delay),
                        strength: prm.strength === undefined ? old.strength : Math.max(0.1, prm.strength),
                        ease: prm.ease === undefined ? old.ease : prm.ease,
                        half: old.half
                    });
                    list[index] = rec;
                    acSave(e.layer, list);
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), items: acPublic(list) };
            });
        },

        acRemove: function (index) {
            return reply(function () {
                var e = acEditLayer();
                var list = acLoad(e.layer);
                if (!list[index]) { throw new Error("PRESET_GONE"); }
                app.beginUndoGroup("Sayframe: remove " + list[index].id);
                try {
                    acTakeOut(e.layer, list[index]);
                    list.splice(index, 1);
                    acSave(e.layer, list);
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), items: acPublic(list) };
            });
        },

        // Imports a sound once (reused if it is already in the project) and puts it at the time indicator.
        // path: the file to play (maybe rendered with the pitch); len: the layer's Stretch; meta: {src, p, l} for the comment.
        acSound: function (path, binName, len, volume, title, meta) {
            return reply(function () {
                var comp = activeComp();
                var proj = app.project;
                var file = new File(path);
                var item = null, i, it, l;
                if (!file.exists) { throw new Error("SOUND_NOT_FOUND"); }
                for (i = 1; i <= proj.numItems; i++) {
                    it = proj.item(i);
                    try {
                        if (it.mainSource && it.mainSource.file && it.mainSource.file.fsName === file.fsName) { item = it; break; }
                    } catch (e0) {}
                }
                var reused = !!item;
                app.beginUndoGroup("Sayframe: sound");
                try {
                    if (!item) {
                        item = proj.importFile(new ImportOptions(file));
                        try { item.parentFolder = projectBin(binName); } catch (e1) {}
                    }
                    l = comp.layers.add(item);
                    l.startTime = comp.time;
                    if (title) { try { l.name = String(title); } catch (e2) {} }
                    sndSetLayer(l, Number(len) || 100, Number(volume) || 0);
                    if (meta) { sndSave(l, meta); }
                } finally {
                    app.endUndoGroup();
                }
                return { name: String(item.name), reused: reused };
            });
        },

        // FX Console: every installed effect plus the animation presets (.ffx) After Effects ships with
        // and the ones the user saved.
        fxCatalog: function () {
            return reply(fxCatalogData);
        },

        // Adds the effect to every selected layer that can take effects (not cameras or lights).
        applyEffect: function (matchName, label) {
            return reply(function () { return fxApplyEffect(matchName, label); });
        },

        applyPreset: function (path, label) {
            return reply(function () { return fxApplyPreset(path, label); });
        },

        // The effect search as a small After Effects window at the mouse (x, y in screen points).
        // fav and recent are item ids ("e:<matchName>" or "p:<path>"). The same key again closes it.
        fxPopup: function (x, y, fav, recent) {
            return reply(function () { return fxPopupShow(x, y, fav || [], recent || []); });
        },

        // Quick export. What the export sheet needs to know about the open comp and the machine.
        exportInfo: function () {
            return reply(function () {
                var comp = activeComp(), proj = app.project, rq = proj.renderQueue, ame = false;
                try { ame = !!(rq && rq.canQueueInAME); } catch (e0) {}
                return { comp: { name: String(comp.name), w: comp.width, h: comp.height, dur: comp.duration, fps: comp.frameRate,
                    waStart: comp.workAreaStart, waDur: comp.workAreaDuration },
                    projectFolder: proj.file && proj.file.parent ? proj.file.parent.fsName : "", ame: ame };
            });
        },

        // Saves the open comp as one MP4 (H.264): o = { w, h, label, fit: blur|black|crop, quality: light|normal|max,
        // span: all|work, folder, ame, bin }. Another size than the comp's goes through a wrapper comp.
        // In After Effects the render runs here and blocks until done; with ame it is sent to Media Encoder.
        exportOne: function (o) {
            return reply(function () {
                var grouped = false;
                function closeGroup() { if (grouped) { grouped = false; try { app.endUndoGroup(); } catch (eg) {} } }
                var comp = activeComp(), proj = app.project, rq = proj.renderQueue, w, h, wrap = null, it, om, tpl, file, dir;
                var parked = [], i, q, mode, base, size = 0, tpls = [], want, rate, ameT = "", epr = "", src = null;
                if (!o || typeof o !== "object") { throw new Error("BAD_EXPORT"); }
                if (!rq || !rq.items) { throw new Error("NO_RENDER_QUEUE"); }
                if (rq.rendering) { throw new Error("EXPORT_BUSY"); }
                w = Math.round(Number(o.w) || comp.width); h = Math.round(Number(o.h) || comp.height);
                w -= w % 2; h -= h % 2;
                if (w < 16 || h < 16 || w > 16384 || h > 16384) { throw new Error("BAD_EXPORT_SIZE"); }
                dir = new Folder(String(o.folder));
                if (!dir.exists) { try { dir.create(); } catch (e0) {} }
                if (!dir.exists) { throw new Error("EXPORT_NO_FOLDER"); }
                base = exSafe(String(comp.name) + (o.label ? " \u2014 " + o.label : ""));
                // Rendering inside an open undo group makes After Effects warn "Undo group mismatch":
                // the group covers only the setup and is closed before render() (closeGroup).
                app.beginUndoGroup("Sayframe: export");
                grouped = true;
                try {
                    if (w !== comp.width || h !== comp.height) {
                        wrap = exWrap(comp, w, h, o.fit === "crop" ? "crop" : (o.fit === "black" ? "black" : "blur"), base, String(o.bin || "Sayframe Export"));
                    }
                    // Other items already waiting in the Render Queue stay there but sit this render out.
                    for (i = 1; i <= rq.numItems; i++) {
                        q = rq.item(i);
                        try { if (q.render) { q.render = false; parked.push(q); } } catch (e1) {}
                    }
                    it = rq.items.add(wrap || comp);
                    // Always set the span: After Effects' default render settings may say "Work Area Only".
                    try {
                        if (o.span === "work") { it.timeSpanStart = comp.workAreaStart; it.timeSpanDuration = comp.workAreaDuration; }
                        else { it.timeSpanStart = 0; it.timeSpanDuration = comp.duration; }
                    } catch (e2) {}
                    om = it.outputModule(1);
                    try { tpls = om.templates; } catch (e3) {}
                    tpl = exTemplate(tpls, o.quality, o.mbps);
                    want = Number(o.mbps) > 0 ? Number(o.mbps) : exTplRate(tpl);
                    rate = exTplRate(tpl);
                    // Another bitrate than AE's templates: AE makes a 40 Mbps file, Media Encoder the final one.
                    if (o.ame && rq.canQueueInAME && tpl && want && rate !== want && want < 40) {
                        ameT = exAmeTarget();
                        epr = ameT ? exMakeEpr(want, w, h) : "";
                        if (epr) { tpl = exTemplate(tpls, "max", 40); }
                    }
                    if (tpl) { om.applyTemplate(tpl); }
                    file = exFreeFile(dir.fsName, base, ".mp4");
                    if (epr) {
                        src = new File(Folder.temp.fsName + "/Sayframe/" + base + " (40 Mbps " + new Date().getTime() + ").mp4");
                        om.file = src;
                    } else {
                        om.file = file;
                    }
                    if (!tpl && !o.ame) { throw new Error("NO_H264"); }
                    if (epr) {
                        closeGroup();
                        rq.render();
                        try { it.remove(); } catch (e11) {}
                        if (wrap) { try { wrap.remove(); } catch (e12) {} wrap = null; }
                        if (exSendAme(ameT, src.fsName, epr, file.fsName)) {
                            mode = "ame"; rate = want;
                        } else {
                            // Media Encoder did not answer: keep the 40 Mbps file as the result.
                            try { if (src.copy(file.fsName)) { src.remove(); } } catch (e13) {}
                            mode = "ae"; rate = 40;
                            try { size = new File(file.fsName).length; } catch (e14) {}
                        }
                    } else if (o.ame && rq.canQueueInAME) {
                        closeGroup();
                        rq.queueInAME(true);
                        mode = "ame";
                        try { it.render = false; } catch (e4) {}
                    } else {
                        closeGroup();
                        rq.render();
                        mode = "ae";
                        try { size = new File(file.fsName).length; } catch (e5) {}
                        try { it.remove(); } catch (e6) {}
                        if (wrap) { try { wrap.remove(); } catch (e7) {} wrap = null; }
                    }
                } catch (err) {
                    if (it && mode !== "ame") { try { it.remove(); } catch (e8) {} }
                    if (wrap && mode !== "ame") { try { wrap.remove(); } catch (e9) {} }
                    throw err;
                } finally {
                    for (i = 0; i < parked.length; i++) { try { parked[i].render = true; } catch (e10) {} }
                    closeGroup();
                }
                return { path: file.fsName, name: decodeURI(file.name), size: size, mode: mode, w: w, h: h, wrapped: !!wrap || (w !== comp.width || h !== comp.height), template: tpl, mbps: rate || 0 };
            });
        },

        // Opens the folder of an exported file in Finder / Explorer.
        exportReveal: function (path) {
            return reply(function () {
                var f = new File(String(path)), d = f.parent;
                if (!d || !d.exists) { throw new Error("EXPORT_NO_FOLDER"); }
                d.execute();
                return { folder: d.fsName };
            });
        },

        // Saves the frame at the time indicator of the open comp as a PNG in the given folder.
        // Saves the frame at the time indicator of the open comp as a PNG. A save dialog opens in the
        // project's folder (or fallbackFolder for an unsaved project); returns snap: null on Cancel.
        // Where snapshots go by default: next to the saved project, otherwise the fallback folder.
        snapWhere: function (fallbackFolder) {
            return reply(function () {
                var proj = app.project;
                var inProject = !!(proj.file && proj.file.parent);
                return { folder: inProject ? proj.file.parent.fsName : fallbackFolder, project: inProject };
            });
        },

        // The "Browse" button of the snapshot bar: a folder picker that starts in the current folder.
        snapPickFolder: function (start, prompt) {
            return reply(function () {
                var f = new Folder(start), picked = null;
                if (!f.exists) { f = Folder.myDocuments; }
                picked = f.selectDlg(prompt);
                return { folder: picked ? picked.fsName : null };
            });
        },

        // Saves the frame under the time indicator as a PNG. With exact, it goes straight into folder (the
        // snapshot bar has already chosen it); otherwise a Save window opens, starting next to the project.
        // importIt: the PNG is also imported into the project, into a "Sayframe Snapshots" bin.
        snapFrame: function (fallbackFolder, stamp, prompt, importIt, exact) {
            return reply(function () {
                var comp = activeComp();
                var proj = app.project;
                var folder = exact ? fallbackFolder : (proj.file && proj.file.parent ? proj.file.parent.fsName : fallbackFolder);
                var name = String(comp.name).replace(/[\\\/:\*\?"<>\|]/g, "_") + "_" + stamp + ".png";
                var file, dir, item = null, bin = null, i;
                dir = new Folder(folder);
                if (!dir.exists) { try { dir.create(); } catch (e0) {} }
                file = new File(folder + "/" + name);
                if (prompt) {
                    file = file.saveDlg(prompt);
                    if (!file) { return { snap: null, folder: folder }; }
                    if (!/\.png$/i.test(file.fsName)) { file = new File(file.fsName + ".png"); }
                }
                comp.saveFrameToPng(comp.time, file);
                if (!waitForFile(file.fsName, 20000)) { throw new Error("FRAME_NOT_SAVED"); }
                if (importIt) {
                    for (i = 1; i <= proj.numItems; i++) {
                        if (proj.item(i) instanceof FolderItem && String(proj.item(i).name) === "Sayframe Snapshots") { bin = proj.item(i); break; }
                    }
                    try {
                        item = proj.importFile(new ImportOptions(file));
                        if (!bin) { bin = proj.items.addFolder("Sayframe Snapshots"); }
                        try { item.parentFolder = bin; } catch (e1) {}
                    } catch (e2) {
                        item = null;
                    }
                    // Importing makes the picture the active item; the comp stays the one being worked on.
                    try { comp.openInViewer(); } catch (e3) {}
                }
                return { snap: { path: file.fsName, comp: String(comp.name), time: comp.time }, folder: folder,
                    imported: item ? String(item.name) : "", importFailed: !!importIt && !item };
            });
        },

        // Shortcuts that work anywhere in After Effects, not only in the panel. A CEP panel only hears
        // keys while it has focus, so After Effects is polled for the keyboard state a few times a
        // second; when a shortcut is held, the panel gets a "com.sayframe.hotkey" event with its id.
        setHotkeys: function (list) {
            return reply(function () {
                var g = $.global;
                if (g.__sayframeKeyTask) {
                    try { app.cancelTask(g.__sayframeKeyTask); } catch (e0) {}
                    g.__sayframeKeyTask = 0;
                }
                g.__sayframeKeys = list || [];
                g.__sayframeKeyDown = "";
                if (g.__sayframeKeys.length && typeof app.scheduleTask === "function") {
                    g.__sayframeKeyTask = app.scheduleTask("sayframeHost.pollKeys()", 60, true);
                }
                return { polling: !!g.__sayframeKeyTask };
            });
        },

        pollKeys: function () {
            var g = $.global, keys = g.__sayframeKeys || [], st, name, i, k, hit = "";
            try { st = ScriptUI.environment.keyboardState; } catch (e0) { return; }
            if (!st) { return; }
            name = String(st.keyName || "");
            if (name) {
                for (i = 0; i < keys.length; i++) {
                    k = keys[i];
                    if (name.toUpperCase() === String(k.key).toUpperCase() && !!st.ctrlKey === !!k.ctrl && !!st.altKey === !!k.alt &&
                            !!st.shiftKey === !!k.shift && !!st.metaKey === !!k.cmd) { hit = k.id; break; }
                }
            }
            if (hit && hit !== g.__sayframeKeyDown) { sayframeDispatch("com.sayframe.hotkey", hit); }
            g.__sayframeKeyDown = hit;
        },

        // Sorts the Project panel into category folders. Only parentFolder changes:
        // files on disk, names, comps and layers stay as they are. One undo step.
        organizeProject: function () {
            return reply(function () {
                var proj = app.project;
                var root = proj.rootFolder;
                var n = proj.numItems;
                var items = [], used = {}, folders = [], plan = [], made = [], counts = {}, found = {};
                var i, j, it, c, L, cat, f, target, moved = 0, total = 0;

                for (i = 1; i <= n; i++) {
                    it = proj.item(i);
                    if (it instanceof FolderItem) { folders.push(it); } else { items.push(it); }
                }
                // Comps that sit as a layer inside another comp are precomps.
                for (i = 0; i < items.length; i++) {
                    c = items[i];
                    if (!(c instanceof CompItem)) { continue; }
                    for (j = 1; j <= c.numLayers; j++) {
                        L = c.layer(j);
                        if (L && L.source && L.source instanceof CompItem && L.source !== c) { used["i" + L.source.id] = true; }
                    }
                }
                // Existing folders: a top-level one wins over a nested one with the same meaning.
                for (i = 0; i < folders.length; i++) {
                    cat = orgFolderCategory(folders[i].name);
                    if (!cat) { continue; }
                    if (!found[cat] || (folders[i].parentFolder === root && found[cat].parentFolder !== root)) { found[cat] = folders[i]; }
                }
                for (i = 0; i < items.length; i++) {
                    it = items[i];
                    cat = orgCategory(it, used);
                    total++;
                    if (orgInside(it, cat, root)) { continue; }
                    // An unused comp the user parked among precomps stays there.
                    if (cat === "Compositions" && orgInside(it, "Precomps", root)) { continue; }
                    plan.push({ item: it, cat: cat });
                }
                if (plan.length) {
                    app.beginUndoGroup("Sayframe: organize project");
                    try {
                        for (i = 0; i < plan.length; i++) {
                            cat = plan[i].cat;
                            target = found[cat];
                            if (!target) {
                                target = proj.items.addFolder(cat);
                                found[cat] = target;
                                made.push(cat);
                            }
                            f = plan[i].item;
                            if (f.parentFolder !== target) {
                                f.parentFolder = target;
                                moved++;
                                counts[cat] = (counts[cat] || 0) + 1;
                            }
                        }
                    } finally {
                        app.endUndoGroup();
                    }
                }
                return { organized: { total: total, moved: moved, counts: counts, created: made } };
            });
        },

        // ---- Projects (brand books): logos, colors, fonts, texts and formats of one brand.

        // A logo file into the project (folder binName) and, when a comp is open, into the comp.
        // Which of these files the open project still uses as footage (by index), so the panel keeps them on disk:
        // a deleted source file makes After Effects show "A file could not be found" when it reloads footage.
        brandFilesInUse: function (paths) {
            return reply(function () {
                var proj = app.project, used = [], names = {}, i, it, n;
                for (i = 0; i < paths.length; i++) { try { names[new File(paths[i]).fsName] = i; } catch (e0) {} }
                for (i = 1; proj && i <= proj.numItems; i++) {
                    it = proj.item(i);
                    try {
                        if (it.mainSource && it.mainSource.file) {
                            n = names[it.mainSource.file.fsName];
                            if (n !== undefined) { used.push(n); }
                        }
                    } catch (e1) {}
                }
                return { used: used };
            });
        },

        brandLogo: function (path, binName, logoName) {
            return reply(function () {
                var proj = app.project;
                var comp = proj.activeItem && proj.activeItem instanceof CompItem ? proj.activeItem : null;
                var file = new File(path);
                var item = null, i, it, reused, pre = null, inner, layer;
                if (!file.exists) { throw new Error("LOGO_NOT_FOUND"); }
                for (i = 1; i <= proj.numItems; i++) {
                    it = proj.item(i);
                    try {
                        if (it.mainSource && it.mainSource.file && it.mainSource.file.fsName === file.fsName) { item = it; break; }
                    } catch (e0) {}
                }
                reused = !!item;
                app.beginUndoGroup("Sayframe: brand logo");
                try {
                    if (!item) {
                        item = proj.importFile(new ImportOptions(file));
                        try { item.parentFolder = projectBin(binName); } catch (e1) {}
                    }
                    // In a comp the logo goes in as a precomp the size of the logo: inside it stays at 100%,
                    // the precomp layer is scaled to 10% so a big logo file does not fill the screen.
                    // Collapse Transformations keeps a vector logo sharp at any size.
                    if (comp) {
                        pre = proj.items.addComp((logoName ? String(logoName) : baseName(item.name)) + " Logo", Math.max(4, Math.round(item.width || 100)), Math.max(4, Math.round(item.height || 100)),
                            item.pixelAspect || 1, comp.duration, comp.frameRate);
                        try { pre.parentFolder = projectBin(binName); } catch (e2) {}
                        inner = pre.layers.add(item);
                        try { inner.collapseTransformation = true; } catch (e3) {}
                        layer = comp.layers.add(pre);
                        layer.property("ADBE Transform Group").property("ADBE Scale").setValue([BR_LOGO_SCALE, BR_LOGO_SCALE]);
                        try { layer.collapseTransformation = true; } catch (e4) {}
                        restoreActive(comp);
                    }
                } finally {
                    app.endUndoGroup();
                }
                return { name: String(item.name), comp: comp ? comp.name : "", reused: reused, pre: pre ? pre.name : "", scale: BR_LOGO_SCALE };
            });
        },

        // Brand icon: the file goes into the open comp as a plain layer in the centre at its own size,
        // Collapse Transformations on (a vector icon stays sharp when scaled up). Without a comp it only lands in the bin.
        brandIcon: function (path, binName) {
            return reply(function () {
                var proj = app.project;
                var comp = proj.activeItem && proj.activeItem instanceof CompItem ? proj.activeItem : null;
                var file = new File(path);
                var item = null, i, it, reused, layer = null;
                if (!file.exists) { throw new Error("ICON_NOT_FOUND"); }
                for (i = 1; i <= proj.numItems; i++) {
                    it = proj.item(i);
                    try {
                        if (it.mainSource && it.mainSource.file && it.mainSource.file.fsName === file.fsName) { item = it; break; }
                    } catch (e0) {}
                }
                reused = !!item;
                app.beginUndoGroup("Sayframe: brand icon");
                try {
                    if (!item) {
                        item = proj.importFile(new ImportOptions(file));
                        try { item.parentFolder = projectBin(binName); } catch (e1) {}
                    }
                    if (comp) {
                        layer = comp.layers.add(item);
                        try { layer.collapseTransformation = true; } catch (e2) {}
                        restoreActive(comp);
                    }
                } finally {
                    app.endUndoGroup();
                }
                return { name: String(item.name), comp: comp ? String(comp.name) : "", reused: reused };
            });
        },

        // Paints the selected layers. With a "Brand Colors" layer in the comp that has this color,
        // the color is linked to it by an expression, so changing it there changes it everywhere.
        brandColor: function (hex, name) {
            return reply(function () {
                var comp = activeComp();
                var sel = comp.selectedLayers;
                var rgb = brHex(hex), link = brLink(comp, name), i, n = 0;
                if (!sel.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup("Sayframe: brand color");
                try {
                    for (i = 0; i < sel.length; i++) {
                        if (brPaint(sel[i], rgb, link)) { n++; }
                    }
                } finally {
                    app.endUndoGroup();
                }
                return { count: n, linked: !!link };
            });
        },

        // Brand gradient: a Gradient Ramp on each selected layer, fitted to the layer's own rectangle at the given
        // angle (0 = bottom to top, 90 = left to right) or radial from its centre. Nothing selected: a new solid
        // the size of the comp gets it. g = { name, from, to, angle, type }.
        brandGradient: function (g) {
            return reply(function () {
                var comp = activeComp();
                var sel = comp.selectedLayers, made = null, i, n = 0, list = [];
                app.beginUndoGroup("Sayframe: brand gradient");
                try {
                    if (!sel.length) {
                        made = comp.layers.addSolid([1, 1, 1], String(g.name), comp.width, comp.height, comp.pixelAspect || 1, comp.duration);
                        list = [made];
                    } else {
                        for (i = 0; i < sel.length; i++) { list.push(sel[i]); }
                    }
                    for (i = 0; i < list.length; i++) {
                        if (brRamp(list[i], g, comp)) { n++; }
                    }
                } finally {
                    app.endUndoGroup();
                }
                return { count: n, created: made ? String(made.name) : "" };
            });
        },

        // A "Brand Colors" null with one Color Control per brand color; an existing one is updated.
        brandRig: function (colors) {
            return reply(function () {
                var comp = activeComp();
                var rig = brRigLayer(comp), created = false, fx, ef, i, j, c;
                app.beginUndoGroup("Sayframe: brand colors");
                try {
                    if (!rig) {
                        rig = comp.layers.addNull(comp.duration);
                        rig.name = BR_RIG;
                        created = true;
                    }
                    fx = rig.property("ADBE Effect Parade");
                    for (i = 0; i < colors.length; i++) {
                        c = colors[i];
                        ef = null;
                        for (j = 1; j <= fx.numProperties; j++) {
                            if (fx.property(j).name === c.name && fx.property(j).matchName === "ADBE Color Control") { ef = fx.property(j); break; }
                        }
                        if (!ef) {
                            ef = fx.addProperty("ADBE Color Control");
                            ef.name = c.name;
                        }
                        ef.property(1).setValue(brHex(c.hex));
                    }
                } finally {
                    app.endUndoGroup();
                }
                return { comp: comp.name, created: created, count: colors.length };
            });
        },

        // Sets the font of the selected text layers.
        brandFont: function (font) {
            return reply(function () {
                var comp = activeComp();
                var sel = comp.selectedLayers, n = 0, i, prop, td;
                app.beginUndoGroup("Sayframe: brand font");
                try {
                    for (i = 0; i < sel.length; i++) {
                        if (!(sel[i] instanceof TextLayer)) { continue; }
                        prop = sel[i].property("ADBE Text Properties").property("ADBE Text Document");
                        td = prop.value;
                        td.font = font;
                        prop.setValue(td);
                        n++;
                    }
                } finally {
                    app.endUndoGroup();
                }
                if (!n) { throw new Error("BR_NO_TEXT"); }
                return { count: n, missing: brFontMissing(font) };
            });
        },

        // A text layer with a brand text, in the brand font and color, in the middle of the comp.
        brandText: function (text, font, hex) {
            return reply(function () {
                var comp = activeComp();
                var l, prop, td;
                app.beginUndoGroup("Sayframe: brand text");
                try {
                    l = comp.layers.addText(text);
                    prop = l.property("ADBE Text Properties").property("ADBE Text Document");
                    td = prop.value;
                    if (font) { td.font = font; }
                    if (hex) { td.applyFill = true; td.fillColor = brHex(hex); }
                    try { td.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (eJ) {}
                    prop.setValue(td);
                } finally {
                    app.endUndoGroup();
                }
                return { name: String(l.name), comp: comp.name, missing: font ? brFontMissing(font) : false };
            });
        },

        // A new comp of a brand format, with a background of the brand "background" color, opened.
        brandComp: function (name, w, h, fps, dur, bgHex, binName) {
            return reply(function () {
                var proj = app.project;
                var comp, bg;
                app.beginUndoGroup("Sayframe: brand comp");
                try {
                    comp = proj.items.addComp(name, w, h, 1, dur, fps);
                    try { comp.parentFolder = projectBin(binName); } catch (e1) {}
                    if (bgHex) {
                        bg = comp.layers.addSolid(brHex(bgHex), "Background", w, h, 1, dur);
                        try { comp.bgColor = brHex(bgHex); } catch (e2) {}
                    }
                    comp.openInViewer();
                } finally {
                    app.endUndoGroup();
                }
                return { name: comp.name, bg: !!bg };
            });
        },

        // Save window for a brand book file; starts in Documents with the suggested name.
        brandSaveDialog: function (fileName, prompt) {
            return reply(function () {
                var f = new File(Folder.myDocuments.fsName + "/" + fileName);
                var picked = f.saveDlg(prompt);
                var path = picked ? String(picked.fsName) : "";
                if (path && !/\.sfbrand$/i.test(path)) { path += ".sfbrand"; }
                return { path: path };
            });
        },

        // Installed fonts (PostScript names), for the hint while typing. Older After Effects: none.
        brandFonts: function () {
            return reply(function () {
                var out = [], groups, i, j;
                try { groups = app.fonts.allFonts; } catch (e) { groups = null; }
                for (i = 0; groups && i < groups.length && out.length < 6000; i++) {
                    for (j = 0; j < groups[i].length; j++) {
                        try { out.push(String(groups[i][j].postScriptName)); } catch (e2) {}
                    }
                }
                return { fonts: out };
            });
        },

        // Remove unused: footage that no comp uses leaves the project (File > Dependencies > Remove Unused Footage).
        // Files on disk stay where they are. One undo step.
        // Cut out: the photo under the selected layer (a still image file), for the panel's cut-out window.
        cutoutSource: function () {
            return reply(function () {
                var comp = activeComp();
                var sel = comp.selectedLayers;
                var layer, src, ms, f;
                if (!sel.length) { throw new Error("NO_LAYERS_SELECTED"); }
                layer = sel[0];
                src = layer.source;
                ms = src && src instanceof FootageItem ? src.mainSource : null;
                if (!ms || !(ms instanceof FileSource) || !ms.file) { throw new Error("CO_NOT_PHOTO"); }
                if (!ms.isStill) { throw new Error("CO_NOT_STILL"); }
                f = ms.file;
                if (!f.exists) { throw new Error("CO_MISSING"); }
                return { path: f.fsName, layer: String(layer.name), index: layer.index, item: String(src.name),
                    width: src.width, height: src.height, comp: String(comp.name), many: sel.length > 1,
                    dir: app.project.file ? app.project.file.parent.fsName : "" };
            });
        },

        // Cut out, done: the PNG with the transparent background replaces the photo on that layer
        // ("replace": position, scale, effects stay) or goes on a copy of the layer just above it, and the
        // original is switched off ("above"). The PNG lands in the project bin binName. One undo step.
        cutoutApply: function (path, index, mode, binName, newName) {
            return reply(function () {
                var comp = activeComp();
                var file = new File(path);
                var layer, item, dup, res;
                if (!(index >= 1 && index <= comp.numLayers)) { throw new Error("CO_LAYER_GONE"); }
                layer = comp.layer(index);
                if (!file.exists) { throw new Error("CO_NOT_SAVED"); }
                app.beginUndoGroup("Sayframe: cut out background");
                try {
                    item = app.project.importFile(new ImportOptions(file));
                    try { item.parentFolder = projectBin(binName); } catch (e1) {}
                    if (mode === "above") {
                        dup = layer.duplicate();
                        dup.replaceSource(item, false);
                        if (newName) { try { dup.name = String(newName); } catch (e2) {} }
                        layer.enabled = false;
                        res = { mode: "above", layer: String(dup.name), original: String(layer.name) };
                    } else {
                        layer.replaceSource(item, false);
                        res = { mode: "replace", layer: String(layer.name) };
                    }
                } finally {
                    app.endUndoGroup();
                }
                res.item = String(item.name);
                return res;
            });
        },

        removeUnused: function () {
            return reply(function () {
                var proj = app.project;
                var names = [], i, it, n;
                for (i = 1; i <= proj.numItems; i++) {
                    it = proj.item(i);
                    if (it instanceof FootageItem && it.usedIn && it.usedIn.length === 0) { names.push(it.name); }
                }
                if (!names.length) { return { removed: 0, names: [] }; }
                app.beginUndoGroup("Sayframe: remove unused footage");
                try {
                    n = proj.removeUnusedFootage();
                } finally {
                    app.endUndoGroup();
                }
                if (typeof n !== "number") { n = names.length; }
                return { removed: n, names: names };
            });
        },

        // Null / Parent, chosen by the selection: nothing selected - a new null; several layers - a new null
        // becomes their parent; one layer - its children (layers parented to it) get selected and listed.
        nullParent: function () {
            return reply(function () {
                var comp = activeComp();
                var sel = comp.selectedLayers;
                var made;
                if (sel.length === 1) { return { children: npChildren(comp, sel[0]) }; }
                app.beginUndoGroup("Sayframe: null parent");
                try {
                    made = npCreate(comp, sel);
                } finally {
                    app.endUndoGroup();
                }
                return { created: made };
            });
        },

        // Kit: ready-made set-ups (liquid glass for now). labels: layer names in the panel's language.
        kitApply: function (id, labels) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (id !== "liquid-glass") { throw new Error("UNKNOWN_PRESET"); }
                app.beginUndoGroup("Sayframe: liquid glass");
                try {
                    res = kitLiquidGlass(comp, labels || {});
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Liquid glass block (Maketi): o = { mode: "text"|"shape"|"mine", text, form, shape, kind, edge, blur, light, size }.
        glassMake: function (o, labels, mk) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (!o || typeof o !== "object") { throw new Error("BAD_GLASS"); }
                app.beginUndoGroup("Sayframe: liquid glass");
                try {
                    res = mkWrap(comp, "glass", mk, function () { return glBuild(comp, o, labels || {}); }, { keepSel: o.mode === "mine" ? function (L) { return !(L instanceof CameraLayer) && !(L instanceof LightLayer) && !L.adjustmentLayer; } : false });
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Split / merge: one layer selected - it splits into its groups (or masks); several shape layers - one layer.
        shapeSplitMerge: function () {
            return reply(function () {
                var comp = activeComp();
                var sel = comp.selectedLayers;
                var res;
                if (!sel.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup(sel.length === 1 ? "Sayframe: split shape" : "Sayframe: merge shapes");
                try {
                    res = sel.length === 1 ? smSplit(comp, sel[0]) : smMerge(comp, sel);
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Grid: o = { rows, cols, gap, split, gapV, round, rand, seed, fit, w, h, mode, numbers, stagger }; labels - layer names.
        // Photos selected in the Project panel go into the card comps of a carousel, one per card, in order.
        orbitPhotos: function (labels) {
            labels = labels || {};
            return reply(function () {
            var comp = activeComp(), sel = [], cards = {}, n = 0, i, j, k, L, src, m, it, cc, nl, sc, placed = 0, ctrl = null, base = labels.card || "Card ", pw, ph, num;
            try { sel = app.project.selection || []; } catch (eS) { sel = []; }
            labels = labels || {};
            num = function (nm) { nm = String(nm); return nm.indexOf(base) === 0 && /^\d+$/.test(nm.slice(base.length)) ? Number(nm.slice(base.length)) : 0; };
            // The carousel: the selected one's control (or a card), else the only one in the comp.
            for (i = 1; i <= comp.numLayers; i++) {
                L = comp.layer(i);
                if (L.name.indexOf(labels.ctrl || "Carousel Control") === 0 && (!ctrl || L.selected)) { ctrl = L; }
            }
            for (i = 1; i <= comp.numLayers; i++) {
                L = comp.layer(i);
                try { src = L.source; } catch (eSrc) { src = null; }
                if (!src || !(typeof CompItem === "undefined" || src instanceof CompItem)) { continue; }
                if (ctrl && L.parent !== ctrl) { continue; }
                m = num(src.name);
                if (m) { cards[m] = src; n = Math.max(n, m); }
            }
            if (!n) { throw new Error("OR_NO_CAROUSEL"); }
            var list = [];
            for (i = 0; i < sel.length; i++) {
                it = sel[i];
                if (!it || (typeof FolderItem !== "undefined" && it instanceof FolderItem)) { continue; }
                if (num(it.name)) { continue; }
                if (!(it.width > 0)) { continue; }
                list.push(it);
            }
            if (!list.length) { throw new Error("OR_NO_PHOTOS"); }
            app.beginUndoGroup("Sayframe: photos into cards");
            try {
                for (k = 0; k < list.length && k < n; k++) {
                    cc = cards[k + 1];
                    if (!cc) { continue; }
                    // A photo put here before by this button goes away; the card's own shape and number stay under.
                    for (j = cc.numLayers; j >= 1; j--) { try { if (cc.layer(j).comment === "Sayframe|photo") { cc.layer(j).remove(); } } catch (eR) {} }
                    nl = cc.layers.add(list[k]);
                    try { nl.comment = "Sayframe|photo"; } catch (eC) {}
                    try { nl.moveToBeginning(); } catch (eB) {}
                    pw = Number(list[k].width) || cc.width; ph = Number(list[k].height) || cc.height;
                    sc = Math.max(cc.width / pw, cc.height / ph) * 100;
                    orbitSet(nl, "ADBE Scale", [sc, sc]);
                    orbitSet(nl, "ADBE Position", [cc.width / 2, cc.height / 2]);
                    placed++;
                }
            } finally {
                app.endUndoGroup();
            }
            return { placed: placed, cards: n, extra: Math.max(0, list.length - n) };
            });
        },

        gridMake: function (o, labels, mk) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (!o || typeof o !== "object") { throw new Error("BAD_GRID"); }
                app.beginUndoGroup("Sayframe: grid");
                try {
                    res = mkWrap(comp, "grid", mk, function () { return gridBuild(comp, o, labels || {}); });
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Text on a ribbon / 3D ring: o = { mode: "ribbon"|"ring", form, text, sep, width, textSize, speed, run, ribbonColor, textColor, rings, radius, tilt, backDark, camera }.
        ribbonMake: function (o, labels, mk) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (!o || typeof o !== "object") { throw new Error("BAD_RIBBON"); }
                app.beginUndoGroup(o.mode === "ring" ? "Sayframe: text ring" : "Sayframe: text ribbon");
                try {
                    res = mkWrap(comp, "ribbon", mk, function () { return o.mode === "ring" ? ringBuild(comp, o, labels || {}) : ribBuild(comp, o, labels || {}); },
                        { keepSel: o.mode !== "ring" && o.form === "path" ? function (L) { return !!ribFindPath(L); } : false });
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Phone mockup: o = { model: "iphone"|"android", color, pose: "flat"|"tilt"|"lie", size, round, shadow, appear, screen: "precomp"|"layer" }.
        phoneMake: function (o, labels, mk) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (!o || typeof o !== "object") { throw new Error("BAD_PHONE"); }
                app.beginUndoGroup("Sayframe: phone mockup");
                try {
                    res = mkWrap(comp, "phone", mk, function () { return phoneBuild(comp, o, labels || {}); }, { keepSel: o.screen === "layer", cleanKeep: function (L) {
                        // The screen mask the mockup put on the user's layer: it is made again.
                        var M = L.property("ADBE Mask Parade"), n;
                        for (n = M.numProperties; n >= 1; n--) { if (M.property(n).name === ((labels || {}).screenMask || "Screen")) { M.property(n).remove(); } }
                    } });
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Carousel: o = { count, layout, shape, corners, mode: "shape"|"precomp", radius, w, h, numbers, camera }; labels - layer names.
        orbitMake: function (o, labels, mk) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (!o || typeof o !== "object") { throw new Error("BAD_ORBIT"); }
                app.beginUndoGroup("Sayframe: carousel");
                try {
                    res = mkWrap(comp, "carousel", mk, function () { return orbitBuild(comp, o, labels || {}); });
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Maketi: is something a block made selected? Then the block shows its settings and changes it.
        mkSelected: function () {
            return reply(function () {
                var comp = app.project ? app.project.activeItem : null, sel, i, t, g;
                if (!comp || !(comp instanceof CompItem)) { return { kind: "" }; }
                sel = comp.selectedLayers || [];
                for (i = 0; i < sel.length; i++) {
                    t = mkTagOf(sel[i]);
                    if (!t) { continue; }
                    g = mkGroupOf(comp, t.gid);
                    if (!g.main) { continue; }
                    return { kind: g.main.tag.kind, gid: t.gid, name: g.main.L.name, state: g.main.tag.state, comp: comp.name };
                }
                return { kind: "", comp: comp.name };
            });
        },

        mkDeselect: function () {
            return reply(function () {
                var comp = app.project ? app.project.activeItem : null, sel, i;
                if (!comp || !(comp instanceof CompItem)) { return {}; }
                sel = comp.selectedLayers || [];
                for (i = sel.length - 1; i >= 0; i--) { try { sel[i].selected = false; } catch (e) {} }
                return {};
            });
        },

        // Pathfinder: mode "unite" | "front" | "intersect" | "exclude" | "back"; keep - hide the source layers instead of removing them.
        // Text box: o = { per: "all"|"line", look: "fill"|"stroke"|"both", style: "box"|"marker", color, strokeColor,
        // px, py, round, stroke, skew, opacity, shadow }; lab - control and layer names. The box is not animated.
        textBox: function (o, lab, mk) {
            return reply(function () {
                var comp = activeComp(), sel = comp.selectedLayers, texts = [], res = [], i, made = "";
                if (!o || typeof o !== "object" || !lab) { throw new Error("BAD_TEXTBOX"); }
                for (i = 0; i < sel.length; i++) { if (sel[i] instanceof TextLayer) { texts.push(sel[i]); } }
                app.beginUndoGroup("Sayframe: text box");
                try {
                    return mkWrap(comp, "textbox", mk, function () {
                        var j;
                        if (mk) { sel = comp.selectedLayers; texts = []; for (j = 0; j < sel.length; j++) { if (sel[j] instanceof TextLayer) { texts.push(sel[j]); } } }
                        // No text selected: a new text in the middle of the comp gets the box.
                        if (!texts.length) { texts.push(tbNewText(comp, lab.defaultText || "Text", tbTextColor(o))); made = texts[0].name; }
                        for (i = 0; i < texts.length; i++) { res.push(tbBuild(comp, texts[i], o, lab)); }
                        return { textBox: { boxes: res, made: made } };
                    }, { keepSel: function (L) { return L instanceof TextLayer; }, keepNames: [lab.defaultText || "Text"] });
                } finally {
                    app.endUndoGroup();
                }
            });
        },

        pathfinder: function (mode, keep) {
            return reply(function () {
                var comp = activeComp();
                var sel = comp.selectedLayers;
                var res;
                if (!PF_MODES[mode]) { throw new Error("BAD_PF_MODE"); }
                if (!sel.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup("Sayframe: pathfinder");
                try {
                    res = pfApply(comp, sel, mode, !!keep);
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Clear cache: everything After Effects keeps in memory (RAM preview frames, image cache,
        // snapshots, undo history) is dropped at once, like Edit > Purge > All Memory.
        clearCache: function () {
            return reply(function () {
                var target = typeof PurgeTarget !== "undefined" && PurgeTarget.ALL_CACHES !== undefined ? PurgeTarget.ALL_CACHES : null;
                if (target === null) { throw new Error("PURGE_UNAVAILABLE"); }
                app.purge(target);
                return { purged: true };
            });
        },

        // Decompose: the layers inside each selected precomp come out into the open comp, in the
        // precomp's place and at the same times; the precomp layer is removed. One undo step.
        decompose: function () {
            return reply(function () {
                var comp = activeComp();
                var sel = comp.selectedLayers;
                var pre = [], res = { precomps: 0, layers: 0, names: [], skipped: [], empty: [], notes: [] };
                var i;
                if (!sel.length) { throw new Error("NO_LAYERS_SELECTED"); }
                for (i = 0; i < sel.length; i++) {
                    if (sel[i].source && sel[i].source instanceof CompItem) { pre.push(sel[i]); }
                }
                if (!pre.length) { throw new Error("DC_NO_PRECOMP"); }
                app.beginUndoGroup("Sayframe: decompose");
                try {
                    for (i = 0; i < pre.length; i++) { dcOne(comp, pre[i], res); }
                } finally {
                    app.endUndoGroup();
                }
                return { decomposed: res };
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
        },

        // Ease copy: remembers easing, interpolation and value of every selected key, property by property.
        ecCopy: function () {
            return reply(function () {
                var comp = activeComp();
                var groups = ecGroups(comp);
                var out = { groups: [], keys: 0 };
                var g, k, p, idx, inE, outE, dims, rec, list;
                if (!groups.length) { throw new Error("NO_KEYS_SELECTED"); }
                for (g = 0; g < groups.length; g++) {
                    p = groups[g].prop;
                    list = [];
                    for (k = 0; k < groups[g].keys.length; k++) {
                        idx = groups[g].keys[k];
                        inE = p.keyInTemporalEase(idx);
                        outE = p.keyOutTemporalEase(idx);
                        dims = inE.length;
                        rec = {
                            t: p.keyTime(idx) - p.keyTime(groups[g].keys[0]),
                            it: p.keyInInterpolationType(idx), ot: p.keyOutInterpolationType(idx),
                            i: ecSide(inE, ecSegment(p, idx - 1, idx, dims)),
                            o: ecSide(outE, ecSegment(p, idx, idx + 1, dims)),
                            v: ecValue(p.keyValue(idx)), c: false
                        };
                        try { rec.c = !!p.keyTemporalContinuous(idx); } catch (e1) {}
                        list.push(rec);
                    }
                    out.groups.push({ name: p.name, vt: p.propertyValueType, mp: ecPath(p), keys: list });
                    out.keys += list.length;
                }
                return out;
            });
        },

        // Ease copy: mode "ease" puts the copied easing on the selected keys and keeps their values,
        // "value" puts the copied values and keeps their easing. through: one speed in and out of middle keys.
        ecPaste: function (clip, mode, through) {
            return reply(function () {
                var comp = activeComp();
                var targets = ecGroups(comp);
                var pairs, i, byLayer = false;
                var out = { keys: 0, properties: 0, byLayer: false };
                if (!clip || !clip.groups || !clip.groups.length) { throw new Error("EC_EMPTY"); }
                if (!targets.length) {
                    targets = ecEmptySelected(comp);
                    if (!targets.length) {
                        targets = ecLayerTargets(comp, clip);
                        byLayer = true;
                    }
                }
                if (!targets.length) { throw new Error(comp.selectedLayers.length ? "EC_NO_TARGET" : "EC_NO_KEYS"); }
                if (byLayer) {
                    // Each found property takes the copied group it was found for. Its keys were not chosen by hand,
                    // so the count does not have to match: the copied pattern simply repeats over all of them.
                    pairs = [];
                    for (i = 0; i < targets.length; i++) { pairs.push({ src: clip.groups[targets[i].group], dst: targets[i] }); }
                    out.byLayer = true;
                } else if (targets[0].empty) {
                    pairs = [];
                    for (i = 0; i < targets.length; i++) { pairs.push({ src: clip.groups[clip.groups.length === 1 ? 0 : Math.min(i, clip.groups.length - 1)], dst: targets[i] }); }
                } else {
                    pairs = ecPairs(clip, targets);
                }
                if (mode === "value") {
                    for (i = 0; i < pairs.length; i++) { if (pairs[i].src.vt !== pairs[i].dst.prop.propertyValueType) { throw new Error("EC_TYPE"); } }
                }
                out.created = 0;
                out.names = [];
                app.beginUndoGroup(mode === "value" ? "Sayframe: paste values" : "Sayframe: paste easing");
                try {
                    for (i = 0; i < pairs.length; i++) {
                        if (pairs[i].dst.empty) {
                            // No keys there yet: make them, then put the easing on them (values too, in "value" mode).
                            out.created += ecCreateKeys(comp, pairs[i], mode);
                            out.keys += ecPasteEase(pairs[i], !!through);
                        } else {
                            out.keys += mode === "value" ? ecPasteValue(pairs[i]) : ecPasteEase(pairs[i], !!through);
                        }
                        out.names.push(String(pairs[i].dst.prop.name));
                        out.properties++;
                    }
                } finally {
                    app.endUndoGroup();
                }
                return out;
            });
        },

        // What easing the selected keys have, for the graph in the panel: the out influence of the first selected
        // key and the in influence of the next one (first property that has two). mixed: other pairs differ.
        easeRead: function () {
            return reply(function () {
                var item = app.project.activeItem, groups, g, k, p, a, b, pair = null, out = { keys: 0 };
                if (!item || !(item instanceof CompItem)) { return out; }
                groups = ecGroups(item);
                for (g = 0; g < groups.length; g++) {
                    p = groups[g].prop;
                    out.keys += groups[g].keys.length;
                    for (k = 0; k + 1 < groups[g].keys.length; k++) {
                        try {
                            a = Math.round(p.keyOutTemporalEase(groups[g].keys[k])[0].influence);
                            b = Math.round(p.keyInTemporalEase(groups[g].keys[k + 1])[0].influence);
                        } catch (e) { continue; }
                        if (!pair) { pair = { name: String(p.name), out: a, "in": b }; }
                        else if (pair.out !== a || pair["in"] !== b) { pair.mixed = true; }
                    }
                }
                if (pair) { out.name = pair.name; out.out = pair.out; out["in"] = pair["in"]; out.mixed = !!pair.mixed; }
                return out;
            });
        },

        // Eases the selected keyframes. Influences are percentages (0.1-100); mode is "both", "in" or "out".
        ease: function (inInfluence, outInfluence, mode) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (mode !== "in" && mode !== "out") { mode = "both"; }
                app.beginUndoGroup("Sayframe: ease keyframes");
                try {
                    res = easeSelectedKeys(comp, clampInfluence(inInfluence), clampInfluence(outInfluence), mode);
                } finally {
                    app.endUndoGroup();
                }
                if (!res.keys && !res.failed) { throw new Error("NO_KEYS_SELECTED"); }
                return res;
            });
        },

        // Moves the anchor point of the selected layers. fx, fy: 0, 0.5 or 1 across the layer's bounds.
        // keyMode: "key" (add a keyframe when the property is animated), "shift" (move all keyframes) or "skip".
        anchor: function (fx, fy, keyMode) {
            return reply(function () {
                var comp = activeComp();
                var res;
                fx = Math.max(0, Math.min(1, Number(fx)));
                fy = Math.max(0, Math.min(1, Number(fy)));
                if (isNaN(fx) || isNaN(fy)) { throw new Error("BAD_ANCHOR_TARGET"); }
                if (keyMode !== "shift" && keyMode !== "skip") { keyMode = "key"; }
                if (!comp.selectedLayers.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup("Sayframe: move anchor point");
                try {
                    res = moveAnchor(comp, fx, fy, keyMode);
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Aligns the selected layers to the composition ("comp") or to each other ("selection").
        align: function (edge, target) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (edge !== "left" && edge !== "hcenter" && edge !== "right" && edge !== "top" && edge !== "vcenter" && edge !== "bottom") {
                    throw new Error("BAD_ALIGN_EDGE");
                }
                if (target !== "selection") { target = "comp"; }
                if (!comp.selectedLayers.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup("Sayframe: align layers");
                try {
                    res = alignLayers(comp, edge, target);
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Moves the "in" or "out" animation of the selected layers, or the layers themselves, by a number of frames.
        shift: function (what, frames) {
            return reply(function () {
                var comp = activeComp();
                var res;
                frames = Math.round(Number(frames));
                if (what !== "in" && what !== "out" && what !== "layer") { throw new Error("BAD_SHIFT_TARGET"); }
                if (isNaN(frames) || Math.abs(frames) > 100000) { throw new Error("BAD_SHIFT_FRAMES"); }
                if (!comp.selectedLayers.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup("Sayframe: shift in time");
                try {
                    res = shiftSelected(comp, what, frames);
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Brings the start or the end of the "in"/"out" animation of the selected layers to the current time.
        alignTime: function (point) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (point !== "inStart" && point !== "inEnd" && point !== "outStart" && point !== "outEnd") { throw new Error("BAD_SHIFT_TARGET"); }
                if (!comp.selectedLayers.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup("Sayframe: align to current time");
                try {
                    res = alignToTime(comp, point);
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Staircase: every next layer (or its keyframes, or its "in"/"out" animation) starts a few frames later.
        stagger: function (what, frames, order) {
            return reply(function () {
                var comp = activeComp();
                var res;
                frames = Math.round(Number(frames));
                if (what !== "in" && what !== "out" && what !== "layer" && what !== "keys") { throw new Error("BAD_SHIFT_TARGET"); }
                if (order !== "asc" && order !== "desc" && order !== "selection" && order !== "random" && order !== "align" && order !== "alignEnd") { throw new Error("BAD_STAGGER_ORDER"); }
                if (order === "alignEnd" && what !== "layer") { throw new Error("BAD_STAGGER_ORDER"); }
                if (order !== "align" && order !== "alignEnd" && (isNaN(frames) || frames === 0 || Math.abs(frames) > 100000)) { throw new Error("BAD_SHIFT_FRAMES"); }
                if (!comp.selectedLayers.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup("Sayframe: stagger");
                try {
                    res = staggerSelected(comp, what, frames, order);
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // Key actions of the stagger block (keys mode): mirror, reverse, first, last, clone.
        keyAct: function (mode) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (mode !== "mirror" && mode !== "reverse" && mode !== "first" && mode !== "last" && mode !== "clone") { throw new Error("BAD_KEY_ACTION"); }
                if (!comp.selectedLayers.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup("Sayframe: keys");
                try {
                    res = keyActSelected(comp, mode);
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        },

        // The selected properties that can take an expression, described for the AI.
        exprTargets: function () {
            return reply(function () {
                var comp = activeComp();
                return { compName: comp.name, props: selectedExprProps(comp) };
            });
        },

        // Expressions in the open composition that are switched on but give an error.
        exprBroken: function () {
            return reply(function () {
                var comp = activeComp();
                return { compName: comp.name, props: brokenExpressions(comp), limit: EXPR_SCAN_MAX };
            });
        },

        // items: [{ layer, path: [indices], expression }]. Sets each expression and reports
        // which ones After Effects accepted and which give an error (with the error text).
        exprApply: function (items) {
            return reply(function () {
                var comp = activeComp();
                var out = { results: [] };
                var i, it, p, r;
                app.beginUndoGroup("Sayframe: expression");
                try {
                    for (i = 0; i < items.length; i++) {
                        it = items[i];
                        r = { index: i, ok: false, error: "", trail: "" };
                        try {
                            p = propAt(comp, it);
                            if (!p || p.propertyType !== PropertyType.PROPERTY || !p.canSetExpression) { throw new Error("PROPERTY_GONE"); }
                            r.trail = propTrail(p);
                            p.expression = String(it.expression);
                            try { p.expressionEnabled = true; } catch (e1) {}
                            r.error = p.expressionError || "";
                            r.ok = r.error === "";
                        } catch (e) {
                            r.error = (e && e.message) ? e.message : String(e);
                        }
                        out.results.push(r);
                    }
                } finally {
                    app.endUndoGroup();
                }
                return out;
            });
        },

        // Spreads the selected layers evenly between the two outermost ones.
        distribute: function (edge) {
            return reply(function () {
                var comp = activeComp();
                var res;
                if (edge !== "left" && edge !== "hcenter" && edge !== "right" && edge !== "top" && edge !== "vcenter" && edge !== "bottom") {
                    throw new Error("BAD_ALIGN_EDGE");
                }
                if (!comp.selectedLayers.length) { throw new Error("NO_LAYERS_SELECTED"); }
                app.beginUndoGroup("Sayframe: distribute layers");
                try {
                    res = distributeLayers(comp, edge);
                } finally {
                    app.endUndoGroup();
                }
                return res;
            });
        }
    };
})();

/*
 * SF - motion design building blocks for the scripts the AI writes (and for "my scripts").
 * Tested recipes instead of hand-made keyframes: proper easing, springs, staggers, text animators,
 * mask wipes, draw-on. Times are in seconds of the composition; every function is defensive and
 * returns the layer (or property) it worked on. SF.style(name) sets the character of the motion.
 */
var SF = (function () {
    var D = {};
    var STYLES = {
        normal:    { dur: 0.7, step: 0.06, easeIn: 15, easeOut: 85, spring: false, amp: 0.06, freq: 2.5, decay: 6, dist: 0.12, rise: 40, blur: 30, popFrom: 0 },
        smooth:    { dur: 0.9, step: 0.08, easeIn: 10, easeOut: 90, spring: false, amp: 0.04, freq: 2, decay: 7, dist: 0.08, rise: 30, blur: 25, popFrom: 0.85 },
        energetic: { dur: 0.45, step: 0.04, easeIn: 25, easeOut: 80, spring: true, amp: 0.08, freq: 3, decay: 7, dist: 0.2, rise: 60, blur: 40, popFrom: 0 },
        minimal:   { dur: 0.7, step: 0.06, easeIn: 15, easeOut: 85, spring: false, amp: 0.03, freq: 2, decay: 8, dist: 0.04, rise: 20, blur: 15, popFrom: 0.95 },
        corporate: { dur: 0.8, step: 0.07, easeIn: 20, easeOut: 80, spring: false, amp: 0.04, freq: 2, decay: 8, dist: 0.08, rise: 30, blur: 20, popFrom: 0.9 },
        playful:   { dur: 0.55, step: 0.05, easeIn: 20, easeOut: 80, spring: true, amp: 0.12, freq: 2.5, decay: 5, dist: 0.15, rise: 50, blur: 30, popFrom: 0 }
    };
    var KIT = (typeof KeyframeInterpolationType !== "undefined") ? KeyframeInterpolationType : { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };

    function style(name) {
        var s = STYLES[name] || STYLES.normal, k;
        for (k in s) { if (s.hasOwnProperty(k)) { D[k] = s[k]; } }
        D.name = STYLES[name] ? name : "normal";
        return D.name;
    }
    style("normal");

    function opt(o, k) { return (o && o[k] !== undefined && o[k] !== null) ? o[k] : D[k]; }
    function comp() {
        var c = app.project.activeItem;
        if (!c || !(c instanceof CompItem)) { throw new Error("SF: open a composition first"); }
        return c;
    }
    function tr(layer, m) { return layer.property("ADBE Transform Group").property(m); }
    function copy(v) { var o, i; if (v && typeof v === "object" && typeof v.length === "number") { o = []; for (i = 0; i < v.length; i++) { o.push(v[i]); } return o; } return v; }
    function valueAt(prop, t) { try { return copy(prop.numKeys ? prop.valueAtTime(t, true) : prop.value); } catch (e) { return copy(prop.value); } }

    function easeAt(prop, k, inInf, outInf) {
        var n, a, b, i;
        try { prop.setInterpolationTypeAtKey(k, KIT.BEZIER, KIT.BEZIER); } catch (e0) {}
        for (n = 1; n <= 3; n++) {
            a = []; b = [];
            for (i = 0; i < n; i++) { a.push(new KeyframeEase(0, inInf)); b.push(new KeyframeEase(0, outInf)); }
            try { prop.setTemporalEaseAtKey(k, a, b); return true; } catch (e1) {}
        }
        return false;
    }

    // Keys with easing: pairs = [[time, value], ...]; ease = "out" (fast start, soft landing - for things
    // arriving), "in" (soft start, fast exit - for things leaving), "inout", "linear" or "hold".
    function keys(prop, pairs, ease) {
        var i, k, inInf, outInf, idx = [];
        if (!prop || !pairs || !pairs.length) { return prop; }
        ease = ease || "out";
        for (i = 0; i < pairs.length; i++) { prop.setValueAtTime(pairs[i][0], pairs[i][1]); }
        for (i = 0; i < pairs.length; i++) { try { idx.push(prop.nearestKeyIndex(pairs[i][0])); } catch (e) {} }
        inInf = ease === "in" ? D.easeIn : ease === "inout" ? 66 : D.easeOut;
        outInf = ease === "in" ? D.easeOut : ease === "inout" ? 66 : D.easeIn;
        for (i = 0; i < idx.length; i++) {
            k = idx[i];
            if (ease === "linear") { try { prop.setInterpolationTypeAtKey(k, KIT.LINEAR, KIT.LINEAR); } catch (e2) {} }
            else if (ease === "hold") { try { prop.setInterpolationTypeAtKey(k, KIT.HOLD, KIT.HOLD); } catch (e3) {} }
            else { easeAt(prop, k, inInf, outInf); }
        }
        return prop;
    }

    // Overshoot and settle after the last key (an inertial bounce expression).
    function spring(prop, amp, freq, decay) {
        if (!prop) { return prop; }
        amp = amp || D.amp; freq = freq || D.freq; decay = decay || D.decay;
        try {
            prop.expression = "var amp=" + amp + ",freq=" + freq + ",decay=" + decay + ";var n=0;" +
                "if(numKeys>0){n=nearestKey(time).index;if(key(n).time>time){n--;}}" +
                "if(n>0&&n==numKeys&&time>key(n).time){var t=time-key(n).time;var v=velocityAtTime(key(n).time-thisComp.frameDuration/10);" +
                "value+v*amp*Math.sin(freq*t*2*Math.PI)/Math.exp(decay*t);}else{value;}";
        } catch (e) {}
        return prop;
    }

    function fadeIn(layer, t, o) {
        var p = tr(layer, "ADBE Opacity"), d = typeof o === "number" ? o : opt(o, "dur") * 0.6, to = valueAt(p, t);
        if (to === 0) { to = 100; }
        keys(p, [[t, 0], [t + d, to]], "out");
        return layer;
    }
    function fadeOut(layer, t, o) {
        var p = tr(layer, "ADBE Opacity"), d = typeof o === "number" ? o : opt(o, "dur") * 0.6;
        keys(p, [[t, valueAt(p, t)], [t + d, 0]], "in");
        return layer;
    }

    function dirVec(from, c, o) {
        var dist = (o && o.dist) ? o.dist : Math.round(Math.max(c.width, c.height) * D.dist);
        if (from === "right") { return [dist, 0]; }
        if (from === "top") { return [0, -dist]; }
        if (from === "bottom") { return [0, dist]; }
        return [-dist, 0];
    }

    // Moves a layer by an offset: o.reverse - leave instead of arrive.
    function shift(layer, t, vec, d, leaving, springy) {
        var p = tr(layer, "ADBE Position"), base, a, b, px, py;
        if (p.dimensionsSeparated) {
            px = tr(layer, "ADBE Position_0"); py = tr(layer, "ADBE Position_1");
            a = valueAt(px, t); b = valueAt(py, t);
            if (leaving) { keys(px, [[t, a], [t + d, a + vec[0]]], "in"); keys(py, [[t, b], [t + d, b + vec[1]]], "in"); }
            else { keys(px, [[t, a + vec[0]], [t + d, a]], "out"); keys(py, [[t, b + vec[1]], [t + d, b]], "out"); if (springy) { spring(px); spring(py); } }
            return;
        }
        base = valueAt(p, t);
        a = copy(base); a[0] += vec[0]; a[1] += vec[1];
        if (leaving) { keys(p, [[t, base], [t + d, a]], "in"); }
        else { keys(p, [[t, a], [t + d, base]], "out"); if (springy) { spring(p); } }
    }

    function slideIn(layer, t, o) {
        var c = comp(), d = opt(o, "dur");
        shift(layer, t, dirVec(o && o.from, c, o), d, false, opt(o, "spring"));
        if (!o || o.fade !== false) { fadeIn(layer, t, d * 0.6); }
        return layer;
    }
    function slideOut(layer, t, o) {
        var c = comp(), d = opt(o, "dur"), v = dirVec((o && o.to) || (o && o.from) || "left", c, o);
        shift(layer, t, v, d, true, false);
        if (!o || o.fade !== false) { fadeOut(layer, t + d * 0.4, d * 0.6); }
        return layer;
    }

    function scaled(v, k) { var o = copy(v), i; for (i = 0; i < o.length && i < 2; i++) { o[i] = o[i] * k; } return o; }
    function popIn(layer, t, o) {
        var p = tr(layer, "ADBE Scale"), d = opt(o, "dur"), to = valueAt(p, t), from = opt(o, "popFrom"), springy = (o && o.spring !== undefined) ? o.spring : true;
        keys(p, [[t, scaled(to, from)], [t + d, to]], "out");
        if (springy) { spring(p); }
        fadeIn(layer, t, d * 0.4);
        return layer;
    }
    function popOut(layer, t, o) {
        var p = tr(layer, "ADBE Scale"), d = opt(o, "dur") * 0.8, v = valueAt(p, t);
        keys(p, [[t, v], [t + d, scaled(v, 0)]], "in");
        fadeOut(layer, t + d * 0.5, d * 0.5);
        return layer;
    }

    function rectOf(layer, t) {
        var r = null, c = comp();
        try { r = layer.sourceRectAtTime(t, false); } catch (e) {}
        if (!r || !(r.width > 0) || !(r.height > 0)) { r = { left: 0, top: 0, width: layer.width || c.width, height: layer.height || c.height }; }
        return r;
    }
    function boxShape(l, tp, r, b) {
        var s = new Shape();
        s.vertices = [[l, tp], [r, tp], [r, b], [l, b]];
        s.closed = true;
        return s;
    }

    // Mask wipe: the layer is revealed from one side (o.from: left, right, top, bottom).
    function wipe(layer, t, o) {
        var d = opt(o, "dur"), r = rectOf(layer, t), pad = 2, L = r.left - pad, T = r.top - pad, R = r.left + r.width + pad, B = r.top + r.height + pad;
        var from = (o && o.from) || "left", m, shape, start;
        m = layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        try { m.name = "SF Wipe"; } catch (e0) {}
        shape = m.property("ADBE Mask Shape");
        start = from === "right" ? boxShape(R, T, R, B) : from === "top" ? boxShape(L, T, R, T) : from === "bottom" ? boxShape(L, B, R, B) : boxShape(L, T, L, B);
        keys(shape, [[t, start], [t + d, boxShape(L, T, R, B)]], opt(o, "ease") === "inout" ? "inout" : "out");
        if (o && o.feather) { try { m.property("ADBE Mask Feather").setValue([o.feather, o.feather]); } catch (e1) {} }
        return layer;
    }

    // Text by characters, words or lines (o.by), style: rise (default), fade, scale, blur.
    function textIn(layer, t, o) {
        var d = (o && o.dur) ? o.dur : D.dur * 1.6, by = (o && o.by) || "chars", st = (o && o.style) || "rise", an, props, sel, adv;
        try {
            an = layer.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator");
            try { an.name = "SF Text In"; } catch (e0) {}
            props = an.property("ADBE Text Animator Properties");
            props.addProperty("ADBE Text Opacity").setValue(0);
            if (st === "rise") { props.addProperty("ADBE Text Position 3D").setValue([0, opt(o, "rise"), 0]); }
            if (st === "scale") { props.addProperty("ADBE Text Scale 3D").setValue([0, 0, 100]); }
            if (st === "blur") { props.addProperty("ADBE Text Blur").setValue([opt(o, "blur"), opt(o, "blur")]); }
            sel = an.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
            adv = sel.property("ADBE Text Range Advanced");
            try { adv.property("ADBE Text Range Type2").setValue(by === "words" ? 3 : by === "lines" ? 4 : 2); } catch (e1) {}
            try { adv.property("ADBE Text Range Shape").setValue(1); } catch (e2) {}
            try { adv.property("ADBE Text Selector Smoothness").setValue(100); } catch (e3) {}
            keys(sel.property("ADBE Text Percent Start"), [[t, 0], [t + d, 100]], "inout");
        } catch (e) {
            fadeIn(layer, t, d * 0.5);
        }
        return layer;
    }
    function typeOn(layer, t, o) {
        var d = (o && o.dur) ? o.dur : D.dur * 2, an, sel, adv;
        try {
            an = layer.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator");
            try { an.name = "SF Type On"; } catch (e0) {}
            an.property("ADBE Text Animator Properties").addProperty("ADBE Text Opacity").setValue(0);
            sel = an.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
            adv = sel.property("ADBE Text Range Advanced");
            try { adv.property("ADBE Text Range Shape").setValue(1); } catch (e1) {}
            try { adv.property("ADBE Text Selector Smoothness").setValue(0); } catch (e2) {}
            keys(sel.property("ADBE Text Percent Start"), [[t, 0], [t + d, 100]], "linear");
        } catch (e) {
            fadeIn(layer, t, d * 0.3);
        }
        return layer;
    }

    // Strokes of a shape layer draw themselves (Trim Paths 0 -> 100%). Other layers get a wipe instead.
    function drawOn(layer, t, o) {
        var d = opt(o, "dur") * 1.4, root = null, trim;
        try { root = layer.property("ADBE Root Vectors Group"); } catch (e0) {}
        if (!root) { return wipe(layer, t, o); }
        trim = root.addProperty("ADBE Vector Filter - Trim");
        keys(trim.property("ADBE Vector Trim End"), [[t, 0], [t + d, 100]], "inout");
        return layer;
    }

    function blurIn(layer, t, o) {
        var d = opt(o, "dur"), fx = layer.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
        try { fx.name = "SF Blur In"; } catch (e0) {}
        try { fx.property("ADBE Gaussian Blur 2-0003").setValue(1); } catch (e1) {}
        keys(fx.property("ADBE Gaussian Blur 2-0001"), [[t, (o && o.amount) || D.blur], [t + d, 0]], "out");
        return layer;
    }

    // A slow push-in for the whole shot (o.amount: percent, default 6).
    function drift(layer, t, o) {
        var p = tr(layer, "ADBE Scale"), d = (o && o.dur) ? o.dur : 4, v = valueAt(p, t), k = 1 + ((o && o.amount) || 6) / 100;
        keys(p, [[t, v], [t + d, scaled(v, k)]], "inout");
        return layer;
    }

    function wiggle(prop, freq, amp) {
        try { prop.expression = "wiggle(" + (freq || 2) + "," + (amp || 10) + ")"; } catch (e) {}
        return prop;
    }

    function motionBlur(layers) {
        var c = comp(), i;
        try { c.motionBlur = true; } catch (e0) {}
        if (!layers) { layers = []; for (i = 1; i <= c.numLayers; i++) { layers.push(c.layer(i)); } }
        for (i = 0; i < layers.length; i++) { try { layers[i].motionBlur = true; } catch (e1) {} }
        return c;
    }

    var API = {};
    // One effect on several layers, each a little later: SF.stagger(layers, t, step, "popIn", opts).
    function stagger(layers, t, step, fn, o) {
        var i, f = typeof fn === "string" ? API[fn] : fn;
        if (!f) { throw new Error("SF.stagger: unknown recipe " + fn); }
        if (step === null || step === undefined) { step = D.step; }
        for (i = 0; i < layers.length; i++) { f(layers[i], t + i * step, o); }
        return layers;
    }

    API.style = style; API.defaults = D; API.keys = keys; API.spring = spring;
    API.fadeIn = fadeIn; API.fadeOut = fadeOut; API.slideIn = slideIn; API.slideOut = slideOut;
    API.popIn = popIn; API.popOut = popOut; API.wipe = wipe; API.textIn = textIn; API.typeOn = typeOn;
    API.drawOn = drawOn; API.blurIn = blurIn; API.drift = drift; API.wiggle = wiggle; API.motionBlur = motionBlur; API.stagger = stagger;
    return API;
})();
