/* RoxReview submit widget — a floating "Send to coach" button + modal that any
 * athlete can use to send a movement clip to David's Form Review queue and read
 * his feedback. Drop-in: include review-client.js then this file. Optional
 * data-session="A" on the script tag pre-tags the clip with the session.
 *
 * Reused across the strength pages (A–D) and RoxLive — one widget everywhere.
 */
(function () {
  var SESSION = "";
  try { SESSION = (document.currentScript && document.currentScript.getAttribute("data-session")) || ""; } catch (e) {}
  if (!window.RoxReview) { console.warn("[review-submit] review-client.js not loaded"); return; }

  var CSS = ""
    + ".rxs-fab{position:fixed;right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));z-index:9000;"
    + "font-family:'Marcellus',Georgia,serif;font-size:13px;letter-spacing:.06em;color:#1a1206;background:linear-gradient(180deg,#e6c088,#d4a868);"
    + "border:none;border-radius:100px;padding:12px 18px;box-shadow:0 8px 28px rgba(0,0,0,.45);cursor:pointer;display:flex;align-items:center;gap:8px;}"
    + ".rxs-fab:hover{filter:brightness(1.06);}"
    + ".rxs-ov{position:fixed;inset:0;z-index:9001;background:rgba(4,2,10,.72);backdrop-filter:blur(4px);display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 14px;}"
    + ".rxs-ov.on{display:flex;}"
    + ".rxs-card{width:min(560px,96vw);background:linear-gradient(180deg,#15102a,#0a0618);border:1px solid rgba(139,111,44,.4);border-radius:18px;color:#e8dcc0;font-family:'EB Garamond',Georgia,serif;padding:18px 18px 20px;box-shadow:0 24px 70px rgba(0,0,0,.6);}"
    + ".rxs-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;}"
    + ".rxs-h h3{font-family:'Cinzel Decorative',serif;font-size:18px;color:#f4ebd6;font-weight:700;}"
    + ".rxs-x{background:none;border:1px solid rgba(139,111,44,.4);color:#d4a868;border-radius:10px;width:32px;height:32px;cursor:pointer;font-size:16px;}"
    + ".rxs-sub{font-style:italic;color:#d4c4a0;font-size:13px;margin-bottom:14px;}"
    + ".rxs-lab{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6a6478;margin:12px 0 5px;}"
    + ".rxs-inp{width:100%;background:rgba(6,3,15,.6);border:1px solid rgba(139,111,44,.3);border-radius:10px;color:#f4ebd6;font-family:inherit;font-size:15px;padding:10px 12px;}"
    + ".rxs-inp:focus{outline:none;border-color:#d4a868;}"
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
    + ".rxs-muted{color:#6a6478;font-size:13px;font-style:italic;}";

  var style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);

  var fab = document.createElement("button");
  fab.className = "rxs-fab";
  fab.innerHTML = '<span aria-hidden="true">&#127909;</span> Send to coach';
  document.body.appendChild(fab);

  var ov = document.createElement("div");
  ov.className = "rxs-ov";
  ov.innerHTML =
    '<div class="rxs-card" role="dialog" aria-modal="true">'
    + '<div class="rxs-h"><h3>Send your form to coach</h3><button class="rxs-x" aria-label="Close">&times;</button></div>'
    + '<div class="rxs-sub" id="rxsSub">Record a set (or pick a clip), tag the movement, and David will mark it up and send feedback.</div>'
    + '<div id="rxsForm">'
    + '<div class="rxs-lab">Movement</div>'
    + '<input class="rxs-inp" id="rxsMove" placeholder="e.g. Back squat, Deadlift, 400m run" />'
    + '<div class="rxs-row">'
    + '<button class="rxs-btn" id="rxsPick">&#128247; Record / choose clip</button>'
    + '<button class="rxs-btn gold" id="rxsSend" disabled>Send to coach</button>'
    + '<input type="file" accept="video/*" capture="environment" id="rxsFile" style="display:none" />'
    + '</div>'
    + '<video class="rxs-prev" id="rxsPrev" controls playsinline style="display:none"></video>'
    + '<div class="rxs-bar" id="rxsBar"><i></i></div>'
    + '<div class="rxs-msg" id="rxsMsg"></div>'
    + '</div>'
    + '<div class="rxs-list" id="rxsList"></div>'
    + '</div>';
  document.body.appendChild(ov);

  var $ = function (id) { return ov.querySelector(id); };
  var file = null, previewUrl = null;

  function open() { ov.classList.add("on"); document.body.style.overflow = "hidden"; render(); }
  function close() { ov.classList.remove("on"); document.body.style.overflow = ""; }
  fab.onclick = open;
  ov.querySelector(".rxs-x").onclick = close;
  ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
  window.addEventListener("keydown", function (e) { if (e.key === "Escape" && ov.classList.contains("on")) close(); });

  function msg(t, kind) { var m = $("#rxsMsg"); m.textContent = t || ""; m.className = "rxs-msg" + (t ? " " + kind : ""); m.style.display = t ? "block" : "none"; }
  function fmtDate(t) { try { return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function fmtSize(b) { b = b || 0; return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  $("#rxsPick").onclick = function () { $("#rxsFile").click(); };
  $("#rxsFile").onchange = function (e) {
    file = e.target.files && e.target.files[0];
    var prev = $("#rxsPrev");
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (file) {
      if (file.size > 150 * 1024 * 1024) { msg("That clip is over 150 MB — trim it or record a shorter set.", "err"); file = null; $("#rxsSend").disabled = true; return; }
      previewUrl = URL.createObjectURL(file); prev.src = previewUrl; prev.style.display = "block";
      $("#rxsSend").disabled = false; msg("", "");
    } else { prev.style.display = "none"; $("#rxsSend").disabled = true; }
  };

  $("#rxsSend").onclick = function () {
    if (!file) return;
    if (!RoxReview.authed()) { msg("Sign in on the hub first, then resend.", "err"); return; }
    var move = $("#rxsMove").value.trim();
    var qs = new URLSearchParams();
    if (move) qs.set("movement", move);
    if (SESSION) qs.set("session", SESSION);
    var bar = $("#rxsBar"), fill = bar.querySelector("i");
    bar.style.display = "block"; fill.style.width = "0%";
    $("#rxsSend").disabled = true; $("#rxsPick").disabled = true; msg("", "");
    var xhr = new XMLHttpRequest();
    xhr.open("POST", RoxReview.workerUrl() + "/review/upload?" + qs.toString());
    xhr.setRequestHeader("authorization", "Bearer " + RoxReview.token());
    xhr.setRequestHeader("content-type", file.type || "video/mp4");
    xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) fill.style.width = Math.round((ev.loaded / ev.total) * 100) + "%"; };
    xhr.onload = function () {
      bar.style.display = "none"; $("#rxsSend").disabled = false; $("#rxsPick").disabled = false;
      var d = {}; try { d = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        msg("Sent to coach! David will review it and your feedback shows up here.", "ok");
        file = null; $("#rxsFile").value = ""; $("#rxsPrev").style.display = "none"; $("#rxsSend").disabled = true; $("#rxsMove").value = "";
        render();
      } else {
        msg((d && d.error) || ("Upload failed (" + xhr.status + ")"), "err");
      }
    };
    xhr.onerror = function () { bar.style.display = "none"; $("#rxsSend").disabled = false; $("#rxsPick").disabled = false; msg("Network error — check your connection and retry.", "err"); };
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
