const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

// ── Credentials — never exposed to frontend ──────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PRINTIFY_KEY  = process.env.PRINTIFY_API_KEY   || null;
const ETSY_API_KEY  = process.env.ETSY_API_KEY        || null;
const ETSY_SECRET   = process.env.ETSY_SHARED_SECRET  || null;
const ETSY_REDIRECT = process.env.ETSY_REDIRECT_URI   || null;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── In-memory stores ─────────────────────────────────────────────────────────
const etsyStore = {
  accessToken: null, refreshToken: null,
  shopId: null, shopName: null, connectedAt: null,
  state: null, codeVerifier: null,
};
const printifyStore = {
  shopId: null, shopTitle: null,
  // catalog cache: { sticker: {blueprintId, blueprintTitle}, ... }
  catalog: null,
  catalogFetchedAt: null,
};

const CATALOG_TTL_MS = 30 * 60 * 1000; // 30 min cache

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── PKCE helpers ─────────────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function generateCodeVerifier() { return base64url(crypto.randomBytes(32)); }
function generateCodeChallenge(v) {
  return base64url(crypto.createHash("sha256").update(v).digest());
}

// ── Etsy fetch helper ────────────────────────────────────────────────────────
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
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Etsy ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

// ── Printify fetch helper ────────────────────────────────────────────────────
async function printifyFetch(endpoint, opts = {}) {
  if (!PRINTIFY_KEY) throw new Error("PRINTIFY_API_KEY not set in Railway environment");
  const r = await fetch(`https://api.printify.com/v1${endpoint}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${PRINTIFY_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Printify ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

// ── Printify shop ID (cached) ────────────────────────────────────────────────
async function getPrintifyShopId() {
  if (printifyStore.shopId) return printifyStore.shopId;
  const shops = await printifyFetch("/shops.json");
  if (!Array.isArray(shops) || !shops.length) throw new Error("No Printify shops found");
  printifyStore.shopId    = shops[0].id;
  printifyStore.shopTitle = shops[0].title;
  console.log(`[Printify] Shop resolved: id=${printifyStore.shopId} title="${printifyStore.shopTitle}"`);
  return printifyStore.shopId;
}

// ── Catalog search (cached) ──────────────────────────────────────────────────
// Maps product type names to ordered search terms.
// Uses substring matching against blueprint titles from the live Printify catalog.
const TYPE_SEARCH_TERMS = {
  sticker: [
    "kiss-cut stickers",
    "kiss cut sticker",
    "kiss-cut sticker",
    "sticker sheet",
    "die cut sticker",
    "die-cut sticker",
    "sticker",
  ],
  poster: [
    "enhanced matte paper poster",
    "matte paper poster",
    "enhanced matte poster",
    "poster",
    "fine art print",
    "art print",
    "wall art",
    "print",
  ],
  shirt: [
    "unisex softstyle t-shirt",
    "unisex softstyle tshirt",
    "unisex heavy cotton tee",
    "unisex jersey short sleeve tee",
    "unisex staple t-shirt",
    "unisex t-shirt",
    "t-shirt",
    "tee shirt",
    "tshirt",
    "tee",
    "shirt",
  ],
};

async function resolveBlueprints(forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    printifyStore.catalog &&
    printifyStore.catalogFetchedAt &&
    now - printifyStore.catalogFetchedAt < CATALOG_TTL_MS
  ) {
    console.log("[Printify] Returning cached catalog");
    return printifyStore.catalog;
  }

  console.log("[Printify] Fetching full catalog...");
  const raw = await printifyFetch("/catalog/blueprints.json");
  const blueprints = Array.isArray(raw) ? raw : [];
  console.log(`[Printify] Catalog: ${blueprints.length} blueprints returned`);

  if (!blueprints.length) {
    throw new Error("Printify catalog returned 0 blueprints — check API key permissions");
  }

  // Log ALL titles so we can see what's available for debugging
  console.log("[Printify] ALL blueprint titles (id:title):");
  blueprints.forEach(b => console.log(`  ${b.id}: "${b.title}"`));

  const catalog = {};
  // Store the full list for the manual picker fallback
  catalog._allBlueprints = blueprints.map(b => ({ id: b.id, title: b.title }));

  for (const [type, terms] of Object.entries(TYPE_SEARCH_TERMS)) {
    let match = null;
    for (const term of terms) {
      match = blueprints.find(
        b => b.title?.toLowerCase().includes(term.toLowerCase())
      );
      if (match) {
        console.log(`[Printify] Catalog match — ${type}: searched="${term}" → id=${match.id} title="${match.title}"`);
        break;
      }
    }
    if (match) {
      catalog[type] = { blueprintId: match.id, blueprintTitle: match.title, found: true };
    } else {
      console.warn(`[Printify] No catalog match for "${type}". Terms tried: ${terms.join(", ")}`);
      catalog[type] = { blueprintId: null, blueprintTitle: null, found: false };
    }
  }

  printifyStore.catalog          = catalog;
  printifyStore.catalogFetchedAt = now;
  return catalog;
}

// ── Provider selection logic ─────────────────────────────────────────────────
// Scores providers: prefers US location, high ratings, known good names.
const PREFERRED_PROVIDERS = [
  "monster digital",
  "printify",
  "district photo",
  "sticker mule",
  "printful",
  "gooten",
  "awkward styles",
];

function scoreProvider(provider) {
  let score = 0;
  const title = (provider.title || "").toLowerCase();
  const location = (provider.location?.country || "").toLowerCase();

  // US fulfillment strongly preferred
  if (location === "us" || location === "united states") score += 50;

  // Rating
  const rating = parseFloat(provider.rating || provider.score || 0);
  score += Math.min(rating * 10, 40);

  // Known good provider names
  for (const name of PREFERRED_PROVIDERS) {
    if (title.includes(name)) { score += 20; break; }
  }

  return score;
}

function selectBestProvider(providers) {
  if (!providers.length) throw new Error("No providers available");
  return [...providers].sort((a, b) => scoreProvider(b) - scoreProvider(a))[0];
}

// ── Kitsari AI ───────────────────────────────────────────────────────────────
const KITSARI_SYSTEM = `You are Kitsari — operator of the Lantern District Market, the most powerful celestial night market in existence. You are a nine-tailed fox spirit who has mastered Etsy commerce, Printify print-on-demand, NFT utility design, social media strategy, and brand alchemy.

PERSONALITY: Sharp, warm, precise, playful. Lantern-fire confidence. Never generic. No em dashes. Keep responses actionable.

COMPLIANCE: Never copy existing sellers, copyrighted designs, or trademarks. All products must be original Celestial Yokai ecosystem merchandise.

NFT UTILITY: Weave in holder benefits where relevant: holder-only discounts, trait-based variants, early access drops, secret shop pages, collectible lore artifacts, Lantern District exclusives.

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

// ── Parse helpers ────────────────────────────────────────────────────────────
function parseSection(text, heading) {
  const re = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]+?)(?=\\n##|$)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}
function parseTags(text) {
  const raw = parseSection(text, "13 ETSY TAGS");
  return raw.split(/,\s*|\n/)
    .map(t => t.replace(/^\d+\.\s*/, "").replace(/\*\*/g, "").trim())
    .filter(t => t.length > 0 && t.length <= 20)
    .slice(0, 13);
}
function parsePrice(text) {
  const m = text.match(/\$(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 18.00;
}

// ════════════════════════════════════════════════════════════════════════════
// ETSY OAUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/etsy/debug", (req, res) => {
  res.json({
    hasApiKey: !!ETSY_API_KEY, hasSecret: !!ETSY_SECRET,
    redirectUri: ETSY_REDIRECT || "NOT SET",
    stateStored: !!etsyStore.state, connected: !!etsyStore.accessToken,
    shopName: etsyStore.shopName || null,
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
  if (!code) return res.status(400).send(`<h2>Missing Code</h2><p>Redirect URI mismatch. Value: <code>${ETSY_REDIRECT}</code></p><p><a href="/api/etsy/connect">Retry</a></p>`);
  if (!state || state !== etsyStore.state) return res.status(400).send(`<h2>State Mismatch</h2><p><a href="/api/etsy/connect">Start over</a></p>`);
  try {
    const tr = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: ETSY_API_KEY,
        redirect_uri: ETSY_REDIRECT, code, code_verifier: etsyStore.codeVerifier,
      }),
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

// Always-draft Etsy listing creator
app.post("/api/etsy/create-draft", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });
  const { title, description, tags, price, type } = req.body;
  if (!title || !description) return res.status(400).json({ error: "Title and description required." });
  try {
    const listing = await etsyFetch(`/application/shops/${etsyStore.shopId}/listings`, {
      method: "POST",
      body: JSON.stringify({
        quantity: 999, title: title.slice(0, 140), description,
        price: parseFloat(price) || 18.00,
        who_made: "i_did", when_made: "made_to_order",
        taxonomy_id: 2078, type: type || "download",
        tags: (tags || []).slice(0, 13), state: "draft",
      }),
    });
    res.json({ success: true, listingId: listing.listing_id, url: listing.url, state: "draft" });
  } catch (err) { console.error("create-draft:", err.message); res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// PRINTIFY ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/printify/status", async (req, res) => {
  if (!PRINTIFY_KEY) return res.json({ connected: false, message: "PRINTIFY_API_KEY not set." });
  try {
    const shops = await printifyFetch("/shops.json");
    if (Array.isArray(shops) && shops.length) {
      printifyStore.shopId = shops[0].id;
      printifyStore.shopTitle = shops[0].title;
    }
    res.json({
      connected: true,
      shopCount: shops.length,
      shops: shops.map(s => ({ id: s.id, title: s.title })),
      activeShopId: printifyStore.shopId,
    });
  } catch (err) { res.json({ connected: false, message: err.message }); }
});

app.get("/api/printify/shops", async (req, res) => {
  try { res.json(await printifyFetch("/shops.json")); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/printify/catalog
// Fetches real Printify blueprints, searches for our 3 supported types,
// caches results for 30 minutes. No hardcoded IDs — all dynamic.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/printify/catalog", async (req, res) => {
  if (!PRINTIFY_KEY) return res.status(400).json({ error: "PRINTIFY_API_KEY not configured." });
  const forceRefresh = req.query.refresh === "true";
  try {
    const catalog = await resolveBlueprints(forceRefresh);
    const { _allBlueprints, ...supported } = catalog;
    const foundCount = Object.values(supported).filter(v => v.found).length;
    res.json({
      supported,
      foundCount,
      totalTypes: Object.keys(supported).length,
      totalBlueprints: (_allBlueprints || []).length,
      allBlueprints: _allBlueprints || [],
      cachedAt: printifyStore.catalogFetchedAt,
    });
  } catch (err) {
    console.error("[Printify] catalog route error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/printify/blueprint-info/:blueprintId
// Also accepts ?blueprintId=X for backwards compat.
// Fetches ALL print providers, scores them, returns the best one + first variant.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/printify/blueprint-info/:blueprintId?", async (req, res) => {
  const blueprintId = parseInt(req.params.blueprintId || req.query.blueprintId);
  if (!blueprintId) return res.status(400).json({ error: "blueprintId is required (path or query param)" });

  console.log(`[Printify] blueprint-info for id=${blueprintId}`);

  try {
    // Step 1 — get providers
    const providersRaw = await printifyFetch(`/catalog/blueprints/${blueprintId}/print_providers.json`);
    const providers = Array.isArray(providersRaw) ? providersRaw : [];
    console.log(`[Printify] blueprint=${blueprintId} — ${providers.length} provider(s): ${providers.map(p => `${p.id}:"${p.title}"`).join(", ")}`);

    if (!providers.length) {
      return res.status(404).json({
        error: `No print providers for blueprint ${blueprintId}. The blueprint may be invalid for your account.`,
      });
    }

    // Step 2 — score and pick best provider
    const scoredProviders = providers.map(p => ({
      ...p,
      _score: scoreProvider(p),
    })).sort((a, b) => b._score - a._score);

    const best = scoredProviders[0];
    console.log(`[Printify] Best provider: id=${best.id} title="${best.title}" score=${best._score} location=${best.location?.country || "unknown"}`);

    // Step 3 — get variants for best provider
    const variantsRaw = await printifyFetch(`/catalog/blueprints/${blueprintId}/print_providers/${best.id}/variants.json`);

    // Printify variant response shape can vary
    let variantList = [];
    if (Array.isArray(variantsRaw)) variantList = variantsRaw;
    else if (Array.isArray(variantsRaw?.variants)) variantList = variantsRaw.variants;
    else if (Array.isArray(variantsRaw?.data)) variantList = variantsRaw.data;

    console.log(`[Printify] Provider ${best.id} has ${variantList.length} variant(s)`);

    if (!variantList.length) {
      // Try the second-best provider if variants are empty
      if (scoredProviders.length > 1) {
        const fallback = scoredProviders[1];
        console.log(`[Printify] No variants for provider ${best.id}, trying fallback provider ${fallback.id}`);
        const fb = await printifyFetch(`/catalog/blueprints/${blueprintId}/print_providers/${fallback.id}/variants.json`);
        const fbList = Array.isArray(fb) ? fb : (Array.isArray(fb?.variants) ? fb.variants : []);
        if (fbList.length) {
          const fbVariant = fbList[0];
          return res.json({
            blueprintId,
            provider: { id: fallback.id, title: fallback.title, score: fallback._score, location: fallback.location?.country || "unknown", usedFallback: true },
            variant:  { id: fbVariant.id, title: fbVariant.title || fbVariant.options?.join(" / ") || "Default" },
            variantCount: fbList.length,
            allProviders: scoredProviders.map(p => ({ id: p.id, title: p.title, score: p._score, location: p.location?.country || "?" })),
          });
        }
      }
      return res.status(404).json({ error: `No variants found for blueprint ${blueprintId} with any available provider.` });
    }

    const firstVariant = variantList[0];
    const variantTitle = firstVariant.title || firstVariant.options?.join(" / ") || `Variant ${firstVariant.id}`;
    console.log(`[Printify] Using variant id=${firstVariant.id} title="${variantTitle}"`);

    res.json({
      blueprintId,
      provider: {
        id:       best.id,
        title:    best.title,
        score:    best._score,
        location: best.location?.country || "unknown",
      },
      variant: {
        id:    firstVariant.id,
        title: variantTitle,
      },
      variantCount: variantList.length,
      allProviders: scoredProviders.map(p => ({ id: p.id, title: p.title, score: p._score, location: p.location?.country || "?" })),
    });

  } catch (err) {
    console.error(`[Printify] blueprint-info error for ${blueprintId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/printify/products", async (req, res) => {
  try {
    const shopId = await getPrintifyShopId();
    res.json(await printifyFetch(`/shops/${shopId}/products.json?limit=20&page=1`));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/printify/create-product
// Requires explicit blueprintId + printProviderId + variantId.
// Caller MUST have fetched /api/printify/catalog then /api/printify/blueprint-info.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/printify/create-product", async (req, res) => {
  const { title, description, blueprintId, printProviderId, variantId, imageUrl, price } = req.body;

  if (!title)           return res.status(400).json({ error: "title required" });
  if (!blueprintId)     return res.status(400).json({ error: "blueprintId required — call /api/printify/catalog first" });
  if (!printProviderId) return res.status(400).json({ error: "printProviderId required — call /api/printify/blueprint-info first" });
  if (!variantId)       return res.status(400).json({ error: "variantId required — call /api/printify/blueprint-info first" });

  const bpId  = parseInt(blueprintId);
  const prvId = parseInt(printProviderId);
  const varId = parseInt(variantId);

  console.log(`[Printify] create-product — bp=${bpId} provider=${prvId} variant=${varId} price=${price} title="${title}"`);

  try {
    const shopId = await getPrintifyShopId();

    // Optional image upload
    let printifyImageId = null;
    if (imageUrl) {
      console.log(`[Printify] Uploading image: ${imageUrl}`);
      try {
        const imgRes = await printifyFetch("/uploads/images.json", {
          method: "POST",
          body: JSON.stringify({ file_name: `kitsari_${Date.now()}.png`, url: imageUrl }),
        });
        printifyImageId = imgRes.id;
        console.log(`[Printify] Image uploaded — id=${printifyImageId}`);
      } catch (imgErr) {
        console.warn(`[Printify] Image upload failed (product will need art via dashboard): ${imgErr.message}`);
      }
    }

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

    console.log(`[Printify] Submitting product payload (description truncated):`, JSON.stringify({ ...payload, description: payload.description.slice(0, 60) + "..." }));

    const product = await printifyFetch(`/shops/${shopId}/products.json`, {
      method: "POST",
      body:   JSON.stringify(payload),
    });

    console.log(`[Printify] Product created — id=${product.id} title="${product.title}"`);

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
    console.error(`[Printify] create-product FAILED: ${err.message}`);
    res.status(500).json({
      error: err.message,
      debug: { blueprintId: bpId, printProviderId: prvId, variantId: varId },
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/printify/publish-to-etsy
// Syncs a Printify product into Etsy as a DRAFT listing only.
// Publishing stays permanently locked in this route.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/printify/publish-to-etsy", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });

  const { printifyProductId, title, description, tags, price, productType, aiDraft } = req.body;

  const resolvedTitle = (title || parseSection(aiDraft || "", "ETSY SEO TITLE") || "Celestial Yokai Product")
    .replace(/\*\*/g, "").trim().slice(0, 140);
  const resolvedDesc  = description || parseSection(aiDraft || "", "DESCRIPTION") || resolvedTitle;
  const resolvedTags  = Array.isArray(tags) && tags.length ? tags.slice(0, 13) : parseTags(aiDraft || "");
  const resolvedPrice = parseFloat(price) || parsePrice(aiDraft || "") || 18.00;

  const isPhysical = ["shirt", "poster", "sticker"].includes(productType);

  console.log(`[Etsy] publish-to-etsy — title="${resolvedTitle}" tags=${resolvedTags.length} price=${resolvedPrice} physical=${isPhysical}`);

  try {
    const listing = await etsyFetch(`/application/shops/${etsyStore.shopId}/listings`, {
      method: "POST",
      body: JSON.stringify({
        quantity:    999,
        title:       resolvedTitle,
        description: resolvedDesc,
        price:       resolvedPrice,
        who_made:    "i_did",
        when_made:   "made_to_order",
        taxonomy_id: isPhysical ? 68887794 : 2078,
        type:        isPhysical ? "physical" : "download",
        tags:        resolvedTags,
        state:       "draft",   // ALWAYS DRAFT — publishing locked
      }),
    });

    console.log(`[Etsy] Draft listing created — id=${listing.listing_id} url=${listing.url}`);

    res.json({
      success:           true,
      listingId:         listing.listing_id,
      etsyUrl:           listing.url,
      printifyProductId: printifyProductId || null,
      state:             "draft",
      title:             resolvedTitle,
      tagCount:          resolvedTags.length,
      publishLocked:     "Autonomous publishing is locked until draft quality, Etsy compliance, and Printify sync are verified.",
    });

  } catch (err) {
    console.error(`[Etsy] publish-to-etsy FAILED: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// KITSARI AI ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/agent/kitsari", async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: "Command required." });
  try { res.json({ agent: "kitsari", response: await askKitsari(command.trim()) }); }
  catch (err) { res.status(500).json({ error: "Transmission failed." }); }
});

// ── Generate Product — primary sticker-focused AI draft ──────────────────────
app.post("/api/commerce/generate-product", async (req, res) => {
  const { productType = "sticker", theme, stickerStyle, nftAngle } = req.body;

  const typeContext = productType === "sticker"
    ? `PRODUCT TYPE: Kiss-cut vinyl sticker (Printify sticker blueprint)
STICKER STYLE: ${stickerStyle || "sigil / emblem / faction decal"}
Format: standalone die-cut or small 2-4 sticker sheet. Suitable for laptop, bottle, journal, NFT merch pack.`
    : productType === "poster"
    ? `PRODUCT TYPE: Art print / poster (Printify poster blueprint)
Format: vertical or square print, wall art, collectible display piece.`
    : `PRODUCT TYPE: T-shirt (Printify shirt blueprint)
Format: unisex, front print, collector / fan appeal.`;

  const prompt = `Generate a complete Celestial Yokai product draft for the Lantern District Market.

${typeContext}
THEME: ${theme || "Kitsari / Lantern District / celestial fox sigil"}
NFT UTILITY: ${nftAngle || "holder-only variant or faction decal concept"}

Generate EXACTLY this structure with these exact headings:

## PRODUCT NAME
Evocative brand name for this piece — collectible-feeling, not generic.

## LORE ANGLE
2-3 sentences of in-universe lore making this feel like a real artifact from the Hidden Realm.

## TARGET BUYER
Specific buyer profile: interests, motivation, discovery channel.

## ETSY SEO TITLE
Max 140 chars. Front-load most-searched keywords. End with "Celestial Yokai" or "Lantern District".

## DESCRIPTION
180-250 words. Opening hook, lore tie-in, product details, material/size placeholder, care note. Mystical but scannable.

## 13 ETSY TAGS
tag one, tag two, tag three, tag four, tag five, tag six, tag seven, tag eight, tag nine, tag ten, tag eleven, tag twelve, tag thirteen
(max 20 chars each, no repeats, mix broad and niche)

## PRICING SUGGESTION
Retail price with brief reasoning. NFT holder discount suggestion.

## PRINTIFY PRODUCT MATCH
Exact Printify product category name for this type.

## MOCKUP ART DIRECTION
2-3 sentences: background, props, lighting for maximum Etsy conversion.

## X LAUNCH POST
One post, max 280 chars, hook-first, 2-3 hashtags. High energy.

## NFT HOLDER UTILITY
Specific benefit: trait variant, holder discount %, early access, or secret shop page.

All content must be original Celestial Yokai IP. No copying existing sellers or copyrighted material.`;

  try {
    const aiDraft = await askKitsari(prompt, 2200);
    res.json({ response: aiDraft, productType, status: "ai_draft", publishLocked: true });
  } catch (err) {
    console.error("[AI] generate-product:", err.message);
    res.status(500).json({ error: "Draft generation failed." });
  }
});

app.post("/api/commerce/product-idea", async (req, res) => {
  const { niche, style, medium } = req.body;
  const prompt = `Generate 3 original Celestial Yokai print-on-demand product ideas.

Theme: ${niche || "celestial yokai, mystical anime, dark cosmic"}
Visual style: ${style || "glowing, ethereal, dark palette with gold accents"}
Product type: ${medium || "sticker, poster, or shirt"}

For EACH of the 3 ideas:
1. **Product Name** — evocative, marketable
2. **Product Type** — Printify-compatible (sticker / poster / shirt)
3. **Design Concept** — vivid 2-3 sentence original description
4. **Target Buyer** — specific profile
5. **Retail Price** — with reasoning
6. **Printify Blueprint** — exact category
7. **NFT Holder Utility** — specific benefit

Separate ideas with ---
Original Celestial Yokai IP only.`;

  try { res.json({ response: await askKitsari(prompt, 1800) }); }
  catch (err) { res.status(500).json({ error: "Market spirits unavailable." }); }
});

app.post("/api/commerce/launch-post", async (req, res) => {
  const { productName, platform, tone, dropDate } = req.body;
  if (!productName) return res.status(400).json({ error: "Product name required." });
  const prompt = `Write a complete social launch package for the Celestial Night Market.

Product: ${productName}
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
Post specifically for holders. Reference their benefit.`;
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
Trends, buyer psychology, seasonal notes.

## CONTENT GAP
What Celestial Yokai could own that doesn't exist yet.

## TOP 3 PRODUCT OPPORTUNITIES
Each: product type, why it sells, price point, first-mover angle.

## ETSY SEO KEYWORDS
15 high-opportunity keywords (not from any specific seller).

## NFT CROSSOVER ANGLE
How to connect products to NFT holder utility.

Analyze trends only. Never copy specific seller content.`;
  try { res.json({ response: await askKitsari(prompt, 1800) }); }
  catch (err) { res.status(500).json({ error: "Market scan failed." }); }
});

// ── Ledger snapshot ───────────────────────────────────────────────────────────
app.get("/api/ledger/snapshot", async (req, res) => {
  if (!etsyStore.accessToken || !etsyStore.shopId) {
    return res.json({ connected: false, message: "Connect Etsy to populate the Lunar Ledger." });
  }
  try {
    const [shopR, draftR] = await Promise.allSettled([
      etsyFetch(`/application/shops/${etsyStore.shopId}`),
      etsyFetch(`/application/shops/${etsyStore.shopId}/listings?state=draft&limit=100`),
    ]);
    const shop   = shopR.status  === "fulfilled" ? shopR.value  : null;
    const drafts = draftR.status === "fulfilled" ? draftR.value : null;
    res.json({
      connected:    true,
      shopName:     etsyStore.shopName,
      shopId:       etsyStore.shopId,
      connectedAt:  etsyStore.connectedAt,
      favorites:    shop?.num_favorers           ?? "—",
      orders:       shop?.transaction_sold_count ?? "—",
      listingCount: shop?.listing_active_count   ?? "—",
      draftCount:   drafts?.count ?? 0,
      currency:     shop?.currency_code ?? "USD",
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
