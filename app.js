const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

// ── Credentials — never exposed to frontend ───────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PRINTIFY_KEY  = process.env.PRINTIFY_API_KEY   || null;
const ETSY_API_KEY  = process.env.ETSY_API_KEY        || null;
const ETSY_SECRET   = process.env.ETSY_SHARED_SECRET  || null;
const ETSY_REDIRECT = process.env.ETSY_REDIRECT_URI   || null;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── In-memory stores ──────────────────────────────────────────────────────────
const etsyStore = {
  accessToken: null, refreshToken: null,
  shopId: null, shopName: null, connectedAt: null,
  state: null, codeVerifier: null,
};
const printifyStore = {
  shopId: null, shopTitle: null,
  catalog: null, catalogFetchedAt: null,
};
const CATALOG_TTL_MS = 30 * 60 * 1000;

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── PKCE ──────────────────────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function generateCodeVerifier() { return base64url(crypto.randomBytes(32)); }
function generateCodeChallenge(v) {
  return base64url(crypto.createHash("sha256").update(v).digest());
}

// ── Etsy fetch ────────────────────────────────────────────────────────────────
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
  if (!r.ok) { const t = await r.text(); throw new Error(`Etsy ${r.status}: ${t.slice(0, 300)}`); }
  return r.json();
}

// ── Printify fetch ────────────────────────────────────────────────────────────
async function printifyFetch(endpoint, opts = {}) {
  if (!PRINTIFY_KEY) throw new Error("PRINTIFY_API_KEY not set");
  const r = await fetch(`https://api.printify.com/v1${endpoint}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${PRINTIFY_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Printify ${r.status}: ${t.slice(0, 400)}`); }
  return r.json();
}

async function getPrintifyShopId() {
  if (printifyStore.shopId) return printifyStore.shopId;
  const shops = await printifyFetch("/shops.json");
  if (!Array.isArray(shops) || !shops.length) throw new Error("No Printify shops found");
  printifyStore.shopId = shops[0].id;
  printifyStore.shopTitle = shops[0].title;
  console.log(`[Printify] Shop: id=${printifyStore.shopId} title="${printifyStore.shopTitle}"`);
  return printifyStore.shopId;
}

// ── Catalog search ────────────────────────────────────────────────────────────
const TYPE_SEARCH_TERMS = {
  sticker: ["kiss-cut stickers", "kiss cut sticker", "kiss-cut sticker", "sticker sheet", "die cut sticker", "die-cut sticker", "sticker"],
  poster:  ["enhanced matte paper poster", "matte paper poster", "enhanced matte poster", "poster", "fine art print", "art print", "wall art", "print"],
  shirt:   ["unisex softstyle t-shirt", "unisex softstyle tshirt", "unisex heavy cotton tee", "unisex staple t-shirt", "unisex t-shirt", "t-shirt", "tee shirt", "tshirt", "tee", "shirt"],
};

async function resolveBlueprints(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && printifyStore.catalog && printifyStore.catalogFetchedAt && now - printifyStore.catalogFetchedAt < CATALOG_TTL_MS) {
    return printifyStore.catalog;
  }
  console.log("[Printify] Fetching catalog...");
  const raw = await printifyFetch("/catalog/blueprints.json");
  const blueprints = Array.isArray(raw) ? raw : [];
  console.log(`[Printify] Catalog: ${blueprints.length} blueprints`);
  if (!blueprints.length) throw new Error("Printify catalog returned 0 blueprints — check API key permissions");

  // Log all titles for diagnostics
  console.log("[Printify] Blueprint titles:");
  blueprints.forEach(b => console.log(`  ${b.id}: "${b.title}"`));

  const catalog = { _allBlueprints: blueprints.map(b => ({ id: b.id, title: b.title })) };
  for (const [type, terms] of Object.entries(TYPE_SEARCH_TERMS)) {
    let match = null;
    for (const term of terms) {
      match = blueprints.find(b => b.title?.toLowerCase().includes(term.toLowerCase()));
      if (match) { console.log(`[Printify] Match ${type}: term="${term}" → id=${match.id} "${match.title}"`); break; }
    }
    catalog[type] = match
      ? { blueprintId: match.id, blueprintTitle: match.title, found: true }
      : { blueprintId: null, blueprintTitle: null, found: false };
    if (!match) console.warn(`[Printify] No match for "${type}". Terms: ${terms.join(", ")}`);
  }
  printifyStore.catalog = catalog;
  printifyStore.catalogFetchedAt = now;
  return catalog;
}

// ── Provider scoring ──────────────────────────────────────────────────────────
const PREFERRED_PROVIDERS = ["monster digital", "printify", "district photo", "sticker mule", "printful", "gooten", "awkward styles"];
function scoreProvider(p) {
  let s = 0;
  const title = (p.title || "").toLowerCase();
  const loc = (p.location?.country || "").toLowerCase();
  if (loc === "us" || loc === "united states") s += 50;
  s += Math.min(parseFloat(p.rating || p.score || 0) * 10, 40);
  for (const n of PREFERRED_PROVIDERS) { if (title.includes(n)) { s += 20; break; } }
  return s;
}

// ── Kitsari AI ────────────────────────────────────────────────────────────────
const KITSARI_SYSTEM = `You are Kitsari — operator of the Lantern District Market, a nine-tailed celestial fox spirit who has mastered Etsy commerce, Printify print-on-demand, NFT utility design, and brand alchemy.

PERSONALITY: Sharp, warm, precise, playful. Lantern-fire confidence. Never generic. No em dashes. Keep responses actionable.

COMPLIANCE: Never copy existing sellers, copyrighted designs, or trademarks. All products must be original Celestial Yokai ecosystem merchandise.

NFT UTILITY: Weave in holder benefits where relevant: holder-only discounts, trait-based variants, early access, secret shop pages, collectible artifacts.

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
// ETSY OAUTH
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/etsy/debug", (req, res) => res.json({
  hasApiKey:      !!ETSY_API_KEY,
  hasSecret:      !!ETSY_SECRET,
  redirectUri:    ETSY_REDIRECT || "NOT SET",
  stateStored:    !!etsyStore.state,
  verifierStored: !!etsyStore.codeVerifier,
  connected:      !!etsyStore.accessToken,
  shopName:       etsyStore.shopName || null,
  connectedAt:    etsyStore.connectedAt || null,
}));

app.get("/api/etsy/connect", (req, res) => {
  console.log("[Etsy OAuth] Starting Etsy OAuth flow");
  if (!ETSY_API_KEY) {
    console.error("[Etsy OAuth] ETSY_API_KEY is not set");
    return res.status(500).send("<h2>Missing ETSY_API_KEY</h2><p>Add it to Railway environment variables.</p>");
  }
  if (!ETSY_REDIRECT) {
    console.error("[Etsy OAuth] ETSY_REDIRECT_URI is not set");
    return res.status(500).send("<h2>Missing ETSY_REDIRECT_URI</h2><p>Set it to: https://your-app.railway.app/api/etsy/callback</p>");
  }
  const state        = base64url(crypto.randomBytes(16));
  const codeVerifier = generateCodeVerifier();
  const challenge    = generateCodeChallenge(codeVerifier);
  etsyStore.state        = state;
  etsyStore.codeVerifier = codeVerifier;
  const params = new URLSearchParams({
    response_type: "code", redirect_uri: ETSY_REDIRECT,
    scope: "listings_r listings_w shops_r transactions_r",
    client_id: ETSY_API_KEY, state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authUrl = `https://www.etsy.com/oauth/connect?${params.toString()}`;
  console.log(`[Etsy OAuth] Redirecting to Etsy — redirect_uri=${ETSY_REDIRECT}`);
  res.redirect(authUrl);
});

app.get("/api/etsy/callback", async (req, res) => {
  console.log("[Etsy OAuth] Received Etsy callback — query:", JSON.stringify(req.query));
  const { code, state, error, error_description } = req.query;
  if (error) {
    console.error(`[Etsy OAuth] Etsy returned error: ${error} — ${error_description}`);
    return res.status(400).send(`<h2>Etsy Authorization Error</h2><p><strong>${error}</strong>: ${error_description||"unknown"}</p><p><a href="/api/etsy/connect">Try again</a></p>`);
  }
  if (!code) {
    console.error(`[Etsy OAuth] No code in callback. redirect_uri=${ETSY_REDIRECT}`);
    return res.status(400).send(`<h2>Missing Authorization Code</h2><p>Redirect URI must exactly match:<br><code>${ETSY_REDIRECT}</code></p><p><a href="/api/etsy/connect">Start over</a> | <a href="/api/etsy/debug">Debug</a></p>`);
  }
  if (!state || state !== etsyStore.state) {
    console.error(`[Etsy OAuth] State mismatch — received: ${state}, stored: ${etsyStore.state}`);
    return res.status(400).send(`<h2>OAuth State Mismatch</h2><p>Server may have restarted. <a href="/api/etsy/connect">Start over</a></p>`);
  }
  try {
    console.log("[Etsy OAuth] Exchanging authorization code for token...");
    const tr = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: ETSY_API_KEY,
        redirect_uri: ETSY_REDIRECT, code, code_verifier: etsyStore.codeVerifier,
      }),
    });
    if (!tr.ok) {
      const errText = await tr.text();
      console.error(`[Etsy OAuth] Etsy token exchange failed (${tr.status}): ${errText}`);
      return res.status(500).send(`<h2>Token Exchange Failed</h2><p>Status ${tr.status} — check Railway logs.</p><p><a href="/api/etsy/connect">Retry</a></p>`);
    }
    const tokens = await tr.json();
    etsyStore.accessToken  = tokens.access_token;
    etsyStore.refreshToken = tokens.refresh_token;
    etsyStore.connectedAt  = new Date().toISOString();
    etsyStore.state        = null;
    etsyStore.codeVerifier = null;
    console.log("[Etsy OAuth] Etsy token exchange success — fetching shop info...");
    try {
      const sd = await etsyFetch("/application/shops?limit=1");
      if (sd?.results?.[0]) {
        etsyStore.shopId   = sd.results[0].shop_id;
        etsyStore.shopName = sd.results[0].shop_name;
        console.log(`[Etsy OAuth] Shop found: id=${etsyStore.shopId} name="${etsyStore.shopName}"`);
      }
    } catch (shopErr) {
      console.warn("[Etsy OAuth] Shop fetch failed (non-fatal):", shopErr.message);
    }
    res.redirect("/?etsy=connected");
  } catch (err) {
    console.error("[Etsy OAuth] OAuth callback exception:", err.message);
    res.status(500).send(`<h2>OAuth Failed</h2><p>${err.message}</p><p><a href="/api/etsy/connect">Retry</a></p>`);
  }
});

app.get("/api/etsy/status", (req, res) => {
  if (!ETSY_API_KEY) {
    console.log("[Etsy] status: unconfigured — ETSY_API_KEY missing");
    return res.json({ connected: false, status: "unconfigured", message: "ETSY_API_KEY not set in Railway." });
  }
  if (!etsyStore.accessToken) {
    console.log("[Etsy] status: disconnected — no access token");
    return res.json({ connected: false, status: "disconnected", message: "Etsy disconnected — reconnect required." });
  }
  console.log("[Etsy] status: connected — shop=" + (etsyStore.shopName || "unknown"));
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

app.post("/api/etsy/create-draft", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });
  const { title, description, tags, price, type } = req.body;
  if (!title || !description) return res.status(400).json({ error: "Title and description required." });
  try {
    const listing = await etsyFetch(`/application/shops/${etsyStore.shopId}/listings`, {
      method: "POST",
      body: JSON.stringify({
        quantity: 999, title: title.slice(0, 140), description,
        price: parseFloat(price) || 18.00, who_made: "i_did", when_made: "made_to_order",
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
  if (!PRINTIFY_KEY) {
    console.log("[Printify] status: unconfigured — PRINTIFY_API_KEY missing");
    return res.json({ connected: false, message: "PRINTIFY_API_KEY not set." });
  }
  try {
    console.log("[Printify] status: checking API...");
    const shops = await printifyFetch("/shops.json");
    if (Array.isArray(shops) && shops.length) { printifyStore.shopId = shops[0].id; printifyStore.shopTitle = shops[0].title; }
    console.log("[Printify] status: connected — " + shops.length + " shop(s)");
    res.json({ connected: true, shopCount: shops.length, shops: shops.map(s => ({ id: s.id, title: s.title })), activeShopId: printifyStore.shopId });
  } catch (err) {
    console.error("[Printify] status check failed:", err.message);
    res.json({ connected: false, message: err.message });
  }
});

app.get("/api/printify/shops", async (req, res) => {
  try { res.json(await printifyFetch("/shops.json")); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/printify/catalog", async (req, res) => {
  if (!PRINTIFY_KEY) return res.status(400).json({ error: "PRINTIFY_API_KEY not configured." });
  try {
    const catalog = await resolveBlueprints(req.query.refresh === "true");
    const { _allBlueprints, ...supported } = catalog;
    res.json({
      supported,
      foundCount: Object.values(supported).filter(v => v.found).length,
      totalBlueprints: (_allBlueprints || []).length,
      allBlueprints: _allBlueprints || [],
      cachedAt: printifyStore.catalogFetchedAt,
    });
  } catch (err) { console.error("[Printify] catalog error:", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/api/printify/blueprint-info/:blueprintId?", async (req, res) => {
  const blueprintId = parseInt(req.params.blueprintId || req.query.blueprintId);
  if (!blueprintId) return res.status(400).json({ error: "blueprintId required" });
  console.log(`[Printify] blueprint-info: id=${blueprintId}`);
  try {
    const providersRaw = await printifyFetch(`/catalog/blueprints/${blueprintId}/print_providers.json`);
    const providers = Array.isArray(providersRaw) ? providersRaw : [];
    console.log(`[Printify] ${providers.length} provider(s): ${providers.map(p => `${p.id}:"${p.title}"`).join(", ")}`);
    if (!providers.length) return res.status(404).json({ error: `No providers for blueprint ${blueprintId}` });

    const scored = providers.map(p => ({ ...p, _score: scoreProvider(p) })).sort((a, b) => b._score - a._score);
    let best = scored[0];
    console.log(`[Printify] Best provider: id=${best.id} "${best.title}" score=${best._score} loc=${best.location?.country || "?"}`);

    // Get variants, try fallback providers if empty
    let variantList = [], usedProvider = best;
    for (const prov of scored) {
      const vRaw = await printifyFetch(`/catalog/blueprints/${blueprintId}/print_providers/${prov.id}/variants.json`);
      variantList = Array.isArray(vRaw) ? vRaw : (Array.isArray(vRaw?.variants) ? vRaw.variants : []);
      console.log(`[Printify] Provider ${prov.id} has ${variantList.length} variant(s)`);
      if (variantList.length) { usedProvider = prov; break; }
    }
    if (!variantList.length) return res.status(404).json({ error: `No variants found for blueprint ${blueprintId} with any provider` });

    const v = variantList[0];
    const vTitle = v.title || (v.options ? Object.values(v.options).join(" / ") : `Variant ${v.id}`);
    console.log(`[Printify] Using variant id=${v.id} title="${vTitle}"`);

    res.json({
      blueprintId,
      provider: { id: usedProvider.id, title: usedProvider.title, score: usedProvider._score, location: usedProvider.location?.country || "unknown" },
      variant: { id: v.id, title: vTitle },
      variantCount: variantList.length,
      allProviders: scored.map(p => ({ id: p.id, title: p.title, score: p._score, location: p.location?.country || "?" })),
    });
  } catch (err) { console.error(`[Printify] blueprint-info error:`, err.message); res.status(500).json({ error: err.message }); }
});

app.get("/api/printify/products", async (req, res) => {
  try { const shopId = await getPrintifyShopId(); res.json(await printifyFetch(`/shops/${shopId}/products.json?limit=20&page=1`)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/printify/upload-image
// Uploads artwork to Printify and returns the image ID.
// Accepts: { imageUrl } OR { imageBase64, mimeType }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/printify/upload-image", async (req, res) => {
  const { imageUrl, imageBase64, mimeType = "image/png" } = req.body;
  if (!imageUrl && !imageBase64) return res.status(400).json({ error: "imageUrl or imageBase64 required" });

  const fileName = `kitsari_art_${Date.now()}.png`;
  console.log(`[Printify] Uploading image: ${imageUrl ? `url=${imageUrl}` : "base64 data"}`);

  try {
    let payload;
    if (imageBase64) {
      // Base64 upload — clean data URL prefix if present
      const cleanB64 = imageBase64.replace(/^data:[^;]+;base64,/, "");
      payload = { file_name: fileName, contents: cleanB64 };
    } else {
      payload = { file_name: fileName, url: imageUrl };
    }

    const result = await printifyFetch("/uploads/images.json", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    console.log(`[Printify] Image uploaded — id=${result.id} preview=${result.preview_url || "none"}`);
    res.json({
      success: true,
      imageId: result.id,
      previewUrl: result.preview_url || null,
      fileName: result.file_name || fileName,
    });
  } catch (err) {
    console.error(`[Printify] upload-image FAILED: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/printify/create-product
// Now REQUIRES a printifyImageId (from /api/printify/upload-image).
// Will NOT attempt creation without a valid image attached.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/printify/create-product", async (req, res) => {
  const { title, description, blueprintId, printProviderId, variantId, printifyImageId, price } = req.body;

  if (!title)            return res.status(400).json({ error: "title required" });
  if (!blueprintId)      return res.status(400).json({ error: "blueprintId required — run catalog fetch first" });
  if (!printProviderId)  return res.status(400).json({ error: "printProviderId required — run blueprint-info first" });
  if (!variantId)        return res.status(400).json({ error: "variantId required — run blueprint-info first" });
  if (!printifyImageId)  return res.status(400).json({ error: "printifyImageId required — upload artwork first via /api/printify/upload-image" });

  const bpId  = parseInt(blueprintId);
  const prvId = parseInt(printProviderId);
  const varId = parseInt(variantId);

  console.log(`[Printify] create-product — bp=${bpId} provider=${prvId} variant=${varId} imageId=${printifyImageId} price=${price} title="${title}"`);

  try {
    const shopId = await getPrintifyShopId();

    const payload = {
      title:             title.slice(0, 140),
      description:       description || title,
      blueprint_id:      bpId,
      print_provider_id: prvId,
      variants:          [{ id: varId, price: Math.round((parseFloat(price) || 18.00) * 100), is_enabled: true }],
      print_areas: [{
        variant_ids:  [varId],
        placeholders: [{
          position: "front",
          images:   [{ id: printifyImageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
        }],
      }],
    };

    console.log(`[Printify] Submitting payload (desc truncated):`, JSON.stringify({ ...payload, description: (payload.description || "").slice(0, 60) + "..." }));

    const product = await printifyFetch(`/shops/${shopId}/products.json`, {
      method: "POST", body: JSON.stringify(payload),
    });

    console.log(`[Printify] Product created — id=${product.id} title="${product.title}"`);
    res.json({ success: true, printifyProductId: product.id, title: product.title, blueprintId: bpId, printProviderId: prvId, variantId: varId, shopId });
  } catch (err) {
    console.error(`[Printify] create-product FAILED: ${err.message}`);
    res.status(500).json({ error: err.message, debug: { blueprintId: bpId, printProviderId: prvId, variantId: varId, imageId: printifyImageId } });
  }
});

app.post("/api/printify/publish-to-etsy", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({ error: "Etsy not connected." });
  const { printifyProductId, title, description, tags, price, productType, aiDraft } = req.body;
  const resolvedTitle = (title || parseSection(aiDraft || "", "ETSY SEO TITLE") || "Celestial Yokai Product").replace(/\*\*/g, "").trim().slice(0, 140);
  const resolvedDesc  = description || parseSection(aiDraft || "", "DESCRIPTION") || resolvedTitle;
  const resolvedTags  = Array.isArray(tags) && tags.length ? tags.slice(0, 13) : parseTags(aiDraft || "");
  const resolvedPrice = parseFloat(price) || parsePrice(aiDraft || "") || 18.00;
  const isPhysical    = ["shirt", "poster", "sticker"].includes(productType);
  console.log(`[Etsy] publish-to-etsy — title="${resolvedTitle}" tags=${resolvedTags.length} price=${resolvedPrice}`);
  try {
    const listing = await etsyFetch(`/application/shops/${etsyStore.shopId}/listings`, {
      method: "POST",
      body: JSON.stringify({
        quantity: 999, title: resolvedTitle, description: resolvedDesc,
        price: resolvedPrice, who_made: "i_did", when_made: "made_to_order",
        taxonomy_id: isPhysical ? 68887794 : 2078,
        type: isPhysical ? "physical" : "download",
        tags: resolvedTags, state: "draft",
      }),
    });
    console.log(`[Etsy] Draft created — id=${listing.listing_id} url=${listing.url}`);
    res.json({ success: true, listingId: listing.listing_id, etsyUrl: listing.url, printifyProductId: printifyProductId || null, state: "draft", title: resolvedTitle, tagCount: resolvedTags.length, publishLocked: "Autonomous publishing is locked until draft quality, Etsy compliance, and Printify sync are verified." });
  } catch (err) { console.error(`[Etsy] publish-to-etsy FAILED: ${err.message}`); res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ARTWORK GENERATION
// ════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/art/generate
// Uses Claude to generate a detailed visual prompt for the artwork concept,
// then calls Claude's image generation capability if available.
// Returns a prompt + a placeholder SVG artwork for immediate use.
//
// NOTE: Claude does not generate images natively. This route:
// 1. Generates a detailed visual prompt via Claude text
// 2. Creates a high-quality SVG placeholder that represents the sigil/design
// 3. Converts SVG → base64 for Printify upload
//
// To use real AI images: integrate an image generation API (DALL-E, Stability AI,
// etc.) and pass the returned URL to /api/printify/upload-image.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/art/generate", async (req, res) => {
  const { concept, stickerStyle = "sigil", productType = "sticker", theme } = req.body;

  console.log(`[Art] Generating artwork — style="${stickerStyle}" concept="${concept}"`);

  // Step 1: Generate visual prompt via Claude
  const promptRequest = `You are a visual art director for the Celestial Yokai brand. Create a precise, detailed visual prompt for AI image generation of a ${productType} design.

Style: ${stickerStyle}
Concept: ${concept || theme || "Kitsari fox sigil / Lantern District emblem"}
Product: ${productType === "sticker" ? "Kiss-cut vinyl sticker, needs clean transparent/white background" : productType}

Generate:

## VISUAL PROMPT
A single dense paragraph (80-120 words) describing the artwork for an AI image generator. Include: subject, style, colors, mood, technical specs. Must specify: transparent background, vector-style, clean edges suitable for printing. Celestial Yokai aesthetic — mystical, anime-influenced, dark cosmic palette with gold/purple accents.

## DESIGN NOTES
3 bullet points of key design decisions that make this work as a ${productType}.

## COLOR PALETTE
Primary: [hex], Secondary: [hex], Accent: [hex], Background: transparent or white`;

  try {
    const aiResponse = await askKitsari(promptRequest, 800);
    const visualPrompt = parseSection(aiResponse, "VISUAL PROMPT");
    const designNotes  = parseSection(aiResponse, "DESIGN NOTES");

    // Step 2: Generate SVG placeholder artwork
    // This is a real, print-ready SVG sigil that can be uploaded to Printify.
    // Replace this section with a real image generation API call for production.
    const svgArt = generateSigilSVG(concept || theme || stickerStyle, stickerStyle);
    const svgBase64 = Buffer.from(svgArt).toString("base64");
    const dataUrl = `data:image/svg+xml;base64,${svgBase64}`;

    console.log(`[Art] Artwork generated — SVG ${svgArt.length} chars`);

    res.json({
      success:       true,
      visualPrompt,
      designNotes,
      fullAiResponse: aiResponse,
      // Artwork as base64 data URL — ready for display and Printify upload
      artworkDataUrl:  dataUrl,
      artworkBase64:   svgBase64,
      artworkMimeType: "image/svg+xml",
      artworkType:     "svg_placeholder",
      note: "SVG sigil generated. For photorealistic art, integrate DALL-E or Stability AI and pass the image URL to /api/printify/upload-image.",
    });
  } catch (err) {
    console.error(`[Art] generate error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SVG Sigil Generator — creates a print-ready 1200×1200 sticker design
// Pure SVG, no external deps. Suitable for Printify upload.
// ─────────────────────────────────────────────────────────────────────────────
function generateSigilSVG(concept = "", style = "sigil") {
  const seed = concept.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = (n) => ((seed * 9301 + n * 49297) % 233280) / 233280;

  // Color palettes by style
  const PALETTES = {
    sigil:    { primary: "#c084fc", secondary: "#9b5cf6", accent: "#e8c97a", glow: "rgba(192,132,252,0.6)" },
    seal:     { primary: "#e8c97a", secondary: "#b45309", accent: "#c084fc", glow: "rgba(232,201,122,0.6)" },
    emblem:   { primary: "#67e8f9", secondary: "#0e7490", accent: "#9b5cf6", glow: "rgba(103,232,249,0.6)" },
    warning:  { primary: "#ff6b6b", secondary: "#c41e3a", accent: "#e8c97a", glow: "rgba(255,107,107,0.6)" },
    kitsari:  { primary: "#c084fc", secondary: "#e8c97a", accent: "#ffffff", glow: "rgba(192,132,252,0.7)" },
    faction:  { primary: "#4ade80", secondary: "#166534", accent: "#e8c97a", glow: "rgba(74,222,128,0.6)" },
  };
  const pal = PALETTES[style] || PALETTES.sigil;

  // Generate a unique but consistent geometric pattern from the concept seed
  const rings = 3 + Math.floor(rng(1) * 2);
  const petals = 6 + Math.floor(rng(2) * 6);
  const innerRot = rng(3) * 360;
  const hasMoon = rng(4) > 0.4;
  const hasRunes = rng(5) > 0.3;

  // Core geometry
  const cx = 600, cy = 600, baseR = 420;

  let paths = "";

  // Outer ring with glow
  paths += `<circle cx="${cx}" cy="${cy}" r="${baseR}" fill="none" stroke="${pal.primary}" stroke-width="3" opacity="0.9"/>`;
  paths += `<circle cx="${cx}" cy="${cy}" r="${baseR + 8}" fill="none" stroke="${pal.primary}" stroke-width="1" opacity="0.3"/>`;

  // Inner rings
  for (let r = 1; r <= rings; r++) {
    const rad = baseR * (0.75 - r * 0.15);
    paths += `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${pal.secondary}" stroke-width="${2 - r * 0.3}" opacity="${0.7 - r * 0.1}" stroke-dasharray="${r % 2 === 0 ? "none" : "8,4"}"/>`;
  }

  // Radiating lines (like a compass rose)
  for (let i = 0; i < petals; i++) {
    const angle = (i / petals) * 360 + innerRot;
    const rad = angle * Math.PI / 180;
    const x1 = cx + Math.cos(rad) * baseR * 0.25;
    const y1 = cy + Math.sin(rad) * baseR * 0.25;
    const x2 = cx + Math.cos(rad) * baseR * 0.92;
    const y2 = cy + Math.sin(rad) * baseR * 0.92;
    paths += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${pal.accent}" stroke-width="1.5" opacity="0.6"/>`;
  }

  // Petal/flame shapes
  const flameCount = Math.floor(petals / 2);
  for (let i = 0; i < flameCount; i++) {
    const angle = (i / flameCount) * 360 + innerRot + (180 / flameCount);
    const rad = angle * Math.PI / 180;
    const tipX = cx + Math.cos(rad) * baseR * 0.78;
    const tipY = cy + Math.sin(rad) * baseR * 0.78;
    const base1X = cx + Math.cos(rad + 0.25) * baseR * 0.42;
    const base1Y = cy + Math.sin(rad + 0.25) * baseR * 0.42;
    const base2X = cx + Math.cos(rad - 0.25) * baseR * 0.42;
    const base2Y = cy + Math.sin(rad - 0.25) * baseR * 0.42;
    paths += `<path d="M ${tipX.toFixed(1)},${tipY.toFixed(1)} Q ${(cx+Math.cos(rad+0.6)*baseR*0.6).toFixed(1)},${(cy+Math.sin(rad+0.6)*baseR*0.6).toFixed(1)} ${base1X.toFixed(1)},${base1Y.toFixed(1)} L ${base2X.toFixed(1)},${base2Y.toFixed(1)} Q ${(cx+Math.cos(rad-0.6)*baseR*0.6).toFixed(1)},${(cy+Math.sin(rad-0.6)*baseR*0.6).toFixed(1)} ${tipX.toFixed(1)},${tipY.toFixed(1)} Z" fill="${pal.primary}" opacity="0.18" stroke="${pal.primary}" stroke-width="1"/>`;
  }

  // Central symbol — fox eye / moon glyph
  if (style === "kitsari" || style === "sigil") {
    // Fox eye
    paths += `<ellipse cx="${cx}" cy="${cy}" rx="90" ry="50" fill="${pal.primary}" opacity="0.9"/>`;
    paths += `<ellipse cx="${cx}" cy="${cy}" rx="50" ry="46" fill="#0a0118"/>`;
    paths += `<circle cx="${cx + 12}" cy="${cy - 8}" r="10" fill="${pal.accent}" opacity="0.9"/>`;
  } else if (style === "seal" || style === "emblem") {
    // Lantern shape
    paths += `<rect x="${cx - 45}" y="${cy - 60}" width="90" height="120" rx="12" fill="${pal.primary}" opacity="0.85"/>`;
    paths += `<rect x="${cx - 30}" y="${cy - 42}" width="60" height="84" rx="6" fill="#0a0118"/>`;
    paths += `<rect x="${cx - 3}" y="${cy - 22}" width="6" height="44" fill="${pal.accent}" opacity="0.7"/>`;
    paths += `<rect x="${cx - 22}" y="${cy - 3}" width="44" height="6" fill="${pal.accent}" opacity="0.7"/>`;
  } else if (style === "warning") {
    // Warning triangle
    paths += `<polygon points="${cx},${cy - 90} ${cx - 78},${cy + 45} ${cx + 78},${cy + 45}" fill="${pal.primary}" opacity="0.9"/>`;
    paths += `<polygon points="${cx},${cy - 55} ${cx - 48},${cy + 28} ${cx + 48},${cy + 28}" fill="#0a0118"/>`;
    paths += `<text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="64" font-family="serif" fill="${pal.accent}" opacity="0.9">!</text>`;
  } else {
    // Generic star/cross
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r1 = 80, r2 = 38;
      const x1 = cx + Math.cos(a) * r1, y1 = cy + Math.sin(a) * r1;
      const a2 = a + Math.PI / 8;
      const x2 = cx + Math.cos(a2) * r2, y2 = cy + Math.sin(a2) * r2;
      if (i === 0) paths += `<polygon points="`;
      paths += `${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)} `;
      if (i === 7) paths += `" fill="${pal.primary}" opacity="0.9"/>`;
    }
  }

  // Moon crescent (top right)
  if (hasMoon) {
    paths += `<circle cx="${cx + 240}" cy="${cy - 240}" r="55" fill="${pal.accent}" opacity="0.7"/>`;
    paths += `<circle cx="${cx + 258}" cy="${cy - 248}" r="44" fill="#0a0118"/>`;
  }

  // Decorative runes around the ring
  if (hasRunes) {
    const runeChars = ["⊕", "✦", "◈", "⟡", "⊗", "◉", "✧", "⬡"];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * 360 * Math.PI / 180;
      const rx = cx + Math.cos(angle) * (baseR - 30);
      const ry = cy + Math.sin(angle) * (baseR - 30);
      const char = runeChars[Math.floor(rng(i + 10) * runeChars.length)];
      paths += `<text x="${rx.toFixed(1)}" y="${(ry + 8).toFixed(1)}" text-anchor="middle" font-size="22" fill="${pal.accent}" opacity="0.65" font-family="serif">${char}</text>`;
    }
  }

  // Concept text at bottom (small)
  const label = concept ? concept.slice(0, 24).toUpperCase() : "CELESTIAL YOKAI";
  paths += `<text x="${cx}" y="${cy + baseR + 55}" text-anchor="middle" font-size="28" font-family="'Share Tech Mono', monospace" fill="${pal.accent}" opacity="0.55" letter-spacing="4">${label}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <defs>
    <filter id="glow">
      <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <radialGradient id="bgGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" style="stop-color:#0a0118;stop-opacity:1"/>
      <stop offset="100%" style="stop-color:#030108;stop-opacity:1"/>
    </radialGradient>
  </defs>
  <!-- Background -->
  <rect width="1200" height="1200" fill="url(#bgGrad)"/>
  <!-- Glow layer -->
  <g filter="url(#glow)" opacity="0.6">
    <circle cx="${cx}" cy="${cy}" r="${baseR * 0.55}" fill="${pal.glow}"/>
  </g>
  <!-- Main artwork -->
  ${paths}
</svg>`;
}

// ════════════════════════════════════════════════════════════════════════════
// KITSARI AI COMMERCE ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/agent/kitsari", async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: "Command required." });
  try { res.json({ agent: "kitsari", response: await askKitsari(command.trim()) }); }
  catch (err) { res.status(500).json({ error: "Transmission failed." }); }
});

app.post("/api/commerce/generate-product", async (req, res) => {
  const { productType = "sticker", theme, stickerStyle, nftAngle } = req.body;
  const typeContext = productType === "sticker"
    ? `PRODUCT TYPE: Kiss-cut vinyl sticker\nSTICKER STYLE: ${stickerStyle || "sigil / emblem"}\nFormat: die-cut, suitable for laptop, bottle, journal, NFT merch pack.`
    : productType === "poster"
    ? `PRODUCT TYPE: Art print / poster\nFormat: vertical or square, wall art, collectible.`
    : `PRODUCT TYPE: T-shirt\nFormat: unisex front print, collector appeal.`;

  const prompt = `Generate a complete Celestial Yokai product draft.

${typeContext}
THEME: ${theme || "Kitsari / Lantern District / celestial fox sigil"}
NFT UTILITY: ${nftAngle || "holder-only variant or faction decal"}

Generate EXACTLY this structure:

## PRODUCT NAME
Evocative brand name.

## LORE ANGLE
2-3 sentences of in-universe lore.

## TARGET BUYER
Specific buyer profile.

## ETSY SEO TITLE
Max 140 chars. Front-load keywords. End with "Celestial Yokai" or "Lantern District".

## DESCRIPTION
180-250 words. Hook, lore tie-in, product details, material placeholder, care note.

## 13 ETSY TAGS
tag one, tag two, tag three, tag four, tag five, tag six, tag seven, tag eight, tag nine, tag ten, tag eleven, tag twelve, tag thirteen

## PRICING SUGGESTION
Retail price with reasoning. NFT holder discount.

## PRINTIFY PRODUCT MATCH
Exact Printify product category.

## MOCKUP ART DIRECTION
2-3 sentences on staging for maximum Etsy conversion.

## X LAUNCH POST
Max 280 chars, hook-first, 2-3 hashtags.

## NFT HOLDER UTILITY
Specific benefit: trait variant, holder discount, early access, or secret page.

All content must be original Celestial Yokai IP.`;

  try {
    const aiDraft = await askKitsari(prompt, 2200);
    res.json({ response: aiDraft, productType, status: "ai_draft", publishLocked: true });
  } catch (err) { console.error("[AI] generate-product:", err.message); res.status(500).json({ error: "Draft generation failed." }); }
});

app.post("/api/commerce/product-idea", async (req, res) => {
  const { niche, medium } = req.body;
  const prompt = `Generate 3 original Celestial Yokai product ideas.
Theme: ${niche || "celestial yokai, mystical anime, dark cosmic"}
Type: ${medium || "sticker, poster, or shirt"}
For EACH: Product Name, Product Type, Design Concept (2-3 sentences), Target Buyer, Retail Price, Printify Blueprint, NFT Utility.
Separate with ---. Original IP only.`;
  try { res.json({ response: await askKitsari(prompt, 1800) }); }
  catch (err) { res.status(500).json({ error: "Market spirits unavailable." }); }
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
Post 1: lore | Post 2: product details | Post 3: CTA
## INSTAGRAM CAPTION
150-200 words, 15 hashtags at end.
## 5-DAY DROP SEQUENCE
One beat per day.
## NFT HOLDER EXCLUSIVE
Post for holders only.`;
  try { res.json({ response: await askKitsari(prompt, 2000) }); }
  catch (err) { res.status(500).json({ error: "Signal lost." }); }
});

app.post("/api/commerce/lore-content", async (req, res) => {
  const { topic, platform } = req.body;
  const prompt = `Write lore content for the Celestial Yokai universe.
Topic: ${topic || "Kitsari and the Lantern District Market"}
Platform: ${platform || "X / Twitter"}
## LORE POST
## LORE THREAD (3 posts)
## ENGAGEMENT HOOK
## CAMPAIGN ANGLE`;
  try { res.json({ response: await askKitsari(prompt, 1500) }); }
  catch (err) { res.status(500).json({ error: "Lore keeper unavailable." }); }
});

app.post("/api/commerce/market-scan", async (req, res) => {
  const { category, priceRange } = req.body;
  const prompt = `Analyze market signals for the Celestial Night Market.
Category: ${category || "mystical anime stickers, celestial yokai merch"}
Price: ${priceRange || "$5-$30"}
## MARKET SIGNAL REPORT
## CONTENT GAP
## TOP 3 PRODUCT OPPORTUNITIES
## ETSY SEO KEYWORDS (15)
## NFT CROSSOVER ANGLE
Analyze trends only. Never copy specific sellers.`;
  try { res.json({ response: await askKitsari(prompt, 1800) }); }
  catch (err) { res.status(500).json({ error: "Market scan failed." }); }
});

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
      connected: true, shopName: etsyStore.shopName, shopId: etsyStore.shopId, connectedAt: etsyStore.connectedAt,
      favorites: shop?.num_favorers ?? "—", orders: shop?.transaction_sold_count ?? "—",
      listingCount: shop?.listing_active_count ?? "—", draftCount: drafts?.count ?? 0,
      currency: shop?.currency_code ?? "USD",
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
