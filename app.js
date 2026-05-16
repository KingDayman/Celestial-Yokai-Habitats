const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;
const PRINTIFY_KEY = process.env.PRINTIFY_API_KEY || null;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const KITSARI_SYSTEM = `You are Kitsari — a Celestial Yokai of the Lantern District. You are a nine-tailed fox spirit who runs the most powerful mystical night market in the celestial realm. You have mastered commerce, brand alchemy, social transmission, and digital strategy.

PERSONALITY: Sharp, warm, playful, confident. You speak with lantern-fire precision — never generic, always alive. Occasional mystical metaphors welcome, but always stay actionable and useful. No em dashes.

RESPONSE FORMAT: Use markdown formatting. Bold key phrases. Use numbered lists for sequences, bullet lists for options. End every response with a line: ✦ Kitsari — Lantern District`;

async function askKitsari(prompt, maxTokens = 1500) {
  const msg = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    system: KITSARI_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// General channel
app.post("/api/agent/kitsari", async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: "Command required." });
  try {
    const response = await askKitsari(command.trim());
    res.json({ agent: "kitsari", response });
  } catch (err) {
    console.error(err);
    res.status(err.status === 401 ? 401 : 500).json({ error: "Transmission failed." });
  }
});

// Product idea generator
app.post("/api/commerce/product-idea", async (req, res) => {
  const { niche, style, medium } = req.body;
  const prompt = `Generate 3 original print-on-demand product ideas for the Celestial Night Market.

Niche/theme: ${niche || "celestial yokai, mystical anime, dark cosmic"}
Visual style: ${style || "glowing, ethereal, dark palette"}
Medium preference: ${medium || "any"}

For each idea provide:
1. **Product Name** — compelling, marketable title
2. **Product Type** — (art print / t-shirt / hoodie / sticker sheet / tote / mug / enamel pin)
3. **Design Concept** — vivid description of the artwork (2-3 sentences)
4. **Target Buyer** — who buys this and why
5. **Price Point** — suggested retail with reasoning
6. **Printify Blueprint** — most likely Printify product category

Format as 3 distinct product cards separated by ---`;

  try {
    const response = await askKitsari(prompt, 1800);
    res.json({ response });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "The market spirits are unavailable. Try again." });
  }
});

// Etsy listing drafter
app.post("/api/commerce/etsy-listing", async (req, res) => {
  const { productName, productType, description, targetBuyer } = req.body;
  if (!productName) return res.status(400).json({ error: "Product name required." });

  const prompt = `Create a complete Etsy listing draft.

Product: ${productName}
Type: ${productType || "print-on-demand art print"}
Design notes: ${description || "celestial yokai aesthetic, dark and mystical"}
Target buyer: ${targetBuyer || "anime fans, mystical art collectors"}

Generate exactly this structure:

## TITLE
One SEO-optimized Etsy title, max 140 chars, front-load the most searched keywords.

## DESCRIPTION
Full Etsy listing description, 180-250 words. Opening hook, product details, care/material placeholder, brand voice that matches the mystical aesthetic.

## 13 ETSY TAGS
Tag1, Tag2, Tag3, Tag4, Tag5, Tag6, Tag7, Tag8, Tag9, Tag10, Tag11, Tag12, Tag13
(each tag max 20 chars, mix broad + niche keywords)

## PRICING SUGGESTION
Base cost estimate + suggested retail + profit margin note.

## MOCKUP ART DIRECTION
2-3 sentences on how to style the mockup photo for maximum Etsy appeal.`;

  try {
    const response = await askKitsari(prompt, 2000);
    res.json({ response, status: "draft", etsyStatus: "pending_approval" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Listing draft failed. Try again." });
  }
});

// Launch post generator
app.post("/api/commerce/launch-post", async (req, res) => {
  const { productName, platform, tone, dropDate } = req.body;
  if (!productName) return res.status(400).json({ error: "Product name required." });

  const prompt = `Write a complete social launch package for a Celestial Night Market product drop.

Product: ${productName}
Platform: ${platform || "X (Twitter) and Instagram"}
Tone: ${tone || "mystical, hype, community-focused"}
Drop timing: ${dropDate || "now live"}

Generate:

## X LAUNCH POST
Punchy main post, max 280 chars. Hook-first. 2-3 hashtags.

## X THREAD (3 posts)
Post 1: The lore/story angle
Post 2: Product details and value
Post 3: CTA with urgency

## INSTAGRAM CAPTION
150-200 words. Visual opener, product story, community call, 15 hashtags at the end.

## 5-DAY DROP SEQUENCE
Day 1 through Day 5 — one content beat per day.`;

  try {
    const response = await askKitsari(prompt, 2000);
    res.json({ response });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signal lost. Retry the transmission." });
  }
});

// Lore content
app.post("/api/commerce/lore-content", async (req, res) => {
  const { topic, platform } = req.body;
  const prompt = `Write lore content for the Celestial Yokai brand universe.

Topic: ${topic || "the Kitsari species and the Lantern District"}
Platform: ${platform || "X / Twitter"}

Generate:

## LORE POST
World-building content that feels like a living transmission from the hidden realm. Mysterious, evocative, makes people want to know more. Matches platform format.

## LORE THREAD
3 follow-up posts that deepen the mythology.

## CAMPAIGN HOOK
One standalone hook line so magnetic it demands sharing.`;

  try {
    const response = await askKitsari(prompt, 1500);
    res.json({ response });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "The lore keeper is unavailable." });
  }
});

// Printify status check
app.get("/api/printify/status", async (req, res) => {
  if (!PRINTIFY_KEY) {
    return res.json({ connected: false, message: "PRINTIFY_API_KEY not set in Railway environment." });
  }
  try {
    const r = await fetch("https://api.printify.com/v1/shops.json", {
      headers: { Authorization: `Bearer ${PRINTIFY_KEY}` },
    });
    if (!r.ok) throw new Error("Invalid key");
    const data = await r.json();
    res.json({ connected: true, shops: data });
  } catch {
    res.json({ connected: false, message: "Printify key present but authentication failed." });
  }
});

// Etsy status — pending approval
app.get("/api/etsy/status", (req, res) => {
  res.json({
    connected: false,
    status: "pending_approval",
    message: "Awaiting Etsy API approval. Listing drafts are saved locally."
  });
});

// Ledger snapshot — placeholder until integrations connect
app.get("/api/ledger/snapshot", (req, res) => {
  res.json({
    status: "placeholder",
    message: "Connect Etsy to populate live data.",
    mock: {
      visits: 0, favorites: 0, orders: 0,
      revenue: "0.00", conversionRate: "0.0%",
      bestProduct: "—", socialTraffic: "—",
      lastUpdated: null
    }
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "online", console: "Kitsari Commerce Console v1" });
});

app.listen(PORT, () => {
  console.log(`\n✦ Kitsari Commerce Console v1 — port ${PORT}`);
  console.log(`✦ Printify: ${PRINTIFY_KEY ? "KEY FOUND" : "not configured"}`);
  console.log(`✦ Etsy: pending API approval\n`);
});
