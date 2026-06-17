/* RoxReview submit widget — a floating "Send to coach" button + modal that any
 * athlete can use to send a movement clip to David's Form Review queue and read
 * his feedback. Drop-in: include review-client.js then this file. Optional
 * data-session="A" on the script tag pre-tags the clip with the session.
 *
 * Reused across the strength pages (A–D) and RoxLive — one widget everywhere.
 *
 * Recording: an in-page recorder (front camera by default) shown as a SMALL
 * MOVABLE window so the athlete can still see the workout while filming. The
 * clip is bitrate-capped, so a full 2-minute set lands well under the size
 * limit. A "choose file" fallback is kept for pre-recorded clips.
 *
 * Naming: the movement is picked from the CURRENT page's workouts — from
 * window.RXS_WORKOUTS if the page sets it, otherwise scraped from the strength
 * pages' exercise cards — plus a free-text "Other…" option.
 */
(function () {
  var SESSION = "";
  try { SESSION = (document.currentScript && document.currentScript.getAttribute("data-session")) || ""; } catch (e) {}
  if (!window.RoxReview) { console.warn("[review-submit] review-client.js not loaded"); return; }

  var MAX_MB = 300;                 // per-clip cap (matches the worker's REVIEW_MAX_BYTES)
  var REC_BITRATE = 2500000;        // ~2.5 Mbps video → a 2-min clip ≈ 40 MB
  var REC_MAX_SEC = 180;            // hard ceiling so a forgotten recording can't balloon

  var CSS = ""
    + ".rxs-fab{position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:9000;"
    + "font-family:'Marcellus',Georgia,serif;font-size:11px;line-height:1.15;letter-spacing:.04em;color:#1a1206;background:linear-gradient(180deg,#e6c088,#d4a868);"
    + "border:none;border-radius:100px;padding:8px 13px;max-width:62vw;box-shadow:0 6px 20px rgba(0,0,0,.42);cursor:pointer;display:flex;align-items:center;gap:6px;}"
    + ".rxs-fab:hover{filter:brightness(1.06);}"
    + ".rxs-ov{position:fixed;inset:0;z-index:9001;background:rgba(4,2,10,.72);backdrop-filter:blur(4px);display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 14px;}"
    + ".rxs-ov.on{display:flex;}"
    + ".rxs-card{width:min(560px,96vw);background:linear-gradient(180deg,#15102a,#0a0618);border:1px solid rgba(139,111,44,.4);border-radius:18px;color:#e8dcc0;font-family:'EB Garamond',Georgia,serif;padding:18px 18px 20px;box-shadow:0 24px 70px rgba(0,0,0,.6);}"
    + ".rxs-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;}"
    + ".rxs-h h3{font-family:'Cinzel Decorative',serif;font-size:18px;color:#f4ebd6;font-weight:700;}"
    + ".rxs-x{background:none;border:1px solid rgba(139,111,44,.4);color:#d4a868;border-radius:10px;width:32px;height:32px;cursor:pointer;font-size:16px;}"
    + ".rxs-sub{font-style:italic;color:#d4c4a0;font-size:13px;margin-bottom:14px;}"
    + ".rxs-lab{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6a6478;margin:12px 0 5px;}"
    + ".rxs-inp,.rxs-sel{width:100%;background:rgba(6,3,15,.6);border:1px solid rgba(139,111,44,.3);border-radius:10px;color:#f4ebd6;font-family:inherit;font-size:15px;padding:10px 12px;}"
    + ".rxs-inp:focus,.rxs-sel:focus{outline:none;border-color:#d4a868;}"
    + ".rxs-sel{appearance:none;-webkit-appearance:none;background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' fill='none' stroke='%23d4a868' stroke-width='1.6'/></svg>\");background-repeat:no-repeat;background-position:right 12px center;padding-right:30px;}"
    + ".rxs-btn{font-family:'Marcellus',serif;font-size:13px;letter-spacing:.06em;border-radius:10px;padding:11px 16px;cursor:pointer;border:1px solid rgba(139,111,44,.4);background:rgba(12,8,32,.5);color:#d4c4a0;}"
    + ".rxs-btn.gold{background:linear-gradient(180deg,#e6c088,#d4a868);color:#1a1206;border-color:transparent;font-weight:600;}"
    + ".rxs-btn:disabled{opacity:.45;cursor:default;}"
    + ".rxs-prev{width:100%;border-radius:12px;margin-top:10px;background:#000;max-height:240px;}"
    + ".rxs-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px;}"
    + ".rxs-bar{height:8px;border-radius:6px;background:rgba(46,38,64,.6);overflow:hidden;margin-top:10px;display:none;}"
    + ".rxs-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#d4a868,#e6c088);transition:width .2s;}"
    + ".rxs-msg{font-size:13px;margin-top:10px;padding:8px 11px;border-radius:9px;display:none;}"
    + ".rxs-msg.ok{color:#7bd88f;background:rgba(123,216,143,.08);border:1px solid rgba(123,216,143,.3);}"
    + ".rxs-msg.err{color:#e0b24a;background:rgba(224,178,74,.08);border:1px solid rgba(224,178,74,.3);}"
    + ".rxs-list{margin-top:16px;border-top:1px solid rgba(139,111,44,.25);padding-top:12px;}"
    + ".rxs-item{border:1px solid rgba(139,111,44,.25);border-radius:12px;padding:10px 12px;margin-top:8px;background:rgba(12,8,32,.4);}"
    + ".rxs-item .t{display:flex;justify-content:space-between;gap:8px;align-items:center;}"
    + ".rxs-bdg{font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:3px 7px;border-radius:100px;font-family:'Marcellus',serif;}"
    + ".rxs-bdg.pending{color:#e0b24a;border:1px solid rgba(224,178,74,.4);}"
    + ".rxs-bdg.reviewed{color:#7bd88f;border:1px solid rgba(123,216,143,.4);}"
    + ".rxs-fb{margin-top:8px;font-size:14px;color:#e8dcc0;background:rgba(6,3,15,.5);border-left:2px solid #d4a868;padding:8px 11px;border-radius:0 8px 8px 0;white-space:pre-wrap;}"
    + ".rxs-del{background:none;border:none;color:#b54156;cursor:pointer;font-size:12px;}"
    + ".rxs-muted{color:#6a6478;font-size:13px;font-style:italic;}"
    // ---- movable recorder window ----
    + ".rxs-rec{position:fixed;z-index:9100;width:184px;background:#0a0618;border:1px solid rgba(212,168,104,.55);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.7);overflow:hidden;display:none;touch-action:none;}"
    + ".rxs-rec.on{display:block;}"
    + ".rxs-rec-hd{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;cursor:grab;background:rgba(212,168,104,.12);font-family:'Marcellus',serif;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#d4c4a0;}"
    + ".rxs-rec-hd:active{cursor:grabbing;}"
    + ".rxs-rec-vid{width:100%;display:block;background:#000;aspect-ratio:3/4;object-fit:cover;transform:scaleX(-1);}"
    + ".rxs-rec-ct{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px;}"
    + ".rxs-rec-btn{width:40px;height:40px;border-radius:100px;border:2px solid #fff;background:#e0444f;cursor:pointer;padding:0;}"
    + ".rxs-rec-btn.stop{border-radius:8px;background:#e0444f;width:34px;height:34px;}"
    + ".rxs-mini{background:none;border:1px solid rgba(212,168,104,.4);color:#d4c4a0;border-radius:8px;min-width:34px;height:34px;cursor:pointer;font-size:14px;padding:0 6px;}"
    + ".rxs-rec-dot{width:8px;height:8px;border-radius:100px;background:#e0444f;display:inline-block;margin-right:5px;animation:rxsPulse 1s infinite;}"
    + "@keyframes rxsPulse{50%{opacity:.25;}}";

  var style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);

  var fab = document.createElement("button");
  fab.className = "rxs-fab";
  fab.innerHTML = '<span aria-hidden="true">&#127909;</span> Video your form &amp; send to coach';
  document.body.appendChild(fab);

  var ov = document.createElement("div");
  ov.className = "rxs-ov";
  ov.innerHTML =
    '<div class="rxs-card" role="dialog" aria-modal="true">'
    + '<div class="rxs-h"><h3>Send your form to coach</h3><button class="rxs-x" aria-label="Close">&times;</button></div>'
    + '<div class="rxs-sub" id="rxsSub">Record a set (front camera, in a little movable window so you can still see your workout), tag the movement, and David will mark it up.</div>'
    + '<div id="rxsForm">'
    + '<div class="rxs-lab">Movement</div>'
    + '<select class="rxs-sel" id="rxsMoveSel"></select>'
    + '<input class="rxs-inp" id="rxsMove" placeholder="Name the movement" style="margin-top:8px;display:none" />'
    + '<div class="rxs-row">'
    + '<button class="rxs-btn gold" id="rxsRec">&#128247; Record (front cam)</button>'
    + '<button class="rxs-btn" id="rxsPick">Choose a clip</button>'
    + '<button class="rxs-btn gold" id="rxsSend" disabled>Send to coach</button>'
    + '<input type="file" accept="video/*" id="rxsFile" style="display:none" />'
    + '</div>'
    + '<video class="rxs-prev" id="rxsPrev" controls playsinline style="display:none"></video>'
    + '<div class="rxs-bar" id="rxsBar"><i></i></div>'
    + '<div class="rxs-msg" id="rxsMsg"></div>'
    + '</div>'
    + '<div class="rxs-list" id="rxsList"></div>'
    + '</div>';
  document.body.appendChild(ov);

  // Movable recorder window (separate from the modal so it stays on top of the
  // workout page while the modal is closed).
  var rec = document.createElement("div");
  rec.className = "rxs-rec";
  rec.innerHTML =
    '<div class="rxs-rec-hd" id="rxsRecHd"><span id="rxsRecTime">&#9210; ready</span><span style="opacity:.7">drag &#10021;</span></div>'
    + '<video class="rxs-rec-vid" id="rxsRecVid" muted autoplay playsinline></video>'
    + '<div class="rxs-rec-ct">'
    + '<button class="rxs-mini" id="rxsFlip" title="Flip camera">&#8635;</button>'
    + '<button class="rxs-rec-btn" id="rxsRecToggle" title="Start recording" aria-label="Start recording"></button>'
    + '<button class="rxs-mini" id="rxsRecCancel" title="Cancel">&times;</button>'
    + '</div>';
  document.body.appendChild(rec);

  var $ = function (id) { return ov.querySelector(id) || rec.querySelector(id); };
  var file = null, previewUrl = null;

  function open() { ov.classList.add("on"); document.body.style.overflow = "hidden"; buildMovements(); render(); }
  function close() { ov.classList.remove("on"); document.body.style.overflow = ""; }
  fab.onclick = open;
  ov.querySelector(".rxs-x").onclick = close;
  ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
  window.addEventListener("keydown", function (e) { if (e.key === "Escape" && ov.classList.contains("on")) close(); });

  function msg(t, kind) { var m = $("#rxsMsg"); m.textContent = t || ""; m.className = "rxs-msg" + (t ? " " + kind : ""); m.style.display = t ? "block" : "none"; }
  function fmtDate(t) { try { return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function fmtSize(b) { b = b || 0; return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  /* ---- Movement names: from the current page's workouts ---- */
  function pageWorkouts() {
    // 1) explicit list the page may publish
    try {
      if (Array.isArray(window.RXS_WORKOUTS) && window.RXS_WORKOUTS.length) {
        return window.RXS_WORKOUTS.map(function (s) { return String(s).trim(); }).filter(Boolean);
      }
    } catch (e) {}
    // 2) scrape the strength pages' exercise cards (the <h2> movement name)
    var out = [], seen = {};
    try {
      document.querySelectorAll(".exercise-card .card-title-block h2, .exercise-card h2").forEach(function (h) {
        var t = (h.textContent || "").replace(/\s+/g, " ").trim();
        if (t && !seen[t]) { seen[t] = 1; out.push(t); }
      });
    } catch (e) {}
    return out;
  }
  var OTHER = "✎  Other / type my own…";
  function buildMovements() {
    var sel = $("#rxsMoveSel"), names = pageWorkouts();
    sel.innerHTML = "";
    names.forEach(function (n) { var o = document.createElement("option"); o.value = n; o.textContent = n.length > 70 ? n.slice(0, 68) + "…" : n; sel.appendChild(o); });
    var o2 = document.createElement("option"); o2.value = "__other__"; o2.textContent = OTHER; sel.appendChild(o2);
    // default to "Other" (free text) when the page exposes no workouts
    sel.value = names.length ? names[0] : "__other__";
    onMoveSel();
  }
  function onMoveSel() { var custom = $("#rxsMoveSel").value === "__other__"; var inp = $("#rxsMove"); inp.style.display = custom ? "block" : "none"; if (custom) inp.focus(); }
  function chosenMovement() { var sel = $("#rxsMoveSel"); if (sel.value === "__other__") return $("#rxsMove").value.trim(); return sel.value.trim(); }

  /* ---- Clip selection (record or file) ---- */
  function clearPreview() { if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; } }
  function setClip(blob) {
    clearPreview();
    var prev = $("#rxsPrev");
    if (!blob) { file = null; prev.style.display = "none"; $("#rxsSend").disabled = true; return; }
    if (blob.size > MAX_MB * 1024 * 1024) {
      file = null; $("#rxsSend").disabled = true;
      msg("That clip is over " + MAX_MB + " MB (" + fmtSize(blob.size) + ") — record a shorter set or pick a smaller file.", "err");
      return;
    }
    file = blob;
    previewUrl = URL.createObjectURL(blob); prev.src = previewUrl; prev.style.display = "block";
    $("#rxsSend").disabled = false; msg("", "");
  }

  $("#rxsMoveSel").onchange = onMoveSel;
  $("#rxsPick").onclick = function () { $("#rxsFile").click(); };
  $("#rxsFile").onchange = function (e) { setClip(e.target.files && e.target.files[0]); };

  /* ---- In-page recorder (front cam, movable window) ---- */
  var stream = null, recorder = null, chunks = [], facing = "user", recording = false, recT = null, recS = 0;

  function pickMime() {
    var c = ["video/mp4;codecs=h264,aac", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    for (var i = 0; i < c.length; i++) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch (e) {} }
    return "";
  }
  function camSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }

  async function startCamera() {
    stopStream();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
    var v = $("#rxsRecVid");
    v.srcObject = stream;
    v.style.transform = (facing === "user") ? "scaleX(-1)" : "none"; // mirror selfie preview only
    try { await v.play(); } catch (e) {}
  }
  function stopStream() { if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; } }

  async function openRecorder() {
    if (!camSupported()) { msg("This browser can’t record in-page — use “Choose a clip” instead.", "err"); return; }
    msg("", "");
    close(); // hide the modal so the workout stays visible behind the mini window
    placeRecorder();
    rec.classList.add("on");
    setRecBtn(false); $("#rxsFlip").style.display = "";
    $("#rxsRecTime").innerHTML = "&#9210; ready";
    try { await startCamera(); }
    catch (e) { rec.classList.remove("on"); open(); msg("Couldn’t open the camera — check permissions, or use “Choose a clip”.", "err"); }
  }
  function placeRecorder() {
    var w = 184, h = 280;
    rec.style.left = Math.max(8, window.innerWidth - w - 14) + "px";
    rec.style.top = Math.max(8, window.innerHeight - h - 14) + "px";
  }
  function setRecBtn(isRec) {
    var b = $("#rxsRecToggle");
    b.className = "rxs-rec-btn" + (isRec ? " stop" : "");
    b.title = isRec ? "Stop recording" : "Start recording";
    b.setAttribute("aria-label", b.title);
  }
  function tickTime() {
    recS++;
    var m = Math.floor(recS / 60), s = recS % 60;
    $("#rxsRecTime").innerHTML = '<span class="rxs-rec-dot"></span>' + m + ":" + (s < 10 ? "0" : "") + s;
    if (recS >= REC_MAX_SEC) stopRecording();
  }
  function beginRecording() {
    if (!stream) return;
    chunks = []; recS = 0;
    var m = pickMime();
    try { recorder = m ? new MediaRecorder(stream, { mimeType: m, videoBitsPerSecond: REC_BITRATE, audioBitsPerSecond: 128000 }) : new MediaRecorder(stream); }
    catch (e) { try { recorder = new MediaRecorder(stream); } catch (e2) { msg("Recording isn’t supported here — use “Choose a clip”.", "err"); return; } }
    recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = function () {
      var type = (recorder && recorder.mimeType) || m || "video/webm";
      var blob = new Blob(chunks, { type: type });
      stopStream(); rec.classList.remove("on");
      open(); // back to the modal with the clip ready to review + send
      setClip(blob);
    };
    recorder.start();
    recording = true; setRecBtn(true); $("#rxsFlip").style.display = "none";
    recT = setInterval(tickTime, 1000); tickTime.call(null); recS = 0; $("#rxsRecTime").innerHTML = '<span class="rxs-rec-dot"></span>0:00';
  }
  function stopRecording() {
    if (recT) { clearInterval(recT); recT = null; }
    recording = false;
    if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch (e) {} }
    else { stopStream(); rec.classList.remove("on"); open(); }
  }
  function cancelRecorder() {
    if (recT) { clearInterval(recT); recT = null; }
    if (recorder && recorder.state !== "inactive") { try { recorder.onstop = null; recorder.stop(); } catch (e) {} }
    recording = false; recorder = null; stopStream(); rec.classList.remove("on"); open();
  }

  $("#rxsRec").onclick = function () { openRecorder(); };
  $("#rxsRecToggle").onclick = function () { if (recording) stopRecording(); else beginRecording(); };
  $("#rxsRecCancel").onclick = cancelRecorder;
  $("#rxsFlip").onclick = async function () {
    if (recording) return;
    facing = (facing === "user") ? "environment" : "user";
    try { await startCamera(); } catch (e) { facing = (facing === "user") ? "environment" : "user"; msg("Couldn’t switch camera.", "err"); }
  };

  // Drag the recorder window by its header (pointer events → works on touch).
  (function () {
    var hd = $("#rxsRecHd"), dragging = false, dx = 0, dy = 0;
    hd.addEventListener("pointerdown", function (e) {
      dragging = true; var r = rec.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top;
      try { hd.setPointerCapture(e.pointerId); } catch (er) {}
    });
    hd.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var x = Math.min(window.innerWidth - rec.offsetWidth, Math.max(0, e.clientX - dx));
      var y = Math.min(window.innerHeight - rec.offsetHeight, Math.max(0, e.clientY - dy));
      rec.style.left = x + "px"; rec.style.top = y + "px";
    });
    hd.addEventListener("pointerup", function (e) { dragging = false; try { hd.releasePointerCapture(e.pointerId); } catch (er) {} });
    window.addEventListener("resize", function () { if (rec.classList.contains("on")) placeRecorder(); });
  })();

  /* ---- Send ---- */
  $("#rxsSend").onclick = function () {
    if (!file) return;
    if (!RoxReview.authed()) { msg("Sign in on the hub first, then resend.", "err"); return; }
    var move = chosenMovement();
    var qs = new URLSearchParams();
    if (move) qs.set("movement", move);
    if (SESSION) qs.set("session", SESSION);
    var bar = $("#rxsBar"), fill = bar.querySelector("i");
    bar.style.display = "block"; fill.style.width = "0%";
    $("#rxsSend").disabled = true; $("#rxsRec").disabled = true; $("#rxsPick").disabled = true; msg("", "");
    var xhr = new XMLHttpRequest();
    xhr.open("POST", RoxReview.workerUrl() + "/review/upload?" + qs.toString());
    xhr.setRequestHeader("authorization", "Bearer " + RoxReview.token());
    xhr.setRequestHeader("content-type", file.type || "video/mp4");
    xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) fill.style.width = Math.round((ev.loaded / ev.total) * 100) + "%"; };
    xhr.onload = function () {
      bar.style.display = "none"; $("#rxsSend").disabled = false; $("#rxsRec").disabled = false; $("#rxsPick").disabled = false;
      var d = {}; try { d = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        msg("Sent to coach! David will review it and your feedback shows up here.", "ok");
        setClip(null); $("#rxsFile").value = "";
        render();
      } else {
        msg((d && d.error) || ("Upload failed (" + xhr.status + ")"), "err");
      }
    };
    xhr.onerror = function () { bar.style.display = "none"; $("#rxsSend").disabled = false; $("#rxsRec").disabled = false; $("#rxsPick").disabled = false; msg("Network error — check your connection and retry.", "err"); };
    xhr.send(file);
  };

  async function render() {
    var form = $("#rxsForm"), list = $("#rxsList");
    if (!RoxReview.authed()) {
      form.style.display = "none";
      list.innerHTML = '<div class="rxs-muted">Sign in on the hub to send clips to your coach. <a href="enter.html" style="color:#d4a868">Sign in →</a></div>';
      return;
    }
    form.style.display = "block";
    list.innerHTML = '<div class="rxs-muted">Loading your clips…</div>';
    try {
      var me = RoxReview.user();
      var items = (await RoxReview.list()).filter(function (it) { return !me || it.owner === me; });
      if (!items.length) { list.innerHTML = '<div class="rxs-muted">No clips yet — send your first set above.</div>'; return; }
      list.innerHTML = '<div class="rxs-lab">Your clips</div>';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var st = it.status === "reviewed" ? "reviewed" : "pending"; // whitelist (never trust raw into HTML)
        var el = document.createElement("div"); el.className = "rxs-item";
        el.innerHTML = '<div class="t"><b>' + esc(it.movement || "(untagged)") + (it.session ? ' · ' + esc(it.session) : '') + '</b>'
          + '<span class="rxs-bdg ' + st + '">' + st + '</span></div>'
          + '<div class="rxs-muted" style="margin-top:3px">' + fmtDate(it.createdAt) + ' · ' + fmtSize(it.size) + '</div>'
          + '<div data-fb="' + esc(it.id) + '"></div>'
          + '<div style="margin-top:6px"><button class="rxs-del" data-del="' + esc(it.id) + '">Delete</button></div>';
        list.appendChild(el);
        if (it.hasFeedback) loadFeedback(it.id, el.querySelector('[data-fb]'));
      }
      list.querySelectorAll("[data-del]").forEach(function (b) {
        b.onclick = async function () { if (!confirm("Delete this clip?")) return; try { await RoxReview.remove(b.getAttribute("data-del")); render(); } catch (e) { msg(e.message || "Couldn’t delete.", "err"); } };
      });
    } catch (e) { list.innerHTML = '<div class="rxs-muted">' + esc(e.message || "Couldn’t load your clips.") + '</div>'; }
  }
  async function loadFeedback(id, mount) {
    try { var it = await RoxReview.item(id); if (it && it.feedback && it.feedback.text) mount.innerHTML = '<div class="rxs-fb">' + esc(it.feedback.text) + '</div>'; }
    catch (e) { /* ignore */ }
  }
})();
