// guide.js — real-time guidance: voice (Hebrew TTS) + big on-screen text.
// The scan state machines live here; they consume landmark frames and
// decide what to tell the user next. The readiness gate everywhere is
// lowerBodyVisible: floor-to-waist in frame — angles are tracked from the
// moment hips-to-heels are visible, not from a distance estimate.
import * as P from './pose.js?v=10';

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
        if (this.sinceMs() > 1000 && speechIdle())
          this.setState('TURN_BACK', 'הסתובב — גב למצלמה', 'עכשיו הסתובב, גב למצלמה');
        break;
      case 'TURN_BACK':
        if (this.sinceMs() > 2500 && speechIdle()) {
          this.walkBase = null; this.reminded = false;
          this.setState('WALK_AWAY', 'לך קדימה — אני אגיד מתי לעצור', 'לך קדימה בקצב רגיל. אני אגיד לך מתי לעצור');
        }
        break;
      case 'WALK_AWAY': {
        // sight-driven stop: the walker's apparent leg scale shrinks as
        // they move away; stop only once they have actually covered ground.
        if (!diag.ok && diag.reason === 'no_person')
          this.coach.feed(diag); // walked out of frame — call it out
        const scale = lms ? P.legScale(lms) : null;
        if (scale) {
          this.walkBase = Math.max(this.walkBase || 0, scale);
          const ratio = scale / this.walkBase;
          if (ratio < 0.72 && this.sinceMs() > 2000) {
            say('עצור', { urgent: true });
            this.setState('STOP', 'עצור', null);
            break;
          }
          if (!this.reminded && this.sinceMs() > 4000 && ratio > 0.93) {
            this.reminded = true;
            say('לך קדימה, תתרחק מהמצלמה', { force: true });
          }
        }
        if (this.sinceMs() > 12000) { // fallback so nobody gets stuck
          say('עצור', { urgent: true });
          this.setState('STOP', 'עצור', null);
        }
        break;
      }
      case 'STOP':
        if (this.sinceMs() > 1200 && speechIdle())
          this.setState('TURN_FACE', 'הסתובב — פנים למצלמה', 'עכשיו הסתובב, פנים למצלמה');
        break;
      case 'TURN_FACE':
        if (this.sinceMs() > 2500 && speechIdle()) {
          this.walkBase = null; this.reminded = false;
          this.setState('WALK_TOWARD', 'לך ישר אל המצלמה', 'לך ישר אל המצלמה, בקצב רגיל, עד שאגיד עצור');
        }
        break;
      case 'WALK_TOWARD': {
        if (lms && diag.ok) this.sampleAngles(lms);
        const scale = lms ? P.legScale(lms) : null;
        if (scale) {
          this.walkBase = Math.min(this.walkBase || Infinity, scale);
          if (!this.reminded && this.sinceMs() > 4000 && scale / this.walkBase < 1.08) {
            this.reminded = true;
            say('המשך ללכת ישר אל המצלמה', { force: true });
          }
        }
        // stop from what the camera sees: heels reached the lower frame,
        // or the walker has clearly closed most of the distance
        const arrived = lms && (P.approachLevel(lms) > 0.9 ||
          (scale && this.walkBase && scale / this.walkBase > 1.6));
        if ((arrived && this.sinceMs() > 2000) || this.sinceMs() > 12000) {
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
    this.stateSince = Date.now();
    this.visibleSince = 0;
    this.coach = new SightCoach(ui);
    this.name = side === 'R' ? 'ימין' : 'שמאל';
    this.otherName = side === 'R' ? 'שמאל' : 'ימין';
    this.ui.instr('התרחק עד שרואים אותך מהרצפה עד המותן');
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
    const diag = P.diagnose(lms, { profile: true });
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
        const arch = P.archHeight(lms, P.standingSide(lms));
        if (arch != null) this.baseline.push(arch);
        if (this.baseline.length > 30 && this.sinceMs() > 2500 && speechIdle()) {
          this.setState('LIFT');
          this.ui.instr(`הרם את רגל ${this.otherName} — הרגל הקרובה למצלמה`);
          say(`עכשיו הרם את רגל ${this.otherName}, הרגל הקרובה למצלמה, ועמוד על רגל ${this.name} בלבד`, { force: true });
        }
        break;
      }
      case 'LIFT':
        if (!lms) break;
        if (P.legLifted(lms) && speechIdle()) {
          this.setState('HOLD');
          say('מצוין. החזק חמש שניות', { force: true });
        } else if (this.sinceMs() > 7000) {
          say(`הרם את רגל ${this.otherName} מהרצפה ועמוד על רגל ${this.name}`, { force: true });
          this.stateSince = Date.now();
        }
        break;
      case 'HOLD': {
        if (!lms) break;
        if (!P.legLifted(lms)) { // foot came down — restart the hold
          this.setState('LIFT');
          this.ui.instr(`הרם את רגל ${this.otherName} והחזק`);
          break;
        }
        const arch = P.archHeight(lms, P.standingSide(lms));
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
