// pose.js — camera + MediaPipe PoseLandmarker wrapper and angle math.
// All angles are computed in the image plane from normalized landmarks.
import { FilesetResolver, PoseLandmarker, DrawingUtils } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// MediaPipe Pose landmark indices
export const LM = {
  NOSE: 0, L_EYE: 2, R_EYE: 5, L_EAR: 7, R_EAR: 8,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_TOE: 31, R_TOE: 32,
};

let landmarker = null;

export async function initPose() {
  if (landmarker) return landmarker;
  const files = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
  landmarker = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  return landmarker;
}

// Front (selfie) camera by default: the customer sees themselves and the
// on-screen instructions while positioning. The display is mirrored in CSS;
// landmark math runs on the unmirrored frames, so angles are unaffected.
export async function openCamera(videoEl, facing = 'user') {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 960 } },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

export function closeCamera(videoEl) {
  const s = videoEl.srcObject;
  if (s) s.getTracks().forEach(t => t.stop());
  videoEl.srcObject = null;
}

export function detect(videoEl, ts) {
  if (!landmarker || videoEl.readyState < 2) return null;
  const res = landmarker.detectForVideo(videoEl, ts);
  return res.landmarks && res.landmarks[0] ? res.landmarks[0] : null;
}

export function drawSkeleton(canvas, lms) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!lms) return;
  const du = new DrawingUtils(ctx);
  du.drawConnectors(lms, PoseLandmarker.POSE_CONNECTIONS,
    { color: '#4FE3C1', lineWidth: 3 });
  du.drawLandmarks(lms, { color: '#4FE3C1', radius: 3 });
}

/* ---------- geometry ---------- */
const deg = r => r * 180 / Math.PI;

// Angle of a limb segment (a→b) from the vertical, signed by x direction.
function segmentFromVertical(a, b) {
  return deg(Math.atan2(b.x - a.x, a.y - b.y)); // y grows downward
}

// Achilles line: heel → knee vs vertical, per leg. In a frontal
// (walking toward camera) view, an inward break shows as deviation.
// Sign is normalized so + = medial (inward) for both legs.
export function achillesDeviation(lms, side) {
  const heel = lms[side === 'R' ? LM.R_HEEL : LM.L_HEEL];
  const knee = lms[side === 'R' ? LM.R_KNEE : LM.L_KNEE];
  const raw = segmentFromVertical(heel, knee);
  return side === 'R' ? raw : -raw;
}

// Knee axis: angle between thigh (hip→knee) and shank (knee→ankle).
// + = valgus (knee pulled medially), − = varus (O-legs).
export function kneeAxis(lms, side) {
  const hip = lms[side === 'R' ? LM.R_HIP : LM.L_HIP];
  const knee = lms[side === 'R' ? LM.R_KNEE : LM.L_KNEE];
  const ankle = lms[side === 'R' ? LM.R_ANKLE : LM.L_ANKLE];
  const thigh = segmentFromVertical(hip, knee);
  const shank = segmentFromVertical(knee, ankle);
  const raw = shank - thigh;
  return side === 'R' ? raw : -raw;
}

// Arch proxy for the single-leg profile test: ankle height above the
// heel–toe line, normalized by foot length. Collapse% is computed by the
// caller as the relative drop from the two-leg baseline.
export function archHeight(lms, side) {
  const heel = lms[side === 'R' ? LM.R_HEEL : LM.L_HEEL];
  const toe = lms[side === 'R' ? LM.R_TOE : LM.L_TOE];
  const ankle = lms[side === 'R' ? LM.R_ANKLE : LM.L_ANKLE];
  const footLen = Math.hypot(toe.x - heel.x, toe.y - heel.y);
  if (footLen < 1e-4) return null;
  const cross = Math.abs(
    (toe.x - heel.x) * (heel.y - ankle.y) - (heel.x - ankle.x) * (toe.y - heel.y));
  return cross / footLen / footLen; // scale-free
}

// Person size in frame (0..1) — rough distance signal.
export function personHeight(lms) {
  const nose = lms[LM.NOSE];
  const la = lms[LM.L_ANKLE], ra = lms[LM.R_ANKLE];
  return Math.max(la.y, ra.y) - nose.y;
}

// Both ankles + knees visible with decent confidence?
export function legsVisible(lms) {
  return [LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE, LM.L_HEEL, LM.R_HEEL]
    .every(i => (lms[i].visibility ?? 1) > 0.5);
}

/* ---------- sight diagnosis ---------- */
// What does the camera actually see right now?
// Returns { ok:true } or { ok:false, reason } where reason is one of:
//   no_person   — nobody / nothing trackable in frame
//   feet_cut    — legs tracked but the feet fall outside the frame bottom
//   legs_hidden — a person is there but knees/ankles are not confidently seen
// The waist line is treated leniently: knees+ankles+heels confidently in
// frame is enough (hip points sit right at the frame edge when the crop
// is exactly at the waist, so they are not required).
export function diagnose(lms, { profile = false } = {}) {
  if (!lms) return { ok: false, reason: 'no_person' };
  const vis = i => (lms[i].visibility ?? 1);
  const chain = side => {
    const [k, a, h] = side === 'R'
      ? [LM.R_KNEE, LM.R_ANKLE, LM.R_HEEL] : [LM.L_KNEE, LM.L_ANKLE, LM.L_HEEL];
    return vis(k) > 0.3 && vis(a) > 0.3 && vis(h) > 0.2;
  };
  const chains = (chain('R') ? 1 : 0) + (chain('L') ? 1 : 0);
  const need = profile ? 1 : 2;         // profile: one leg occludes the other
  if (chains < need) return { ok: false, reason: 'legs_hidden' };
  const heelY = Math.max(
    vis(LM.R_HEEL) > 0.3 ? lms[LM.R_HEEL].y : 0,
    vis(LM.L_HEEL) > 0.3 ? lms[LM.L_HEEL].y : 0);
  if (heelY > 0.985) return { ok: false, reason: 'feet_cut' };
  return { ok: true };
}

// Visibility gates built on the diagnosis
export function lowerBodyVisible(lms) { return diagnose(lms).ok; }
export function profileVisible(lms) { return diagnose(lms, { profile: true }).ok; }

// Arch-test framing: the subject is the FOOT, so the camera should be
// CLOSE — floor to the knees at most. Requires one leg's knee→ankle→
// heel→toe chain in frame, the foot inside the frame bottom, and the
// foot large enough in frame for arch resolution (else: come closer).
export function archDiagnose(lms) {
  if (!lms) return { ok: false, reason: 'no_person' };
  const vis = i => (lms[i].visibility ?? 1);
  const side = s => {
    const [k, a, h, t] = s === 'R'
      ? [LM.R_KNEE, LM.R_ANKLE, LM.R_HEEL, LM.R_TOE]
      : [LM.L_KNEE, LM.L_ANKLE, LM.L_HEEL, LM.L_TOE];
    return vis(k) > 0.25 && vis(a) > 0.3 && vis(h) > 0.2 && vis(t) > 0.2 ? { h, t } : null;
  };
  const leg = side('R') || side('L');
  if (!leg) return { ok: false, reason: 'legs_hidden' };
  if (lms[leg.h].y > 0.985 || lms[leg.t].y > 0.985) return { ok: false, reason: 'feet_cut' };
  const footLen = Math.hypot(lms[leg.t].x - lms[leg.h].x, lms[leg.t].y - lms[leg.h].y);
  if (footLen < 0.055) return { ok: false, reason: 'too_far' };
  return { ok: true };
}

// The standing (loaded) foot right now: the LOWER ankle (y grows down).
export function standingSide(lms) {
  return lms[LM.R_ANKLE].y >= lms[LM.L_ANKLE].y ? 'R' : 'L';
}

// Is some foot clearly lifted? (ankle height gap, scale-free via leg len)
export function legLifted(lms) {
  const la = lms[LM.L_ANKLE], ra = lms[LM.R_ANKLE];
  const lh = lms[LM.L_HIP], rh = lms[LM.R_HIP];
  const legLen = (Math.hypot(lh.x - la.x, lh.y - la.y) +
                  Math.hypot(rh.x - ra.x, rh.y - ra.y)) / 2;
  if (legLen < 1e-3) return false;
  return Math.abs(la.y - ra.y) / legLen > 0.12;
}

// How close is the walker? 0..1 — the lower the heels sit in the frame,
// the closer the person is to an ankle-height camera.
export function approachLevel(lms) {
  return Math.max(lms[LM.R_HEEL].y, lms[LM.L_HEEL].y);
}

// Body orientation from face-landmark visibility: nose + both eyes
// confidently seen = facing the camera; no face signal at all = back to
// camera; one eye/ear = profile.
export function facing(lms) {
  const vis = i => (lms[i].visibility ?? 0);
  const face = (vis(LM.NOSE) + vis(LM.L_EYE) + vis(LM.R_EYE)) / 3;
  const ears = (vis(LM.L_EAR) + vis(LM.R_EAR)) / 2;
  if (face > 0.6) return 'front';
  if (face < 0.25 && ears < 0.5) return 'back';
  return 'profile';
}

// Apparent leg scale in frame (hip→heel length). Shrinks as the person
// walks away, grows as they approach — and unlike nose-based height it
// works with the back to the camera. Returns null when legs aren't tracked.
export function legScale(lms) {
  const vis = i => (lms[i].visibility ?? 1);
  if (vis(LM.L_HIP) < 0.3 || vis(LM.R_HIP) < 0.3) return null;
  const l = Math.hypot(lms[LM.L_HIP].x - lms[LM.L_HEEL].x, lms[LM.L_HIP].y - lms[LM.L_HEEL].y);
  const r = Math.hypot(lms[LM.R_HIP].x - lms[LM.R_HEEL].x, lms[LM.R_HIP].y - lms[LM.R_HEEL].y);
  const s = (l + r) / 2;
  return s > 1e-3 ? s : null;
}

// Compact per-joint confidence readout for the on-screen debug line.
export function visReport(lms) {
  if (!lms) return 'no person';
  const v = i => (lms[i].visibility ?? 1).toFixed(2);
  return `knee ${v(LM.R_KNEE)}/${v(LM.L_KNEE)} ankle ${v(LM.R_ANKLE)}/${v(LM.L_ANKLE)} heel ${v(LM.R_HEEL)}/${v(LM.L_HEEL)}`;
}
