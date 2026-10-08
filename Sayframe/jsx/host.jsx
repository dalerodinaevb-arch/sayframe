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
