// ═══════════════════════════════════════════════════════════════════════
//  LinkCall — Offer-in-URL P2P signaling (zero backend)
//  + localStorage persistence so refresh doesn't lose your SDP state
//
//  WHAT IS SAVED TO localStorage:
//  ┌────────────────────────────────────────────────────────────────────┐
//  │  lc_role        → "caller" | "callee"                             │
//  │  lc_offer       → encoded offer SDP (set by caller)               │
//  │  lc_answer      → encoded answer SDP (set by callee)              │
//  │  lc_link        → full shareable URL (set by caller)              │
//  │  lc_answered    → "1" once callee has generated their answer      │
//  └────────────────────────────────────────────────────────────────────┘
//
//  NOTE: localStorage CAN'T keep the live RTCPeerConnection alive across
//  a refresh — that is impossible. What it DOES do is restore the UI so:
//  • Caller sees their share link + paste-answer box again (no need to
//    re-create the offer from scratch)
//  • Callee sees their generated answer again (no need to re-open link)
//  Both peers just need to redo the final ICE handshake by re-connecting.
// ═══════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────
let localStream   = null;
let remoteStream  = null;
let peer          = null;
let isCaller      = false;
let micOn         = true;
let camOn         = true;
let timerInterval = null;
let timerSecs     = 0;

// ── localStorage keys ─────────────────────────────────────────────────
const LS = {
  ROLE    : "lc_role",
  OFFER   : "lc_offer",
  ANSWER  : "lc_answer",
  LINK    : "lc_link",
  ANSWERED: "lc_answered",
};

// ── ICE / STUN servers ────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302"  },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

// ═══════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════
window.addEventListener("DOMContentLoaded", async () => {
  const params       = new URLSearchParams(window.location.search);
  const encodedOffer = params.get("offer");

  if (encodedOffer) {
    // ── Fresh callee join via shared link ──────────────────────────
    isCaller = false;
    lsSave(LS.ROLE,  "callee");
    lsSave(LS.OFFER, encodedOffer); // save offer so callee can restore after refresh
    showCallScreen();
    await initMedia();
    await receiveOffer(encodedOffer);

  } else if (lsGet(LS.ROLE) === "caller" && lsGet(LS.OFFER)) {
    // ── Caller refreshed — restore their UI ───────────────────────
    isCaller = true;
    showCallScreen();
    await initMedia();
    restoreCallerUI();

  } else if (lsGet(LS.ROLE) === "callee" && lsGet(LS.OFFER)) {
    // ── Callee refreshed — re-generate answer from saved offer ────
    isCaller = false;
    showCallScreen();
    await initMedia();
    await receiveOffer(lsGet(LS.OFFER));

  }
  // else: clean lobby
});

// ═══════════════════════════════════════════════════════════════════════
//  CALLER — "Create a Call"
// ═══════════════════════════════════════════════════════════════════════
async function startNewCall() {
  const btn = document.getElementById("btn-create");
  btn.disabled    = true;
  btn.textContent = "⏳ Setting up…";

  isCaller = true;
  lsSave(LS.ROLE, "caller");

  showCallScreen();
  await initMedia();
  buildPeer();
  setStatus("wait", "Creating offer…");

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  setStatus("wait", "Gathering network info…");
  await waitForIce(peer);

  // Encode & save offer
  const encoded = encodeURIComponent(btoa(JSON.stringify(peer.localDescription)));
  const link    = `${location.origin}${location.pathname}?offer=${encoded}`;

  lsSave(LS.OFFER, encoded);
  lsSave(LS.LINK,  link);

  document.getElementById("link-url").value = link;
  setStatus("wait", "Share link → wait for peer's answer");
  showPanel("panel-set-answer");
  toast("🔗 Link ready! Share it with your peer.");
}

// ═══════════════════════════════════════════════════════════════════════
//  CALLER — restore UI after refresh (no need to rebuild offer)
// ═══════════════════════════════════════════════════════════════════════
async function restoreCallerUI() {
  const savedLink   = lsGet(LS.LINK);
  const savedAnswer = lsGet(LS.ANSWER);

  // Rebuild peer so it's ready to accept the answer
  buildPeer();

  // Re-set local description from saved offer
  try {
    const savedOffer = JSON.parse(atob(decodeURIComponent(lsGet(LS.OFFER))));
    await peer.setLocalDescription(new RTCSessionDescription(savedOffer));
  } catch (_) {
    // Offer expired or malformed — start fresh
    lsClear();
    window.location.href = location.pathname;
    return;
  }

  // Restore UI
  if (savedLink) document.getElementById("link-url").value = savedLink;

  showPanel("panel-set-answer");

  // If peer had already answered before the refresh, prefill it
  if (savedAnswer) {
    document.getElementById("answer-input").value = savedAnswer;
    setStatus("wait", "Answer restored — click Connect to reconnect");
    toast("🔄 Session restored! Click Connect to reconnect.");
  } else {
    setStatus("wait", "Session restored — waiting for peer's answer");
    toast("🔄 Session restored! Share the link and wait for answer.");
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  CALLEE — decode offer from URL or localStorage → auto-generate answer
// ═══════════════════════════════════════════════════════════════════════
async function receiveOffer(encodedOffer) {
  buildPeer();
  setStatus("wait", "Reading offer from link…");

  try {
    const offer = JSON.parse(atob(decodeURIComponent(encodedOffer)));
    await peer.setRemoteDescription(new RTCSessionDescription(offer));

    setStatus("wait", "Generating answer…");
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    await waitForIce(peer);

    const encodedAnswer = btoa(JSON.stringify(peer.localDescription));

    // Save answer to localStorage so callee can copy it after refresh
    lsSave(LS.ANSWER,   encodedAnswer);
    lsSave(LS.ANSWERED, "1");

    document.getElementById("answer-output").value = encodedAnswer;
    showPanel("panel-copy-answer");

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

    // Save answer so it can be restored after a refresh
    lsSave(LS.ANSWER, raw);

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

  localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

  peer.ontrack = (e) => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    document.getElementById("ov-remote").classList.add("gone");
    setStatus("live", "Connected ✓");
    startTimer();
    hidePanel("panel-set-answer");
    hidePanel("panel-copy-answer");
    toast("🟢 You're live!");
  };

  peer.oniceconnectionstatechange = () => {
    const state = peer.iceConnectionState;
    if (state === "disconnected" || state === "failed") {
      setStatus("err", "Connection lost — refresh to reconnect");
      toast("⚠️ Connection lost. Refresh to reconnect.");
      stopTimer();
    }
    if (state === "connected" || state === "completed") {
      setStatus("live", "Connected ✓");
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  MEDIA
// ═══════════════════════════════════════════════════════════════════════
async function initMedia() {
  setStatus("wait", "Requesting camera & mic…");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById("user-1").srcObject = localStream;
    document.getElementById("ov-local").classList.add("gone");
  } catch (err) {
    const msgs = {
      NotFoundError:    "No camera/mic found.",
      NotAllowedError:  "Camera permission denied.",
      NotReadableError: "Camera in use by another app.",
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
  if (!camOn) { ov.classList.remove("gone"); ov.querySelector("span").textContent = "Camera off"; }
  else          ov.classList.add("gone");
  toast(camOn ? "📷 Camera on" : "🚫 Camera off");
}

// ═══════════════════════════════════════════════════════════════════════
//  END CALL — clears localStorage too
// ═══════════════════════════════════════════════════════════════════════
function endCall() {
  if (peer) { peer.close(); peer = null; }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  stopTimer();
  lsClear(); // wipe saved session
  window.location.href = location.pathname;
}

// ═══════════════════════════════════════════════════════════════════════
//  localStorage HELPERS
// ═══════════════════════════════════════════════════════════════════════
function lsSave(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}

function lsGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function lsClear() {
  try {
    Object.values(LS).forEach(k => localStorage.removeItem(k));
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
//  COPY HELPERS
// ═══════════════════════════════════════════════════════════════════════
async function smartCopy(text, textareaId) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
  }
  const el = textareaId
    ? document.getElementById(textareaId)
    : (() => {
        const t = document.createElement("textarea");
        t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
        document.body.appendChild(t); return t;
      })();
  el.focus(); el.select(); el.setSelectionRange(0, 99999);
  const ok = document.execCommand("copy");
  if (!textareaId) document.body.removeChild(el);
  return ok;
}

function copyLink() {
  const url = document.getElementById("link-url").value;
  if (!url) { toast("⏳ Link not ready yet"); return; }
  smartCopy(url).then(ok => {
    if (!ok) { toast("❌ Copy failed — select the link manually"); return; }
    const btn = document.getElementById("btn-copy");
    btn.textContent = "Copied! ✓"; btn.classList.add("ok");
    setTimeout(() => { btn.textContent = "Copy Link"; btn.classList.remove("ok"); }, 2500);
    toast("🔗 Link copied!");
  });
}

function copyAnswer() {
  const val = document.getElementById("answer-output").value;
  if (!val) { toast("⏳ Answer not ready yet"); return; }
  smartCopy(val, "answer-output").then(ok => {
    if (!ok) { toast("❌ Copy failed — select text manually"); return; }
    const btn = document.getElementById("btn-copy-answer");
    btn.textContent = "Copied! ✓"; btn.classList.add("ok");
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
function waitForIce(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", check); resolve(); }, 4000);
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
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function startTimer() {
  timerSecs = 0; clearInterval(timerInterval);
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