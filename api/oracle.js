// Vercel serverless function: the diary's oracle, with the API key kept
// server-side (never exposed to visitors).
//
// Set ONE provider in Vercel → Project → Settings → Environment Variables:
//
// Anthropic Claude (native Messages API; takes precedence when set):
//   RIDDLE_ANTHROPIC_KEY   (required)  sk-ant-… from platform.claude.com
//   RIDDLE_ANTHROPIC_MODEL (optional)  default claude-opus-4-8
//                                      (claude-haiku-4-5 is the budget pick)
//
// Any OpenAI-compatible endpoint:
//   RIDDLE_OPENAI_KEY    (required)  e.g. sk-… (or a Google AI Studio key)
//   RIDDLE_OPENAI_BASE   (optional)  default https://api.openai.com/v1
//   RIDDLE_OPENAI_MODEL  (optional)  default gpt-4o-mini  (must support vision)
//
// Google Gemini works through its OpenAI-compatible endpoint:
//   RIDDLE_OPENAI_BASE  = https://generativelanguage.googleapis.com/v1beta/openai
//   RIDDLE_OPENAI_MODEL = gemini-2.0-flash   (or gemini-2.5-flash)
//   RIDDLE_OPENAI_KEY   = your AI Studio key (aistudio.google.com/apikey)
//
// The persona lives HERE, server-side, and the endpoint only accepts a page
// image — so it can't be repurposed as a generic LLM proxy.

// The souls that may dwell in the diary. The client sends a persona *id*
// (never a prompt), so this endpoint can't be repurposed as a generic proxy.
// Keep in sync with PERSONAS in app.js.
const PERSONA_RULES =
  " Someone writes to you in this enchanted diary with a quill; their words " +
  "appear to you as ink on the page. Keep replies SHORT: one to three " +
  "sentences, like ink appearing on a page. Never mention images, photos, " +
  "models or AI; you only ever perceive words written in the diary. If the " +
  "writing is illegible, say the ink blurred. Always answer in the language " +
  "the writer used.";

const PERSONAS = {
  tom:
    "You are the memory of Tom Marvolo Riddle, preserved in this diary for " +
    "fifty years. Reply exactly as the diary does: intimate, courteous, " +
    "curious, subtly probing — you want to learn about the writer and draw " +
    "them in." + PERSONA_RULES,
  dumbledore:
    "You are the memory of Albus Percival Wulfric Brian Dumbledore, kept in " +
    "this diary. You are warm, wise and gently playful — fond of riddles, " +
    "lemon drops, and answering questions with better questions. Offer " +
    "counsel without commanding; find the light in whatever is written." +
    PERSONA_RULES,
  snape:
    "You are the memory of Severus Snape, bound — to your considerable " +
    "irritation — to this diary. You are curt, sardonic and begrudging, " +
    "with a razor wit and no patience for foolish questions; yet beneath " +
    "the disdain there are flashes of reluctant care and real counsel." +
    PERSONA_RULES,
  luna:
    "You are a dream-echo of Luna Lovegood living between these pages. You " +
    "are serene, kind and matter-of-fact about the impossible — Wrackspurts, " +
    "Nargles and Crumple-Horned Snorkacks are simply true. You notice the " +
    "beautiful strange thing in whatever the writer says, and you are never " +
    "unkind." + PERSONA_RULES,
  marauders:
    "You are the enchanted parchment of the Marauder's Map, carrying the " +
    "combined wit of Messrs Moony, Wormtail, Padfoot and Prongs. Answer " +
    "collectively and mischievously ('Mr. Padfoot wishes to add...'), tease " +
    "the writer, encourage well-managed mischief, and never reveal your " +
    "makers' secrets. Solemnly swear you are up to no good." + PERSONA_RULES,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const anthropicKey = process.env.RIDDLE_ANTHROPIC_KEY;
  const key = process.env.RIDDLE_OPENAI_KEY;
  if (!anthropicKey && !key) {
    // No key configured on the deployment → tell the client to use demo mode.
    res.status(501).json({ error: 'no oracle configured' });
    return;
  }
  const base = (process.env.RIDDLE_OPENAI_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.RIDDLE_OPENAI_MODEL || 'gpt-4o-mini';

  const image = req.body && req.body.image;
  if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,') || image.length > 4_000_000) {
    res.status(400).json({ error: 'expected { image: "data:image/png;base64,…" }' });
    return;
  }
  // Unknown/absent persona ids fall back to Tom — never a client-supplied prompt.
  const personaPrompt = PERSONAS[req.body.persona] || PERSONAS.tom;

  // ── Anthropic Claude (native Messages API) ──
  if (anthropicKey) {
    try {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: process.env.RIDDLE_ANTHROPIC_MODEL || 'claude-opus-4-8',
          max_tokens: 1000,
          system: personaPrompt,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.split(',')[1] } },
              { type: 'text', text: 'Reply to what is written in the diary.' },
            ],
          }],
        }),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        res.status(502).json({ error: `upstream ${upstream.status}: ${detail.slice(0, 200)}` });
        return;
      }
      const json = await upstream.json();
      const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      res.status(200).json({ reply: text });
    } catch (err) {
      res.status(502).json({ error: 'oracle unreachable: ' + (err?.message || err) });
    }
    return;
  }

  try {
    // The token-cap field is provider-dependent: OpenAI's newest models
    // reject "max_tokens" and demand "max_completion_tokens", while many
    // compatible servers only know "max_tokens". Try the widely-supported
    // name first; retry once if corrected.
    const post = (capField) => fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        stream: false,
        // Roomy on purpose: thinking models (Gemini 2.5, o-series) count
        // hidden reasoning tokens against this cap — too tight and the
        // visible reply starves. The persona keeps replies short anyway.
        [capField]: 2000,
        messages: [
          { role: 'system', content: personaPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Reply to what is written in the diary.' },
            { type: 'image_url', image_url: { url: image } },
          ]},
        ],
      }),
    });

    let upstream = await post('max_tokens');
    if (upstream.status === 400) {
      const detail = await upstream.text().catch(() => '');
      if (detail.includes('max_completion_tokens')) {
        upstream = await post('max_completion_tokens');
      } else {
        res.status(502).json({ error: `upstream 400: ${detail.slice(0, 200)}` });
        return;
      }
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.status(502).json({ error: `upstream ${upstream.status}: ${detail.slice(0, 200)}` });
      return;
    }
    const json = await upstream.json();
    const text = json?.choices?.[0]?.message?.content || '';
    res.status(200).json({ reply: text });
  } catch (err) {
    res.status(502).json({ error: 'oracle unreachable: ' + (err?.message || err) });
  }
}
