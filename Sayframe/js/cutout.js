/* Sayframe — вырезание фона на фото (блок «Вырезать фон»).
   Здесь только расчёт маски, без интерфейса: GrabCut (модель цветов объекта и фона + разрез графа)
   на уменьшенной копии кадра и уточнение края по исходному кадру (guided filter).
   Работает и в панели, и в Node (для проверки): window.SayframeCutout / module.exports. */
(function (root) {
    "use strict";

    // ------------------------------------------------------------ максимальный поток (Бойков—Колмогоров)
    // Граф: n вершин, рёбра парами (дуга a и встречная a^1). trcap > 0 — ребро от истока, < 0 — к стоку.
    var TERMINAL = -2, ORPHAN = -3, NONE = -1;

    function Graph(n, maxArcs) {
        this.n = n;
        this.first = new Int32Array(n).fill(-1);
        this.head = new Int32Array(maxArcs);
        this.next = new Int32Array(maxArcs);
        this.rcap = new Float64Array(maxArcs);
        this.trcap = new Float64Array(n);
        this.na = 0;
    }
    Graph.prototype.addEdge = function (i, j, cap, revCap) {
        var a = this.na;
        this.na += 2;
        this.head[a] = j; this.next[a] = this.first[i]; this.first[i] = a; this.rcap[a] = cap;
        this.head[a + 1] = i; this.next[a + 1] = this.first[j]; this.first[j] = a + 1; this.rcap[a + 1] = revCap;
    };
    Graph.prototype.addTWeights = function (i, toSource, toSink) {
        this.trcap[i] += toSource - toSink;
    };

    // Возвращает Uint8Array: 1 — вершина на стороне истока (объект), 0 — на стороне стока (фон).
    Graph.prototype.maxflow = function () {
        var n = this.n, first = this.first, head = this.head, next = this.next, rcap = this.rcap, trcap = this.trcap;
        var parent = new Int32Array(n), isSink = new Uint8Array(n), ts = new Int32Array(n), dist = new Int32Array(n);
        var inQ = new Uint8Array(n), q = new Int32Array(n), qh = 0, qt = 0, qn = 0;
        var orph = new Int32Array(n), oh = 0, ot = 0, on = 0;
        var time = 0, i, j, a, a0, cur = -1, found, b, k, d, dmin, a0min, INF = 1e9, out;

        function activate(v) { if (!inQ[v]) { inQ[v] = 1; q[qt] = v; qt = (qt + 1) % n; qn++; } }
        function popActive() {
            var v;
            while (qn) {
                v = q[qh]; qh = (qh + 1) % n; qn--; inQ[v] = 0;
                if (parent[v] !== NONE) { return v; }
            }
            return -1;
        }
        function orphan(v) { parent[v] = ORPHAN; orph[ot] = v; ot = (ot + 1) % n; on++; }

        for (i = 0; i < n; i++) {
            if (trcap[i] > 0) { isSink[i] = 0; parent[i] = TERMINAL; ts[i] = 0; dist[i] = 1; activate(i); }
            else if (trcap[i] < 0) { isSink[i] = 1; parent[i] = TERMINAL; ts[i] = 0; dist[i] = 1; activate(i); }
            else { parent[i] = NONE; }
        }

        for (;;) {
            if (cur !== -1 && parent[cur] === NONE) { cur = -1; }
            if (cur === -1) { cur = popActive(); if (cur === -1) { break; } }
            i = cur;
            found = -1;
            if (!isSink[i]) {
                for (a = first[i]; a !== -1; a = next[a]) {
                    if (rcap[a] > 0) {
                        j = head[a];
                        if (parent[j] === NONE) {
                            isSink[j] = 0; parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; activate(j);
                        } else if (isSink[j]) { found = a; break; }
                        else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; }
                    }
                }
            } else {
                for (a = first[i]; a !== -1; a = next[a]) {
                    if (rcap[a ^ 1] > 0) {
                        j = head[a];
                        if (parent[j] === NONE) {
                            isSink[j] = 1; parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; activate(j);
                        } else if (!isSink[j]) { found = a ^ 1; break; }
                        else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; }
                    }
                }
            }
            time++;
            if (found === -1) { cur = -1; continue; }

            // Путь: исток … head[found^1] → head[found] … сток.
            a = found;
            b = rcap[a];
            for (k = head[a ^ 1]; ; k = head[parent[k]]) {
                a0 = parent[k];
                if (a0 === TERMINAL) { break; }
                if (b > rcap[a0 ^ 1]) { b = rcap[a0 ^ 1]; }
            }
            if (b > trcap[k]) { b = trcap[k]; }
            for (k = head[a]; ; k = head[parent[k]]) {
                a0 = parent[k];
                if (a0 === TERMINAL) { break; }
                if (b > rcap[a0]) { b = rcap[a0]; }
            }
            if (b > -trcap[k]) { b = -trcap[k]; }

            rcap[a ^ 1] += b; rcap[a] -= b;
            for (k = head[a ^ 1]; ; ) {
                a0 = parent[k];
                if (a0 === TERMINAL) { trcap[k] -= b; if (trcap[k] <= 0) { trcap[k] = 0; orphan(k); } break; }
                rcap[a0] += b; rcap[a0 ^ 1] -= b;
                if (rcap[a0 ^ 1] <= 0) { rcap[a0 ^ 1] = 0; orphan(k); }
                k = head[a0];
            }
            for (k = head[a]; ; ) {
                a0 = parent[k];
                if (a0 === TERMINAL) { trcap[k] += b; if (trcap[k] >= 0) { trcap[k] = 0; orphan(k); } break; }
                rcap[a0 ^ 1] += b; rcap[a0] -= b;
                if (rcap[a0] <= 0) { rcap[a0] = 0; orphan(k); }
                k = head[a0];
            }

            // Усыновление сирот.
            while (on) {
                i = orph[oh]; oh = (oh + 1) % n; on--;
                dmin = INF; a0min = -1;
                for (a0 = first[i]; a0 !== -1; a0 = next[a0]) {
                    if ((isSink[i] ? rcap[a0] : rcap[a0 ^ 1]) <= 0) { continue; }
                    j = head[a0];
                    if (isSink[j] !== isSink[i] || parent[j] === NONE) { continue; }
                    d = 0;
                    for (k = j; ; ) {
                        if (ts[k] === time) { d += dist[k]; break; }
                        a = parent[k];
                        d++;
                        if (a === TERMINAL) { ts[k] = time; dist[k] = 1; break; }
                        if (a === ORPHAN) { d = INF; break; }
                        k = head[a];
                    }
                    if (d < INF) {
                        if (d < dmin) { a0min = a0; dmin = d; }
                        for (k = j; ts[k] !== time; k = head[parent[k]]) { ts[k] = time; dist[k] = d; d--; }
                    }
                }
                if (a0min !== -1) {
                    parent[i] = a0min; ts[i] = time; dist[i] = dmin + 1;
                } else {
                    parent[i] = NONE;
                    if (inQ[i] === 0 && i === cur) { cur = -1; }
                    for (a0 = first[i]; a0 !== -1; a0 = next[a0]) {
                        j = head[a0];
                        if (isSink[j] !== isSink[i]) { continue; }
                        a = parent[j];
                        if (a === NONE) { continue; }
                        if ((isSink[i] ? rcap[a0] : rcap[a0 ^ 1]) > 0) { activate(j); }
                        if (a !== TERMINAL && a !== ORPHAN && head[a] === i) { orphan(j); }
                    }
                }
            }
        }

        out = new Uint8Array(n);
        for (i = 0; i < n; i++) { out[i] = parent[i] !== NONE && !isSink[i] ? 1 : 0; }
        return out;
    };

    // ------------------------------------------------------------ модель цветов (смесь гауссиан)
    var K = 5;

    function rng(seed) {
        var s = seed >>> 0;
        return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }

    // Цвета выборки → k средних (k-means++, 8 проходов).
    function kmeans(px, idx, k, rand) {
        var m = idx.length, cent = new Float64Array(k * 3), d2 = new Float64Array(m), lab = new Int32Array(m);
        var c, i, t, s, best, bd, dd, dx, dy, dz, it, sum, cnt, p;
        p = idx[Math.floor(rand() * m)] * 3;
        cent[0] = px[p]; cent[1] = px[p + 1]; cent[2] = px[p + 2];
        for (c = 1; c < k; c++) {
            sum = 0;
            for (i = 0; i < m; i++) {
                p = idx[i] * 3; bd = Infinity;
                for (t = 0; t < c; t++) {
                    dx = px[p] - cent[t * 3]; dy = px[p + 1] - cent[t * 3 + 1]; dz = px[p + 2] - cent[t * 3 + 2];
                    dd = dx * dx + dy * dy + dz * dz;
                    if (dd < bd) { bd = dd; }
                }
                d2[i] = bd; sum += bd;
            }
            s = rand() * sum; i = 0;
            if (sum > 0) { while (i < m - 1 && (s -= d2[i]) > 0) { i++; } } else { i = Math.floor(rand() * m); }
            p = idx[i] * 3;
            cent[c * 3] = px[p]; cent[c * 3 + 1] = px[p + 1]; cent[c * 3 + 2] = px[p + 2];
        }
        for (it = 0; it < 8; it++) {
            for (i = 0; i < m; i++) {
                p = idx[i] * 3; bd = Infinity; best = 0;
                for (t = 0; t < k; t++) {
                    dx = px[p] - cent[t * 3]; dy = px[p + 1] - cent[t * 3 + 1]; dz = px[p + 2] - cent[t * 3 + 2];
                    dd = dx * dx + dy * dy + dz * dz;
                    if (dd < bd) { bd = dd; best = t; }
                }
                lab[i] = best;
            }
            cnt = new Float64Array(k); sum = new Float64Array(k * 3);
            for (i = 0; i < m; i++) {
                p = idx[i] * 3; t = lab[i]; cnt[t]++;
                sum[t * 3] += px[p]; sum[t * 3 + 1] += px[p + 1]; sum[t * 3 + 2] += px[p + 2];
            }
            for (t = 0; t < k; t++) {
                if (cnt[t]) { cent[t * 3] = sum[t * 3] / cnt[t]; cent[t * 3 + 1] = sum[t * 3 + 1] / cnt[t]; cent[t * 3 + 2] = sum[t * 3 + 2] / cnt[t]; }
            }
        }
        return lab;
    }

    function GMM() {
        this.w = new Float64Array(K); this.mean = new Float64Array(K * 3);
        this.inv = new Float64Array(K * 9); this.coef = new Float64Array(K);
    }
    // Параметры по пикселям idx с номерами компонент comp.
    GMM.prototype.learn = function (px, idx, comp) {
        var s = new Float64Array(K * 3), pr = new Float64Array(K * 9), cnt = new Float64Array(K);
        var i, p, c, r, g, b, tot = idx.length, m, cv, det, e = 0.01;
        for (i = 0; i < tot; i++) {
            p = idx[i] * 3; c = comp[i]; r = px[p]; g = px[p + 1]; b = px[p + 2];
            cnt[c]++; s[c * 3] += r; s[c * 3 + 1] += g; s[c * 3 + 2] += b;
            pr[c * 9] += r * r; pr[c * 9 + 1] += r * g; pr[c * 9 + 2] += r * b;
            pr[c * 9 + 4] += g * g; pr[c * 9 + 5] += g * b; pr[c * 9 + 8] += b * b;
        }
        for (c = 0; c < K; c++) {
            this.w[c] = tot ? cnt[c] / tot : 0;
            if (!cnt[c]) { this.coef[c] = 0; continue; }
            m = [s[c * 3] / cnt[c], s[c * 3 + 1] / cnt[c], s[c * 3 + 2] / cnt[c]];
            this.mean[c * 3] = m[0]; this.mean[c * 3 + 1] = m[1]; this.mean[c * 3 + 2] = m[2];
            cv = [pr[c * 9] / cnt[c] - m[0] * m[0] + e, pr[c * 9 + 1] / cnt[c] - m[0] * m[1], pr[c * 9 + 2] / cnt[c] - m[0] * m[2],
                0, pr[c * 9 + 4] / cnt[c] - m[1] * m[1] + e, pr[c * 9 + 5] / cnt[c] - m[1] * m[2],
                0, 0, pr[c * 9 + 8] / cnt[c] - m[2] * m[2] + e];
            cv[3] = cv[1]; cv[6] = cv[2]; cv[7] = cv[5];
            det = cv[0] * (cv[4] * cv[8] - cv[5] * cv[7]) - cv[1] * (cv[3] * cv[8] - cv[5] * cv[6]) + cv[2] * (cv[3] * cv[7] - cv[4] * cv[6]);
            if (!(det > 1e-12)) { det = 1e-12; }
            this.inv[c * 9] = (cv[4] * cv[8] - cv[5] * cv[7]) / det;
            this.inv[c * 9 + 1] = (cv[2] * cv[7] - cv[1] * cv[8]) / det;
            this.inv[c * 9 + 2] = (cv[1] * cv[5] - cv[2] * cv[4]) / det;
            this.inv[c * 9 + 3] = (cv[5] * cv[6] - cv[3] * cv[8]) / det;
            this.inv[c * 9 + 4] = (cv[0] * cv[8] - cv[2] * cv[6]) / det;
            this.inv[c * 9 + 5] = (cv[2] * cv[3] - cv[0] * cv[5]) / det;
            this.inv[c * 9 + 6] = (cv[3] * cv[7] - cv[4] * cv[6]) / det;
            this.inv[c * 9 + 7] = (cv[1] * cv[6] - cv[0] * cv[7]) / det;
            this.inv[c * 9 + 8] = (cv[0] * cv[4] - cv[1] * cv[3]) / det;
            this.coef[c] = this.w[c] / Math.sqrt(det);
        }
    };
    GMM.prototype.compProb = function (c, r, g, b) {
        var o = c * 9, dr, dg, db, q;
        if (!this.coef[c]) { return 0; }
        dr = r - this.mean[c * 3]; dg = g - this.mean[c * 3 + 1]; db = b - this.mean[c * 3 + 2];
        q = dr * (dr * this.inv[o] + dg * this.inv[o + 3] + db * this.inv[o + 6]) +
            dg * (dr * this.inv[o + 1] + dg * this.inv[o + 4] + db * this.inv[o + 7]) +
            db * (dr * this.inv[o + 2] + dg * this.inv[o + 5] + db * this.inv[o + 8]);
        return this.coef[c] * Math.exp(-0.5 * q);
    };
    GMM.prototype.prob = function (r, g, b) {
        var c, s = 0;
        for (c = 0; c < K; c++) { s += this.compProb(c, r, g, b); }
        return s;
    };
    GMM.prototype.best = function (r, g, b) {
        var c, v, bv = -1, bc = 0;
        for (c = 0; c < K; c++) { v = this.compProb(c, r, g, b); if (v > bv) { bv = v; bc = c; } }
        return bc;
    };

    // ------------------------------------------------------------ GrabCut
    // rgb — Float32Array w*h*3 (0..255); seeds — Int8Array w*h: 1 точно объект, -1 точно фон, 0 неизвестно.
    // Возвращает Uint8Array w*h: 1 — объект.
    function grabcut(rgb, w, h, seeds, iters) {
        var n = w * h, gamma = 50, lambda = 9 * gamma, beta, i, x, y, p, q, d, s, cnt, it;
        var lab = new Uint8Array(n), wts, dirs = [[1, 0], [0, 1], [1, 1], [-1, 1]], dw, di, dx, dy;
        var fg = new GMM(), bg = new GMM(), rand = rng(7), fgIdx, bgIdx, comp, g, hasFg = false, hasBg = false;
        var MAXS = 30000;

        for (i = 0; i < n; i++) {
            lab[i] = seeds[i] < 0 ? 0 : 1;
            if (seeds[i] > 0) { hasFg = true; }
            if (seeds[i] < 0) { hasBg = true; }
        }
        if (!hasBg) { return lab; }

        // beta — по средней разнице соседних цветов.
        s = 0; cnt = 0;
        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                p = (y * w + x) * 3;
                for (di = 0; di < 4; di++) {
                    dx = x + dirs[di][0]; dy = y + dirs[di][1];
                    if (dx < 0 || dx >= w || dy >= h) { continue; }
                    q = (dy * w + dx) * 3;
                    d = sq(rgb, p, q); s += d; cnt++;
                }
            }
        }
        beta = s > 0 ? 1 / (2 * s / cnt) : 0;
        wts = new Float64Array(n * 4);
        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                i = y * w + x; p = i * 3;
                for (di = 0; di < 4; di++) {
                    dx = x + dirs[di][0]; dy = y + dirs[di][1];
                    if (dx < 0 || dx >= w || dy >= h) { continue; }
                    q = (dy * w + dx) * 3;
                    dw = di >= 2 ? gamma / Math.SQRT2 : gamma;
                    wts[i * 4 + di] = dw * Math.exp(-beta * sq(rgb, p, q));
                }
            }
        }

        function sample(want) {
            var all = [], k, step;
            for (k = 0; k < n; k++) { if (lab[k] === want) { all.push(k); } }
            if (all.length <= MAXS) { return Int32Array.from(all); }
            step = all.length / MAXS;
            return Int32Array.from({ length: MAXS }, function (_, t) { return all[Math.floor(t * step)]; });
        }
        function assign(gm, idx) {
            var out = new Int32Array(idx.length), k, o;
            for (k = 0; k < idx.length; k++) { o = idx[k] * 3; out[k] = gm.best(rgb[o], rgb[o + 1], rgb[o + 2]); }
            return out;
        }

        fgIdx = sample(1); bgIdx = sample(0);
        if (fgIdx.length < K || bgIdx.length < K) { return lab; }
        fg.learn(rgb, fgIdx, kmeans(rgb, fgIdx, K, rand));
        bg.learn(rgb, bgIdx, kmeans(rgb, bgIdx, K, rand));

        for (it = 0; it < iters; it++) {
            if (it > 0) {
                fgIdx = sample(1); bgIdx = sample(0);
                if (fgIdx.length < K || bgIdx.length < K) { break; }
                comp = assign(fg, fgIdx); fg.learn(rgb, fgIdx, comp);
                comp = assign(bg, bgIdx); bg.learn(rgb, bgIdx, comp);
            }
            g = new Graph(n, n * 8);
            for (i = 0; i < n; i++) {
                p = i * 3;
                if (seeds[i] > 0) { g.addTWeights(i, lambda, 0); }
                else if (seeds[i] < 0) { g.addTWeights(i, 0, lambda); }
                else {
                    g.addTWeights(i, -Math.log(Math.max(1e-300, bg.prob(rgb[p], rgb[p + 1], rgb[p + 2]))),
                        -Math.log(Math.max(1e-300, fg.prob(rgb[p], rgb[p + 1], rgb[p + 2]))));
                }
            }
            for (y = 0; y < h; y++) {
                for (x = 0; x < w; x++) {
                    i = y * w + x;
                    for (di = 0; di < 4; di++) {
                        dx = x + dirs[di][0]; dy = y + dirs[di][1];
                        if (dx < 0 || dx >= w || dy >= h) { continue; }
                        g.addEdge(i, dy * w + dx, wts[i * 4 + di], wts[i * 4 + di]);
                    }
                }
            }
            lab = g.maxflow();
            for (i = 0; i < n; i++) { if (seeds[i] > 0) { lab[i] = 1; } else if (seeds[i] < 0) { lab[i] = 0; } }
        }
        if (hasFg) { lab = keepTouching(lab, seeds, w, h); }
        return lab;
    }

    function sq(a, p, q) {
        var r = a[p] - a[q], g = a[p + 1] - a[q + 1], b = a[p + 2] - a[q + 2];
        return r * r + g * g + b * b;
    }

    // Оставляет только куски объекта, которых коснулся щелчок «оставить» (островки фона того же цвета уходят).
    function keepTouching(lab, seeds, w, h) {
        var n = w * h, out = new Uint8Array(n), st = new Int32Array(n), sp = 0, i, v, x, y;
        for (i = 0; i < n; i++) { if (seeds[i] > 0 && lab[i]) { out[i] = 1; st[sp++] = i; } }
        while (sp) {
            v = st[--sp]; x = v % w; y = (v - x) / w;
            if (x > 0 && lab[v - 1] && !out[v - 1]) { out[v - 1] = 1; st[sp++] = v - 1; }
            if (x < w - 1 && lab[v + 1] && !out[v + 1]) { out[v + 1] = 1; st[sp++] = v + 1; }
            if (y > 0 && lab[v - w] && !out[v - w]) { out[v - w] = 1; st[sp++] = v - w; }
            if (y < h - 1 && lab[v + w] && !out[v + w]) { out[v + w] = 1; st[sp++] = v + w; }
        }
        return out;
    }

    // ------------------------------------------------------------ картинки
    // Уменьшение RGBA (w,h) до (dw,dh) усреднением → Float32Array dw*dh*3.
    function shrinkRGB(rgba, w, h, dw, dh) {
        var out = new Float32Array(dw * dh * 3), x, y, sx0, sx1, sy0, sy1, sx, sy, r, g, b, c, p, o;
        for (y = 0; y < dh; y++) {
            sy0 = Math.floor(y * h / dh); sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / dh));
            for (x = 0; x < dw; x++) {
                sx0 = Math.floor(x * w / dw); sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / dw));
                r = g = b = c = 0;
                for (sy = sy0; sy < sy1; sy++) {
                    for (sx = sx0; sx < sx1; sx++) { p = (sy * w + sx) * 4; r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; c++; }
                }
                o = (y * dw + x) * 3;
                out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c;
            }
        }
        return out;
    }

    // Яркость RGBA (0..1).
    function luma(rgba, n) {
        var out = new Float32Array(n), i, p;
        for (i = 0; i < n; i++) { p = i * 4; out[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255; }
        return out;
    }

    // Билинейное увеличение поля (w,h) → (dw,dh).
    function resize(src, w, h, dw, dh) {
        var out = new Float32Array(dw * dh), x, y, fx, fy, x0, y0, x1, y1, ax, ay;
        for (y = 0; y < dh; y++) {
            fy = Math.min(h - 1, Math.max(0, (y + 0.5) * h / dh - 0.5)); y0 = Math.floor(fy); y1 = Math.min(h - 1, y0 + 1); ay = fy - y0;
            for (x = 0; x < dw; x++) {
                fx = Math.min(w - 1, Math.max(0, (x + 0.5) * w / dw - 0.5)); x0 = Math.floor(fx); x1 = Math.min(w - 1, x0 + 1); ax = fx - x0;
                out[y * dw + x] = (src[y0 * w + x0] * (1 - ax) + src[y0 * w + x1] * ax) * (1 - ay) +
                    (src[y1 * w + x0] * (1 - ax) + src[y1 * w + x1] * ax) * ay;
            }
        }
        return out;
    }

    // Среднее в окне (2r+1)² — через суммы по строкам и столбцам; на краях окно обрезается.
    function box(src, w, h, r) {
        var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, s, row, lo, hi;
        for (y = 0; y < h; y++) {
            row = y * w; s = 0;
            for (x = 0; x <= Math.min(r, w - 1); x++) { s += src[row + x]; }
            for (x = 0; x < w; x++) {
                lo = Math.max(0, x - r); hi = Math.min(w - 1, x + r);
                tmp[row + x] = s / (hi - lo + 1);
                if (x + r + 1 < w) { s += src[row + x + r + 1]; }
                if (x - r >= 0) { s -= src[row + x - r]; }
            }
        }
        for (x = 0; x < w; x++) {
            s = 0;
            for (y = 0; y <= Math.min(r, h - 1); y++) { s += tmp[y * w + x]; }
            for (y = 0; y < h; y++) {
                lo = Math.max(0, y - r); hi = Math.min(h - 1, y + r);
                out[y * w + x] = s / (hi - lo + 1);
                if (y + r + 1 < h) { s += tmp[(y + r + 1) * w + x]; }
                if (y - r >= 0) { s -= tmp[(y - r) * w + x]; }
            }
        }
        return out;
    }

    // Guided filter (He и др.): грубая маска p подстраивается под края кадра I.
    function guided(I, p, w, h, r, eps) {
        var n = w * h, mI = box(I, w, h, r), mp = box(p, w, h, r), II = new Float32Array(n), Ip = new Float32Array(n);
        var i, mII, mIp, a = new Float32Array(n), b = new Float32Array(n), v, out = new Float32Array(n);
        for (i = 0; i < n; i++) { II[i] = I[i] * I[i]; Ip[i] = I[i] * p[i]; }
        mII = box(II, w, h, r); mIp = box(Ip, w, h, r);
        for (i = 0; i < n; i++) {
            v = mII[i] - mI[i] * mI[i];
            a[i] = (mIp[i] - mI[i] * mp[i]) / (v + eps);
            b[i] = mp[i] - a[i] * mI[i];
        }
        a = box(a, w, h, r); b = box(b, w, h, r);
        for (i = 0; i < n; i++) { v = a[i] * I[i] + b[i]; out[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
        return out;
    }

    // Мягкий край: размытие маски (три прохода «среднего в окне» ≈ гаусс).
    function feather(alpha, w, h, radius) {
        var r = Math.round(radius), out = alpha;
        if (r < 1) { return alpha; }
        out = box(out, w, h, Math.max(1, Math.round(r / 2)));
        out = box(out, w, h, Math.max(1, Math.round(r / 2)));
        return box(out, w, h, Math.max(1, Math.round(r / 2)));
    }

    // ------------------------------------------------------------ метки пользователя
    // marks: [{ v: 1 | -1, r: радиус (доля длинной стороны), pts: [x, y, x, y, …] (доли ширины и высоты) }].
    // Рисует их в поле w×h: значения 1 / -1, последняя метка сверху.
    function paintMarks(marks, w, h, field) {
        var out = field || new Int8Array(w * h), m, k, L = Math.max(w, h), r, x0, y0, x1, y1, t, steps, s;
        for (m = 0; m < marks.length; m++) {
            r = Math.max(1, marks[m].r * L);
            if (marks[m].pts.length === 2) { disk(out, w, h, marks[m].pts[0] * w, marks[m].pts[1] * h, r, marks[m].v); continue; }
            for (k = 0; k + 3 < marks[m].pts.length; k += 2) {
                x0 = marks[m].pts[k] * w; y0 = marks[m].pts[k + 1] * h; x1 = marks[m].pts[k + 2] * w; y1 = marks[m].pts[k + 3] * h;
                steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, r / 2)));
                for (s = 0; s <= steps; s++) { t = s / steps; disk(out, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, marks[m].v); }
            }
        }
        return out;
    }
    function disk(out, w, h, cx, cy, r, v) {
        var x, y, xa = Math.max(0, Math.floor(cx - r)), xb = Math.min(w - 1, Math.ceil(cx + r)),
            ya = Math.max(0, Math.floor(cy - r)), yb = Math.min(h - 1, Math.ceil(cy + r)), r2 = r * r;
        for (y = ya; y <= yb; y++) {
            for (x = xa; x <= xb; x++) {
                if ((x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - cy) * (y + 0.5 - cy) <= r2) { out[y * w + x] = v; }
            }
        }
    }

    // ------------------------------------------------------------ всё вместе
    var WORK_MAX = 320;

    // Размер рабочей копии для кадра w×h.
    function workSize(w, h, max) {
        var k = Math.min(1, (max || WORK_MAX) / Math.max(w, h));
        return { w: Math.max(8, Math.round(w * k)), h: Math.max(8, Math.round(h * k)) };
    }

    // Объект по щелчкам и кисти (без macOS): метки «оставить» — зёрна объекта, рамка кадра и метки «убрать» — фона.
    // Если объект касается края кадра, рамка не считается фоном там, где её задела кисть «оставить».
    // Возвращает Float32Array ws.w*ws.h (0..1).
    function solve(rgba, w, h, marks, opts) {
        var ws = workSize(w, h, opts && opts.work), rgb = shrinkRGB(rgba, w, h, ws.w, ws.h), n = ws.w * ws.h;
        var seeds = new Int8Array(n), x, y, band = Math.max(1, Math.round(Math.max(ws.w, ws.h) / 100)), lab, out, i, user;
        for (y = 0; y < ws.h; y++) {
            for (x = 0; x < ws.w; x++) {
                if (x < band || y < band || x >= ws.w - band || y >= ws.h - band) { seeds[y * ws.w + x] = -1; }
            }
        }
        user = paintMarks(marks, ws.w, ws.h);
        for (i = 0; i < n; i++) { if (user[i]) { seeds[i] = user[i]; } }
        lab = grabcut(rgb, ws.w, ws.h, seeds, (opts && opts.iters) || 4);
        out = new Float32Array(n);
        for (i = 0; i < n; i++) { out[i] = lab[i]; }
        return { w: ws.w, h: ws.h, alpha: out };
    }

    // Маска рабочего размера → маска w×h с краем по кадру (guided filter) и метками кисти поверх.
    function refine(rgba, w, h, coarse, cw, ch, marks, edge) {
        var up = resize(coarse, cw, ch, w, h), I = luma(rgba, w * h), k = w / cw, r = Math.max(2, Math.round(k * 1.5) + 1), out, user, i;
        out = guided(I, up, w, h, r, 1e-3);
        if (marks && marks.length) {
            user = paintMarks(marks, w, h);
            for (i = 0; i < w * h; i++) { if (user[i] > 0) { out[i] = 1; } else if (user[i] < 0) { out[i] = 0; } }
        }
        return edge > 0 ? feather(out, w, h, edge * Math.max(w, h) / 1000) : out;
    }

    var api = {
        Graph: Graph, grabcut: grabcut, solve: solve, refine: refine, resize: resize, guided: guided,
        feather: feather, box: box, luma: luma, paintMarks: paintMarks, shrinkRGB: shrinkRGB, workSize: workSize
    };
    if (typeof module !== "undefined" && module.exports) { module.exports = api; }
    if (root) { root.SayframeCutout = api; }
}(typeof window !== "undefined" ? window : null));
