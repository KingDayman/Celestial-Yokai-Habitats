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
  const rootIndex = path.join(__dirname, "index.html");
  const publicIndex = path.join(__dirname, "public", "index.html");

  res.sendFile(publicIndex, (err) => {
    if (err) {
      res.sendFile(rootIndex, (err2) => {
        if (err2) {
          res.status(200).send(`
            <h1>Celestial Yokai Mothership</h1>
            <p>Server works, but no index.html was found.</p>
          `);
        }
      });
    }
  });
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

  const kitsari = SPECIES.find((s) => s.id === "kitsari");
  if (!kitsari || kitsari.status !== "active") {
    return res.status(503).json({ error: "Kitsari is not active." });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1500,
      system: kitsari.systemPrompt,
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
