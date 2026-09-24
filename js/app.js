// app.js — flow controller: questionnaire → guided scans → results → pay.
import * as P from './pose.js?v=31';
import { WalkScan, ArchTest, primeTTS } from './guide.js?v=31';
import { classify, LOGIC_LINE } from './engine.js?v=31';

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
            'התרחק כ־3 מטרים, יחף, במכנסיים קצרים — כל הגוף צריך להיכנס לפריים',
            'פשוט תלך הלוך ושוב טבעי כ־20 שניות — ההקלטה מנותחת אוטומטית, מחזורי הליכה נקיים בלבד'] },
];
let stageIdx = 0;
const scanResults = {};
// raw landmark log — the ground truth for offline calibration
const rawLog = [];
// evidence snapshots captured during recording: {t, url}
const snaps = [];
let lastSnapAt = 0;
function captureSnap(video, lms, recT) {
  const now = performance.now();
  if (now - lastSnapAt < 1200 || snaps.length > 40 || !video.videoWidth) return;
  lastSnapAt = now;
  const c = document.createElement('canvas');
  c.width = 270; c.height = 360;
  const x = c.getContext('2d');
  // mirror to match what the user sees on screen
  x.translate(c.width, 0); x.scale(-1, 1);
  x.drawImage(video, 0, 0, c.width, c.height);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.strokeStyle = '#4FE3C1'; x.lineWidth = 3; x.lineCap = 'round';
  const pt = i => [(1 - lms[i].x) * c.width, lms[i].y * c.height];
  for (const [a, b] of [[P.LM.R_HIP, P.LM.R_KNEE], [P.LM.R_KNEE, P.LM.R_ANKLE], [P.LM.R_HEEL, P.LM.R_KNEE],
                        [P.LM.L_HIP, P.LM.L_KNEE], [P.LM.L_KNEE, P.LM.L_ANKLE], [P.LM.L_HEEL, P.LM.L_KNEE]]) {
    const [ax, ay] = pt(a), [bx, by] = pt(b);
    x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke();
  }
  snaps.push({ t: recT, url: c.toDataURL('image/jpeg', 0.6) });
}
function logFrame(stage, lms) {
  if (rawLog.length > 30000) return;
  rawLog.push({ s: stage, t: Math.round(performance.now()),
    l: lms ? lms.map(p => [+p.x.toFixed(3), +p.y.toFixed(3), +(p.visibility ?? 1).toFixed(2)]) : null });
}

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
      logFrame(st.key, lms);
      if (lms && machine.state === 'RECORD' && machine.lastRecT != null)
        captureSnap(video, lms, machine.lastRecT);
      P.drawSkeleton(overlay, lms);
      machine.frame(lms);
      if ((machine._dbgN = (machine._dbgN || 0) + 1) % 10 === 0) {
        const now = performance.now();
        const fps = machine._dbgT ? Math.round(10000 / (now - machine._dbgT)) : 0;
        machine._dbgT = now;
        $('dbgLine').textContent = `v31 · ${fps}fps · ${P.visReport(lms)}`;
      }
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
    R: { ach: walk.R.ach, knee: walk.R.knee, collapse: null },
    L: { ach: walk.L.ach, knee: walk.L.knee, collapse: null },
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
      <div class="metric"><span>אורך × רוחב</span><b>${num(li)} × ${num(wi)} ס״מ</b></div>
      <div class="small">${c.why}</div>`;
    box.appendChild(el);
  });
  $('logicLine').textContent = LOGIC_LINE;
  renderEvidence();
  $('dumpBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ ts: new Date().toISOString(), answers, scanResults, rawLog })],
      { type: 'application/json' });
    const a2 = document.createElement('a');
    a2.href = URL.createObjectURL(blob);
    a2.download = 'solescan-debug.json';
    a2.click();
  };

  const specs = new Set(); [out.R, out.L].forEach(c => c.spec.forEach(s => specs.add(s)));
  const asym = out.R.cls !== out.L.cls;
  $('recSpec').innerHTML =
    `<p style="margin:0 0 8px"><strong>ימין:</strong> ${out.R.name} · <strong>שמאל:</strong> ${out.L.name}${asym ? ' — מפרט נפרד לכל רגל' : ''}</p>
     <ul style="margin:0;padding-right:18px">${[...specs].map(s => `<li>${s}</li>`).join('')}</ul>`;
}

function nearestSnap(t) {
  let best = null, d = Infinity;
  for (const s of snaps) { const dd = Math.abs(s.t - t); if (dd < d) { d = dd; best = s; } }
  return d < 1500 ? best : null;
}
function renderEvidence() {
  const box = $('evidence'); box.innerHTML = '';
  const walk = scanResults.walk || {};
  const picks = [];
  const add = (times, label) => {
    const used = new Set();
    for (const t of times || []) {
      const s = nearestSnap(t);
      if (s && !used.has(s.url)) { used.add(s.url); picks.push({ s, label }); if (used.size >= 2) break; }
    }
  };
  add(walk.achTimes, 'מבט אחורי · קו גיד אכילס');
  add(walk.kneeTimes, 'מבט קדמי · ציר הברך');
  if (!picks.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '<strong>צילומים מרגעי המדידה</strong><div class="evgrid">' +
    picks.map(p => `<figure class="ev"><img src="${p.s.url}" alt=""><figcaption>${p.label}</figcaption></figure>`).join('') +
    '</div><p class="small">הפריימים שנדגמו ברגעי התמיכה על רגל אחת — הבסיס למספרים שלמעלה.</p>';
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
