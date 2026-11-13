const T = window.__TAURI__;
const invoke = T.core.invoke;
// A missing element must never break startup: $ returns a detached stub (and warns once) instead of null.
const _stubs = {};
const $ = (id) => {
  const el = document.getElementById(id);
  if (el) return el;
  if (!_stubs[id]) { console.warn("missing element #" + id); _stubs[id] = document.createElement("div"); }
  return _stubs[id];
};
const on = (id, ev, fn) => {
  const el = document.getElementById(id);
  if (!el) { console.warn("on(): missing element #" + id); return; }
  el.addEventListener(ev, fn);
};
const safe = async (label, fn) => { try { return await fn(); } catch (e) { console.warn(label + " failed:", e); } };
const listen = (name, fn) => { try { const r = T.event.listen(name, fn); if (r && r.catch) r.catch((e) => console.warn("listen " + name, e)); } catch (e) { console.warn("listen " + name, e); } };
let state = {};

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3000);
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === name));
  if (name === "settings") refreshState();
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- history ----------
function rel(v) {
  if (!v) return "";
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  if (isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
  return new Date(t).toLocaleDateString("en-US");
}

async function loadHistory() {
  const items = await invoke("get_history");
  const ul = $("list");
  ul.textContent = "";
  $("empty").hidden = items.length > 0;
  $("count").textContent = items.length ? items.length + (items.length === 1 ? " download" : " downloads") : "";
  $("clear").hidden = !items.length;
  for (const it of items) {
    const li = document.createElement("li");
    const title = document.createElement("div");
    title.className = "title"; title.textContent = it.title || it.file || "(untitled)"; title.title = it.title || "";
    const meta = document.createElement("div");
    meta.className = "meta";
    if (it.audio) { const b = document.createElement("span"); b.className = "badge"; b.textContent = "MP3"; meta.append(b); }
    const l = document.createElement("span"); l.textContent = [it.label, rel(it.finishedAt)].filter(Boolean).join(" · ");
    meta.append(l);
    const acts = document.createElement("div");
    acts.className = "acts";
    const open = document.createElement("button"); open.textContent = "Open";
    open.onclick = () => invoke("open_path", { path: it.file }).catch((e) => toast(e));
    const rev = document.createElement("button"); rev.textContent = "Show in folder";
    rev.onclick = () => invoke("reveal_path", { path: it.file }).catch((e) => toast(e));
    acts.append(open, rev);
    li.append(title, meta, acts);
    ul.append(li);
  }
}
// ---------- active (in-progress) downloads ----------
let activeCount = 0;
function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
// optimistic feedback: id -> { action, status (at click time), until }
const pending = new Map();
function ctl(it, action) {
  pending.set(it.id, { action, status: it.status || "running", until: Date.now() + 3000 });
  loadActive();
  setTimeout(loadActive, 3100);
  invoke("control_download", { id: it.id, action }).catch((e) => { pending.delete(it.id); toast(String(e)); loadActive(); });
}
function iconBtn(text, title, onclick, disabled) {
  const b = mk("button", "icon", text);
  b.title = title; b.setAttribute("aria-label", title);
  b.disabled = !!disabled; b.onclick = onclick;
  return b;
}
async function loadActive() {
  let items = [];
  try { items = await invoke("get_active"); } catch (_) {}
  const ul = $("active-list");
  ul.textContent = "";
  $("active-wrap").hidden = items.length === 0;
  const ids = new Set(items.map((i) => i.id));
  for (const k of [...pending.keys()]) if (!ids.has(k)) pending.delete(k);
  for (const it of items) {
    const paused = it.status === "paused";
    const pend = pending.get(it.id);
    // a pending pause/resume is over once active.json reflects it (or ~3 s passed); cancel stays until the row vanishes
    const pendingActive = !!pend && (pend.action === "cancel" ? Date.now() < pend.until + 60000 : pend.status === (it.status || "running") && Date.now() < pend.until);
    if (pend && !pendingActive) pending.delete(it.id);
    const li = mk("li", "act" + (paused ? " paused" : ""));
    const head = mk("div", "head");
    head.append(mk("div", "title", it.title || it.url || "(untitled)"));
    const btns = mk("div", "ctl");
    btns.append(
      paused
        ? iconBtn("▶", "Resume", () => ctl(it, "resume"), pendingActive)
        : iconBtn("⏸", "Pause", () => ctl(it, "pause"), pendingActive),
      iconBtn("✕", "Cancel", () => ctl(it, "cancel"), pendingActive && pend.action === "cancel")
    );
    head.append(btns);
    li.append(head);
    const meta = mk("div", "meta");
    if (it.audio) meta.append(mk("span", "badge", "MP3"));
    if (it.stage > 0) meta.append(mk("span", "stage", "Audio"));
    if (it.label) meta.append(mk("span", null, it.label));
    li.append(meta);
    const pct = Math.max(0, Math.min(100, Number(it.percent) || 0));
    const bar = mk("div", "progress");
    const fill = mk("div", "fill");
    if (pct >= 100 && !paused) fill.classList.add("indet"); else fill.style.width = pct + "%";
    bar.append(fill);
    li.append(bar);
    const row = mk("div", "row2");
    if (paused) {
      row.append(mk("span", null, "Paused"));
      row.append(mk("span", null, (Math.round(pct * 10) / 10) + "%"));
    } else if (pct >= 100) {
      row.append(mk("span", null, "Processing…"));
    } else {
      row.append(mk("span", null, (Math.round(pct * 10) / 10) + "%"));
      row.append(mk("span", null, [it.speed, it.eta ? it.eta + " left" : ""].filter(Boolean).join(" · ")));
    }
    li.append(row);
    ul.append(li);
  }
  if (items.length < activeCount) loadHistory();
  activeCount = items.length;
}

$("clear").onclick = async () => {
  if (!confirm("Clear history? (Files are not deleted)")) return;
  await invoke("clear_history"); loadHistory();
};

// ---------- settings ----------
function setStatus(id, ok, text) {
  const el = $(id); el.textContent = text; el.className = ok ? "ok" : "bad";
}
async function refreshState() {
  state = await invoke("get_state");
  $("dldir").textContent = state.downloadDir || "-"; $("dldir").title = state.downloadDir || "";
  $("extpath").textContent = state.extensionPath; $("extpath").title = state.extensionPath;
  setStatus("st-ytdlp", !!state.ytdlpVersion, state.ytdlpVersion || (state.ytdlpPresent ? "not working" : "missing"));
  setStatus("st-ffmpeg", state.ffmpegPresent, state.ffmpegPresent ? "present" : "missing");
  setStatus("st-reg", state.registered, state.registered ? "OK" : "not registered");
  setStatus("st-host", state.hostExists, state.hostExists ? "present" : "not found");
  refreshExtStatus();
  try { $("autostart").checked = await T.autostart.isEnabled(); } catch (_) {}
  try { $("notify").checked = await invoke("get_notify"); } catch (_) {}
  try { $("autoupd").checked = await invoke("get_auto_update"); } catch (_) {}
  try { $("app-version").textContent = await invoke("get_app_version"); } catch (_) {}
  return state;
}

$("pick").onclick = async () => {
  const dir = await T.dialog.open({ directory: true, defaultPath: state.downloadDir || undefined, title: "Download folder" });
  if (dir) { await invoke("set_download_dir", { dir }); refreshState(); toast("Saved"); }
};
$("autostart").onchange = async (e) => {
  try { e.target.checked ? await T.autostart.enable() : await T.autostart.disable(); }
  catch (err) { toast("Error: " + err); }
};
$("notify").onchange = async (e) => {
  try { await invoke("set_notify", { enabled: e.target.checked }); }
  catch (err) { toast("Error: " + err); }
};
on("autoupd", "change", async (e) => {
  try { await invoke("set_auto_update", { enabled: e.target.checked }); }
  catch (err) { toast("Error: " + err); }
});
listen("update-status", (ev) => {
  const p = ev.payload || {};
  $("upd-status").textContent = p.text || "";
  $("chkupd").disabled = ["checking", "downloading", "waiting", "installing"].includes(p.state);
  if (p.state === "installing") toast(p.text);
});
on("chkupd", "click", async () => {
  const b = $("chkupd"); b.disabled = true; $("upd-status").textContent = "Checking…";
  try { $("upd-status").textContent = await invoke("check_update"); }
  catch (e) { $("upd-status").textContent = "Error: " + e; }
  b.disabled = false;
});
async function doUpdate() {
  const out = $("upd-out"), b = $("upd");
  b.disabled = true; out.hidden = false; out.textContent = "Updating…";
  try { out.textContent = await invoke("update_ytdlp"); } catch (e) { out.textContent = String(e); }
  b.disabled = false; refreshState();
}
$("upd").onclick = doUpdate;
$("log").onclick = () => invoke("open_log").catch((e) => toast(e));
$("openext").onclick = () => invoke("open_extension_dir");
$("repair").onclick = () => { if (confirm("Re-download the tools and repair registrations?")) runSetup(true); };

// ---------- setup ----------
let setupWasFirstRun = false;
function setupView(v) {
  $("setup").hidden = false;
  $("setup-run").hidden = v !== "run"; $("setup-err").hidden = v !== "err"; $("setup-done").hidden = v !== "done";
}
async function runSetup(force) {
  setupView("run");
  $("bar").style.width = "0"; $("bar").classList.add("indet"); $("setup-text").textContent = "Preparing…";
  try {
    await invoke("run_setup", { force });
    await refreshState();
    if (setupWasFirstRun) { setupWasFirstRun = false; $("setup").hidden = true; openWizard(); } else { $("setup").hidden = true; toast("Repair complete"); }
  } catch (e) {
    $("err-text").textContent = String(e); setupView("err");
  }
}
$("retry").onclick = () => runSetup(setupWasFirstRun ? false : true);
$("finish").onclick = () => { $("setup").hidden = true; setupWasFirstRun = false; openWizard(); };

// ---------- extension setup wizard ----------
const BROWSER_NAMES = { "brave.exe": "Brave", "chrome.exe": "Chrome", "msedge.exe": "Edge" };
const friendlyBrowser = (b) => BROWSER_NAMES[String(b || "").toLowerCase()] || (b && b !== "unknown" && b !== "bilinmiyor" ? b : "unknown");
async function refreshExtStatus() {
  let st = null;
  try { st = await invoke("get_extension_status"); } catch (_) {}
  const el = $("st-ext");
  if (st && st.connectedAt) {
    el.textContent = friendlyBrowser(st.browser) + " · " + rel(st.connectedAt) + " connected";
    el.className = "ok";
  } else {
    el.textContent = "not connected yet"; el.className = "bad";
  }
  return st;
}
const wz = { timer: null, openedAt: 0, hadBefore: false, running: false, startedAt: 0 };
async function copyText(t, msg) {
  try { await navigator.clipboard.writeText(t); toast(msg || "Copied"); }
  catch (_) { toast("Could not copy"); }
}
const STEP_LABEL = { open: "Opening browser", navigate: "Opening browser", devmode: "Enabling developer mode", load: "Loading extension", dialog: "Loading extension", select: "Loading extension", verify: "Verifying" };
// a checklist row is complete when its last sub-step reports ok
const ROW_LAST = { navigate: "open", devmode: "devmode", select: "load", verify: "verify" };
const ROW_ORDER = ["open", "devmode", "load", "verify"];
function setRows(doneKeys, runKey) {
  document.querySelectorAll("#wz-checklist li").forEach((li) => {
    li.classList.toggle("done", doneKeys.includes(li.dataset.k));
    li.classList.toggle("run", li.dataset.k === runKey);
  });
}
function wzView(v) {
  $("wz-main").hidden = v !== "main"; $("wz-run").hidden = v !== "run"; $("wz-ok").hidden = v !== "ok";
}
const wzDone = [];
listen("ext-step", (ev) => {
  const p = ev.payload || {};
  if (!p.step || p.done) return;
  if (p.ok && ROW_LAST[p.step] && !wzDone.includes(ROW_LAST[p.step])) wzDone.push(ROW_LAST[p.step]);
  setRows(wzDone, ROW_ORDER.find((k) => !wzDone.includes(k)));
});
function wzSuccess(name) {
  clearInterval(wz.timer);
  $("wz-ok-text").textContent = "✓ Extension installed" + (name ? " (" + name + ")" : "");
  wzView("ok"); refreshExtStatus();
}
async function extConnectedSince(t) {
  let st = null;
  try { st = await invoke("get_extension_status"); } catch (_) {}
  return st && st.connectedAt && st.connectedAt > t ? st : null;
}
async function autoInstall(b) {
  if (wz.running) return;
  wz.running = true;
  wzDone.length = 0; setRows([], "open"); wzView("run");
  wz.startedAt = Date.now();
  clearInterval(wz.timer);
  let early = null;
  wz.timer = setInterval(async () => { early = early || (await extConnectedSince(wz.startedAt)); }, 1000);
  let res = null, err = null;
  try { res = await invoke("install_extension", { id: b.id }); } catch (e) { err = String(e); }
  clearInterval(wz.timer);
  wz.running = false;
  let st = early || (await extConnectedSince(wz.startedAt));
  if (!st && !(res && res.ok) && !err) {
    // the extension may still be starting: give it a moment to ping the host
    for (let i = 0; i < 4 && !st; i++) { await new Promise((r) => setTimeout(r, 1000)); st = await extConnectedSince(wz.startedAt); }
  }
  if ((res && res.ok) || st) { wzSuccess(st ? friendlyBrowser(st.browser) : b.name); return; }
  const label = STEP_LABEL[res && res.failedStep] || "";
  wzView("main");
  $("wz-fail").hidden = false;
  $("wz-fail").textContent = err
    ? "Could not start automatic setup: " + err
    : "Automatic setup failed" + (label ? " (step: " + label + ")" : "") + ". Try manual setup.";
  showManual(true);
}
function showManual(on) { $("wz-manual").hidden = !on; }
async function openWizard() {
  $("wizard").hidden = false;
  wzView("main"); $("wz-steps").hidden = true; $("wz-fail").hidden = true; showManual(false);
  $("wz-browsers").textContent = ""; $("wz-others").textContent = "";
  const st0 = await refreshExtStatus();
  wz.hadBefore = !!(st0 && st0.connectedAt);
  wz.openedAt = Date.now();
  if (!state.extensionPath) { try { state = await invoke("get_state"); } catch (_) {} }
  $("wz-path").textContent = state.extensionPath || "-";
  let list = [];
  try { list = await invoke("detect_browsers"); } catch (_) {}
  $("wz-nobrowser").hidden = list.length > 0;
  $("wz-auto").hidden = !list.length; $("wz-others").hidden = list.length < 2;
  if (!list.length) {
    showManual(true); $("wz-steps").hidden = false; $("wz-url").textContent = "chrome://extensions";
    $("wz-copyurl").onclick = () => copyText("chrome://extensions");
  }
  const main = list.find((b) => b.isDefault) || list[0];
  if (main) {
    $("wz-auto").textContent = "Install extension (" + main.name + ")";
    $("wz-auto").onclick = () => autoInstall(main);
    for (const b of list.filter((x) => x !== main)) {
      const btn = mk("button", "ghost", "Install for " + b.name);
      btn.onclick = () => autoInstall(b);
      $("wz-others").append(btn);
    }
  }
  for (const b of list) {
    const btn = mk("button", "browser", "Install manually for " + b.name);
    btn.onclick = async () => {
      document.querySelectorAll("button.browser").forEach((x) => x.classList.toggle("sel", x === btn));
      $("wz-url").textContent = b.url;
      $("wz-copyurl").onclick = () => copyText(b.url);
      try {
        const p = await invoke("setup_browser", { id: b.id });
        $("wz-path").textContent = p;
        await copyText(p, "Folder path copied");
      } catch (e) { toast(String(e)); }
      $("wz-steps").hidden = false;
      clearInterval(wz.timer);
      wz.timer = setInterval(pollWizard, 1000);
    };
    $("wz-browsers").append(btn);
  }
  $("wz-copypath").onclick = () => copyText($("wz-path").textContent, "Folder path copied");
}
$("wz-manual-btn").onclick = () => showManual($("wz-manual").hidden);
async function pollWizard() {
  let st = null;
  try { st = await invoke("get_extension_status"); } catch (_) {}
  if (!st || !st.connectedAt) return;
  if (st.connectedAt > wz.openedAt || !wz.hadBefore) wzSuccess(friendlyBrowser(st.browser));
}
function closeWizard() { if (wz.running) return; clearInterval(wz.timer); $("wizard").hidden = true; refreshExtStatus(); }
$("wz-close").onclick = closeWizard;
$("wz-done").onclick = closeWizard;
$("setupext").onclick = openWizard;

listen("setup-progress", (ev) => {
  const p = ev.payload, bar = $("bar");
  $("setup-text").textContent = p.text;
  if (p.pct == null) bar.classList.add("indet"); else { bar.classList.remove("indet"); bar.style.width = p.pct + "%"; }
});
listen("history-changed", loadHistory);
listen("active-changed", loadActive);
listen("navigate", (ev) => showTab(ev.payload));
listen("tray-update", (ev) => {
  const out = $("upd-out");
  out.hidden = false;
  out.textContent = ev.payload === "start" ? "Updating…" : ev.payload;
  if (ev.payload !== "start") refreshState();
});

(async function init() {
  await safe("loadHistory", loadHistory);
  await safe("loadActive", loadActive);
  const s = (await safe("refreshState", refreshState)) || (await safe("get_state", () => invoke("get_state"))) || {};
  if (s.busy) { setupView("run"); return; }
  if (s.needsSetup) { setupWasFirstRun = true; runSetup(false); }
})();
