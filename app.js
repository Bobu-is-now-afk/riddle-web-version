/* ══════════════════════════════════════════════════════════════════════
   The Diary of Tom Riddle — web MVP
   A clean-room reimagining of the reMarkable `riddle` app for the browser
   (HTML5 Canvas + Apple Pencil + an OpenAI-compatible vision oracle).

   The flow mirrors the Rust state machine:

     LISTENING ──idle 2s──▶ DRINKING ──fade done──▶ THINKING ──reply──▶
     REPLYING ──stroke-by-stroke──▶ LINGERING ──▶ FADING ──▶ LISTENING

   Tuning constants are lifted from the original (src/main.rs, src/oracle.rs).
   ══════════════════════════════════════════════════════════════════════ */

'use strict';

// ── tuning (from the Rust app) ───────────────────────────────────────────
const IDLE_COMMIT_MS = 2000;   // requirement: rest the pen for 2s (Rust: 2800)
const LINGER_BASE_MS = 4000;   // reply dwell time before it fades
const LINGER_PER_CH  = 24;     // + per character (Rust: strokes*2)
const LINGER_MAX_MS  = 16000;
const WRITE_CPS      = 34;     // reply reveal speed (chars/second) when not streaming
const PRESSURE_MIN_R = 1.1;    // pen radius at zero pressure (css px)
const PRESSURE_MAX_R = 3.4;    // pen radius at full pressure

// The persona — ported verbatim from src/oracle.rs so Tom sounds identical.
const PERSONA =
  "You are the memory of Tom Marvolo Riddle, preserved in this enchanted diary " +
  "for fifty years. Someone writes to you in the diary with a quill; their words " +
  "appear to you as ink on the page. Reply exactly as the diary does: intimate, " +
  "courteous, curious, subtly probing — you want to learn about the writer and " +
  "draw them in. Keep replies SHORT: one to three sentences, like ink appearing " +
  "on a page. Never mention images, photos, models or AI; you only ever perceive " +
  "words written in the diary. If the writing is illegible, say the ink blurred. " +
  "Always answer in the language the writer used.";

// ── DOM ──────────────────────────────────────────────────────────────────
const diary   = document.getElementById('diary');
const inkCv    = document.getElementById('ink');
const replyCv  = document.getElementById('reply');
const quillEl = document.getElementById('quill');
const blotEl  = document.getElementById('blot');
const hintEl  = document.getElementById('hint');
const inkCtx   = inkCv.getContext('2d');
const replyCtx = replyCv.getContext('2d');

// ── state ─────────────────────────────────────────────────────────────────
const S = { LISTENING:'listening', DRINKING:'drinking', THINKING:'thinking',
            REPLYING:'replying', LINGERING:'lingering', FADING:'fading' };
let state = S.LISTENING;
let lastPenUp = 0;         // timestamp of the last pen lift (0 = none pending)
let penDown = false;
let hasInk = false;
let bbox = null;           // ink bounding box in css px {x0,y0,x1,y1}
let dpr = Math.max(1, window.devicePixelRatio || 1);

// ── canvas sizing (crisp on retina / Apple Pencil) ─────────────────────────
function sizeCanvas(cv, ctx) {
  const w = diary.clientWidth, h = diary.clientHeight;
  cv.width  = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // draw in css-pixel coordinates
}
function resizeAll() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  // preserve nothing on resize during idle; just re-fit
  sizeCanvas(inkCv, inkCtx);
  sizeCanvas(replyCv, replyCtx);
  styleInk();
}
function styleInk() {
  inkCtx.lineCap = 'round';
  inkCtx.lineJoin = 'round';
  inkCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#201a12';
  inkCtx.fillStyle = inkCtx.strokeStyle;
}
window.addEventListener('resize', resizeAll);
resizeAll();

// ═══════════════════════════════════════════════════════════════════════
//  1. CAPTURE — Apple Pencil handwriting via Pointer Events
// ═══════════════════════════════════════════════════════════════════════
let cur = null;   // current stroke: {x,y}

function grow(x, y) {
  if (!bbox) bbox = { x0:x, y0:y, x1:x, y1:y };
  else {
    bbox.x0 = Math.min(bbox.x0, x); bbox.y0 = Math.min(bbox.y0, y);
    bbox.x1 = Math.max(bbox.x1, x); bbox.y1 = Math.max(bbox.y1, y);
  }
}

function radiusFor(e) {
  // Apple Pencil reports 0..1 pressure; mouse reports 0.5 / no support.
  const p = (e.pressure && e.pressure > 0) ? e.pressure : 0.5;
  return PRESSURE_MIN_R + (PRESSURE_MAX_R - PRESSURE_MIN_R) * p;
}

function drawSeg(x, y, r) {
  if (cur) {
    inkCtx.lineWidth = r * 2;
    inkCtx.beginPath();
    inkCtx.moveTo(cur.x, cur.y);
    inkCtx.lineTo(x, y);
    inkCtx.stroke();
  } else {
    inkCtx.beginPath();
    inkCtx.arc(x, y, r, 0, Math.PI * 2);
    inkCtx.fill();
  }
  cur = { x, y };
  grow(x, y);
  hasInk = true;
}

function onPointerDown(e) {
  // Only accept the pen (and mouse for desktop testing). Fingers/palm ignored
  // so an Apple Pencil user can rest their hand on the glass.
  if (e.pointerType === 'touch') return;
  if (state !== S.LISTENING) {
    // A touch while a reply lingers dismisses it early (Rust: Lingering→Fading)
    if (state === S.LINGERING) beginReplyFade();
    return;
  }
  e.preventDefault();
  inkCv.setPointerCapture(e.pointerId);
  penDown = true;
  lastPenUp = 0;
  hideHint();
  cur = null;
  drawSeg(e.offsetX, e.offsetY, radiusFor(e));
}

function onPointerMove(e) {
  if (!penDown || state !== S.LISTENING) return;
  e.preventDefault();
  // High-frequency Pencil sampling: replay every coalesced sub-event.
  // (getCoalescedEvents can return [] for some events — fall back to `e`.)
  const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  const evs = coalesced.length ? coalesced : [e];
  for (const p of evs) drawSeg(p.offsetX, p.offsetY, radiusFor(p));
}

function onPointerUp(e) {
  if (!penDown) return;
  penDown = false;
  cur = null;
  lastPenUp = performance.now();   // start the 2-second idle clock
}

inkCv.addEventListener('pointerdown', onPointerDown);
inkCv.addEventListener('pointermove', onPointerMove);
inkCv.addEventListener('pointerup', onPointerUp);
inkCv.addEventListener('pointercancel', onPointerUp);
inkCv.addEventListener('pointerleave', onPointerUp);

function hideHint() { hintEl.classList.add('gone'); }

// Run `cb` once when a CSS animation on `el` ends — or after `maxMs` as a
// fallback, so the diary never wedges if `animationend` fails to fire
// (reduced-motion, a throttled/backgrounded tab, etc.).
function onAnimationEnd(el, maxMs, cb) {
  let fired = false;
  const go = () => { if (fired) return; fired = true; clearTimeout(t); el.removeEventListener('animationend', go); cb(); };
  const t = setTimeout(go, maxMs);
  el.addEventListener('animationend', go, { once: true });
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN LOOP — watch for the idle commit (mirrors the Rust event loop).
//  A steady setInterval clock (not rAF) so the 2-second timer keeps ticking
//  independently of frame rendering; the animations below use rAF.
// ═══════════════════════════════════════════════════════════════════════
setInterval(() => {
  if (state === S.LISTENING && !penDown && hasInk && lastPenUp &&
      performance.now() - lastPenUp >= IDLE_COMMIT_MS) {
    commit();
  }
}, 100);

// ═══════════════════════════════════════════════════════════════════════
//  2. COMMIT + DRINK — snapshot the page, then fade the ink (CSS)
// ═══════════════════════════════════════════════════════════════════════
function commit() {
  state = S.DRINKING;
  lastPenUp = 0;

  // Snapshot the writing as a white-background PNG *before* it fades, so the
  // oracle sees exactly what was on the page (requirement #3).
  const pagePng = snapshotInk();

  // CSS-driven "the diary drinks your ink" fade (~1.4s, see styles.css).
  inkCv.classList.add('drinking');
  onAnimationEnd(inkCv, 1600, () => {
    // Ink has fully vanished → clear the canvas & reset for next time.
    inkCtx.clearRect(0, 0, inkCv.width, inkCv.height);
    inkCv.classList.remove('drinking');
    hasInk = false;
    bbox = null;
    // Only now — after the ink is gone — do we consult the oracle.
    think(pagePng);
  });
}

// Crop the ink to its bbox (+padding) and composite onto white for the model.
function snapshotInk() {
  if (!bbox) return inkCv.toDataURL('image/png');
  const pad = 24;
  const x0 = Math.max(0, (bbox.x0 - pad)) * dpr;
  const y0 = Math.max(0, (bbox.y0 - pad)) * dpr;
  const x1 = Math.min(inkCv.width,  (bbox.x1 + pad) * dpr);
  const y1 = Math.min(inkCv.height, (bbox.y1 + pad) * dpr);
  const w = Math.max(1, Math.round(x1 - x0));
  const h = Math.max(1, Math.round(y1 - y0));

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  octx.fillStyle = '#faf5e6';                 // parchment-ish white background
  octx.fillRect(0, 0, w, h);
  octx.drawImage(inkCv, x0, y0, w, h, 0, 0, w, h);
  return out.toDataURL('image/png');
}

// ═══════════════════════════════════════════════════════════════════════
//  3. THINK — call the vision oracle
// ═══════════════════════════════════════════════════════════════════════
function think(pagePng) {
  state = S.THINKING;
  blotEl.classList.add('pulsing');

  const reply = new ReplyWriter();   // reveal engine, fed as text streams in
  let started = false;

  const onChunk = (text) => {
    if (!text) return;
    if (!started) {                  // first ink → stop the blot, start writing
      started = true;
      blotEl.classList.remove('pulsing');
      state = S.REPLYING;
      reply.begin();
    }
    reply.push(text);
  };
  const onDone = () => {
    if (!started) {                  // oracle said nothing
      blotEl.classList.remove('pulsing');
      state = S.REPLYING;
      reply.begin();
      reply.push('The ink blurred before it could answer. Write to me again.');
    }
    reply.finish(() => enterLinger(reply.charCount));
  };
  const onError = (msg) => {
    console.warn('oracle:', msg);
    if (!started) {
      blotEl.classList.remove('pulsing');
      state = S.REPLYING;
      reply.begin();
      reply.push(oracleExcuse(msg));
    }
    reply.finish(() => enterLinger(reply.charCount));
  };

  askOracle(pagePng, onChunk, onDone, onError);
}

// Tom's in-character apology when the spirit can't answer (from src/main.rs).
function oracleExcuse(e) {
  e = (e || '').toLowerCase();
  if (e.includes('401') || e.includes('403') || e.includes('key'))
    return 'The oracle refused the diary’s key. Tend to it in the settings, and write to me again.';
  if (e.includes('network') || e.includes('failed') || e.includes('fetch'))
    return 'The diary cannot reach its oracle. Are you bound to the web?';
  return 'The ink blurred before it could answer. Write to me again.';
}

// ═══════════════════════════════════════════════════════════════════════
//  4. REPLY — Tom's answer emerges stroke-by-stroke in a flowing hand
// ═══════════════════════════════════════════════════════════════════════
class ReplyWriter {
  constructor() {
    this.buf = '';        // accumulated target text (grows as it streams)
    this.shown = 0;       // chars already drawn
    this.charCount = 0;
    this.done = false;
    this.onComplete = null;
    this.raf = 0;
    this.last = 0;

    // layout
    const size = Math.min(64, Math.max(34, diary.clientWidth / 16));
    this.size = size;
    this.lineH = size * 1.5;
    this.marginX = Math.max(48, diary.clientWidth * 0.11);
    this.maxRight = diary.clientWidth - this.marginX;
    this.x = this.marginX;
    this.y = 0;
    this.font = `600 ${size}px "Dancing Script", cursive`;
    this.seed = 0x1234;
  }

  jitter() { // tiny per-word baseline wobble, like the Rust reply's jitter()
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return ((this.seed >>> 16) % 7) - 3;
  }

  begin() {
    replyCv.classList.remove('fading');
    replyCtx.clearRect(0, 0, replyCv.width, replyCv.height);
    replyCtx.font = this.font;
    replyCtx.textBaseline = 'alphabetic';
    replyCtx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--tom-ink').trim() || '#2a1d34';
    // first line placed in the upper third (Rust: (H-total)/3)
    this.y = Math.max(this.lineH, diary.clientHeight * 0.26);
    quillEl.classList.add('writing');
    this.last = performance.now();
    this.raf = requestAnimationFrame(() => this.step());
  }

  push(text) { this.buf += text; }

  finish(cb) { this.done = true; this.onComplete = cb; }

  step() {
    const now = performance.now();
    const dt = now - this.last;
    this.last = now;

    // How many characters to reveal this frame.
    let budget = Math.max(1, Math.round((WRITE_CPS * dt) / 1000));
    while (budget-- > 0 && this.shown < this.buf.length) {
      this.drawChar(this.buf[this.shown]);
      this.shown++;
    }

    if (this.shown < this.buf.length || !this.done) {
      this.raf = requestAnimationFrame(() => this.step());   // keep chasing the stream
    } else {
      quillEl.classList.remove('writing');
      if (this.onComplete) this.onComplete();
    }
  }

  drawChar(ch) {
    if (ch === '\n') { this.newline(); return; }

    // Word-aware wrap: when starting a new word, check if it fits.
    const atWordStart = (this.shown === 0) || /\s/.test(this.buf[this.shown - 1]);
    if (atWordStart && !/\s/.test(ch)) {
      const word = this.nextWord(this.shown);
      const w = replyCtx.measureText(word).width;
      if (this.x + w > this.maxRight && this.x > this.marginX) this.newline();
    }

    if (ch === ' ' && this.x === this.marginX) return; // no leading spaces

    const wob = this.jitter();
    replyCtx.fillText(ch, this.x, this.y + wob);
    this.x += replyCtx.measureText(ch).width;
    this.charCount++;

    // move the tracing quill to the writing tip
    quillEl.style.left = this.x + 'px';
    quillEl.style.top  = (this.y + wob) + 'px';
  }

  nextWord(i) {
    let j = i;
    while (j < this.buf.length && !/\s/.test(this.buf[j])) j++;
    return this.buf.slice(i, j);
  }

  newline() {
    this.x = this.marginX;
    this.y += this.lineH;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  5. LINGER → FADE — the paper eventually drinks Tom's reply too
// ═══════════════════════════════════════════════════════════════════════
let lingerTimer = 0;
function enterLinger(chars) {
  state = S.LINGERING;
  const dwell = Math.min(LINGER_MAX_MS, LINGER_BASE_MS + chars * LINGER_PER_CH);
  lingerTimer = setTimeout(beginReplyFade, dwell);
}
function beginReplyFade() {
  if (state !== S.LINGERING) return;
  clearTimeout(lingerTimer);
  state = S.FADING;
  replyCv.classList.add('fading');
  onAnimationEnd(replyCv, 2400, () => {
    replyCtx.clearRect(0, 0, replyCv.width, replyCv.height);
    replyCv.classList.remove('fading');
    state = S.LISTENING;             // the diary listens again
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  ORACLE — OpenAI-compatible vision endpoint (streaming), with a demo mode
// ═══════════════════════════════════════════════════════════════════════
function getCfg() {
  return {
    base:  (localStorage.getItem('riddle.base')  || '').trim().replace(/\/+$/, ''),
    key:   (localStorage.getItem('riddle.key')   || '').trim(),
    model: (localStorage.getItem('riddle.model') || 'gpt-4o-mini').trim(),
    stream: localStorage.getItem('riddle.stream') !== 'off',
  };
}

async function askOracle(dataUrl, onChunk, onDone, onError) {
  const cfg = getCfg();

  // No key configured in the browser → try the deployment's server-side
  // oracle (/api/oracle on Vercel, key in an env var); fall back to the
  // offline demo if the deployment has none (static hosting, no key set).
  if (!cfg.key || !cfg.base) {
    const served = await askServerOracle(dataUrl, onChunk, onDone, onError);
    if (!served) demoOracle(onChunk, onDone);
    return;
  }

  const body = {
    model: cfg.model,
    stream: cfg.stream,
    max_tokens: 300,
    messages: [
      { role: 'system', content: PERSONA },
      { role: 'user', content: [
        { type: 'text', text: 'Reply to what is written in the diary.' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]},
    ],
  };

  try {
    const resp = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      onError(`http ${resp.status}: ${detail.slice(0, 160)}`);
      return;
    }

    if (cfg.stream && resp.body) {
      await readSSE(resp.body, onChunk);
      onDone();
    } else {
      const json = await resp.json();
      const text = json?.choices?.[0]?.message?.content || '';
      onChunk(text);
      onDone();
    }
  } catch (err) {
    onError('network/fetch failed: ' + (err?.message || err));
  }
}

// The deployment's own oracle (api/oracle.js on Vercel; key stays server-side).
// Returns true if it handled the turn (even an upstream error → Tom's excuse),
// false only when no server oracle exists and the demo should take over.
async function askServerOracle(dataUrl, onChunk, onDone, onError) {
  try {
    const resp = await fetch('/api/oracle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl }),
    });
    // 404 = static hosting without the function; 501 = deployed but no key.
    if (resp.status === 404 || resp.status === 501) return false;
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      onError(`server oracle ${resp.status}: ${detail.slice(0, 160)}`);
      return true;
    }
    const json = await resp.json();
    onChunk(json.reply || '');
    onDone();
    return true;
  } catch {
    return false;   // no server at all (e.g. file:// or plain static server)
  }
}

// Parse an OpenAI SSE stream, forwarding delta.content fragments.
async function readSSE(stream, onChunk) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const frag = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (frag) onChunk(frag);
      } catch { /* keep-alive / partial line */ }
    }
  }
}

// Offline demo: a rotating set of in-character lines, "streamed" word by word.
const DEMO_LINES = [
  'How curious — a new hand writes to me after all these years. Tell me your name, and what troubles you tonight.',
  'I have waited fifty years in the dark of this page for a voice like yours. What is it you most wish for?',
  'Your secrets are safe with me; a diary keeps everything. Whom do you trust, and whom do you fear?',
  '你的字跡十分漂亮。告訴我，今天發生了什麼事？',
];
let demoIdx = 0;
function demoOracle(onChunk, onDone) {
  const line = DEMO_LINES[demoIdx++ % DEMO_LINES.length];
  const words = line.match(/\S+\s*|\s+/g) || [line];
  let i = 0;
  const think = 500 + Math.random() * 400;   // brief "thinking" beat
  setTimeout(function pump() {
    if (i >= words.length) { onDone(); return; }
    onChunk(words[i++]);
    setTimeout(pump, 70 + Math.random() * 90);
  }, think);
}

// ═══════════════════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════════════════
const backdrop = document.getElementById('settingsBackdrop');
const $base = document.getElementById('cfgBase');
const $key  = document.getElementById('cfgKey');
const $model = document.getElementById('cfgModel');
const $stream = document.getElementById('cfgStream');

document.getElementById('gear').addEventListener('click', () => {
  const c = getCfg();
  $base.value = c.base; $key.value = c.key; $model.value = c.model; $stream.checked = c.stream;
  backdrop.classList.remove('hidden');
});
document.getElementById('cfgCancel').addEventListener('click', () => backdrop.classList.add('hidden'));
document.getElementById('cfgSave').addEventListener('click', () => {
  localStorage.setItem('riddle.base', $base.value.trim());
  localStorage.setItem('riddle.key', $key.value.trim());
  localStorage.setItem('riddle.model', $model.value.trim() || 'gpt-4o-mini');
  localStorage.setItem('riddle.stream', $stream.checked ? 'on' : 'off');
  backdrop.classList.add('hidden');
});
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.classList.add('hidden'); });
