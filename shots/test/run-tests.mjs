// Node tests: geometry + full detection pipeline on synthetic frames.
// Run: node test/run-tests.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Core = require('../tracker-core.js');
const { Scene } = require('../scene-sim.js');

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failed++;
}

// --- geometry ---
const quad = [{ x: 100, y: 50 }, { x: 300, y: 60 }, { x: 310, y: 200 }, { x: 90, y: 190 }];
const m = Core.goalMapping(quad);
const c = Core.applyH(m.toGoal, 310, 200);
check('homography maps BR corner to (1,1)', Math.abs(c.x - 1) < 1e-6 && Math.abs(c.y - 1) < 1e-6);
const back = Core.applyH(m.toImage, 0.5, 0.5), fwd = Core.applyH(m.toGoal, back.x, back.y);
check('homography round trip', Math.abs(fwd.x - 0.5) < 1e-6 && Math.abs(fwd.y - 0.5) < 1e-6);
check('valid quad accepted', Core.isValidQuad(quad));
check('crossed quad rejected', !Core.isValidQuad([quad[0], quad[2], quad[1], quad[3]]));
check('zone top left', Core.zoneOf(0.1, 0.1).label === 'Top left');
check('zone bottom right', Core.zoneOf(0.9, 0.9).label === 'Bottom right');
check('3x3: middle centre', Core.zoneOf(0.5, 0.5, 3).label === 'Middle centre' && Core.zoneOf(0.5, 0.5, 3).index === 4);
check('3x3: 9 labels', Core.zoneLabels(3).length === 9 && Core.zoneLabels(3)[8] === 'Bottom right');
const acc = Core.accuracy({ correct: 19, wrong: 0, missedByCamera: 1, shots: 40 });
check('accuracy 19/20 = 95 % passes', acc.passFound === true && acc.found === 0.95);

// --- pipeline ---
function run(fps, opts) {
  const scene = new Scene(400, 225, Object.assign({ count: 20 }, opts));
  const det = new Core.Detector(400, 225, scene.r0, {});
  const trk = new Core.ShotTracker(scene.map, {});
  const events = [];
  const frame = new Uint8ClampedArray(400 * 225 * 4);
  for (let t = 0; t < scene.duration(); t += 1000 / fps) {
    scene.render(t, frame, 1000 / fps * 0.5);
    const r = det.process(frame, 1000 / fps);
    trk.absorbAt = null;
    const e = trk.update(r.skipped ? [] : r.blobs, t);
    if (trk.absorbAt) det.absorb(frame, trk.absorbAt.x, trk.absorbAt.y, trk.absorbAt.r);
    if (e) events.push(e);
  }
  const last = trk.flush(scene.duration()); if (last) events.push(last);
  const truth = scene.truth();
  const goals = events.filter(e => e.kind === 'goal'), unsure = events.filter(e => e.kind === 'unsure');
  // Match each truth goal to a counted event within 1.5 s of the shot.
  let correct = 0, zoneRight = 0, zoneClose = 0, zone3Right = 0;
  const used = new Set();
  for (const g of truth) {
    const e = [...goals, ...unsure].find(e => !used.has(e) && e.t >= g.t - 100 && e.t < g.t + 1500);
    if (e) { used.add(e); if (e.kind === 'goal') correct++; if (e.zone.index === g.zone.index) zoneRight++;
      if (Math.hypot(e.impact.u - g.u, e.impact.v - g.v) <= 0.1) zoneClose++;
      if (Core.zoneOf(e.zonePoint.u, e.zonePoint.v, 3).index === g.zone3.index) zone3Right++; }
  }
  const falseGoals = goals.filter(e => !used.has(e)).length;
  return { truth: truth.length, goals: goals.length, unsure: unsure.length, correct, zoneRight, zoneClose, zone3Right, falseGoals, events };
}

for (const fps of [60, 30]) {
  const r = run(fps);
  const detail = `truth ${r.truth}, auto goals ${r.goals}, unsure ${r.unsure}, correct ${r.correct}, false ${r.falseGoals}, zone right 3x2 ${r.zoneRight}, 3x3 ${r.zone3Right}, impact within 0.1 ${r.zoneClose}`;
  check(`${fps} fps: >= 95 % of goals auto-counted`, r.correct / r.truth >= 0.95, detail);
  check(`${fps} fps: no false goals`, r.falseGoals === 0);
  // Zone cells have hard borders; a shot right on a border can land in the
  // neighbour cell. So the test checks the impact point itself.
  check(`${fps} fps: impact point within 10 % of the goal size for >= 90 %`, r.zoneClose / r.truth >= 0.9);
  if (process.argv.includes('-v')) for (const e of r.events) console.log('   ', e.kind, Math.round(e.t), e.reason, e.zone && e.zone.label, e.maxSpeed);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
