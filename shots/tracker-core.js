// FLOORBALL IQ – Shot Tracker core.
// Pure detection logic: no DOM, no camera. Works on RGBA pixel arrays so it
// can run in the browser and in node tests (test/run-tests.mjs).
(function (root) {
  'use strict';

  // ---------- Geometry ----------

  // Solve an 8x8 linear system (Gaussian elimination with pivoting).
  function solve(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      [b[c], b[p]] = [b[p], b[c]];
      const d = A[c][c];
      if (Math.abs(d) < 1e-12) return null;
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / d;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  // Homography mapping 4 src points to 4 dst points ({x,y}).
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], u = dst[i].x, v = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return h ? [...h, 1] : null;
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
  }

  const UNIT = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  // corners: TL, TR, BR, BL of the goal opening (image coords).
  // toGoal maps image -> (u right, v down) in the unit square; toImage the reverse.
  function goalMapping(corners) {
    const toGoal = homography(corners, UNIT);
    const toImage = homography(UNIT, corners);
    if (!toGoal || !toImage) return null;
    const w = (dist(corners[0], corners[1]) + dist(corners[3], corners[2])) / 2;
    const h = (dist(corners[0], corners[3]) + dist(corners[1], corners[2])) / 2;
    return { toGoal, toImage, widthPx: w, heightPx: h };
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Corners must form a convex quad in TL, TR, BR, BL order (clockwise on screen).
  function isValidQuad(c) {
    if (!c || c.length !== 4) return false;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
      const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
      if (Math.abs(cross) < 1) return false;
      const s = Math.sign(cross);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return sign > 0 && c[0].x < c[1].x && c[3].x < c[2].x && c[0].y < c[3].y && c[1].y < c[2].y;
  }

  const ZONE_COLS = ['left', 'centre', 'right'];
  const ZONE_ROWS = { 2: ['Top', 'Bottom'], 3: ['Top', 'Middle', 'Bottom'] };

  // Zone in a 3x2 or 3x3 grid of the goal opening, seen from the shooter.
  function zoneOf(u, v, rows) {
    rows = rows === 3 ? 3 : 2;
    const col = Math.min(2, Math.max(0, Math.floor(u * 3)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
    return { col, row, index: row * 3 + col, label: ZONE_ROWS[rows][row] + ' ' + ZONE_COLS[col] };
  }
  function zoneLabels(rows) {
    rows = rows === 3 ? 3 : 2;
    const out = [];
    for (const r of ZONE_ROWS[rows]) for (const c of ZONE_COLS) out.push(r + ' ' + c);
    return out;
  }

  // ---------- Colour ----------

  function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max / 255 };
  }

  // ---------- Detector: background model + ball mask + blobs ----------

  const DEFAULTS = {
    sensitivity: 20,      // min colour difference to the background (0-255 scale)
    ballColour: null,     // null = white ball, or {h,s,v} sampled from the ball
    bgAlpha: 0.03,        // background update speed for non-ball pixels
    fgAlpha: 0.006,       // slower update where the ball is (a resting ball stays visible ~2-3 s)
    globalChange: 0.25,   // share of changed pixels that means "camera moved / exposure jump"
  };

  class Detector {
    constructor(width, height, ballRadiusPx, opts) {
      this.w = width; this.h = height;
      this.opts = Object.assign({}, DEFAULTS, opts || {});
      this.setBallRadius(ballRadiusPx);
      const n = width * height;
      this.bg = new Float32Array(n * 3);
      this.mask = new Uint8Array(n);
      this.labels = new Int32Array(n);
      this.stack = new Int32Array(n);
      this.ready = false;
      this.frames = 0;
    }

    setBallRadius(r) {
      this.ballR = Math.max(1.5, r);
      const area = Math.PI * this.ballR * this.ballR;
      this.minArea = Math.max(3, area * 0.2);
      this.maxArea = area * 25;
    }

    reset() { this.ready = false; this.frames = 0; }

    // Copy the current frame into the background around (x, y): a ball that
    // came to rest stops being "new" at once instead of fading slowly.
    absorb(rgba, x, y, r) {
      const { w, h, bg } = this;
      for (let yy = Math.max(0, Math.floor(y - r)); yy < Math.min(h, Math.ceil(y + r)); yy++)
        for (let xx = Math.max(0, Math.floor(x - r)); xx < Math.min(w, Math.ceil(x + r)); xx++) {
          const i = yy * w + xx, j = i * 4, k = i * 3;
          bg[k] = rgba[j]; bg[k + 1] = rgba[j + 1]; bg[k + 2] = rgba[j + 2];
        }
    }

    // rgba: Uint8ClampedArray (w*h*4); dtMs: time since the last frame.
    // Returns {blobs, changed, skipped}.
    process(rgba, dtMs) {
      const { w, h, bg, mask } = this, n = w * h, o = this.opts;
      // Update speeds are defined per 60 fps frame; scale them to the real frame time.
      const f = Math.min(4, Math.max(0.25, (dtMs || 16.7) / 16.7));
      const bgA = 1 - Math.pow(1 - o.bgAlpha, f), fgA = 1 - Math.pow(1 - o.fgAlpha, f);
      if (!this.ready) {
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          bg[i * 3] = rgba[j]; bg[i * 3 + 1] = rgba[j + 1]; bg[i * 3 + 2] = rgba[j + 2];
        }
        this.ready = true; this.frames = 1;
        return { blobs: [], changed: 0, skipped: true };
      }
      this.frames++;
      const T = o.sensitivity, T3 = T * 3;
      const colour = o.ballColour;
      let changed = 0;
      for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
        const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
        const br = bg[k], bgG = bg[k + 1], bb = bg[k + 2];
        const diff = Math.abs(r - br) + Math.abs(g - bgG) + Math.abs(b - bb);
        let m = 0;
        if (diff > T3) {
          changed++;
          const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
          const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
          if (!colour) {
            // White ball: bright, little colour, brighter than what is behind it.
            const y = (r * 77 + g * 150 + b * 29) >> 8;
            const by = (br * 77 + bgG * 150 + bb * 29) / 256;
            const sat = max ? (max - min) / max : 0;
            if (y > 95 && sat < 0.38 && y - by > T) m = 1;
          } else {
            const s = max ? (max - min) / max : 0;
            if (s > Math.max(0.2, colour.s * 0.5) && max > 50) {
              const hsv = rgbToHsv(r, g, b);
              let dh = Math.abs(hsv.h - colour.h); if (dh > 180) dh = 360 - dh;
              if (dh < 22) m = 1;
            }
          }
        }
        mask[i] = m;
        const a = m ? fgA : bgA;
        bg[k] = br + (r - br) * a; bg[k + 1] = bgG + (g - bgG) * a; bg[k + 2] = bb + (b - bb) * a;
      }
      const changedShare = changed / n;
      if (changedShare > o.globalChange) {
        // Camera moved or exposure jumped: re-learn the background quickly, no blobs.
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          const k = i * 3;
          bg[k] += (rgba[j] - bg[k]) * 0.5; bg[k + 1] += (rgba[j + 1] - bg[k + 1]) * 0.5; bg[k + 2] += (rgba[j + 2] - bg[k + 2]) * 0.5;
        }
        return { blobs: [], changed: changedShare, skipped: true };
      }
      return { blobs: this.findBlobs(), changed: changedShare, skipped: false };
    }

    findBlobs() {
      const { w, h, mask, labels, stack } = this;
      labels.fill(0);
      const blobs = [];
      let next = 1;
      for (let start = 0; start < w * h; start++) {
        if (!mask[start] || labels[start]) continue;
        let sp = 0; stack[sp++] = start; labels[start] = next;
        let area = 0, sx = 0, sy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
        while (sp) {
          const p = stack[--sp];
          const x = p % w, y = (p - x) / w;
          area++; sx += x; sy += y;
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= w) continue;
              const q = yy * w + xx;
              if (mask[q] && !labels[q]) { labels[q] = next; stack[sp++] = q; }
            }
          }
        }
        next++;
        if (area < this.minArea || area > this.maxArea) continue;
        const bw = maxx - minx + 1, bh = maxy - miny + 1;
        const fill = area / (bw * bh);
        const aspect = Math.max(bw, bh) / Math.min(bw, bh);
        if (fill < 0.22 || aspect > 8) continue;
        // Width across a streak should still be about one ball.
        if (Math.min(bw, bh) > this.ballR * 5) continue;
        blobs.push({ x: sx / area, y: sy / area, area, w: bw, h: bh });
      }
      return blobs;
    }
  }

  // ---------- Shot events: track the ball and decide goal / unsure / miss ----------

  const EV = {
    gapMs: 400,          // ball unseen this long -> event ends
    restMs: 350,         // ball still this long -> event ends
    maxMs: 4000,
    cooldownMs: 600,     // after a goal, ignore new events this long
    minShotSpeed: 0.8,   // goal widths per second: below this it was not a shot
    edgeMargin: 0.06,    // in goal units; closer to the outline = unsure
    zoneRows: 2,         // 3x2 or 3x3 grid
  };

  class ShotTracker {
    // mapping: goalMapping() in the same pixel coords as the blobs.
    constructor(mapping, opts) {
      this.map = mapping;
      this.o = Object.assign({}, EV, opts || {});
      this.ev = null;
      this.lastGoalT = -1e9;
      this.lastBall = null;
      this.absorbAt = null;
    }

    // blobs from Detector.process; t in ms. Returns a finished event or null.
    update(blobs, t) {
      const ev = this.ev, gw = this.map.widthPx;
      let pick = null;
      if (ev) {
        const last = ev.samples[ev.samples.length - 1];
        const prev = ev.samples.length > 1 ? ev.samples[ev.samples.length - 2] : null;
        let px = last.x, py = last.y, vx = 0, vy = 0;
        if (prev && last.t > prev.t) {
          vx = (last.x - prev.x) / (last.t - prev.t); vy = (last.y - prev.y) / (last.t - prev.t);
          px += vx * (t - last.t); py += vy * (t - last.t);
        }
        const gate = gw * 0.12 + Math.hypot(vx, vy) * (t - last.t) * 0.8 + gw * 0.002 * (t - last.t);
        let best = Infinity;
        for (const b of blobs) {
          const d = Math.hypot(b.x - px, b.y - py);
          if (d < gate && d < best) { best = d; pick = b; }
        }
      } else if (blobs.length) {
        if (t - this.lastGoalT < this.o.cooldownMs) { this.lastBall = null; return null; }
        // Start with the blob closest to its expected size.
        const r = gw * 0.0225, expected = Math.PI * r * r;
        let best = Infinity;
        for (const b of blobs) {
          const s = Math.abs(Math.log(b.area / expected + 1e-3));
          if (s < best) { best = s; pick = b; }
        }
      }

      if (pick) {
        const g = applyH(this.map.toGoal, pick.x, pick.y);
        const s = { t, x: pick.x, y: pick.y, u: g.x, v: g.y, area: pick.area };
        if (!this.ev) this.ev = { start: t, samples: [], stillSince: null, id: Math.random().toString(36).slice(2, 8) };
        const e = this.ev, last = e.samples[e.samples.length - 1];
        if (last && Math.hypot(s.x - last.x, s.y - last.y) < gw * 0.015) {
          if (e.stillSince === null) e.stillSince = last.t;
        } else e.stillSince = null;
        e.samples.push(s);
        this.lastBall = s;
      } else this.lastBall = null;

      const e = this.ev;
      if (!e) return null;
      const lastT = e.samples[e.samples.length - 1].t;
      const ended = (t - lastT > this.o.gapMs) ||
        (e.stillSince !== null && t - e.stillSince > this.o.restMs) ||
        (t - e.start > this.o.maxMs);
      if (!ended) return null;
      this.ev = null;
      const endS = e.samples[e.samples.length - 1];
      this.absorbAt = { x: endS.x, y: endS.y, r: gw * 0.06 };
      const result = classify(e, this.map, this.o);
      if (result.kind === 'goal' || result.kind === 'unsure') this.lastGoalT = t;
      return result.kind === 'noise' ? null : result;
    }

    // Close a running event (e.g. at Finish).
    flush(t) {
      if (!this.ev) return null;
      const e = this.ev; this.ev = null;
      const r = classify(e, this.map, this.o);
      return r.kind === 'noise' ? null : r;
    }
  }

  function classify(e, map, o) {
    const S = e.samples, n = S.length, gw = map.widthPx;
    const base = { id: e.id, t: S[0].t, samples: S };
    if (n < 3) return Object.assign(base, { kind: 'noise', reason: 'too short' });
    const speed = [0];
    for (let i = 1; i < n; i++) {
      const dt = Math.max(1, S[i].t - S[i - 1].t) / 1000;
      speed.push(Math.hypot(S[i].x - S[i - 1].x, S[i].y - S[i - 1].y) / gw / dt);
    }
    let maxI = 1;
    for (let i = 1; i < n; i++) if (speed[i] > speed[maxI]) maxI = i;
    const maxSpeed = speed[maxI];
    if (maxSpeed < o.minShotSpeed) return Object.assign(base, { kind: 'noise', reason: 'slow only', maxSpeed });

    // Impact: the sharpest turn/brake of the path after the fastest part
    // (where the net stops the ball). Without one, the last sample.
    let impactI = n - 1, bestTurn = 0;
    for (let i = Math.max(1, maxI); i < n - 1; i++) {
      const d0 = Math.max(1, S[i].t - S[i - 1].t), d1 = Math.max(1, S[i + 1].t - S[i].t);
      const ax = (S[i].x - S[i - 1].x) / d0, ay = (S[i].y - S[i - 1].y) / d0;
      const bx = (S[i + 1].x - S[i].x) / d1, by = (S[i + 1].y - S[i].y) / d1;
      const turn = Math.hypot(ax - bx, ay - by) * 1000 / gw;
      if (turn > bestTurn) { bestTurn = turn; impactI = i; }
    }
    if (bestTurn < maxSpeed * 0.5) impactI = n - 1;
    // Slowdown: average of the last two speeds versus the max.
    const endSpeed = n > 2 ? (speed[n - 1] + speed[n - 2]) / 2 : speed[n - 1];
    const slowed = endSpeed < maxSpeed * 0.4 || impactI < n - 1;
    const end = S[n - 1], imp = S[impactI];
    const m = o.edgeMargin;
    const inside = (p, mm) => p.u >= mm && p.u <= 1 - mm && p.v >= mm && p.v <= 1 + 0.02;
    const endIn = inside(end, m), endLoose = inside(end, -m);
    const impIn = inside(imp, m), impLoose = inside(imp, -m);
    const zonePt = impLoose ? imp : end;
    const zu = Math.min(1, Math.max(0, zonePt.u)), zv = Math.min(1, Math.max(0, zonePt.v));
    const zone = zoneOf(zu, zv, o.zoneRows);
    const info = { zonePoint: { u: zu, v: zv }, maxSpeed: +maxSpeed.toFixed(2), endSpeed: +endSpeed.toFixed(2), impactIndex: impactI, zone, end: { u: +end.u.toFixed(3), v: +end.v.toFixed(3) }, impact: { u: +imp.u.toFixed(3), v: +imp.v.toFixed(3) } };

    if (endIn && slowed && impLoose) return Object.assign(base, info, { kind: 'goal', reason: 'stopped inside the goal' });
    if (endLoose && (!slowed || !endIn)) return Object.assign(base, info, { kind: 'unsure', reason: endIn ? 'vanished inside while fast' : 'ended at the goal outline' });
    if (endIn && !impLoose) return Object.assign(base, info, { kind: 'unsure', reason: 'came in from outside the outline' });
    if (impIn && inside(end, -0.3)) return Object.assign(base, info, { kind: 'unsure', reason: 'hit inside, ended just outside' });
    return Object.assign(base, info, { kind: 'miss', reason: 'ended outside the goal' });
  }

  // ---------- Accuracy summary (result screen + tests) ----------

  // correct: detected goals confirmed true; wrong: detected goals marked false;
  // missedByCamera: real goals the camera did not count.
  function accuracy({ correct, wrong, missedByCamera, shots }) {
    const real = correct + missedByCamera;
    return {
      found: real ? correct / real : null,
      falseRate: shots ? wrong / shots : null,
      passFound: real ? correct / real >= 0.95 : null,
      passFalse: shots ? wrong / shots <= 0.02 : null,
    };
  }

  const api = { homography, applyH, goalMapping, isValidQuad, zoneOf, zoneLabels, rgbToHsv, Detector, ShotTracker, classify, accuracy, ZONE_COLS, ZONE_ROWS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShotCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
