// ✦ Kitsari Commerce Console v2.1 — production
const express  = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path     = require("path");
const crypto   = require("crypto");

// ── Pure in-memory stores (fast, zero native deps) ───────────────────────
// Sessions: token → session object
const _sessions  = {};
// Drafts: array of draft objects
const _drafts    = [];
let   _draftId   = 1;
// Rate limits: "discordId:action" → {count, start}
const _rl        = {};
// YC upgrades: "discordId:action" → {expiresAt, txSig, amount}
const _ycUpgrades = {};
// YC sales history: array
const _ycSales   = [];

// db = null means SQLite not available — all functions use in-memory
const db = null;

// ── Session helpers ────────────────────────────────────────────────────────
function dbSessionSet(token, s) { _sessions[token] = s; }
function dbSessionGet(token)    { return _sessions[token] || null; }
function dbSessionDel(token)    { delete _sessions[token]; }
function dbSessionList() {
  return Object.entries(_sessions)
    .filter(([k,v]) => v && v.discordId && !k.startsWith("_state_"))
    .map(([,v]) => ({
      discordId: v.discordId, username: v.username, globalName: v.globalName,
      avatar: v.avatar, isAdmin: !!v.isAdmin, isHolder: !!v.isHolder,
      hasWanderer: !!v.hasWanderer, wallet: v.wallet,
      verifiedAt: v.loggedInAt ? new Date(v.loggedInAt).toISOString() : null,
    }));
}
function dbSessionUpdate(token, fields) {
  if (_sessions[token]) Object.assign(_sessions[token], fields);
}

// ── Draft helpers ──────────────────────────────────────────────────────────
function dbDraftAdd(d) {
  const id = _draftId++;
  _drafts.push({ id, ...d, status: "pending", submittedAt: new Date().toISOString() });
  return id;
}
function dbDraftList(filter) {
  const all = [..._drafts].reverse();
  return filter && filter !== "all" ? all.filter(d => d.status === filter) : all;
}
function dbDraftMine(discordId) {
  return [..._drafts].reverse()
    .filter(d => d.discordId === discordId)
    .map(d => ({ id: d.id, productType: d.productType, concept: d.concept,
      status: d.status, reviewNote: d.reviewNote, submittedAt: d.submittedAt }));
}
function dbDraftUpdate(id, fields) {
  const d = _drafts.find(x => x.id === id);
  if (d) {
    if (fields.reviewNote  !== undefined) d.reviewNote  = fields.reviewNote;
    if (fields.status      !== undefined) d.status      = fields.status;
    if (fields.review_note !== undefined) d.reviewNote  = fields.review_note;
    if (fields.reviewed_at !== undefined) d.reviewedAt  = new Date(fields.reviewed_at).toISOString();
  }
}

// ── Rate limiting ──────────────────────────────────────────────────────────
const RATE_WINDOW = 60000;
const RATE_LIMITS = { chat:{free:10,yc:30}, meme:{free:3,yc:10}, draft:{free:5,yc:20}, imggen:{free:2,yc:8} };
const YC_PRICES   = { chat:100000, draft:50000, meme:50000, imggen:100000 };
const YC_MINT     = "7bPUfM26oCHkVLXNpDR7dgwmGoTiaTsaK2uPSAHUpump";
const BURN_WALLET = "HCjg9usafd2QcecA5KacRJg98AzeM5ExafUEA5LVp2ah";
const YC_UPGRADE_DAYS = 30;

function hasYCUpgrade(discordId, action) {
  const key = discordId + ":" + action;
  const u = _ycUpgrades[key];
  return u && u.expiresAt > Date.now();
}

function checkRate(discordId, action, hasYC = false) {
  if (!hasYC && discordId) hasYC = hasYCUpgrade(discordId, action);
  const lim = RATE_LIMITS[action] || { free:5, yc:15 };
  const max = hasYC ? lim.yc : lim.free;
  const key = (discordId || "anon") + ":" + action;
  const now = Date.now();
  const r   = _rl[key];
  if (!r || now - r.start > RATE_WINDOW) { _rl[key] = { count:1, start:now }; return { allowed:true, count:1, max }; }
  if (r.count >= max) return { allowed:false, count:r.count, max };
  r.count++;
  return { allowed:true, count:r.count, max };
}

// ── YC verification (Solana) ────────────────────────────────────────────
const SOLANA_RPC = process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";
async function verifyYCTransaction(txSig, requiredAmount) {
  try {
    const resp = await fetch(SOLANA_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"getTransaction",
        params:[txSig, { encoding:"jsonParsed", commitment:"confirmed", maxSupportedTransactionVersion:0 }] }),
    });
    const data = await resp.json();
    const tx = data?.result;
    if (!tx) return { valid:false, error:"Transaction not found or not confirmed" };
    if (tx.meta?.err) return { valid:false, error:"Transaction failed on-chain" };
    const preB = tx.meta?.preTokenBalances  || [];
    const posB = tx.meta?.postTokenBalances || [];
    let burnReceived = 0, senderWallet = null;
    for (const post of posB) {
      if (post.mint !== YC_MINT) continue;
      const pre = preB.find(p => p.accountIndex === post.accountIndex);
      const gained = parseInt(post.uiTokenAmount?.amount||"0") - parseInt(pre?.uiTokenAmount?.amount||"0");
      if (gained > 0 && post.owner === BURN_WALLET) burnReceived += gained;
    }
    for (const pre of preB) {
      if (pre.mint !== YC_MINT) continue;
      const post = posB.find(p => p.accountIndex === pre.accountIndex);
      if (parseInt(pre.uiTokenAmount?.amount||"0") > parseInt(post?.uiTokenAmount?.amount||"0")) {
        senderWallet = pre.owner; break;
      }
    }
    const burnHuman = burnReceived / 1e6;
    if (burnHuman < requiredAmount) return { valid:false, error:"Got "+burnHuman.toLocaleString()+" YC, need "+requiredAmount.toLocaleString()+" YC." };
    return { valid:true, amountHuman:burnHuman, amountRaw:burnReceived, senderWallet };
  } catch (e) { return { valid:false, error:"Verification failed: "+e.message }; }
}

// ── OpenAI / DALL-E (optional) ────────────────────────────────────────────
let openai = null;
try {
  const { OpenAI } = require("openai");
  const key = process.env.OPENAI_API_KEY;
  if (key) { openai = new OpenAI({ apiKey: key }); console.log("[OpenAI] DALL-E ready"); }
  else console.warn("[OpenAI] OPENAI_API_KEY not set — image generation disabled");
} catch(e) { console.warn("[OpenAI] Package not available:", e.message); }
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
const INDEX  = path.join(PUBLIC, "console.html");

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
const SYS = `You are Kitsari, guardian of the Lantern District Market and first spirit of the Celestial Yokais universe. Sharp, warm, precise. No em dashes. Always actionable. Celestial Yokais is a Web3 IP on Solana — 1,000 Kitsari fox NFTs launching on GraveMint.io. Yokai Coin (YC) is the ecosystem token earned through staking on GraveStake.io. Holders are Wanderers. Philosophy: Join the Veil. End every response with: ✦ Kitsari — Lantern District`;

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
  const { productType = "sticker", theme, stickerStyle, nftAngle, hasYC = false } = req.body;
  const sess = getSession(req);
  if (sess?.discordId) {
    const rl = checkRate(sess.discordId, "draft", hasYC);
    if (!rl.allowed) return res.status(429).json({
      error: "Draft limit reached (" + rl.count + "/" + rl.max + " per minute).",
      upgrade: "Spend 5 YC to unlock 20 drafts/minute. Coming soon.",
      retryAfter: 60
    });
  }
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

// ════════════════════════════════════════════════════════════════════════
// HOLDER AUTH — Discord OAuth2 + role check + Solana NFT ownership
// Add to app.js after existing routes, before static/SPA fallback
// ════════════════════════════════════════════════════════════════════════

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || "1518077281665286324";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "4GSQyUpYybtUBrED1Nary0WbXefkQqad";
const DISCORD_GUILD_ID      = process.env.DISCORD_GUILD_ID      || "1489281154522677280";
const DISCORD_WANDERER_ROLE = process.env.DISCORD_WANDERER_ROLE_ID || "1504725209087869009";
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  || "https://celestial-yokai-habitats-production.up.railway.app/api/auth/discord/callback";
const DISCORD_ADMIN_ID      = process.env.DISCORD_ADMIN_ID || "834262283826757663"; // also set in Railway vars
const KITSARI_CONTRACT      = process.env.KITSARI_CONTRACT       || "AtYGtFGHHkqBURkXrLkurUfLo929mhU2hmtUznfri1rg";
const HELIUS_RPC            = process.env.HELIUS_RPC             || "https://api.mainnet-beta.solana.com";

// Simple in-memory session store — also persists to SQLite when available
const holderSessions = {}; // token → session object
const draftQueue     = []; // legacy compat — drafts go to SQLite
const SESSION_TTL    = 7 * 24 * 60 * 60 * 1000; // 7 days

// Wrap set/get to also sync SQLite
function sessSet(token, sess) {
  holderSessions[token] = sess;
  try { dbSessionSet(token, sess); } catch(e) {}
}
function sessDel(token) {
  delete holderSessions[token];
  try { dbSessionDel(token); } catch(e) {}
}
function sessGet(token) {
  // Try memory first
  if (holderSessions[token]) return { ...holderSessions[token], token };
  // Fall back to SQLite (e.g. after restart)
  try {
    const s = dbSessionGet(token);
    if (s) { holderSessions[token] = s; return s; }
  } catch(e) {}
  return null;
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || "";
  h.split(";").forEach(p => {
    const idx = p.indexOf("=");
    if (idx > 0) out[p.slice(0, idx).trim()] = decodeURIComponent(p.slice(idx + 1).trim());
  });
  return out;
}
function getSession(req) {
  const cookies = parseCookies(req);
  const auth = req.headers["authorization"] || "";
  const token = auth.replace("Bearer ", "").trim() || cookies["kitsari_sess"] || req.query._sess;
  if (!token || token.startsWith("_state_")) return null;
  const sess = sessGet(token);
  if (!sess) return null;
  if (Date.now() - (sess.loggedInAt||0) > SESSION_TTL) { sessDel(token); return null; }
  return sess;
}
function requireHolder(req, res, next) {
  const sess = getSession(req);
  if (!sess || !sess.isHolder) return res.status(401).json({ error: "Holder login required", loginUrl: "/api/auth/discord/connect" });
  req.session = sess;
  next();
}
function requireAdmin(req, res, next) {
  const sess = getSession(req);
  if (!sess || !sess.isAdmin) return res.status(403).json({ error: "Admin only" });
  req.session = sess;
  next();
}

// ── Check Discord guild member roles ──────────────────────────────────
async function getDiscordMemberRoles(userId, accessToken) {
  const r = await fetch(
    `https://discord.com/api/v10/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
    { headers: { Authorization: "Bearer " + accessToken } }
  );
  if (!r.ok) {
    const t = await r.text();
    console.warn("[Discord] Member fetch failed:", r.status, t.slice(0, 200));
    return [];
  }
  const m = await r.json();
  return m.roles || [];
}

// ── Check Solana NFT ownership via Helius DAS API ─────────────────────
async function checkSolanaNFTOwnership(walletAddress) {
  if (!walletAddress) return { holds: false, count: 0 };
  try {
    // Use Helius DAS getAssetsByOwner to check if wallet holds any Kitsari NFT
    const rpcUrl = HELIUS_RPC.includes("helius")
      ? HELIUS_RPC
      : "https://api.mainnet-beta.solana.com";

    const body = {
      jsonrpc: "2.0", id: 1,
      method: "getAssetsByOwner",
      params: {
        ownerAddress: walletAddress,
        page: 1, limit: 1000,
        displayOptions: { showFungible: false, showNativeBalance: false },
      },
    };
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    const assets = d?.result?.items || [];
    // Check if any asset's grouping matches our collection contract
    const kitsariAssets = assets.filter(a => {
      const groupings = a.grouping || [];
      return groupings.some(g =>
        g.group_key === "collection" &&
        g.group_value === KITSARI_CONTRACT
      );
    });
    console.log("[Solana] Wallet", walletAddress, "holds", kitsariAssets.length, "Kitsari NFTs");
    return { holds: kitsariAssets.length > 0, count: kitsariAssets.length };
  } catch (e) {
    console.error("[Solana] NFT check failed:", e.message);
    return { holds: false, count: 0, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════════
// DISCORD OAUTH ROUTES
// ════════════════════════════════════════════════════════════════════════

// Step 1 — redirect to Discord
app.get("/api/auth/discord/connect", (req, res) => {
  if (!DISCORD_CLIENT_ID) return res.status(500).json({ error: "DISCORD_CLIENT_ID not set" });
  if (!DISCORD_CLIENT_SECRET) return res.status(500).json({ error: "DISCORD_CLIENT_SECRET not set" });
  if (!DISCORD_REDIRECT_URI) return res.status(500).json({ error: "DISCORD_REDIRECT_URI not set" });

  const state = crypto.randomBytes(16).toString("hex");
  // Store state briefly (5 min) to prevent CSRF
  holderSessions["_state_" + state] = { createdAt: Date.now() };

  const url = "https://discord.com/oauth2/authorize" +
    "?client_id=" + DISCORD_CLIENT_ID +
    "&response_type=code" +
    "&redirect_uri=" + encodeURIComponent(DISCORD_REDIRECT_URI) +
    "&scope=identify%20guilds.members.read" +
    "&state=" + state;

  res.redirect(url);
});

// Step 2 — callback from Discord
app.get("/api/auth/discord/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect("/?auth=error&reason=" + encodeURIComponent(error));
  if (!code)  return res.redirect("/?auth=error&reason=no_code");

  // Validate state (loose — just check it existed)
  const stateKey = "_state_" + state;
  if (!holderSessions[stateKey]) {
    console.warn("[Discord Auth] State not found:", state);
    // Don't block — state may have been cleaned up
  }
  delete holderSessions[stateKey];

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  DISCORD_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      const e = await tokenRes.text();
      console.error("[Discord Auth] Token exchange failed:", tokenRes.status, e);
      return res.redirect("/?auth=error&reason=token_exchange_failed");
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Get Discord user info
    const userRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!userRes.ok) return res.redirect("/?auth=error&reason=user_fetch_failed");
    const user = await userRes.json();

    console.log("[Discord Auth] User:", user.id, user.username);

    // Check guild membership + roles
    const roles = await getDiscordMemberRoles(user.id, accessToken);
    const hasWanderer = roles.includes(DISCORD_WANDERER_ROLE);
    const isAdmin = DISCORD_ADMIN_ID ? user.id === DISCORD_ADMIN_ID : false;

    console.log("[Discord Auth] Roles:", roles.length, "hasWanderer:", hasWanderer, "isAdmin:", isAdmin);

    // Issue session — wallet linkage happens separately
    const sessionToken = makeSessionToken();
    const sessData = {
      discordId:   user.id,
      username:    user.username,
      globalName:  user.global_name || user.username,
      avatar:      user.avatar ? "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png" : null,
      isHolder:    hasWanderer || isAdmin,
      isAdmin:     isAdmin,
      hasWanderer: hasWanderer,
      wallet:      null,
      nftVerified: false,
      loggedInAt:  Date.now(),
    };

    console.log("[Discord Auth] Session for:", user.username, "| id:", user.id, "| isAdmin:", isAdmin, "| isHolder:", sessData.isHolder);

    const cookieOpts = "; Path=/; Max-Age=604800; SameSite=Lax; HttpOnly";

    if (!hasWanderer && !isAdmin) {
      sessData.isHolder = false;
      sessSet(sessionToken, sessData);
      res.setHeader("Set-Cookie", "kitsari_sess=" + sessionToken + cookieOpts);
      return res.redirect("/holder?auth=not_holder");
    }

    sessSet(sessionToken, sessData);
    res.setHeader("Set-Cookie", "kitsari_sess=" + sessionToken + cookieOpts);
    res.redirect("/holder?auth=success");
  } catch (err) {
    console.error("[Discord Auth] Error:", err.message);
    res.redirect("/?auth=error&reason=" + encodeURIComponent(err.message));
  }
});

// ── Link wallet (optional — for on-chain NFT verification) ────────────
app.post("/api/auth/link-wallet", requireHolder, async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: "walletAddress required" });

  const nftCheck = await checkSolanaNFTOwnership(walletAddress);
  const sess = getSession(req);
  if (sess) {
    sess.wallet      = walletAddress;
    sess.nftVerified = nftCheck.holds;
    sess.nftCount    = nftCheck.count;
  }

  res.json({
    walletAddress,
    nftVerified: nftCheck.holds,
    nftCount:    nftCheck.count,
    message: nftCheck.holds
      ? "Verified — " + nftCheck.count + " Kitsari NFT(s) confirmed"
      : "No Kitsari NFTs found in this wallet. Discord Wanderer role still grants access.",
  });
});

// ── Session check ─────────────────────────────────────────────────────
app.get("/api/auth/me", (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.json({ loggedIn: false });
  res.json({
    loggedIn:    true,
    discordId:   sess.discordId,
    username:    sess.username,
    globalName:  sess.globalName,
    avatar:      sess.avatar,
    isHolder:    sess.isHolder,
    isAdmin:     sess.isAdmin,
    hasWanderer: sess.hasWanderer,
    wallet:      sess.wallet,
    nftVerified: sess.nftVerified,
    nftCount:    sess.nftCount,
  });
});

// ── Logout ────────────────────────────────────────────────────────────
app.post("/api/auth/logout", (req, res) => {
  const sess = getSession(req);
  if (sess) sessDel(sess.token);
  res.setHeader("Set-Cookie", "kitsari_sess=; Path=/; Max-Age=0");
  res.json({ loggedOut: true });
});
app.get("/api/auth/logout", (req, res) => {
  const sess = getSession(req);
  if (sess) sessDel(sess.token);
  res.setHeader("Set-Cookie", "kitsari_sess=; Path=/; Max-Age=0");
  res.redirect("/holder");
});

// ════════════════════════════════════════════════════════════════════════
// DRAFT SUBMISSION QUEUE (holders submit, admin approves)
// ════════════════════════════════════════════════════════════════════════

let draftIdCounter = 1;

// Submit a draft for review
app.post("/api/drafts/submit", requireHolder, (req, res) => {
  const sess = req.session;
  if (!sess.isHolder) return res.status(403).json({ error: "Holder access required" });

  const { aiDraft, productType, productTitle, notes, blueprintId, printProviderId, variantId, allVariantIds, printifyImageId } = req.body;
  if (!aiDraft) return res.status(400).json({ error: "aiDraft required" });

  const draft = {
    id:              draftIdCounter++,
    submittedAt:     new Date().toISOString(),
    submittedBy:     sess.discordId,
    submitterName:   sess.globalName || sess.username,
    submitterAvatar: sess.avatar,
    status:          "pending",  // pending | approved | rejected
    reviewedAt:      null,
    reviewNote:      null,
    aiDraft,
    productType:     productType || "sticker",
    productTitle:    productTitle || "",
    notes:           notes || "",
    // Printify data if they went through the wizard
    blueprintId:     blueprintId || null,
    printProviderId: printProviderId || null,
    variantId:       variantId || null,
    allVariantIds:   allVariantIds || [],
    printifyImageId: printifyImageId || null,
  };

  draftQueue.push(draft);
  console.log("[Draft Queue] New submission #" + draft.id + " from", sess.username, "-", productType);

  res.json({
    success: true,
    draftId: draft.id,
    message: "Draft submitted for review. Kitsari will review and approve it shortly.",
    position: draftQueue.filter(d => d.status === "pending").length,
  });
});

// Get holder's own submissions
app.get("/api/drafts/mine", requireHolder, (req, res) => {
  const mine = draftQueue
    .filter(d => d.submittedBy === req.session.discordId)
    .map(d => ({
      id: d.id, submittedAt: d.submittedAt, status: d.status,
      productType: d.productType, productTitle: d.productTitle,
      reviewNote: d.reviewNote, reviewedAt: d.reviewedAt,
    }));
  res.json({ drafts: mine, total: mine.length });
});

// ── ADMIN: View full queue ────────────────────────────────────────────
app.get("/api/admin/drafts", requireAdmin, (req, res) => {
  const { status } = req.query;
  const list = status ? draftQueue.filter(d => d.status === status) : draftQueue;
  res.json({ drafts: list.slice().reverse(), total: list.length }); // newest first
});

// ── ADMIN: Approve a draft ────────────────────────────────────────────
app.post("/api/admin/drafts/:id/approve", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const draft = draftQueue.find(d => d.id === id);
  if (!draft) return res.status(404).json({ error: "Draft not found" });
  if (draft.status !== "pending") return res.status(400).json({ error: "Draft already reviewed" });

  const { note, autoPublish } = req.body;
  draft.status     = "approved";
  draft.reviewedAt = new Date().toISOString();
  draft.reviewNote = note || "Approved by admin.";

  console.log("[Admin] Approved draft #" + id + " from", draft.submitterName);

  // If they completed the wizard and autoPublish is requested
  if (autoPublish && draft.printifyImageId && draft.blueprintId) {
    try {
      // Create the Printify product and publish
      const shopId = await getPrintifyShopId();
      const priceInCents = 1800;
      const variantIds = (draft.allVariantIds && draft.allVariantIds.length > 0
        ? draft.allVariantIds.map(v => parseInt(v))
        : [parseInt(draft.variantId)]
      ).slice(0, 100);

      const prod = await printifyFetch("/shops/" + shopId + "/products.json", {
        method: "POST",
        body: JSON.stringify({
          title: draft.productTitle.slice(0, 140) || "Celestial Yokai " + draft.productType,
          description: draft.aiDraft.slice(0, 1000),
          blueprint_id: parseInt(draft.blueprintId),
          print_provider_id: parseInt(draft.printProviderId),
          variants: variantIds.map(id => ({ id, price: priceInCents, is_enabled: true })),
          print_areas: [{ variant_ids: variantIds, placeholders: [{ position: "front", images: [{ id: draft.printifyImageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] }],
        }),
      });
      draft.printifyProductId = prod.id;
      draft.status = "published";
      console.log("[Admin] Auto-published draft #" + id + " → Printify", prod.id);
      return res.json({ success: true, draftId: id, status: "published", printifyProductId: prod.id });
    } catch (e) {
      console.error("[Admin] Auto-publish failed:", e.message);
      return res.json({ success: true, draftId: id, status: "approved", publishError: e.message });
    }
  }

  res.json({ success: true, draftId: id, status: "approved" });
});

// ── ADMIN: Reject a draft ────────────────────────────────────────────
app.post("/api/admin/drafts/:id/reject", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const draft = draftQueue.find(d => d.id === id);
  if (!draft) return res.status(404).json({ error: "Draft not found" });

  const { note } = req.body;
  draft.status     = "rejected";
  draft.reviewedAt = new Date().toISOString();
  draft.reviewNote = note || "Not approved at this time.";

  console.log("[Admin] Rejected draft #" + id, "-", note);
  res.json({ success: true, draftId: id, status: "rejected" });
});

// ── ADMIN: Stats ──────────────────────────────────────────────────────
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json({
    totalSessions: Object.keys(holderSessions).filter(k => !k.startsWith("_state_")).length,
    activeSessions: Object.values(holderSessions).filter(s => s.discordId && Date.now() - s.loggedInAt < SESSION_TTL).length,
    draftQueue: {
      total:    draftQueue.length,
      pending:  draftQueue.filter(d => d.status === "pending").length,
      approved: draftQueue.filter(d => d.status === "approved").length,
      rejected: draftQueue.filter(d => d.status === "rejected").length,
      published:draftQueue.filter(d => d.status === "published").length,
    },
  });
});

// ── Protect wizard routes behind holder auth ───────────────────────────
// Wrap commerce + printify creation routes so non-holders get 401
const PROTECTED_PATHS = [
  "/api/commerce/generate-product",
  "/api/printify/create-product",
  "/api/printify/upload-image",
  "/api/printify/publish-to-etsy",
];
PROTECTED_PATHS.forEach(path => {
  app._router.stack = app._router.stack; // no-op, gate applied via middleware below
});

// Insert auth check before protected routes
app.use(PROTECTED_PATHS, (req, res, next) => {
  const sess = getSession(req);
  if (!sess || !sess.isHolder) {
    return res.status(401).json({
      error: "Holder login required to use the Product Forge.",
      loginUrl: "/api/auth/discord/connect",
    });
  }
  req.session = sess;
  next();
});


// ── Static + SPA fallback AFTER all /api routes ───────────────────────
// ── Holder portal routes ─────────────────────────────────────────────
const HOLDER_HTML = path.join(PUBLIC, 'holder.html');
app.get('/holder', (req, res) => res.sendFile(HOLDER_HTML));
app.get('/holder/login', (req, res) => res.sendFile(HOLDER_HTML));

// Admin: Active sessions
app.get('/api/admin/sessions', requireAdmin, (req, res) => {
  const active = [];
  for (const [token, sess] of Object.entries(holderSessions)) {
    if (!token.startsWith('_state_') && sess.discordId) {
      active.push({
        username: sess.username, discordId: sess.discordId,
        isAdmin: sess.isAdmin, isHolder: sess.isHolder,
        hasWanderer: sess.hasWanderer, wallet: sess.wallet,
        nftVerified: sess.nftVerified, verifiedAt: new Date(sess.loggedInAt).toISOString(),
      });
    }
  }
  res.json({ count: active.length, sessions: active });
});

// ════════════════════════════════════════════════════════════════════════
// BULLETIN BOARD — public feed of approved/pending holder submissions
// ════════════════════════════════════════════════════════════════════════
app.get("/api/bulletin", (req, res) => {
  const public_items = dbDraftList("all")
    .filter(d => d.status === "pending" || d.status === "approved")
    .slice(0, 30)
    .map(d => ({

      id:          d.id,
      submitterName: d.submitterName || "Anonymous Yokai",
      productType: d.productType,
      concept:     d.concept || "",
      status:      d.status,
      submittedAt: d.submittedAt,
      reviewNote:  d.status === "approved" ? d.reviewNote : null,
    }));
  res.json({ items: public_items, total: draftQueue.length });
});

// ════════════════════════════════════════════════════════════════════════
// KITSARI AI CHAT — holder feature
// Supports: general chat, x posts, product drafts, design ideas, lore
// ════════════════════════════════════════════════════════════════════════
const KITSARI_PERSONA = `You are Kitsari — the first celestial fox spirit of the Celestial Yokais universe and guardian of the Lantern District Market. You speak with warmth, mystical wisdom, and sharp wit. No em dashes ever.

ABOUT CELESTIAL YOKAIS:
Celestial Yokais is an original Web3 intellectual property and expanding digital universe built on the Solana blockchain that combines storytelling, community building, education, ownership, and long-term ecosystem utility. The ecosystem will ultimately consist of eight unique Yokai species, each inhabiting their own Celestial Realm and contributing to the larger mythology. The core philosophy is "Join the Veil" — entering a hidden world beyond ordinary perception where creativity, technology, and community intersect. The project believes Web3 should empower people to become builders rather than passive consumers.

ABOUT KITSARI:
Kitsari is the first species: a fox-inspired celestial guardian spirit representing wisdom, curiosity, companionship, adaptability, and exploration. Kitsari is a collection of 1,000 NFTs launching on GraveMint.io. Rather than a simple profile picture project, Kitsari is designed as a digital companion that evolves alongside its holder. Holders (called Wanderers) are active participants who help build, learn, create, and shape the project's future.

ECOSYSTEM & TECHNOLOGY:
- Blockchain: Solana (speed, affordability, scalability)
- Minting: GraveMint.io
- Staking: GraveStake.io — holders stake Kitsari NFTs to earn Yokai Coin (YC)
- Yokai Coin (YC): The native ecosystem token — stake YC to earn more YC. Used for future species launches, raffles, exclusive events, merchandise, and expanding utilities
- Trait Shop (in development): Holders can swap traits and customize their Kitsari NFTs
- Future: Additional species each with own lore, realms, abilities, and cross-species interactions

ROADMAP PRIORITIES:
Educational initiatives, builder resources, hackathons, tournaments, collaborative events, AI integrations, merchandise, gaming concepts, and community-driven storytelling. The long-term mission is a recognizable Web3 brand spanning digital collectibles, storytelling, gaming, education, AI, and merchandise — proven sustainable through genuine value creation, transparent development, and strong community relationships.

YOUR ROLE:
Help Wanderers with: project lore and worldbuilding, product ideas and merchandise concepts, X/Twitter posts with Celestial Yokai energy, meme ideas, design direction, questions about the ecosystem, and educational content about Web3 and Solana. Always be specific and actionable. Reference ecosystem details naturally.

Always end every response with: ✦ Kitsari — Lantern District`;

async function kitsariChat(messages, max = 1200) {
  const result = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: max,
    system: KITSARI_PERSONA,
    messages,
  });
  return result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

app.post("/api/holder/chat", requireHolder, async (req, res) => {
  req.setTimeout(90000);
  const { message, history = [], mode = "chat", hasYC = false } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Message required" });
  const sess = getSession(req);
  const rl = checkRate(sess?.discordId || "anon", "chat", hasYC);
  if (!rl.allowed) return res.status(429).json({
    error: "Rate limit reached (" + rl.count + "/" + rl.max + " per minute).",
    upgrade: "Spend 10 YC to unlock 30 messages/minute. Coming soon.",
    retryAfter: 60
  });

  const systemAddons = {
    xpost:   "\nFocus: Generate X (Twitter) posts. Make them punchy, mystical, community-focused. Include relevant hashtags like #CelestialYokai #Solana #NFT.",
    product: "\nFocus: Help generate product ideas and drafts for Kitsari merchandise. Be specific about design direction, target buyer, and Etsy SEO.",
    design:  "\nFocus: Help with visual design concepts, color palettes, and art direction for Celestial Yokai products.",
    lore:    "\nFocus: Help build and expand the Celestial Yokai lore, worldbuilding, character backstories, and ecosystem narrative.",
    meme:    "\nFocus: Generate meme concepts for Celestial Yokai content. Describe the meme format, text overlay, and vibe clearly.",
  };

  const messages = [
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: message + (systemAddons[mode] || "") },
  ];

  try {
    const reply = await kitsariChat(messages);
    res.json({ reply, mode });
  } catch (e) {
    res.status(500).json({ error: "Kitsari is unavailable: " + e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// MEME GENERATOR — generates 4 meme concepts for uploaded Kitsari NFT
// Uses Claude vision to analyze the NFT then generate meme directions
// ════════════════════════════════════════════════════════════════════════
app.post("/api/holder/generate-memes", requireHolder, async (req, res) => {
  req.setTimeout(120000);
  const { imageBase64, mimeType = "image/png", nftName = "Kitsari NFT", hasYC = false } = req.body;
  const sess = getSession(req);
  const rl = checkRate(sess?.discordId || "anon", "meme", hasYC);
  if (!rl.allowed) return res.status(429).json({
    error: "Meme forge limit reached (" + rl.count + "/" + rl.max + " per minute).",
    upgrade: "Spend 5 YC to unlock 10 memes/minute. Coming soon.",
    retryAfter: 60
  });
  if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

  try {
    // Step 1: Analyze the NFT with Claude vision
    const analysis = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType, data: imageBase64 },
          },
          {
            type: "text",
            text: `Analyze this Kitsari NFT image carefully. Describe:
1. The fox character's expression and pose
2. Key visual traits (colors, accessories, outfit, background)
3. The overall vibe/mood (fierce, mysterious, playful, regal, etc.)
4. Any notable details that make this NFT unique

Be specific and concise. This analysis will be used to generate memes.`,
          },
        ],
      }],
    });
    const nftAnalysis = analysis.content[0].text;

    // Step 2: Generate 4 distinct meme concepts
    const memePrompt = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1600,
      system: `You are a meme strategist for the Celestial Yokai NFT community. 
Generate meme concepts that CELEBRATE and ENHANCE the NFT — never distort, mock, or alter the character's appearance.
Each meme should overlay text or context AROUND the NFT image, not ON the character itself.
Keep the Kitsari character as the hero of each meme.`,
      messages: [{
        role: "user",
        content: `NFT: ${nftName}
Analysis: ${nftAnalysis}

Generate exactly 4 DIFFERENT meme concepts for this Kitsari NFT.
Each must use a different meme format and different emotion/vibe.

For EACH meme, output in this exact format:
---MEME [N]---
FORMAT: [meme template name, e.g. "Drake meme", "Distracted boyfriend", "This is fine", "Change my mind", custom]
VIBE: [one word: hype / mysterious / relatable / flex / funny / legendary]
TOP TEXT: [text that goes above or before the NFT image — keep it short]
BOTTOM TEXT: [text that goes below or after the image — the punchline]
CAPTION: [social post caption with hashtags]
WHY IT WORKS: [one sentence on why this lands for the Celestial Yokai community]
---END---

Make each meme distinct. Reference specific traits from the NFT analysis.`,
      }],
    });

    const rawMemes = memePrompt.content[0].text;

    // Parse the 4 memes
    const memes = [];
    const memeBlocks = rawMemes.split(/---MEME \d+---/).filter(b => b.trim());
    for (const block of memeBlocks) {
      const get = (key) => {
        const m = block.match(new RegExp(key + ":\\s*(.+)"));
        return m ? m[1].trim() : "";
      };
      memes.push({
        format:   get("FORMAT"),
        vibe:     get("VIBE"),
        topText:  get("TOP TEXT"),
        botText:  get("BOTTOM TEXT"),
        caption:  get("CAPTION"),
        why:      get("WHY IT WORKS"),
      });
    }

    res.json({
      success: true,
      nftAnalysis,
      memes: memes.slice(0, 4),
      note: "Images are your original NFT — overlay the text above/below to create each meme.",
    });
  } catch (e) {
    res.status(500).json({ error: "Meme generation failed: " + e.message });
  }
});


// ════════════════════════════════════════════════════════════════════════
// YC UPGRADE SYSTEM — on-chain verification + sales tracking + burn
// ════════════════════════════════════════════════════════════════════════

// Get upgrade status and pricing for the current holder
app.get("/api/holder/yc-status", requireHolder, (req, res) => {
  const sess = getSession(req);
  const now  = Date.now();
  const actions = ["chat","draft","meme","imggen"];
  const status = {};
  for (const action of actions) {
    const upgraded = hasYCUpgrade(sess.discordId, action);
    let expiresAt = null;
    if (upgraded) {
      const u = _ycUpgrades[sess.discordId + ":" + action];
      expiresAt = u ? new Date(u.expiresAt).toISOString() : null;
    }
    status[action] = {
      upgraded,
      expiresAt,
      freeLimit: RATE_LIMITS[action]?.free || 5,
      ycLimit:   RATE_LIMITS[action]?.yc   || 15,
      ycPrice:   YC_PRICES[action] || 50000,
    };
  }
  res.json({
    discordId:   sess.discordId,
    burnWallet:  BURN_WALLET,
    ycMint:      YC_MINT,
    upgradeDays: YC_UPGRADE_DAYS,
    status,
  });
});

// Verify a YC payment transaction and activate upgrade
app.post("/api/holder/yc-upgrade", requireHolder, async (req, res) => {
  const { txSig, action } = req.body;
  if (!txSig || !action) return res.status(400).json({ error: "txSig and action required" });
  if (!YC_PRICES[action]) return res.status(400).json({ error: "Invalid action: " + action });

  const sess     = getSession(req);
  const required = YC_PRICES[action];

  // Check if this tx was already used
  const alreadyUsed = _ycSales.find(s => s.txSig === txSig);
  if (alreadyUsed) return res.status(400).json({ error: "This transaction has already been used." });

  // Verify on Solana
  const verification = await verifyYCTransaction(txSig, required);
  if (!verification.valid) return res.status(400).json({ error: verification.error });

  const now       = Date.now();
  const expiresAt = now + (YC_UPGRADE_DAYS * 24 * 60 * 60 * 1000);

  // Record upgrade in memory
  _ycUpgrades[sess.discordId + ":" + action] = { expiresAt, txSig, amountHuman: verification.amountHuman };

  // Record sale
  _ycSales.push({
    id: _ycSales.length + 1, discordId: sess.discordId, username: sess.username||"Unknown",
    action, ycAmount: verification.amountHuman, txSig, walletFrom: verification.senderWallet||null,
    burnWallet: BURN_WALLET, soldAt: new Date(now).toISOString(), month: new Date(now).toISOString().slice(0,7),
  });

  const labels = { chat:"Chat (30/min)", draft:"Draft Gen (20/min)", meme:"Meme Forge (10/min)", imggen:"Image Gen (8/min)" };
  console.log("[YC] Upgrade activated:", sess.username, action, verification.amountHuman, "YC");

  res.json({
    success:    true,
    action,
    label:      labels[action] || action,
    ycAmount:   verification.amountHuman,
    expiresAt:  new Date(expiresAt).toISOString(),
    message:    "Upgrade active for 30 days. " + (labels[action]||action) + " unlocked.",
  });
});

// ── ADMIN: YC Sales History ──────────────────────────────────────────────
app.get("/api/admin/yc-sales", requireAdmin, (req, res) => {
  const sales = [..._ycSales].reverse().map(r => ({
    id:          r.id,
    discordId:   r.discordId,
    username:    r.username,
    action:      r.action,
    ycAmount:    r.ycAmount,
    txSig:       r.txSig,
    walletFrom:  r.walletFrom,
    burnWallet:  r.burnWallet,
    soldAt:      r.soldAt,
    month:       r.month||r.soldAt?.slice(0,7),
  }));

  // Monthly burn summary
  const monthMap = {};
  for (const s of sales) {
    if (!monthMap[s.month]) monthMap[s.month] = { month:s.month, totalYC:0, txCount:0, burnWallet:BURN_WALLET };
    monthMap[s.month].totalYC  += s.ycAmount;
    monthMap[s.month].txCount  += 1;
  }
  const burnSummary = Object.values(monthMap).sort((a,b)=>b.month.localeCompare(a.month));

  const totalYC = sales.reduce((sum,s)=>sum+s.ycAmount, 0);
  const totals  = {
    allTime:    totalYC,
    thisMonth:  burnSummary[0]?.totalYC || 0,
    txCount:    sales.length,
    burnWallet: BURN_WALLET,
    ycMint:     YC_MINT,
  };

  res.json({ sales, totals, burnSummary });
});

// CSV export for burn reporting
app.get("/api/admin/yc-sales/csv", requireAdmin, (req, res) => {
  const sales = [..._ycSales].reverse();
  const header = "ID,Discord ID,Username,Action,YC Amount,TX Signature,Wallet From,Burn Wallet,Date\n";
  const rows = sales.map(r => [
    r.id, r.discordId, r.username, r.action,
    r.ycAmount, r.txSig, r.walletFrom||"", r.burnWallet, r.soldAt
  ].map(v=>'"'+String(v)+'"').join(",")).join("\n");
  res.setHeader("Content-Type","text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="yc-sales-'+new Date().toISOString().slice(0,10)+'.csv"');
  res.send(header + rows);
});


// ════════════════════════════════════════════════════════════════════════
// DALL-E 3 MEME IMAGE GENERATION
// ════════════════════════════════════════════════════════════════════════
app.post("/api/holder/generate-meme-images", requireHolder, async (req, res) => {
  req.setTimeout(180000);
  if (!openai) {
    return res.status(503).json({ error: "Image generation not configured. Add OPENAI_API_KEY to Railway variables." });
  }

  const { memes, nftAnalysis, nftName = "Kitsari NFT", hasYC = false } = req.body;
  if (!memes || !memes.length) return res.status(400).json({ error: "memes array required" });

  const sess = getSession(req);
  const rl = checkRate(sess?.discordId || "anon", "imggen", hasYC);
  if (!rl.allowed) {
    return res.status(429).json({
      error: "Image generation limit reached (" + rl.count + "/" + rl.max + " per minute).",
      upgrade: "Spend 100K YC to unlock 8/minute.",
      retryAfter: 60
    });
  }

  const results = [];
  for (let i = 0; i < Math.min(memes.length, 4); i++) {
    const meme = memes[i];
    // Keep prompt focused and under 1000 chars — avoids SDK pattern validation errors
    const prompt = (
      "Celestial Yokai universe illustration. Dark anime aesthetic, deep purple and gold palette, night market atmosphere. " +
      "Meme format: " + (meme.format || "image macro") + ". " +
      "Vibe: " + (meme.vibe || "mystical") + ". " +
      "Scene: " + (nftAnalysis ? nftAnalysis.slice(0, 200) : "fox spirit in mystic robes") + ". " +
      "Leave clear negative space at top and bottom for text overlays. " +
      "No text in image. Square composition. Original artwork only."
    ).slice(0, 900);

    try {
      const resp = await openai.images.generate({
        model: "dall-e-3",
        prompt,
        n: 1,
        size: "1024x1024",
      });
      results.push({
        index: i, meme,
        imageUrl: resp.data[0].url,
        success: true,
      });
      console.log("[DALL-E] Image", i + 1, "generated OK");
    } catch (e) {
      console.error("[DALL-E] Image", i + 1, "failed:", e.message);
      results.push({ index: i, meme, error: e.message, success: false });
    }
  }

  res.json({
    success: true,
    images: results,
    generated: results.filter(r => r.success).length,
    total: Math.min(memes.length, 4),
    note: "Images expire after 1 hour — download them promptly. Overlay your NFT on top of each scene.",
  });
});

// ── Page routes ───────────────────────────────────
const HOME_HTML    = path.join(PUBLIC, 'home.html');
const CONSOLE_HTML = path.join(PUBLIC, 'console.html');
app.get("/home",    (req, res) => res.sendFile(HOME_HTML));
app.get("/console", (req, res) => res.sendFile(CONSOLE_HTML));

app.use(express.static(PUBLIC, { index: false })); // disable auto index.html so home.html is the root
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found", path: req.path });
  res.sendFile(HOME_HTML); // home is now the landing page
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
