// Vidsnap yerel yardımcı programı (Chrome Native Messaging host)
// Eklentiden gelen istekleri yt-dlp ile işler. stdout SADECE protokol mesajları içindir.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- Veri klasörü ve yapılandırma ----------
// Öncelik: VIDSNAP_CONFIG ortam değişkeni -> %APPDATA%\Vidsnap\config.json -> host.js yanındaki config.json (eski kurulum)
function resolvePaths() {
  if (process.env.VIDSNAP_CONFIG) {
    const cfg = path.resolve(process.env.VIDSNAP_CONFIG);
    return { configPath: cfg, dataDir: path.dirname(cfg) };
  }
  if (process.env.APPDATA) {
    const dir = path.join(process.env.APPDATA, 'Vidsnap');
    const cfg = path.join(dir, 'config.json');
    try { if (fs.existsSync(cfg)) return { configPath: cfg, dataDir: dir }; } catch {}
  }
  return { configPath: path.join(__dirname, 'config.json'), dataDir: __dirname };
}
const { configPath: CONFIG_PATH, dataDir: DATA_DIR } = resolvePaths();
const LOG_PATH = path.join(DATA_DIR, 'host.log');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');

// Günlük 2 MB'ı aşmışsa başlangıçta host.log.1'e döndür (üzerine yazar)
try {
  if (fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.1');
} catch {}

function log(...args) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${args.join(' ')}
`);
  } catch {}
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  return {
    ytdlp: cfg.ytdlp || 'yt-dlp',
    ffmpegDir: cfg.ffmpegDir || '',
    downloadDir: cfg.downloadDir || path.join(os.homedir(), 'Downloads'),
  };
}
let config = loadConfig();
// Her probe/indirme isteğinde yeniden okunur (uygulamada indirme klasörü değişince host yeniden başlamadan etkili olur)
function reloadConfig() { config = loadConfig(); }

// ---------- Geçmiş ----------
// Başarılı indirmeyi history.json'un başına ekler (en yeni önce, en fazla 200). Hata indirmeyi bozmaz.
function addHistory(entry) {
  try {
    let list = [];
    try {
      const j = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      if (Array.isArray(j)) list = j;
    } catch {}
    list.unshift(entry);
    list = list.slice(0, 200);
    const tmp = HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, HISTORY_PATH);
  } catch (e) {
    log('history error', e && e.message);
  }
}

// ---------- Native messaging çerçeveleme ----------
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let inbuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) break;
    const raw = inbuf.subarray(4, 4 + len).toString('utf8');
    inbuf = inbuf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { log('bad json', raw); continue; }
    handle(msg).catch((e) => {
      log('handler error', e && e.stack);
      send({ type: 'error', id: msg.id, message: String((e && e.message) || e) });
    });
  }
});

const active = new Map(); // id -> child process
process.stdin.on('end', () => {
  // Tarayıcı bağlantıyı kapattı: süren indirmeler bitince çık.
  const check = () => (active.size === 0 ? process.exit(0) : setTimeout(check, 1000));
  check();
});

// ---------- Yardımcılar ----------
function cookiesFile(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
    lines.push([
      domain,
      c.hostOnly ? 'FALSE' : 'TRUE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      c.expirationDate ? Math.floor(c.expirationDate) : 0,
      c.name,
      c.value,
    ].join('\t'));
  }
  const file = path.join(os.tmpdir(), `vidsnap-cookies-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function commonArgs(req, cookieFile) {
  const args = ['--no-playlist', '--no-warnings', '--encoding', 'utf-8', '--no-color'];
  if (config.ffmpegDir) args.push('--ffmpeg-location', config.ffmpegDir);
  if (cookieFile) args.push('--cookies', cookieFile);
  if (req.referer) args.push('--referer', req.referer);
  if (req.userAgent) args.push('--user-agent', req.userAgent);
  return args;
}

// ---------- yt-dlp otomatik güncelleme ----------
// Günde bir kez; ayrıca bir video açılamazsa (en fazla 10 dakikada bir) zorla güncelleyip tekrar dener.
const STATE_PATH = path.join(DATA_DIR, 'state.json');
let updating = null;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

function updateYtdlp(force) {
  if (updating) return updating;
  const last = readState().lastUpdate || 0;
  const age = Date.now() - last;
  if (age < (force ? 10 * 60e3 : 24 * 3600e3)) return Promise.resolve(false);
  updating = new Promise((resolve) => {
    log('yt-dlp update', force ? '(zorla)' : '(günlük)');
    const c = spawn(config.ytdlp, ['-U'], { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { c.kill(); } catch {} }, 90e3);
    const finish = (ok) => {
      clearTimeout(timer);
      try { fs.writeFileSync(STATE_PATH, JSON.stringify({ ...readState(), lastUpdate: Date.now() })); } catch {}
      log('update result', out.trim().split(/\r?\n/).pop() || '');
      updating = null;
      resolve(ok);
    };
    c.on('close', () => finish(/Updated yt-dlp/i.test(out)));
    c.on('error', () => finish(false));
  });
  return updating;
}

function run(args, onLine) {
  return new Promise((resolve) => {
    log('run', config.ytdlp, JSON.stringify(args));
    const child = spawn(config.ytdlp, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '';
    let err = '';
    let lineBuf = '';
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      if (onLine) {
        lineBuf += s;
        const parts = lineBuf.split(/\r?\n|\r/);
        lineBuf = parts.pop();
        parts.forEach((l) => l && onLine(l));
      }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => resolve({ code: -1, out, err: err + '\n' + e.message, child }));
    child.on('close', (code) => resolve({ code, out, err, child }));
    resolve.child = child;
    run.lastChild = child;
  });
}

function cleanError(err) {
  const lines = String(err).split(/\r?\n/).filter((l) => /ERROR/i.test(l));
  const msg = (lines[lines.length - 1] || String(err).trim().split(/\r?\n/).pop() || 'Bilinmeyen hata')
    .replace(/^ERROR:\s*/, '');
  return msg.slice(0, 400);
}

// ---------- Format listesi ----------
function buildOptions(info) {
  const formats = Array.isArray(info.formats) && info.formats.length ? info.formats : [info];
  const hasVideo = (f) => f.vcodec !== 'none' && (f.height || f.vcodec);
  const audioOnly = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
  const bestAudioSize = audioOnly.reduce((m, f) => Math.max(m, f.filesize || f.filesize_approx || 0), 0);

  const byHeight = new Map();
  for (const f of formats) {
    if (!hasVideo(f) || !f.height) continue;
    const g = byHeight.get(f.height) || { height: f.height, fps: 0, size: 0 };
    g.fps = Math.max(g.fps, Math.round(f.fps || 0));
    const sz = (f.filesize || f.filesize_approx || 0) + (f.acodec === 'none' ? bestAudioSize : 0);
    g.size = Math.max(g.size, sz);
    byHeight.set(f.height, g);
  }

  const options = [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .map((g) => ({
      label: `${g.height}p${g.fps > 30 ? g.fps : ''}`,
      height: g.height,
      size: g.size || null,
      format: `bv*[height=${g.height}]+ba/b[height=${g.height}]`,
    }));

  if (options.length === 0) {
    options.push({ label: 'Orijinal kalite', height: null, size: info.filesize || info.filesize_approx || null, format: 'bv*+ba/b' });
  }
  // Ses içeren bir format varsa (ya da ses bilgisi bilinmiyorsa) MP3 seçeneği
  const audioKnown = formats.some((f) => f.acodec);
  if (!audioKnown || formats.some((f) => f.acodec && f.acodec !== 'none')) {
    options.push({ label: 'Sadece ses', height: null, size: bestAudioSize || null, format: 'ba/b', audio: true, ext: 'MP3' });
  }
  return options;
}

async function probe(req) {
  reloadConfig();
  const candidates = (req.candidates || []).filter(Boolean);
  const errors = [];
  for (const cand of candidates) {
    // Önce çerezle, olmazsa çerezsiz dene (YouTube'da tersi: girişli istemciler format vermeyebiliyor)
    const hasCookies = Array.isArray(cand.cookies) && cand.cookies.length > 0;
    const attempts = !hasCookies ? [false]
      : /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(hostOf(cand.url)) ? [false, true] : [true, false];
    for (const useCookies of attempts) {
      const res = await probeOnce(req, cand, useCookies, errors);
      if (res) return res;
    }
  }
  return { type: 'error', id: req.id, message: errors[0] || 'Bu videoda indirilebilir format bulunamadı' };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function probeOnce(req, cand, useCookies, errors) {
  const cookieFile = useCookies ? cookiesFile(cand.cookies) : null;
  try {
    const args = [...commonArgs({ ...req, ...cand }, cookieFile), '-J', cand.url];
    const r = await run(args);
    if (r.code !== 0) { errors.push(cleanError(r.err)); return null; }
    let info = JSON.parse(r.out);
    if (info._type === 'playlist' && Array.isArray(info.entries)) {
      info = info.entries.find((e) => e && (e.formats || e.url)) || null;
    }
    if (!info) { errors.push('Video bulunamadı'); return null; }
    const options = buildOptions(info);
    // Doğrudan akış/dosya adreslerinde yt-dlp başlığı "master", "index" gibi olur: sayfa başlığını kullan
    const title = cand.kind !== 'page' && req.pageTitle ? req.pageTitle : (info.title || '');
    const { cookies, ...rest } = cand;
    return {
      type: 'formats',
      id: req.id,
      url: cand.url,
      candidate: { ...rest, noCookies: !useCookies }, // indirme de aynı yöntemle yapılır
      title,
      extractor: info.extractor_key || info.extractor || '',
      duration: info.duration || null,
      options,
    };
  } finally {
    if (cookieFile) fs.unlink(cookieFile, () => {});
  }
}

// ---------- İndirme ----------
function outputTemplate(cand, title, audio) {
  const suffix = audio ? '' : '%(height& {}p|)s';
  if (cand.kind && cand.kind !== 'page' && title) {
    const safe = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/%/g, '%%');
    if (safe) return `${safe}${suffix}.%(ext)s`;
  }
  return `%(title).120B [%(id).40B]${suffix}.%(ext)s`;
}

async function download(req) {
  reloadConfig();
  const cand = req.candidate || {};
  const cookieFile = cand.noCookies ? null : cookiesFile(cand.cookies);
  const formatArgs = req.audio
    ? ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0']
    : ['-f', req.format || 'bv*+ba/b', '-S', 'vcodec:h264,fps,acodec:aac', '--merge-output-format', 'mp4', '--remux-video', 'mp4'];
  const args = [
    ...commonArgs({ ...req, ...cand }, cookieFile),
    ...formatArgs,
    '--no-mtime',
    '--windows-filenames',
    '--no-part',
    '-P', config.downloadDir,
    '-o', outputTemplate(cand, req.title, req.audio),
    '--newline', '--progress',
    '--progress-template', 'download:[YTD]%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:[YTDFILE]%(filepath)s',
    cand.url || req.url,
  ];

  let lastFile = null;
  let stage = 0;
  let lastPct = -1;
  let lastSent = 0;
  const p = run(args, (line) => {
    if (line.startsWith('[YTD]')) {
      const [pctStr, speed, eta] = line.slice(5).split('|').map((s) => s.trim());
      const pct = parseFloat(pctStr);
      if (!isNaN(pct)) {
        if (pct < lastPct - 50) stage++; // ikinci akışa (ses) geçti
        lastPct = pct;
        const now = Date.now();
        if (now - lastSent > 400 || pct >= 100) {
          lastSent = now;
          send({ type: 'progress', id: req.id, percent: pct, stage, speed, eta });
        }
      }
    } else if (line.startsWith('[YTDFILE]')) {
      lastFile = line.slice(9).trim();
    }
  });
  active.set(req.id, run.lastChild);
  const r = await p;
  active.delete(req.id);
  if (cookieFile) fs.unlink(cookieFile, () => {});

  if (r.code === 0) {
    try {
      addHistory({
        id: req.id,
        title: req.title || (lastFile ? path.basename(lastFile, path.extname(lastFile)) : ''),
        file: lastFile,
        url: cand.url || req.url || null,
        label: req.label || null,
        audio: !!req.audio,
        finishedAt: Date.now(),
      });
    } catch {}
    return { type: 'done', id: req.id, file: lastFile };
  }
  if (r.child && r.child.killed) return { type: 'cancelled', id: req.id };
  log('download failed', r.code, String(r.err).slice(-1500), String(r.out).slice(-500));
  return { type: 'error', id: req.id, message: cleanError(r.err) };
}

// ---------- Mesaj yönlendirme ----------
async function handle(msg) {
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong', id: msg.id, version: 1, downloadDir: config.downloadDir });
      return;
    case 'probe': {
      await updateYtdlp(false);
      let res = await probe(msg);
      // Site değişmiş olabilir: yt-dlp'yi güncelleyip bir kez daha dene
      if (res.type === 'error' && (await updateYtdlp(true))) res = await probe(msg);
      send(res);
      return;
    }
    case 'download':
      await updateYtdlp(false);
      send(await download(msg));
      return;
    case 'cancel': {
      const child = active.get(msg.target);
      if (child) {
        // yt-dlp + ffmpeg alt süreçlerini birlikte sonlandır
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        child.killed = true;
      }
      send({ type: 'ok', id: msg.id });
      return;
    }
    case 'reveal': {
      if (msg.file && fs.existsSync(msg.file)) {
        spawn('explorer.exe', [`/select,${msg.file}`], { windowsHide: false, detached: true });
      } else {
        spawn('explorer.exe', [config.downloadDir], { detached: true });
      }
      send({ type: 'ok', id: msg.id });
      return;
    }
    default:
      send({ type: 'error', id: msg.id, message: 'Bilinmeyen istek: ' + msg.type });
  }
}

log('host started', JSON.stringify(config));
