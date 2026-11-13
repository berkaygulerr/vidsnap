// Vidsnap service worker
// 1) Ağ trafiğinden video akışlarını (m3u8 / mpd / mp4) sekme+frame bazında yakalar
// 2) İçerik betiği ile yerel yardımcı program (yt-dlp) arasında köprü kurar

const HOST = 'com.vidsnap.host';
const MAX_STREAMS_PER_TAB = 40;

// ------------------------------------------------------------------
// Ağ yakalama
// ------------------------------------------------------------------
const streamsMem = new Map(); // tabId -> [{url, kind, frameId, t}]

async function getStreams(tabId) {
  if (streamsMem.has(tabId)) return streamsMem.get(tabId);
  const key = 'streams:' + tabId;
  const data = (await chrome.storage.session.get(key))[key] || [];
  streamsMem.set(tabId, data);
  return data;
}

async function saveStreams(tabId, list) {
  streamsMem.set(tabId, list);
  await chrome.storage.session.set({ ['streams:' + tabId]: list });
}

async function clearStreams(tabId) {
  streamsMem.delete(tabId);
  await chrome.storage.session.remove('streams:' + tabId);
}

function classify(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  let path;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return null; }
  if (/\.(m4s|ts|aac|m4a|vtt|webvtt|key)$/.test(path)) return null; // parça / yan dosya
  if (ct.includes('mpegurl') || path.endsWith('.m3u8')) return 'hls';
  if (ct.includes('dash+xml') || path.endsWith('.mpd')) return 'dash';
  if (/\.(mp4|webm|mov|m4v)$/.test(path) || ct.startsWith('video/')) {
    if (ct.includes('iso.segment')) return null;
    return 'file';
  }
  return null;
}

// Aynı dosyanın byte-range isteklerini tek kayıtta topla
function normalize(url) {
  try {
    const u = new URL(url);
    ['bytestart', 'byteend', 'range', 'rn', 'rbuf'].forEach((p) => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.type === 'main_frame' && d.tabId >= 0) clearStreams(d.tabId); },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const ctHeader = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type');
    const kind = classify(d.url, ctHeader && ctHeader.value);
    if (!kind) return;
    const url = normalize(d.url);
    (async () => {
      const list = await getStreams(d.tabId);
      const existing = list.findIndex((s) => s.url === url);
      if (existing >= 0) list.splice(existing, 1);
      list.unshift({ url, kind, frameId: d.frameId, t: Date.now() });
      if (list.length > MAX_STREAMS_PER_TAB) list.length = MAX_STREAMS_PER_TAB;
      await saveStreams(d.tabId, list);
    })();
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => clearStreams(tabId));

// Eklenti yüklenince/tarayıcı açılınca masaüstü uygulamasına "bağlandım" sinyali (tek seferlik)
function announce() {
  try {
    chrome.runtime.sendNativeMessage(HOST, { type: 'ping', id: 'hello' }, () => void chrome.runtime.lastError);
  } catch {}
}
chrome.runtime.onInstalled.addListener(announce);
chrome.runtime.onStartup.addListener(announce);

// ------------------------------------------------------------------
// Kendini güncelleme: masaüstü uygulaması güncellenince eklenti dosyaları
// diskte değişir. Diskteki sürüm çalışan sürümden farklıysa yeniden yükle.
// Süren/duraklatılmış indirme varken bekle (yeniden yükleme bağlantıyı koparır).
// ------------------------------------------------------------------
async function checkSelfUpdate() {
  try {
    if (downloads.size > 0) return;
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const disk = (await r.json()).version;
    if (disk && disk !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch {}
}
chrome.alarms.create('vidsnap-self-update', { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'vidsnap-self-update') checkSelfUpdate(); });
chrome.runtime.onStartup.addListener(checkSelfUpdate);

// ------------------------------------------------------------------
// Yerel yardımcı program bağlantısı
// ------------------------------------------------------------------
let port = null;
let seq = 0;
const pending = new Map();   // msgId -> {resolve}
const downloads = new Map(); // downloadId -> {tabId, frameId}

function hostMissingMessage(raw) {
  if (/not found|bulunamad/i.test(raw || '')) {
    return 'Vidsnap uygulaması kurulu değil ya da kaydı eksik. Vidsnap uygulamasını açın (Ayarlar → Onar).';
  }
  return 'Yardımcı programla bağlantı koptu: ' + (raw || 'bilinmeyen hata');
}

function getPort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const err = hostMissingMessage(chrome.runtime.lastError && chrome.runtime.lastError.message);
    port = null;
    for (const [, p] of pending) p.resolve({ type: 'error', message: err });
    pending.clear();
    for (const [id, d] of downloads) {
      sendToFrame(d, { evt: 'download', type: 'error', id, message: err });
    }
    downloads.clear();
    updateBadge();
  });
  return port;
}

function request(msg) {
  return new Promise((resolve) => {
    const id = 'm' + (++seq);
    pending.set(id, { resolve });
    try {
      getPort().postMessage({ ...msg, id });
    } catch (e) {
      pending.delete(id);
      resolve({ type: 'error', message: hostMissingMessage(e.message) });
    }
  });
}

function sendToFrame(target, msg) {
  chrome.tabs.sendMessage(target.tabId, msg, { frameId: target.frameId }).catch(() => {});
}

function onHostMessage(msg) {
  if (downloads.has(msg.id)) {
    const target = downloads.get(msg.id);
    // Sadece kesin bitişte eşlemeyi sil (paused/resumed/progress sürerken lazım)
    if (msg.type === 'done' || msg.type === 'error' || msg.type === 'cancelled') {
      downloads.delete(msg.id);
      if (downloads.size === 0) setTimeout(checkSelfUpdate, 5000); // bekleyen güncelleme varsa şimdi uygula
    }
    sendToFrame(target, { evt: 'download', ...msg });
    updateBadge();
    return;
  }
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    p.resolve(msg);
  }
}

function updateBadge() {
  const n = downloads.size;
  chrome.action && chrome.action.setBadgeText && chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

// ------------------------------------------------------------------
// Aday URL'ler + çerezler
// ------------------------------------------------------------------
async function cookiesFor(urls) {
  const seen = new Map();
  for (const url of urls) {
    if (!/^https?:/.test(url || '')) continue;
    try {
      const list = await chrome.cookies.getAll({ url });
      for (const c of list) seen.set(`${c.domain}|${c.path}|${c.name}`, c);
    } catch {}
  }
  return [...seen.values()].map((c) => ({
    domain: c.domain, hostOnly: c.hostOnly, path: c.path, secure: c.secure,
    expirationDate: c.expirationDate, name: c.name, value: c.value,
  }));
}

async function buildCandidates(req, sender) {
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  const frameUrl = req.frameUrl || sender.url;
  const topUrl = sender.tab.url;
  const out = [];
  const add = (url, kind) => {
    if (!url || !/^https?:/.test(url) || out.some((c) => c.url === url)) return;
    out.push({ url, kind });
  };

  (req.primary || []).forEach((u) => add(u, 'page'));
  if (req.direct) add(req.direct, 'file');

  const all = await getStreams(tabId);
  let streams = all.filter((s) => s.frameId === frameId);
  if (streams.length === 0) streams = all;
  // Önce manifest'ler (HLS/DASH), içinde "master" geçenler önde; sonra dosyalar
  const rank = (s) => (s.kind === 'file' ? 2 : 0) + (/master|playlist|manifest/i.test(s.url) ? 0 : 1) * 0.5;
  streams.slice().sort((a, b) => rank(a) - rank(b) || b.t - a.t).slice(0, 4).forEach((s) => add(s.url, s.kind));

  add(frameUrl, 'page');

  for (const c of out) {
    c.cookies = await cookiesFor([c.url, frameUrl, topUrl]);
    if (c.kind !== 'page') {
      c.referer = frameUrl;
      c.userAgent = req.userAgent;
    }
  }
  return out;
}

// ------------------------------------------------------------------
// İçerik betiğinden gelen istekler
// ------------------------------------------------------------------
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (!sender.tab) return;
  (async () => {
    switch (req.cmd) {
      case 'probe': {
        const candidates = await buildCandidates(req, sender);
        if (candidates.length === 0) return { type: 'error', message: 'Bu video için adres bulunamadı.' };
        const res = await request({ type: 'probe', candidates, pageTitle: req.pageTitle });
        // Çerezler sayfa tarafına asla dönmesin
        if (res.candidate) { const { cookies, ...rest } = res.candidate; res.candidate = rest; }
        return res;
      }
      case 'download': {
        downloads.set(req.id, { tabId: sender.tab.id, frameId: sender.frameId });
        updateBadge();
        const cand = req.candidate || {};
        const candidate = {
          url: cand.url, kind: cand.kind, referer: cand.referer, userAgent: cand.userAgent,
          noCookies: !!cand.noCookies,
          cookies: cand.noCookies ? [] : await cookiesFor([cand.url, req.frameUrl || sender.url, sender.tab.url]),
        };
        try {
          getPort().postMessage({ type: 'download', id: req.id, candidate, format: req.format, audio: !!req.audio, title: req.title, label: req.label });
        } catch (e) {
          downloads.delete(req.id);
          return { type: 'error', message: hostMissingMessage(e.message) };
        }
        return { type: 'ok' };
      }
      case 'cancel':
        return request({ type: 'cancel', target: req.id });
      case 'pause':
        return request({ type: 'pause', target: req.id });
      case 'resume':
        return request({ type: 'resume', target: req.id });
      case 'reveal':
        return request({ type: 'reveal', file: req.file });
      default:
        return { type: 'error', message: 'Bilinmeyen komut' };
    }
  })().then(sendResponse);
  return true;
});
