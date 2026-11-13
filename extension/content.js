// Vidsnap içerik betiği: video üzerine gelince sağ üst köşede indirme butonu gösterir.
(() => {
  if (window.__vidsnapLoaded) return;
  window.__vidsnapLoaded = true;

  const MIN_W = 150;
  const MIN_H = 90;

  // ------------------------------------------------------------------
  // DOM yardımcıları (Shadow DOM'u da delerek)
  // ------------------------------------------------------------------
  const parentDeep = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

  function closestDeep(el, sel) {
    for (let n = el; n; n = parentDeep(n)) if (n.matches && n.matches(sel)) return n;
    return null;
  }

  // Videodan yukarı doğru çıkarak en yakın eşleşen bağlantıyı bul
  function findLinkUp(el, re, maxDepth = 15) {
    let n = el;
    for (let d = 0; n && d < maxDepth; d++, n = parentDeep(n)) {
      if (!n.querySelectorAll) continue;
      for (const a of n.querySelectorAll('a[href]')) if (re.test(a.href)) return a.href;
    }
    return null;
  }

  function eligible(el) {
    const r = el.getBoundingClientRect();
    return r.width >= MIN_W && r.height >= MIN_H;
  }

  // İçinde tek video olan ve boyutu ona uyan oynatıcı kapsayıcısı mı?
  // (YouTube gibi oynatıcılarda <video> öğesi oynatmadan önce görünür alanın dışında durabiliyor)
  function playerContainerVideo(el) {
    if (!el.querySelectorAll || el === document.body || el === document.documentElement) return null;
    const vids = el.querySelectorAll('video');
    if (vids.length !== 1) return null;
    const a = el.getBoundingClientRect();
    const v = vids[0].getBoundingClientRect();
    if (a.width < MIN_W || a.height < MIN_H || v.width === 0 || v.height === 0) return null;
    const rw = v.width / a.width;
    const rh = v.height / a.height;
    return rw > 0.6 && rw < 1.5 && rh > 0.5 && rh < 2 ? vids[0] : null;
  }

  // İmlecin altındaki video ve butonun yerleşeceği alan.
  // Üst katmanların ve shadow root'ların altını da görür.
  function hitAt(x, y) {
    const stack = [];
    const seen = new Set();
    const visit = (root) => {
      let els;
      try { els = root.elementsFromPoint(x, y); } catch { return; }
      for (const el of els) {
        if (!stack.includes(el)) stack.push(el);
        if (el.shadowRoot && !seen.has(el.shadowRoot)) { seen.add(el.shadowRoot); visit(el.shadowRoot); }
      }
    };
    visit(document);
    for (const el of stack) {
      if (el.tagName === 'VIDEO' && eligible(el)) return { video: el, anchor: el };
    }
    for (const el of stack.slice(0, 15)) {
      if (el === root) continue;
      const v = playerContainerVideo(el);
      if (v) return { video: v, anchor: el };
    }
    return null;
  }

  function directSrc(v) {
    if (!v || v.tagName !== 'VIDEO') return null;
    const s = v.currentSrc || v.src || (v.querySelector('source[src]') || {}).src;
    return s && /^https?:/.test(s) ? s : null;
  }

  // ------------------------------------------------------------------
  // Site adaptörleri: akıştaki videonun kendi gönderi adresini bulur
  // ------------------------------------------------------------------
  const HOST = location.hostname.replace(/^(www|m|mobile)\./, '');
  const is = (...ds) => ds.some((d) => HOST === d || HOST.endsWith('.' + d));
  // Videonun üstünde sabit başlık çubuğu olan siteler: buton alta gelsin
  const PREFER_BELOW = is('youtube.com');
  const KNOWN = [
    'vimeo.com', 'twitch.tv', 'dailymotion.com', 'bilibili.com', 'kick.com', 'streamable.com',
    '9gag.com', 'imgur.com', 'pinterest.com', 'tumblr.com', 'vk.com', 'ok.ru', 'rumble.com',
    'odysee.com', 'bsky.app', 'ted.com', 'soundcloud.com', 'youtube-nocookie.com',
  ];

  function postUrl(video) {
    const here = location.href;
    if (is('x.com', 'twitter.com')) {
      const art = closestDeep(video, 'article');
      if (art) {
        const a = [...art.querySelectorAll('a[href*="/status/"]')].find((x) => x.querySelector('time'));
        if (a) return a.href.replace(/\/(photo|video|analytics|quotes).*$/, '');
      }
      return /\/status\/\d+/.test(here) ? here : null;
    }
    if (is('instagram.com')) {
      const re = /\/(p|reel|reels|tv)\/[\w-]+/;
      const art = closestDeep(video, 'article');
      const u = art && [...art.querySelectorAll('a[href]')].map((a) => a.href).find((h) => re.test(h));
      if (u) return u;
      if (/\/(p|reel|reels|tv|stories)\//.test(location.pathname)) return here;
      return findLinkUp(video, re, 8);
    }
    if (is('reddit.com')) {
      const post = closestDeep(video, 'shreddit-post');
      if (post && post.getAttribute('permalink')) return new URL(post.getAttribute('permalink'), location.origin).href;
      return /\/comments\//.test(here) ? here : findLinkUp(video, /\/comments\/\w+/, 10);
    }
    if (is('youtube.com')) {
      const inPreview = closestDeep(video, 'ytd-video-preview, #video-preview, ytd-rich-item-renderer');
      if (!inPreview && /^\/(watch|shorts|live|embed)/.test(location.pathname)) return here;
      return findLinkUp(video, /\/(watch\?v=|shorts\/)/, 12) || here;
    }
    if (is('tiktok.com')) return findLinkUp(video, /\/video\/\d+/, 10) || here;
    if (is('facebook.com')) return findLinkUp(video, /\/(videos|reel|watch)\b|\/share\/[vr]\//, 12) || here;
    if (is('threads.net', 'threads.com')) return findLinkUp(video, /\/post\/[\w-]+/, 12) || here;
    if (is('linkedin.com')) return findLinkUp(video, /\/(posts|feed\/update)\//, 12) || here;
    if (KNOWN.some((d) => is(d))) return here;
    return null; // bilinmeyen site: doğrudan kaynak ve ağdan yakalanan akışlar kullanılır
  }

  // ------------------------------------------------------------------
  // Arayüz
  // ------------------------------------------------------------------
  const root = document.createElement('vidsnap-root');
  root.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
  :host { all: initial; }
  .wrap {
    --bg: #fff; --fg: #0f0f0f; --muted: #606060; --soft: rgba(0,0,0,.06); --line: rgba(0,0,0,.1);
    --accent: #0f0f0f; --accent-fg: #fff; --font: system-ui, sans-serif; --r: 10px;
  }
  * { box-sizing: border-box; font-family: var(--font); }
  .wrap { position: fixed; top: 0; left: 0; }
  .wrap[hidden] { display: none; }
  .inner { transform: translateX(-100%); display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .btn {
    all: unset; cursor: pointer; height: 34px; min-width: 34px; padding: 0 9px; border-radius: 17px;
    display: flex; align-items: center; justify-content: center; gap: 5px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    box-shadow: 0 1px 6px rgba(0,0,0,.18); font: 600 12px var(--font); transition: background .15s, color .15s;
  }
  .btn:hover { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .btn svg { width: 16px; height: 16px; flex: none; }
  .btn .pct:empty { display: none; }
  .btn[hidden] { display: none; }
  .panel {
    width: 270px; overflow: auto; border-radius: var(--r); padding: 10px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    box-shadow: 0 8px 28px rgba(0,0,0,.22); font-size: 13px; line-height: 1.35;
  }
  .panel[hidden] { display: none; }
  .head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
  .logo { font-weight: 700; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .title { font-size: 12px; font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .msg { display: flex; align-items: center; gap: 8px; color: var(--muted); padding: 6px 2px; }
  .err { color: #e5484d; word-break: break-word; }
  .list { display: flex; flex-direction: column; gap: 4px; }
  button.opt, button.small {
    all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; color: var(--fg);
    padding: 8px 10px; border-radius: calc(var(--r) * .7); background: var(--soft);
  }
  button.opt:hover, button.small:hover { background: var(--accent); color: var(--accent-fg); }
  .opt b { min-width: 64px; font-weight: 650; }
  .opt span { color: var(--muted); font-size: 12px; flex: 1; }
  .opt:hover span { color: inherit; }
  .opt .tag { flex: none; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: var(--line); }
  button.small { padding: 5px 9px; font-size: 12px; display: inline-flex; }
  .dls { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
  .dl-top { display: flex; justify-content: space-between; gap: 6px; font-size: 12px; }
  .dl-top .st { color: var(--muted); }
  .bar { height: 5px; border-radius: 3px; background: var(--line); overflow: hidden; margin: 5px 0; }
  .bar i { display: block; height: 100%; background: var(--accent); transition: width .3s; }
  .bar.done i { background: #22a35a; }
  .dl-actions { display: flex; gap: 6px; }
  .toast {
    display: flex; align-items: center; gap: 10px; max-width: 320px; padding: 9px 10px 9px 12px;
    border-radius: var(--r); background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    box-shadow: 0 8px 28px rgba(0,0,0,.22); font-size: 13px; animation: pop .16s ease-out;
  }
  .toast[hidden] { display: none; }
  .t-ic { flex: none; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 13px; background: var(--soft); }
  .t-ic.ok { background: #22a35a; color: #fff; }
  .t-ic.bad { background: #e5484d; color: #fff; }
  .t-txt { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
  .t-txt span { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .toast button.small { flex: none; margin-left: 4px; }
  @keyframes pop { from { opacity: 0; transform: translateY(-4px); } }
  .dl-line { display: flex; align-items: center; gap: 8px; font-size: 12px; min-height: 26px; }
  .dl-line .st { margin-left: auto; color: var(--muted); }
  .dl-line .ok { color: #22a35a; font-weight: 700; }
  .dl-line .tag { flex: none; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: var(--line); }
  button.icon { all: unset; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; color: var(--fg); background: var(--soft); flex: none; }
  button.icon:hover { background: var(--accent); color: var(--accent-fg); }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent); animation: r .8s linear infinite; flex: none; }
  @keyframes r { to { transform: rotate(360deg); } }
</style>
<div class="wrap" hidden>
  <div class="inner">
    <button class="btn" title="Videoyu indir (Vidsnap)">
      <svg data-vs-icon viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>
      <span class="pct"></span>
    </button>
    <div class="panel" hidden></div>
    <div class="toast" hidden></div>
  </div>
</div>`;

  const wrap = shadow.querySelector('.wrap');
  const inner = shadow.querySelector('.inner');
  const btn = shadow.querySelector('.btn');
  const pctEl = shadow.querySelector('.pct');
  const toast = shadow.querySelector('.toast');
  const panel = shadow.querySelector('.panel');

  // Sitenin kendi tıklama işleyicileri butonumuzu görmesin
  for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'wheel', 'touchstart']) {
    wrap.addEventListener(t, (e) => e.stopPropagation(), { passive: t === 'wheel' || t === 'touchstart' });
  }

  function mount() {
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    if (root.parentNode !== parent) parent.appendChild(root);
  }
  document.addEventListener('fullscreenchange', () => { if (current) mount(); });

  // ------------------------------------------------------------------
  // Durum
  // ------------------------------------------------------------------
  let current = null;     // butonun gösterildiği video
  let anchor = null;      // butonun konumlandığı alan (video ya da oynatıcı kapsayıcısı)
  let panelOpen = false;
  let hideTimer = null;
  let loopOn = false;
  const state = new WeakMap();  // video -> {key, status, options, candidate, title, error}
  const downloads = new Map();  // id -> {video, label, title, percent, stage, status, ...}

  let nativeMode = false;  // panel sitenin içine eklenen butondan mı açıldı
  let lastPoint = [0, 0];

  // ------------------------------------------------------------------
  // Otomatik tema: butonun duracağı yerin arka planı, sitenin yazı tipi ve vurgu rengi
  // ------------------------------------------------------------------
  const parseRgb = (s) => {
    const m = String(s || '').match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m[3] == null ? 1 : +m[3] };
  };
  const lum = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  const sat = (c) => { const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b); return mx ? (mx - mn) / mx : 0; };
  const SITE_ACCENT = is('x.com', 'twitter.com') ? '#1d9bf0' : is('instagram.com') ? '#0095f6' : is('reddit.com') ? '#d93900' : null;

  function cssColor(value) {
    const el = document.createElement('i');
    el.style.color = value;
    shadow.appendChild(el);
    const c = parseRgb(getComputedStyle(el).color);
    el.remove();
    return c;
  }

  function pageAccent(dark) {
    if (SITE_ACCENT) return SITE_ACCENT;
    const meta = document.querySelector('meta[name="theme-color"]');
    const link = document.querySelector('a[href]');
    for (const c of [meta && cssColor(meta.content), link && parseRgb(getComputedStyle(link).color)]) {
      if (c && sat(c) > 0.35 && Math.abs(lum(c) - (dark ? 0.1 : 0.95)) > 0.3) return `rgb(${c.r},${c.g},${c.b})`;
    }
    return null;
  }

  function applyTheme(x, y) {
    let c = null;
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === root || (el.classList && el.classList.contains('vidsnap-native'))) continue;
      const cc = parseRgb(getComputedStyle(el).backgroundColor);
      if (cc && cc.a > 0.5) { c = cc; break; }
    }
    c = c || { r: 255, g: 255, b: 255 };
    const dark = lum(c) < 0.5;
    const fg = dark ? '#f1f1f1' : '#0f0f0f';
    const accent = pageAccent(dark) || fg;
    const ac = cssColor(accent);
    const v = {
      '--bg': `rgb(${c.r},${c.g},${c.b})`,
      '--fg': fg,
      '--muted': dark ? '#aaaaaa' : '#606060',
      '--soft': dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)',
      '--line': dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.1)',
      '--accent': accent,
      '--accent-fg': ac && lum(ac) > 0.6 ? '#0f0f0f' : '#ffffff',
      '--font': getComputedStyle(document.body || document.documentElement).fontFamily || 'system-ui, sans-serif',
    };
    for (const k in v) wrap.style.setProperty(k, v[k]);
  }

  // ------------------------------------------------------------------
  // Yerli butonlar: büyük sitelerde sitenin kendi buton çubuğuna eklenir
  // ------------------------------------------------------------------
  const ICON = '<svg data-vs-icon viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%;display:block"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
  const ownerBtn = new WeakMap(); // gönderi/oynatıcı -> eklenen buton
  const nativeButtons = new Set();

  function makeNative(ref, owner, keyFn, label) {
    const s = getComputedStyle(ref);
    const svg = ref.querySelector('svg');
    const icon = Math.round((svg && svg.getBoundingClientRect().width) || 20) || 20;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vidsnap-native';
    b.title = 'Videoyu indir';
    b.setAttribute('aria-label', 'Videoyu indir');
    const radius = /^\d+px 0px 0px \d+px$/.test(s.borderRadius) ? s.borderRadius.split(' ')[0] : s.borderRadius;
    Object.assign(b.style, {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flex: 'none',
      boxSizing: 'border-box', border: 'none', cursor: 'pointer', margin: '0 0 0 8px', alignSelf: 'center',
      height: s.height, minWidth: s.height, padding: label ? s.padding : '0', borderRadius: radius,
      background: s.backgroundColor, color: s.color, transition: 'background-color .15s',
      fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight,
    });
    const hoverBg = `color-mix(in srgb, ${s.color} 14%, ${s.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'transparent' : s.backgroundColor})`;
    b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
    b.addEventListener('mouseleave', () => { b.style.background = s.backgroundColor; });
    b.innerHTML = `<span style="display:inline-block;width:${icon}px;height:${icon}px">${ICON}</span>` +
      (label ? `<span>${label}</span>` : '') + '<span class="vidsnap-pct" style="font-size:.85em;opacity:.8;display:none"></span>';
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'pointerup']) b.addEventListener(t, (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleNative(keyFn(), b); });
    b._key = keyFn;
    ownerBtn.set(owner, b);
    nativeButtons.add(b);
    return b;
  }

  // Tıklama, ilerleme ve kayıt bağlantıları (hazır bir öğeyi yerli butona çevirir)
  function wireNative(el, owner, keyFn) {
    el.classList.add('vidsnap-native');
    el.title = 'Videoyu indir';
    el.setAttribute('aria-label', 'Videoyu indir');
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'pointerup']) el.addEventListener(t, (e) => e.stopPropagation());
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleNative(el._key(), el); }, true);
    el._key = keyFn;
    ownerBtn.set(owner, el);
    nativeButtons.add(el);
    return el;
  }

  // Instagram: videonun altındaki (akış) ya da sağındaki (Reels) 24px ikonları konuma göre bulur,
  // Paylaş öğesini kopyalayıp ikonunu değiştirir. Sınıf adlarına bağlı değildir.
  function instagramNative(video) {
    const vr = video.getBoundingClientRect();
    const art = closestDeep(video, 'article');
    // Reels akıştan açılınca bir pencerede (dialog) açılır: ikonları orada ara
    const scope = art || closestDeep(video, '[role="dialog"]') || document.querySelector('main') || document.body;
    const row = [], col = [];
    for (const svg of scope.querySelectorAll('svg')) {
      const r = svg.getBoundingClientRect();
      if (r.width < 18 || r.width > 32 || Math.abs(r.width - r.height) > 2) continue;
      if (r.top >= vr.bottom - 4 && r.top <= vr.bottom + 70 && r.left >= vr.left - 10 && r.right <= vr.right + 10) row.push({ svg, r });
      else if (r.left >= vr.right - 90 && r.left <= vr.right + 100 && r.top >= vr.top + vr.height * 0.3 && r.bottom <= vr.bottom + 10) col.push({ svg, r });
    }
    const vertical = col.length > row.length;
    const icons = (vertical ? col : row).sort((a, b) => (vertical ? a.r.top - b.r.top : a.r.left - b.r.left));
    if (icons.length < 3) return;
    // Kaydet ikonunu bul: önce etiketten, olmazsa konumdan (akışta en sağdaki, Reels'te sondan ikinci)
    const SAVE_RE = /^(save|kaydet|speichern|enregistrer|guardar|salva|salvar|opslaan|сохранить|zapisz)$/i;
    let si = icons.findIndex((ic) => SAVE_RE.test((ic.svg.getAttribute('aria-label') || '').trim()));
    if (si < 0) si = vertical ? icons.length - 2 : icons.length - 1;
    if (si < 2) return;
    const save = icons[si];
    // Kaydet öğesi: kaydet ikonunu içeren, başka ikon içermeyen en üst öğe
    let item = save.svg;
    while (item.parentElement && item.parentElement !== scope && item.parentElement.querySelectorAll('svg').length === 1) item = item.parentElement;
    const box = item.parentElement;
    if (!box || box === document.body) return;
    const owner = art || video;
    const existing = box.querySelector('.vidsnap-native');
    if (existing) { existing._key = () => owner; ownerBtn.set(owner, existing); return; }
    let ref;
    if (vertical) {
      // Reels: dikey sütun. Kaydet öğesinin bir kopyasını sütuna, kaydet'in hemen üstüne ekle (hizayı bozmadan)
      ref = item;
    } else {
      // Akış: kaydet kapsayıcısı sağa yaslı (margin-left:auto) olabilir: butonu onun İÇİNE, kaydet butonunun önüne koy
      const innerChild = [...item.children].find((c) => c.tagName.toLowerCase() !== 'svg' && c.querySelector('svg'));
      const host = innerChild ? item : box;
      ref = innerChild || item;
      if (!/flex|grid/.test(getComputedStyle(host).display)) { host.style.display = 'flex'; host.style.alignItems = 'center'; }
    }

    const clone = ref.cloneNode(true);
    if (!vertical) {
      clone.style.marginLeft = '0';
      clone.style.marginRight = '12px';
    }
    clone.querySelectorAll('a[href]').forEach((a) => a.removeAttribute('href'));
    clone.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    for (let t; (t = walker.nextNode());) t.textContent = '';
    const oldSvg = clone.querySelector('svg');
    if (!oldSvg) return;
    const size = Math.round(save.r.width);
    const svg = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" data-vs-icon="" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v12"/><path d="m6.5 10.5 5.5 5.5 5.5-5.5"/><path d="M4 20.5h16"/></svg>`,
      'image/svg+xml').documentElement;
    svg.setAttribute('class', oldSvg.getAttribute('class') || '');
    svg.style.color = getComputedStyle(oldSvg).color;
    oldSvg.replaceWith(document.importNode(svg, true));
    const target = clone.querySelector('[role="button"], button, a') || clone;
    target.style.cursor = 'pointer';
    wireNative(target, owner, () => owner);
    ref.before(clone);
  }

  function hasNative(v) {
    for (let n = v; n; n = parentDeep(n)) {
      const b = ownerBtn.get(n);
      if (b && b.isConnected) return true;
    }
    return false;
  }

  function scanNative() {
    try {
      if (is('youtube.com')) {
        if (location.pathname !== '/watch') return;
        const bar = document.querySelector('ytd-watch-metadata #top-level-buttons-computed');
        const owner = document.querySelector('#movie_player');
        if (!bar || !owner || bar.querySelector('.vidsnap-native')) return;
        const ref = (bar.lastElementChild && bar.lastElementChild.querySelector('button')) || bar.querySelector('button');
        if (ref) bar.appendChild(makeNative(ref, owner, () => owner.querySelector('video') || owner, ''));
      } else if (is('x.com', 'twitter.com')) {
        for (const art of document.querySelectorAll('article')) {
          if ((ownerBtn.get(art) || {}).isConnected) continue;
          if (!art.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]')) continue;
          const groups = art.querySelectorAll('[role="group"]');
          const g = groups[groups.length - 1];
          const ref = g && g.querySelector('button');
          if (ref) g.appendChild(makeNative(ref, art, () => art, ''));
        }
      } else if (is('instagram.com')) {
        for (const v of document.querySelectorAll('video')) {
          if (hasNative(v) || !eligible(v)) continue;
          instagramNative(v);
        }
      } else if (is('reddit.com')) {
        for (const post of document.querySelectorAll('shreddit-post')) {
          if ((ownerBtn.get(post) || {}).isConnected) continue;
          const sr = post.shadowRoot;
          const q = (sel) => post.querySelector(sel) || (sr && sr.querySelector(sel));
          if (!q('shreddit-player, shreddit-player-2, video') && post.getAttribute('post-type') !== 'video') continue;
          const share = q('shreddit-post-share-button');
          if (!share) continue;
          const ref = (share.shadowRoot && share.shadowRoot.querySelector('button')) || share;
          share.after(makeNative(ref, post, () => post, 'İndir'));
        }
      }
    } catch (e) { /* site yapısı değiştiyse yüzen buton kullanılır */ }
  }
  if (is('youtube.com', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com')) setInterval(scanNative, 1500);

  function toggleNative(key, b) {
    if (panelOpen && nativeMode && current === key) { hide(true); return; }
    closePanel();
    clearTimeout(hideTimer);
    current = key;
    anchor = b;
    nativeMode = true;
    btn.hidden = true;
    mount();
    wrap.hidden = false;
    const r = b.getBoundingClientRect();
    applyTheme(r.left + r.width / 2, r.top + r.height / 2);
    place();
    if (!loopOn) { loopOn = true; requestAnimationFrame(loop); }
    openPanel();
  }

  function place() {
    if (!current) return;
    if (nativeMode) {
      if (!anchor.isConnected) { hide(true); return; }
      const r = anchor.getBoundingClientRect();
      const H = window.innerHeight, G = 6;
      const up = H - r.bottom < 260 && r.top > H - r.bottom;
      wrap.style.transform = `translate(${Math.round(Math.max(r.right, 276))}px, ${Math.round(up ? r.top - G : r.bottom + G)}px)`;
      inner.style.flexDirection = 'column';
      inner.style.transform = `translate(-100%, ${up ? '-100%' : '0'})`;
      panel.style.maxHeight = Math.max(160, (up ? r.top : H - r.bottom) - 16) + 'px';
      return;
    }
    if (!current.isConnected || !anchor.isConnected || !eligible(anchor)) { hide(true); return; }
    const r = anchor.getBoundingClientRect();
    const B = 34, G = 6, W = window.innerWidth, H = window.innerHeight;
    const right = Math.min(r.right, W - 4);
    let x, y;
    const fitsAbove = r.top - B - G >= (PREFER_BELOW ? H : 0);
    if (fitsAbove) { x = right; y = r.top - B - G; }                          // videonun üstü
    else if (r.bottom + B + G <= H) { x = right; y = r.bottom + G; }          // videonun altı
    else if (r.top - B - G >= 0) { x = right; y = r.top - B - G; }
    else if (r.right + B + G <= W) { x = r.right + G + B; y = Math.max(r.top, 0) + G; } // sağ kenar dışı
    else { x = right - 10; y = Math.max(r.top, 0) + 10; }                     // son çare: içeride
    wrap.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    lastPoint = [x - B / 2, y + B / 2];
    // Menü: altta yer yoksa yukarı açılsın
    const below = H - y - B - G, above = y - G;
    const up = below < 220 && above > below;
    inner.style.flexDirection = up ? 'column-reverse' : 'column';
    inner.style.transform = `translate(-100%, ${up ? `calc(-100% + ${B}px)` : '0'})`;
    panel.style.maxHeight = Math.max(160, (up ? above : below) - 10) + 'px';
  }

  function loop() {
    if (!current) { loopOn = false; return; }
    place();
    requestAnimationFrame(loop);
  }

  function show(v, a) {
    clearTimeout(hideTimer);
    const changed = current !== v;
    if (changed) {
      closePanel();
      current = v;
      renderButton();
    }
    anchor = a || v;
    mount();
    wrap.hidden = false;
    if (changed) { place(); applyTheme(lastPoint[0], lastPoint[1]); }
    if (!loopOn) { loopOn = true; requestAnimationFrame(loop); }
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hide(false), 700);
  }

  function hide(force) {
    if ((panelOpen || toastOpen) && !force) return;
    // İndirme sürerken yüzen buton videonun üstünde kalsın (ilerleme halkası görünsün)
    if (!force && current && isRunning(current)) return;
    closePanel();
    closeToast(true);
    current = null;
    nativeMode = false;
    btn.hidden = false;
    wrap.hidden = true;
  }

  // ------------------------------------------------------------------
  // Fare takibi
  // ------------------------------------------------------------------
  let lastMove = 0;
  document.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 80) return;
    lastMove = now;
    if (e.target === root) { clearTimeout(hideTimer); return; }
    if (panelOpen || toastOpen) return;
    const hit = hitAt(e.clientX, e.clientY);
    if (hit && !hasNative(hit.video)) show(hit.video, hit.anchor);
    else if (current) scheduleHide();
  }, { capture: true, passive: true });

  document.documentElement.addEventListener('mouseleave', () => { if (current && !panelOpen) scheduleHide(); });

  document.addEventListener('pointerdown', (e) => {
    if (toastOpen && e.target !== root) closeToast();
    if (!panelOpen || e.target === root) return;
    if (e.composedPath().some((n) => n.classList && n.classList.contains('vidsnap-native'))) return;
    if (nativeMode) hide(true);
    else { closePanel(); scheduleHide(); }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) { if (nativeMode) hide(true); else closePanel(); }
  }, true);

  // ------------------------------------------------------------------
  // Panel
  // ------------------------------------------------------------------
  btn.addEventListener('click', () => {
    if (panelOpen) { closePanel(); return; }
    openPanel();
  });

  function openPanel() {
    if (!current) return;
    panelOpen = true;
    panel.hidden = false;
    probe(current);
    render();
  }

  function closePanel() {
    panelOpen = false;
    panel.hidden = true;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtSize(b) {
    if (!b) return '';
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return Math.round(b / 1e6) + ' MB';
    return Math.max(1, Math.round(b / 1e3)) + ' KB';
  }

  function render() {
    if (!panelOpen || !current) return;
    const st = state.get(current) || { status: 'probing' };
    let html = `<div class="head"><span class="logo">Vidsnap</span>${st.title ? `<span class="title">${esc(st.title)}</span>` : ''}</div>`;
    if (st.status === 'probing') {
      html += `<div class="msg"><span class="spin"></span>Kaliteler alınıyor…</div>`;
    } else if (st.status === 'error') {
      html += `<div class="msg err">${esc(st.error)}</div><button class="small retry">Tekrar dene</button>`;
    } else {
      html += '<div class="list">' + st.options.map((o, i) =>
        `<button class="opt" data-i="${i}"><b>${esc(o.label)}</b><span>${o.size ? '~' + fmtSize(o.size) : ''}</span><span class="tag">${o.ext || 'MP4'}</span></button>`
      ).join('') + '</div>';
    }
    html += '<div class="dls"></div>';
    panel.innerHTML = html;
    renderDownloads();
  }

  const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>';
  const PLAY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
  const X_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function dlRow(id, d) {
    const head = `<b>${esc(d.label)}</b><span class="tag">${esc(d.ext || 'MP4')}</span>`;
    if (isActive(d)) {
      const pct = Math.round(d.percent || 0);
      const paused = d.status === 'paused';
      const status = paused ? `Duraklatıldı · %${pct}`
        : pct >= 100 ? 'İşleniyor…' : `${d.stage > 0 ? 'Ses ' : ''}%${pct}${d.speed && !/unknown/i.test(d.speed) ? ' · ' + esc(d.speed) : ''}`;
      const dis = d.pending ? ' disabled style="opacity:.5;pointer-events:none"' : '';
      const toggle = paused
        ? `<button class="icon resume" data-id="${id}" title="Devam et"${dis}>${PLAY_ICON}</button>`
        : `<button class="icon pause" data-id="${id}" title="Duraklat"${dis}>${PAUSE_ICON}</button>`;
      return `<div class="dl">
        <div class="dl-line">${head}<span class="st">${status}</span>${toggle}<button class="icon cancel" data-id="${id}" title="İptal"${dis}>${X_ICON}</button></div>
        <div class="bar"${paused ? ' style="opacity:.5"' : ''}><i style="width:${Math.min(100, d.percent || 0)}%"></i></div>
      </div>`;
    }
    if (d.status === 'done') {
      return `<div class="dl"><div class="dl-line"><span class="ok">✓</span>${head}<span class="st">İndirildi</span><button class="icon reveal" data-id="${id}" title="Klasörde göster">${FOLDER_ICON}</button></div></div>`;
    }
    if (d.status === 'cancelled') {
      return `<div class="dl"><div class="dl-line">${head}<span class="st">İptal edildi</span></div></div>`;
    }
    return `<div class="dl"><div class="dl-line">${head}<span class="st err">Hata</span><button class="icon dismiss" data-id="${id}" title="Kapat">${X_ICON}</button></div>
      <div class="err" style="font-size:12px;margin-top:4px">${esc(d.message)}</div></div>`;
  }

  // ------------------------------------------------------------------
  // Buton durumu: ilerleme halkası, ✓ ya da ! (kısa süre)
  // ------------------------------------------------------------------
  const RING = 2 * Math.PI * 9;
  const IDLE_ICON = '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>';

  const isActive = (d) => d.status === 'running' || d.status === 'paused';

  // Süren ya da duraklatılmış indirme var mı (yüzen buton görünür kalsın)
  function isRunning(key) {
    for (const d of downloads.values()) if (d.video === key && isActive(d)) return true;
    return false;
  }

  // Bu video için gösterilecek durum: süren indirme, yoksa az önce biten/hata veren
  function latestFor(key) {
    let pick = null;
    for (const d of downloads.values()) {
      if (d.video !== key) continue;
      if (isActive(d)) return d;
      if (d.flashUntil > Date.now()) pick = d;
    }
    return pick;
  }

  function paintIcon(svg, d) {
    if (!svg) return;
    let html = IDLE_ICON, color = '';
    if (d && isActive(d)) {
      const p = Math.max(0.04, Math.min(1, (d.percent || 0) / 100));
      html = `<circle cx="12" cy="12" r="9" opacity=".25"/>` +
        `<circle cx="12" cy="12" r="9" stroke-dasharray="${(RING * p).toFixed(1)} ${RING.toFixed(1)}" transform="rotate(-90 12 12)"/>` +
        (d.status === 'paused' ? `<path d="M10 9v6"/><path d="M14 9v6"/>` : `<path d="M12 8v7"/><path d="m9.2 12.4 2.8 2.8 2.8-2.8"/>`);
      if (d.status === 'paused') color = '#d4910a';
    } else if (d && d.status === 'done') {
      html = '<path d="M5 12.5l4.5 4.5L19 7.5"/>'; color = '#22a35a';
    } else if (d && d.status === 'error') {
      html = '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.6v.01"/>'; color = '#e5484d';
    }
    if (svg.innerHTML !== html) svg.innerHTML = html;
    svg.style.color = color;
  }

  // Panelde yalnızca süren indirme (iptal için) gösterilir; biten/hata baloncukta
  function renderDownloads() {
    if (!panelOpen || !current) return;
    const box = panel.querySelector('.dls');
    if (!box) return;
    const rows = [...downloads.entries()].filter(([, d]) => d.video === current && isActive(d));
    box.style.display = rows.length ? '' : 'none';
    // Butonlar değişmediyse sadece yazı ve çubuğu güncelle (tıklama sırasında DOM yenilenmesin)
    const sig = rows.map(([id, d]) => `${id}:${d.status}:${d.pending ? 1 : 0}`).join('|');
    if (box.dataset.sig === sig && box.children.length === rows.length) {
      rows.forEach(([id, d], i) => {
        const tmp = document.createElement('div');
        tmp.innerHTML = dlRow(id, d);
        const row = box.children[i];
        row.querySelector('.st').textContent = tmp.querySelector('.st').textContent;
        row.querySelector('.bar i').style.width = tmp.querySelector('.bar i').style.width;
      });
      return;
    }
    box.dataset.sig = sig;
    box.innerHTML = rows.map(([id, d]) => dlRow(id, d)).join('');
  }

  function renderButton() {
    const cur = current ? latestFor(current) : null;
    paintIcon(btn.querySelector('svg[data-vs-icon]'), cur);
    pctEl.textContent = cur && isActive(cur) ? `%${Math.round(cur.percent || 0)}` : '';
    for (const b of nativeButtons) {
      if (!b.isConnected) { nativeButtons.delete(b); continue; }
      const k = b._key();
      paintIcon(b.querySelector('svg[data-vs-icon]'), latestFor(k));
      const d = [...downloads.values()].find((x) => x.video === k && isActive(x));
      const pct = b.querySelector('.vidsnap-pct');
      if (pct) {
        pct.textContent = d ? `%${Math.round(d.percent || 0)}` : '';
        pct.style.display = d ? '' : 'none';
        if (!b.dataset.ytdPad) b.dataset.ytdPad = b.style.padding || '0';
        b.style.padding = d ? '0 12px' : b.dataset.ytdPad; // yüzde görünürken hap şekline geç
      }
      else b.title = d ? `İndiriliyor %${Math.round(d.percent || 0)}` : 'Videoyu indir';
    }
  }

  panel.addEventListener('click', (e) => {
    const el = e.target.closest('button');
    if (!el || !current) return;
    if (el.classList.contains('opt')) {
      const st = state.get(current);
      startDownload(current, st.options[+el.dataset.i]);
    } else if (el.classList.contains('retry')) {
      state.delete(current);
      probe(current);
    } else if (el.classList.contains('cancel') || el.classList.contains('pause') || el.classList.contains('resume')) {
      const id = el.dataset.id;
      const cmd = el.classList.contains('cancel') ? 'cancel' : el.classList.contains('pause') ? 'pause' : 'resume';
      const d = downloads.get(id);
      if (d) {
        d.pending = true; // yanıt gelene kadar butonları kilitle
        setTimeout(() => { if (d.pending) { d.pending = false; renderDownloads(); } }, 4000);
      }
      renderDownloads();
      send({ cmd, id });
    }
  });

  // ------------------------------------------------------------------
  // Baloncuk: indirme bitince/hata olunca butonun yanında kısa süre
  // ------------------------------------------------------------------
  let toastOpen = false;
  let toastTimer = null;

  function closeToast(silent) {
    clearTimeout(toastTimer);
    if (!toastOpen) return;
    toastOpen = false;
    toast.hidden = true;
    if (!silent && !panelOpen) hide(true);
  }

  function showToast(d) {
    if (panelOpen && current !== d.video) return;           // başka bir panel açıksa araya girme
    const a = d.anchor;
    if (!a || !a.isConnected) return;
    clearTimeout(hideTimer);
    closePanel();
    current = d.video;
    anchor = a;
    nativeMode = !!d.native;
    btn.hidden = nativeMode;
    renderButton();
    mount();
    wrap.hidden = false;
    place();
    if (!loopOn) { loopOn = true; requestAnimationFrame(loop); }
    const what = `${esc(d.label)} · ${esc(d.ext || 'MP4')}`;
    if (d.status === 'done') {
      toast.innerHTML = `<span class="t-ic ok">✓</span><div class="t-txt"><b>İndirildi</b><span>${what}</span></div>` +
        `<button class="small reveal">Klasörde göster</button>`;
    } else if (d.status === 'error') {
      toast.innerHTML = `<span class="t-ic bad">!</span><div class="t-txt"><b>İndirilemedi</b><span>${esc(d.message)}</span></div>` +
        `<button class="icon dismiss" title="Kapat">${X_ICON}</button>`;
    } else {
      toast.innerHTML = `<span class="t-ic">✕</span><div class="t-txt"><b>İptal edildi</b><span>${what}</span></div>`;
    }
    toast.dataset.file = d.file || '';
    toast.hidden = false;
    toastOpen = true;
    clearTimeout(toastTimer);
    if (d.status !== 'error') toastTimer = setTimeout(() => closeToast(), d.status === 'done' ? 5000 : 2500);
  }

  toast.addEventListener('mouseenter', () => clearTimeout(toastTimer));
  toast.addEventListener('mouseleave', () => { if (toastOpen) toastTimer = setTimeout(() => closeToast(), 2000); });
  toast.addEventListener('click', (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    if (el.classList.contains('reveal')) send({ cmd: 'reveal', file: toast.dataset.file || null });
    closeToast();
  });

  // Bitiş: ✓/! birkaç saniye butonda kalır, sonra kayıt silinir (tam geçmiş masaüstü uygulamasında)
  function finish(id, d) {
    d.flashUntil = Date.now() + 6000;
    showToast(d);
    setTimeout(() => { downloads.delete(id); renderButton(); }, 6100);
  }

  // ------------------------------------------------------------------
  // Service worker iletişimi
  // ------------------------------------------------------------------
  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return { type: 'error', message: 'Eklenti güncellendi. Sayfayı yenileyin (F5).' };
    }
  }

  async function probe(v) {
    const p = postUrl(v);
    const ctx = {
      primary: p ? [p] : [],
      direct: directSrc(v),
      frameUrl: location.href,
      userAgent: navigator.userAgent,
      pageTitle: document.title || '',
    };
    const key = JSON.stringify([ctx.primary, ctx.direct]);
    let st = state.get(v);
    if (st && st.key === key && (st.status === 'ready' || st.status === 'probing')) return;
    st = { key, status: 'probing' };
    state.set(v, st);
    render();
    const res = await send({ cmd: 'probe', ...ctx });
    if (state.get(v) !== st) return;
    if (res && res.type === 'formats') {
      Object.assign(st, { status: 'ready', options: res.options, candidate: res.candidate, title: res.title });
    } else {
      Object.assign(st, { status: 'error', error: (res && res.message) || 'Bilinmeyen hata' });
    }
    if (current === v) render();
  }

  async function startDownload(v, opt) {
    const st = state.get(v);
    if (!st || !opt) return;
    const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    downloads.set(id, {
      video: v, label: opt.label, ext: opt.ext || 'MP4', title: st.title, percent: 0, stage: 0, status: 'running',
      anchor, native: nativeMode,
    });
    // Seçim yapıldı: panel kapansın, ilerleme butonda görünsün
    if (nativeMode) hide(true); else closePanel();
    renderButton();
    const res = await send({ cmd: 'download', id, candidate: st.candidate, format: opt.format, audio: !!opt.audio, frameUrl: location.href, title: st.title, label: opt.label });
    if (res && res.type === 'error') {
      const d = downloads.get(id);
      if (d) { Object.assign(d, { status: 'error', message: res.message }); finish(id, d); }
      renderButton();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.evt !== 'download') return;
    const d = downloads.get(msg.id);
    if (!d) return;
    if (msg.type === 'progress') { if (d.status === 'paused') return; Object.assign(d, { percent: msg.percent, stage: msg.stage, speed: msg.speed, eta: msg.eta }); }
    else if (msg.type === 'paused') Object.assign(d, { status: 'paused', pending: false, speed: '' });
    else if (msg.type === 'resumed') Object.assign(d, { status: 'running', pending: false });
    else if (msg.type === 'done') { Object.assign(d, { status: 'done', percent: 100, file: msg.file }); finish(msg.id, d); }
    else if (msg.type === 'cancelled') { d.status = 'cancelled'; finish(msg.id, d); }
    else if (msg.type === 'error') { Object.assign(d, { status: 'error', message: msg.message }); finish(msg.id, d); }
    renderDownloads();
    renderButton();
  });
})();
