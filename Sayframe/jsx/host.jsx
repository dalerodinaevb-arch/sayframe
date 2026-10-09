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
        "function sfM(t){var m=thisLayer.marker,i;for(i=1;i<=m.numKeys;i++){if(m.key(i).comment.indexOf(t)>=0)return m.key(i);}return null;}",
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

    // The Sayframe marker of one direction: {index, time, dur, presets: [{motion, curve}], names}.
    function sfReadMarker(layer, dir) {
        var mk = sfMarkerProp(layer), i, mv, re, m, out, params;
        if (!mk) { return null; }
        for (i = 1; i <= mk.numKeys; i++) {
            mv = mk.keyValue(i);
            out = { index: i, time: mk.keyTime(i), dur: mv.duration, presets: [], names: {} };
            re = /\{sf:([a-z0-9\-]+):(in|out):([a-z]+)\}/g;
            while ((m = re.exec(String(mv.comment))) !== null) {
                if (m[2] === dir) { out.presets.push({ motion: m[1], curve: m[3] }); }
            }
            if (!out.presets.length) { continue; }
            try {
                params = mv.getParameters();
                out.names = params && params.sf ? eval("(" + params.sf + ")") : {};
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
        mv = new MarkerValue((dir === "in" ? "IN: " : "OUT: ") + parts.join(" + ") + " " + tags.join(""));
        mv.duration = Math.max(data.dur, fd || 0.01);
        try { mv.setParameters({ sf: toJSON(keep) }); } catch (e0) {}
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
            m = SF_MOTIONS[it.motion];
            if (!m) { continue; }
            fx = it.names.fx || {};
            tag = q("{sf:" + it.motion + ":" + it.dir + ":");
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
        var m = SF_MOTIONS[motion], mk = sfReadMarker(layer, dir), fd = comp.frameDuration || 0.01;
        var title = labels.title || motion, keys = sfParamKeys(m), names, i, nm, w, data, end;
        names = { title: title, curveLabel: labels.curve || "", fx: {} };
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
                params = [];
                keys = sfParamKeys(SF_MOTIONS[p.motion] || {});
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

    // ---- Transitions, the way Animation Composer does them: a transition goes on a cut, not on a layer.
    // At the time indicator (the cut) a new layer appears on top of the comp, half before the cut and
    // half after it: an adjustment layer for camera moves and glitches, a solid for light leaks and fades,
    // a shape layer for wipes. Everything on it is driven by expressions from the layer's own length, so
    // stretching the layer in the timeline changes the duration and moving it moves the transition.
    // A "Strength" slider in Effect Controls scales the move.

    var TR_KIND = {
        "zoom-in": "adj", "zoom-out": "adj", "zoom-rotate": "adj", "rotate": "adj", "pan-left": "adj", "pan-right": "adj",
        "pan-up": "adj", "pan-down": "adj", "shake": "adj", "twirl": "adj", "blur-zoom": "adj",
        "glitch": "adj", "glitch-shake": "adj",
        "leak-warm": "solid", "leak-cool": "solid", "flash": "solid", "fade-black": "solid", "fade-white": "solid",
        "wipe-left": "shape", "wipe-up": "shape", "circle": "shape"
    };

    function trHead(strength) {
        return [
            "// Sayframe transition: written by the Sayframe panel. The cut is in the middle of this layer; its length is the duration.",
            "function tP(){var a=thisLayer.inPoint,b=thisLayer.outPoint;return Math.min(1,Math.max(0,(time-a)/Math.max(b-a,thisComp.frameDuration)));}",
            "function tK(){try{return effect(" + jsonString(strength) + ")(1)/100;}catch(e){return 1;}}",
            "function tIn(x){return x*x*x;}",
            "function tOut(x){return 1-Math.pow(1-x,3);}",
            "function tBell(){return Math.pow(Math.sin(Math.PI*tP()),2);}",
            "function tSplit(a,b){var p=tP();return p<0.5?a*tIn(p*2):b*(1-tOut(p*2-1));}"
        ].join("\n");
    }

    function trExpr(prop, strength, body) { prop.expression = trHead(strength) + "\n" + body; }

    // Motion Tile with mirrored edges first, so zooming out, panning and rotating never show empty edges.
    function trCamera(l, k, opts) {
        var tile = acAdd(l, ["ADBE Effect Parade"], "ADBE Tile"), tr, s;
        try {
            acP(l, ["ADBE Effect Parade", tile, "ADBE Tile-0004"]).setValue(400);
            acP(l, ["ADBE Effect Parade", tile, "ADBE Tile-0005"]).setValue(400);
            acP(l, ["ADBE Effect Parade", tile, "ADBE Tile-0006"]).setValue(1);
        } catch (e0) {}
        if (opts.twirl) {
            s = acAdd(l, ["ADBE Effect Parade"], "ADBE Twirl");
            trExpr(acP(l, ["ADBE Effect Parade", s, "ADBE Twirl-0001"]), k, "720*tBell()*tK()");
            try { acP(l, ["ADBE Effect Parade", s, "ADBE Twirl-0002"]).setValue(60); } catch (e1) {}
        }
        tr = acAdd(l, ["ADBE Effect Parade"], "ADBE Geometry2");
        try {
            acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0009"]).setValue(0);
            acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0010"]).setValue(180);
        } catch (e2) {}
        if (opts.scale) {
            trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0003"]), k, opts.scale);
            trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0004"]), k, opts.scale);
        }
        if (opts.rot) { trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0007"]), k, opts.rot); }
        if (opts.pos) { trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0002"]), k, opts.pos); }
        if (opts.skew) { trExpr(acP(l, ["ADBE Effect Parade", tr, "ADBE Geometry2-0005"]), k, opts.skew); }
        if (opts.blur) {
            s = acAdd(l, ["ADBE Effect Parade"], "ADBE Box Blur2");
            trExpr(acP(l, ["ADBE Effect Parade", s, "ADBE Box Blur2-0001"]), k, opts.blur);
        }
    }

    var TR_GLITCH = "posterizeTime(12);seedRandom(index,false);";

    function trLeak(l, k, colors) {
        var g = acAdd(l, ["ADBE Effect Parade"], "ADBE 4ColorGradient"), i;
        for (i = 0; i < 4; i++) {
            try { acP(l, ["ADBE Effect Parade", g, "ADBE 4ColorGradient-000" + (2 + i * 2)]).setValue(colors[i]); } catch (e0) {}
        }
        trExpr(acP(l, ["ADBE Effect Parade", g, "ADBE 4ColorGradient-0001"]), k,
            "[value[0]+Math.sin(time*1.3)*thisComp.width*0.25,value[1]+Math.cos(time*0.9)*thisComp.height*0.2]");
        trExpr(acP(l, ["ADBE Effect Parade", g, "ADBE 4ColorGradient-0005"]), k,
            "[value[0]+Math.cos(time*1.1)*thisComp.width*0.2,value[1]+Math.sin(time*1.7)*thisComp.height*0.25]");
        try { l.blendingMode = BlendingMode.SCREEN; } catch (e1) {}
        trExpr(acP(l, ["ADBE Transform Group", "ADBE Opacity"]), k, "100*Math.pow(Math.sin(Math.PI*tP()),1.5)*Math.min(1,tK())");
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
        "zoom-in": function (l, k) { trCamera(l, k, { scale: "100*(1+tK()*tSplit(3,-0.6))" }); },
        "zoom-out": function (l, k) { trCamera(l, k, { scale: "100*(1+tK()*tSplit(-0.6,3))" }); },
        "zoom-rotate": function (l, k) { trCamera(l, k, { scale: "100*(1+tK()*tSplit(2,-0.5))", rot: "tK()*tSplit(90,-90)" }); },
        "rotate": function (l, k) { trCamera(l, k, { scale: "100*(1+0.3*tBell()*tK())", rot: "tK()*tSplit(180,-180)" }); },
        "pan-left": function (l, k) { trCamera(l, k, { pos: "[value[0]+tK()*tSplit(-1,1)*thisComp.width,value[1]]" }); },
        "pan-right": function (l, k) { trCamera(l, k, { pos: "[value[0]+tK()*tSplit(1,-1)*thisComp.width,value[1]]" }); },
        "pan-up": function (l, k) { trCamera(l, k, { pos: "[value[0],value[1]+tK()*tSplit(-1,1)*thisComp.height]" }); },
        "pan-down": function (l, k) { trCamera(l, k, { pos: "[value[0],value[1]+tK()*tSplit(1,-1)*thisComp.height]" }); },
        "shake": function (l, k) {
            trCamera(l, k, { scale: "100*(1+0.15*tBell()*tK())", pos: "var a=tBell()*tK();[value[0]+noise(time*18)*90*a,value[1]+noise(time*18+40)*60*a]",
                rot: "noise(time*14+90)*6*tBell()*tK()" });
        },
        "twirl": function (l, k) { trCamera(l, k, { twirl: true, scale: "100*(1+0.5*tBell()*tK())" }); },
        "blur-zoom": function (l, k) { trCamera(l, k, { scale: "100*(1+tK()*tSplit(1.5,-0.3))", blur: "60*tBell()*tK()" }); },
        "glitch": function (l, k) {
            trCamera(l, k, { pos: TR_GLITCH + "var a=tBell()*tK();[value[0]+(random()-0.5)*thisComp.width*0.15*a,value[1]+(random()-0.5)*40*a]",
                skew: TR_GLITCH + "(random()-0.5)*40*tBell()*tK()", scale: TR_GLITCH + "100*(1+random()*0.3*tBell()*tK())" });
        },
        "glitch-shake": function (l, k) {
            trCamera(l, k, { pos: TR_GLITCH + "var a=tBell()*tK();[value[0]+(random()-0.5)*thisComp.width*0.3*a,value[1]+(random()-0.5)*120*a]",
                skew: TR_GLITCH + "(random()-0.5)*70*tBell()*tK()", scale: TR_GLITCH + "100*(1+random()*0.5*tBell()*tK())",
                rot: TR_GLITCH + "(random()-0.5)*16*tBell()*tK()" });
        },
        "leak-warm": function (l, k) { trLeak(l, k, [[1, 0.55, 0.1, 1], [1, 0.2, 0.3, 1], [1, 0.85, 0.4, 1], [0.2, 0.04, 0, 1]]); },
        "leak-cool": function (l, k) { trLeak(l, k, [[0.2, 0.6, 1, 1], [0.6, 0.3, 1, 1], [0.3, 1, 0.9, 1], [0, 0.03, 0.15, 1]]); },
        "flash": function (l, k) {
            trExpr(acP(l, ["ADBE Transform Group", "ADBE Opacity"]), k, "100*Math.pow(Math.max(0,1-Math.abs(tP()*2-1)),3)*Math.min(1,tK())");
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
            m = /\{sft:([a-z0-9\-]+)\}/.exec(String(mv.comment));
            if (!m) { continue; }
            try { params = mv.getParameters() || {}; } catch (e0) { params = {}; }
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

    function shiftOne(layer, what, dt, frame, out) {
        if (what === "layer") { shiftLayer(layer, dt, frame, out); } else { countShift(shiftTransition(layer, what, dt, frame, out), out); }
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

    // Each next layer is moved `frames` frames further than the one before it.
    // order: "asc" (from the top layer down), "desc" (from the bottom up), "selection" or "random".
    function staggerSelected(comp, what, frames, order) {
        var layers = comp.selectedLayers;
        var frame = comp.frameDuration;
        var out = newShiftCount(layers.length);
        var list = [];
        var i, j, tmp, step;
        for (i = 0; i < layers.length; i++) {
            // A layer with nothing to move does not take a step of the staircase.
            if (what !== "layer" && !findTransition(layers[i], what).count) { out.skipped++; continue; }
            list.push(layers[i]);
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
                    mv = new MarkerValue((labels.marker || "Cut: ") + (labels.title || id) + " {sft:" + id + "}");
                    try { mv.setParameters({ sk: k }); } catch (e2) {}
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
                var out = { applied: 0, removed: 0, skipped: [] }, i, j, l, all, have, sk;
                if (!SF_MOTIONS[motion] || !SF_CURVES[curve]) { throw new Error("UNKNOWN_PRESET"); }
                if (!(comp.selectedLayers || []).length) { throw new Error("NO_LAYERS_SELECTED"); }
                labels = labels || {};
                app.beginUndoGroup("Sayframe: " + motion);
                try {
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
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer), transition: trDescribe(e.layer) };
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
                var e = acEditLayer(), fx = sfFx(e.layer, name);
                if (!fx) { throw new Error("PRESET_GONE"); }
                app.beginUndoGroup("Sayframe: setting");
                try {
                    fx.property(1).setValue(Number(value));
                } finally {
                    app.endUndoGroup();
                }
                return { layer: String(e.layer.name), groups: sfDescribe(e.layer), transition: trDescribe(e.layer) };
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
        acSound: function (path, binName) {
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
                } finally {
                    app.endUndoGroup();
                }
                return { name: String(item.name), reused: reused };
            });
        },

        // FX Console: every installed effect plus the animation presets (.ffx) After Effects ships with
        // and the ones the user saved.
        fxCatalog: function () {
            return reply(function () {
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
            });
        },

        // Adds the effect to every selected layer that can take effects (not cameras or lights).
        applyEffect: function (matchName, label) {
            return reply(function () {
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
            });
        },

        applyPreset: function (path, label) {
            return reply(function () {
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
            });
        },

        // Saves the frame at the time indicator of the open comp as a PNG in the given folder.
        // Saves the frame at the time indicator of the open comp as a PNG. A save dialog opens in the
        // project's folder (or fallbackFolder for an unsaved project); returns snap: null on Cancel.
        snapFrame: function (fallbackFolder, stamp, prompt) {
            return reply(function () {
                var comp = activeComp();
                var proj = app.project;
                var folder = proj.file && proj.file.parent ? proj.file.parent.fsName : fallbackFolder;
                var name = String(comp.name).replace(/[\\\/:\*\?"<>\|]/g, "_") + "_" + stamp + ".png";
                var file = new File(folder + "/" + name);
                if (prompt) {
                    file = file.saveDlg(prompt);
                    if (!file) { return { snap: null, folder: folder }; }
                    if (!/\.png$/i.test(file.fsName)) { file = new File(file.fsName + ".png"); }
                }
                comp.saveFrameToPng(comp.time, file);
                if (!waitForFile(file.fsName, 20000)) { throw new Error("FRAME_NOT_SAVED"); }
                return { snap: { path: file.fsName, comp: String(comp.name), time: comp.time }, folder: folder };
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

        // Staircase: every next layer (or its "in"/"out" animation) starts a few frames later.
        stagger: function (what, frames, order) {
            return reply(function () {
                var comp = activeComp();
                var res;
                frames = Math.round(Number(frames));
                if (what !== "in" && what !== "out" && what !== "layer") { throw new Error("BAD_SHIFT_TARGET"); }
                if (order !== "asc" && order !== "desc" && order !== "selection" && order !== "random") { throw new Error("BAD_STAGGER_ORDER"); }
                if (isNaN(frames) || frames === 0 || Math.abs(frames) > 100000) { throw new Error("BAD_SHIFT_FRAMES"); }
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
