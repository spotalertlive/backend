// =======================================
// SpotAlert Live Camera → AWS Detector
// =======================================

// ✅ Backend URL
const API_BASE = "https://api.spotalert.live"; // change to http://localhost:3000 for local testing

// ✅ Elements
const video = document.getElementById("liveFeed");
const connectBtn = document.getElementById("connectCameraBtn");
const cameraUrlInput = document.getElementById("cameraUrl");

let captureInterval = null;
let stream = null;

// =======================================
// 1️⃣ CONNECT TO CAMERA
// =======================================
async function connectCamera() {
  const cameraUrl = cameraUrlInput.value.trim();

  if (cameraUrl) {
    alert("📡 External CCTV integration coming soon. For now, using device camera.");
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    video.play();
    console.log("🎥 Camera connected");
    startAutoCapture();
  } catch (err) {
    console.error("⚠️ Camera access error:", err);
    alert("Unable to access camera. Please allow permissions or check device.");
  }
}

if (connectBtn) connectBtn.addEventListener("click", connectCamera);

// =======================================
// 2️⃣ AUTO CAPTURE + UPLOAD
// =======================================
function startAutoCapture() {
  if (captureInterval) clearInterval(captureInterval);

  captureInterval = setInterval(async () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg"));
      if (!blob) return;

      const formData = new FormData();
      formData.append("image", blob, `frame_${Date.now()}.jpg`);
      formData.append("email", "admin@spotalert.live");

      const res = await fetch(`${API_BASE}/trigger-alert`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (res.ok) {
        console.log(`✅ Frame sent — ${data.faces?.length || 0} face(s) detected`);
      } else {
        console.error("❌ Detection failed:", data.error);
      }
    } catch (err) {
      console.error("⚠️ Auto-capture error:", err);
    }
  }, 10000); // ⏱ capture every 10 seconds
}

// =======================================
// 3️⃣ DISCONNECT CAMERA
// =======================================
function stopCamera() {
  if (captureInterval) clearInterval(captureInterval);
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    console.log("🛑 Camera disconnected");
  }
}
