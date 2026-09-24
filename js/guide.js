// guide.js — real-time guidance: voice (Hebrew TTS) + big on-screen text.
// The scan state machines live here; they consume landmark frames and
// decide what to tell the user next.
import * as P from './pose.js?v=2';

let lastSpoken = '', lastSpokenAt = 0;
export function say(text, { force = false } = {}) {
  const now = Date.now();
  if (!force && text === lastSpoken && now - lastSpokenAt < 6000) return;
  lastSpoken = text; lastSpokenAt = now;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'he-IL'; u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* TTS unavailable — screen text still guides */ }
}

// ---------- walking scan (knee / ankle height) ----------
// Guides the user into position, then runs N walk-toward-camera passes,
// sampling Achilles + knee-axis angles only on valid mid-walk frames.
export class WalkScan {
  constructor({ passes = 3, ui }) {
    this.passes = passes; this.ui = ui;
    this.state = 'FIND';
    this.pass = 0;
    this.samples = { R: { ach: [], knee: [] }, L: { ach: [], knee: [] } };
    this.sizeHist = [];
    this.stateSince = Date.now();
  }
  setState(s, instr, speak) {
    if (this.state !== s) { this.state = s; this.stateSince = Date.now(); }
    this.ui.instr(instr);
    if (speak) say(speak);
  }
  get done() { return this.state === 'DONE'; }
  progress() {
    const per = 1 / this.passes;
    const inPass = this.state === 'WALK' ? 0.5 : this.state === 'RETURN' ? 0.85 : 0.1;
    return Math.min(1, this.pass * per + inPass * per);
  }
  frame(lms) {
    if (!lms) { this.setState('FIND', 'התרחק כך שכל הגוף בפריים', 'לא רואים אותך — התרחק מהמצלמה עד שכל הגוף בתמונה'); return; }
    const h = P.personHeight(lms);
    this.sizeHist.push(h); if (this.sizeHist.length > 8) this.sizeHist.shift();
    const trend = this.sizeHist.length > 4
      ? this.sizeHist.at(-1) - this.sizeHist[0] : 0;

    switch (this.state) {
      case 'FIND':
        if (P.legsVisible(lms)) this.setState('POSITION', '', '');
        break;
      case 'POSITION':
        if (h > 0.85) this.setState('POSITION', 'צעד אחורה', 'קרוב מדי — קח כמה צעדים אחורה');
        else if (h < 0.45) this.setState('POSITION', 'צעד קדימה', 'רחוק מדי — התקרב מעט');
        else this.setState('HOLD', 'עצור. עמוד במקום', 'מצוין. עצור ועמוד במקום שנייה');
        break;
      case 'HOLD':
        if (Date.now() - this.stateSince > 1500)
          this.setState('WALK', 'לך ישר אל המצלמה', `מעבר ${this.pass + 1} מתוך ${this.passes}. לך ישר אל המצלמה בקצב רגיל`);
        break;
      case 'WALK':
        // sample only while clearly approaching and legs tracked
        if (P.legsVisible(lms) && trend > 0.002 && h > 0.5 && h < 0.92) {
          for (const side of ['R', 'L']) {
            this.samples[side].ach.push(Math.abs(P.achillesDeviation(lms, side)));
            this.samples[side].knee.push(P.kneeAxis(lms, side));
          }
        }
        if (h >= 0.92)
          this.setState('TURN', 'עצור. הסתובב', 'עצור. עכשיו הסתובב וחזור לנקודת ההתחלה');
        break;
      case 'TURN':
        if (Date.now() - this.stateSince > 2000) this.setState('RETURN', 'חזור לנקודת ההתחלה', '');
        break;
      case 'RETURN':
        if (h < 0.6 && Date.now() - this.stateSince > 2000) {
          this.pass++;
          if (this.pass >= this.passes) {
            this.setState('DONE', 'מעולה! השלב הושלם', 'מעולה, שלב הסריקה הושלם');
          } else {
            this.setState('HOLD', 'עצור. עמוד במקום', 'עצור והסתובב אל המצלמה');
          }
        }
        break;
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
// Profile stance: capture a two-leg baseline arch height, then a loaded
// value while standing on one leg for `holdMs`. Collapse% = relative drop.
export class ArchTest {
  constructor({ side, holdMs = 5000, ui }) {
    this.side = side; this.holdMs = holdMs; this.ui = ui;
    this.state = 'PROFILE';
    this.baseline = []; this.loaded = [];
    this.stateSince = Date.now();
    const name = side === 'R' ? 'ימין' : 'שמאל';
    this.ui.instr(`עמוד בפרופיל, צד ${name} למצלמה`);
    say(`עמוד בפרופיל, כשצד ${name} שלך פונה למצלמה, על שתי הרגליים`);
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
          say(`עכשיו הרם את הרגל השנייה ועמוד על רגל ${name} בלבד. החזק חמש שניות`);
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
          say('יופי, אפשר להוריד את הרגל');
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
