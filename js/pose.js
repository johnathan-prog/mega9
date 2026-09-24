// pose.js — camera + MediaPipe PoseLandmarker wrapper and angle math.
// All angles are computed in the image plane from normalized landmarks.
import { FilesetResolver, PoseLandmarker, DrawingUtils } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// MediaPipe Pose landmark indices
export const LM = {
  NOSE: 0,
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
  // Camera view: subject faces camera, so subject-right appears on image-left.
  // Medial for image-left leg is +x, for image-right leg is -x.
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
  // Distance of the ankle from the heel→toe line
  const cross = Math.abs(
    (toe.x - heel.x) * (heel.y - ankle.y) - (heel.x - ankle.x) * (toe.y - heel.y));
  return cross / footLen / footLen; // scale-free
}

// Person size in frame (0..1) — used for distance guidance.
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

// The scan-readiness gate: floor-to-waist in frame. Hips through heels
// visible, and the feet actually inside the frame (not cut off below).
export function lowerBodyVisible(lms) {
  const parts = [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE,
    LM.L_ANKLE, LM.R_ANKLE, LM.L_HEEL, LM.R_HEEL];
  if (!parts.every(i => (lms[i].visibility ?? 1) > 0.5)) return false;
  const maxY = Math.max(lms[LM.L_HEEL].y, lms[LM.R_HEEL].y);
  const minY = Math.min(lms[LM.L_HIP].y, lms[LM.R_HIP].y);
  return maxY < 0.99 && minY > 0.01;
}

// Profile readiness: in profile stance one leg occludes the other, so
// requiring both legs never triggers. One full leg chain in frame is
// enough: hip→knee→ankle→heel on either side, with the heel inside frame.
export function profileVisible(lms) {
  const chain = side => {
    const ids = side === 'R'
      ? [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE, LM.R_HEEL]
      : [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE, LM.L_HEEL];
    return ids.every(i => (lms[i].visibility ?? 1) > 0.5)
      && lms[ids[3]].y < 0.99 && lms[ids[0]].y > 0.01;
  };
  return chain('R') || chain('L');
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
