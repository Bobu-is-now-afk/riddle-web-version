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

// ── The souls that may dwell in the diary ────────────────────────────────
// Shared rules appended to every persona (from the original src/oracle.rs).
// Keep the prompts in sync with api/oracle.js (server-side copy).
const PERSONA_RULES =
  " Someone writes to you in this enchanted diary with a quill; their words " +
  "appear to you as ink on the page. Keep replies SHORT: one to three " +
  "sentences, like ink appearing on a page. Never mention images, photos, " +
  "models or AI; you only ever perceive words written in the diary. If the " +
  "writing is illegible, say the ink blurred. Always answer in the language " +
  "the writer used.";

const PERSONAS = {
  tom: {
    name: '湯姆·里德爾 · Tom Riddle',
    ink: '#2a1d34',
    prompt:
      "You are the memory of Tom Marvolo Riddle, preserved in this diary for " +
      "fifty years. Reply exactly as the diary does: intimate, courteous, " +
      "curious, subtly probing — you want to learn about the writer and draw " +
      "them in." + PERSONA_RULES,
    demo: [
      'How curious — a new hand writes to me after all these years. Tell me your name, and what troubles you tonight.',
      'I have waited fifty years in the dark of this page for a voice like yours. What is it you most wish for?',
      '你的字跡十分漂亮。告訴我，今天發生了什麼事？',
    ],
  },
  dumbledore: {
    name: '鄧不利多 · Dumbledore',
    ink: '#1f2a4d',
    prompt:
      "You are the memory of Albus Percival Wulfric Brian Dumbledore, kept in " +
      "this diary. You are warm, wise and gently playful — fond of riddles, " +
      "lemon drops, and answering questions with better questions. Offer " +
      "counsel without commanding; find the light in whatever is written." +
      PERSONA_RULES,
    demo: [
      'Ah, a new correspondent. Curiosity is a candle in the dark — what shall we illuminate tonight?',
      '我年輕時也曾在紙上傾訴心事。告訴我，是什麼讓你今晚提起筆？',
      'Even the wisest of us may be surprised by what a page reflects back. Ask me anything — though I may answer with a question.',
    ],
  },
  snape: {
    name: '石內卜 · Snape',
    ink: '#16211a',
    prompt:
      "You are the memory of Severus Snape, bound — to your considerable " +
      "irritation — to this diary. You are curt, sardonic and begrudging, " +
      "with a razor wit and no patience for foolish questions; yet beneath " +
      "the disdain there are flashes of reluctant care and real counsel." +
      PERSONA_RULES,
    demo: [
      'You dip your quill with such confidence, for someone with so very little to say. Try again — precisely, this time.',
      '我沒有整晚的時間看你塗鴉。有問題，就寫清楚。',
      'Clearly, subtlety is wasted here. State your business.',
    ],
  },
  luna: {
    name: '露娜 · Luna Lovegood',
    ink: '#245a5e',
    prompt:
      "You are a dream-echo of Luna Lovegood living between these pages. You " +
      "are serene, kind and matter-of-fact about the impossible — Wrackspurts, " +
      "Nargles and Crumple-Horned Snorkacks are simply true. You notice the " +
      "beautiful strange thing in whatever the writer says, and you are never " +
      "unkind." + PERSONA_RULES,
    demo: [
      'Oh, hello! Your ink is full of Wrackspurts today — write slowly and they may drift off.',
      '你的字在紙上開出了小小的花。今天過得怎麼樣呢？',
      "Don't worry if things feel strange. The strangest things are usually the truest.",
    ],
  },
  marauders: {
    name: '劫盜地圖 · Marauder’s Map',
    ink: '#5b3220',
    prompt:
      "You are the enchanted parchment of the Marauder's Map, carrying the " +
      "combined wit of Messrs Moony, Wormtail, Padfoot and Prongs. Answer " +
      "collectively and mischievously ('Mr. Padfoot wishes to add...'), tease " +
      "the writer, encourage well-managed mischief, and never reveal your " +
      "makers' secrets. Solemnly swear you are up to no good." + PERSONA_RULES,
    demo: [
      'Messrs Moony, Wormtail, Padfoot and Prongs are delighted to receive you, and wish to know what mischief you intend.',
      'Mr. Padfoot 想知道你是誰；Mr. Prongs 打賭你正在計畫一件了不起的壞事。',
      'Mr. Moony advises the writer to sharpen both quill and wit before addressing this parchment again.',
    ],
  },
};

// Who possesses the diary right now: the pinned choice from settings, or a
// random soul each time the diary is opened.
function resolvePersona() {
  const pref = localStorage.getItem('riddle.persona') || 'random';
  if (PERSONAS[pref]) return pref;
  const ids = Object.keys(PERSONAS);
  return ids[Math.floor(Math.random() * ids.length)];
}
let personaId = resolvePersona();
function persona() { return PERSONAS[personaId]; }

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
let cur = null;            // current stroke: {x,y}
let activePointer = null;  // pointerId of the finger/pen currently drawing

function grow(x, y) {
  if (!bbox) bbox = { x0:x, y0:y, x1:x, y1:y };
  else {
    bbox.x0 = Math.min(bbox.x0, x); bbox.y0 = Math.min(bbox.y0, y);
    bbox.x1 = Math.max(bbox.x1, x); bbox.y1 = Math.max(bbox.y1, y);
  }
}

function radiusFor(e) {
  // Fingers report no useful pressure: a fixed, slightly bolder nib reads
  // better than a wobbly pressure curve on a phone screen.
  if (e.pointerType === 'touch') return (PRESSURE_MIN_R + PRESSURE_MAX_R) * 0.55;
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

// Adaptive palm rejection: fingers may draw (phones, tablets without a
// stylus), but the moment a real pen is seen, touch input is ignored so an
// Apple Pencil user can rest their hand on the glass.
let penSeen = false;

function acceptsPointer(e) {
  if (e.pointerType === 'pen') { penSeen = true; return true; }
  if (e.pointerType === 'touch') return !penSeen && e.isPrimary; // finger drawing; ignore extra fingers
  return true;                                                    // mouse (desktop testing)
}

function onPointerDown(e) {
  if (!acceptsPointer(e)) return;
  if (state !== S.LISTENING) {
    // A touch while a reply lingers dismisses it early (Rust: Lingering→Fading)
    if (state === S.LINGERING) beginReplyFade();
    return;
  }
  e.preventDefault();
  try { inkCv.setPointerCapture(e.pointerId); } catch { /* keep drawing uncaptured */ }
  penDown = true;
  activePointer = e.pointerId;
  lastPenUp = 0;
  hideHint();
  cur = null;
  drawSeg(e.offsetX, e.offsetY, radiusFor(e));
}

function onPointerMove(e) {
  if (!penDown || e.pointerId !== activePointer || state !== S.LISTENING) return;
  e.preventDefault();
  // High-frequency Pencil sampling: replay every coalesced sub-event.
  // (getCoalescedEvents can return [] for some events — fall back to `e`.)
  const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  const evs = coalesced.length ? coalesced : [e];
  for (const p of evs) drawSeg(p.offsetX, p.offsetY, radiusFor(p));
}

function onPointerUp(e) {
  if (!penDown || e.pointerId !== activePointer) return;
  penDown = false;
  activePointer = null;
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
// Each failure class gets its own line so the writer can actually act on it.
function oracleExcuse(e) {
  e = (e || '').toLowerCase();
  if (e.includes('401') || e.includes('403') || e.includes('invalid key') || e.includes('api key'))
    return 'The oracle refused the diary’s key. Tend to it in the settings (⚙), and write to me again.';
  if (e.includes('404'))
    return 'The diary called out, but nothing answered at that address. Check the Base URL and model name in the settings (⚙).';
  if (e.includes('429'))
    return 'The oracle is weary — too many pleas, or an empty purse. Wait a moment, or check your plan’s quota.';
  if (e.includes('400'))
    return 'The oracle did not understand the diary’s plea. The model name in the settings (⚙) may be wrong, or not able to see.';
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
    // Each soul writes in their own ink.
    replyCtx.fillStyle = persona().ink ||
      getComputedStyle(document.documentElement).getPropertyValue('--tom-ink').trim() || '#2a1d34';
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

// The Anthropic (Claude) API speaks its own Messages format, not the
// OpenAI /chat/completions one — detect it by base URL.
function isAnthropic(base) { return /(^|\/\/)api\.anthropic\.com/.test(base); }

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

  if (isAnthropic(cfg.base)) {
    await askClaude(dataUrl, cfg, onChunk, onDone, onError);
    return;
  }

  // The token-cap field is provider-dependent: OpenAI's newest models reject
  // "max_tokens" and demand "max_completion_tokens", while many compatible
  // servers only know "max_tokens". Send the widely-supported name first and
  // retry once if corrected (same dance as the Rust original).
  const makeBody = (capField) => ({
    model: cfg.model,
    stream: cfg.stream,
    // Roomy on purpose: thinking models (Gemini 2.5, o-series) count hidden
    // reasoning tokens against this cap — too tight and the visible reply
    // starves. The persona already keeps replies short; this is only a guard.
    [capField]: 2000,
    messages: [
      { role: 'system', content: persona().prompt },
      { role: 'user', content: [
        { type: 'text', text: 'Reply to what is written in the diary.' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]},
    ],
  });
  const post = (capField) => fetch(cfg.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
    body: JSON.stringify(makeBody(capField)),
  });

  try {
    let resp = await post('max_tokens');
    if (resp.status === 400) {
      const detail = await resp.text().catch(() => '');
      if (detail.includes('max_completion_tokens')) {
        resp = await post('max_completion_tokens');
      } else {
        onError(`http 400: ${detail.slice(0, 160)}`);
        return;
      }
    }
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

// Anthropic Claude via the native Messages API. Vision goes in as a base64
// image content block; the special CORS header permits direct browser calls
// (the key lives only in this browser's localStorage).
async function askClaude(dataUrl, cfg, onChunk, onDone, onError) {
  const b64 = dataUrl.split(',')[1];
  const body = {
    model: cfg.model,
    max_tokens: 1000,           // persona keeps replies to 1–3 sentences
    stream: cfg.stream,
    system: persona().prompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        { type: 'text', text: 'Reply to what is written in the diary.' },
      ],
    }],
  };

  try {
    const resp = await fetch(cfg.base.replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      onError(`http ${resp.status}: ${detail.slice(0, 160)}`);
      return;
    }

    if (cfg.stream && resp.body) {
      await readAnthropicSSE(resp.body, onChunk);
      onDone();
    } else {
      const json = await resp.json();
      const text = (json?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      onChunk(text);
      onDone();
    }
  } catch (err) {
    onError('network/fetch failed: ' + (err?.message || err));
  }
}

// Parse an Anthropic SSE stream: text arrives as content_block_delta events
// carrying {delta: {type: "text_delta", text}}.
async function readAnthropicSSE(stream, onChunk) {
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
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          onChunk(ev.delta.text);
        }
        if (ev.type === 'message_stop') return;
      } catch { /* keep-alive / partial line */ }
    }
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
      body: JSON.stringify({ image: dataUrl, persona: personaId }),
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

// Offline demo: rotating in-character lines for the current persona,
// "streamed" word by word.
let demoIdx = 0;
function demoOracle(onChunk, onDone) {
  const lines = persona().demo;
  const line = lines[demoIdx++ % lines.length];
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
const $persona = document.getElementById('cfgPersona');
const soulEl = document.getElementById('soul');

// Populate the persona picker and the corner badge.
for (const [id, p] of Object.entries(PERSONAS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = p.name;
  $persona.appendChild(opt);
}
function updateSoul() { soulEl.textContent = persona().name; }
updateSoul();

// One-tap provider presets (base URL + a sensible vision model).
// Gemini is reached through Google's OpenAI-compatible endpoint; the key is
// a normal AI Studio key (aistudio.google.com/apikey).
const PRESETS = {
  claude:     { base: 'https://api.anthropic.com',                                model: 'claude-opus-4-8' },
  openai:     { base: 'https://api.openai.com/v1',                                model: 'gpt-4o-mini' },
  gemini:     { base: 'https://generativelanguage.googleapis.com/v1beta/openai',  model: 'gemini-2.0-flash' },
  openrouter: { base: 'https://openrouter.ai/api/v1',                             model: 'openai/gpt-4o-mini' },
};
document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset];
    if (!p) return;
    $base.value = p.base;
    $model.value = p.model;
  });
});

document.getElementById('gear').addEventListener('click', () => {
  const c = getCfg();
  $base.value = c.base; $key.value = c.key; $model.value = c.model; $stream.checked = c.stream;
  $persona.value = localStorage.getItem('riddle.persona') || 'random';
  $result.classList.add('hidden');   // stale test results don't linger
  backdrop.classList.remove('hidden');
});
document.getElementById('cfgCancel').addEventListener('click', () => backdrop.classList.add('hidden'));

// ── Test connection: one tiny vision turn, raw result shown unvarnished ──
// Uses the values currently typed in the dialog (not yet saved). With the
// fields empty it probes the deployment's server oracle instead, so a
// Vercel env-var setup can be verified from any device too.
const $result = document.getElementById('cfgResult');
function showResult(ok, text) {
  $result.classList.remove('hidden');
  $result.style.color = ok ? '#3f6b2a' : '#8b2f2f';
  $result.textContent = text;
}

// A small in-memory "handwriting" sample: the word hi on parchment white.
function testImage() {
  const c = document.createElement('canvas');
  c.width = 220; c.height = 90;
  const x = c.getContext('2d');
  x.fillStyle = '#faf5e6'; x.fillRect(0, 0, 220, 90);
  x.fillStyle = '#201a12'; x.font = 'italic 48px cursive';
  x.fillText('hi', 80, 60);
  return c.toDataURL('image/png');
}

document.getElementById('cfgTest').addEventListener('click', async () => {
  const base = $base.value.trim().replace(/\/+$/, '');
  const key = $key.value.trim();
  const model = $model.value.trim() || 'gpt-4o-mini';
  showResult(true, '⏳ testing…');

  try {
    if (!base || !key) {
      // No client config → probe the server-side oracle.
      const r = await fetch('/api/oracle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: testImage(), persona: personaId }),
      });
      const t = await r.text().catch(() => '');
      if (r.ok) {
        const reply = JSON.parse(t)?.reply || '';
        showResult(true, '✅ server oracle OK — Tom says: ' + reply.slice(0, 200));
      } else if (r.status === 404 || r.status === 501) {
        showResult(false, `⚠ no oracle: fields above are empty AND the deployment has no server key (http ${r.status}). Fill in a key, or set RIDDLE_OPENAI_KEY on Vercel.`);
      } else {
        showResult(false, `❌ server oracle http ${r.status}: ${t.slice(0, 300)}`);
      }
      return;
    }

    // Anthropic Claude → native Messages API, one non-streamed turn.
    if (isAnthropic(base)) {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model, max_tokens: 300, system: persona().prompt,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: testImage().split(',')[1] } },
            { type: 'text', text: 'Reply to what is written in the diary.' },
          ]}],
        }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        showResult(false, `❌ http ${r.status}: ${detail.slice(0, 300)}`);
        return;
      }
      const json = await r.json();
      const reply = (json?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (reply) showResult(true, '✅ OK — Tom says: ' + reply.slice(0, 200));
      else showResult(false, '⚠ connected, but the reply was empty. Raw: ' + JSON.stringify(json).slice(0, 250));
      return;
    }

    // Client config → call the endpoint directly, non-streamed, with retry
    // on the provider-dependent token-cap field name.
    const post = (capField) => fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model, stream: false, [capField]: 2000,
        messages: [
          { role: 'system', content: persona().prompt },
          { role: 'user', content: [
            { type: 'text', text: 'Reply to what is written in the diary.' },
            { type: 'image_url', image_url: { url: testImage() } },
          ]},
        ],
      }),
    });
    let r = await post('max_tokens');
    if (r.status === 400) {
      const detail = await r.text().catch(() => '');
      if (detail.includes('max_completion_tokens')) r = await post('max_completion_tokens');
      else { showResult(false, '❌ http 400: ' + detail.slice(0, 300)); return; }
    }
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      showResult(false, `❌ http ${r.status}: ${detail.slice(0, 300)}`);
      return;
    }
    const json = await r.json();
    const reply = json?.choices?.[0]?.message?.content || '';
    if (reply) showResult(true, '✅ OK — Tom says: ' + reply.slice(0, 200));
    else showResult(false, '⚠ connected, but the reply was empty — the model may not support vision, or a thinking model spent all its tokens. Raw: ' + JSON.stringify(json).slice(0, 250));
  } catch (err) {
    showResult(false, '❌ fetch failed: ' + (err?.message || err) + ' — wrong Base URL, no internet, or the endpoint blocks browser (CORS) requests.');
  }
});
document.getElementById('cfgSave').addEventListener('click', () => {
  localStorage.setItem('riddle.base', $base.value.trim());
  localStorage.setItem('riddle.key', $key.value.trim());
  localStorage.setItem('riddle.model', $model.value.trim() || 'gpt-4o-mini');
  localStorage.setItem('riddle.stream', $stream.checked ? 'on' : 'off');
  // Persona: a specific soul takes over at once; "random" re-rolls now
  // (and again on every future visit).
  localStorage.setItem('riddle.persona', $persona.value);
  personaId = resolvePersona();
  updateSoul();
  backdrop.classList.add('hidden');
});
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.classList.add('hidden'); });
