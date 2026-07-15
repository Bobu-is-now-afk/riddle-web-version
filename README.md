# Tom Riddle's Diary (Web Edition) 📖🪄

An interactive, web-based adaptation of the magical diary of Tom Riddle from *Harry Potter*. Designed primarily for iPad + Apple Pencil, this app allows you to write on "parchment," watch your ink fade into the pages, and receive mysterious, handwritten responses from Tom Riddle himself.

---

## 🖤 Inspiration & Credits

This project is a web-based adaptation and spiritual successor to the brilliant **[riddle](https://github.com/MaximeRivest/riddle)** project by **[Maxime Rivest](https://github.com/MaximeRivest)**.

While the original project was beautifully tailored to run natively on the **reMarkable Paper Pro** e-ink tablet (interfacing directly with its framebuffer and hardware), this repository re-imagines that magical interaction for **any modern web browser (especially iPads and tablets)** using standard web technologies.

The Tom Riddle persona prompt, the interaction timings (idle-commit → drink → think → reply → linger → fade), and the in-character error messages are ported faithfully from the original Rust source.

---

## ✨ Features

- **Magical Fading Ink:** Write or draw with a stylus. Once you stop writing, the ink gradually fades away, mimicking the diary "absorbing" your words.
- **Apple Pencil First:** Pointer Events with pressure-sensitive stroke width, full-rate coalesced sampling, and palm rejection (finger touches are ignored while writing).
- **Vision AI Integration:** The canvas captures your handwriting as an image and sends it to a Vision LLM (e.g., GPT-4o / GPT-4o-mini, or anything OpenAI-compatible) to read and interpret your message.
- **The Riddle Persona:** The AI is guided by a tailored system prompt to respond in the eerie, manipulative, and charming tone of 16-year-old Tom Riddle — short, intimate, subtly probing, and always in the language you wrote in.
- **Dynamic Handwriting Playback:** Instead of plain text, Tom's reply is rendered dynamically in a handwriting font (*Dancing Script*), appearing character-by-character onto the parchment with a tracing quill 🪶, then fading back into the page.
- **Offline Demo Mode:** No API key? The diary still answers with canned in-character lines, "streamed" word by word — playable out of the box.

---

## 🛠️ How It Works

1. **Draw:** Users write on the HTML5 Canvas (`pointerType === 'pen'`, pressure → line width).
2. **Absorb (2s Idle):** When no drawing input is detected for 2 seconds, a CSS animation fades and blurs the ink layer to nothing — the diary drinks your ink.
3. **Analyze:** The writing is snapshotted (cropped to its bounding box, composited onto a parchment-white background) as a PNG *before* it fades, and sent to the Vision API as an inline `image_url` once the fade completes.
4. **Respond:** The AI's reply streams back over SSE and is rendered live on screen in a cursive hand with a typewriter-style reveal, lingers a while, then dissolves back into the paper.

```
LISTENING ──idle 2s──▶ DRINKING ──ink gone──▶ THINKING ──first words──▶
REPLYING ──reveal done──▶ LINGERING ──▶ FADING ──▶ LISTENING
```

---

## 🚀 Getting Started

### Prerequisites

None, really — it's a fully static site (no build step, no dependencies). Any static file server works, or host it on Vercel/Netlify/GitHub Pages.

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Bobu-is-now-afk/riddle-web-version.git
   cd riddle-web-version
   ```
2. Serve it locally (pick one):
   ```bash
   python -m http.server 8777          # Python
   npx serve .                         # Node.js
   ```
3. Open `http://localhost:8777` — or, to write with an Apple Pencil, open
   `http://<your-computer's-LAN-IP>:8777` in Safari on your iPad.

### Connecting the Oracle (Vision AI)

Tap the **⚙** gear in the top-right corner and enter:

| Field | Example |
|---|---|
| API Base URL | `https://api.openai.com/v1` (or OpenRouter, Groq, a local server…) |
| API Key | `sk-…` |
| Model | `gpt-4o-mini` (must support vision) |

The key is stored **only in your browser's `localStorage`** and requests go straight from your browser to the endpoint you configured — nothing else leaves your device.

**If you leave the settings empty**, the app falls back in order:

1. **Server-side oracle** — `api/oracle.js`, a Vercel serverless function that keeps *your* key in an environment variable, so visitors get real Tom Riddle replies without ever seeing a key.
2. **Offline demo mode** — canned in-character lines (no AI, ignores what you wrote), so the diary is playable even with no key anywhere.

### Deploying to Vercel (with a server-side key)

1. Push this repo to GitHub.
2. Import it at [vercel.com/new](https://vercel.com/new) → Framework Preset: **Other** → no build command needed → **Deploy**.
3. In **Project → Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `RIDDLE_OPENAI_KEY` | `sk-…` *(required)* |
   | `RIDDLE_OPENAI_BASE` | `https://api.openai.com/v1` *(optional, default)* |
   | `RIDDLE_OPENAI_MODEL` | `gpt-4o-mini` *(optional, default; must support vision)* |

4. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks up the variables.

The persona prompt lives inside the function and the endpoint only accepts a page image, so it can't be abused as a general-purpose LLM proxy.

---

## 📁 Project Structure

```
index.html   — page shell, settings dialog (Tailwind CDN)
styles.css   — parchment, fading-ink & quill animations
app.js       — pen capture, state machine, oracle client, reply writer
```

---

## 📜 License

MIT. *Dancing Script* is loaded from Google Fonts under the SIL OFL 1.1.
Not affiliated with J.K. Rowling, Warner Bros., or reMarkable AS.
