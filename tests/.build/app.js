// app.js — flow controller: questionnaire → guided scans → results → pay.
import * as P from './pose.js';
import { WalkScan, ArchTest, primeTTS } from './guide.js';
import { classify, LOGIC_LINE } from './engine.js';

const $ = id => document.getElementById(id);
const LABELS = { intro: 'פתיחה', quiz: 'שאלון', setup: 'הכנה', scan: 'סריקה', analyzing: 'ניתוח', results: 'הדוח שלך' };
const ORDER = ['intro', 'quiz', 'setup', 'scan', 'analyzing', 'results'];
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
let audioCtx = null;
function initAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // iOS creates the context SUSPENDED even inside a gesture — resume it
    if (audioCtx.state === 'suspended') audioCtx.resume();
    beep(880, 0.03, 0.001); // silent kick so the pipeline is warm
  } catch { audioCtx = null; }
}
function beep(freq, dur, gainV, freq2) {
  if (!audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq;
    if (freq2) o.frequency.exponentialRampToValueAtTime(freq2, audioCtx.currentTime + dur);
    g.gain.setValueAtTime(gainV, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch { /* audio best-effort */ }
}
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
  renderSkeletonReplay();
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

// skeleton-only replay: the customer's full recorded movement as clean
// glowing lines on dark — the "x-ray" view of their gait state
let skelTimer = null;
function renderSkeletonReplay() {
  const card = $('skelCard'), cv = $('skelReplay');
  const frames = rawLog.filter(f => f.l && f.rt != null);
  if (frames.length < 20) { card.hidden = true; return; }
  card.hidden = false;
  const x = cv.getContext('2d');
  let fi = 0;
  clearInterval(skelTimer);
  skelTimer = setInterval(() => {
    const f = frames[fi];
    const lms = f.l.map(a => ({ x: a[0], y: a[1], visibility: a[2] }));
    x.fillStyle = '#0B1416'; x.fillRect(0, 0, cv.width, cv.height);
    const pt = i => [(1 - lms[i].x) * cv.width, lms[i].y * cv.height];
    x.lineCap = 'round';
    // glowing body lines
    x.shadowColor = '#4FE3C1'; x.shadowBlur = 10;
    x.strokeStyle = '#4FE3C1'; x.lineWidth = 3;
    const seg = (a, b) => {
      if ((lms[a].visibility ?? 1) < 0.2 || (lms[b].visibility ?? 1) < 0.2) return;
      const [ax, ay] = pt(a), [bx, by] = pt(b);
      x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke();
    };
    seg(P.LM.L_HIP, P.LM.R_HIP);
    seg(P.LM.R_HIP, P.LM.R_KNEE); seg(P.LM.R_KNEE, P.LM.R_ANKLE);
    seg(P.LM.R_ANKLE, P.LM.R_HEEL); seg(P.LM.R_HEEL, P.LM.R_TOE);
    seg(P.LM.L_HIP, P.LM.L_KNEE); seg(P.LM.L_KNEE, P.LM.L_ANKLE);
    seg(P.LM.L_ANKLE, P.LM.L_HEEL); seg(P.LM.L_HEEL, P.LM.L_TOE);
    x.shadowBlur = 0;
    // heel lines + live angle
    let maxDev = 0;
    for (const side of ['R', 'L']) {
      const HEEL = side === 'R' ? P.LM.R_HEEL : P.LM.L_HEEL;
      const KNEE = side === 'R' ? P.LM.R_KNEE : P.LM.L_KNEE;
      if ((lms[HEEL].visibility ?? 1) < 0.2) continue;
      const [hx, hy] = pt(HEEL), [kx, ky] = pt(KNEE);
      x.strokeStyle = '#FFD166'; x.lineWidth = 3;
      x.beginPath(); x.moveTo(hx, hy); x.lineTo(kx, ky); x.stroke();
      maxDev = Math.max(maxDev, Math.abs(P.achillesDeviation(lms, side)));
    }
    x.font = '700 22px Assistant, sans-serif'; x.fillStyle = '#FFD166';
    x.textAlign = 'left';
    x.fillText(maxDev.toFixed(0) + '°', 14, 34);
    $('skelCaption').textContent = 'כך המערכת רואה את התנועה שלך — הקו הצהוב הוא קו העקב';
    fi = (fi + 1) % frames.length;
  }, 60);
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
  if (reduced) { done(); return; }
  const items = [...ul.children];
  items.forEach((li, i) => setTimeout(() => {
    li.classList.add('on');
    beep(900 + i * 120, 0.05, 0.1);
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
      u.style.right = finalRight; // CSS transition slides the marker
      const t0 = performance.now();
      const tick = now => {
        const p = Math.min(1, (now - t0) / 900);
        b.textContent = (target * (1 - Math.pow(1 - p, 3))).toFixed(1) + '°';
        if (p < 1) requestAnimationFrame(tick);
        else { b.textContent = finalText; beep(620, 0.1, 0.1, 940); }
      };
      requestAnimationFrame(tick);
    }, 600 + bi * 250);
  });
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
$('shareBtn').onclick = () => { shareReport(); };
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
