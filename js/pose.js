// pose.js — camera + MediaPipe PoseLandmarker wrapper. All landmark math
// lives in posemath.js (pure, Node-testable) and is re-exported here.
import { FilesetResolver, PoseLandmarker, DrawingUtils } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

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


export * from './posemath.js?v=27';
import { LM } from './posemath.js?v=27';
