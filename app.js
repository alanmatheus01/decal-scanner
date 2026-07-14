'use strict';

/* ---------- config ---------- */

// Restrict OCR to characters actually used on decals. Includes lowercase
// even though matching normalizes to uppercase -- if the whitelist excludes
// a character that's actually on the decal (e.g. decals use mixed case),
// Tesseract can't skip it, it's forced to guess the closest *allowed*
// character, which often produces garbage. Widen further (or set to null)
// if decals use other characters (e.g. accented letters).
const OCR_CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789- ';

// Tesseract's default page-segmentation mode assumes a full multi-column
// document and tries to detect its layout -- a well-known cause of garbage
// output when fed a small cropped snippet instead of a page. '7' means
// "treat the image as a single text line," which fits a decal name. If
// names sometimes wrap to two lines, try '6' (single uniform block) instead.
const OCR_PAGE_SEGMENTATION_MODE = '7';

// Max normalized-edit-distance allowed for a fuzzy match, as a fraction of
// the candidate name's length (bounded to an integer, min 1).
const FUZZY_MAX_DISTANCE_RATIO = 0.25;

// If a second robot name is within this many edits of the best match's
// distance, the two are "confusable" -- e.g. Paola/Paolo are 1 edit apart,
// and a decal missing a letter can be equidistant from both. Rather than
// silently picking one (even on an otherwise-exact text match), the app
// stops and asks the operator to pick, since decals are frequently damaged
// or missing letters in this fleet.
const CONFUSABLE_DISTANCE_GAP = 2;

// Some browsers/platforms deliver the front camera's MediaStream already
// mirrored at the frame-data level (independent of any CSS on the <video>
// element) -- this is inconsistent across browsers. If OCR keeps reading
// backwards text, this is the fix; flip it off if a device turns out to
// deliver a true (non-mirrored) stream and this makes things worse. Check
// the live "Last read" text under the camera view to tell which case you're
// in after changing this.
const FLIP_CAPTURE_HORIZONTALLY = true;

const COUNTER_KEY = 'decalScanner.counter';
const MUTED_KEY = 'decalScanner.muted';

// This is a hands-free kiosk: the operator holds a decal up to the selfie
// camera with both hands busy on the robot and just glances at (or listens
// to) the phone. So scanning runs continuously with no button to press, and
// a reading only "commits" (updates the screen, speaks, counts) once it's
// been read the same way for CONFIRM_FRAMES loop iterations in a row -- this
// filters out single-frame OCR noise from an empty/incidental camera view.
// Once the camera stops seeing any text for EMPTY_RESET_FRAMES iterations,
// the current match is cleared so the *same* robot can be recognized again
// later (e.g. it leaves and comes back).
const CONFIRM_FRAMES = 2;
const EMPTY_RESET_FRAMES = 2;
const LOOP_YIELD_MS = 150;

/* ---------- state ---------- */

let robotsByKey = new Map(); // normalized name -> robot record
let robotList = [];          // [{normalized, record}]
let worker = null;
let videoStream = null;
let lastOcrText = '';
let muted = localStorage.getItem(MUTED_KEY) === '1';

let loopStopRequested = false;
let pendingNorm = null;
let pendingCount = 0;
let emptyStreak = 0;
let currentKey = null; // identity of whatever is currently shown on the overlay

const els = {};
[
  'video', 'canvas', 'guideBox', 'cameraHint', 'ocrLive',
  'manualInput', 'manualResults',
  'statusOverlay', 'resultContent', 'notFoundContent', 'ambiguousContent',
  'resultName', 'resultEpicKey', 'resultAction', 'fuzzyNotice', 'ticketList',
  'notFoundText', 'ambiguousText', 'ambiguousCandidates', 'ambiguousRsvBtn',
  'counterValue', 'resetCounterBtn', 'syncStatus', 'muteBtn', 'loopDot',
].forEach((id) => { els[id] = document.getElementById(id); });

/* ---------- normalization + fuzzy matching ---------- */

function normalize(text) {
  return (text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Returns one of:
//   { status: 'exact', record }       -- unique, confident textual match
//   { status: 'fuzzy', record }       -- unique, confident within edit-distance tolerance
//   { status: 'ambiguous', candidates } -- two or more names are close enough to confuse
//   { status: 'none' }                -- nothing close enough to guess at
function findMatch(rawText) {
  const norm = normalize(rawText);
  if (!norm || robotList.length === 0) return { status: 'none' };

  const scored = robotList
    .map(({ normalized, record }) => ({ record, dist: levenshtein(norm, normalized) }))
    .sort((a, b) => a.dist - b.dist);

  const best = scored[0];
  const maxDist = Math.max(1, Math.floor(best.record.name.length * FUZZY_MAX_DISTANCE_RATIO));
  if (best.dist > maxDist) return { status: 'none' };

  const confusable = scored.filter(
    (s) => s.record !== best.record && s.dist - best.dist <= CONFUSABLE_DISTANCE_GAP
  );
  if (confusable.length > 0) {
    const candidates = [best, ...confusable].slice(0, 4).map((s) => s.record);
    return { status: 'ambiguous', candidates };
  }

  return { status: best.dist === 0 ? 'exact' : 'fuzzy', record: best.record };
}

function keyForMatch(match) {
  if (match.status === 'exact' || match.status === 'fuzzy') return `r:${normalize(match.record.name)}`;
  if (match.status === 'ambiguous') return `a:${match.candidates.map((c) => normalize(c.name)).sort().join(',')}`;
  return null;
}

/* ---------- robots.json loading ---------- */

async function loadRobots() {
  try {
    const res = await fetch('robots.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    robotsByKey = new Map();
    robotList = [];
    const entries = Object.values(data.robots || {});
    for (const record of entries) {
      const normalized = normalize(record.name);
      robotsByKey.set(normalized, record);
      robotList.push({ normalized, record });
    }
    const syncedAt = data.generated_at ? new Date(data.generated_at).toLocaleString() : 'unknown';
    els.syncStatus.textContent = `${entries.length} robots · synced ${syncedAt}`;
  } catch (err) {
    els.syncStatus.textContent = 'Failed to load robots.json';
    console.error('loadRobots failed', err);
  }
}

/* ---------- camera ---------- */

async function startCamera() {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
  } catch (err) {
    console.warn('front camera unavailable, falling back', err);
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (err2) {
      console.error('no camera available', err2);
      els.cameraHint.textContent = 'Camera unavailable -- use manual search below';
      els.syncStatus.textContent += ' · camera unavailable, use manual search below';
      return false;
    }
  }
  els.video.srcObject = videoStream;
  return true;
}

// Maps the on-screen guide box (CSS pixels, drawn over a video element using
// object-fit: cover) back into source-video pixel coordinates, accounting
// for the cover-crop. This is layout-box math (clientWidth/clientHeight,
// getBoundingClientRect()), which CSS transforms like a mirror don't affect
// -- so it's correct regardless of FLIP_CAPTURE_HORIZONTALLY below.
function guideBoxToVideoRect() {
  const video = els.video;
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = video.clientWidth, ch = video.clientHeight;
  if (!vw || !vh || !cw || !ch) return null;

  const scale = Math.max(cw / vw, ch / vh); // object-fit: cover
  const displayedW = vw * scale, displayedH = vh * scale;
  const offsetX = (cw - displayedW) / 2;
  const offsetY = (ch - displayedH) / 2;

  const box = els.guideBox.getBoundingClientRect();
  const videoBox = video.getBoundingClientRect();

  const boxLeftInVideo = (box.left - videoBox.left - offsetX) / scale;
  const boxTopInVideo = (box.top - videoBox.top - offsetY) / scale;
  const boxWidthInVideo = box.width / scale;
  const boxHeightInVideo = box.height / scale;

  return {
    x: Math.max(0, boxLeftInVideo),
    y: Math.max(0, boxTopInVideo),
    w: Math.min(vw, boxWidthInVideo),
    h: Math.min(vh, boxHeightInVideo),
  };
}

function captureGuideBoxFrame() {
  const rect = guideBoxToVideoRect();
  const canvas = els.canvas;
  let sx, sy, sw, sh;
  if (!rect || rect.w <= 0 || rect.h <= 0) {
    canvas.width = els.video.videoWidth || 640;
    canvas.height = els.video.videoHeight || 480;
    sx = 0; sy = 0; sw = canvas.width; sh = canvas.height;
  } else {
    canvas.width = rect.w;
    canvas.height = rect.h;
    sx = rect.x; sy = rect.y; sw = rect.w; sh = rect.h;
  }

  const ctx = canvas.getContext('2d');
  if (FLIP_CAPTURE_HORIZONTALLY) {
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(els.video, sx, sy, sw, sh, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();
  } else {
    ctx.drawImage(els.video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/* ---------- speech feedback ---------- */

function speak(text) {
  if (muted || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.speak(utter);
}

function setMuted(next) {
  muted = next;
  localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  els.muteBtn.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
  if (muted) window.speechSynthesis.cancel();
}

/* ---------- wake lock (keep the screen on at the front door) ---------- */

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    console.warn('wake lock failed', err);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

/* ---------- OCR ---------- */

async function ensureWorker() {
  if (worker) return worker;
  worker = await Tesseract.createWorker('eng');
  const params = {};
  if (OCR_CHAR_WHITELIST) params.tessedit_char_whitelist = OCR_CHAR_WHITELIST;
  if (OCR_PAGE_SEGMENTATION_MODE) params.tessedit_pageseg_mode = OCR_PAGE_SEGMENTATION_MODE;
  if (Object.keys(params).length) await worker.setParameters(params);
  return worker;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanLoop() {
  const w = await ensureWorker();
  while (!loopStopRequested) {
    els.loopDot.classList.add('busy');
    try {
      const frame = captureGuideBoxFrame();
      const { data: { text } } = await w.recognize(frame);
      const raw = text.trim();
      const norm = normalize(raw);
      els.ocrLive.textContent = raw ? `Last read: ${raw}` : '';

      if (!norm) {
        emptyStreak++;
        pendingNorm = null;
        pendingCount = 0;
        if (emptyStreak >= EMPTY_RESET_FRAMES && currentKey !== null) {
          currentKey = null;
          hideOverlay();
        }
      } else {
        emptyStreak = 0;
        if (norm === pendingNorm) {
          pendingCount++;
        } else {
          pendingNorm = norm;
          pendingCount = 1;
        }
        if (pendingCount >= CONFIRM_FRAMES) {
          const match = findMatch(raw);
          const key = keyForMatch(match);
          if (key !== currentKey) {
            currentKey = key;
            handleMatch(match, raw);
          }
        }
      }
    } catch (err) {
      console.error('scan loop error', err);
    }
    els.loopDot.classList.remove('busy');
    await sleep(LOOP_YIELD_MS);
  }
}

function handleMatch(match, rawText) {
  lastOcrText = rawText;
  if (match.status === 'exact' || match.status === 'fuzzy') {
    showResult(match.record, match.status === 'fuzzy');
    incrementCounter();
    speak(`${match.record.cone} cone. ${match.record.action}`);
  } else if (match.status === 'ambiguous') {
    showAmbiguous(rawText, match.candidates);
    speak('Multiple possible matches. Please check the screen.');
  } else {
    showNotFound(rawText);
    incrementCounter();
    speak('Decal not recognized. Create an R S V, and drop off in the Fleet Management room.');
  }
}

/* ---------- overlay rendering ---------- */

function setOverlayState(state) {
  els.resultContent.hidden = state !== 'result';
  els.notFoundContent.hidden = state !== 'notfound';
  els.ambiguousContent.hidden = state !== 'ambiguous';
  els.statusOverlay.className = 'status-overlay';
  if (state) {
    els.statusOverlay.classList.add('active');
    if (state === 'result') {
      els.statusOverlay.classList.add(`state-${els.statusOverlay.dataset.cone}`);
    } else {
      els.statusOverlay.classList.add('state-attention');
    }
  }
}

function hideOverlay() {
  els.statusOverlay.classList.remove('active');
}

function showResult(record, fuzzy) {
  els.statusOverlay.dataset.cone = record.cone;
  els.resultName.textContent = record.name;
  els.resultEpicKey.textContent = record.epic_key || '';
  els.resultAction.textContent = record.action || '';
  els.fuzzyNotice.hidden = !fuzzy;

  els.ticketList.innerHTML = '';
  (record.tickets || []).forEach((t) => {
    const li = document.createElement('li');
    li.textContent = `${t.key} · ${t.type} · ${t.status}`;
    els.ticketList.appendChild(li);
  });

  setOverlayState('result');
}

function showNotFound(text) {
  els.notFoundText.textContent = text || '(nothing read)';
  setOverlayState('notfound');
}

function showAmbiguous(text, candidates) {
  els.ambiguousText.textContent = text || '(nothing read)';
  els.ambiguousCandidates.innerHTML = '';
  candidates.forEach((record) => {
    const li = document.createElement('li');
    li.textContent = record.name;
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      currentKey = `r:${normalize(record.name)}`;
      showResult(record, true);
      incrementCounter();
      speak(`${record.cone} cone. ${record.action}`);
    });
    els.ambiguousCandidates.appendChild(li);
  });
  setOverlayState('ambiguous');
}

/* ---------- counter ---------- */

function getCounter() {
  return parseInt(localStorage.getItem(COUNTER_KEY) || '0', 10);
}

function setCounter(n) {
  localStorage.setItem(COUNTER_KEY, String(n));
  els.counterValue.textContent = String(n);
}

function incrementCounter() {
  setCounter(getCounter() + 1);
}

/* ---------- manual search fallback ---------- */

function renderManualResults(query) {
  const norm = normalize(query);
  els.manualResults.innerHTML = '';
  if (!norm) return;
  const matches = robotList
    .filter(({ normalized }) => normalized.includes(norm))
    .slice(0, 8);
  for (const { record } of matches) {
    const li = document.createElement('li');
    li.textContent = record.name;
    li.addEventListener('click', () => {
      els.manualInput.value = '';
      els.manualResults.innerHTML = '';
      currentKey = `r:${normalize(record.name)}`;
      showResult(record, false);
      incrementCounter();
      speak(`${record.cone} cone. ${record.action}`);
    });
    els.manualResults.appendChild(li);
  }
}

/* ---------- wiring ---------- */

els.statusOverlay.addEventListener('click', () => {
  currentKey = null;
  hideOverlay();
});

els.ambiguousRsvBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  currentKey = `n:${normalize(lastOcrText)}`;
  showNotFound(lastOcrText);
  incrementCounter();
  speak('Decal not recognized. Create an R S V, and drop off in the Fleet Management room.');
});

els.resetCounterBtn.addEventListener('click', () => {
  if (confirm('Reset the robots-processed counter to 0?')) setCounter(0);
});

els.muteBtn.addEventListener('click', () => setMuted(!muted));

els.manualInput.addEventListener('input', (e) => renderManualResults(e.target.value));

/* ---------- init ---------- */

async function init() {
  setCounter(getCounter());
  setMuted(muted);
  await loadRobots();
  await requestWakeLock();
  const hasCamera = await startCamera();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('sw register failed', err));
  }

  if (hasCamera) scanLoop();
}

init();
