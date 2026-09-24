// app.js — flow controller: questionnaire → guided scans → results → pay.
import * as P from './pose.js?v=11';
import { WalkScan, ArchTest, primeTTS } from './guide.js?v=11';
import { classify, LOGIC_LINE } from './engine.js?v=11';

const $ = id => document.getElementById(id);
const LABELS = { intro: 'פתיחה', quiz: 'שאלון', setup: 'הכנה', scan: 'סריקה', measure: 'מידות', results: 'תוצאות', pay: 'תשלום', done: 'סיום' };
const ORDER = ['intro', 'quiz', 'setup', 'scan', 'measure', 'results', 'pay', 'done'];
let cur = 'intro';

function go(name) {
  $('s-' + cur).classList.remove('on');
  cur = name;
  $('s-' + cur).classList.add('on');
  $('pbar').style.width = (ORDER.indexOf(name) / (ORDER.length - 1) * 100) + '%';
  $('plabel').textContent = LABELS[name] || '';
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
  const t = b.dataset.go;
  if (t === 'quiz') { qi = 0; renderQ(); }
  go(t);
});

/* ================= questionnaire ================= */
// multi:true questions collect several answers and show a continue button.
const QS = [
  { t: 'איפה כואב לך?', s: 'סמן את כל האזורים הרלוונטיים', multi: true, k: 'pain',
    c: ['עקב / דורבן', 'קשת כף הרגל', 'כרית הבהונות', 'קרסול', 'ברכיים', 'גב תחתון', 'אין כאב — מניעה ונוחות'] },
  { t: 'מתי הכאב מורגש?', s: 'אפשר לסמן כמה', multi: true, k: 'when',
    c: ['בצעדים הראשונים בבוקר', 'אחרי הליכה או עמידה ממושכת', 'בזמן ספורט', 'לאורך כל היום', 'לא רלוונטי'] },
  { t: 'כמה שעות ביום אתה על הרגליים?', s: '', multi: false, k: 'hours',
    c: ['עד 2 שעות', '2–5 שעות', '5–8 שעות', 'מעל 8 שעות'] },
  { t: 'האם אובחנת בעבר?', s: 'סמן כל אבחנה קיימת', multi: true, k: 'dx',
    c: ['פלטפוס', 'קשת גבוהה', 'דורבן / פלנטר פסציאטיס', 'סוכרת', 'לא אובחנתי'] },
  { t: 'לאיזו נעל מיועד המדרס?', s: 'אפשר לסמן כמה', multi: true, k: 'shoe',
    c: ['נעלי ספורט / הליכה', 'נעלי עבודה', 'נעל אלגנטית'] },
];
const answers = {};
let qi = 0;
function renderQ() {
  const q = QS[qi];
  $('qnum').textContent = `שאלה ${qi + 1} מתוך ${QS.length}`;
  $('qtitle').textContent = q.t;
  $('qsub').textContent = q.s;
  const box = $('qchoices'); box.innerHTML = '';
  const sel = new Set();
  // every question advances only via the continue button — no auto-advance
  const next = $('qnext');
  next.hidden = false; next.disabled = true;
  const advance = () => {
    answers[q.k] = [...sel];
    qi++;
    if (qi < QS.length) renderQ();
    else { prepStage(0); }
  };
  const buttons = [];
  q.c.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'choice'; b.textContent = c; b.id = `qc_${q.k}_${i}`;
    b.onclick = () => {
      if (q.multi) {
        sel.has(i) ? sel.delete(i) : sel.add(i);
      } else {
        sel.clear(); sel.add(i);
        buttons.forEach(x => x.classList.remove('sel'));
      }
      b.classList.toggle('sel', sel.has(i));
      next.disabled = sel.size === 0;
    };
    buttons.push(b);
    box.appendChild(b);
  });
  next.onclick = advance;
}

/* ================= scan stages ================= */
const STAGES = [
  { key: 'walk', title: 'סריקת הליכה · גובה קרסול',
    sub: 'המצלמה עוקבת אחרי גיד אכילס, העקב וציר הברך בזמן הליכה.',
    steps: ['הנח את הטלפון יציב בגובה הקרסול (נשען על משהו), מסך אליך',
            'התרחק יחף, במכנסיים קצרים או מופשלים, עד שרואים אותך מהרצפה עד המותן',
            'ההדרכה הקולית מגיבה למה שהמצלמה רואה: הסתובב, לך, עצור, חזור אל המצלמה'] },
  { key: 'archR', title: 'מבחן קריסת קשת · רגל ימין',
    sub: 'עמידה בפרופיל על רגל אחת — מדידת הקשת תחת עומס מלא.',
    steps: ['הטלפון נשאר בגובה קרסול', 'עמוד בפרופיל כשצד שמאל למצלמה — מרימים את שמאל ורואים את הקשת הפנימית של ימין', 'עקוב אחרי ההנחיות הקוליות'] },
  { key: 'archL', title: 'מבחן קריסת קשת · רגל שמאל',
    sub: 'אותו מבחן לרגל שמאל.',
    steps: ['הסתובב — צד ימין למצלמה, מרימים את ימין ורואים את הקשת הפנימית של שמאל', 'עקוב אחרי ההנחיות'] },
];
let stageIdx = 0;
const scanResults = {};

function prepStage(i) {
  stageIdx = i;
  const st = STAGES[i];
  $('setupTitle').textContent = st.title;
  $('setupSub').textContent = st.sub;
  $('setupSteps').innerHTML = st.steps.map((s, n) =>
    `<div class="setup"><span class="n">${n + 1}</span>${s}</div>`).join('');
  go('setup');
}
$('setupStart').onclick = () => {
  primeTTS(); // mobile TTS unlocks only from a user gesture
  runStage(STAGES[stageIdx]);
};

let abortScan = false;
$('scanAbort').onclick = () => { abortScan = true; };

async function runStage(st) {
  go('scan');
  const video = $('cam'), overlay = $('overlay');
  const ui = {
    instr: t => { $('bigInstr').textContent = t; },
    tag: t => { $('scanTag').textContent = t; },
  };
  ui.tag('טוען מנוע זיהוי…'); ui.instr('');
  abortScan = false;
  try {
    await P.initPose();
    ui.tag('מבקש גישה למצלמה…');
    await P.openCamera(video);
  } catch (e) {
    ui.tag('שגיאה');
    $('scanHint').textContent = 'אין גישה למצלמה. ודא שאישרת הרשאה ושאתה גולש ב־HTTPS.';
    return;
  }
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  const machine = st.key === 'archR' ? new ArchTest({ side: 'R', ui })
    : st.key === 'archL' ? new ArchTest({ side: 'L', ui })
    : new WalkScan({ ui });
  ui.tag(st.title);
  $('angleHud').hidden = !(machine instanceof WalkScan);
  $('scanHint').textContent = 'עקוב אחרי ההנחיות על המסך ובקול';

  await new Promise(resolve => {
    const loop = (ts) => {
      if (abortScan) return resolve();
      const lms = P.detect(video, ts ?? performance.now());
      P.drawSkeleton(overlay, lms);
      machine.frame(lms);
      $('scanGauge').style.width = (machine.progress() * 100) + '%';
      if (lms && machine instanceof WalkScan) {
        $('hAch').textContent = ((Math.abs(P.achillesDeviation(lms, 'R')) + Math.abs(P.achillesDeviation(lms, 'L'))) / 2).toFixed(1) + '°';
        $('hKnee').textContent = ((P.kneeAxis(lms, 'R') + P.kneeAxis(lms, 'L')) / 2).toFixed(1) + '°';
      }
      if (machine.done) return resolve();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  P.closeCamera(video);
  speechSynthesis.cancel();
  if (abortScan) { prepStage(stageIdx); return; }

  scanResults[st.key] = machine.result();
  if (stageIdx + 1 < STAGES.length) prepStage(stageIdx + 1);
  else go('measure');
}

/* ================= results ================= */
function num(id) { return parseFloat($(id).value) || 0; }
$('analyzeBtn').onclick = () => {
  const walk = scanResults.walk || { R: { ach: 0, knee: 0 }, L: { ach: 0, knee: 0 } };
  const profile = {
    R: { ach: walk.R.ach, knee: walk.R.knee, collapse: scanResults.archR?.collapse ?? 0 },
    L: { ach: walk.L.ach, knee: walk.L.knee, collapse: scanResults.archL?.collapse ?? 0 },
  };
  renderResults(profile);
  go('results');
};

function renderResults(profile) {
  const box = $('results'); box.innerHTML = '';
  const out = {};
  [['R', 'רגל ימין', 'mRL', 'mRW'], ['L', 'רגל שמאל', 'mLL', 'mLW']].forEach(([k, label, li, wi]) => {
    const f = profile[k], c = classify(f); out[k] = c;
    const cls = v => v ? 'dev' : 'norm';
    const el = document.createElement('div');
    el.className = 'res-foot';
    el.innerHTML = `
      <div class="res-head"><strong>${label}</strong><span class="pill" style="background:${c.color}">${c.name}</span></div>
      <div class="metric"><span>סטיית גיד אכילס מהאנך</span><b class="${cls(f.ach > 3)}">${f.ach}°</b></div>
      <div class="metric"><span>זווית ציר ברך (וולגוס+/וורוס−)</span><b class="${cls(Math.abs(f.knee) > 3)}">${f.knee}°</b></div>
      <div class="metric"><span>קריסת קשת בהעמסה</span><b class="${cls(f.collapse > 37)}">${f.collapse}%</b></div>
      <div class="metric"><span>אורך × רוחב</span><b>${num(li)} × ${num(wi)} ס״מ</b></div>
      <div class="small">${c.why}</div>`;
    box.appendChild(el);
  });
  $('logicLine').textContent = LOGIC_LINE;

  const specs = new Set(); [out.R, out.L].forEach(c => c.spec.forEach(s => specs.add(s)));
  const asym = out.R.cls !== out.L.cls;
  $('recSpec').innerHTML =
    `<p style="margin:0 0 8px"><strong>ימין:</strong> ${out.R.name} · <strong>שמאל:</strong> ${out.L.name}${asym ? ' — מפרט נפרד לכל רגל' : ''}</p>
     <ul style="margin:0;padding-right:18px">${[...specs].map(s => `<li>${s}</li>`).join('')}</ul>`;
}

/* ================= payment ================= */
// Production: replace with the PSP's hosted page / iframe (Grow, Tranzila,
// Stripe). The order payload below is what the backend receives.
$('payBtn').onclick = () => {
  const order = {
    ts: new Date().toISOString(),
    answers,
    scan: scanResults,
    measurements: { R: [num('mRL'), num('mRW')], L: [num('mLL'), num('mLW')] },
  };
  console.log('ORDER PAYLOAD', order);
  go('done');
};

/* ================= boot ================= */
(function boot() {
  const bad = [];
  if (!navigator.mediaDevices?.getUserMedia) bad.push('מצלמה');
  if (!('speechSynthesis' in window)) bad.push('הנחיה קולית');
  $('compatNote').textContent = bad.length
    ? `שים לב: הדפדפן הזה לא תומך ב: ${bad.join(', ')}. פתח בכרום או ספארי בטלפון.`
    : 'הסריקה משתמשת במצלמה ובהנחיה קולית — פתח בטלפון, באור טוב.';
})();
