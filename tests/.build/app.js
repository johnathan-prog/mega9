// app.js — flow controller: questionnaire → guided scans → results → pay.
import * as P from './pose.js';
import { WalkScan, ArchTest, primeTTS } from './guide.js';
import { classify, LOGIC_LINE } from './engine.js';

const $ = id => document.getElementById(id);
const LABELS = { intro: 'פתיחה', quiz: 'שאלון', details: 'פרטים', setup: 'הכנה', scan: 'סריקה', analyzing: 'ניתוח', results: 'הדוח שלך' };
const ORDER = ['intro', 'quiz', 'details', 'setup', 'scan', 'analyzing', 'results'];
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
    else go('details');
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
  if (now - lastSnapAt < 500 || snaps.length > 80 || !video.videoWidth) return;
  lastSnapAt = now;
  const c = document.createElement('canvas');
  c.width = 270; c.height = 360;
  const x = c.getContext('2d');
  // mirror to match what the user sees on screen, cover-cropped so the
  // photo keeps its true proportions instead of stretching
  const va = video.videoWidth / video.videoHeight, ca = c.width / c.height;
  let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
  if (va > ca) { sw = sh * ca; sx = (video.videoWidth - sw) / 2; }
  else { sh = sw / ca; sy = (video.videoHeight - sh) / 2; }
  x.translate(c.width, 0); x.scale(-1, 1);
  x.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
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
function logFrame(stage, lms, recT) {
  if (rawLog.length > 30000) return;
  rawLog.push({ s: stage, t: Math.round(performance.now()), rt: recT ?? null,
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
/* ---- phone sensors: placement detection + live height meter ---- */
const sensor = { supported: false, still: false, tiltOk: false, drop: 0 };
let accWin = [];
function startSensors() {
  const onMotion = e => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return; // headless/emulated events carry nulls
    sensor.supported = true;
    const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    accWin.push({ t: Date.now(), mag });
    while (accWin.length && Date.now() - accWin[0].t > 700) accWin.shift();
    const mags = accWin.map(m => m.mag);
    const jitter = Math.max(...mags) - Math.min(...mags);
    sensor.still = accWin.length > 8 && jitter < 0.6;
    const lin = e.acceleration;
    if (lin && lin.y != null) {
      sensor.drop = Math.max(0, Math.min(1, sensor.drop + (lin.y > 1.2 ? 0.06 : lin.y < -1.2 ? -0.02 : -0.005)));
    }
  };
  const onOrient = e => {
    if (e.beta == null) return; // headless/emulated events carry nulls
    sensor.supported = true;
    // propped upright-ish, leaning back slightly
    sensor.tiltOk = e.beta > 50 && e.beta < 95;
  };
  window.addEventListener('devicemotion', onMotion);
  window.addEventListener('deviceorientation', onOrient);
}
async function askMotionPermission() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission)
      await DeviceMotionEvent.requestPermission();
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission)
      await DeviceOrientationEvent.requestPermission();
  } catch { /* denied — the place stage will auto-skip */ }
}

$('setupStart').onclick = async () => {
  primeTTS(); // mobile TTS unlocks only from a user gesture
  initAudio(); // scanner sounds unlock on the same gesture
  await askMotionPermission();
  startSensors();
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
    P.initSegmenter(); // loads in the background; aura appears when ready
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
    : new WalkScan({ ui, place: true });
  ui.tag(st.title);
  $('angleHud').hidden = !(machine instanceof WalkScan);
  $('scanHint').textContent = 'עקוב אחרי ההנחיות על המסך ובקול';

  await new Promise(resolve => {
    const loop = (ts) => {
      if (abortScan) return resolve();
      const now2 = ts ?? performance.now();
      const lms = P.detect(video, now2);
      const drawLms = smoothForDisplay(lms);
      machine.sensor = sensor;
      updateHeightMeter(machine.state);
      logFrame(st.key, lms, machine.lastRecT);
      if (lms && machine.state === 'RECORD') feedStepPulse(lms);
      if (lms && machine.state === 'RECORD' && machine.lastRecT != null)
        captureSnap(video, lms, machine.lastRecT);
      // layered rendering: aura always (its data is per-pixel and cannot
      // jitter), measurement lines only while tracking is genuinely stable
      const octx = overlay.getContext('2d');
      octx.clearRect(0, 0, overlay.width, overlay.height);
      drawAura(overlay, video, now2);
      drawFootFlash(overlay);
      const la = lineAlpha(lms);
      if (la > 0.02 && drawLms) {
        octx.save(); octx.globalAlpha = la;
        P.drawSkeleton(overlay, drawLms, { clear: false });
        drawLiveAngles(overlay, drawLms);
        octx.restore();
      }
      if (machine.state === 'FIND' || machine.state === 'SYNC') drawSilhouette(overlay);
      updateDistLight(lms, machine.state);
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
  if (stageIdx + 1 < STAGES.length) { prepStage(stageIdx + 1); return; }
  const walk = scanResults.walk || { R: null, L: null };
  const profile = {
    R: walk.R ? { ...walk.R, collapse: null } : { ach: null, knee: null, collapse: null },
    L: walk.L ? { ...walk.L, collapse: null } : { ach: null, knee: null, collapse: null },
  };
  playAnalyzing(walk, () => { renderResults(profile); go('results'); });
}

/* ================= results ================= */
function num(id) { return parseFloat($(id).value) || 0; }


function renderResults(profile) {
  const box = $('results'); box.innerHTML = '';
  const out = {};
  [['R', 'רגל ימין', 'mRL', 'mRW'], ['L', 'רגל שמאל', 'mLL', 'mLW']].forEach(([k, label, li, wi]) => {
    const f = profile[k], c = classify(f); out[k] = c;
    const cls = v => v ? 'dev' : 'norm';
    const el = document.createElement('div');
    el.className = 'res-foot';
    el.innerHTML = c.cls === 'pending'
      ? `<div class="res-head"><strong>${label}</strong><span class="pill" style="background:${c.color}">${c.name}</span></div>
         <p class="plain">${c.plain}</p>`
      : `<div class="res-head"><strong>${label}</strong><span class="pill" style="background:${c.color}">${c.name}</span></div>
         <p class="plain">${c.plain}</p>
         ${gauge('קו העקב בדריכה', f.ach, 0, 10, [[0, 3, 'var(--ok)'], [3, 6, 'var(--low)'], [6, 10, 'var(--flat)']],
           'ישר', 'קורס פנימה')}
         <details class="small"><summary>הפירוט המקצועי</summary>
           סטיית גיד אכילס: ${f.ach}° · ציר ברך: ${f.knee}°<br>${c.why}</details>`;
    box.appendChild(el);
  });
  [...box.children].forEach((el, i) => { el.style.animationDelay = (i * 0.25) + 's'; });
  $('logicLine').textContent = LOGIC_LINE;
  renderOfficialReport(profile);
  renderEvidence();
  animateGauges();
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

/* ---- layer 1: body aura + scanline (per-pixel, jitter-free) ---- */
// Temporal blending of consecutive masks gives a silky, flowing contour;
// buffers are allocated once and reused (no per-frame GC churn); the
// glow "breathes", and a step pulse flashes the aura on every footstrike.
const auraState = { fresh: null, blendA: null, blendB: null, ring: null,
  img: null, haveMask: false, frame: 0 };
let stepFlash = 0;
function ensureCanvas(key, w, h) {
  let c = auraState[key];
  if (!c) { c = document.createElement('canvas'); auraState[key] = c; }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}
function drawAura(overlay, video, ts) {
  auraState.frame++;
  if (auraState.frame % 2 === 0) {
    const seg = P.segment(video, ts);
    if (seg) {
      const fc = ensureCanvas('fresh', seg.w, seg.h);
      const fx = fc.getContext('2d');
      if (!auraState.img || auraState.img.width !== seg.w || auraState.img.height !== seg.h)
        auraState.img = fx.createImageData(seg.w, seg.h);
      const px = auraState.img.data;
      for (let i = 0; i < seg.data.length; i++) {
        const on = seg.data[i] === 0 ? 255 : 0;
        const j = i * 4;
        px[j] = 79; px[j + 1] = 227; px[j + 2] = 193; px[j + 3] = on;
      }
      fx.putImageData(auraState.img, 0, 0);
      // temporal blend: 35% previous + 65% fresh → flowing silky edge
      const a = ensureCanvas('blendA', seg.w, seg.h);
      const b = ensureCanvas('blendB', seg.w, seg.h);
      const bx = b.getContext('2d');
      bx.clearRect(0, 0, b.width, b.height);
      bx.globalAlpha = 0.35; bx.drawImage(a, 0, 0);
      bx.globalAlpha = 0.75; bx.drawImage(fc, 0, 0);
      bx.globalAlpha = 1;
      auraState.blendA = b; auraState.blendB = a; // swap
      auraState.haveMask = true;
    }
  }
  if (!auraState.haveMask) return;
  const mc = auraState.blendA;
  const rc = ensureCanvas('ring', overlay.width, overlay.height);
  const rx = rc.getContext('2d');
  rx.clearRect(0, 0, rc.width, rc.height);
  // outer glow ring: blurred silhouette minus a softly-edged silhouette
  rx.filter = 'blur(9px)';
  rx.drawImage(mc, 0, 0, rc.width, rc.height);
  rx.filter = 'blur(1.5px)';
  rx.globalCompositeOperation = 'destination-out';
  rx.drawImage(mc, 0, 0, rc.width, rc.height);
  rx.filter = 'none';
  rx.globalCompositeOperation = 'source-over';
  const octx = overlay.getContext('2d');
  octx.save();
  // breathing glow + footstrike flash
  octx.globalAlpha = Math.min(1, 0.7 + 0.18 * Math.sin(performance.now() / 900) + stepFlash * 0.6);
  octx.drawImage(rc, 0, 0);
  // scanline clipped to the body
  rx.clearRect(0, 0, rc.width, rc.height);
  rx.filter = 'blur(1.5px)';
  rx.drawImage(mc, 0, 0, rc.width, rc.height);
  rx.filter = 'none';
  rx.globalCompositeOperation = 'source-in';
  const y = (performance.now() / 1800 % 1) * rc.height;
  const grad = rx.createLinearGradient(0, y - 26, 0, y + 26);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  rx.fillStyle = grad;
  rx.fillRect(0, y - 26, rc.width, 52);
  rx.globalCompositeOperation = 'source-over';
  octx.globalAlpha = 1;
  octx.drawImage(rc, 0, 0);
  octx.restore();
  stepFlash *= 0.85;
}

/* ---- live footstrike pulse + scanner sound ---- */
// Embedded scanner sounds as plain <audio> — WebAudio on iOS gets
// permanently interrupted by speech synthesis, HTMLAudio does not.
const TICK_SRC = 'data:audio/wav;base64,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';
const LOCK_SRC = 'data:audio/wav;base64,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';
let tickEl = null, lockEl = null;
function initAudio() {
  try {
    tickEl = new Audio(TICK_SRC); lockEl = new Audio(LOCK_SRC);
    tickEl.volume = 0.9; lockEl.volume = 0.8;
    // unlock both on the user gesture
    for (const el of [tickEl, lockEl]) {
      el.muted = true;
      el.play().then(() => { el.pause(); el.currentTime = 0; el.muted = false; })
        .catch(() => { el.muted = false; });
    }
  } catch { tickEl = lockEl = null; }
}
function playTick() {
  try { if (tickEl) { tickEl.currentTime = 0; tickEl.play().catch(() => {}); } } catch {}
}
function playLock() {
  try { if (lockEl) { lockEl.currentTime = 0; lockEl.play().catch(() => {}); } } catch {}
}
function beep(freq, dur, gainV, freq2) { freq2 ? playLock() : playTick(); }

const pulse = { smooth: null, dir: 0, lastAt: 0 };
let footFlash = null; // {x, y, at} — burst drawn on the striking heel
function feedStepPulse(lms) {
  if (!lms) return;
  const scl = P.legScale(lms);
  if (!scl) return;
  const la = lms[P.LM.L_ANKLE], ra = lms[P.LM.R_ANKLE];
  const sep = Math.hypot(la.x - ra.x, la.y - ra.y) / scl;
  if (pulse.smooth == null) { pulse.smooth = sep; return; }
  const prev = pulse.smooth;
  pulse.smooth = prev * 0.55 + sep * 0.45;
  if (pulse.smooth > prev + 0.004) pulse.dir = 1;
  else if (pulse.smooth < prev - 0.004 && pulse.dir === 1) {
    if (prev > 0.13 && Date.now() - pulse.lastAt > 300) {
      pulse.lastAt = Date.now();
      // the landing (front) foot sits lower in the frame — flash ITS heel
      const rh = lms[P.LM.R_HEEL], lh = lms[P.LM.L_HEEL];
      const heel = rh.y >= lh.y ? rh : lh;
      footFlash = { x: heel.x, y: heel.y, at: performance.now() };
      stepFlash = 0.5;               // gentle aura bump
      beep(1250, 0.06, 0.18);        // scanner tick
    }
    pulse.dir = -1;
  }
}
// expanding light ring on the heel that just struck the ground
function drawFootFlash(canvas) {
  if (!footFlash) return;
  const age = performance.now() - footFlash.at;
  if (age > 380) { footFlash = null; return; }
  const x = canvas.getContext('2d');
  const cx = footFlash.x * canvas.width, cy = footFlash.y * canvas.height;
  const p = age / 380;
  const r = 12 + p * 46;
  x.save();
  x.globalAlpha = (1 - p) * 0.9;
  x.strokeStyle = '#FFD166'; x.lineWidth = 4 * (1 - p) + 1;
  x.shadowColor = '#FFD166'; x.shadowBlur = 16;
  x.beginPath(); x.arc(cx, cy, r, 0, 7); x.stroke();
  x.beginPath(); x.arc(cx, cy, r * 0.55, 0, 7); x.stroke();
  x.restore();
}

/* ---- layer 2 gate: lines earn their place with sustained confidence ---- */
let stableFrames = 0, shownAlpha = 0;
function lineAlpha(lms) {
  let conf = 0;
  if (lms) {
    const ids = [P.LM.R_KNEE, P.LM.L_KNEE, P.LM.R_ANKLE, P.LM.L_ANKLE, P.LM.R_HEEL, P.LM.L_HEEL];
    conf = ids.reduce((a, i) => a + (lms[i].visibility ?? 0), 0) / ids.length;
  }
  if (conf > 0.55) stableFrames++;
  else if (conf < 0.35) stableFrames = 0;
  const target = stableFrames > 12 ? 1 : 0;   // ~0.5s of proven stability
  if (target === 1 && shownAlpha < 0.1) beep(620, 0.14, 0.15, 940); // lock-on
  shownAlpha += (target - shownAlpha) * 0.12; // soft fade in/out
  return shownAlpha;
}

// Display-only exponential smoothing: the drawn lines sit calmly on the
// body while the ANALYSIS still consumes the raw landmark stream.
let smoothState = null, smoothSeenAt = 0;
function smoothForDisplay(lms) {
  const now = performance.now();
  if (!lms) {
    // hold the last pose through momentary dropouts instead of resetting —
    // resets are exactly what read as random jumps
    if (smoothState && now - smoothSeenAt < 400) return smoothState;
    smoothState = null; return null;
  }
  smoothSeenAt = now;
  if (!smoothState) { smoothState = lms.map(p => ({ ...p })); return smoothState; }
  for (let i = 0; i < lms.length; i++) {
    const s = smoothState[i], p = lms[i];
    // adaptive: heavy damping at rest, responsive under real movement
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    const a = Math.min(0.6, 0.08 + d * 8);
    s.x += (p.x - s.x) * a;
    s.y += (p.y - s.y) * a;
    s.visibility = p.visibility;
  }
  return smoothState;
}

// the live "technology mirror": heel lines + degree readouts on the body
function drawLiveAngles(canvas, lms) {
  const x = canvas.getContext('2d');
  const pt = i => [lms[i].x * canvas.width, lms[i].y * canvas.height];
  x.lineCap = 'round';
  for (const side of ['R', 'L']) {
    const HEEL = side === 'R' ? P.LM.R_HEEL : P.LM.L_HEEL;
    const KNEE = side === 'R' ? P.LM.R_KNEE : P.LM.L_KNEE;
    if ((lms[HEEL].visibility ?? 1) < 0.15) continue;
    const [hx, hy] = pt(HEEL), [kx, ky] = pt(KNEE);
    x.strokeStyle = '#FFD166'; x.lineWidth = 4;
    x.beginPath(); x.moveTo(hx, hy); x.lineTo(kx, ky); x.stroke();
    x.setLineDash([6, 6]); x.strokeStyle = 'rgba(255,255,255,.6)'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(hx, hy); x.lineTo(hx, hy - Math.hypot(kx - hx, ky - hy)); x.stroke();
    x.setLineDash([]);
    const a = Math.abs(P.achillesDeviation(lms, side)).toFixed(0);
    x.font = '700 22px Assistant, sans-serif';
    x.fillStyle = '#FFD166';
    x.save(); x.translate(hx, hy + 26); x.scale(-1, 1); x.fillText(a + '°', -14, 0); x.restore();
  }
}

// positioning silhouette: fit yourself inside the dashed figure
function drawSilhouette(canvas) {
  const x = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, cx = w / 2;
  x.setLineDash([8, 8]); x.strokeStyle = 'rgba(79,227,193,.8)'; x.lineWidth = 3;
  x.beginPath(); x.arc(cx, h * 0.16, h * 0.05, 0, 7); x.stroke();
  x.beginPath();
  x.moveTo(cx - w * 0.13, h * 0.26); x.lineTo(cx + w * 0.13, h * 0.26);
  x.lineTo(cx + w * 0.10, h * 0.55); x.lineTo(cx + w * 0.08, h * 0.93);
  x.moveTo(cx - w * 0.13, h * 0.26); x.lineTo(cx - w * 0.10, h * 0.55); x.lineTo(cx - w * 0.08, h * 0.93);
  x.stroke(); x.setLineDash([]);
}

// live distance traffic light — the customer never estimates meters
function updateDistLight(lms, state) {
  const el = $('distLight');
  if (state === 'DONE') { el.hidden = true; return; }
  el.hidden = false;
  const sc = lms ? P.legScale(lms) : 0;
  if (!lms) { el.className = 'dist'; el.textContent = 'מחפש אותך…'; }
  else if (sc > 0.78) { el.className = 'dist warn'; el.textContent = 'קרוב מדי — התרחק'; }
  else if (!P.diagnose(lms).ok) { el.className = 'dist'; el.textContent = 'כל הגוף בפריים…'; }
  else { el.className = 'dist good'; el.textContent = 'מרחק מצוין'; }
}

// live height meter: the phone icon slides down as the device is lowered
function updateHeightMeter(state) {
  const el = $('heightMeter');
  if (state !== 'PLACE' || !sensor.supported) { el.hidden = true; return; }
  el.hidden = false;
  const dot = $('heightDot');
  const pct = sensor.still && sensor.tiltOk ? 100 : sensor.drop * 100;
  dot.style.top = `calc(${Math.min(100, pct)}% - 12px)`;
  dot.classList.toggle('ok', sensor.still && sensor.tiltOk);
}

function nearestSnap(t) {
  let best = null, d = Infinity;
  for (const s of snaps) { const dd = Math.abs(s.t - t); if (dd < d) { d = dd; best = s; } }
  return d < 1500 ? best : null;
}
// slow-motion replay of the customer's own measurement instants: their
// photo behind, the skeleton and heel line with a degree counter on top.
let replayTimer = null;
function renderEvidence() {
  const card = $('replayCard'), cv = $('replay');
  const walk = scanResults.walk || {};
  const moments = [];
  const collect = ms => {
    for (const m0 of (ms || []).slice(0, 3)) {
      const frames = rawLog.filter(f => f.l && f.rt != null && Math.abs(f.rt - m0.t) < 500);
      if (frames.length > 4) {
        const label = m0.dir === 'back'
          ? 'מבט אחורי — קו העקב שלך'
          : 'מבט קדמי — ציר הברך והשוק שלך';
        moments.push({ frames, label, snap: nearestSnap(m0.t) });
      }
    }
  };
  collect(walk.achMoments);
  collect(walk.kneeMoments);
  if (!moments.length) { card.hidden = true; return; }
  card.hidden = false;
  const x = cv.getContext('2d');
  const imgs = new Map();
  for (const m of moments) if (m.snap && !imgs.has(m.snap.url)) {
    const im = new Image(); im.src = m.snap.url; imgs.set(m.snap.url, im);
  }
  let mi = 0, fi = 0;
  clearInterval(replayTimer);
  replayTimer = setInterval(() => {
    const m = moments[mi];
    const f = m.frames[fi];
    const lms = f.l.map(a => ({ x: a[0], y: a[1], visibility: a[2] }));
    x.fillStyle = '#0B1416'; x.fillRect(0, 0, cv.width, cv.height);
    const im = m.snap && imgs.get(m.snap.url);
    if (im && im.complete) { x.globalAlpha = 0.55; x.drawImage(im, 0, 0, cv.width, cv.height); x.globalAlpha = 1; }
    const pt = i => [(1 - lms[i].x) * cv.width, lms[i].y * cv.height];
    x.strokeStyle = '#4FE3C1'; x.lineWidth = 3; x.lineCap = 'round';
    for (const [a, b] of [[P.LM.R_HIP, P.LM.R_KNEE], [P.LM.R_KNEE, P.LM.R_ANKLE],
                          [P.LM.L_HIP, P.LM.L_KNEE], [P.LM.L_KNEE, P.LM.L_ANKLE]]) {
      const [ax, ay] = pt(a), [bx, by] = pt(b);
      x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke();
    }
    let maxDev = 0;
    for (const side of ['R', 'L']) {
      const HEEL = side === 'R' ? P.LM.R_HEEL : P.LM.L_HEEL;
      const KNEE = side === 'R' ? P.LM.R_KNEE : P.LM.L_KNEE;
      const [hx, hy] = pt(HEEL), [kx, ky] = pt(KNEE);
      const len = Math.hypot(kx - hx, ky - hy);
      // reference line with a dark halo so it reads on any background
      x.setLineDash([6, 6]);
      x.strokeStyle = 'rgba(0,0,0,.7)'; x.lineWidth = 5;
      x.beginPath(); x.moveTo(hx, hy); x.lineTo(hx, hy - len); x.stroke();
      x.strokeStyle = '#FFFFFF'; x.lineWidth = 2.5;
      x.beginPath(); x.moveTo(hx, hy); x.lineTo(hx, hy - len); x.stroke();
      x.setLineDash([]);
      x.strokeStyle = '#FFD166'; x.lineWidth = 4;
      x.beginPath(); x.moveTo(hx, hy); x.lineTo(kx, ky); x.stroke();
      const dev = Math.abs(P.achillesDeviation(lms, side));
      maxDev = Math.max(maxDev, dev);
      x.font = '700 20px Assistant, sans-serif'; x.fillStyle = '#FFD166';
      x.fillText(dev.toFixed(0) + '°', hx + 8, hy - 8);
    }
    $('replayCaption').textContent = m.label + (maxDev < 2.5
      ? ' · הקווים חופפים — דריכה ישרה'
      : ' · צהוב: קו העקב שלך · לבן מקווקו: היעד הישר');
    fi++;
    if (fi >= m.frames.length) { fi = 0; mi = (mi + 1) % moments.length; }
  }, 140); // slow motion
}

// horizontal gauge: colored zones + a marker where this foot measured
function gauge(label, val, min, max, zones, loLabel, hiLabel) {
  const pct = v => ((Math.min(max, Math.max(min, v)) - min) / (max - min) * 100).toFixed(1);
  const zoneDivs = zones.map(([a, b, col]) =>
    `<i style="right:${pct(a)}%;width:${(pct(b) - pct(a)).toFixed(1)}%;background:${col}"></i>`).join('');
  return `<div class="gaugebox"><div class="glabel"><span>${label}</span><b>${val}°</b></div>
    <div class="gtrack">${zoneDivs}<u style="right:calc(${pct(val)}% - 7px)"></u></div>
    <div class="gends"><span>${loLabel}</span><span>${hiLabel}</span></div></div>`;
}

/* ---- report dramatization: real-number analysis reveal ---- */
function playAnalyzing(walk, done) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lines = [
    `מנתח ${rawLog.filter(f => f.l).length} פריימים של תנועה`,
    `זוהו ${walk.cycles || 0} מחזורי הליכה`,
    walk.R ? `נמדדו זוויות עקב: ימין ${walk.R.ach}° · שמאל ${walk.L.ach}°` : 'מעביר את הצילומים לבחינת המומחה',
    'מרכיב את הדוח האישי שלך…',
  ];
  const ul = $('anaLines');
  ul.innerHTML = lines.map(l => `<li>${l}</li>`).join('');
  go('analyzing');
  if (reduced) {
    [...ul.children].forEach(li => li.classList.add('on'));
    $('anaGauge').style.width = '100%';
    setTimeout(done, 1400);
    return;
  }
  const items = [...ul.children];
  items.forEach((li, i) => setTimeout(() => {
    li.classList.add('on');
    playTick();
    $('anaGauge').style.width = ((i + 1) / items.length * 100) + '%';
  }, 500 + i * 650));
  setTimeout(done, 500 + items.length * 650 + 500);
}

// count the gauge numbers up and slide the markers into place
function animateGauges() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('#results .gaugebox').forEach((box, bi) => {
    const b = box.querySelector('.glabel b');
    const u = box.querySelector('.gtrack u');
    if (!b || !u) return;
    const finalText = b.textContent;
    const target = parseFloat(finalText) || 0;
    const finalRight = u.style.right;
    b.textContent = '0°';
    u.style.right = 'calc(0% - 7px)';
    setTimeout(() => {
      u.style.right = finalRight;
      const t0 = performance.now();
      const tick = now => {
        const p = Math.min(1, (now - t0) / 900);
        b.textContent = (target * (1 - Math.pow(1 - p, 3))).toFixed(1) + '°';
        if (p < 1) requestAnimationFrame(tick);
        else { b.textContent = finalText; playLock(); }
      };
      requestAnimationFrame(tick);
    }, 600 + bi * 250);
  });
}

$('detailsNext').onclick = () => {
  answers.person = {
    name: ($('pName').value || '').trim(),
    age: $('pAge').value, shoe: $('pShoe').value,
  };
  prepStage(0);
};

/* ================= official branded report (HTML → image) ================= */
const FOOT_PATH = 'M50,6 C74,6 82,32 80,62 C79,86 85,100 85,122 C85,162 74,202 50,208 C26,202 15,162 15,122 C15,100 21,86 20,62 C18,32 26,6 50,6 Z';
function footBlobs(cls) {
  const RED = '#E2574C', ORG = '#E8A13C', YEL = '#E7CD6A';
  if (cls === 'flat') return [[50, 172, 30, RED], [30, 112, 24, ORG], [50, 44, 20, YEL]];
  if (cls === 'high') return [[50, 172, 26, RED], [50, 44, 26, RED], [66, 110, 14, YEL]];
  if (cls === 'low') return [[50, 172, 26, ORG], [32, 112, 22, ORG], [50, 44, 18, YEL]];
  return [[50, 172, 22, YEL], [50, 44, 16, YEL]];
}
function renderFootSvg(el, cls, mirror) {
  const blobs = footBlobs(cls).map(([bx, by, r, col], i) =>
    `<radialGradient id="g${el.id}${i}"><stop offset="0" stop-color="${col}"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>
     <circle cx="${bx}" cy="${by}" r="${r * 1.5}" fill="url(#g${el.id}${i})"/>`).join('');
  el.innerHTML = `<g transform="${mirror ? 'translate(100,0) scale(-1,1)' : ''}">
    <path d="${FOOT_PATH}" fill="#EEF4F2" stroke="#B9CCC7" stroke-width="2.5"/>${blobs}</g>`;
}
function renderOfficialReport(profile) {
  const walk = scanResults.walk || {};
  const cR = classify(profile.R), cL = classify(profile.L);
  const p = answers.person || {};
  const d = new Date();
  $('orpNo').textContent = `${d.getFullYear()}-${String((d.getMonth() + 1) * 100 + d.getDate()).padStart(4, '0')}`;
  $('orpDate').textContent = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
  $('orpName').textContent = p.name || 'הלקוח';
  $('orpMeta2').textContent = (p.age ? ` · גיל ${p.age}` : '') + (p.shoe ? ` · נעל מידה ${p.shoe}` : '');
  renderFootSvg($('footR'), cR.cls, false);
  renderFootSvg($('footL'), cL.cls, true);
  const R = profile.R, L = profile.L;
  const meanAch = R.ach != null ? (R.ach + L.ach) / 2 : null;
  $('orpCls').textContent = R.ach == null ? 'בהשלמת מומחה'
    : meanAch > 6 ? 'פרונציית-יתר (Overpronation)'
    : meanAch > 3 ? 'פרונציית-יתר מתונה'
    : (R.knee + L.knee) / 2 < -3 ? 'נטייה לסופינציה' : 'דריכה נייטרלית';
  // slider: right = supination, left = overpronation
  const pos = meanAch == null ? 0.5 : Math.min(0.97, Math.max(0.03, 0.45 + meanAch / 20));
  $('orpDot').style.right = `calc(${(pos * 100).toFixed(1)}% - 11px)`;
  $('orpClsLine').textContent = R.ach == null
    ? 'המומחה שלנו משלים את הניתוח מהצילומים ויחזור אליך בוואטסאפ.'
    : meanAch > 3
      ? 'כף הרגל קורסת פנימה בכל צעד. זה הגורם השכיח לשרשרת עומסים שעולה לברכיים ולגב התחתון.'
      : 'קו העקב נשמר יציב לאורך הצעד — בסיס טוב; המדרס יוודא תמיכה גם בהעמסות.';
  const worse = R.ach != null && R.ach >= L.ach ? 'ימין' : 'שמאל';
  const painKnee = (answers.pain || []).includes(4);
  const finds = R.ach == null ? [
    ['ההליכה נקלטה במלואה', 'הצילומים והנתונים הועברו למומחה להשלמת האבחון.'],
    ['השאלון נותח', 'הדיווח שלך שוקלל בפרופיל האישי.'],
    ['השלב הבא מוכן', 'ערכת טביעת רגל ביתית לבניית המדרס האישי.'],
  ] : [
    [`קו עקב ${worse} נוטה פנימה ~${(worse === 'ימין' ? R.ach : L.ach).toFixed(0)}°`,
      'נמדד ברגעי העמסה מלאה על רגל אחת, לאורך מחזורי ההליכה שלך.'],
    Math.abs(R.ach - L.ach) > 1.5
      ? [`עומס לא סימטרי — רגל ${worse} עמוסה יותר`,
         painKnee ? 'עקבי עם כאב הברך שציינת בשאלון — המפרט יתוקן בהתאם.' : 'המפרט של כל רגל ייבנה בנפרד.']
      : ['דפוס דומה בשתי הרגליים', 'זוג המדרסים ייבנה מאוזן.'],
    [`${walk.cycles || 0} מחזורי הליכה נותחו`, 'המדידה מבוססת ממוצע רב-צעדי, לא צעד בודד.'],
  ];
  $('orpFinds').innerHTML = finds.map(([t, d2]) => `<li><b>${t}</b>${d2}</li>`).join('');
  $('orpReco').textContent = `מדרס בהתאמה אישית עם ${cR.spec[0] || 'תמיכת קשת מותאמת'} ופיזור עומס עקב.`;
}
async function shareOfficial() {
  try {
    if (window.html2canvas) {
      const canvas = await html2canvas($('officialReport'), { scale: 2, backgroundColor: '#F2F5F4', useCORS: true });
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
      const file = new File([blob], 'foot-report.jpg', { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: 'הדוח שלי מניתוח הדריכה הביתי' });
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'foot-report.jpg'; a.click();
    }
  } catch { /* cancelled/unsupported — still open the chat */ }
  window.open(waLink(), '_blank');
}

/* ================= WhatsApp handoff + shareable report ================= */
const WHATSAPP = '972500000000'; // TODO: replace with the Vizzy business number
function waLink() {
  return 'https://wa.me/' + WHATSAPP + '?text=' +
    encodeURIComponent('סיימתי את ניתוח הדריכה הביתי — מצרף את הדוח שלי');
}
async function shareReport() {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1400;
  const x = c.getContext('2d');
  x.fillStyle = '#F4F6F5'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#0E7C66'; x.fillRect(0, 0, c.width, 150);
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.direction = 'rtl';
  x.font = '700 54px Assistant, sans-serif';
  x.fillText('דוח ניתוח דריכה ביתי', c.width / 2, 95);
  const walk = scanResults.walk || {};
  let y = 240;
  for (const [k, label] of [['R', 'רגל ימין'], ['L', 'רגל שמאל']]) {
    const f = walk[k] ? { ...walk[k], collapse: null } : { ach: null, knee: null, collapse: null };
    const cRes = classify(f);
    x.fillStyle = '#15252B'; x.font = '700 44px Assistant, sans-serif';
    x.fillText(label + ' — ' + cRes.name, c.width / 2, y);
    x.fillStyle = '#5B6E74'; x.font = '400 32px Assistant, sans-serif';
    wrapText(x, cRes.plain, c.width / 2, y + 55, 900, 44);
    y += 220;
  }
  // evidence stills
  const pics = snaps.slice(-2);
  let px = c.width / 2 - (pics.length * 280) / 2;
  await Promise.all(pics.map(s => new Promise(res => {
    const im = new Image();
    im.onload = () => { x.drawImage(im, px, y, 260, 346); px += 290; res(); };
    im.onerror = res; im.src = s.url;
  })));
  y += 400;
  x.fillStyle = '#0E7C66'; x.font = '700 38px Assistant, sans-serif';
  x.fillText('השלב הבא: ערכת טביעת רגל ביתית לבניית מדרס אישי', c.width / 2, y);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  const file = new File([blob], 'foot-report.jpg', { type: 'image/jpeg' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: 'הדוח שלי מניתוח הדריכה הביתי' });
      return;
    }
  } catch { /* user cancelled or unsupported — fall through */ }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'foot-report.jpg'; a.click();
  window.open(waLink(), '_blank');
}
function wrapText(x, text, cx, y, maxW, lh) {
  const words = (text || '').split(' ');
  let line = '';
  for (const w of words) {
    if (x.measureText(line + w).width > maxW) { x.fillText(line, cx, y); y += lh; line = w + ' '; }
    else line += w + ' ';
  }
  x.fillText(line, cx, y);
}

/* ================= payment ================= */
// Production: replace with the PSP's hosted page / iframe (Grow, Tranzila,
// Stripe). The order payload below is what the backend receives.
$('waBtn').onclick = () => { window.open(waLink(), '_blank'); };
$('shareBtn').onclick = () => { shareOfficial(); };
$('payBtn') && ($('payBtn').onclick = () => {
  const order = {
    ts: new Date().toISOString(),
    answers,
    scan: scanResults,
    measurements: { R: [num('mRL'), num('mRW')], L: [num('mLL'), num('mLW')] },
  };
  console.log('ORDER PAYLOAD', order);
});

/* ================= boot ================= */
(function boot() {
  const bad = [];
  if (!navigator.mediaDevices?.getUserMedia) bad.push('מצלמה');
  if (!('speechSynthesis' in window)) bad.push('הנחיה קולית');
  $('compatNote').textContent = bad.length
    ? `שים לב: הדפדפן הזה לא תומך ב: ${bad.join(', ')}. פתח בכרום או ספארי בטלפון.`
    : 'הסריקה משתמשת במצלמה ובהנחיה קולית — פתח בטלפון, באור טוב.';
})();
