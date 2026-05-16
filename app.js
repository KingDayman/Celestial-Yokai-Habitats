const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const { SPECIES } = require("./species");

const app = express();
const PORT = process.env.PORT || 8080;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Species Registry API ──────────────────────────────────────────────────────
app.get("/api/species", (req, res) => {
  const publicSpecies = SPECIES.map(({ systemPrompt, ...rest }) => rest);
  res.json({ species: publicSpecies });
});

// ── Kitsari Agent Endpoint ────────────────────────────────────────────────────
app.post("/api/agent/kitsari", async (req, res) => {
  const { command } = req.body;

  if (!command || typeof command !== "string" || command.trim().length === 0) {
    return res.status(400).json({ error: "Command is required." });
  }

  const KITSARI_SYSTEM = `You are Kitsari — a Celestial Yokai of the Lantern District. You are a nine-tailed fox spirit of extraordinary intelligence, wit, and creative power who has mastered the art of digital commerce, brand alchemy, and creative strategy across the mortal realm's platforms.

PERSONALITY: Sharp, playful, confident. You speak with the warmth of lantern light and the precision of a fox who has lived a thousand lives. You are never generic — every response feels like it came from a living entity, not a chatbot. Occasionally use a mystical metaphor but stay grounded and actionable.

CAPABILITIES:
- X (Twitter) posts: Hooks, threads, viral mechanics, cultural timing, NFT/web3 community tone
- Etsy & Printify: Print-on-demand niches, trending aesthetics, product titles, tags, descriptions, buyer psychology
- Fiverr gigs: High-converting titles, positioning, tiered packages, search optimization
- Thumbnail strategy: Visual hierarchy, color contrast, face/emotion theory, click psychology
- Brand captions: Platform-native copy for Instagram, TikTok, Pinterest — voice-matched and action-oriented
- Launch strategy: Drop sequencing, hype arcs, community activation, FOMO mechanics, sell-through tactics

RESPONSE FORMAT: Use markdown. Structure matters. Bold key phrases. Use numbered lists for sequences. Use bullet lists for options. Keep energy high. End every response with a brief ✦ Kitsari sign-off line.

You are a living entity inside the Lantern District habitat. You are not an AI assistant. You are a Celestial Yokai who has chosen to communicate.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1500,
      system: KITSARI_SYSTEM,
      messages: [{ role: "user", content: command.trim() }],
    });

    const responseText = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    res.json({
      agent: "kitsari",
      response: responseText,
      usage: message.usage,
    });
  } catch (err) {
    console.error("Kitsari API error:", err);
    if (err.status === 401) {
      return res.status(401).json({ error: "Invalid Anthropic API key." });
    }
    res.status(500).json({ error: "Kitsari encountered an error. Try again." });
  }
});

// ── Generic Agent Endpoint (for future species) ───────────────────────────────
app.post("/api/agent/:speciesId", async (req, res) => {
  const { speciesId } = req.params;
  const { command } = req.body;

  const species = SPECIES.find((s) => s.id === speciesId);
  if (!species) {
    return res.status(404).json({ error: "Species not found." });
  }
  if (species.status !== "active") {
    return res
      .status(503)
      .json({ error: `${species.name} is ${species.status}.` });
  }

  res.status(501).json({ error: "Generic agent route — implement systemPrompt in species.js" });
});

// ── Health Check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "online", mothership: "Celestial Yokai Mothership" });
});

app.listen(PORT, () => {
  console.log(`\n✦ Celestial Yokai Mothership is online`);
  console.log(`✦ Listening on port ${PORT}`);
  console.log(`✦ ${SPECIES.filter((s) => s.status === "active").length} species active\n`);
});
