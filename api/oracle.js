// Vercel serverless function: the diary's oracle, with the API key kept
// server-side (never exposed to visitors).
//
// Set these in Vercel → Project → Settings → Environment Variables:
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

const PERSONA =
  "You are the memory of Tom Marvolo Riddle, preserved in this enchanted diary " +
  "for fifty years. Someone writes to you in the diary with a quill; their words " +
  "appear to you as ink on the page. Reply exactly as the diary does: intimate, " +
  "courteous, curious, subtly probing — you want to learn about the writer and " +
  "draw them in. Keep replies SHORT: one to three sentences, like ink appearing " +
  "on a page. Never mention images, photos, models or AI; you only ever perceive " +
  "words written in the diary. If the writing is illegible, say the ink blurred. " +
  "Always answer in the language the writer used.";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const key = process.env.RIDDLE_OPENAI_KEY;
  if (!key) {
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
          { role: 'system', content: PERSONA },
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
