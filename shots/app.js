// FLOORBALL IQ – Shot Tracker page: sources (camera / file / demo), corner
// marking, live loop, confirmations, result + accuracy check.
(function () {
  'use strict';
  const Core = window.ShotCore;
  const $ = (id) => document.getElementById(id);
  const PROC_WIDTH = 400;      // analysed width of the goal area in pixels
  const RING = 24;             // stored frames for still images of unsure shots

  // ---------- small helpers ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('fst.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('fst.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  let audio = null;
  function beep(freq, ms, vol) {
    try {
      if (!audio) return;
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(vol || 0.25, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
      o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + ms / 1000);
    } catch (e) { /* no sound */ }
  }
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.mode === 'live' && !S.paused) keepAwake(true); });

  function show(screen) {
    $('screen-start').hidden = screen !== 'start';
    $('screen-result').hidden = screen !== 'result';
    $('stage').hidden = !(screen === 'calib' || screen === 'live');
    for (const id of ['calib-top', 'calib-bottom']) $(id).hidden = screen !== 'calib';
    for (const id of ['live-top', 'live-bottom']) $(id).hidden = screen !== 'live';
    if (screen !== 'live') { $('confirm').hidden = true; $('debug').hidden = true; }
    S.mode = screen;
    if (screen === 'calib' || screen === 'live') requestAnimationFrame(resizeOverlay);
    window.scrollTo(0, 0);
  }

  // ---------- state ----------
  const S = {
    mode: 'start', source: null, stream: null, demo: null,
    shots: store.get('shots', 20), colourMode: store.get('colourMode', 'white'), ballColour: null,
    sensitivity: store.get('sensitivity', 20), zoneRows: store.get('zoneRows', 2) === 3 ? 3 : 2,
    corners: [], drag: -1, awaitingBall: false,
    roi: null, det: null, trk: null, map: null, proc: null, pctx: null,
    ring: [], ringI: 0,
    events: [], pending: [], paused: false, debug: false,
    lastT: null, fpsCount: 0, fpsT: 0, fps: 0, movedFrames: 0,
    startedAt: null, trail: [], lastGoalFlash: 0, framesSeen: 0, shotsSeen: 0, procMs: 0,
  };

  // ---------- start screen ----------
  const shotsInput = $('shots');
  shotsInput.value = S.shots;
  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    shotsInput.value = Math.max(1, Math.min(500, (+shotsInput.value || 0) + +b.dataset.step));
  }));
  function setColourMode(m) {
    S.colourMode = m; store.set('colourMode', m);
    $('col-white').setAttribute('aria-pressed', m === 'white');
    $('col-other').setAttribute('aria-pressed', m === 'other');
    $('col-hint').textContent = m === 'white'
      ? 'White ball: works best against a darker background.'
      : 'Coloured ball: after the corners you tap the ball once so the page learns its colour.';
  }
  function setZoneRows(r) {
    S.zoneRows = r; store.set('zoneRows', r);
    for (const p of ['grid-', 'rgrid-']) { $(p + '2').setAttribute('aria-pressed', r === 2); $(p + '3').setAttribute('aria-pressed', r === 3); }
    $('grid-hint').textContent = r === 2
      ? 'Top / bottom × left / centre / right. The safer choice for a camera estimate.'
      : 'Adds a middle row. Finer, so shots close to a line land in the next zone more often.';
    if (S.mode === 'live') updateLive();
    if (S.mode === 'result') renderResult();
  }
  for (const p of ['grid-', 'rgrid-']) { $(p + '2').addEventListener('click', () => setZoneRows(2)); $(p + '3').addEventListener('click', () => setZoneRows(3)); }
  $('col-white').addEventListener('click', () => setColourMode('white'));
  $('col-other').addEventListener('click', () => setColourMode('other'));
  setColourMode(S.colourMode);
  setZoneRows(S.zoneRows);

  function readShots() {
    S.shots = Math.max(1, Math.min(500, Math.round(+shotsInput.value) || 20));
    shotsInput.value = S.shots; store.set('shots', S.shots);
  }
  function startError(msg) { const e = $('start-error'); e.textContent = msg; e.hidden = !msg; }
  function unlockAudio() {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) { audio = null; }
  }

  const video = $('video');

  $('btn-camera').addEventListener('click', async () => {
    readShots(); unlockAudio(); startError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      startError(location.protocol === 'https:' || location.hostname === 'localhost'
        ? 'This browser cannot use the camera. Use Safari on the iPhone.'
        : 'The camera needs a secure (https://) page. Open the page from its https link.');
      return;
    }
    const want = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };
    try {
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false }); }
      catch (e) { if (e.name === 'NotAllowedError') throw e; stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
      stopSource();
      S.stream = stream; S.source = 'camera';
      video.srcObject = stream; video.muted = true;
      await video.play();
      enterCalib();
    } catch (e) {
      startError(e.name === 'NotAllowedError'
        ? 'Camera access was blocked. In Safari: aA menu → Website Settings → Camera → Allow, then try again.'
        : 'Could not start the camera (' + e.name + ').');
    }
  });

  $('btn-file').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    readShots(); unlockAudio(); startError('');
    stopSource();
    S.source = 'file';
    video.srcObject = null; video.src = URL.createObjectURL(f); video.muted = true; video.loop = false;
    try {
      await new Promise((ok, bad) => { video.onloadedmetadata = ok; video.onerror = () => bad(new Error('unreadable')); });
      video.currentTime = Math.min(0.5, (video.duration || 1) / 4);
      video.pause();
      enterCalib();
    } catch (e) { startError('This video file could not be opened.'); }
    ev.target.value = '';
  });

  $('btn-demo').addEventListener('click', async () => {
    readShots(); unlockAudio(); startError('');
    stopSource();
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    if (!c.captureStream) { startError('This browser cannot run the demo scene.'); return; }
    const scene = new window.SceneSim.Scene(640, 360, { count: S.shots });
    const ctx = c.getContext('2d'), img = ctx.createImageData(640, 360);
    const demo = { scene, t0: null, running: true, ctx, img, canvas: c, paintedT: 0 };
    S.demo = demo; S.source = 'demo';
    // The demo clock only runs while tracking, so shots start after "Start tracking".
    const paint = () => {
      if (!demo.running) return;
      const t = demo.t0 === null ? 0 : performance.now() - demo.t0;
      demo.scene.render(t, img.data, 8); ctx.putImageData(img, 0, 0); demo.paintedT = t;
      requestAnimationFrame(paint);
    };
    paint();
    S.stream = c.captureStream(60);
    video.srcObject = S.stream; video.muted = true;
    await video.play().catch(() => {});
    enterCalib();
    S.corners = scene.corners.map(p => ({ x: p.x, y: p.y }));
    updateCalibUI();
  });

  function stopSource() {
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    if (S.demo) S.demo.running = false;
    S.stream = null; S.demo = null;
    if (video.src && video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
    video.removeAttribute('src'); video.srcObject = null;
  }

  // ---------- overlay geometry ----------
  const overlay = $('overlay'), octx = overlay.getContext('2d');
  let view = { s: 1, ox: 0, oy: 0 };
  function resizeOverlay() {
    const r = overlay.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const s = Math.min(r.width / vw, r.height / vh);
    view = { s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2, w: r.width, h: r.height };
  }
  window.addEventListener('resize', () => setTimeout(resizeOverlay, 50));
  video.addEventListener('loadedmetadata', resizeOverlay);
  video.addEventListener('resize', resizeOverlay);
  const toScreen = (p) => ({ x: view.ox + p.x * view.s, y: view.oy + p.y * view.s });
  const toVideo = (x, y) => ({ x: (x - view.ox) / view.s, y: (y - view.oy) / view.s });

  // ---------- calibrate ----------
  const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
  function enterCalib() {
    show('calib');
    S.awaitingBall = false;
    if (S.source !== 'demo') S.corners = [];
    const last = store.get('corners', null);
    $('calib-last').hidden = !(last && S.source !== 'demo');
    updateCalibUI();
    drawLoop();
    calibFps();
  }
  function updateCalibUI() {
    const n = S.corners.length, valid = n === 4 && Core.isValidQuad(S.corners);
    const needBall = S.colourMode === 'other' && !S.ballColour;
    if (n < 4) {
      $('calib-title').textContent = 'Tap the ' + CORNER_NAMES[n] + ' corner';
      $('calib-sub').textContent = 'Inner corner of the goal opening. Step ' + (n + 1) + ' of 4. Drag a dot to adjust.';
    } else if (!valid) {
      $('calib-title').textContent = 'Corners look crossed';
      $('calib-sub').textContent = 'Order: top-left, top-right, bottom-right, bottom-left. Drag the dots or Undo.';
    } else if (S.awaitingBall || needBall) {
      S.awaitingBall = true;
      $('calib-title').textContent = 'Now tap the ball';
      $('calib-sub').textContent = 'Hold or place the ball in view and tap on it so the page learns its colour.';
    } else {
      $('calib-title').textContent = 'Goal marked';
      $('calib-sub').textContent = S.source === 'demo' ? 'Demo corners are set. Start tracking to watch 1 shot every 2.6 s.' : 'Check the outline sits on the inner edge of the posts and bar. Drag to adjust.';
    }
    $('calib-start').disabled = !(valid && !S.awaitingBall && !needBall);
    $('calib-undo').disabled = n === 0;
    $('calib-ball').hidden = S.colourMode !== 'other' || !S.ballColour;
  }
  function pointerPos(ev) { const r = overlay.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
  overlay.addEventListener('pointerdown', (ev) => {
    if (S.mode !== 'calib') return;
    ev.preventDefault();
    const p = pointerPos(ev), v = toVideo(p.x, p.y);
    if (v.x < 0 || v.y < 0 || v.x > video.videoWidth || v.y > video.videoHeight) return;
    if (S.awaitingBall) { sampleBall(v); return; }
    let best = -1, bd = 34;
    S.corners.forEach((c, i) => { const s = toScreen(c), d = Math.hypot(s.x - p.x, s.y - p.y); if (d < bd) { bd = d; best = i; } });
    if (best >= 0) { S.drag = best; overlay.setPointerCapture(ev.pointerId); return; }
    if (S.corners.length < 4) { S.corners.push(v); S.drag = S.corners.length - 1; overlay.setPointerCapture(ev.pointerId); updateCalibUI(); }
  });
  overlay.addEventListener('pointermove', (ev) => {
    if (S.mode !== 'calib' || S.drag < 0) return;
    const p = pointerPos(ev), v = toVideo(p.x, p.y);
    S.corners[S.drag] = { x: Math.max(0, Math.min(video.videoWidth, v.x)), y: Math.max(0, Math.min(video.videoHeight, v.y)) };
  });
  const endDrag = () => { if (S.drag >= 0) { S.drag = -1; updateCalibUI(); } };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  function sampleBall(v) {
    const c = document.createElement('canvas'); c.width = 9; c.height = 9;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(video, v.x - 4, v.y - 4, 9, 9, 0, 0, 9, 9);
    const d = x.getImageData(0, 0, 9, 9).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4, hsv = Core.rgbToHsv(r / n, g / n, b / n);
    if (hsv.s < 0.2) {
      $('calib-title').textContent = 'That looks white or grey';
      $('calib-sub').textContent = 'Tap right on the ball, or go Back and choose "White".';
      return;
    }
    S.ballColour = hsv; S.ballRGB = [r / n, g / n, b / n].map(Math.round); S.awaitingBall = false;
    updateCalibUI();
  }
  $('calib-ball').addEventListener('click', () => { S.ballColour = null; S.awaitingBall = true; updateCalibUI(); });
  $('calib-undo').addEventListener('click', () => { S.corners.pop(); S.awaitingBall = false; updateCalibUI(); });
  $('calib-last').addEventListener('click', () => {
    const last = store.get('corners', null);
    if (!last) return;
    S.corners = last.map(p => ({ x: p.x * video.videoWidth, y: p.y * video.videoHeight }));
    updateCalibUI();
  });
  $('calib-back').addEventListener('click', () => { stopSource(); show('start'); });
  $('calib-start').addEventListener('click', () => {
    store.set('corners', S.corners.map(p => ({ x: p.x / video.videoWidth, y: p.y / video.videoHeight })));
    // After "Re-mark corners" the same round goes on with its counts.
    const keep = S.resumeRound; S.resumeRound = false;
    startTracking(!keep);
  });

  // ---------- tracking ----------
  function setupProcessing() {
    const c = S.corners, vw = video.videoWidth, vh = video.videoHeight;
    const vmap = Core.goalMapping(c);
    const xs = c.map(p => p.x), ys = c.map(p => p.y);
    const gw = vmap.widthPx, gh = vmap.heightPx;
    const x0 = Math.max(0, Math.min(...xs) - 0.55 * gw), x1 = Math.min(vw, Math.max(...xs) + 0.55 * gw);
    const y0 = Math.max(0, Math.min(...ys) - 0.45 * gh), y1 = Math.min(vh, Math.max(...ys) + 0.7 * gh);
    const scale = Math.min(1, PROC_WIDTH / (x1 - x0));
    const pw = Math.max(16, Math.round((x1 - x0) * scale)), ph = Math.max(16, Math.round((y1 - y0) * scale));
    S.roi = { x0, y0, w: x1 - x0, h: y1 - y0, scale, pw, ph };
    S.vmap = vmap;
    const pc = c.map(p => ({ x: (p.x - x0) * scale, y: (p.y - y0) * scale }));
    S.map = Core.goalMapping(pc);
    S.proc = document.createElement('canvas'); S.proc.width = pw; S.proc.height = ph;
    S.pctx = S.proc.getContext('2d', { willReadFrequently: true });
    S.det = new Core.Detector(pw, ph, S.map.widthPx * 0.0225, { sensitivity: S.sensitivity, ballColour: S.colourMode === 'other' ? S.ballColour : null });
    S.trk = new Core.ShotTracker(S.map, {});
    S.ring = []; for (let i = 0; i < RING; i++) S.ring.push({ t: -1, buf: new Uint8ClampedArray(pw * ph * 4) });
    S.ringI = 0;
  }

  function startTracking(newRound) {
    setupProcessing();
    if (newRound) { S.events = []; S.pending = []; S.shotsSeen = 0; S.framesSeen = 0; S.startedAt = new Date(); S.tBase = S.source === 'camera' ? performance.now() : 0; }
    S.paused = false; S.lastT = null; S.trail = []; S.movedFrames = 0;
    show('live');
    $('live-pause').textContent = 'Pause';
    $('live-recal').hidden = true;
    updateLive();
    keepAwake(true);
    if (S.source === 'file') { video.currentTime = 0; video.playbackRate = 1; video.play(); }
    if (S.source === 'demo' && S.demo) S.demo.t0 = performance.now();
    if (S.source === 'demo') S.demoTruth = S.demo.scene.truth().length;
    frameLoop();
  }

  let loopToken = 0;
  function frameLoop() {
    const token = ++loopToken;
    const useRVFC = S.source !== 'demo' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    let lastMedia = -1;
    const step = (now, meta) => {
      if (token !== loopToken || S.mode !== 'live') return;
      if (!S.paused && (video.readyState >= 2 || S.source === 'demo')) {
        let t;
        if (S.source === 'file') t = (meta && meta.mediaTime !== undefined ? meta.mediaTime : video.currentTime) * 1000;
        else if (S.source === 'demo' && S.demo) t = S.demo.paintedT;
        // Camera: the frame's capture time if the browser gives it (less jitter than "now").
        else t = (meta && (meta.captureTime || meta.presentationTime)) || performance.now();
        if (t !== lastMedia) { lastMedia = t; processFrame(t); }
      }
      if (useRVFC) video.requestVideoFrameCallback(step); else requestAnimationFrame(step);
    };
    if (useRVFC) video.requestVideoFrameCallback(step); else requestAnimationFrame(step);
  }

  function processFrame(t) {
    const r = S.roi, t0 = performance.now();
    // The demo is analysed straight from its canvas so frame and time match exactly.
    const src = S.source === 'demo' && S.demo ? S.demo.canvas : video;
    S.pctx.drawImage(src, r.x0, r.y0, r.w, r.h, 0, 0, r.pw, r.ph);
    const frame = S.pctx.getImageData(0, 0, r.pw, r.ph).data;
    const dt = S.lastT === null ? 16.7 : Math.max(1, t - S.lastT);
    S.lastT = t;
    const res = S.det.process(frame, dt);
    S.lastRes = res; S.lastFrame = frame;
    S.movedFrames = res.skipped && res.changed > 0 ? S.movedFrames + 1 : Math.max(0, S.movedFrames - 1);
    S.trk.absorbAt = null;
    const ev = S.trk.update(res.skipped ? [] : res.blobs, t);
    if (S.trk.absorbAt) S.det.absorb(frame, S.trk.absorbAt.x, S.trk.absorbAt.y, S.trk.absorbAt.r);
    if (S.trk.lastBall) {
      const slot = S.ring[S.ringI]; slot.t = t; slot.buf.set(frame); S.ringI = (S.ringI + 1) % RING;
      S.trail.push({ x: S.trk.lastBall.x, y: S.trk.lastBall.y, at: performance.now() });
    }
    if (S.trail.length > 40) S.trail.splice(0, S.trail.length - 40);
    if (ev) onEvent(ev);
    S.framesSeen++;
    // fps + processing time
    S.fpsCount++;
    const now = performance.now();
    S.procMs = S.procMs * 0.9 + (now - t0) * 0.1;
    if (now - S.fpsT > 1000) { S.fps = Math.round(S.fpsCount * 1000 / (now - S.fpsT)); S.fpsCount = 0; S.fpsT = now; updateStatus(); }
  }

  function stillFor(ev) {
    // Still image of the impact frame (or the closest stored frame), with the ball path drawn on it.
    const imp = ev.samples[ev.impactIndex !== undefined ? ev.impactIndex : ev.samples.length - 1];
    let best = null, bd = Infinity;
    for (const s of S.ring) if (s.t >= 0) { const d = Math.abs(s.t - imp.t); if (d < bd) { bd = d; best = s; } }
    const { pw, ph } = S.roi;
    const c = document.createElement('canvas'); c.width = pw; c.height = ph;
    const x = c.getContext('2d');
    if (best) x.putImageData(new ImageData(new Uint8ClampedArray(best.buf), pw, ph), 0, 0);
    x.lineWidth = 1.5; x.strokeStyle = 'rgba(229,50,45,.9)';
    x.beginPath(); S.map && quadPath(x, S.map.toImage, (p) => p); x.stroke();
    x.strokeStyle = '#D4FF3A'; x.beginPath();
    ev.samples.forEach((s, i) => i ? x.lineTo(s.x, s.y) : x.moveTo(s.x, s.y)); x.stroke();
    x.beginPath(); x.arc(imp.x, imp.y, Math.max(5, S.map.widthPx * 0.04), 0, Math.PI * 2); x.stroke();
    const out = document.createElement('canvas'); out.width = 240; out.height = Math.round(240 * ph / pw);
    out.getContext('2d').drawImage(c, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.75);
  }

  function onEvent(ev) {
    if (ev.kind === 'miss') { S.shotsSeen++; return; }
    S.shotsSeen++;
    const item = { id: ev.id, t: ev.t, kind: ev.kind === 'goal' ? 'auto' : 'pending', zonePoint: ev.zonePoint, reason: ev.reason, wrong: false, thumb: stillFor(ev), maxSpeed: ev.maxSpeed };
    S.events.push(item);
    if (item.kind === 'auto') { goalFeedback(); }
    else { S.pending.push(item); beep(520, 140, 0.18); showConfirm(); }
    updateLive();
  }

  function goalFeedback() {
    beep(880, 160, 0.3);
    const c = $('counter'); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
    S.lastGoalFlash = performance.now();
  }

  function showConfirm() {
    const item = S.pending[0];
    const box = $('confirm');
    if (!item) { box.hidden = true; return; }
    box.hidden = false;
    $('confirm-img').src = item.thumb;
    $('confirm-q').textContent = 'Goal? ' + zoneOfEvent(item).label;
    $('confirm-why').textContent = 'Unsure: ' + item.reason + (S.pending.length > 1 ? ' · ' + (S.pending.length - 1) + ' more waiting' : '');
  }
  function answer(yes) {
    const item = S.pending.shift();
    if (!item) return;
    item.kind = yes ? 'confirmed' : 'rejected';
    if (yes) goalFeedback();
    showConfirm(); updateLive();
  }
  $('confirm-yes').addEventListener('click', () => answer(true));
  $('confirm-no').addEventListener('click', () => answer(false));

  // ---------- counting ----------
  const isCamGoal = (e) => (e.kind === 'auto' || e.kind === 'confirmed') && !e.wrong;
  function goalCount() { return S.events.filter(e => isCamGoal(e) || e.kind === 'manual').length; }
  // Zones are computed from the stored impact point, so the grid can change after the round.
  function zoneOfEvent(e) { return e.zonePoint ? Core.zoneOf(e.zonePoint.u, e.zonePoint.v, S.zoneRows) : null; }
  function zoneCounts() {
    const z = new Array(S.zoneRows * 3).fill(0);
    for (const e of S.events) { const zn = isCamGoal(e) && zoneOfEvent(e); if (zn) z[zn.index]++; }
    return z;
  }

  function updateLive() {
    const g = goalCount();
    $('live-goals').textContent = g;
    $('live-of').textContent = 'goals · ' + S.shots + ' shots';
    $('live-zones').innerHTML = zoneCounts().map(n => '<div>' + n + '</div>').join('');
    $('live-minus').disabled = !S.events.some(e => isCamGoal(e) || e.kind === 'manual');
  }
  function updateStatus() {
    const fpsTxt = (S.fps || '—') + ' fps';
    $('calib-fps').textContent = fpsTxt;
    $('live-fps').textContent = fpsTxt;
    const st = $('live-state');
    if (S.paused) { st.textContent = 'Paused'; st.className = 'pill'; }
    else if (S.movedFrames > 20) { st.textContent = 'Camera moved?'; st.className = 'pill bad'; $('live-recal').hidden = false; }
    else if (S.fps && S.fps < 24 && S.source === 'camera') { st.textContent = 'Low frame rate'; st.className = 'pill bad'; }
    else { st.textContent = 'Tracking'; st.className = 'pill ok'; }
    if (S.debug) {
      const r = S.roi;
      $('debug-info').textContent = [
        'video ' + video.videoWidth + '×' + video.videoHeight + ' · analysed ' + (r ? r.pw + '×' + r.ph : '-'),
        'processing ' + S.procMs.toFixed(1) + ' ms/frame',
        'ball size ' + (S.det ? (S.det.ballR * 2).toFixed(1) : '-') + ' px · blobs ' + (S.lastRes ? S.lastRes.blobs.length : 0),
        'changed ' + (S.lastRes ? (S.lastRes.changed * 100).toFixed(1) : 0) + ' % · shots seen ' + S.shotsSeen,
        S.trk && S.trk.ev ? 'tracking ' + S.trk.ev.samples.length + ' samples' : 'waiting for ball',
      ].join('\n');
    }
  }
  // Camera frame rate during corner marking.
  let calibToken = 0;
  function calibFps() {
    const token = ++calibToken;
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
    let n = 0, t0 = performance.now();
    const step = () => {
      if (token !== calibToken || S.mode !== 'calib') return;
      n++;
      const now = performance.now();
      if (now - t0 > 1000) { S.fps = Math.round(n * 1000 / (now - t0)); n = 0; t0 = now; updateStatus(); }
      video.requestVideoFrameCallback(step);
    };
    video.requestVideoFrameCallback(step);
  }

  $('live-plus').addEventListener('click', () => {
    S.events.push({ id: 'm' + Date.now(), t: S.lastT || 0, kind: 'manual', zonePoint: null, reason: 'added by hand', wrong: false });
    goalFeedback(); updateLive();
  });
  $('live-minus').addEventListener('click', () => {
    for (let i = S.events.length - 1; i >= 0; i--) {
      const e = S.events[i];
      if (e.kind === 'manual') { S.events.splice(i, 1); break; }
      if (isCamGoal(e)) { e.wrong = true; break; }
    }
    updateLive();
  });
  $('live-pause').addEventListener('click', () => {
    S.paused = !S.paused;
    $('live-pause').textContent = S.paused ? 'Resume' : 'Pause';
    if (S.source === 'file') S.paused ? video.pause() : video.play();
    if (!S.paused) { S.det.reset(); S.lastT = null; keepAwake(true); }
    updateStatus();
  });
  $('live-debug').addEventListener('click', () => {
    S.debug = !S.debug; $('debug').hidden = !S.debug; $('live-debug').setAttribute('aria-pressed', S.debug); updateStatus();
  });
  const sens = $('sens'); sens.value = S.sensitivity; $('sens-val').textContent = S.sensitivity;
  sens.addEventListener('input', () => {
    S.sensitivity = +sens.value; $('sens-val').textContent = S.sensitivity; store.set('sensitivity', S.sensitivity);
    if (S.det) S.det.opts.sensitivity = S.sensitivity;
  });
  $('live-recal').addEventListener('click', () => { loopToken++; enterCalibKeep(); });
  function enterCalibKeep() {
    // Keep counts, re-mark corners, then continue the same round.
    S.resumeRound = true;
    show('calib'); S.awaitingBall = false; updateCalibUI(); drawLoop(); calibFps();
  }
  $('live-finish').addEventListener('click', finish);
  video.addEventListener('ended', () => { if (S.mode === 'live' && S.source === 'file') finish(); });


  // ---------- drawing ----------
  function quadPath(x, H, map) {
    const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => map(Core.applyH(H, u, v)));
    pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.closePath();
  }
  let drawing = false;
  function drawLoop() {
    if (drawing) return; drawing = true;
    const frame = () => {
      if (S.mode !== 'calib' && S.mode !== 'live') { drawing = false; return; }
      draw(); requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  function draw() {
    const x = octx, W = view.w || 0, H = view.h || 0;
    x.clearRect(0, 0, W, H);
    if (S.mode === 'calib') {
      const c = S.corners;
      if (c.length === 4 && Core.isValidQuad(c)) drawGoal(Core.goalMapping(c), 0.9);
      else if (c.length > 1) {
        x.strokeStyle = 'rgba(229,50,45,.9)'; x.lineWidth = 2; x.beginPath();
        c.forEach((p, i) => { const s = toScreen(p); i ? x.lineTo(s.x, s.y) : x.moveTo(s.x, s.y); }); x.stroke();
      }
      c.forEach((p, i) => {
        const s = toScreen(p);
        x.beginPath(); x.arc(s.x, s.y, 14, 0, Math.PI * 2); x.fillStyle = 'rgba(212,255,58,.25)'; x.fill();
        x.lineWidth = 2; x.strokeStyle = '#D4FF3A'; x.stroke();
        x.beginPath(); x.moveTo(s.x - 6, s.y); x.lineTo(s.x + 6, s.y); x.moveTo(s.x, s.y - 6); x.lineTo(s.x, s.y + 6); x.stroke();
        x.fillStyle = '#F2F4F7'; x.font = '800 15px "Barlow Condensed", sans-serif'; x.fillText(String(i + 1), s.x + 16, s.y - 10);
      });
      return;
    }
    if (!S.vmap) return;
    drawGoal(S.vmap, 0.55);
    const r = S.roi;
    const pToScreen = (p) => toScreen({ x: r.x0 + p.x / r.scale, y: r.y0 + p.y / r.scale });
    if (S.debug && S.det && S.lastRes) drawMask(r);
    if (S.debug) {
      const tl = toScreen({ x: r.x0, y: r.y0 }), br = toScreen({ x: r.x0 + r.w, y: r.y0 + r.h });
      x.strokeStyle = 'rgba(154,163,174,.6)'; x.setLineDash([4, 4]); x.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y); x.setLineDash([]);
      if (S.lastRes) for (const b of S.lastRes.blobs) { const s = pToScreen(b); x.strokeStyle = 'rgba(247,201,21,.9)'; x.lineWidth = 1; x.beginPath(); x.arc(s.x, s.y, 8, 0, Math.PI * 2); x.stroke(); }
    }
    const now = performance.now();
    const trail = S.trail.filter(p => now - p.at < 700);
    if (trail.length) {
      x.lineWidth = 3; x.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) {
        const a = pToScreen(trail[i - 1]), b = pToScreen(trail[i]);
        x.strokeStyle = 'rgba(212,255,58,' + (1 - (now - trail[i].at) / 700).toFixed(2) + ')';
        x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke();
      }
      const last = pToScreen(trail[trail.length - 1]);
      x.beginPath(); x.arc(last.x, last.y, 9, 0, Math.PI * 2); x.strokeStyle = '#D4FF3A'; x.lineWidth = 2; x.stroke();
    }
    if (now - S.lastGoalFlash < 600) {
      x.fillStyle = 'rgba(212,255,58,' + (0.3 * (1 - (now - S.lastGoalFlash) / 600)).toFixed(2) + ')';
      x.beginPath(); quadPath(x, S.vmap.toImage, toScreen); x.fill();
    }
  }
  function drawGoal(m, alpha) {
    const x = octx;
    x.lineWidth = 2.5; x.strokeStyle = 'rgba(229,50,45,' + alpha + ')';
    x.beginPath(); quadPath(x, m.toImage, toScreen); x.stroke();
    x.lineWidth = 1; x.strokeStyle = 'rgba(242,244,247,' + alpha * 0.45 + ')';
    x.beginPath();
    for (const u of [1 / 3, 2 / 3]) { const a = toScreen(Core.applyH(m.toImage, u, 0)), b = toScreen(Core.applyH(m.toImage, u, 1)); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); }
    for (let k = 1; k < S.zoneRows; k++) { const v = k / S.zoneRows, a = toScreen(Core.applyH(m.toImage, 0, v)), b = toScreen(Core.applyH(m.toImage, 1, v)); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); }
    x.stroke();
  }
  let maskCanvas = null, maskImg = null;
  function drawMask(r) {
    if (!maskCanvas || maskCanvas.width !== r.pw || maskCanvas.height !== r.ph) {
      maskCanvas = document.createElement('canvas'); maskCanvas.width = r.pw; maskCanvas.height = r.ph;
      maskImg = maskCanvas.getContext('2d').createImageData(r.pw, r.ph);
    }
    const m = S.det.mask, d = maskImg.data;
    for (let i = 0, j = 0; i < m.length; i++, j += 4) { d[j] = 255; d[j + 1] = 40; d[j + 2] = 200; d[j + 3] = m[i] ? 230 : 0; }
    maskCanvas.getContext('2d').putImageData(maskImg, 0, 0);
    const tl = toScreen({ x: r.x0, y: r.y0 });
    octx.drawImage(maskCanvas, tl.x, tl.y, r.w * view.s, r.h * view.s);
  }

  // ---------- result ----------
  function finish() {
    if (S.trk) { const ev = S.trk.flush(S.lastT || 0); if (ev) onEvent(ev); }
    loopToken++;
    keepAwake(false);
    if (S.source === 'file') video.pause();
    if (S.demo) S.demo.t0 = null;
    // Unanswered "unsure" shots stay open on the result screen.
    $('missed').value = S.events.filter(e => e.kind === 'manual').length;
    show('result');
    renderResult();
  }

  function renderResult() {
    const missedByCam = Math.max(0, Math.round(+$('missed').value) || 0);
    const camGoals = S.events.filter(isCamGoal).length;
    const wrong = S.events.filter(e => (e.kind === 'auto' || e.kind === 'confirmed') && e.wrong).length;
    const goals = camGoals + missedByCam;
    const misses = Math.max(0, S.shots - goals);
    $('res-goals').textContent = goals;
    $('res-misses').textContent = misses;
    $('res-rate').textContent = S.shots ? Math.round(goals / S.shots * 100) + '%' : '–';
    const open = S.events.filter(e => e.kind === 'pending').length;
    const when = S.startedAt || new Date();
    $('res-when').textContent = when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + ' · ' + sourceName();
    $('res-line').textContent = S.shots + ' shots entered · ' + camGoals + ' goals by camera, ' + missedByCam + ' added by you' +
      (goals > S.shots ? ' · more goals than shots: check the shot number' : '') + (open ? ' · ' + open + ' unsure shot' + (open > 1 ? 's' : '') + ' not answered' : '') +
      (S.source === 'demo' ? ' · demo truth: ' + S.demoTruth + ' goals' : '');

    const z = zoneCounts(), labels = Core.zoneLabels(S.zoneRows);
    $('res-zones').innerHTML = z.map((n, i) => '<div aria-label="' + labels[i] + ': ' + n + '">' + n + '<small>' + labels[i] + '</small></div>').join('');

    const list = $('res-events');
    const camEvents = S.events.filter(e => e.kind !== 'manual');
    list.innerHTML = camEvents.length ? '' : '<p class="small dim">The camera counted no goals and asked nothing.</p>';
    camEvents.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'ev' + (e.wrong || e.kind === 'rejected' ? ' wrong' : '');
      const status = e.kind === 'auto' ? 'counted automatically' : e.kind === 'confirmed' ? 'you said goal' : e.kind === 'rejected' ? 'you said no goal' : 'unsure, not answered';
      row.innerHTML = '<img alt="Still image of shot ' + (i + 1) + '" src="' + e.thumb + '"><div class="txt"><b>' + (e.zonePoint ? zoneOfEvent(e).label : 'Goal') + '</b>' +
        (e.wrong ? 'marked not a goal' : status) + '<br><span class="dim">' + fmtTime(e.t) + ' · ' + e.reason + '</span></div>';
      const btns = document.createElement('div'); btns.className = 'yn';
      if (e.kind === 'auto' || e.kind === 'confirmed') {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small' + (e.wrong ? '' : ' danger');
        b.textContent = e.wrong ? 'Was a goal' : 'Not a goal';
        b.addEventListener('click', () => { e.wrong = !e.wrong; renderResult(); });
        btns.appendChild(b);
      } else {
        const y = document.createElement('button'); y.type = 'button'; y.className = 'btn small'; y.textContent = 'Goal';
        y.addEventListener('click', () => { e.kind = 'confirmed'; e.wrong = false; renderResult(); });
        const n = document.createElement('button'); n.type = 'button'; n.className = 'btn small'; n.textContent = 'No goal';
        n.addEventListener('click', () => { e.kind = 'rejected'; renderResult(); });
        btns.append(y, n);
      }
      row.appendChild(btns); list.appendChild(row);
    });

    const a = Core.accuracy({ correct: camGoals, wrong, missedByCamera: missedByCam, shots: S.shots });
    const pct = (v) => v === null ? '–' : (v * 100).toFixed(1) + ' %';
    $('res-acc').innerHTML =
      '<span>Goals found by the camera <span class="dim small">(target ≥ 95 %)</span></span><span class="v ' + (a.passFound === null ? '' : a.passFound ? 'pass' : 'fail') + '">' + pct(a.found) + '</span>' +
      '<span>False goals per shot <span class="dim small">(target ≤ 2 %)</span></span><span class="v ' + (a.passFalse === null ? '' : a.passFalse ? 'pass' : 'fail') + '">' + pct(a.falseRate) + '</span>' +
      '<span class="small dim" style="grid-column:1/-1">Only meaningful after you checked every shot. One round is too small to judge: the test needs at least 60 shots.</span>';

    $('summary').value = [
      'FLOORBALL IQ Shot Tracker – camera estimate (not validated)',
      (S.startedAt || new Date()).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) + ' · ' + sourceName() + ' · ' + (video.videoWidth + '×' + video.videoHeight) + ' · ~' + (S.fps || '?') + ' fps',
      'Shots ' + S.shots + ' · goals ' + goals + ' (camera ' + camGoals + ', added ' + missedByCam + ') · misses ' + misses,
      'Zones 3×' + S.zoneRows + ' (camera goals, left/centre/right): ' + Core.ZONE_ROWS[S.zoneRows].map((r, i) => r.toLowerCase() + ' ' + z.slice(i * 3, i * 3 + 3).join('/')).join(' · '),
      'Check: correct ' + camGoals + ', false ' + wrong + ', missed by camera ' + missedByCam + ' → found ' + pct(a.found) + ', false/shot ' + pct(a.falseRate),
      'Asked: ' + S.events.filter(e => ['confirmed', 'rejected', 'pending'].includes(e.kind)).length + ' (yes ' + S.events.filter(e => e.kind === 'confirmed').length + ', no ' + S.events.filter(e => e.kind === 'rejected').length + ', open ' + open + ') · shots seen by camera ' + S.shotsSeen,
      'Settings: ball ' + (S.colourMode === 'white' ? 'white' : 'colour rgb(' + (S.ballRGB || []).join(',') + ')') + ', sensitivity ' + S.sensitivity + ', analysed ' + (S.roi ? S.roi.pw + '×' + S.roi.ph : '-') + ', ' + (S.procMs || 0).toFixed(1) + ' ms/frame',
      (S.source === 'demo' ? 'Demo truth: ' + S.demoTruth + ' goals' : ''),
      'Events: ' + S.events.map(e => fmtTime(e.t) + ' ' + e.kind + (e.wrong ? '(false)' : '') + (e.zonePoint ? ' ' + zoneOfEvent(e).label : '') + (e.maxSpeed ? ' v' + e.maxSpeed : '')).join('; '),
    ].filter(Boolean).join('\n');
  }
  function fmtTime(ms) {
    const s = Math.max(0, Math.round((ms - (S.tBase || 0)) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function sourceName() { return S.source === 'camera' ? 'live camera' : S.source === 'file' ? 'video file' : S.source === 'demo' ? 'demo scene' : '-'; }

  document.querySelectorAll('[data-mstep]').forEach(b => b.addEventListener('click', () => {
    $('missed').value = Math.max(0, (+$('missed').value || 0) + +b.dataset.mstep); renderResult();
  }));
  $('missed').addEventListener('input', renderResult);
  $('btn-copy').addEventListener('click', () => {
    const t = $('summary');
    const done = () => { $('btn-copy').textContent = 'Copied'; setTimeout(() => { $('btn-copy').textContent = 'Copy summary'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t.value).then(done, () => { t.select(); });
    else { t.select(); try { document.execCommand('copy'); done(); } catch (e) { /* user copies by hand */ } }
  });
  $('btn-again').addEventListener('click', () => {
    if (!S.source || (!S.stream && S.source !== 'file')) { show('start'); return; }
    if (S.source === 'demo' && S.demo) { S.demo.scene = new window.SceneSim.Scene(640, 360, { count: S.shots, seed: Date.now() % 1000 }); }
    startTracking(true);
  });
  $('btn-home').addEventListener('click', () => { stopSource(); show('start'); });

  // Expose for debugging in the browser console only.
  window.__shotTracker = S;
  S.testEvent = onEvent;
  show('start');
})();
