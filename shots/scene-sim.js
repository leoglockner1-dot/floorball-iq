// Synthetic floorball goal scene with scripted shots and a known truth.
// Used by the in-page demo (demo source) and by the node tests.
// Includes the hard parts on purpose: white boards behind the goal, a light
// net, bright hall lights, sensor noise, motion blur, balls left in the net.
(function (root) {
  'use strict';
  const Core = (typeof module !== 'undefined' && module.exports) ? require('./tracker-core.js') : root.ShotCore;

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  // Fixed shot list: mix of goals in every zone, wide, high, post hits.
  function defaultShots(count, seed) {
    const r = rng(seed || 7), shots = [];
    const types = ['goal', 'goal', 'wide', 'goal', 'high', 'goal', 'post', 'goal', 'wide', 'goal'];
    for (let i = 0; i < count; i++) {
      const type = types[i % types.length];
      let u, v;
      if (type === 'goal') { u = 0.12 + r() * 0.76; v = 0.12 + r() * 0.76; }
      else if (type === 'wide') { u = r() < 0.5 ? -0.25 - r() * 0.2 : 1.25 + r() * 0.2; v = 0.3 + r() * 0.6; }
      else if (type === 'high') { u = 0.2 + r() * 0.6; v = -0.3 - r() * 0.2; }
      else { u = r() < 0.5 ? 0 : 1; v = 0.3 + r() * 0.5; }
      shots.push({ t0: 1500 + i * 2600, type, target: { u, v }, startX: 0.4 + r() * 0.2 });
    }
    return shots;
  }

  class Scene {
    constructor(W, H, opts) {
      opts = opts || {};
      this.W = W; this.H = H;
      this.corners = [
        { x: 0.31 * W, y: 0.27 * H }, { x: 0.69 * W, y: 0.26 * H },
        { x: 0.70 * W, y: 0.63 * H }, { x: 0.30 * W, y: 0.64 * H },
      ];
      this.map = Core.goalMapping(this.corners);
      this.r0 = this.map.widthPx * 0.0225; // 72 mm ball on a 160 cm goal
      this.shots = opts.shots || defaultShots(opts.count || 20, opts.seed);
      this.noise = opts.noise === undefined ? 6 : opts.noise;
      this.base = this.drawBackground();
      this.rand = rng(99);
    }

    truth() {
      return this.shots.filter(s => s.type === 'goal').map(s => ({ t: s.t0, u: s.target.u, v: s.target.v, zone: Core.zoneOf(s.target.u, s.target.v), zone3: Core.zoneOf(s.target.u, s.target.v, 3) }));
    }

    duration() { return this.shots.length ? this.shots[this.shots.length - 1].t0 + 3000 : 3000; }

    img(u, v) { return Core.applyH(this.map.toImage, u, v); }

    drawBackground() {
      const { W, H } = this, px = new Uint8ClampedArray(W * H * 4);
      const floorY = 0.66 * H;
      const set = (i, r, g, b) => { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (y > floorY) set(i, 38, 72, 112);                  // sports floor
        else if (y > floorY - 0.07 * H) set(i, 232, 234, 236); // white boards
        else set(i, 84, 86, 92);                               // hall wall
      }
      // Hall lights
      for (const lx of [0.15, 0.5, 0.85]) this.fillRect(px, lx * W - 0.05 * W, 0.03 * H, 0.1 * W, 0.025 * H, 255, 255, 250);
      // Net: light grid inside the goal
      const g = this.map;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = Core.applyH(g.toGoal, x, y);
        if (p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1) {
          const i = (y * W + x) * 4;
          if (x % 6 === 0 || y % 6 === 0) set(i, 205, 205, 210);
          else set(i, px[i] * 0.8, px[i + 1] * 0.8, px[i + 2] * 0.8);
        }
      }
      // Red goal frame
      const c = this.corners, t = Math.max(2, Math.round(W * 0.007));
      this.line(px, c[3], c[0], t, 200, 30, 40); this.line(px, c[0], c[1], t, 200, 30, 40); this.line(px, c[1], c[2], t, 200, 30, 40);
      return px;
    }

    fillRect(px, x0, y0, w, h, r, g, b) {
      for (let y = Math.max(0, y0 | 0); y < Math.min(this.H, y0 + h); y++)
        for (let x = Math.max(0, x0 | 0); x < Math.min(this.W, x0 + w); x++) {
          const i = (y * this.W + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b;
        }
    }

    line(px, a, b, t, r, g, bl) {
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
      for (let k = 0; k <= n; k++) {
        const x = a.x + (b.x - a.x) * k / n, y = a.y + (b.y - a.y) * k / n;
        this.fillRect(px, x - t / 2, y - t / 2, t, t, r, g, bl);
      }
    }

    // Ball position (centre, radius) for one shot at time t, or null.
    ballOf(s, t) {
      const dt = t - s.t0, flight = 180;
      if (dt < 0) return null;
      const S = { x: s.startX * this.W, y: 0.99 * this.H, r: this.r0 * 2.2 };
      const I = this.img(s.target.u, s.target.v);
      if (dt <= flight) {
        const k = dt / flight;
        return { x: S.x + (I.x - S.x) * k, y: S.y + (I.y - S.y) * k, r: S.r + (this.r0 - S.r) * k };
      }
      const vx = (I.x - S.x) / flight, vy = (I.y - S.y) / flight, a = dt - flight;
      if (s.type === 'goal') {
        const D = this.img(s.target.u, 0.97), k = Math.min(1, a / 450), e = 1 - (1 - k) * (1 - k);
        return { x: I.x + (D.x - I.x) * e, y: I.y + (D.y - I.y) * e, r: this.r0 * 0.95 };
      }
      if (s.type === 'post') {
        if (a > 500) return null;
        return { x: I.x - vx * 0.35 * a, y: I.y - vy * 0.35 * a + a * a * 0.0004, r: this.r0 * (1 + a / 500) };
      }
      if (a > 300) return null; // flew past, gone behind the boards / out of view
      return { x: I.x + vx * 0.7 * a, y: I.y + vy * 0.7 * a, r: this.r0 * 0.95 };
    }

    // RGBA frame at time t (ms). exposureMs gives motion blur.
    render(t, out, exposureMs) {
      const { W, H } = this, px = out || new Uint8ClampedArray(W * H * 4);
      px.set(this.base);
      const exp = exposureMs === undefined ? 8 : exposureMs, steps = 6;
      for (const s of this.shots) {
        if (t < s.t0) continue;
        const subs = [];
        for (let k = 0; k < steps; k++) { const b = this.ballOf(s, t - exp * k / steps); if (b) subs.push(b); }
        if (!subs.length) continue;
        let x0 = W, x1 = 0, y0 = H, y1 = 0;
        for (const b of subs) { x0 = Math.min(x0, b.x - b.r - 1); x1 = Math.max(x1, b.x + b.r + 1); y0 = Math.min(y0, b.y - b.r - 1); y1 = Math.max(y1, b.y + b.r + 1); }
        for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1); x++) {
          let cov = 0;
          for (const b of subs) if ((x - b.x) ** 2 + (y - b.y) ** 2 <= b.r * b.r) cov += 1 / steps;
          if (!cov) continue;
          const i = (y * W + x) * 4, shade = 245;
          px[i] += (shade - px[i]) * cov; px[i + 1] += (shade - px[i + 1]) * cov; px[i + 2] += (shade - px[i + 2]) * cov;
        }
      }
      if (this.noise) {
        const r = this.rand, nz = this.noise;
        for (let i = 0; i < px.length; i += 4) {
          const d = (r() - 0.5) * 2 * nz;
          px[i] += d; px[i + 1] += d; px[i + 2] += d;
        }
      }
      return px;
    }
  }

  const api = { Scene, defaultShots };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SceneSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
