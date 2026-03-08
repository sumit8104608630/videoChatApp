// ─── State ────────────────────────────────────────────────────────────────────
let localStream  = null;
let remoteStream = null;
let peer         = null;
let micOn        = true;
let camOn        = true;

// ─── ICE Servers ──────────────────────────────────────────────────────────────
const servers = {
  iceServers: [                                       // ✅ fixed: iceServers (plural)
    { urls: "stun:stun.l.google.com:19302"  },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ─── Init ─────────────────────────────────────────────────────────────────────
const init = async () => {
  try {
    setStatus("connecting", "Requesting camera & mic…");

    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,   // ✅ fixed: lowercase 'audio'
    });

    document.getElementById("user-1").srcObject   = localStream;
    document.getElementById("local-placeholder").style.display = "none";
    setStatus("idle", "Ready — create or receive an offer");
  } catch (err) {
    handleMediaError(err);
  }
};

// ─── Build RTCPeerConnection ───────────────────────────────────────────────────
const buildPeer = () => {
  if (peer) { peer.close(); }

  peer         = new RTCPeerConnection(servers);
  remoteStream = new MediaStream();
  document.getElementById("user-2").srcObject = remoteStream;

  // Add local tracks to the connection
  localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

  // Receive remote tracks
  peer.ontrack = (event) => {
    event.streams[0].getTracks().forEach(track => {
      remoteStream.addTrack(track);               // ✅ fixed: pass 'track' argument
    });
    document.getElementById("remote-placeholder").style.display = "none";
    setStatus("connected", "Connected ✓");
  };

  // ICE candidate logging (in production → send via signaling server)
  peer.onicecandidate = (event) => {
    if (event.candidate) {
      console.log("New ICE candidate:", JSON.stringify(event.candidate));
    }
  };

  peer.oniceconnectionstatechange = () => {
    console.log("ICE state:", peer.iceConnectionState);
    if (peer.iceConnectionState === "disconnected" ||
        peer.iceConnectionState === "failed") {
      setStatus("error", "Connection lost");
    }
  };

  peer.onnegotiationneeded = () => console.log("Negotiation needed");
};

// ─── Create Offer (Caller) ────────────────────────────────────────────────────
const createOffer = async () => {
  if (!localStream) { alert("Camera not ready yet."); return; }
  buildPeer();
  setStatus("connecting", "Creating offer…");

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  // Wait for ICE gathering to complete so the SDP is self-contained
  await waitForIce(peer);

  document.getElementById("offer-sdp").value =
    JSON.stringify(peer.localDescription);
  setStatus("connecting", "Offer ready — share it with your peer");
};

// ─── Create Answer (Callee) ───────────────────────────────────────────────────
const createAnswer = async () => {
  if (!localStream) { alert("Camera not ready yet."); return; }

  const raw = document.getElementById("offer-input").value.trim();
  if (!raw) { alert("Paste the Offer SDP first."); return; }

  buildPeer();
  setStatus("connecting", "Creating answer…");

  const offer = JSON.parse(raw);
  await peer.setRemoteDescription(new RTCSessionDescription(offer));

  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);

  await waitForIce(peer);

  document.getElementById("answer-sdp").value =
    JSON.stringify(peer.localDescription);
  setStatus("connecting", "Answer ready — send it back to caller");
};

// ─── Set Answer (Caller) ──────────────────────────────────────────────────────
const setAnswer = async () => {
  const raw = document.getElementById("answer-input").value.trim();
  if (!raw)  { alert("Paste the Answer SDP first."); return; }
  if (!peer) { alert("Create an offer first.");      return; }

  const answer = JSON.parse(raw);
  await peer.setRemoteDescription(new RTCSessionDescription(answer));
  setStatus("connecting", "Answer set — waiting for ICE…");
};

// ─── Media Controls ───────────────────────────────────────────────────────────
const toggleMic = () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => (t.enabled = micOn));
  const btn = document.getElementById("btn-mic");
  btn.textContent = micOn ? "🎤" : "🔇";
  btn.classList.toggle("active", !micOn);
};

const toggleCam = () => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => (t.enabled = camOn));
  const btn = document.getElementById("btn-cam");
  btn.textContent = camOn ? "📷" : "🚫";
  btn.classList.toggle("active", !camOn);
  document.getElementById("local-placeholder").style.display =
    camOn ? "none" : "flex";
};

const endCall = () => {
  if (peer) { peer.close(); peer = null; }
  if (remoteStream) {
    remoteStream.getTracks().forEach(t => t.stop());
  }
  document.getElementById("user-2").srcObject = null;
  document.getElementById("remote-placeholder").style.display = "flex";
  ["offer-sdp","answer-sdp","offer-input","answer-input"].forEach(
    id => (document.getElementById(id).value = "")
  );
  setStatus("idle", "Call ended");
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wait until ICE gathering finishes so SDP includes all candidates */
const waitForIce = (pc) =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    // Fallback timeout — resolve after 3 s regardless
    setTimeout(resolve, 3000);
  });

const copyText = (id) => {
  const el = document.getElementById(id);
  if (!el.value) { alert("Nothing to copy yet."); return; }
  navigator.clipboard.writeText(el.value)
    .then(() => alert("Copied to clipboard!"))
    .catch(() => {
      el.select();
      document.execCommand("copy");
      alert("Copied!");
    });
};

const setStatus = (state, text) => {
  const dot  = document.getElementById("status-dot");
  const span = document.getElementById("status-text");
  dot.className  = "";
  if (state !== "idle") dot.classList.add(state);
  span.textContent = text;
};

const handleMediaError = (err) => {
  const msgs = {
    NotFoundError:    "No camera/microphone found. Check device connections.",
    NotAllowedError:  "Permission denied — allow camera & mic in browser settings.",
    NotReadableError: "Device in use by another app. Close Zoom, Teams, etc.",
    OverconstrainedError: "Camera doesn't support requested constraints.",
  };
  const msg = msgs[err.name] || `Error: ${err.message}`;
  setStatus("error", msg);
  console.error(err);
  alert(msg);
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();