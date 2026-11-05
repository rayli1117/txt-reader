'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ================= Storage ================= */

const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('txt-reader', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('books', { keyPath: 'id' });
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books', mode);
      const req = fn(tx.objectStore('books'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  put(book) { return this.run('readwrite', (s) => s.put(book)); },
  get(id) { return this.run('readonly', (s) => s.get(id)); },
  remove(id) { return this.run('readwrite', (s) => s.delete(id)); },
};

const Store = {
  getJSON(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  setJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); },

  library() { return this.getJSON('library', []); },
  saveLibrary(list) { this.setJSON('library', list); },

  progress(id) { return this.getJSON('progress:' + id, null); },
  saveProgress(id, p) { this.setJSON('progress:' + id, p); },
};

const DEFAULT_SETTINGS = {
  fontSize: 20,
  lineHeight: 1.8,
  theme: 'sepia',
  fontFamily: 'sans',
  traditional: true,
  tapPaging: true,
};

let settings = { ...DEFAULT_SETTINGS, ...Store.getJSON('settings', {}) };

/* ================= Text processing ================= */

const COMMON_CHARS = '的一是了我不人在他有这个们中来上大为和国说這個們說來為國時會她你';

function scoreDecoded(text) {
  const sample = text.slice(0, 20000);
  let bad = 0;
  let good = 0;
  for (const ch of sample) {
    if (ch === '\uFFFD') bad++;
    else if (COMMON_CHARS.includes(ch)) good++;
  }
  return good - bad * 10;
}

function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let best = null;
    let bestScore = -Infinity;
    for (const enc of ['gb18030', 'big5']) {
      try {
        const text = new TextDecoder(enc).decode(bytes);
        const score = scoreDecoded(text);
        if (score > bestScore) { best = text; bestScore = score; }
      } catch { /* encoding not supported */ }
    }
    return best ?? new TextDecoder('utf-8').decode(bytes);
  }
}

const AD_LINE_RE = /(https?:\/\/|www\.|\.com\b|本站所有书籍|本站所有書籍|小说发布地址|小說發佈地址|小说不断更新|侵犯了您的版权|请联系我们|TXT\s*格式小说)/i;
const DIVIDER_RE = /^[\s*=\-_~#]+$/;
const PAGE_NUMBER_RE = /^\d{1,4}$/;
const SENTENCE_END_RE = /[。！？!?”」』…~～）)】]$/;
const CHAPTER_RE = new RegExp(
  '^(' +
    '第[0-9０-９零〇一二两兩三四五六七八九十百千万萬]+[章回节節卷集部篇话話].{0,30}' +
    '|(序章|序言|序|楔子|引子|前言|尾声|尾聲|后记|後記|终章|終章|番外)([\\s，,:：].{0,30})?' +
    '|.{1,15}\\s+(序|序章|楔子)' +
  ')$'
);

function cleanLines(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\f\v\u200b]/g, '')
    .split('\n')
    .map((l) => l.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''))
    .filter((l) => l.length > 0 && !DIVIDER_RE.test(l) && !AD_LINE_RE.test(l));
}

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

function parseChineseNumber(s) {
  if (/^[0-9０-９]+$/.test(s)) return Number(s.replace(/[０-９]/g, (c) => c.charCodeAt(0) - 0xFF10));
  let total = 0;
  let digit = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) digit = CN_DIGITS[ch];
    else if (ch in CN_UNITS) { total += (digit || 1) * CN_UNITS[ch]; digit = 0; }
    else return NaN;
  }
  return total + digit;
}

function toChineseNumber(n) {
  const d = '零一二三四五六七八九';
  if (n < 10) return d[n];
  if (n < 20) return '十' + (n % 10 ? d[n % 10] : '');
  if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
  return String(n);
}

function chapterNumber(title) {
  const m = title.match(/^第([0-9０-９零〇一二两兩三四五六七八九十百千]+)[章回节節话話]/);
  return m ? parseChineseNumber(m[1]) : NaN;
}

// Many TXT files are hard-wrapped at a fixed width; that width shows up as the most common long line length.
function detectWrapWidth(lines) {
  const counts = new Map();
  for (const l of lines) if (l.length >= 20) counts.set(l.length, (counts.get(l.length) || 0) + 1);
  let width = 0;
  let best = 0;
  for (const [len, c] of counts) if (c > best) { width = len; best = c; }
  return best >= 20 && best >= lines.length * 0.03 ? width : 0;
}

function mergeWrappedLines(lines) {
  const width = detectWrapWidth(lines);
  if (!width) return lines;
  const out = [];
  let prevPhysical = '';
  for (const line of lines) {
    const isHeading = PAGE_NUMBER_RE.test(line) || (line.length <= 40 && CHAPTER_RE.test(line));
    const wrapped = prevPhysical.length >= width - 2 && !SENTENCE_END_RE.test(prevPhysical);
    if (out.length > 0 && !isHeading && wrapped) out[out.length - 1] += line;
    else out.push(line);
    prevPhysical = line;
  }
  return out;
}

function splitChapters(text) {
  const lines = mergeWrappedLines(cleanLines(text));
  const chapters = [];
  let current = { title: '前言', lines: [] };
  let lastNum = 0;

  const startChapter = (title) => {
    if (current.lines.length > 0 || chapters.length > 0) chapters.push(current);
    current = { title, lines: [] };
  };

  for (const line of lines) {
    if (PAGE_NUMBER_RE.test(line)) {
      // A bare number is a chapter heading only if it continues the chapter sequence; otherwise it's a page number.
      const n = Number(line);
      if (lastNum > 0 && n === lastNum + 1) {
        startChapter(`第${toChineseNumber(n)}章`);
        lastNum = n;
      }
    } else if (line.length <= 40 && CHAPTER_RE.test(line)) {
      startChapter(line);
      const n = chapterNumber(line);
      if (!Number.isNaN(n)) lastNum = n;
    } else {
      current.lines.push(line);
    }
  }
  chapters.push(current);

  // Drop an empty preface; fall back to fixed-size parts when no headings found.
  const result = chapters.filter((c, i) => !(i === 0 && c.title === '前言' && c.lines.length === 0));
  if (result.length <= 1 && lines.length > 200) return chunkByLines(lines, 120);
  return result;
}

function chunkByLines(lines, size) {
  const parts = [];
  for (let i = 0; i < lines.length; i += size) {
    parts.push({ title: `第 ${parts.length + 1} 部分`, lines: lines.slice(i, i + size) });
  }
  return parts;
}

let s2t = null;

function loadS2T() {
  const chars = new Map();
  const src = Array.from(window.S2T_SRC);
  const dst = Array.from(window.S2T_DST);
  src.forEach((c, i) => chars.set(c, dst[i]));

  const phrases = new Map();
  const maxLenByFirst = new Map();
  for (const row of (window.S2T_PHRASES || '').split('\n')) {
    const [s, t] = row.split('\t');
    if (!s || !t) continue;
    phrases.set(s, t);
    const first = s[0];
    if ((maxLenByFirst.get(first) || 0) < s.length) maxLenByFirst.set(first, s.length);
  }
  return { chars, phrases, maxLenByFirst };
}

// Longest-match phrase conversion first, then per-character fallback.
function toTraditional(str) {
  if (!settings.traditional || !window.S2T_SRC) return str;
  if (!s2t) s2t = loadS2T();
  const { chars, phrases, maxLenByFirst } = s2t;
  let out = '';
  let i = 0;
  while (i < str.length) {
    const maxLen = Math.min(maxLenByFirst.get(str[i]) || 0, str.length - i);
    let matched = false;
    for (let len = maxLen; len >= 2; len--) {
      const hit = phrases.get(str.substr(i, len));
      if (hit) {
        out += hit;
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += chars.get(str[i]) ?? str[i];
      i++;
    }
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ================= Library ================= */

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function displayName(fileName) {
  return fileName.replace(/\.txt$/i, '').replace(/^\d{5,}[-_ ]*/, '');
}

async function importFile(file) {
  $('#importing').hidden = false;
  try {
    const text = decodeText(await file.arrayBuffer());
    const chapters = splitChapters(text);
    const id = makeId();
    const name = displayName(file.name);
    await DB.put({ id, name, text, addedAt: Date.now() });
    const lib = Store.library();
    lib.unshift({ id, name, chapterCount: chapters.length, size: file.size, addedAt: Date.now(), lastReadAt: 0 });
    Store.saveLibrary(lib);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    renderLibrary();
    openBook(id);
  } catch (err) {
    alert('匯入失敗：' + err.message);
  } finally {
    $('#importing').hidden = true;
  }
}

async function deleteBook(id) {
  const book = Store.library().find((b) => b.id === id);
  if (!book || !confirm(`刪除《${book.name}》？`)) return;
  await DB.remove(id);
  Store.saveLibrary(Store.library().filter((b) => b.id !== id));
  localStorage.removeItem('progress:' + id);
  if (localStorage.getItem('lastBook') === id) localStorage.removeItem('lastBook');
  renderLibrary();
}

function renderLibrary() {
  const lib = Store.library().sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
  const list = $('#bookList');
  list.innerHTML = '';
  $('#emptyHint').hidden = lib.length > 0;

  for (const b of lib) {
    const p = Store.progress(b.id);
    const name = toTraditional(b.name);
    const meta = p
      ? `讀到 第 ${p.ch + 1} / ${b.chapterCount} 章 · ${toTraditional(p.title || '')}`
      : `未開始 · 共 ${b.chapterCount} 章`;
    const li = document.createElement('li');
    li.className = 'book-item';
    li.innerHTML = `
      <div class="book-cover">${escapeHtml(name.charAt(0))}</div>
      <div class="book-info">
        <div class="book-name">${escapeHtml(name)}</div>
        <div class="book-meta">${escapeHtml(meta)}</div>
      </div>
      <button class="book-del">刪除</button>`;
    li.querySelector('.book-info').addEventListener('click', () => openBook(b.id));
    li.querySelector('.book-cover').addEventListener('click', () => openBook(b.id));
    li.querySelector('.book-del').addEventListener('click', () => deleteBook(b.id));
    list.appendChild(li);
  }
}

/* ================= Reader ================= */

const reader = {
  bookId: null,
  chapters: [],
  ch: 0,
  paras: [],
};

async function openBook(id) {
  const book = await DB.get(id);
  if (!book) {
    alert('找不到這本書的內容，可能已被刪除。');
    return;
  }
  reader.bookId = id;
  reader.chapters = splitChapters(book.text);
  localStorage.setItem('lastBook', id);

  const lib = Store.library();
  const entry = lib.find((b) => b.id === id);
  if (entry) {
    entry.lastReadAt = Date.now();
    entry.chapterCount = reader.chapters.length;
    Store.saveLibrary(lib);
  }

  $('#library').hidden = true;
  $('#reader').hidden = false;
  setBars(false);

  const p = Store.progress(id);
  const ch = p ? Math.min(p.ch, reader.chapters.length - 1) : 0;
  showChapter(ch, p ? p.para : 0);
  buildToc();
}

function closeBook() {
  saveProgress();
  reader.bookId = null;
  localStorage.removeItem('lastBook');
  $('#reader').hidden = true;
  $('#library').hidden = false;
  setBars(false);
  renderLibrary();
  window.scrollTo(0, 0);
}

function showChapter(index, paraIndex = 0, atEnd = false) {
  const chapters = reader.chapters;
  reader.ch = Math.max(0, Math.min(index, chapters.length - 1));
  const c = chapters[reader.ch];

  let html = `<h2>${escapeHtml(toTraditional(c.title))}</h2>`;
  for (const line of c.lines) html += `<p>${escapeHtml(toTraditional(line))}</p>`;
  html += `
    <div class="chapter-nav">
      <button data-nav="-1" ${reader.ch === 0 ? 'disabled' : ''}>‹ 上一章</button>
      <button data-nav="1" ${reader.ch === chapters.length - 1 ? 'disabled' : ''}>下一章 ›</button>
    </div>
    <div id="pullHint" class="pull-hint">${reader.ch === chapters.length - 1 ? '— 全書完 —' : PULL_HINT_IDLE}</div>`;

  const content = $('#content');
  content.innerHTML = html;
  reader.paras = Array.from(content.querySelectorAll('h2, p'));

  $('#barTitle').textContent = toTraditional(c.title);
  updateProgressText();

  if (atEnd) window.scrollTo(0, document.documentElement.scrollHeight);
  else scrollToPara(paraIndex);

  saveProgress();
}

function scrollToPara(i) {
  const el = reader.paras[Math.max(0, Math.min(i, reader.paras.length - 1))];
  if (!el || i <= 0) {
    window.scrollTo(0, 0);
    return;
  }
  window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - topInset());
}

function topInset() {
  return parseFloat(getComputedStyle($('#content')).paddingTop) || 0;
}

// Binary search for the first paragraph whose bottom is below the top inset.
function currentParaIndex() {
  const paras = reader.paras;
  const limit = topInset();
  let lo = 0;
  let hi = paras.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (paras[mid].getBoundingClientRect().bottom > limit) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function saveProgress() {
  if (!reader.bookId || !reader.chapters.length) return;
  Store.saveProgress(reader.bookId, {
    ch: reader.ch,
    para: currentParaIndex(),
    title: reader.chapters[reader.ch].title,
    t: Date.now(),
  });
}

function updateProgressText() {
  const total = reader.chapters.length;
  const doc = document.documentElement;
  const max = Math.max(1, doc.scrollHeight - window.innerHeight);
  const inChapter = Math.min(1, window.scrollY / max);
  const overall = ((reader.ch + inChapter) / total) * 100;
  $('#progressText').textContent = `第 ${reader.ch + 1} / ${total} 章 · 全書 ${overall.toFixed(1)}%`;
}

function gotoChapter(delta) {
  const next = reader.ch + delta;
  if (next < 0 || next >= reader.chapters.length) return;
  showChapter(next, 0);
}

/* ---------- Pull up at chapter end to go to next chapter ---------- */

const PULL_THRESHOLD = 80;
const PULL_HINT_IDLE = '↑ 繼續上拉進入下一章';
const PULL_HINT_READY = '↑ 放開進入下一章';

function isAtChapterBottom() {
  return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
}

function isPanelOpen() {
  return !$('#tocPanel').hidden || !$('#settingsPanel').hidden;
}

function bindPullToNext() {
  let startY = null;
  let ready = false;

  const setHint = (isReady) => {
    if (ready === isReady) return;
    ready = isReady;
    const hint = $('#pullHint');
    if (hint && reader.ch < reader.chapters.length - 1) {
      hint.textContent = isReady ? PULL_HINT_READY : PULL_HINT_IDLE;
      hint.classList.toggle('ready', isReady);
    }
  };

  window.addEventListener('touchstart', (e) => {
    startY = reader.bookId && e.touches.length === 1 && !isPanelOpen() ? e.touches[0].clientY : null;
    ready = false;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const y = e.touches[0].clientY;
    // Measure the pull only from the moment the chapter bottom is reached.
    if (!isAtChapterBottom()) {
      startY = y;
      setHint(false);
      return;
    }
    setHint(startY - y >= PULL_THRESHOLD);
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (startY === null) return;
    const go = ready && reader.ch < reader.chapters.length - 1;
    startY = null;
    setHint(false);
    if (go) {
      setBars(false);
      gotoChapter(1);
    }
  }, { passive: true });

  window.addEventListener('touchcancel', () => {
    startY = null;
    setHint(false);
  }, { passive: true });
}

function pageScroll(dir) {
  const doc = document.documentElement;
  const lineHeightPx = settings.fontSize * settings.lineHeight;
  const step = window.innerHeight - lineHeightPx * 2;
  const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - 4;
  const atTop = window.scrollY <= 0;

  if (dir > 0 && atBottom) return gotoChapter(1);
  if (dir < 0 && atTop) {
    if (reader.ch > 0) showChapter(reader.ch - 1, 0, true);
    return;
  }
  window.scrollBy(0, dir * step);
}

function buildToc() {
  const list = $('#tocList');
  list.innerHTML = '';
  reader.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    li.textContent = toTraditional(c.title);
    li.dataset.index = i;
    list.appendChild(li);
  });
}

function openToc() {
  const items = $$('#tocList li');
  items.forEach((li, i) => li.classList.toggle('current', i === reader.ch));
  $('#tocPanel').hidden = false;
  const cur = items[reader.ch];
  if (cur) cur.scrollIntoView({ block: 'center' });
}

function setBars(visible) {
  document.body.classList.toggle('bars-visible', visible);
  if (visible) updateProgressText();
}

/* ================= Settings ================= */

function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty('--font-size', settings.fontSize + 'px');
  root.style.setProperty('--line-height', settings.lineHeight);
  root.style.setProperty(
    '--font-family',
    settings.fontFamily === 'serif'
      ? '"Songti TC", "Songti SC", "STSong", "PMingLiU", serif'
      : '-apple-system, "PingFang TC", "PingFang SC", "Heiti TC", "Microsoft JhengHei", sans-serif'
  );
  const themeColors = { light: '#f8f8f8', sepia: '#ece1c8', green: '#bedcbe', dark: '#1e1e1e' };
  document.querySelector('meta[name="theme-color"]').content = themeColors[settings.theme];

  $('#fontSizeVal').textContent = settings.fontSize;
  $('#lineHeightVal').textContent = settings.lineHeight.toFixed(1);
  $$('[data-theme-set]').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === settings.theme));
  $$('[data-font-set]').forEach((b) => b.classList.toggle('active', b.dataset.fontSet === settings.fontFamily));
  $$('[data-trad-set]').forEach((b) => b.classList.toggle('active', (b.dataset.tradSet === '1') === settings.traditional));
  $$('[data-tap-set]').forEach((b) => b.classList.toggle('active', (b.dataset.tapSet === '1') === settings.tapPaging));
}

// Change a setting while keeping the reading position anchored to the same paragraph.
function updateSettings(patch, { rerender = false } = {}) {
  const anchor = reader.bookId ? currentParaIndex() : 0;
  settings = { ...settings, ...patch };
  Store.setJSON('settings', settings);
  applySettings();
  if (!reader.bookId) return;
  if (rerender) {
    showChapter(reader.ch, anchor);
    buildToc();
  } else {
    scrollToPara(anchor);
  }
}

/* ================= Events ================= */

function bindEvents() {
  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });

  $('#backBtn').addEventListener('click', closeBook);
  $('#prevBtn').addEventListener('click', () => gotoChapter(-1));
  $('#nextBtn').addEventListener('click', () => gotoChapter(1));
  $('#tocBtn').addEventListener('click', openToc);
  $('#settingsBtn').addEventListener('click', () => { $('#settingsPanel').hidden = false; });

  $('#content').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      gotoChapter(Number(nav.dataset.nav));
      return;
    }
    if (document.body.classList.contains('bars-visible')) {
      setBars(false);
      return;
    }
    const x = e.clientX / window.innerWidth;
    if (settings.tapPaging && x < 0.3) pageScroll(-1);
    else if (settings.tapPaging && x > 0.7) pageScroll(1);
    else setBars(true);
  });

  $('#tocList').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    $('#tocPanel').hidden = true;
    setBars(false);
    showChapter(Number(li.dataset.index), 0);
  });

  $$('.panel-backdrop').forEach((bd) => {
    bd.addEventListener('click', (e) => {
      if (e.target === bd || e.target.closest('.close-panel')) bd.hidden = true;
    });
  });

  $('#settingsPanel').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'fontUp') updateSettings({ fontSize: Math.min(40, settings.fontSize + 1) });
    else if (a === 'fontDown') updateSettings({ fontSize: Math.max(12, settings.fontSize - 1) });
    else if (a === 'lhUp') updateSettings({ lineHeight: Math.min(3, Math.round((settings.lineHeight + 0.1) * 10) / 10) });
    else if (a === 'lhDown') updateSettings({ lineHeight: Math.max(1.2, Math.round((settings.lineHeight - 0.1) * 10) / 10) });
    else if (t.dataset.themeSet) updateSettings({ theme: t.dataset.themeSet });
    else if (t.dataset.fontSet) updateSettings({ fontFamily: t.dataset.fontSet });
    else if (t.dataset.tradSet) updateSettings({ traditional: t.dataset.tradSet === '1' }, { rerender: true });
    else if (t.dataset.tapSet) updateSettings({ tapPaging: t.dataset.tapSet === '1' });
  });

  bindPullToNext();

  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (!reader.bookId) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      saveProgress();
      if (document.body.classList.contains('bars-visible')) updateProgressText();
    }, 300);
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgress();
  });
  window.addEventListener('pagehide', saveProgress);
}

/* ================= Boot ================= */

function boot() {
  applySettings();
  bindEvents();
  renderLibrary();

  const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  $('#installHint').hidden = isStandalone;

  const last = localStorage.getItem('lastBook');
  if (last && Store.library().some((b) => b.id === last)) openBook(last);

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
