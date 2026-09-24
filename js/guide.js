// guide.js — real-time guidance: voice (Hebrew TTS) + big on-screen text.
// The scan state machines live here; they consume landmark frames and
// decide what to tell the user next.
import * as P from './pose.js?v=3';

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

// ---------- step counter ----------
// Counts steps from the horizontal ankle-separation oscillation: each
// stride swings the ankles apart and back. A peak above threshold with a
// minimum interval = one step.
class StepCounter {
  constructor() { this.prev = 0; this.rising = false; this.steps = 0; this.lastStepAt = 0; }
  feed(lms) {
    const la = lms[P.LM.L_ANKLE], ra = lms[P.LM.R_ANKLE];
    const sep = Math.hypot(la.x - ra.x, la.y - ra.y);
    const now = Date.now();
    if (sep > this.prev + 0.002) this.rising = true;
    else if (this.rising && sep < this.prev - 0.002 && this.prev > 0.045
             && now - this.lastStepAt > 350) {
      this.steps++; this.lastStepAt = now; this.rising = false;
    }
    this.prev = sep;
    return this.steps;
  }
  reset() { this.steps = 0; this.rising = false; this.lastStepAt = 0; }
}

// ---------- walking scan (knee / ankle height) ----------
// The exact protocol:
//   sync facing the camera → turn (back to camera) → 5 steps forward →
//   stop → turn (face the camera) → 5 steps forward (toward the camera).
// Angles are sampled on the walk-toward-camera leg of the pass.
export class WalkScan {
  constructor({ steps = 5, ui }) {
    this.stepsTarget = steps; this.ui = ui;
    this.state = 'FIND';
    this.samples = { R: { ach: [], knee: [] }, L: { ach: [], knee: [] } };
    this.counter = new StepCounter();
    this.sizeHist = [];
    this.stateSince = Date.now();
    this.ui.instr('עמוד מול המצלמה');
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
    const map = { FIND: .02, SYNC: .1, TURN_BACK: .2, WALK_AWAY: .35, STOP: .55, TURN_FACE: .65, WALK_TOWARD: .8, DONE: 1 };
    let p = map[this.state] ?? 0;
    if (this.state === 'WALK_AWAY') p = .25 + .3 * (this.counter.steps / this.stepsTarget);
    if (this.state === 'WALK_TOWARD') p = .7 + .3 * (this.counter.steps / this.stepsTarget);
    return Math.min(1, p);
  }
  frame(lms) {
    if (!lms) {
      if (this.state === 'FIND' || this.state === 'SYNC')
        this.setState('FIND', 'עמוד מול המצלמה, שכל הגוף ייראה', 'עמוד מול המצלמה כך שכל הגוף נראה בתמונה');
      return;
    }
    const h = P.personHeight(lms);
    this.sizeHist.push(h); if (this.sizeHist.length > 10) this.sizeHist.shift();

    switch (this.state) {
      case 'FIND':
        if (P.legsVisible(lms)) this.setState('SYNC', 'עמוד מול המצלמה — מסנכרן…', 'מצוין. עמוד ישר מול המצלמה, פנים למצלמה');
        break;
      case 'SYNC':
        if (!P.legsVisible(lms)) { this.setState('FIND', 'עמוד מול המצלמה, שכל הגוף ייראה'); break; }
        if (h > 0.9) this.setState('SYNC', 'צעד אחורה', 'קרוב מדי — קח צעד אחורה');
        else if (this.sinceMs() > 2000) {
          this.counter.reset();
          this.setState('TURN_BACK', 'הסתובב — גב למצלמה', 'מסונכרן! עכשיו הסתובב, גב למצלמה');
        }
        break;
      case 'TURN_BACK':
        if (this.sinceMs() > 3000) {
          this.counter.reset();
          this.setState('WALK_AWAY', 'קח 5 צעדים קדימה', 'קח חמישה צעדים קדימה');
        }
        break;
      case 'WALK_AWAY': {
        const n = this.counter.feed(lms);
        this.ui.instr(`צעד ${Math.min(n, this.stepsTarget)} מתוך ${this.stepsTarget}`);
        if (n >= this.stepsTarget || h < 0.35)
          this.setState('STOP', 'עצור', 'עצור');
        break;
      }
      case 'STOP':
        if (this.sinceMs() > 1500)
          this.setState('TURN_FACE', 'הסתובב — פנים למצלמה', 'עכשיו הסתובב, פנים למצלמה');
        break;
      case 'TURN_FACE':
        if (this.sinceMs() > 3000) {
          this.counter.reset();
          this.setState('WALK_TOWARD', 'קח 5 צעדים אל המצלמה', 'קח חמישה צעדים קדימה, ישר אל המצלמה, בקצב רגיל');
        }
        break;
      case 'WALK_TOWARD': {
        // the measurement leg: sample while approaching with legs tracked
        if (P.legsVisible(lms)) {
          for (const side of ['R', 'L']) {
            this.samples[side].ach.push(Math.abs(P.achillesDeviation(lms, side)));
            this.samples[side].knee.push(P.kneeAxis(lms, side));
          }
        }
        const n = this.counter.feed(lms);
        this.ui.instr(`צעד ${Math.min(n, this.stepsTarget)} מתוך ${this.stepsTarget}`);
        if (n >= this.stepsTarget || h > 0.92)
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
// Profile stance at ankle height: capture a two-leg baseline arch height,
// then a loaded value while standing on one leg for `holdMs`.
export class ArchTest {
  constructor({ side, holdMs = 5000, ui }) {
    this.side = side; this.holdMs = holdMs; this.ui = ui;
    this.state = 'PROFILE';
    this.baseline = []; this.loaded = [];
    this.stateSince = Date.now();
    const name = side === 'R' ? 'ימין' : 'שמאל';
    this.ui.instr(`עמוד בפרופיל, צד ${name} למצלמה`);
    say(`עמוד בפרופיל, כשצד ${name} שלך פונה למצלמה, על שתי הרגליים`, { force: true });
  }
  setState(s) { this.state = s; this.stateSince = Date.now(); }
  get done() { return this.state === 'DONE'; }
  progress() {
    if (this.state === 'PROFILE') return 0.15;
    if (this.state === 'LIFT') return 0.35;
    if (this.state === 'HOLD') return 0.4 + 0.6 * Math.min(1, (Date.now() - this.stateSince) / this.holdMs);
    return 1;
  }
  frame(lms) {
    if (!lms) { this.ui.instr('לא רואים אותך — הישאר בפריים'); return; }
    const arch = P.archHeight(lms, this.side);
    switch (this.state) {
      case 'PROFILE':
        if (arch != null) this.baseline.push(arch);
        if (this.baseline.length > 30 && Date.now() - this.stateSince > 2500) {
          this.setState('LIFT');
          const name = this.side === 'R' ? 'ימין' : 'שמאל';
          this.ui.instr(`עכשיו עמוד על רגל ${name} בלבד`);
          say(`עכשיו הרם את הרגל השנייה ועמוד על רגל ${name} בלבד. החזק חמש שניות`, { force: true });
        }
        break;
      case 'LIFT':
        if (Date.now() - this.stateSince > 1500) { this.setState('HOLD'); this.ui.instr('החזק…'); }
        break;
      case 'HOLD': {
        if (arch != null) this.loaded.push(arch);
        const left = Math.ceil((this.holdMs - (Date.now() - this.stateSince)) / 1000);
        this.ui.instr(left > 0 ? String(left) : '✓');
        if (Date.now() - this.stateSince >= this.holdMs) {
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
