/* RoxReview — shared client for the async video-coaching queue.
 * Talks to the RoxLive sync Worker's /review/* routes using the same
 * roxlive.session bearer token the hub login sets. Used by the strength
 * pages (athlete submit) and coach-review.html (coach review).
 */
(function () {
  var URL_DEFAULT = "https://roxlive-sync.david-singson.workers.dev";
  function workerUrl() {
    try { return (localStorage.getItem("roxlive.syncUrl") || "").trim() || URL_DEFAULT; } catch (e) { return URL_DEFAULT; }
  }
  function token() {
    try { return localStorage.getItem("roxlive.session") || ""; } catch (e) { return ""; }
  }
  function user() {
    try { return (localStorage.getItem("hcUser") || sessionStorage.getItem("hcUser") || "").toLowerCase(); } catch (e) { return ""; }
  }
  function authed() { return !!token(); }

  function auth() { return { authorization: "Bearer " + token() }; }
  async function asJson(res) {
    var d = {};
    try { d = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error((d && d.error) || (res.status === 503 ? "Coach review isn't set up on the server yet." : "request failed (" + res.status + ")"));
    return d;
  }

  /** Upload a clip File/Blob. opts: { movement, session, note } */
  async function upload(file, opts) {
    opts = opts || {};
    if (!authed()) throw new Error("Sign in first.");
    var qs = new URLSearchParams();
    if (opts.movement) qs.set("movement", opts.movement);
    if (opts.session) qs.set("session", opts.session);
    if (opts.note) qs.set("note", opts.note);
    var res = await fetch(workerUrl() + "/review/upload?" + qs.toString(), {
      method: "POST",
      headers: Object.assign({ "content-type": file.type || "video/mp4" }, auth()),
      body: file,
    });
    return asJson(res);
  }
  async function list() {
    var res = await fetch(workerUrl() + "/review/list", { headers: auth() });
    return (await asJson(res)).items || [];
  }
  async function item(id) {
    var res = await fetch(workerUrl() + "/review/item?id=" + encodeURIComponent(id), { headers: auth() });
    return (await asJson(res)).item;
  }
  /** Download the clip (auth header) and return an object URL for <video>. */
  async function clipBlobUrl(id) {
    var res = await fetch(workerUrl() + "/review/clip?id=" + encodeURIComponent(id), { headers: auth() });
    if (!res.ok) { await asJson(res); }
    var b = await res.blob();
    return URL.createObjectURL(b);
  }
  async function feedback(id, payload) {
    var res = await fetch(workerUrl() + "/review/feedback", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, auth()),
      body: JSON.stringify(Object.assign({ id: id }, payload || {})),
    });
    return asJson(res);
  }
  async function remove(id) {
    var res = await fetch(workerUrl() + "/review/delete", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, auth()),
      body: JSON.stringify({ id: id }),
    });
    return asJson(res);
  }

  window.RoxReview = {
    workerUrl: workerUrl, token: token, user: user, authed: authed,
    upload: upload, list: list, item: item, clipBlobUrl: clipBlobUrl, feedback: feedback, remove: remove,
  };
})();
