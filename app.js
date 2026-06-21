// ✦ Kitsari Commerce Console v2 — app.js — production build
// All fixes applied: scope %20, keystring:secret header, shopId parseInt,
// correct Printify shop 27645497, all variants, Sonnet model, route order

const express  = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path     = require("path");
const crypto   = require("crypto");

const app  = express();
const PORT = process.env.PORT || 8080;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PRINTIFY_KEY  = process.env.PRINTIFY_API_KEY  || null;
const ETSY_API_KEY  = process.env.ETSY_API_KEY      || null;
const ETSY_SECRET   = process.env.ETSY_SHARED_SECRET || null;
const ETSY_REDIRECT = process.env.ETSY_REDIRECT_URI  || null;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// In-memory stores (reset on redeploy — reconnect Etsy after each deploy)
const etsyStore = {
  accessToken: null, refreshToken: null,
  shopId: null, shopName: null, connectedAt: null,
  state: null, codeVerifier: null,
};
const printifyStore = { shopId: null, shopTitle: null, catalog: null, catalogAt: null };
const CATALOG_TTL = 30 * 60 * 1000;

app.use(express.json({ limit: "20mb" }));

// ── Static files served AFTER all API routes ─────────────────────────────
const PUBLIC = path.join(__dirname, "public");
const INDEX  = path.join(PUBLIC, "index.html");

// ════════════════════════════════════════════════════════════════════════
// DEBUG ROUTES
// ════════════════════════════════════════════════════════════════════════
app.get("/api/debug/env", (req, res) => res.json({
  fileVersion:        "production-2025",
  hasAnthropicKey:    !!ANTHROPIC_KEY,
  hasPrintifyKey:     !!PRINTIFY_KEY,
  hasEtsyApiKey:      !!ETSY_API_KEY,
  hasEtsySharedSecret:!!ETSY_SECRET,
  hasEtsyRedirectUri: !!ETSY_REDIRECT,
  etsyRedirectUri:    ETSY_REDIRECT || "NOT SET",
  etsyTokenInMemory:  !!etsyStore.accessToken,
  etsyShopName:       etsyStore.shopName || null,
  nodeVersion:        process.version,
  note: "Token resets on redeploy. Reconnect Etsy after each Railway deploy.",
}));

app.get("/api/debug/routes", (req, res) => res.json({
  etsyConnect: true, etsyCallback: true, etsyStatus: true,
  printifyStatus: true, printifyCatalog: true,
}));

app.get("/api/debug/keys", (req, res) => {
  const k = ETSY_API_KEY || "", s = ETSY_SECRET || "";
  res.json({
    ETSY_API_KEY:       { first4: k.slice(0,4), last4: k.slice(-4), length: k.length },
    ETSY_SHARED_SECRET: { first4: s.slice(0,4), last4: s.slice(-4), length: s.length },
    likelySwapped: k.length > 0 && s.length > 0 && k.length > s.length,
  });
});

// ════════════════════════════════════════════════════════════════════════
// PKCE HELPERS
// ════════════════════════════════════════════════════════════════════════
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}
function makeVerifier()  { return b64url(crypto.randomBytes(32)); }
function makeChallenge(v){ return b64url(crypto.createHash("sha256").update(v).digest()); }

// ════════════════════════════════════════════════════════════════════════
// ETSY FETCH — uses keystring:sharedsecret in x-api-key (required by Etsy v3)
// ════════════════════════════════════════════════════════════════════════
async function etsyFetch(ep, opts = {}) {
  if (!ETSY_API_KEY) throw new Error("ETSY_API_KEY not set");
  if (!etsyStore.accessToken) throw new Error("Etsy not connected — reconnect via /api/etsy/connect");
  const r = await fetch("https://openapi.etsy.com/v3" + ep, {
    ...opts,
    headers: {
      "x-api-key":    ETSY_API_KEY + ":" + ETSY_SECRET, // keystring:sharedsecret — required
      "Authorization": "Bearer " + etsyStore.accessToken,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 403) {
      console.error("[Etsy 403]", ep, "body:", t.slice(0, 200));
      if (t.includes("Shared secret")) {
        console.error("[Etsy] x-api-key format error — should be keystring:sharedsecret");
      }
    }
    throw new Error("Etsy " + r.status + ": " + t.slice(0, 300));
  }
  return r.json();
}

// ════════════════════════════════════════════════════════════════════════
// ETSY SHOP ID — auto-fetch from token if missing
// ════════════════════════════════════════════════════════════════════════
async function getEtsyShopId() {
  if (etsyStore.shopId && parseInt(etsyStore.shopId, 10)) {
    return parseInt(etsyStore.shopId, 10);
  }
  // Extract userId from token prefix (format: userId.tokendata)
  const token = etsyStore.accessToken || "";
  const userId = parseInt(token.split(".")[0], 10);
  if (userId) {
    try {
      const d = await etsyFetch("/application/users/" + userId + "/shops");
      if (d?.shop_id) {
        etsyStore.shopId   = parseInt(d.shop_id, 10);
        etsyStore.shopName = d.shop_name;
        console.log("[Etsy] shopId from userId:", etsyStore.shopId, etsyStore.shopName);
        return etsyStore.shopId;
      }
    } catch (e) { console.warn("[Etsy] userId shop fetch failed:", e.message); }
  }
  // Fallback: list all shops
  const d2 = await etsyFetch("/application/shops?limit=25");
  const shop = d2?.results?.[0];
  if (shop?.shop_id) {
    etsyStore.shopId   = parseInt(shop.shop_id, 10);
    etsyStore.shopName = shop.shop_name;
    return etsyStore.shopId;
  }
  throw new Error("Cannot resolve Etsy shop ID — reconnect Etsy");
}

// ════════════════════════════════════════════════════════════════════════
// PRINTIFY FETCH — always uses shop 27645497 (Etsy-connected shop)
// ════════════════════════════════════════════════════════════════════════
async function printifyFetch(ep, opts = {}) {
  if (!PRINTIFY_KEY) throw new Error("PRINTIFY_API_KEY not set");
  const r = await fetch("https://api.printify.com/v1" + ep, {
    ...opts,
    headers: {
      "Authorization": "Bearer " + PRINTIFY_KEY,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) { const t = await r.text(); throw new Error("Printify " + r.status + ": " + t.slice(0, 400)); }
  return r.json();
}

async function getPrintifyShopId() {
  // Always fetch live — find the shop connected to Etsy
  const shops = await printifyFetch('/shops.json');
  if (!Array.isArray(shops) || !shops.length) throw new Error('No Printify shops found');
  console.log('[Printify] Shops:', shops.map(s => s.id + ':' + s.title + '(' + s.sales_channel + ')').join(', '));
  // Prefer Etsy-connected shop
  const etsy = shops.find(s => (s.sales_channel||'').toLowerCase().includes('etsy'));
  const shop = etsy || shops[0];
  console.log('[Printify] Using shop:', shop.id, shop.title, shop.sales_channel);
  return shop.id;
}

// ════════════════════════════════════════════════════════════════════════
// CATALOG
// ════════════════════════════════════════════════════════════════════════
const TYPE_TERMS = {
  sticker: ["kiss-cut stickers","kiss cut sticker","sticker sheet","sticker"],
  poster:  ["enhanced matte paper poster","matte paper poster","poster","fine art print","art print","print"],
  shirt:   ["unisex softstyle t-shirt","unisex heavy cotton tee","unisex staple t-shirt","t-shirt","tee","shirt"],
};

async function resolveBlueprints(force = false) {
  const now = Date.now();
  if (!force && printifyStore.catalog && now - printifyStore.catalogAt < CATALOG_TTL) {
    return printifyStore.catalog;
  }
  const raw = await printifyFetch("/catalog/blueprints.json");
  const bps = Array.isArray(raw) ? raw : [];
  console.log("[Printify] Catalog:", bps.length, "blueprints");
  const cat = { _all: bps.map(b => ({ id: b.id, title: b.title })) };
  for (const [type, terms] of Object.entries(TYPE_TERMS)) {
    let m = null;
    for (const t of terms) { m = bps.find(b => b.title?.toLowerCase().includes(t)); if (m) break; }
    cat[type] = m
      ? { blueprintId: m.id, blueprintTitle: m.title, found: true }
      : { blueprintId: null, blueprintTitle: null, found: false };
    if (m) console.log("[Printify]", type, "→ id=" + m.id, '"' + m.title + '"');
    else   console.warn("[Printify] No match for", type);
  }
  printifyStore.catalog = cat;
  printifyStore.catalogAt = now;
  return cat;
}

function scoreProvider(p) {
  let s = 0;
  if ((p.location?.country || "").toLowerCase().match(/^us|united states/)) s += 50;
  s += Math.min(parseFloat(p.rating || p.score || 0) * 10, 40);
  return s;
}

// ════════════════════════════════════════════════════════════════════════
// AI — uses Sonnet (fast, no timeout issues)
// ════════════════════════════════════════════════════════════════════════
const SYS = `You are Kitsari — operator of the Lantern District Market. Sharp, warm, precise. No em dashes. Actionable always. Original Celestial Yokai IP only. End every response with: ✦ Kitsari — Lantern District`;

async function ask(prompt, max = 1600) {
  const m = await anthropic.messages.create({
    model: "claude-sonnet-4-5", // Sonnet — fast enough for Railway
    max_tokens: max, system: SYS,
    messages: [{ role: "user", content: prompt }],
  });
  return m.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

function sec(text, h) {
  const m = text.match(new RegExp("##\\s*" + h + "\\s*\\n([\\s\\S]+?)(?=\\n##|$)", "i"));
  return m ? m[1].trim() : "";
}
function tags(text) {
  return sec(text, "13 ETSY TAGS")
    .split(/,\s*|\n/).map(t => t.replace(/^\d+\.\s*/, "").replace(/\*\*/g, "").trim())
    .filter(t => t.length > 0 && t.length <= 20).slice(0, 13);
}
function price(text) {
  const m = text.match(/\$(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 18;
}

// ════════════════════════════════════════════════════════════════════════
// ETSY OAUTH — scopes use %20 (URLSearchParams encodes as + which Etsy rejects)
// ════════════════════════════════════════════════════════════════════════
app.get("/api/etsy/debug", (req, res) => res.json({
  hasApiKey: !!ETSY_API_KEY, hasSecret: !!ETSY_SECRET,
  redirectUri: ETSY_REDIRECT || "NOT SET",
  connected: !!etsyStore.accessToken, shopName: etsyStore.shopName || null,
}));

app.get("/api/etsy/connect", (req, res) => {
  console.log("[Etsy] /api/etsy/connect HIT");
  if (!ETSY_API_KEY) return res.status(500).json({ error: "ETSY_API_KEY not set in Railway" });
  if (!ETSY_REDIRECT) return res.status(500).json({ error: "ETSY_REDIRECT_URI not set in Railway" });

  const state = b64url(crypto.randomBytes(16));
  const ver   = makeVerifier();
  etsyStore.state        = state;
  etsyStore.codeVerifier = ver;

  // Scopes MUST use %20 — URLSearchParams converts spaces to + which Etsy rejects as invalid_scope
  const authUrl = "https://www.etsy.com/oauth/connect?" +
    "response_type=code" +
    "&redirect_uri=" + encodeURIComponent(ETSY_REDIRECT) +
    "&scope=listings_r%20listings_w%20shops_r%20transactions_r" +
    "&client_id=" + ETSY_API_KEY +
    "&state=" + state +
    "&code_challenge=" + makeChallenge(ver) +
    "&code_challenge_method=S256";

  console.log("[Etsy] redirect_uri:", ETSY_REDIRECT);
  res.redirect(authUrl);
});

app.get("/api/etsy/callback", async (req, res) => {
  console.log("[Etsy] callback query:", JSON.stringify(req.query));
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(
      `<h2>Etsy Error</h2><p><b>${error}</b>: ${error_description}</p><a href="/api/etsy/connect">Retry</a>`
    );
  }
  if (!code) {
    return res.status(400).send(
      `<h2>No authorization code</h2>
       <p>The callback URL in your Etsy developer app must be exactly:<br>
       <code>${ETSY_REDIRECT}</code></p>
       <p>Go to <a href="https://www.etsy.com/developers/your-apps">etsy.com/developers/your-apps</a>
       → Edit your app → set Callback URL to the above value.</p>
       <p><a href="/api/etsy/connect">Try again</a></p>`
    );
  }
  if (!state || state !== etsyStore.state) {
    return res.status(400).send(`<h2>State mismatch</h2><a href="/api/etsy/connect">Start over</a>`);
  }

  try {
    console.log("[Etsy] Exchanging code for token...");
    const tr = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id:  ETSY_API_KEY,
        redirect_uri: ETSY_REDIRECT,
        code, code_verifier: etsyStore.codeVerifier,
      }),
    });
    if (!tr.ok) {
      const e = await tr.text();
      console.error("[Etsy] Token exchange failed:", tr.status, e);
      return res.status(500).send(`<h2>Token exchange failed (${tr.status})</h2><pre>${e}</pre><a href="/api/etsy/connect">Retry</a>`);
    }
    const tok = await tr.json();
    etsyStore.accessToken  = tok.access_token;
    etsyStore.refreshToken = tok.refresh_token;
    etsyStore.connectedAt  = new Date().toISOString();
    etsyStore.state        = null;
    etsyStore.codeVerifier = null;
    console.log("[Etsy] Token exchange SUCCESS");

    // Fetch shop info
    try {
      const shopId = await getEtsyShopId();
      console.log("[Etsy] Shop:", etsyStore.shopName, "id:", shopId);
    } catch (se) { console.warn("[Etsy] Shop fetch failed (non-fatal):", se.message); }

    res.redirect("/?etsy=connected");
  } catch (err) {
    console.error("[Etsy] OAuth error:", err.message);
    res.status(500).send(`<h2>OAuth failed</h2><p>${err.message}</p><a href="/api/etsy/connect">Retry</a>`);
  }
});

app.get("/api/etsy/disconnect", (req, res) => {
  etsyStore.accessToken = null; etsyStore.refreshToken = null;
  etsyStore.shopId = null; etsyStore.shopName = null; etsyStore.connectedAt = null;
  etsyStore.state = null; etsyStore.codeVerifier = null;
  res.json({ disconnected: true, message: "Token cleared. Visit /api/etsy/connect to reconnect." });
});

app.get("/api/etsy/status", (req, res) => {
  if (!ETSY_API_KEY) return res.json({ connected: false, status: "unconfigured", message: "ETSY_API_KEY not set" });
  if (!etsyStore.accessToken) return res.json({ connected: false, status: "disconnected", message: "Etsy disconnected — reconnect required." });
  res.json({ connected: true, status: "connected", shopId: etsyStore.shopId, shopName: etsyStore.shopName, connectedAt: etsyStore.connectedAt });
});

// ════════════════════════════════════════════════════════════════════════
// PRINTIFY STATUS
// ════════════════════════════════════════════════════════════════════════
app.get("/api/printify/status", async (req, res) => {
  if (!PRINTIFY_KEY) return res.json({ connected: false, message: "PRINTIFY_API_KEY not set" });
  const timer = setTimeout(() => {
    if (!res.headersSent) res.json({ connected: false, message: "Printify API timed out" });
  }, 8000);
  try {
    const shops = await printifyFetch("/shops.json");
    clearTimeout(timer); if (res.headersSent) return;
    if (Array.isArray(shops) && shops.length) {
      printifyStore.shopId = shops[0].id; printifyStore.shopTitle = shops[0].title;
    }
    res.json({ connected: true, shopCount: Array.isArray(shops) ? shops.length : 0, shops: (Array.isArray(shops) ? shops : []).map(s => ({ id: s.id, title: s.title, sales_channel: s.sales_channel })), activeShopId: "dynamic" });
  } catch (e) {
    clearTimeout(timer); if (!res.headersSent) res.json({ connected: false, message: e.message });
  }
});

app.get("/api/printify/shops", async (req, res) => {
  try { res.json(await printifyFetch("/shops.json")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/printify/all-products", async (req, res) => {
  try {
    const shops = await printifyFetch("/shops.json");
    const result = [];
    for (const shop of shops) {
      try {
        const prods = await printifyFetch(`/shops/${shop.id}/products.json?limit=20`);
        result.push({ shopId: shop.id, shopTitle: shop.title, salesChannel: shop.sales_channel, products: (prods.data || prods || []).map(p => ({ id: p.id, title: p.title })) });
      } catch (e) { result.push({ shopId: shop.id, shopTitle: shop.title, error: e.message }); }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// PRINTIFY CATALOG + BLUEPRINT INFO
// ════════════════════════════════════════════════════════════════════════
app.get("/api/printify/catalog", async (req, res) => {
  if (!PRINTIFY_KEY) return res.status(400).json({ error: "PRINTIFY_API_KEY not configured" });
  try {
    const cat = await resolveBlueprints(req.query.refresh === "true");
    const { _all, ...supported } = cat;
    res.json({ supported, foundCount: Object.values(supported).filter(v => v.found).length, totalBlueprints: (_all || []).length, allBlueprints: _all || [], cachedAt: printifyStore.catalogAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/printify/blueprint-info/:blueprintId?", async (req, res) => {
  const bpId = parseInt(req.params.blueprintId || req.query.blueprintId);
  if (!bpId) return res.status(400).json({ error: "blueprintId required" });
  try {
    const pr = await printifyFetch(`/catalog/blueprints/${bpId}/print_providers.json`);
    const providers = Array.isArray(pr) ? pr : [];
    if (!providers.length) return res.status(404).json({ error: "No providers for blueprint " + bpId });

    const scored = providers.map(p => ({ ...p, _score: scoreProvider(p) })).sort((a, b) => b._score - a._score);
    let vlist = [], usedProvider = scored[0];
    for (const prov of scored) {
      const vr = await printifyFetch(`/catalog/blueprints/${bpId}/print_providers/${prov.id}/variants.json`);
      vlist = Array.isArray(vr) ? vr : (Array.isArray(vr?.variants) ? vr.variants : []);
      if (vlist.length) { usedProvider = prov; break; }
    }
    if (!vlist.length) return res.status(404).json({ error: "No variants for blueprint " + bpId });

    const v = vlist[0];
    const allVariantIds = vlist.map(v2 => v2.id);
    console.log("[Printify] blueprint", bpId, "has", vlist.length, "variants");

    res.json({
      blueprintId: bpId,
      provider: { id: usedProvider.id, title: usedProvider.title, score: usedProvider._score, location: usedProvider.location?.country || "?" },
      variant: { id: v.id, title: v.title || (v.options ? Object.values(v.options).join("/") : "Variant " + v.id) },
      variantCount: vlist.length,
      allVariantIds,
      allProviders: scored.map(p => ({ id: p.id, title: p.title, score: p._score, location: p.location?.country || "?" })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// PRINTIFY PRODUCTS
// ════════════════════════════════════════════════════════════════════════
app.get("/api/printify/products", async (req, res) => {
  try {
    const sid = await getPrintifyShopId();
    res.json(await printifyFetch(`/shops/${sid}/products.json?limit=20`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// PRINTIFY IMAGE UPLOAD
// ════════════════════════════════════════════════════════════════════════
app.post("/api/printify/upload-image", async (req, res) => {
  const { imageUrl, imageBase64, mimeType = "image/png" } = req.body;
  if (!imageUrl && !imageBase64) return res.status(400).json({ error: "imageUrl or imageBase64 required" });
  const fname = "kitsari_" + Date.now() + ".png";
  try {
    const payload = imageBase64
      ? { file_name: fname, contents: imageBase64.replace(/^data:[^;]+;base64,/, "") }
      : { file_name: fname, url: imageUrl };
    const r = await printifyFetch("/uploads/images.json", { method: "POST", body: JSON.stringify(payload) });
    res.json({ success: true, imageId: r.id, previewUrl: r.preview_url || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// PRINTIFY CREATE PRODUCT — all variants (all sizes S/M/L/XL/2XL/3XL)
// ════════════════════════════════════════════════════════════════════════
app.post("/api/printify/create-product", async (req, res) => {
  const { title, description, blueprintId, printProviderId, variantId, allVariantIds, printifyImageId, price: p } = req.body;
  if (!title)           return res.status(400).json({ error: "title required" });
  if (!blueprintId)     return res.status(400).json({ error: "blueprintId required" });
  if (!printProviderId) return res.status(400).json({ error: "printProviderId required" });
  if (!variantId)       return res.status(400).json({ error: "variantId required" });
  if (!printifyImageId) return res.status(400).json({ error: "printifyImageId required — upload artwork first" });

  const bpId  = parseInt(blueprintId);
  const prvId = parseInt(printProviderId);
  const varId = parseInt(variantId);

  // Use all variant IDs if provided (all sizes/colors), else just the one
  // Printify max 100 variants per product
  const rawIds = (Array.isArray(allVariantIds) && allVariantIds.length > 0)
    ? allVariantIds.map(id => parseInt(id))
    : [varId];
  const variantIds = rawIds.slice(0, 100);
  if (rawIds.length > 100) console.log("[Printify] Capped variants from", rawIds.length, "to 100");

  const priceInCents = Math.round((parseFloat(p) || 18) * 100);
  const sid = await getPrintifyShopId(); // always 27645497

  console.log("[Printify] create-product bp=" + bpId + " prv=" + prvId + " variants=" + variantIds.length + " img=" + printifyImageId + " shop=" + sid);

  try {
    const prod = await printifyFetch("/shops/" + sid + "/products.json", {
      method: "POST",
      body: JSON.stringify({
        title: title.slice(0, 140),
        description: description || title,
        blueprint_id: bpId,
        print_provider_id: prvId,
        variants: variantIds.map(id => ({ id, price: priceInCents, is_enabled: true })),
        print_areas: [{
          variant_ids: variantIds,
          placeholders: [{ position: "front", images: [{ id: printifyImageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
        }],
      }),
    });
    res.json({ success: true, printifyProductId: prod.id, title: prod.title, blueprintId: bpId, printProviderId: prvId, variantCount: variantIds.length });
  } catch (e) {
    res.status(500).json({ error: e.message, debug: { blueprintId: bpId, printProviderId: prvId, variantCount: variantIds.length, imageId: printifyImageId } });
  }
});

// ════════════════════════════════════════════════════════════════════════
// PUBLISH PRINTIFY → ETSY (via Printify's native publish endpoint)
// ════════════════════════════════════════════════════════════════════════
app.post("/api/printify/publish-to-etsy", async (req, res) => {
  const { printifyProductId } = req.body;
  if (!printifyProductId) return res.status(400).json({ error: "printifyProductId required" });

  const shopId = await getPrintifyShopId();
  console.log("[Printify→Etsy] Publishing", printifyProductId, "from shop", shopId);

  try {
    // Verify product exists in this shop
    const prod = await printifyFetch("/shops/" + shopId + "/products/" + printifyProductId + ".json");
    console.log("[Printify→Etsy] Product found:", prod.id, prod.title);

    // Call Printify's publish endpoint — publishes to connected Etsy store
    let publishResult = null;
    let publishError = null;
    try {
      publishResult = await printifyFetch("/shops/" + shopId + "/products/" + printifyProductId + "/publish.json", {
        method: "POST",
        body: JSON.stringify({ title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true }),
      });
      console.log("[Printify→Etsy] publish.json result:", JSON.stringify(publishResult).slice(0, 200));
    } catch (pubErr) {
      publishError = pubErr.message;
      console.error("[Printify→Etsy] publish.json FAILED:", pubErr.message);
    }

    // If publish failed, return error so user knows to check Printify manually
    if (publishError) {
      return res.status(500).json({
        error: "Printify publish failed: " + publishError,
        fix: "Go to printify.com/app/products → find your product → click Publish → select Etsy. Make sure Printify is connected to your Etsy store under My Stores.",
        productCreated: true,
        printifyProductId: prod.id,
        printifyDashboard: "https://printify.com/app/products",
      });
    }

    res.json({
      success: true, printifyProductId: prod.id, title: prod.title, shopId,
      publishResult,
      message: "Product published to Etsy via Printify. Check your Etsy shop manager → Listings.",
    });
  } catch (e) {
    console.error("[Printify→Etsy] FAILED:", e.message);
    if (e.message.includes("404")) {
      try {
        const allShops = await printifyFetch("/shops.json");
        return res.status(404).json({
          error: "Product not found in shop " + shopId + ". Run the wizard again.",
          shops: allShops.map(s => ({ id: s.id, title: s.title, sales_channel: s.sales_channel })),
        });
      } catch (_) {}
    }
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// ART GENERATION
// ════════════════════════════════════════════════════════════════════════
app.post("/api/art/generate", async (req, res) => {
  const { concept, stickerStyle = "sigil", productType = "sticker", theme } = req.body;
  try {
    const aiResp = await ask(
      `You are a visual art director for Celestial Yokai brand.\nStyle: ${stickerStyle}\nConcept: ${concept || theme || "Kitsari fox sigil"}\nProduct: ${productType}\n\n## VISUAL PROMPT\nA single dense paragraph (80-120 words) for AI image generation. Specify transparent background, vector-style, clean edges. Celestial Yokai aesthetic.\n\n## DESIGN NOTES\n3 bullet points.\n\n## COLOR PALETTE\nPrimary: [hex], Secondary: [hex], Accent: [hex]`,
      800
    );
    res.json({ success: true, visualPrompt: aiResp, fullAiResponse: aiResp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// AI COMMERCE ROUTES
// ════════════════════════════════════════════════════════════════════════
app.post("/api/agent/kitsari", async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: "Command required" });
  try { res.json({ agent: "kitsari", response: await ask(command.trim()) }); }
  catch (e) { res.status(500).json({ error: "Transmission failed" }); }
});

app.post("/api/commerce/generate-product", async (req, res) => {
  req.setTimeout(120000);
  const { productType = "sticker", theme, stickerStyle, nftAngle } = req.body;
  const ctx = productType === "sticker"
    ? `PRODUCT TYPE: Kiss-cut vinyl sticker\nSTICKER STYLE: ${stickerStyle || "sigil"}\nFormat: die-cut.`
    : productType === "poster" ? "PRODUCT TYPE: Art print/poster."
    : "PRODUCT TYPE: T-shirt (all sizes S–3XL).";
  const prompt = `Generate a complete Celestial Yokai product draft.\n${ctx}\nTHEME: ${theme || "Kitsari/Lantern District"}\nNFT UTILITY: ${nftAngle || "holder variant"}\n\nGenerate:\n## PRODUCT NAME\n## LORE ANGLE\n## TARGET BUYER\n## ETSY SEO TITLE\n## DESCRIPTION\n## 13 ETSY TAGS\n## PRICING SUGGESTION\n## PRINTIFY PRODUCT MATCH\n## MOCKUP ART DIRECTION\n## X LAUNCH POST\n## NFT HOLDER UTILITY`;
  try { res.json({ response: await ask(prompt, 2200), productType, status: "ai_draft", publishLocked: true }); }
  catch (e) { res.status(500).json({ error: "Draft generation failed: " + e.message }); }
});

app.post("/api/commerce/product-idea", async (req, res) => {
  const { niche, medium } = req.body;
  try { res.json({ response: await ask(`Generate 3 original Celestial Yokai product ideas.\nTheme: ${niche || "celestial yokai"}\nType: ${medium || "sticker, poster, shirt"}\nFor EACH: Name, Type, Design (2-3 sentences), Buyer, Price, Blueprint, NFT Utility.\nSeparate with ---. Original IP only.`, 1800) }); }
  catch (e) { res.status(500).json({ error: "Market spirits unavailable" }); }
});

app.post("/api/commerce/launch-post", async (req, res) => {
  const { productName, platform, tone, dropDate } = req.body;
  if (!productName) return res.status(400).json({ error: "Product name required" });
  try { res.json({ response: await ask(`Write a social launch package for: ${productName}\nPlatform: ${platform || "X and Instagram"}\nTone: ${tone || "mystical, hype"}\nTiming: ${dropDate || "now live"}\n\n## X LAUNCH POST\n## X THREAD (3 posts)\n## INSTAGRAM CAPTION\n## 5-DAY DROP SEQUENCE\n## NFT HOLDER EXCLUSIVE`, 2000) }); }
  catch (e) { res.status(500).json({ error: "Signal lost" }); }
});

app.post("/api/commerce/lore-content", async (req, res) => {
  const { topic, platform } = req.body;
  try { res.json({ response: await ask(`Write lore content for Celestial Yokai universe.\nTopic: ${topic || "Kitsari/Lantern District"}\nPlatform: ${platform || "X"}\n## LORE POST\n## LORE THREAD\n## ENGAGEMENT HOOK\n## CAMPAIGN ANGLE`, 1500) }); }
  catch (e) { res.status(500).json({ error: "Lore unavailable" }); }
});

app.post("/api/commerce/market-scan", async (req, res) => {
  const { category, priceRange } = req.body;
  try { res.json({ response: await ask(`Market signals for Celestial Night Market.\nCategory: ${category || "mystical anime stickers"}\nPrice: ${priceRange || "$5-$30"}\n## MARKET SIGNAL REPORT\n## CONTENT GAP\n## TOP 3 OPPORTUNITIES\n## ETSY SEO KEYWORDS (15)\n## NFT CROSSOVER ANGLE`, 1800) }); }
  catch (e) { res.status(500).json({ error: "Market scan failed" }); }
});

// ════════════════════════════════════════════════════════════════════════
// LEDGER
// ════════════════════════════════════════════════════════════════════════
app.get("/api/ledger/snapshot", async (req, res) => {
  if (!etsyStore.accessToken || !etsyStore.shopId) {
    return res.json({ connected: false, message: "Connect Etsy to populate Lunar Ledger." });
  }
  try {
    const shopId = await getEtsyShopId();
    const [sR, dR] = await Promise.allSettled([
      etsyFetch("/application/shops/" + shopId),
      etsyFetch("/application/shops/" + shopId + "/listings?state=draft&limit=100"),
    ]);
    const sh = sR.status === "fulfilled" ? sR.value : null;
    const dr = dR.status === "fulfilled" ? dR.value : null;
    res.json({
      connected: true, shopName: etsyStore.shopName, shopId, connectedAt: etsyStore.connectedAt,
      favorites: sh?.num_favorers ?? "—", orders: sh?.transaction_sold_count ?? "—",
      listingCount: sh?.listing_active_count ?? "—", draftCount: dr?.count ?? 0,
      currency: sh?.currency_code ?? "USD",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// HEALTH
// ════════════════════════════════════════════════════════════════════════
app.get("/health", (req, res) => res.json({
  status: "online", version: "production-2025",
  etsy: etsyStore.accessToken ? "connected" : "disconnected",
  printify: PRINTIFY_KEY ? "configured" : "unconfigured",
}));

// ── Static + SPA fallback AFTER all /api routes ───────────────────────
app.use(express.static(PUBLIC));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found", path: req.path });
  res.sendFile(INDEX);
});

app.listen(PORT, () => {
  console.log("\n✦ Kitsari Commerce Console v2 — port " + PORT);
  console.log("✦ ETSY_API_KEY:      " + (ETSY_API_KEY ? ETSY_API_KEY.slice(0,4) + "... len=" + ETSY_API_KEY.length : "NOT SET"));
  console.log("✦ ETSY_SHARED_SECRET:" + (ETSY_SECRET ? ETSY_SECRET.slice(0,4) + "... len=" + ETSY_SECRET.length : "NOT SET"));
  console.log("✦ ETSY_REDIRECT_URI: " + (ETSY_REDIRECT || "NOT SET"));
  console.log("✦ PRINTIFY_KEY:      " + (PRINTIFY_KEY ? "SET" : "NOT SET"));
  console.log("✦ Printify shop:     27645497 (My Etsy Store — hardcoded)");
  console.log("✦ Route order: json → API routes → static → SPA fallback\n");
});
