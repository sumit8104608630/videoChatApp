// ═══════════════════════════════════════════════════════════════════════
//  LinkCall — Offer-in-URL P2P signaling (zero backend)
//
//  FLOW:
//  ┌─ CALLER ──────────────────────────────────────────────────────────┐
//  │  1. Click "Create a Call"                                         │
//  │  2. Offer SDP encoded → baked into shareable URL (?offer=...)     │
//  │  3. Share the URL with peer                                       │
//  │  4. Paste the answer the peer sends back → click Connect          │
//  └───────────────────────────────────────────────────────────────────┘
//  ┌─ CALLEE ──────────────────────────────────────────────────────────┐
//  │  1. Open the shared link                                          │
//  │  2. Offer decoded from URL automatically                          │
//  │  3. Answer generated & auto-copied to clipboard                   │
//  │  4. Send the answer text back to the caller                       │
//  └───────────────────────────────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────
let localStream    = null;
let remoteStream   = null;
let peer           = null;
let isCaller       = false;
let micOn          = true;
let camOn          = true;
let timerInterval  = null;
let timerSecs      = 0;

// ── ICE / STUN servers ────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302"  },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

// ═══════════════════════════════════════════════════════════════════════
//  BOOT — on page load, check if a ?offer= param is present
// ═══════════════════════════════════════════════════════════════════════
window.addEventListener("DOMContentLoaded", async () => {
  const params       = new URLSearchParams(window.location.search);
  const encodedOffer = params.get("offer");

  if (encodedOffer) {
    // ── Callee path: URL contains an offer ──
    isCaller = false;
    showCallScreen();
    await initMedia();
    await receiveOffer(encodedOffer);
  }
  // else: Lobby shown — user will click "Create a Call"
});

// ═══════════════════════════════════════════════════════════════════════
//  CALLER — "Create a Call" button
// ═══════════════════════════════════════════════════════════════════════
async function startNewCall() {
  const btn = document.getElementById("btn-create");
  btn.disabled    = true;
  btn.textContent = "⏳ Setting up…";

  isCaller = true;
  showCallScreen();

  // Step 1 — get camera/mic
  await initMedia();

  // Step 2 — build peer connection & create offer
  buildPeer();
  setStatus("wait", "Creating offer…");

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  // Step 3 — wait until ICE candidates are gathered into the SDP
  setStatus("wait", "Gathering network info…");
  await waitForIce(peer);

  // Step 4 — encode the full SDP as a URL-safe base64 string
  const encoded = encodeURIComponent(btoa(JSON.stringify(peer.localDescription)));
  const link    = `${location.origin}${location.pathname}?offer=${encoded}`;

  document.getElementById("link-url").value = link;
  setStatus("wait", "Share link → wait for peer's answer");

  // Step 5 — show the "paste answer" panel
  showPanel("panel-set-answer");
  toast("🔗 Link ready! Share it with your peer.");
}

// ═══════════════════════════════════════════════════════════════════════
//  CALLEE — decode offer from URL → auto-generate & copy answer
// ═══════════════════════════════════════════════════════════════════════
async function receiveOffer(encodedOffer) {
  buildPeer();
  setStatus("wait", "Reading offer from link…");

  try {
    // Decode offer SDP from URL param
    const offer = JSON.parse(atob(decodeURIComponent(encodedOffer)));
    await peer.setRemoteDescription(new RTCSessionDescription(offer));

    // Generate answer
    setStatus("wait", "Generating answer…");
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    // Wait for ICE
    await waitForIce(peer);

    // Encode answer as base64 string (this is what callee sends back to caller)
    const encodedAnswer = btoa(JSON.stringify(peer.localDescription));

    // Put answer in the output textarea
    document.getElementById("answer-output").value = encodedAnswer;

    // Show the "copy answer" panel
    showPanel("panel-copy-answer");

    // Auto-copy answer to clipboard
    const copied = await smartCopy(encodedAnswer, "answer-output");
    if (copied) {
      showCopyConfirm();
      setStatus("wait", "Answer auto-copied ✅ — send it to the caller");
      toast("✅ Answer copied! Send it to the caller.");
    } else {
      setStatus("wait", "Copy the answer below and send to caller");
      toast("📋 Copy the answer below and send to caller.");
    }

  } catch (err) {
    setStatus("err", "Invalid offer in link");
    toast("❌ Could not read offer — link may be corrupted");
    console.error("receiveOffer error:", err);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  CALLER — paste callee's answer & connect
// ═══════════════════════════════════════════════════════════════════════
async function setAnswer() {
  const raw = document.getElementById("answer-input").value.trim();
  if (!raw) {
    toast("⚠️ Paste the answer from your peer first");
    return;
  }

  try {
    const answer = JSON.parse(atob(raw));
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
    setStatus("wait", "Connecting…");
    hidePanel("panel-set-answer");
    toast("⏳ Answer accepted — establishing connection…");
  } catch (err) {
    toast("❌ Invalid answer — make sure you copied the full text");
    console.error("setAnswer error:", err);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  BUILD RTCPeerConnection
// ═══════════════════════════════════════════════════════════════════════
function buildPeer() {
  if (peer) peer.close();

  peer         = new RTCPeerConnection(ICE_SERVERS);
  remoteStream = new MediaStream();
  document.getElementById("user-2").srcObject = remoteStream;

  // ── Add local tracks so they're sent to remote peer ──
  localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

  // ── Receive remote tracks ──
  peer.ontrack = (e) => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    document.getElementById("ov-remote").classList.add("gone");
    setStatus("live", "Connected ✓");
    startTimer();
    hidePanel("panel-set-answer");
    hidePanel("panel-copy-answer");
    toast("🟢 You're live!");
  };

  // ── Connection state monitoring ──
  peer.oniceconnectionstatechange = () => {
    const state = peer.iceConnectionState;
    console.log("ICE state:", state);
    if (state === "disconnected" || state === "failed") {
      setStatus("err", "Connection lost");
      toast("⚠️ Peer disconnected");
      stopTimer();
    }
    if (state === "connected" || state === "completed") {
      setStatus("live", "Connected ✓");
    }
  };

  peer.onconnectionstatechange = () => {
    console.log("Connection state:", peer.connectionState);
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  MEDIA — request camera & microphone
// ═══════════════════════════════════════════════════════════════════════
async function initMedia() {
  setStatus("wait", "Requesting camera & mic…");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    document.getElementById("user-1").srcObject = localStream;
    document.getElementById("ov-local").classList.add("gone");
  } catch (err) {
    const msgs = {
      NotFoundError:       "No camera/mic found. Check connections.",
      NotAllowedError:     "Camera permission denied. Allow it in browser settings.",
      NotReadableError:    "Camera in use by another app. Close Zoom/Teams etc.",
      OverconstrainedError:"Camera doesn't support the requested format.",
    };
    const msg = msgs[err.name] || err.message;
    setStatus("err", msg);
    toast("❌ " + msg);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  MEDIA CONTROLS
// ═══════════════════════════════════════════════════════════════════════
function toggleMic() {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => (t.enabled = micOn));
  const btn = document.getElementById("btn-mic");
  btn.textContent = micOn ? "🎤" : "🔇";
  btn.classList.toggle("off", !micOn);
  toast(micOn ? "🎤 Mic on" : "🔇 Mic muted");
}

function toggleCam() {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => (t.enabled = camOn));
  const btn = document.getElementById("btn-cam");
  btn.textContent = camOn ? "📷" : "🚫";
  btn.classList.toggle("off", !camOn);
  const ov = document.getElementById("ov-local");
  if (!camOn) {
    ov.classList.remove("gone");
    ov.querySelector("span").textContent = "Camera off";
  } else {
    ov.classList.add("gone");
  }
  toast(camOn ? "📷 Camera on" : "🚫 Camera off");
}

// ═══════════════════════════════════════════════════════════════════════
//  END CALL
// ═══════════════════════════════════════════════════════════════════════
function endCall() {
  if (peer) { peer.close(); peer = null; }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  stopTimer();
  // Navigate back to lobby (strips ?offer= from URL)
  window.location.href = location.pathname;
}

// ═══════════════════════════════════════════════════════════════════════
//  COPY HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Try modern clipboard API first, fall back to execCommand (works on HTTP too)
 * @param {string} text - text to copy
 * @param {string} [textareaId] - id of textarea to select for fallback
 */
async function smartCopy(text, textareaId) {
  // Method 1: Modern Clipboard API (requires HTTPS or localhost)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // fall through to method 2
    }
  }

  // Method 2: execCommand fallback (works on HTTP too)
  const el = textareaId
    ? document.getElementById(textareaId)
    : (() => {
        const t = document.createElement("textarea");
        t.value = text;
        t.style.position = "fixed";
        t.style.opacity  = "0";
        document.body.appendChild(t);
        return t;
      })();

  el.focus();
  el.select();
  el.setSelectionRange(0, 99999); // mobile support

  const success = document.execCommand("copy");
  if (!textareaId) document.body.removeChild(el);
  return success;
}

function copyLink() {
  const url = document.getElementById("link-url").value;
  if (!url || url === "Generating link…") {
    toast("⏳ Link not ready yet");
    return;
  }
  smartCopy(url).then(ok => {
    if (!ok) { toast("❌ Copy failed — select the link and copy manually"); return; }
    const btn = document.getElementById("btn-copy");
    btn.textContent = "Copied! ✓";
    btn.classList.add("ok");
    setTimeout(() => { btn.textContent = "Copy Link"; btn.classList.remove("ok"); }, 2500);
    toast("🔗 Link copied to clipboard!");
  });
}

function copyAnswer() {
  const val = document.getElementById("answer-output").value;
  if (!val) { toast("⏳ Answer not ready yet"); return; }
  smartCopy(val, "answer-output").then(ok => {
    if (!ok) { toast("❌ Copy failed — select the text and copy manually"); return; }
    const btn = document.getElementById("btn-copy-answer");
    btn.textContent = "Copied! ✓";
    btn.classList.add("ok");
    setTimeout(() => { btn.textContent = "📋 Copy Answer"; btn.classList.remove("ok"); }, 2500);
    showCopyConfirm();
    toast("📋 Answer copied!");
  });
}

function showCopyConfirm() {
  const el = document.getElementById("copy-confirm");
  el.style.display = "inline";
  setTimeout(() => (el.style.display = "none"), 3000);
}

// ═══════════════════════════════════════════════════════════════════════
//  ICE GATHERING WAIT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Returns a Promise that resolves when ICE gathering is complete.
 * Falls back after 4 seconds so we never hang indefinitely.
 */
function waitForIce(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }

    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      }
    };

    pc.addEventListener("icegatheringstatechange", onStateChange);
    // Safety fallback — resolve after 4 s regardless
    setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }, 4000);
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════════════════
function showCallScreen() {
  document.getElementById("lobby").style.display = "none";
  document.getElementById("call-screen").classList.add("show");
}

function showPanel(id) { document.getElementById(id).classList.add("show"); }
function hidePanel(id) { document.getElementById(id).classList.remove("show"); }

function setStatus(state, text) {
  document.getElementById("sdot").className    = state;
  document.getElementById("stext").textContent = text;
}

let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function startTimer() {
  timerSecs = 0;
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timerSecs++;
    const m = String(Math.floor(timerSecs / 60)).padStart(2, "0");
    const s = String(timerSecs % 60).padStart(2, "0");
    document.getElementById("timer").textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  document.getElementById("timer").textContent = "00:00";
}