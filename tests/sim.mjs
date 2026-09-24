// tests/sim.mjs — end-to-end simulator for the SoleScan guidance engine.
// Feeds SYNTHETIC people (walking, turning, single-leg stance, low
// tracking confidence) through the REAL state machines and asserts the
// full flow completes with correct measurements. Run: node tests/sim.mjs
// Nothing ships unless this is green.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'tests', '.build');
mkdirSync(build, { recursive: true });

// ---- build step: strip browser cache-bust queries, stub the camera layer
const strip = src => src.replace(/(from\s+'[^']+?)\?v=\d+'/g, "$1'");
for (const f of ['posemath.js', 'guide.js', 'engine.js']) {
  writeFileSync(join(build, f), strip(readFileSync(join(root, 'js', f), 'utf8')));
}
writeFileSync(join(build, 'pose.js'), `export * from './posemath.js';
export async function initPose() {}
export async function openCamera() {}
export function closeCamera() {}
export function detect() { return null; }
export function drawSkeleton() {}
`);
writeFileSync(join(build, 'app.js'),
  strip(readFileSync(join(root, 'js', 'app.js'), 'utf8')));

// ---- browser stubs
const els = new Map();
const mkEl = () => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {} },
  textContent: '', innerHTML: '', hidden: false, value: '', dataset: {},
  onclick: null, appendChild() {},
});
globalThis.window = globalThis;
globalThis.document = {
  getElementById: id => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); },
  querySelectorAll: () => [],
  createElement: () => mkEl(),
};
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => ({}) } }, configurable: true,
});
globalThis.location = { reload() {} };
globalThis.requestAnimationFrame = () => 0;
const spoken = [];
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
globalThis.speechSynthesis = {
  cancel() {}, getVoices: () => [], onvoiceschanged: null,
  speak(u) { spoken.push(u.text); queueMicrotask(() => u.onend && u.onend()); },
};
// controllable clock
let NOW = 1_000_000;
Date.now = () => NOW;

const P = await import(join(build, 'posemath.js'));
const G = await import(join(build, 'guide.js'));
G.SPEECH_GAP.ms = 0;
const E = await import(join(build, 'engine.js'));
await import(join(build, 'app.js')); // top-level must not throw

// ---- synthetic person generator (normalized image coords, y grows down)
// dist ~ meters from an ankle-height camera; conf = landmark confidence.
function person({ dist = 3, phase = 0, conf = 0.85, face = 'front',
                  archR = 0.25, archL = 0.25, lift = null, achDeg = 0 } = {}) {
  const lms = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: 0.1 }));
  const s = 0.9 / dist;                    // leg (hip→heel) length in frame
  const floor = Math.min(0.96, 0.6 + 0.12 * s);
  const fl = 0.30 * s;                     // foot length
  const set = (i, x, y, v) => { lms[i] = { x, y, z: 0, visibility: v }; };
  const swing = Math.sin(phase) * 0.18 * s;
  const dx = Math.tan(achDeg * Math.PI / 180); // Achilles lean per unit height
  for (const [side, sign] of [['R', -1], ['L', 1]]) {
    const L = side === 'L';
    const ox = 0.5 + sign * 0.05 * s + (L ? swing : -swing);
    const heelY = lift === side ? floor - 0.6 * fl : floor;
    const arch = side === 'R' ? archR : archL;
    const HEEL = L ? P.LM.L_HEEL : P.LM.R_HEEL, TOE = L ? P.LM.L_TOE : P.LM.R_TOE;
    const ANK = L ? P.LM.L_ANKLE : P.LM.R_ANKLE, KNEE = L ? P.LM.L_KNEE : P.LM.R_KNEE;
    const HIP = L ? P.LM.L_HIP : P.LM.R_HIP;
    set(HEEL, ox, heelY, conf);
    set(TOE, ox + fl, heelY, conf);
    set(ANK, ox + 0.25 * fl, heelY - arch * fl, conf);
    const kneeY = heelY - 0.5 * s;
    set(KNEE, ox + dx * (heelY - kneeY), kneeY, conf);
    set(HIP, ox, heelY - s, conf);
  }
  const faceY = floor - 1.6 * s;
  const fv = face === 'front' ? 0.9 : face === 'back' ? 0.05 : 0.45;
  set(P.LM.NOSE, .5, faceY, fv);
  set(P.LM.L_EYE, .49, faceY, fv); set(P.LM.R_EYE, .51, faceY, fv);
  set(P.LM.L_EAR, .48, faceY, face === 'back' ? 0.05 : 0.6);
  set(P.LM.R_EAR, .52, faceY, face === 'back' ? 0.05 : 0.6);
  return lms;
}

// ---- tiny test harness
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${extra}`); }
};
const tick = async (machine, lms, ms = 33) => {
  NOW += ms;
  machine.frame(lms);
  await new Promise(r => setImmediate(r));
};
const ui = () => ({ instr() {}, tag() {} });

// ================= T1: sight diagnosis =================
{
  console.log('T1 sight diagnosis');
  check('full person ok', P.diagnose(person()).ok);
  check('nobody → no_person', P.diagnose(null).reason === 'no_person');
  check('low conf → legs_hidden', P.diagnose(person({ conf: 0.1 })).reason === 'legs_hidden');
  const cut = person(); [P.LM.R_HEEL, P.LM.L_HEEL, P.LM.R_TOE, P.LM.L_TOE]
    .forEach(i => { cut[i].y = 0.995; });
  check('feet at frame edge → feet_cut', P.diagnose(cut).reason === 'feet_cut');
  check('arch framing ok at 2m', P.archDiagnose(person({ dist: 2 })).ok);
  check('arch too far → too_far', P.archDiagnose(person({ dist: 12 })).reason === 'too_far');
}

// ================= T2: walking scan end-to-end =================
{
  console.log('T2 walking scan (record → analyze)');
  const m = new G.WalkScan({ ui: ui() });
  // sync facing the camera
  for (let i = 0; i < 80 && m.state !== 'RECORD'; i++)
    await tick(m, person({ dist: 3, face: 'front' }));
  check('reaches RECORD', m.state === 'RECORD', `state=${m.state}`);
  // walk back and forth naturally with 6° Achilles deviation
  let t = 0;
  while (m.state === 'RECORD' && t < 40000) {
    const cyc = (t % 8000) / 8000;                 // 8s out-and-back
    const dist = cyc < 0.5 ? 1.6 + 2.8 * cyc : 3 - 2.8 * (cyc - 0.5);
    const face = cyc < 0.5 ? 'back' : 'front';
    await tick(m, person({ dist, face, phase: t / 90, achDeg: 6 }));
    t += 33;
  }
  check('recording completes', m.done, `state=${m.state}`);
  const r = m.result();
  check('enough gait cycles', r.cycles >= 6, `cycles=${r.cycles}`);
  check(`Achilles ≈ 6° (got R=${r.R.ach} L=${r.L.ach})`,
    Math.abs(r.R.ach - 6) < 2.5 && Math.abs(r.L.ach - 6) < 2.5);
}

// ================= T3: marginal detection must not flip-flop =================
{
  console.log('T3 flicker / flip-flop tolerance');
  const m = new G.WalkScan({ ui: ui() });
  for (let i = 0; i < 120 && m.state === 'FIND'; i++)
    await tick(m, person({ conf: i % 3 === 0 ? 0.15 : 0.7 })); // 1/3 bad frames
  check('syncs despite flicker', m.state !== 'FIND', `state=${m.state}`);

  const m2 = new G.WalkScan({ ui: ui() });
  spoken.length = 0;
  // detection dropping out entirely on 30% of frames — the killer case
  for (let i = 0; i < 200 && m2.state === 'FIND'; i++)
    await tick(m2, i % 10 < 3 ? null : person());
  check('syncs despite 30% dropped frames', m2.state !== 'FIND', `state=${m2.state}`);
  const seeYou = spoken.filter(s => s.includes('אני רואה אותך')).length;
  const loseYou = spoken.filter(s => s.includes('לא רואה')).length;
  check('no I-see-you/lost-you loop', seeYou <= 1 && loseYou === 0,
    `seeYou=${seeYou} loseYou=${loseYou}`);

  // a face-only close-up (legs invisible) must NEVER sync — it must coach
  const m3 = new G.WalkScan({ ui: ui() });
  spoken.length = 0;
  for (let i = 0; i < 200; i++) await tick(m3, person({ conf: 0.1 }));
  check('face-only never syncs', m3.state === 'FIND', `state=${m3.state}`);
  check('coaches to step back', spoken.some(s => s.includes('התרחק') || s.includes('הרגליים')),
    JSON.stringify(spoken.slice(0, 2)));
}

// ================= T4: arch test measures the STANDING foot =================
{
  console.log('T4 arch test');
  const m = new G.ArchTest({ side: 'R', ui: ui() });
  // close-up profile, both feet down, standing arch 0.25
  for (let i = 0; i < 200 && m.state !== 'LIFT'; i++)
    await tick(m, person({ dist: 1.2, face: 'profile', archR: 0.25, archL: 0.25 }));
  check('baseline captured → LIFT', m.state === 'LIFT', `state=${m.state}`);
  // lift the LEFT (near) foot; standing RIGHT arch collapses to 0.15 —
  // the lifted foot gets a nonsense arch that must NOT leak into results
  const loaded = { dist: 1.2, face: 'profile', lift: 'L', archR: 0.15, archL: 0.9 };
  for (let i = 0; i < 60 && m.state !== 'HOLD'; i++) await tick(m, person(loaded));
  check('lift detected → HOLD', m.state === 'HOLD', `state=${m.state}`);
  for (let i = 0; i < 300 && !m.done; i++) await tick(m, person(loaded));
  check('hold completes', m.done, `state=${m.state}`);
  const r = m.result();
  // collapse from 0.25 → 0.15 = 40%
  check(`collapse ≈ 40% from the standing foot (got ${r.collapse}%)`,
    r.collapse > 30 && r.collapse < 50);

  // a LOW hover must be enough — and an OCCLUDED lifted heel too
  for (const [name, tweak] of [
    ['low hover lift detected', p => { p[P.LM.L_HEEL].y -= 0.30 * 0.225; p[P.LM.L_TOE].y -= 0.30 * 0.225; }],
    ['occluded lifted heel detected', p => { p[P.LM.L_HEEL].visibility = 0.1; p[P.LM.L_TOE].visibility = 0.1; }],
  ]) {
    const m2 = new G.ArchTest({ side: 'R', ui: ui() });
    for (let i = 0; i < 200 && m2.state !== 'LIFT'; i++)
      await tick(m2, person({ dist: 1.2, face: 'profile' }));
    for (let i = 0; i < 100 && m2.state !== 'HOLD'; i++) {
      const p = person({ dist: 1.2, face: 'profile', lift: 'L' });
      // undo the full lift, apply the tweak on a both-down pose
      const q = person({ dist: 1.2, face: 'profile' });
      tweak(q);
      await tick(m2, name.includes('hover') ? q : (tweak(p), p));
    }
    check(name, m2.state === 'HOLD', `state=${m2.state}`);
  }
}

// ================= T5: classification tree =================
{
  console.log('T5 decision tree');
  check('straight tendon + varus → high',
    E.classify({ ach: 2, knee: -5, collapse: 10 }).cls === 'high');
  check('broken tendon + big collapse → flat',
    E.classify({ ach: 8, knee: 4, collapse: 45 }).cls === 'flat');
  check('moderate → low',
    E.classify({ ach: 4.5, knee: 2, collapse: 30 }).cls === 'low');
}

// ================= T6: sitting still must NOT complete the scan =================
{
  console.log('T6 blind-clock guard');
  const m = new G.WalkScan({ ui: ui() });
  for (let i = 0; i < 80 && m.state !== 'RECORD'; i++)
    await tick(m, person({ dist: 2 }));
  check('reaches RECORD', m.state === 'RECORD', `state=${m.state}`);
  spoken.length = 0;
  for (let i = 0; i < 900; i++) await tick(m, person({ dist: 2 })); // ~30s static
  check('static person does not finish the scan', !m.done, `state=${m.state}`);
  check('voice asks for movement', spoken.some(s => s.includes('תנועה') || s.includes('הלוך ושוב')),
    JSON.stringify(spoken.slice(0, 3)));
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL GREEN');
process.exit(failures ? 1 : 0);
