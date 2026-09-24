// guide.js — real-time guidance: voice (Hebrew TTS) + big on-screen text.
// The scan state machines live here; they consume landmark frames and
// decide what to tell the user next. The readiness gate everywhere is
// lowerBodyVisible: floor-to-waist in frame — angles are tracked from the
// moment hips-to-heels are visible, not from a distance estimate.
import * as P from './pose.js?v=14';

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

/* ---------- speech engine ----------
   A queue, not a trigger. Instructions play to completion and queue up;
   only an URGENT line (a correction, "stop") interrupts mid-utterance.
   State machines gate their transitions on speechIdle() so the guide
   never talks over itself — this is what makes the voice calm. */
const speech = {
  q: [], speaking: false, lastText: '', lastAt: 0,
  idle() { return !this.speaking && this.q.length === 0; },
  say(text, { urgent = false, dedupeMs = 6000 } = {}) {
    const now = Date.now();
    if (text === this.lastText && now - this.lastAt < dedupeMs) return;
    if (urgent) { this.q.length = 0; try { speechSynthesis.cancel(); } catch {} this.speaking = false; }
    this.q.push(text);
    this._drain();
  },
  _drain() {
    if (this.speaking || !this.q.length) return;
    const text = this.q.shift();
    this.lastText = text; this.lastAt = Date.now();
    this.speaking = true;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'he-IL'; u.rate = 1.02; if (hebVoice) u.voice = hebVoice;
      const done = () => { this.speaking = false; setTimeout(() => this._drain(), 300); };
      u.onend = done; u.onerror = done;
      speechSynthesis.speak(u);
      // watchdog: some mobile engines drop onend — assume ~90ms/char
      setTimeout(() => { if (this.speaking && this.lastText === text) { this.speaking = false; this._drain(); } },
        Math.max(2500, text.length * 90));
    } catch { this.speaking = false; }
  },
};
export function say(text, { force = false, urgent = false } = {}) {
  speech.say(text, { urgent: urgent || false, dedupeMs: force ? 0 : 6000 });
}
export function speechIdle() { return speech.idle(); }

const HEB_COUNT = ['אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'];

// ---------- sight coach ----------
// Speaks according to what the camera actually sees, not on a script:
// every spoken line is derived from the current sight diagnosis, and it
// only speaks when the situation changes (or persists too long).
const SIGHT_LINES = {
  no_person: ['לא רואים אותך — היכנס לפריים', 'אני לא רואה אותך. עמוד מול המצלמה'],
  legs_hidden: ['התרחק מעט — צריך לראות את הרגליים עד הרצפה', 'עוד קצת אחורה, שאראה את הרגליים שלך במלואן'],
  feet_cut: ['כפות הרגליים נחתכות — התרחק צעד או הטה את הטלפון מעט למטה', 'לא רואים את כפות הרגליים. צעד אחורה'],
  too_far: ['התקרב — המצלמה צריכה לראות את כף הרגל מקרוב', 'עוד קצת קדימה, שכף הרגל תמלא את הפריים'],
};
class SightCoach {
  constructor(ui) { this.ui = ui; this.lastReason = null; this.lastSpokeAt = 0; }
  feed(diag) {
    const now = Date.now();
    if (diag.ok) { this.lastReason = null; return true; }
    const changed = diag.reason !== this.lastReason;
    if (changed || now - this.lastSpokeAt > 5000) {
      const lines = SIGHT_LINES[diag.reason] || SIGHT_LINES.no_person;
      const line = lines[Math.floor(now / 5000) % lines.length];
      say(line, { force: changed });
      this.ui.instr(line);
      this.lastReason = diag.reason; this.lastSpokeAt = now;
    }
    return false;
  }
}

const HEB_COUNT = ['אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'];

// ---------- step counter ----------
// Real step detection: the ankles separate and close once per step. The
// separation signal is normalized by the walker's leg scale in frame, so
// the same threshold works near and far. Peak detection with smoothing,
// hysteresis and a minimum interval kills double counts.
class StepCounter {
  constructor() { this.smooth = null; this.dir = 0; this.steps = 0; this.lastStepAt = 0; }
  feed(lms) {
    const scale = P.legScale(lms);
    if (!scale) return false;
    const la = lms[P.LM.L_ANKLE], ra = lms[P.LM.R_ANKLE];
    const sep = Math.hypot(la.x - ra.x, la.y - ra.y) / scale;
    if (this.smooth == null) { this.smooth = sep; return false; }
    const prev = this.smooth;
    this.smooth = prev * 0.55 + sep * 0.45;
    let stepped = false;
    if (this.smooth > prev + 0.006) this.dir = 1;
    else if (this.smooth < prev - 0.006 && this.dir === 1) {
      // a peak just passed; count it if the swing was a real stride
      if (prev > 0.18 && Date.now() - this.lastStepAt > 380) {
        this.steps++; this.lastStepAt = Date.now(); stepped = true;
      }
      this.dir = -1;
    }
    return stepped;
  }
  reset() { this.smooth = null; this.dir = 0; this.steps = 0; this.lastStepAt = 0; }
}

// ---------- walking scan (ankle height) ----------
// Timed protocol — no step counting (it was unreliable):
//   sight-synced facing the camera → turn, back to camera → walk until
//   told to stop → turn, face camera → walk toward the camera; the stop
//   is called from what the camera sees (heels reaching the lower frame),
//   with a time fallback. Angles sampled on the walk-toward leg.
export class WalkScan {
  constructor({ ui }) {
    this.ui = ui;
    this.state = 'FIND';
    this.samples = { R: { ach: [], knee: [] }, L: { ach: [], knee: [] } };
    this.stateSince = Date.now();
    this.visibleSince = 0;
    this.faceFrames = 0;
    // Whether face landmarks were EVER reliably seen while the user faced
    // the camera. At 3-4m from an ankle-height camera the face can be too
    // small to detect at all — then "no face" does NOT mean "back turned",
    // and orientation must fall back to giving the user real time to turn.
    this.faceSeen = false;
    this.entryScale = null; this.settleUntil = 0;
    this.counter = new StepCounter();
    this.coach = new SightCoach(ui);
    this.ui.instr('עמוד מול המצלמה');
  }
  setState(st, instr, speak) {
    if (this.state !== st) {
      this.state = st; this.stateSince = Date.now();
      if (instr != null) this.ui.instr(instr);
      if (speak) say(speak, { force: true });
    } else if (instr != null) this.ui.instr(instr);
  }
  sinceMs() { return Date.now() - this.stateSince; }
  get done() { return this.state === 'DONE'; }
  progress() {
    const map = { FIND: .05, SYNC: .15, TURN_BACK: .25, WALK_AWAY: .4, STOP: .55, TURN_FACE: .65, WALK_TOWARD: .8, DONE: 1 };
    return map[this.state] ?? 0;
  }
  sampleAngles(lms) {
    for (const side of ['R', 'L']) {
      this.samples[side].ach.push(Math.abs(P.achillesDeviation(lms, side)));
      this.samples[side].knee.push(P.kneeAxis(lms, side));
    }
  }
  frame(lms) {
    const diag = P.diagnose(lms);
    switch (this.state) {
      case 'FIND':
        if (this.coach.feed(diag)) {
          if (!this.visibleSince) {
            this.visibleSince = Date.now();
            this.ui.instr('רואים אותך ✓');
            say('אני רואה אותך, מהרצפה עד המותן. עמוד רגע במקום', { force: true });
          }
          if (Date.now() - this.visibleSince > 1500)
            this.setState('SYNC', 'מסונכרן ✓', 'מסונכרן');
        } else this.visibleSince = 0;
        break;
      case 'SYNC':
        if (diag.ok && lms) this.sampleAngles(lms);
        if (lms && P.facing(lms) === 'front') this.faceSeen = true;
        if (this.sinceMs() > 1000 && speechIdle()) {
          this.faceFrames = 0;
          this.setState('TURN_BACK', 'הסתובב — גב למצלמה', 'עכשיו הסתובב, גב למצלמה');
        }
        break;
      case 'TURN_BACK': {
        // Orientation is trusted only if the face was actually detectable
        // facing the camera; otherwise "no face" proves nothing and the
        // user simply gets real time to complete the turn.
        let turned;
        if (this.faceSeen) {
          if (lms && P.facing(lms) === 'back') this.faceFrames++;
          else this.faceFrames = 0;
          turned = this.faceFrames >= 8;
        } else turned = this.sinceMs() > 4000;
        if (turned && speechIdle()) {
          this.reminded = false; this.counter.reset();
          this.entryScale = null; this.settleUntil = Date.now() + 1500;
          this.setState('WALK_AWAY', 'קח 5 צעדים קדימה', 'יופי. קח חמישה צעדים קדימה, אני סופר איתך');
        } else if (this.sinceMs() > 9000 && speechIdle()) {
          say('הסתובב, גב למצלמה', { force: true });
          this.stateSince = Date.now();
        }
        break;
      }
      case 'WALK_AWAY': {
        // count five actual steps — but only once the turn has settled and
        // only while the walker is genuinely receding (leg scale shrinking),
        // so turn jitter can never be counted as steps.
        if (!diag.ok && diag.reason === 'no_person')
          this.coach.feed(diag); // walked out of frame — call it out
        const scale = lms ? P.legScale(lms) : null;
        if (scale && Date.now() < this.settleUntil) {
          this.entryScale = Math.max(this.entryScale ?? 0, scale);
        } else if (lms && scale && this.entryScale &&
                   scale < this.entryScale * 0.985 && this.counter.feed(lms)) {
          const n = this.counter.steps;
          say(HEB_COUNT[n - 1] || String(n), { force: true });
        }
        this.ui.instr(`צעד ${Math.min(this.counter.steps, 5)} מתוך 5`);
        if (this.counter.steps >= 5) {
          say('עצור', { urgent: true });
          this.setState('STOP', 'עצור', null);
          break;
        }
        if (!this.reminded && this.sinceMs() > 6000 && this.counter.steps === 0) {
          this.reminded = true;
          say('לך קדימה, תתרחק מהמצלמה', { force: true });
        }
        if (this.sinceMs() > 15000) { // safety net so nobody gets stuck
          say('עצור', { urgent: true });
          this.setState('STOP', 'עצור', null);
        }
        break;
      }
      case 'STOP':
        if (this.sinceMs() > 1200 && speechIdle())
          this.setState('TURN_FACE', 'הסתובב — פנים למצלמה', 'עכשיו הסתובב, פנים למצלמה');
        break;
      case 'TURN_FACE': {
        // The walker is far now, so the face may be undetectable even when
        // they have turned — trust it only if it was detectable before.
        let turned;
        if (this.faceSeen) {
          if (lms && P.facing(lms) === 'front') this.faceFrames++;
          else this.faceFrames = 0;
          turned = this.faceFrames >= 8;
        } else turned = this.sinceMs() > 4000;
        if (turned && speechIdle()) {
          this.reminded = false; this.counter.reset();
          this.entryScale = null; this.settleUntil = Date.now() + 1500;
          this.setState('WALK_TOWARD', 'קח 5 צעדים אל המצלמה', 'יופי. עכשיו קח חמישה צעדים ישר אל המצלמה, אני סופר איתך');
        } else if (this.sinceMs() > 9000 && speechIdle()) {
          say('הסתובב — פנים למצלמה', { force: true });
          this.stateSince = Date.now();
        }
        break;
      }
      case 'WALK_TOWARD': {
        if (lms && diag.ok) this.sampleAngles(lms);
        // count only while genuinely approaching (leg scale growing)
        const scale = lms ? P.legScale(lms) : null;
        if (scale && Date.now() < this.settleUntil) {
          this.entryScale = Math.min(this.entryScale ?? Infinity, scale);
        } else if (lms && scale && this.entryScale &&
                   scale > this.entryScale * 1.015 && this.counter.feed(lms)) {
          const n = this.counter.steps;
          say(HEB_COUNT[n - 1] || String(n), { force: true });
        }
        this.ui.instr(`צעד ${Math.min(this.counter.steps, 5)} מתוך 5`);
        if (!this.reminded && this.sinceMs() > 6000 && this.counter.steps === 0) {
          this.reminded = true;
          say('המשך ללכת ישר אל המצלמה', { force: true });
        }
        // five real steps, or the walker physically arrived at the camera
        const arrived = lms && P.approachLevel(lms) > 0.92;
        if (this.counter.steps >= 5 || (arrived && this.sinceMs() > 2000) || this.sinceMs() > 15000) {
          say('עצור', { urgent: true });
          this.setState('DONE', 'עצור — מעולה! השלב הושלם', 'מעולה, השלב הושלם');
        }
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
// The arch is MEDIAL (inner side). To film the right foot's arch the
// user stands with their LEFT side to the camera and lifts the LEFT
// (camera-near) leg out of the line of sight, loading the right leg —
// the far leg, whose medial arch now faces the camera.
// No wrong-leg policing: profile depth data is too noisy to accuse the
// user. Instead the instructions are unambiguous, the hold starts when
// ANY foot is clearly lifted, and the arch is always measured on the
// STANDING (lower) foot — so the measurement cannot land on the wrong leg.
export class ArchTest {
  constructor({ side, holdMs = 5000, ui }) {
    this.side = side;
    this.holdMs = holdMs; this.ui = ui;
    this.state = 'FIND';
    this.baseline = []; this.loaded = [];
    this.floorSamples = []; this.floorY = null;
    this.stateSince = Date.now();
    this.visibleSince = 0;
    this.coach = new SightCoach(ui);
    this.name = side === 'R' ? 'ימין' : 'שמאל';
    this.otherName = side === 'R' ? 'שמאל' : 'ימין';
    this.ui.instr('התקרב — שכף הרגל והקרסול ימלאו את הפריים');
  }
  // Lift detection anchored to the FLOOR LINE recorded during the two-leg
  // baseline — no hips (out of frame in close-up), no depth guessing.
  // Returns the LABEL of the lifted foot ('R'/'L'), or null if none:
  // one heel must rise clearly above the floor line while the other
  // stays planted on it.
  liftedLabel(lms) {
    if (this.floorY == null) return null;
    const foot = s => {
      const h = lms[s === 'R' ? P.LM.R_HEEL : P.LM.L_HEEL];
      const t = lms[s === 'R' ? P.LM.R_TOE : P.LM.L_TOE];
      return { heelY: h.y, len: Math.hypot(t.x - h.x, t.y - h.y) };
    };
    const R = foot('R'), L = foot('L');
    const ref = Math.max(R.len, L.len);
    if (ref < 1e-3) return null;
    const up = s => (this.floorY - s.heelY) / ref;     // heel height above floor, in foot-lengths
    const rUp = up(R), lUp = up(L);
    if (rUp > 0.45 && lUp < 0.2) return 'R';
    if (lUp > 0.45 && rUp < 0.2) return 'L';
    return null;
  }
  setState(s) { this.state = s; this.stateSince = Date.now(); }
  sinceMs() { return Date.now() - this.stateSince; }
  get done() { return this.state === 'DONE'; }
  progress() {
    if (this.state === 'FIND') return 0.05;
    if (this.state === 'PROFILE') return 0.2;
    if (this.state === 'LIFT') return 0.35;
    if (this.state === 'HOLD') return 0.4 + 0.6 * Math.min(1, this.sinceMs() / this.holdMs);
    return 1;
  }
  frame(lms) {
    // arch framing: close-up, floor to the knees — the foot is the subject
    const diag = P.archDiagnose(lms);
    switch (this.state) {
      case 'FIND':
        if (this.coach.feed(diag)) {
          if (!this.visibleSince) this.visibleSince = Date.now();
          this.ui.instr('רואים אותך ✓');
          if (Date.now() - this.visibleSince > 1000) {
            this.setState('PROFILE');
            this.ui.instr(`עמוד בפרופיל — צד ${this.otherName} למצלמה`);
            say(`מסונכרן. עמוד בפרופיל, כשצד ${this.otherName} שלך פונה למצלמה, על שתי הרגליים. ככה רואים את הקשת הפנימית של רגל ${this.name}`, { force: true });
          }
        } else this.visibleSince = 0;
        break;
      case 'PROFILE': {
        if (!lms) break;
        if (P.facing(lms) === 'front' && this.sinceMs() > 5000 && speechIdle()) {
          say(`אתה עדיין מול המצלמה — הסתובב לפרופיל, שצד ${this.otherName} יפנה אליי`, { force: true });
          this.stateSince = Date.now();
          break;
        }
        // two-leg baseline: record the floor line (highest heel y) and the
        // unloaded arch height of BOTH feet — both are grounded now
        this.floorSamples.push(Math.max(lms[P.LM.R_HEEL].y, lms[P.LM.L_HEEL].y));
        for (const s of ['R', 'L']) {
          const a = P.archHeight(lms, s);
          if (a != null) this.baseline.push(a);
        }
        if (this.baseline.length > 60 && this.sinceMs() > 2500 && speechIdle()) {
          const fs = [...this.floorSamples].sort((x, y) => x - y);
          this.floorY = fs[Math.floor(fs.length / 2)];
          this.setState('LIFT');
          this.ui.instr(`הרם את רגל ${this.otherName} — הרגל הקרובה למצלמה`);
          say(`עכשיו הרם את רגל ${this.otherName}, הרגל הקרובה למצלמה, ועמוד על רגל ${this.name} בלבד`, { force: true });
        }
        break;
      }
      case 'LIFT':
        if (!lms) break;
        if (this.liftedLabel(lms) && speechIdle()) {
          this.setState('HOLD');
          say('מצוין. החזק חמש שניות', { force: true });
        } else if (this.sinceMs() > 7000) {
          say(`הרם את רגל ${this.otherName} מהרצפה ועמוד על רגל ${this.name}`, { force: true });
          this.stateSince = Date.now();
        }
        break;
      case 'HOLD': {
        if (!lms) break;
        const lifted = this.liftedLabel(lms);
        if (!lifted) { // foot came down — restart the hold
          this.setState('LIFT');
          this.ui.instr(`הרם את רגל ${this.otherName} והחזק`);
          break;
        }
        // measure the STANDING foot — the one still on the floor line —
        // whose medial arch faces the camera
        const arch = P.archHeight(lms, lifted === 'R' ? 'L' : 'R');
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
  result() {
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
    const base = med(this.baseline), load = med(this.loaded);
    if (!base) return { collapse: 0, frames: this.loaded.length };
    const collapse = Math.round(Math.max(0, Math.min(100, (1 - load / base) * 100)));
    return { collapse, frames: this.loaded.length };
  }
}
