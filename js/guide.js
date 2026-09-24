// guide.js — real-time guidance: voice (Hebrew TTS) + big on-screen text.
// The scan state machines live here; they consume landmark frames and
// decide what to tell the user next. The readiness gate everywhere is
// lowerBodyVisible: floor-to-waist in frame — angles are tracked from the
// moment hips-to-heels are visible, not from a distance estimate.
import * as P from './pose.js?v=6';

let hebVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  hebVoice = vs.find(v => v.lang && v.lang.startsWith('he')) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

// Mobile browsers only allow TTS started from a user gesture. Call this
// from the Start button's click handler to unlock the audio channel.
export function primeTTS() {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance('מתחילים');
    u.lang = 'he-IL'; if (hebVoice) u.voice = hebVoice;
    speechSynthesis.speak(u);
  } catch { /* no TTS — screen text still guides */ }
}

let lastSpoken = '', lastSpokenAt = 0;
export function say(text, { force = false } = {}) {
  const now = Date.now();
  if (!force && text === lastSpoken && now - lastSpokenAt < 6000) return;
  lastSpoken = text; lastSpokenAt = now;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'he-IL'; u.rate = 1.05; if (hebVoice) u.voice = hebVoice;
    speechSynthesis.speak(u);
  } catch { /* TTS unavailable */ }
}

const HEB_COUNT = ['אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'];

// ---------- step counter ----------
// Counts steps from the horizontal ankle-separation oscillation: each
// stride swings the ankles apart and back. A peak above threshold with a
// minimum interval = one step.
class StepCounter {
  constructor() { this.prev = 0; this.rising = false; this.steps = 0; this.lastStepAt = 0; }
  feed(lms) {
    const la = lms[P.LM.L_ANKLE], ra = lms[P.LM.R_ANKLE];
    const lh = lms[P.LM.L_HIP], rh = lms[P.LM.R_HIP];
    // normalize by leg length in frame, so the threshold is distance-
    // independent: a step far from the camera and a step close to it
    // produce the same normalized swing.
    const legLen = (Math.hypot(lh.x - la.x, lh.y - la.y) +
                    Math.hypot(rh.x - ra.x, rh.y - ra.y)) / 2;
    if (legLen < 1e-3) return false;
    const sep = Math.hypot(la.x - ra.x, la.y - ra.y) / legLen;
    const now = Date.now();
    let stepped = false;
    if (sep > this.prev + 0.01) this.rising = true;
    else if (this.rising && sep < this.prev - 0.01 && this.prev > 0.22
             && now - this.lastStepAt > 400) {
      this.steps++; this.lastStepAt = now; this.rising = false; stepped = true;
    }
    this.prev = sep;
    return stepped;
  }
  reset() { this.prev = 0; this.steps = 0; this.rising = false; this.lastStepAt = 0; }
}

// ---------- walking scan (ankle height) ----------
// The protocol:
//   floor-to-waist visible (sync) → turn, back to camera → 5 steps,
//   counted aloud → stop → turn, face camera → 5 steps counted aloud
//   (the measurement leg: Achilles + knee axis sampled per frame).
export class WalkScan {
  constructor({ steps = 5, ui }) {
    this.stepsTarget = steps; this.ui = ui;
    this.state = 'FIND';
    this.samples = { R: { ach: [], knee: [] }, L: { ach: [], knee: [] } };
    this.counter = new StepCounter();
    this.stateSince = Date.now();
    this.visibleSince = 0;
    this.ui.instr('התרחק עד שרואים אותך מהרצפה עד המותן');
  }
  setState(s, instr, speak) {
    if (this.state !== s) {
      this.state = s; this.stateSince = Date.now();
      if (instr != null) this.ui.instr(instr);
      if (speak) say(speak, { force: true });
    } else if (instr != null) this.ui.instr(instr);
  }
  sinceMs() { return Date.now() - this.stateSince; }
  get done() { return this.state === 'DONE'; }
  progress() {
    const map = { FIND: .02, SYNC: .1, TURN_BACK: .2, WALK_AWAY: .3, STOP: .55, TURN_FACE: .62, WALK_TOWARD: .72, DONE: 1 };
    let p = map[this.state] ?? 0;
    if (this.state === 'WALK_AWAY') p = .22 + .32 * (this.counter.steps / this.stepsTarget);
    if (this.state === 'WALK_TOWARD') p = .68 + .32 * (this.counter.steps / this.stepsTarget);
    return Math.min(1, p);
  }
  sampleAngles(lms) {
    for (const side of ['R', 'L']) {
      this.samples[side].ach.push(Math.abs(P.achillesDeviation(lms, side)));
      this.samples[side].knee.push(P.kneeAxis(lms, side));
    }
  }
  frame(lms) {
    const visible = !!lms && P.lowerBodyVisible(lms);
    switch (this.state) {
      case 'FIND':
        if (visible) {
          if (!this.visibleSince) this.visibleSince = Date.now();
          this.ui.instr('רואים אותך — עמוד רגע במקום');
          // stable for a moment = synced; angles are already being tracked
          if (Date.now() - this.visibleSince > 1200)
            this.setState('SYNC', 'מסונכרן ✓', 'מסונכרן! מזהה את הרגליים');
        } else {
          this.visibleSince = 0;
          this.ui.instr('התרחק עד שרואים אותך מהרצפה עד המותן');
          if (lms && !P.lowerBodyVisible(lms))
            say('התרחק מעט, עד שרואים אותך מהרצפה עד קו המותן');
        }
        break;
      case 'SYNC':
        if (visible) this.sampleAngles(lms);
        if (this.sinceMs() > 1200) {
          this.counter.reset();
          this.setState('TURN_BACK', 'הסתובב — גב למצלמה', 'עכשיו הסתובב, גב למצלמה');
        }
        break;
      case 'TURN_BACK':
        if (this.sinceMs() > 2500) {
          this.counter.reset();
          this.setState('WALK_AWAY', 'קח 5 צעדים קדימה', 'קח חמישה צעדים קדימה. אני סופר איתך');
        }
        break;
      case 'WALK_AWAY': {
        if (lms && this.sinceMs() > 1200 && this.counter.feed(lms)) {
          const n = this.counter.steps;
          say(HEB_COUNT[n - 1] || String(n), { force: true });
        }
        this.ui.instr(`צעד ${Math.min(this.counter.steps, this.stepsTarget)} מתוך ${this.stepsTarget}`);
        if (this.counter.steps >= this.stepsTarget)
          this.setState('STOP', 'עצור', 'עצור');
        break;
      }
      case 'STOP':
        if (this.sinceMs() > 1500)
          this.setState('TURN_FACE', 'הסתובב — פנים למצלמה', 'עכשיו הסתובב, פנים למצלמה');
        break;
      case 'TURN_FACE':
        if (this.sinceMs() > 2500) {
          this.counter.reset();
          this.setState('WALK_TOWARD', 'קח 5 צעדים אל המצלמה', 'קח חמישה צעדים קדימה, ישר אל המצלמה. אני סופר איתך');
        }
        break;
      case 'WALK_TOWARD': {
        if (lms) {
          if (visible || P.legsVisible(lms)) this.sampleAngles(lms);
          if (this.sinceMs() > 1200 && this.counter.feed(lms)) {
            const n = this.counter.steps;
            say(HEB_COUNT[n - 1] || String(n), { force: true });
          }
        }
        this.ui.instr(`צעד ${Math.min(this.counter.steps, this.stepsTarget)} מתוך ${this.stepsTarget}`);
        if (this.counter.steps >= this.stepsTarget)
          this.setState('DONE', 'מעולה! השלב הושלם', 'מעולה! השלב הושלם');
        break;
      }
    }
  }
  // Robust aggregate: median of the worst (highest-deviation) third —
  // gait deviation peaks at mid-stance, so the tail carries the signal.
  result() {
    const agg = a => {
      if (!a.length) return 0;
      const s = [...a].sort((x, y) => y - x);
      const tail = s.slice(0, Math.max(3, Math.floor(s.length / 3)));
      return +tail[Math.floor(tail.length / 2)].toFixed(1);
    };
    const med = a => {
      if (!a.length) return 0;
      const s = [...a].sort((x, y) => x - y);
      return +s[Math.floor(s.length / 2)].toFixed(1);
    };
    return {
      R: { ach: agg(this.samples.R.ach), knee: med(this.samples.R.knee) },
      L: { ach: agg(this.samples.L.ach), knee: med(this.samples.L.knee) },
      frames: this.samples.R.ach.length,
    };
  }
}

// ---------- single-leg arch-loading test ----------
// The arch is MEDIAL (inner side). To film the right foot's arch, the
// camera must see its inner aspect: the user stands with their LEFT side
// to the camera and lifts the LEFT (camera-near) leg out of the line of
// sight, loading the right leg — the FAR leg, whose medial arch now
// faces the camera. So correct form is: near foot lifted, far foot
// planted, and the arch is measured on the far (standing) foot.
// Starts only when floor-to-waist is in frame; wrong leg → voice fix.
export class ArchTest {
  constructor({ side, holdMs = 5000, ui }) {
    this.side = side; this.other = side === 'R' ? 'L' : 'R';
    this.holdMs = holdMs; this.ui = ui;
    this.state = 'FIND';
    this.baseline = []; this.loaded = [];
    this.stateSince = Date.now();
    this.visibleSince = 0;
    this.lastCorrectionAt = 0;
    this.name = side === 'R' ? 'ימין' : 'שמאל';
    this.otherName = side === 'R' ? 'שמאל' : 'ימין';
    this.ui.instr('התרחק עד שרואים אותך מהרצפה עד המותן');
  }
  setState(s) { this.state = s; this.stateSince = Date.now(); }
  get done() { return this.state === 'DONE'; }
  progress() {
    if (this.state === 'FIND') return 0.05;
    if (this.state === 'PROFILE') return 0.2;
    if (this.state === 'LIFT') return 0.35;
    if (this.state === 'HOLD') return 0.4 + 0.6 * Math.min(1, (Date.now() - this.stateSince) / this.holdMs);
    return 1;
  }
  // Left/right labels swap in profile (one leg occludes the other), so
  // legs are identified by camera depth (z), never by label.
  // The measured leg is the FAR (standing) one — its medial arch faces
  // the camera; the near leg is the one lifted clear of the line of sight.
  farLabel(lms) {
    return (lms[P.LM.R_ANKLE].z ?? 0) >= (lms[P.LM.L_ANKLE].z ?? 0) ? 'R' : 'L';
  }
  liftedFoot(lms) {
    const a1 = lms[P.LM.R_ANKLE], a2 = lms[P.LM.L_ANKLE];
    const near = (a1.z ?? 0) <= (a2.z ?? 0) ? a1 : a2;
    const far = near === a1 ? a2 : a1;
    const diff = near.y - far.y; // y grows downward
    if (diff > 0.04) return 'near';  // near ankle is higher → CORRECT form
    if (diff < -0.04) return 'far';  // far (standing) ankle is up → wrong leg
    return null;                     // both down
  }
  // debounced classification: require consecutive frames before acting
  stableLifted(lms) {
    const v = this.liftedFoot(lms);
    if (v === this._lastLift) this._liftFrames = (this._liftFrames || 0) + 1;
    else { this._lastLift = v; this._liftFrames = 1; }
    return this._liftFrames >= 12 ? v : undefined; // ~0.5s at 25fps
  }
  correctWrongLeg() {
    if (Date.now() - this.lastCorrectionAt < 4000) return;
    this.lastCorrectionAt = Date.now();
    say(`רגל לא נכונה! עמוד על רגל ${this.name} והרם את רגל ${this.otherName}`, { force: true });
    this.ui.instr(`עמוד על רגל ${this.name} — הרם את רגל ${this.otherName}`);
  }
  frame(lms) {
    const visible = !!lms && P.lowerBodyVisible(lms);
    switch (this.state) {
      case 'FIND':
        if (visible) {
          if (!this.visibleSince) this.visibleSince = Date.now();
          if (Date.now() - this.visibleSince > 1000) {
            this.setState('PROFILE');
            this.ui.instr(`עמוד בפרופיל — צד ${this.otherName} למצלמה`);
            say(`מסונכרן. עמוד בפרופיל, כשצד ${this.otherName} שלך פונה למצלמה, על שתי הרגליים. ככה נראה את הקשת הפנימית של רגל ${this.name}`, { force: true });
          }
        } else {
          this.visibleSince = 0;
          this.ui.instr('התרחק עד שרואים אותך מהרצפה עד המותן');
        }
        break;
      case 'PROFILE': {
        if (!lms) break;
        const arch = P.archHeight(lms, this.farLabel(lms));
        if (arch != null) this.baseline.push(arch);
        if (this.baseline.length > 30 && this.sinceMs() > 2500) {
          this.setState('LIFT');
          this.ui.instr(`עמוד על רגל ${this.name} — הרם את רגל ${this.otherName}`);
          say(`עכשיו הרם את רגל ${this.otherName} ועמוד על רגל ${this.name} בלבד`, { force: true });
        }
        break;
      }
      case 'LIFT': {
        if (!lms) break;
        const lifted = this.stableLifted(lms);
        if (lifted === 'far') { this.correctWrongLeg(); break; }
        if (lifted === 'near') {
          this.setState('HOLD');
          say('מצוין. החזק חמש שניות', { force: true });
        } else if (this.sinceMs() > 6000) {
          say(`הרם את רגל ${this.otherName} מהרצפה`, { force: true });
          this.stateSince = Date.now();
        }
        break;
      }
      case 'HOLD': {
        if (!lms) break;
        const lifted = this.stableLifted(lms);
        if (lifted === 'far') { this.correctWrongLeg(); this.setState('LIFT'); break; }
        if (lifted === null) { this.setState('LIFT'); break; } // foot came down — restart hold
        const arch = P.archHeight(lms, this.farLabel(lms));
        if (arch != null) this.loaded.push(arch);
        const left = Math.ceil((this.holdMs - this.sinceMs()) / 1000);
        this.ui.instr(left > 0 ? String(left) : '✓');
        if (this.sinceMs() >= this.holdMs) {
          this.setState('DONE');
          say('יופי, אפשר להוריד את הרגל', { force: true });
        }
        break;
      }
    }
  }
  sinceMs() { return Date.now() - this.stateSince; }
  result() {
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
    const base = med(this.baseline), load = med(this.loaded);
    if (!base) return { collapse: 0, frames: this.loaded.length };
    const collapse = Math.round(Math.max(0, Math.min(100, (1 - load / base) * 100)));
    return { collapse, frames: this.loaded.length };
  }
}
