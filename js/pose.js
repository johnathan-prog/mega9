// pose.js — camera + MediaPipe PoseLandmarker wrapper. All landmark math
// lives in posemath.js (pure, Node-testable) and is re-exported here.
import { FilesetResolver, PoseLandmarker, ImageSegmenter, DrawingUtils } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const SEG_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

let landmarker = null;
let segmenter = null;

// body segmenter — powers the aura layer; failure only disables the aura
export async function initSegmenter() {
  if (segmenter) return segmenter;
  try {
    const files = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    segmenter = await ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: SEG_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  } catch { segmenter = null; }
  return segmenter;
}

export function segment(videoEl, ts) {
  if (!segmenter || videoEl.readyState < 2) return null;
  try {
    const res = segmenter.segmentForVideo(videoEl, ts);
    const m = res.categoryMask;
    if (!m) return null;
    const out = { data: m.getAsUint8Array(), w: m.width, h: m.height };
    m.close();
    return out.data && out.data.length ? out : null;
  } catch { return null; }
}

export async function initPose() {
  if (landmarker) return landmarker;
  const files = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
  landmarker = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
    // low thresholds so PARTIAL bodies (close-up legs) still yield
    // landmarks — the glowing overlay must appear the moment any part
    // of the person is in frame, not only at full-body distance
    minPoseDetectionConfidence: 0.25,
    minPosePresenceConfidence: 0.25,
    minTrackingConfidence: 0.25,
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

export function drawSkeleton(canvas, lms, { clear = true } = {}) {
  const ctx = canvas.getContext('2d');
  if (clear) ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!lms) return;
  const du = new DrawingUtils(ctx);
  du.drawConnectors(lms, PoseLandmarker.POSE_CONNECTIONS,
    { color: '#4FE3C1', lineWidth: 3 });
  du.drawLandmarks(lms, { color: '#4FE3C1', radius: 3 });
}


export * from './posemath.js?v=50';
import { LM } from './posemath.js?v=50';
