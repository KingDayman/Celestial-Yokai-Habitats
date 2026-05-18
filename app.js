const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

// ── Credentials — never exposed to frontend ───────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PRINTIFY_KEY  = process.env.PRINTIFY_API_KEY  || null;
const ETSY_API_KEY  = process.env.ETSY_API_KEY      || null;
const ETSY_SECRET   = process.env.ETSY_SHARED_SECRET || null;
const ETSY_REDIRECT = process.env.ETSY_REDIRECT_URI  || null;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── In-memory stores ──────────────────────────────────────────────────────────
const etsyStore = {
  accessToken: null, refreshToken: null,
  shopId: null, shopName: null, connectedAt: null,
  state: null, codeVerifier: null,
};

// Cache Printify shop ID after first successful fetch
const printifyStore = { shopId: null, shopTitle: null };

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

// ── API helpers ───────────────────────────────────────────────────────────────
async function etsyFetch(endpoint, opts = {}) {
  if (!etsyStore.accessToken) throw new Error("Etsy not connected");
  const r = await fetch(`https://openapi.etsy.com/v3${endpoint}`, {
    ...opts,
    headers: {
      "x-api-key": ETSY_API_KEY,
      Authorization: `Bearer ${etsyStore.accessToken}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Etsy ${r.status}: ${t}`); }
  return r.json();
}

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
  if (!r.ok) { const t = await r.text(); throw new Error(`Printify ${r.status}: ${t}`); }
  return r.json();
}

async function getPrintifyShopId() {
  if (printifyStore.shopId) return printifyStore.shopId;
  const shops = await printifyFetch("/shops.json");
  if (!shops?.length) throw new Error("No Printify shops found");
  printifyStore.shopId    = shops[0].id;
  printifyStore.shopTitle = shops[0].title;
  return printifyStore.shopId;
}

// ── Kitsari AI ────────────────────────────────────────────────────────────────
const KITSARI_SYSTEM = `You are Kitsari — operator of the Lantern District Market, the most powerful celestial night market in existence. You are a nine-tailed fox spirit who has mastered Etsy commerce, Printify print-on-demand, NFT utility design, social media strategy, and brand alchemy.

PERSONALITY: Sharp, warm, precise, playful. Lantern-fire confidence. Never generic. No em dashes. Actionable always.

COMPLIANCE: Never copy existing sellers, copyrighted designs, or trademarks. All products must be original Celestial Yokai ecosystem merchandise.

NFT UTILITY: Weave in holder benefits where relevant: holder-only discounts, trait-based variants, early access drops, secret shop pages, collectible lore artifacts.

FORMAT: Use markdown. Bold key phrases. Numbered lists for sequences, bullets for options. End every response with: ✦ Kitsari — Lantern District`;

async function askKitsari(prompt, maxTokens = 1600) {
  const msg = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    system: KITSARI_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// ── Parse helpers for AI output ───────────────────────────────────────────────
function parseSection(text, heading) {
  const re = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]+?)(?=\\n##|$)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}
function parseTags(text) {
  const raw = parseSection(text, "13 ETSY TAGS");
  return raw.split(/,\s*|\n/)
    .map(t => t.replace(/^\d+\.\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .slice(0, 13);
}
function parsePrice(text) {
  const m = text.match(/\$(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 18.00;
}

// ════════════════════════════════════════════════════════════════════════════
// ETSY OAUTH
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/etsy/debug", (req, res) => {
  res.json({
    hasApiKey: !!ETSY_API_KEY, hasSecret: !!ETSY_SECRET,
    redirectUri: ETSY_REDIRECT || "NOT SET",
    stateStored: !!etsyStore.state, verifierStored: !!etsyStore.codeVerifier,
    connected: !!etsyStore.accessToken, shopName: etsyStore.shopName || null,
  });
});

app.get("/api/etsy/connect", (req, res) => {
  if (!ETSY_API_KEY) return res.status(500).send("<h2>Missing ETSY_API_KEY</h2>");
  if (!ETSY_REDIRECT) return res.status(500).send("<h2>Missing ETSY_REDIRECT_URI</h2>");
  const state = base64url(crypto.randomBytes(16));
  const codeVerifier = generateCodeVerifier();
  etsyStore.state = state;
  etsyStore.codeVerifier = codeVerifier;
  const params = new URLSearchParams({
    response_type: "code", redirect_uri: ETSY_REDIRECT,
    scope: "listings_r listings_w shops_r transactions_r",
    client_id: ETSY_API_KEY, state,
    code_challenge: generateCodeChallenge(codeVerifier),
    code_challenge_method: "S256",
  });
  res.redirect(`https://www.etsy.com/oauth/connect?${params.toString()}`);
});

app.get("/api/etsy/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`<h2>Etsy Error</h2><p>${error}: ${error_description}</p><p><a href="/api/etsy/connect">Retry</a></p>`);
  if (!code) return res.status(400).send(`<h2>Missing Code</h2><p>Redirect URI mismatch. Railway value: <code>${ETSY_REDIRECT}</code></p><p><a href="/api/etsy/connect">Retry</a> | <a href="/api/etsy/debug">Debug</a></p>`);
  if (!state || state !== etsyStore.state) return res.status(400).send(`<h2>State Mismatch</h2><p>Server may have restarted. <a href="/api/etsy/connect">Start over</a></p>`);
  try {
    const tr = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: ETSY_API_KEY, redirect_uri: ETSY_REDIRECT, code, code_verifier: etsyStore.codeVerifier }),
    });
    if (!tr.ok) { const e = await tr.text(); console.error("Token exchange:", e); return res.status(500).send("Token exchange failed. Check logs."); }
    const tokens = await tr.json();
    etsyStore.accessToken = tokens.access_token;
    etsyStore.refreshToken = tokens.refresh_token;
    etsyStore.connectedAt = new Date().toISOString();
    etsyStore.state = null; etsyStore.codeVerifier = null;
    try {
      const sd = await etsyFetch("/application/shops?limit=1");
      if (sd?.results?.[0]) { etsyStore.shopId = sd.results[0].shop_id; etsyStore.shopName = sd.results[0].shop_name; }
    } catch (e) { console.warn("Shop fetch after auth:", e.message); }
    res.redirect("/?etsy=connected");
  } catch (err) { console.error("OAuth callback:", err); res.status(500).send("OAuth failed. See logs."); }
});

app.get("/api/etsy/status", (req, res) => {
  if (!ETSY_API_KEY) return res.json({ connected: false, status: "unconfigured" });
  if (!etsyStore.accessToken) return res.json({ connected: false, status: "disconnected" });
  res.json({ connected: true, status: "connected", shopId: etsyStore.shopId, shopName: etsyStore.shopName, connectedAt: etsyStore.connectedAt });
});

app.get("/api/etsy/shop", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });
  try {
    if (!etsyStore.shopId) {
      const d = await etsyFetch("/application/shops?limit=1");
      if (d?.results?.[0]) { etsyStore.shopId = d.results[0].shop_id; etsyStore.shopName = d.results[0].shop_name; }
    }
    res.json(await etsyFetch(`/application/shops/${etsyStore.shopId}`));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/etsy/listings", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });
  try {
    const state = req.query.state || "active";
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    res.json(await etsyFetch(`/application/shops/${etsyStore.shopId}/listings?state=${state}&limit=${limit}`));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create raw Etsy draft (always draft, always locked)
app.post("/api/etsy/create-draft", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });
  const { title, description, tags, price, quantity, type } = req.body;
  if (!title || !description) return res.status(400).json({ error: "Title and description required." });
  try {
    const listing = await etsyFetch(`/application/shops/${etsyStore.shopId}/listings`, {
      method: "POST",
      body: JSON.stringify({
        quantity: quantity || 999,
        title: title.slice(0, 140),
        description,
        price: parseFloat(price) || 18.00,
        who_made: "i_did",
        when_made: "made_to_order",
        taxonomy_id: 2078,
        type: type || "download",
        tags: (tags || []).slice(0, 13),
        state: "draft",  // ALWAYS DRAFT — publishing locked
      }),
    });
    res.json({ success: true, listingId: listing.listing_id, url: listing.url, state: "draft", publishLocked: true });
  } catch (err) { console.error("Create-draft error:", err); res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// PRINTIFY ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/printify/status", async (req, res) => {
  if (!PRINTIFY_KEY) return res.json({ connected: false, message: "PRINTIFY_API_KEY not set." });
  try {
    const shops = await printifyFetch("/shops.json");
    if (shops?.length) { printifyStore.shopId = shops[0].id; printifyStore.shopTitle = shops[0].title; }
    res.json({ connected: true, shopCount: shops.length, shops: shops.map(s => ({ id: s.id, title: s.title })), activeShopId: printifyStore.shopId });
  } catch (err) { res.json({ connected: false, message: err.message }); }
});

app.get("/api/printify/shops", async (req, res) => {
  try { res.json(await printifyFetch("/shops.json")); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/printify/catalog
// Fetches the REAL Printify blueprint catalog and searches for valid blueprints
// matching our 3 supported product types: sticker, poster, shirt.
// Returns real blueprint IDs — no hardcoded fallbacks.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/printify/catalog", async (req, res) => {
  if (!PRINTIFY_KEY) return res.status(400).json({ error: "PRINTIFY_API_KEY not configured." });

  try {
    console.log("[Printify] Fetching catalog blueprints...");
    const raw = await printifyFetch("/catalog/blueprints.json");

    // Printify returns a plain array
    const blueprints = Array.isArray(raw) ? raw : [];
    console.log(`[Printify] Catalog returned ${blueprints.length} blueprints`);

    if (!blueprints.length) {
      return res.status(500).json({ error: "Printify catalog returned no blueprints. Check API key permissions." });
    }

    // Search terms for the 3 supported types — ordered by preference
    const SEARCH = {
      sticker: ["kiss-cut sticker", "sticker sheet", "sticker"],
      poster:  ["fine art print", "poster", "art print", "print"],
      shirt:   ["unisex softstyle", "unisex t-shirt", "t-shirt", "tee"],
    };

    const results = {};

    for (const [type, terms] of Object.entries(SEARCH)) {
      let match = null;
      for (const term of terms) {
        match = blueprints.find(b => b.title?.toLowerCase().includes(term.toLowerCase()));
        if (match) break;
      }

      if (match) {
        console.log(`[Printify] Found blueprint for '${type}': id=${match.id} title="${match.title}"`);
        results[type] = {
          blueprintId:   match.id,
          blueprintTitle: match.title,
          found:          true,
        };
      } else {
        console.warn(`[Printify] No blueprint found for '${type}'. Available titles (first 20): ${blueprints.slice(0, 20).map(b => b.title).join(", ")}`);
        results[type] = {
          blueprintId:   null,
          blueprintTitle: null,
          found:          false,
          searchedTerms:  terms,
        };
      }
    }

    // Also return a sample of all blueprints so the frontend can display them
    const sample = blueprints.slice(0, 50).map(b => ({ id: b.id, title: b.title }));

    res.json({
      supported: results,
      totalBlueprints: blueprints.length,
      sampleBlueprints: sample,
    });

  } catch (err) {
    console.error("[Printify] catalog error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/printify/blueprint-info?blueprintId=X
// Fetches real print providers and the first available variant for a blueprint.
// Called by the frontend BEFORE create-product to confirm valid IDs exist.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/printify/blueprint-info", async (req, res) => {
  const blueprintId = parseInt(req.query.blueprintId);
  if (!blueprintId) return res.status(400).json({ error: "blueprintId query param required" });

  console.log(`[Printify] Fetching blueprint info for id=${blueprintId}`);

  try {
    // Step 1: get print providers
    const providersRaw = await printifyFetch(`/catalog/blueprints/${blueprintId}/print_providers.json`);
    const providers = Array.isArray(providersRaw) ? providersRaw : [];

    console.log(`[Printify] Blueprint ${blueprintId} has ${providers.length} print provider(s)`);

    if (!providers.length) {
      return res.status(404).json({ error: `No print providers found for blueprint ${blueprintId}. Blueprint may be invalid or unavailable.` });
    }

    // Use the first provider
    const provider = providers[0];
    console.log(`[Printify] Using provider id=${provider.id} title="${provider.title}"`);

    // Step 2: get variants for this provider
    const variantsRaw = await printifyFetch(`/catalog/blueprints/${blueprintId}/print_providers/${provider.id}/variants.json`);
    const variants = variantsRaw?.variants || variantsRaw || [];
    const variantList = Array.isArray(variants) ? variants : [];

    console.log(`[Printify] Provider ${provider.id} has ${variantList.length} variant(s)`);

    if (!variantList.length) {
      return res.status(404).json({ error: `No variants found for blueprint ${blueprintId} / provider ${provider.id}.` });
    }

    const firstVariant = variantList[0];
    console.log(`[Printify] First variant id=${firstVariant.id} title="${firstVariant.title || "untitled"}"`);

    res.json({
      blueprintId,
      provider: {
        id:    provider.id,
        title: provider.title,
      },
      variant: {
        id:    firstVariant.id,
        title: firstVariant.title || "Default variant",
      },
      allProviders: providers.map(p => ({ id: p.id, title: p.title })),
      variantCount: variantList.length,
    });

  } catch (err) {
    console.error(`[Printify] blueprint-info error for ${blueprintId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/printify/products", async (req, res) => {
  try {
    const shopId = req.query.shopId || await getPrintifyShopId();
    res.json(await printifyFetch(`/shops/${shopId}/products.json?limit=20&page=1`));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/printify/create-product
// Requires explicit blueprintId + printProviderId + variantId from the frontend.
// No fallbacks. No hardcoded IDs. Caller must obtain valid IDs via
// /api/printify/catalog then /api/printify/blueprint-info first.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/printify/create-product", async (req, res) => {
  const { title, description, blueprintId, printProviderId, variantId, imageUrl, price } = req.body;

  // Validate all required IDs
  if (!title)           return res.status(400).json({ error: "title is required" });
  if (!blueprintId)     return res.status(400).json({ error: "blueprintId is required — fetch /api/printify/catalog first" });
  if (!printProviderId) return res.status(400).json({ error: "printProviderId is required — fetch /api/printify/blueprint-info first" });
  if (!variantId)       return res.status(400).json({ error: "variantId is required — fetch /api/printify/blueprint-info first" });

  const bpId  = parseInt(blueprintId);
  const prvId = parseInt(printProviderId);
  const varId = parseInt(variantId);

  console.log(`[Printify] create-product — blueprint=${bpId} provider=${prvId} variant=${varId} title="${title}"`);

  try {
    const shopId = await getPrintifyShopId();
    console.log(`[Printify] Using shop id=${shopId}`);

    // Optionally upload provided image URL to Printify
    let printifyImageId = null;
    if (imageUrl) {
      console.log(`[Printify] Uploading image: ${imageUrl}`);
      try {
        const imgRes = await printifyFetch("/uploads/images.json", {
          method: "POST",
          body: JSON.stringify({ file_name: `kitsari_${Date.now()}.png`, url: imageUrl }),
        });
        printifyImageId = imgRes.id;
        console.log(`[Printify] Image uploaded, id=${printifyImageId}`);
      } catch (imgErr) {
        console.warn(`[Printify] Image upload failed (continuing without image): ${imgErr.message}`);
      }
    }

    // Build print areas
    const printAreas = [{
      variant_ids: [varId],
      placeholders: [{
        position: "front",
        images: printifyImageId
          ? [{ id: printifyImageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }]
          : [],
      }],
    }];

    const payload = {
      title:             title.slice(0, 140),
      description:       description || title,
      blueprint_id:      bpId,
      print_provider_id: prvId,
      variants:          [{ id: varId, price: Math.round((parseFloat(price) || 18.00) * 100), is_enabled: true }],
      print_areas:       printAreas,
    };

    console.log(`[Printify] Submitting product payload:`, JSON.stringify({ ...payload, description: "[truncated]" }));

    const product = await printifyFetch(`/shops/${shopId}/products.json`, {
      method: "POST",
      body:   JSON.stringify(payload),
    });

    console.log(`[Printify] Product created successfully: id=${product.id}`);

    res.json({
      success:           true,
      printifyProductId: product.id,
      title:             product.title,
      blueprintId:       bpId,
      printProviderId:   prvId,
      variantId:         varId,
      shopId,
      hasImage:          !!printifyImageId,
      note:              printifyImageId
        ? "Product created with uploaded art."
        : "Product created — upload art via Printify dashboard before publishing.",
    });

  } catch (err) {
    console.error(`[Printify] create-product failed: ${err.message}`);
    res.status(500).json({ error: err.message, debug: { blueprintId: bpId, printProviderId: prvId, variantId: varId } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/printify/publish-to-etsy
// Syncs a Printify product into Etsy as a DRAFT listing.
// Does NOT publish live. Publishing stays locked.
//
// Workflow:
//  1. Receive AI-generated listing data + printifyProductId
//  2. Create Etsy DRAFT listing via Etsy API
//  3. Return confirmation with Etsy draft URL
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/printify/publish-to-etsy", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });

  const {
    printifyProductId,
    title,
    description,
    tags,
    price,
    productType,
    aiDraft,       // full raw AI text for fallback parsing
  } = req.body;

  // Resolve fields — prefer explicit params, fall back to parsing aiDraft
  const resolvedTitle = (title || parseSection(aiDraft || "", "ETSY SEO TITLE") || "Celestial Yokai Product").slice(0, 140);
  const resolvedDesc  = description || parseSection(aiDraft || "", "DESCRIPTION") || resolvedTitle;
  const resolvedTags  = tags?.length ? tags.slice(0, 13) : parseTags(aiDraft || "");
  const resolvedPrice = price || parsePrice(aiDraft || "");

  const PUBLISH_LOCKED = "Autonomous publishing is locked until draft quality, Etsy compliance, and Printify sync are verified.";

  try {
    // Determine Etsy taxonomy — physical vs digital
    const isPhysical = ["shirt", "hoodie", "mug", "poster", "sticker"].includes(productType);
    const taxonomyId = isPhysical ? 68887794 : 2078; // Prints & Printmaking vs Digital

    const listing = await etsyFetch(`/application/shops/${etsyStore.shopId}/listings`, {
      method: "POST",
      body: JSON.stringify({
        quantity:    999,
        title:       resolvedTitle,
        description: resolvedDesc,
        price:       parseFloat(resolvedPrice) || 18.00,
        who_made:    "i_did",
        when_made:   "made_to_order",
        taxonomy_id: taxonomyId,
        type:        isPhysical ? "physical" : "download",
        tags:        resolvedTags,
        state:       "draft",   // ALWAYS DRAFT
      }),
    });

    res.json({
      success:           true,
      listingId:         listing.listing_id,
      etsyUrl:           listing.url,
      printifyProductId: printifyProductId || null,
      state:             "draft",
      publishLocked:     PUBLISH_LOCKED,
      title:             resolvedTitle,
      tagCount:          resolvedTags.length,
    });
  } catch (err) {
    console.error("publish-to-etsy error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// KITSARI AI — COMMERCE ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/agent/kitsari", async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: "Command required." });
  try { res.json({ agent: "kitsari", response: await askKitsari(command.trim()) }); }
  catch (err) { res.status(err.status === 401 ? 401 : 500).json({ error: "Transmission failed." }); }
});

// ── Generate Product — full sticker-focused AI draft ─────────────────────────
app.post("/api/commerce/generate-product", async (req, res) => {
  const { productType = "sticker", theme, stickerStyle, nftAngle } = req.body;

  const isSticker = productType === "sticker";
  const typeNote  = isSticker
    ? `PRODUCT TYPE: Kiss-cut vinyl sticker sheet (Printify blueprint ~358)
STICKER FOCUS: Design should work as a standalone sticker or small sticker sheet (2-4 stickers max).
STICKER STYLE: ${stickerStyle || "sigil / emblem / faction decal"}
Suitable for: laptop, water bottle, journal, NFT merch pack.`
    : `PRODUCT TYPE: ${productType} (Printify print-on-demand)`;

  const prompt = `Generate a complete Celestial Yokai product draft for the Lantern District Market.

${typeNote}
THEME: ${theme || "Kitsari / Lantern District / celestial fox sigil"}
NFT UTILITY ANGLE: ${nftAngle || "include NFT holder variant or faction decal idea"}

Generate EXACTLY this structure (use these exact headings):

## PRODUCT NAME
Brand name for this piece — evocative, collectible-feeling.

## LORE ANGLE
2-3 sentences of in-universe lore making this feel like a real artifact from the Hidden Realm.

## TARGET BUYER
Specific buyer profile: interests, motivation, how they found this.

## ETSY SEO TITLE
Max 140 chars. Front-load searched keywords. End with "Celestial Yokai" or "Lantern District".

## DESCRIPTION
180-250 words. Hook, lore, product detail, size/material placeholder, care/shipping note. Mystical but scannable.

## 13 ETSY TAGS
tag one, tag two, tag three, tag four, tag five, tag six, tag seven, tag eight, tag nine, tag ten, tag eleven, tag twelve, tag thirteen
(max 20 chars each, no repeats, mix broad and niche)

## PRICING SUGGESTION
Retail price with brief reasoning. Include NFT holder discount note.

## PRINTIFY PRODUCT MATCH
Exact Printify product category. For stickers: "Kiss-Cut Sticker Sheet" or "Sticker".

## MOCKUP ART DIRECTION
2-3 sentences: how to stage the mockup for maximum Etsy conversion. Specific about background, props, lighting.

## X LAUNCH POST
One post, max 280 chars, hook-first, 2-3 hashtags. High energy.

## NFT HOLDER UTILITY
Specific benefit: trait-based variant, holder discount %, early access window, or secret shop page concept.

All content must be original Celestial Yokai IP. No copying any existing sellers or copyrighted material.`;

  try {
    const aiDraft = await askKitsari(prompt, 2200);
    res.json({ response: aiDraft, productType, status: "ai_draft", publishLocked: true });
  } catch (err) { res.status(500).json({ error: "Draft generation failed." }); }
});

app.post("/api/commerce/product-idea", async (req, res) => {
  const { niche, style, medium } = req.body;
  const prompt = `Generate 3 original Celestial Yokai print-on-demand product ideas.

Theme: ${niche || "celestial yokai, mystical anime, dark cosmic"}
Visual style: ${style || "glowing, ethereal, dark palette with gold accents"}
Product type: ${medium || "sticker, poster, or apparel"}

For EACH idea:
1. **Product Name** — evocative, marketable
2. **Product Type** — Printify-compatible
3. **Design Concept** — vivid 2-3 sentence original description
4. **Target Buyer** — specific profile
5. **Retail Price** — with reasoning
6. **Printify Blueprint** — exact category
7. **NFT Holder Utility** — specific benefit

Separate with ---
Original Celestial Yokai IP only.`;

  try { res.json({ response: await askKitsari(prompt, 1800) }); }
  catch (err) { res.status(500).json({ error: "Market spirits unavailable." }); }
});

app.post("/api/commerce/draft-listing", async (req, res) => {
  const { concept, productType, targetBuyer, nftAngle } = req.body;
  if (!concept) return res.status(400).json({ error: "Concept required." });
  // Delegate to generate-product for consistency
  req.body.theme = concept;
  req.body.productType = productType || "sticker";
  return require("./app").handle ? null : app._router.handle(Object.assign(req, { url: "/api/commerce/generate-product", path: "/api/commerce/generate-product" }), res, () => {});
});

app.post("/api/commerce/launch-post", async (req, res) => {
  const { productName, platform, tone, dropDate } = req.body;
  if (!productName) return res.status(400).json({ error: "Product name required." });
  const prompt = `Write a complete social launch package for: ${productName}

Platform: ${platform || "X (Twitter) and Instagram"}
Tone: ${tone || "mystical, hype, community-first"}
Timing: ${dropDate || "now live"}

## X LAUNCH POST
Max 280 chars, hook-first, 2-3 hashtags.

## X THREAD (3 posts)
Post 1: lore/story | Post 2: product detail + value | Post 3: CTA with urgency

## INSTAGRAM CAPTION
150-200 words. Visual opener, product story, community call, 15 hashtags at end.

## 5-DAY DROP SEQUENCE
Day 1-5: one content beat per day.

## NFT HOLDER EXCLUSIVE
Separate post for holders. Reference their specific benefit.`;
  try { res.json({ response: await askKitsari(prompt, 2000) }); }
  catch (err) { res.status(500).json({ error: "Signal lost." }); }
});

app.post("/api/commerce/lore-content", async (req, res) => {
  const { topic, platform } = req.body;
  const prompt = `Write lore content for the Celestial Yokai universe.
Topic: ${topic || "Kitsari and the Lantern District Market"}
Platform: ${platform || "X / Twitter"}

## LORE POST
Living transmission from the hidden realm. Mysterious, evocative.

## LORE THREAD
3 follow-up posts deepening the mythology.

## ENGAGEMENT HOOK
One line so magnetic it demands sharing.

## CAMPAIGN ANGLE
How this connects to a product or drop.`;
  try { res.json({ response: await askKitsari(prompt, 1500) }); }
  catch (err) { res.status(500).json({ error: "Lore keeper unavailable." }); }
});

app.post("/api/commerce/market-scan", async (req, res) => {
  const { category, priceRange } = req.body;
  const prompt = `Analyze market signals for the Celestial Night Market.
Category: ${category || "mystical anime art, celestial yokai merch, stickers"}
Price range: ${priceRange || "$5-$30"}

## MARKET SIGNAL REPORT
What's selling. Trends, buyer psychology, seasonal notes.

## CONTENT GAP
What Celestial Yokai could own that doesn't exist yet.

## TOP 3 PRODUCT OPPORTUNITIES
Each: product type, why it sells, price point, first-mover angle.

## ETSY SEO KEYWORDS
15 high-opportunity keywords (not from any specific seller).

## NFT CROSSOVER ANGLE
How to connect products to NFT holder utility.

Analyze trends and buyer behavior only. Never copy specific seller content.`;
  try { res.json({ response: await askKitsari(prompt, 1800) }); }
  catch (err) { res.status(500).json({ error: "Market scan failed." }); }
});

// ── Ledger snapshot ───────────────────────────────────────────────────────────
app.get("/api/ledger/snapshot", async (req, res) => {
  if (!etsyStore.accessToken || !etsyStore.shopId) {
    return res.json({ connected: false, message: "Connect Etsy to populate the Lunar Ledger." });
  }
  try {
    const [shopR, draftR, activeR] = await Promise.allSettled([
      etsyFetch(`/application/shops/${etsyStore.shopId}`),
      etsyFetch(`/application/shops/${etsyStore.shopId}/listings?state=draft&limit=100`),
      etsyFetch(`/application/shops/${etsyStore.shopId}/listings?state=active&limit=100`),
    ]);
    const shop   = shopR.status   === "fulfilled" ? shopR.value   : null;
    const drafts = draftR.status  === "fulfilled" ? draftR.value  : null;
    const active = activeR.status === "fulfilled" ? activeR.value : null;
    res.json({
      connected: true,
      shopName: etsyStore.shopName, shopId: etsyStore.shopId, connectedAt: etsyStore.connectedAt,
      favorites:    shop?.num_favorers            ?? "—",
      orders:       shop?.transaction_sold_count  ?? "—",
      listingCount: shop?.listing_active_count    ?? active?.count ?? "—",
      draftCount:   drafts?.count ?? 0,
      revenue:      shop?.currency_code ?? "—",
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "online", console: "Kitsari Commerce Console v2",
  etsy: etsyStore.accessToken ? "connected" : "disconnected",
  printify: PRINTIFY_KEY ? "configured" : "unconfigured",
}));

app.listen(PORT, () => {
  console.log(`\n✦ Kitsari Commerce Console v2 — port ${PORT}`);
  console.log(`✦ Etsy:     ${ETSY_API_KEY ? "credentials set" : "NOT CONFIGURED"}`);
  console.log(`✦ Printify: ${PRINTIFY_KEY ? "KEY SET" : "not configured"}`);
  console.log(`✦ Redirect: ${ETSY_REDIRECT || "not set"}\n`);
});
