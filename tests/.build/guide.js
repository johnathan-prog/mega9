// guide.js — real-time guidance: voice (Hebrew TTS) + big on-screen text.
// The scan state machines live here; they consume landmark frames and
// decide what to tell the user next. The readiness gate everywhere is
// lowerBodyVisible: floor-to-waist in frame — angles are tracked from the
// moment hips-to-heels are visible, not from a distance estimate.
import * as P from './posemath.js';

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
export const SPEECH_GAP = { ms: 300 };
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
      const done = () => { this.speaking = false; setTimeout(() => this._drain(), SPEECH_GAP.ms); };
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
  constructor(ui) { this.ui = ui; this.lastReason = null; this.lastSpokeAt = 0; this.hist = []; }
  feed(diag) {
    const now = Date.now();
    // majority vote over the last 12 frames: a momentary tracking flicker
    // must not reset the sync or trigger a nag
    this.hist.push(diag.ok ? 1 : 0);
    if (this.hist.length > 12) this.hist.shift();
    const okRatio = this.hist.reduce((a, b) => a + b, 0) / this.hist.length;
    if (okRatio >= 0.5) { this.lastReason = null; return true; }
    if (diag.ok) return false; // bad majority but this frame fine — stay quiet
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

// ---------- walking scan (ankle height) ----------
// Industry-standard protocol (as in commercial smartphone gait analysis):
// the user simply walks back and forth NATURALLY for a fixed recording
// window while every frame's landmarks are recorded; the analysis happens
// AFTERWARD on the whole recording — gait cycles are segmented, angles
// are sampled at single-support instants of the walking-toward segments,
// outlier cycles are discarded, and a minimum cycle count is enforced
// (the recording auto-extends once if too few clean cycles were caught).
// Live voice is used only for setup coaching and start/stop — never to
// choreograph individual steps.
const RECORD_MS = 20000;
const EXTEND_MS = 8000;
export class WalkScan {
  constructor({ ui }) {
    this.ui = ui;
    this.state = 'FIND';
    this.rec = [];               // per-frame recording
    this.t0 = 0;
    this.extended = false;
    this.encouraged = false;
    this.stateSince = Date.now();
    this.visibleSince = 0;
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
    if (this.state === 'FIND') return 0.05;
    if (this.state === 'SYNC') return 0.12;
    if (this.state === 'RECORD') {
      const total = RECORD_MS + (this.extended ? EXTEND_MS : 0);
      return 0.15 + 0.85 * Math.min(1, (Date.now() - this.t0) / total);
    }
    return 1;
  }
  frame(lms) {
    const diag = P.diagnose(lms);
    switch (this.state) {
      case 'FIND':
        if (this.coach.feed(diag)) {
          if (!this.visibleSince) {
            this.visibleSince = Date.now();
            this.ui.instr('רואים אותך ✓');
            say('אני רואה אותך. עמוד רגע במקום', { force: true });
          }
          if (Date.now() - this.visibleSince > 1200)
            this.setState('SYNC', 'מסונכרן ✓', 'מסונכרן');
        } else this.visibleSince = 0;
        break;
      case 'SYNC':
        if (this.sinceMs() > 800 && speechIdle()) {
          this.t0 = Date.now();
          this.setState('RECORD', 'לך הלוך ושוב, טבעי, עד שאגיד עצור',
            'עכשיו פשוט לך הלוך ושוב לאורך החדר, בקצב טבעי שלך. אל תסתכל על הטלפון — אני מקליט ואגיד לך מתי לעצור');
        }
        break;
      case 'RECORD': {
        const el = Date.now() - this.t0;
        // record every trackable frame
        if (lms && diag.ok) {
          this.rec.push({
            t: el,
            sep: this.sep(lms),
            scale: P.legScale(lms) || 0,
            aR: Math.abs(P.achillesDeviation(lms, 'R')),
            aL: Math.abs(P.achillesDeviation(lms, 'L')),
            kR: P.kneeAxis(lms, 'R'),
            kL: P.kneeAxis(lms, 'L'),
          });
        } else if (diag.reason === 'no_person') {
          this.coach.feed(diag); // walked out of frame — call it out
        }
        const total = RECORD_MS + (this.extended ? EXTEND_MS : 0);
        if (!this.encouraged && el > total * 0.5) {
          this.encouraged = true;
          say('מעולה, תמשיך ככה', { force: true });
        }
        this.ui.instr(`מקליט… ${Math.max(0, Math.ceil((total - el) / 1000))} שניות`);
        if (el >= total) {
          const a = analyzeGait(this.rec);
          if (a.cycles < 6 && !this.extended) {
            this.extended = true; this.encouraged = false;
            say('עוד כמה שניות, המשך ללכת הלוך ושוב', { force: true });
          } else {
            say('עצור', { urgent: true });
            this.setState('DONE', 'מעולה! השלב הושלם', 'מעולה, השלב הושלם');
          }
        }
        break;
      }
    }
  }
  sep(lms) {
    const la = lms[P.LM.L_ANKLE], ra = lms[P.LM.R_ANKLE];
    const sc = P.legScale(lms);
    return sc ? Math.hypot(la.x - ra.x, la.y - ra.y) / sc : 0;
  }
  result() {
    const a = analyzeGait(this.rec);
    return { R: a.R, L: a.L, frames: this.rec.length, cycles: a.cycles };
  }
}

// Offline gait analysis over the whole recording:
// 1. smooth the ankle-separation signal;
// 2. keep only walking-toward-camera spans (leg scale rising over ~0.7s);
// 3. single-support instants = local minima of ankle separation (feet
//    passing, full weight on one leg) — the moment the Achilles line and
//    knee axis are clinically read;
// 4. per-instant angle samples → median per foot (outlier-robust),
//    Achilles from the worst-third median (deviation peaks at mid-stance).
function analyzeGait(rec) {
  const empty = { R: { ach: 0, knee: 0 }, L: { ach: 0, knee: 0 }, cycles: 0 };
  if (rec.length < 30) return empty;
  const sm = (arr, k) => arr.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) { s += arr[j]; n++; }
    return s / n;
  });
  const sep = sm(rec.map(f => f.sep), 2);
  const scale = sm(rec.map(f => f.scale), 5);
  const toward = rec.map((_, i) => {
    const j = Math.max(0, i - 10);
    return scale[i] > scale[j] * 1.01;
  });
  // single-support threshold RELATIVE to this recording's own separation
  // range — an absolute constant breaks across stride widths and framings
  const lo = Math.min(...sep), hi = Math.max(...sep);
  const thr = lo + (hi - lo) * 0.3;
  const idx = [];
  for (let i = 3; i < rec.length - 3; i++) {
    if (!toward[i]) continue;
    if (sep[i] <= sep[i - 1] && sep[i] <= sep[i - 2] && sep[i] < sep[i + 1] && sep[i] < sep[i + 2]
        && sep[i] < thr) {
      if (!idx.length || rec[i].t - rec[idx[idx.length - 1]].t > 350) idx.push(i);
    }
  }
  if (idx.length < 3) return empty;
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const worstThird = a => {
    const s = [...a].sort((x, y) => y - x);
    const tail = s.slice(0, Math.max(2, Math.floor(s.length / 3)));
    return med(tail);
  };
  const pick = k => idx.map(i => rec[i][k]);
  return {
    R: { ach: +worstThird(pick('aR')).toFixed(1), knee: +med(pick('kR')).toFixed(1) },
    L: { ach: +worstThird(pick('aL')).toFixed(1), knee: +med(pick('kL')).toFixed(1) },
    cycles: idx.length,
  };
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
