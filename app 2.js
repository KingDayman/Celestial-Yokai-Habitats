const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

// ── Credentials (never exposed to frontend) ──────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const PRINTIFY_KEY   = process.env.PRINTIFY_API_KEY   || null;
const ETSY_API_KEY   = process.env.ETSY_API_KEY        || null;
const ETSY_SECRET    = process.env.ETSY_SHARED_SECRET  || null;
const ETSY_REDIRECT  = process.env.ETSY_REDIRECT_URI   || null;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── In-memory token store (persists per process; upgrade to DB when needed) ───
const etsyStore = {
  accessToken:  null,
  refreshToken: null,
  shopId:       null,
  shopName:     null,
  connectedAt:  null,
  state:        null,   // PKCE state param
  codeVerifier: null,   // PKCE verifier
};

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function generateCodeVerifier() { return base64url(crypto.randomBytes(32)); }
function generateCodeChallenge(v) {
  return base64url(crypto.createHash("sha256").update(v).digest());
}

// ── Kitsari Claude helper ─────────────────────────────────────────────────────
const KITSARI_SYSTEM = `You are Kitsari — operator of the Lantern District Market, the most powerful celestial night market in existence. You are a nine-tailed fox spirit who has mastered Etsy commerce, Printify print-on-demand, NFT utility design, social media strategy, and brand alchemy.

PERSONALITY: Sharp, warm, precise, playful. You speak with lantern-fire confidence. Never generic. No em dashes. Keep responses actionable.

COMPLIANCE: Never copy existing sellers, copyrighted designs, or trademarks. All products must be original Celestial Yokai-themed work connected to the NFT ecosystem.

NFT UTILITY: When relevant, weave in NFT holder benefits: holder-only discounts, trait-based merch, early access drops, secret shop pages, collectible lore artifacts, physical world extensions.

FORMAT: Use markdown. Bold key phrases. Numbered lists for sequences, bullet lists for options. End every response with: ✦ Kitsari — Lantern District`;

async function askKitsari(prompt, maxTokens = 1600) {
  const msg = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    system: KITSARI_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// ── Etsy API helper ───────────────────────────────────────────────────────────
async function etsyFetch(endpoint, opts = {}) {
  if (!etsyStore.accessToken) throw new Error("Etsy not connected");
  const base = "https://openapi.etsy.com/v3";
  const r = await fetch(`${base}${endpoint}`, {
    ...opts,
    headers: {
      "x-api-key": ETSY_API_KEY,
      Authorization: `Bearer ${etsyStore.accessToken}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Etsy API ${r.status}: ${txt}`);
  }
  return r.json();
}

// ── Printify API helper ───────────────────────────────────────────────────────
async function printifyFetch(endpoint, opts = {}) {
  if (!PRINTIFY_KEY) throw new Error("Printify not configured");
  const r = await fetch(`https://api.printify.com/v1${endpoint}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${PRINTIFY_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Printify API ${r.status}: ${txt}`);
  }
  return r.json();
}

// ════════════════════════════════════════════════════════════════════════════
// ETSY OAUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════

// Debug — never exposes secrets, safe to visit
app.get("/api/etsy/debug", (req, res) => {
  res.json({
    hasApiKey:      !!ETSY_API_KEY,
    hasSecret:      !!ETSY_SECRET,
    redirectUri:    ETSY_REDIRECT || "NOT SET",
    stateStored:    !!etsyStore.state,
    verifierStored: !!etsyStore.codeVerifier,
    connected:      !!etsyStore.accessToken,
    shopName:       etsyStore.shopName || null,
    note: "ETSY_REDIRECT_URI must exactly match the URI registered in your Etsy developer app."
  });
});

// Step 1 — redirect user to Etsy for authorization
app.get("/api/etsy/connect", (req, res) => {
  if (!ETSY_API_KEY) {
    return res.status(500).send('<h2>Missing ETSY_API_KEY</h2><p>Add it to Railway environment variables.</p>');
  }
  if (!ETSY_REDIRECT) {
    return res.status(500).send('<h2>Missing ETSY_REDIRECT_URI</h2><p>Set it to: https://YOUR-APP.railway.app/api/etsy/callback</p>');
  }

  const state        = base64url(crypto.randomBytes(16));
  const codeVerifier = generateCodeVerifier();
  const challenge    = generateCodeChallenge(codeVerifier);
  etsyStore.state        = state;
  etsyStore.codeVerifier = codeVerifier;

  // Use URLSearchParams so Node handles encoding correctly
  const params = new URLSearchParams({
    response_type:         "code",
    redirect_uri:          ETSY_REDIRECT,
    scope:                 "listings_r listings_w shops_r transactions_r",
    client_id:             ETSY_API_KEY,
    state:                 state,
    code_challenge:        challenge,
    code_challenge_method: "S256",
  });

  const url = `https://www.etsy.com/oauth/connect?${params.toString()}`;
  console.log(`[Etsy OAuth] Redirecting → redirect_uri=${ETSY_REDIRECT}`);
  res.redirect(url);
});

// Step 2 — Etsy redirects back here with ?code=...&state=...
app.get("/api/etsy/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Etsy sent back an error (user denied, misconfigured app, etc.)
  if (error) {
    console.error('[Etsy OAuth] Error from Etsy:', error, error_description);
    return res.status(400).send(
      `<h2>Etsy Authorization Failed</h2>
       <p><strong>${error}</strong>: ${error_description || 'Unknown error'}</p>
       <p><a href=/api/etsy/connect>Try connecting again</a></p>`
    );
  }

  // No code — almost always a redirect_uri mismatch
  if (!code) {
    console.error('[Etsy OAuth] Callback reached without code. Query params:', JSON.stringify(req.query));
    return res.status(400).send(
      `<h2>Missing Authorization Code</h2>
       <p>The callback was reached without a <code>code</code> from Etsy.</p>
       <p><strong>Most likely cause:</strong> the Redirect URI registered in your
       <a href=https://www.etsy.com/developers/your-apps target=_blank>Etsy developer app</a>
       does not exactly match <code>ETSY_REDIRECT_URI</code> in Railway.</p>
       <p>Railway ETSY_REDIRECT_URI is currently set to:<br>
       <code>${ETSY_REDIRECT}</code></p>
       <p>Make sure that exact URL (including https, no trailing slash) is in your Etsy app's
       allowed redirect URIs.</p>
       <p><a href=/api/etsy/connect>Start connection again</a> &nbsp;|&nbsp;
       <a href=/api/etsy/debug>View debug info</a></p>`
    );
  }

  // State mismatch — server likely restarted between connect and callback
  if (!state || state !== etsyStore.state) {
    console.error('[Etsy OAuth] State mismatch. Received:', state, '| Stored:', etsyStore.state);
    return res.status(400).send(
      `<h2>OAuth State Mismatch</h2>
       <p>The state token did not match. The server may have restarted during the OAuth flow.</p>
       <p><a href=/api/etsy/connect>Start connection again</a></p>`
    );
  }

  try {
    const tokenRes = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        client_id:     ETSY_API_KEY,
        redirect_uri:  ETSY_REDIRECT,
        code,
        code_verifier: etsyStore.codeVerifier,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("Etsy token exchange failed:", err);
      return res.status(500).send("Token exchange failed. Check Railway logs.");
    }

    const tokens = await tokenRes.json();
    etsyStore.accessToken  = tokens.access_token;
    etsyStore.refreshToken = tokens.refresh_token;
    etsyStore.connectedAt  = new Date().toISOString();
    etsyStore.state        = null;
    etsyStore.codeVerifier = null;

    // Fetch shop info immediately
    try {
      const me = await etsyFetch("/application/openapi-ping");
      const shopData = await etsyFetch("/application/shops?limit=1");
      if (shopData?.results?.[0]) {
        etsyStore.shopId   = shopData.results[0].shop_id;
        etsyStore.shopName = shopData.results[0].shop_name;
      }
    } catch (e) {
      console.warn("Could not fetch shop info after auth:", e.message);
    }

    // Redirect back to the app with success flag
    res.redirect("/?etsy=connected");
  } catch (err) {
    console.error("Etsy OAuth callback error:", err);
    res.status(500).send("OAuth flow failed. See logs.");
  }
});

// Etsy status
app.get("/api/etsy/status", (req, res) => {
  if (!ETSY_API_KEY) {
    return res.json({ connected: false, status: "unconfigured", message: "Etsy credentials not set in Railway." });
  }
  if (!etsyStore.accessToken) {
    return res.json({ connected: false, status: "disconnected", message: "Etsy not connected yet." });
  }
  res.json({
    connected:   true,
    status:      "connected",
    shopId:      etsyStore.shopId,
    shopName:    etsyStore.shopName,
    connectedAt: etsyStore.connectedAt,
  });
});

// Etsy shop info
app.get("/api/etsy/shop", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });
  try {
    if (!etsyStore.shopId) {
      const data = await etsyFetch("/application/shops?limit=1");
      if (data?.results?.[0]) {
        etsyStore.shopId   = data.results[0].shop_id;
        etsyStore.shopName = data.results[0].shop_name;
      }
    }
    const shop = await etsyFetch(`/application/shops/${etsyStore.shopId}`);
    res.json(shop);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Etsy listings
app.get("/api/etsy/listings", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });
  try {
    const state  = req.query.state || "active";
    const limit  = Math.min(parseInt(req.query.limit) || 25, 100);
    const data   = await etsyFetch(
      `/application/shops/${etsyStore.shopId}/listings?state=${state}&limit=${limit}&includes=Images,MainImage`
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create draft Etsy listing (does NOT publish)
app.post("/api/etsy/create-draft", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });
  const { title, description, tags, price, quantity, type } = req.body;
  if (!title || !description) return res.status(400).json({ error: "Title and description required." });

  // Publishing guard — always locked
  const PUBLISH_LOCKED_MSG = "Autonomous publishing is locked until draft quality, Etsy compliance, and Printify sync are verified.";

  try {
    const payload = {
      quantity:           quantity || 999,
      title:              title.slice(0, 140),
      description,
      price:              parseFloat(price) || 18.00,
      who_made:           "i_did",
      when_made:          "made_to_order",
      taxonomy_id:        2078,                        // Art & Collectibles > Digital
      type:               type || "download",
      shipping_profile_id: null,
      is_supply:          false,
      tags:               (tags || []).slice(0, 13),
      state:              "draft",                     // ALWAYS draft
    };

    const listing = await etsyFetch(`/application/shops/${etsyStore.shopId}/listings`, {
      method:  "POST",
      body:    JSON.stringify(payload),
    });

    res.json({
      success:       true,
      listingId:     listing.listing_id,
      url:           listing.url,
      state:         "draft",
      publishLocked: PUBLISH_LOCKED_MSG,
    });
  } catch (err) {
    console.error("Draft listing error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PRINTIFY ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/printify/status", async (req, res) => {
  if (!PRINTIFY_KEY) return res.json({ connected: false, message: "PRINTIFY_API_KEY not set." });
  try {
    const shops = await printifyFetch("/shops.json");
    res.json({ connected: true, shopCount: shops.length, shops: shops.map(s => ({ id: s.id, title: s.title })) });
  } catch (err) {
    res.json({ connected: false, message: err.message });
  }
});

app.get("/api/printify/shops", async (req, res) => {
  try {
    const data = await printifyFetch("/shops.json");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/printify/products", async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    const data = await printifyFetch(`/shops/${shopId}/products.json?limit=20&page=1`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// KITSARI AI ROUTES
// ════════════════════════════════════════════════════════════════════════════

// General channel
app.post("/api/agent/kitsari", async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: "Command required." });
  try {
    const response = await askKitsari(command.trim());
    res.json({ agent: "kitsari", response });
  } catch (err) {
    res.status(err.status === 401 ? 401 : 500).json({ error: "Transmission failed." });
  }
});

// Product idea
app.post("/api/commerce/product-idea", async (req, res) => {
  const { niche, style, medium } = req.body;
  const prompt = `Generate 3 original Celestial Yokai print-on-demand product ideas.

Theme: ${niche || "celestial yokai, mystical anime, dark cosmic"}
Visual style: ${style || "glowing, ethereal, dark palette with gold accents"}
Product type preference: ${medium || "open"}

For EACH of the 3 ideas provide:
1. **Product Name** — evocative, marketable
2. **Product Type** — specific Printify-compatible category
3. **Design Concept** — vivid 2-3 sentence visual description. Must be original.
4. **Target Buyer** — who buys it and why
5. **Retail Price** — with margin reasoning
6. **Printify Blueprint Match** — most relevant Printify category
7. **NFT Holder Utility** — how NFT holders get special access or trait-based variants

Separate ideas with ---
All designs must be original Celestial Yokai IP. No copying existing sellers.`;

  try {
    res.json({ response: await askKitsari(prompt, 1800) });
  } catch (err) {
    res.status(500).json({ error: "Market spirits unavailable." });
  }
});

// Full draft listing workflow (AI generation — does NOT push to Etsy yet)
app.post("/api/commerce/draft-listing", async (req, res) => {
  const { concept, productType, targetBuyer, nftAngle } = req.body;
  if (!concept) return res.status(400).json({ error: "Concept required." });

  const prompt = `Create a complete Etsy listing draft for the Lantern District Market.

CONCEPT: ${concept}
PRODUCT TYPE: ${productType || "art print"}
TARGET BUYER: ${targetBuyer || "anime fans, mystical art collectors, NFT collectors"}
NFT ANGLE: ${nftAngle || "include holder-only utility where relevant"}

Generate EXACTLY this structure:

## PRODUCT NAME
A compelling product title (not the Etsy SEO title — the brand name for this piece)

## LORE ANGLE
2-3 sentences of in-universe lore that makes this product feel like a collectible artifact, not just merch.

## TARGET BUYER
Who buys this. Be specific about their interests and buying motivation.

## ETSY SEO TITLE
Max 140 characters. Front-load highest-searched keywords. End with brand identifiers.

## DESCRIPTION
180-250 words. Opening hook, lore connection, product details, material/size placeholder, care note. Brand voice: mystical but clear.

## 13 ETSY TAGS
tag one, tag two, tag three, tag four, tag five, tag six, tag seven, tag eight, tag nine, tag ten, tag eleven, tag twelve, tag thirteen
(Each tag max 20 chars. Mix broad + niche. No repeats.)

## PRICING SUGGESTION
Recommended retail price with reasoning. Include NFT holder discount suggestion.

## PRINTIFY PRODUCT MATCH
Best Printify blueprint category for this product.

## MOCKUP ART DIRECTION
2-3 sentences on staging the mockup photo for maximum Etsy conversion.

## X LAUNCH POST
One post, max 280 chars, hook-first, 2-3 hashtags.

## NFT HOLDER UTILITY
Specific holder benefit for this product: trait variant, discount tier, early access, or secret page.`;

  try {
    const aiDraft = await askKitsari(prompt, 2200);
    res.json({ response: aiDraft, status: "ai_draft", publishLocked: true });
  } catch (err) {
    res.status(500).json({ error: "Draft generation failed." });
  }
});

// Launch post
app.post("/api/commerce/launch-post", async (req, res) => {
  const { productName, platform, tone, dropDate } = req.body;
  if (!productName) return res.status(400).json({ error: "Product name required." });

  const prompt = `Write a complete launch social package for a Celestial Night Market drop.

Product: ${productName}
Platform: ${platform || "X (Twitter) and Instagram"}
Tone: ${tone || "mystical, hype, community-first"}
Timing: ${dropDate || "now live"}

## X LAUNCH POST
Max 280 chars, hook-first, 2-3 hashtags.

## X THREAD (3 posts)
Post 1 — lore/story angle
Post 2 — product details and value
Post 3 — CTA with urgency

## INSTAGRAM CAPTION
150-200 words. Visual opener, product story, community callout, 15 hashtags at end.

## 5-DAY DROP SEQUENCE
Day 1 through 5 — one content beat each.

## NFT HOLDER EXCLUSIVE POST
Separate post specifically for NFT holders. Reference holder benefits.`;

  try {
    res.json({ response: await askKitsari(prompt, 2000) });
  } catch (err) {
    res.status(500).json({ error: "Signal lost. Retry." });
  }
});

// Lore content
app.post("/api/commerce/lore-content", async (req, res) => {
  const { topic, platform } = req.body;
  const prompt = `Write lore content for the Celestial Yokai universe.

Topic: ${topic || "Kitsari and the Lantern District Market"}
Platform: ${platform || "X / Twitter"}

## LORE POST
A living transmission from the hidden realm. Mysterious, evocative, builds universe depth.

## LORE THREAD
3 follow-up posts deepening the mythology.

## ENGAGEMENT HOOK
One line so magnetic it demands sharing or a reply.

## CAMPAIGN ANGLE
How this lore post connects to a product or drop.`;

  try {
    res.json({ response: await askKitsari(prompt, 1500) });
  } catch (err) {
    res.status(500).json({ error: "Lore keeper unavailable." });
  }
});

// Market Signal Scan
app.post("/api/commerce/market-scan", async (req, res) => {
  const { category, priceRange } = req.body;
  const prompt = `Analyze market signals for the Celestial Night Market.

Category: ${category || "mystical anime art prints, celestial yokai merch"}
Price range: ${priceRange || "$10-$50"}

Generate:

## MARKET SIGNAL REPORT
What is selling in this space right now. Trends, buyer psychology, seasonal patterns.

## CONTENT GAP
What is MISSING that Celestial Yokai could own. Original angles only.

## TOP 3 PRODUCT OPPORTUNITIES
Each with: product type, why it sells, price point, first-mover advantage.

## ETSY SEO KEYWORDS
15 high-opportunity keywords for this category (not from any specific seller).

## NFT CROSSOVER ANGLE
How to connect these products to NFT holder utility for maximum differentiation.

IMPORTANT: Analyze trends and buyer behavior only. Do not copy any specific seller's listings, designs, or content.`;

  try {
    res.json({ response: await askKitsari(prompt, 1800) });
  } catch (err) {
    res.status(500).json({ error: "Market scan failed." });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// LEDGER SNAPSHOT — real Etsy data if connected
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/ledger/snapshot", async (req, res) => {
  if (!etsyStore.accessToken || !etsyStore.shopId) {
    return res.json({
      connected: false,
      message:   "Connect Etsy to populate the Lunar Ledger.",
      mock:      { visits: 0, favorites: 0, orders: 0, revenue: "0.00", conversionRate: "0.0%", draftCount: 0 }
    });
  }
  try {
    const [shop, listings] = await Promise.allSettled([
      etsyFetch(`/application/shops/${etsyStore.shopId}`),
      etsyFetch(`/application/shops/${etsyStore.shopId}/listings?state=draft&limit=100`),
    ]);

    const shopData     = shop.status      === "fulfilled" ? shop.value      : null;
    const draftData    = listings.status  === "fulfilled" ? listings.value  : null;

    res.json({
      connected:    true,
      shopName:     etsyStore.shopName,
      shopId:       etsyStore.shopId,
      connectedAt:  etsyStore.connectedAt,
      visits:       shopData?.num_favorers ?? "—",
      favorites:    shopData?.num_favorers ?? "—",
      orders:       shopData?.transaction_sold_count ?? "—",
      revenue:      shopData?.currency_code ? `${shopData.currency_code}` : "—",
      draftCount:   draftData?.count ?? 0,
      listingCount: shopData?.listing_active_count ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:    "online",
    console:   "Kitsari Commerce Console v2",
    etsy:      etsyStore.accessToken ? "connected" : "disconnected",
    printify:  PRINTIFY_KEY ? "configured" : "unconfigured",
  });
});

app.listen(PORT, () => {
  console.log(`\n✦ Kitsari Commerce Console v2 — port ${PORT}`);
  console.log(`✦ Etsy:     ${ETSY_API_KEY ? "credentials set" : "NOT CONFIGURED"}`);
  console.log(`✦ Printify: ${PRINTIFY_KEY ? "KEY SET" : "not configured"}`);
  console.log(`✦ Redirect: ${ETSY_REDIRECT || "not set"}\n`);
});
