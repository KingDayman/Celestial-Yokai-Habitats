// ✦ KITSARI COMMERCE CONSOLE v2 — app.js
// Route order: json → API routes → static → SPA fallback → listen
// If you can read this at /api/debug/env, Railway is running THIS file.

const express   = require("express");
const Anthropic  = require("@anthropic-ai/sdk");
const path       = require("path");
const crypto     = require("crypto");

const app  = express();
const PORT = process.env.PORT || 8080;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PRINTIFY_KEY  = process.env.PRINTIFY_API_KEY  || null;
const ETSY_API_KEY  = process.env.ETSY_API_KEY       || null;
const ETSY_SECRET   = process.env.ETSY_SHARED_SECRET || null;
const ETSY_REDIRECT = process.env.ETSY_REDIRECT_URI  || null;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

const etsyStore = {
  accessToken: null, refreshToken: null,
  shopId: null, shopName: null, connectedAt: null,
  state: null, codeVerifier: null,
};
const printifyStore = { shopId: null, shopTitle: null, catalog: null, catalogFetchedAt: null };
const CATALOG_TTL_MS = 30 * 60 * 1000;

// ── 1. JSON body parser ───────────────────────────────────────────────────────
app.use(express.json({ limit: "20mb" }));

// ── 2. ALL API ROUTES ─────────────────────────────────────────────────────────

// Debug
app.get("/api/debug/env", (req, res) => res.json({
  fileVersion:        "app.js-2025-clean",
  hasAnthropicKey:    !!ANTHROPIC_KEY,
  hasPrintifyKey:     !!PRINTIFY_KEY,
  hasEtsyApiKey:      !!ETSY_API_KEY,
  hasEtsySharedSecret:!!ETSY_SECRET,
  hasEtsyRedirectUri: !!ETSY_REDIRECT,
  etsyRedirectUri:    ETSY_REDIRECT || "NOT SET",
  etsyTokenInMemory:  !!etsyStore.accessToken,
  etsyShopName:       etsyStore.shopName || null,
  nodeVersion:        process.version,
  memoryNote:         "Token resets on every redeploy. Reconnect Etsy after each Railway deploy.",
}));

app.get("/api/debug/etsy-headers", (req, res) => {
  // Shows first/last 4 chars only — safe to share, never exposes full secret
  const mask = v => v ? v.slice(0,4) + "..." + v.slice(-4) + " (len=" + v.length + ")" : "NOT SET";
  res.json({
    ETSY_API_KEY_preview:      mask(ETSY_API_KEY),
    ETSY_SHARED_SECRET_preview:mask(ETSY_SECRET),
    etsyTokenPreview:          mask(etsyStore.accessToken),
    hasAll:                    !!(ETSY_API_KEY && ETSY_SECRET && etsyStore.accessToken),
    note: "x-api-key header uses ETSY_API_KEY (the keystring). ETSY_SHARED_SECRET is NOT used in request headers.",
  });
});

app.get("/api/debug/keys", (req, res) => {
  // Etsy keystring: typically looks like 'aaaabbbbcccc...' alphanumeric, ~24 chars
  // Etsy shared secret: longer, ~32 chars, may contain hyphens
  const k = ETSY_API_KEY    || '';
  const s = ETSY_SECRET     || '';
  res.json({
    ETSY_API_KEY:    { first4: k.slice(0,4), last4: k.slice(-4), length: k.length, hasHyphens: k.includes('-') },
    ETSY_SHARED_SECRET: { first4: s.slice(0,4), last4: s.slice(-4), length: s.length, hasHyphens: s.includes('-') },
    likelySwapped: k.length > 0 && s.length > 0 && k.length > s.length,
    note: 'Etsy keystring is usually shorter (~24 chars, no hyphens). Shared secret is longer (~32 chars, may have hyphens).',
  });
});

app.get("/api/debug/routes", (req, res) => res.json({
  fileRunning:              "app.js",
  etsyConnectRouteExists:   true,
  etsyCallbackRouteExists:  true,
  etsyStatusRouteExists:    true,
  printifyStatusRouteExists:true,
}));

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function b64url(buf) { return buf.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,""); }
function makeVerifier()  { return b64url(crypto.randomBytes(32)); }
function makeChallenge(v){ return b64url(crypto.createHash("sha256").update(v).digest()); }

// ── Etsy fetch ────────────────────────────────────────────────────────────────
async function etsyFetch(ep, opts={}) {
  if (!etsyStore.accessToken) throw new Error("Etsy not connected — reconnect via /api/etsy/connect");
  if (!ETSY_API_KEY) throw new Error("ETSY_API_KEY not set in Railway env vars");
  // TEMP FULL KEY LOG — remove after fixing 403
  console.log("[etsyFetch] ep=" + ep + " x-api-key=" + ETSY_API_KEY + " token-start=" + (etsyStore.accessToken||" ").slice(0,12));
  const r = await fetch("https://openapi.etsy.com/v3" + ep, {
    ...opts,
    headers: {
      "x-api-key":     ETSY_API_KEY + ":" + ETSY_SECRET,  // Etsy v3: keystring:sharedsecret
      "Authorization": "Bearer " + etsyStore.accessToken,
      "Content-Type":  "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 403) {
      console.error("[Etsy 403] endpoint=" + ep);
      console.error("[Etsy 403] ETSY_API_KEY: " + (ETSY_API_KEY||"").slice(0,4) + "... len=" + (ETSY_API_KEY||"").length);
      console.error("[Etsy 403] ETSY_SHARED_SECRET: " + (ETSY_SECRET||"").slice(0,4) + "... len=" + (ETSY_SECRET||"").length);
      console.error("[Etsy 403] body: " + t.slice(0,300));
      if (t.includes("Shared secret")) {
        console.error("[Etsy 403] *** KEYS ARE SWAPPED IN RAILWAY — ETSY_API_KEY contains the shared secret value ***");
      }
    }
    throw new Error("Etsy " + r.status + ": " + t.slice(0, 300));
  }
  return r.json();
}

// ── Printify fetch ────────────────────────────────────────────────────────────
async function printifyFetch(ep, opts={}) {
  if (!PRINTIFY_KEY) throw new Error("PRINTIFY_API_KEY not set");
  const r = await fetch(`https://api.printify.com/v1${ep}`, {
    ...opts,
    headers: { "Authorization": `Bearer ${PRINTIFY_KEY}`, "Content-Type": "application/json", ...(opts.headers||{}) },
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Printify ${r.status}: ${t.slice(0,400)}`); }
  return r.json();
}

async function getPrintifyShopId() {
  // Always use the Etsy-connected Printify shop (id=27645497, title="My Etsy Store")
  // This is the only shop with sales_channel="etsy" — products created here
  // automatically sync to Etsy when published via Printify.
  const ETSY_SHOP_ID = 27645497;
  if (printifyStore.shopId === ETSY_SHOP_ID) return ETSY_SHOP_ID;
  printifyStore.shopId   = ETSY_SHOP_ID;
  printifyStore.shopTitle = "My Etsy Store";
  console.log("[Printify] Using Etsy-connected shop id=" + ETSY_SHOP_ID);
  return ETSY_SHOP_ID;
}

// ── Catalog ───────────────────────────────────────────────────────────────────
const TYPE_TERMS = {
  sticker:["kiss-cut stickers","kiss cut sticker","kiss-cut sticker","sticker sheet","sticker"],
  poster: ["enhanced matte paper poster","matte paper poster","poster","fine art print","art print","print"],
  shirt:  ["unisex softstyle t-shirt","unisex heavy cotton tee","unisex staple t-shirt","unisex t-shirt","t-shirt","tee","shirt"],
};

async function resolveBlueprints(force=false) {
  const now = Date.now();
  if (!force && printifyStore.catalog && now - printifyStore.catalogFetchedAt < CATALOG_TTL_MS) return printifyStore.catalog;
  const raw = await printifyFetch("/catalog/blueprints.json");
  const bps = Array.isArray(raw) ? raw : [];
  console.log(`[Printify] Catalog: ${bps.length} blueprints`);
  bps.forEach(b => console.log(`  ${b.id}: "${b.title}"`));
  const cat = { _all: bps.map(b=>({id:b.id,title:b.title})) };
  for (const [type, terms] of Object.entries(TYPE_TERMS)) {
    let m = null;
    for (const t of terms) { m = bps.find(b=>b.title?.toLowerCase().includes(t)); if (m) break; }
    cat[type] = m ? {blueprintId:m.id,blueprintTitle:m.title,found:true} : {blueprintId:null,blueprintTitle:null,found:false};
    if (m) console.log(`[Printify] ${type} → id=${m.id} "${m.title}"`);
    else   console.warn(`[Printify] No match for "${type}"`);
  }
  printifyStore.catalog = cat;
  printifyStore.catalogFetchedAt = now;
  return cat;
}

function scoreProvider(p) {
  let s = 0;
  if ((p.location?.country||"").toLowerCase().match(/^us|united states/)) s += 50;
  s += Math.min(parseFloat(p.rating||p.score||0)*10, 40);
  return s;
}

// ── Kitsari AI ────────────────────────────────────────────────────────────────
const SYS = `You are Kitsari — operator of the Lantern District Market, a nine-tailed celestial fox spirit who has mastered Etsy commerce, Printify print-on-demand, NFT utility design, and brand alchemy.
PERSONALITY: Sharp, warm, precise, playful. No em dashes. Actionable always.
COMPLIANCE: Never copy existing sellers, copyrighted designs, or trademarks. Original Celestial Yokai IP only.
NFT UTILITY: Holder discounts, trait variants, early access, secret pages where relevant.
FORMAT: Markdown. End every response with: ✦ Kitsari — Lantern District`;

async function ask(prompt, max=1600) {
  const m = await anthropic.messages.create({ model:"claude-opus-4-5", max_tokens:max, system:SYS, messages:[{role:"user",content:prompt}] });
  return m.content.filter(b=>b.type==="text").map(b=>b.text).join("\n");
}

function sec(text, h) { const m=text.match(new RegExp(`##\\s*${h}\\s*\\n([\\s\\S]+?)(?=\\n##|$)`,"i")); return m?m[1].trim():""; }
function tags(text) { return sec(text,"13 ETSY TAGS").split(/,\s*|\n/).map(t=>t.replace(/^\d+\.\s*/,"").replace(/\*\*/g,"").trim()).filter(t=>t.length>0&&t.length<=20).slice(0,13); }
function price(text) { const m=text.match(/\$(\d+(?:\.\d+)?)/); return m?parseFloat(m[1]):18; }


// Always returns a valid integer Etsy shop ID, fetching it live if not cached
async function getEtsyShopId() {
  if (etsyStore.shopId && parseInt(etsyStore.shopId, 10)) {
    return parseInt(etsyStore.shopId, 10);
  }
  // The access token starts with the numeric user_id: "12345678.xxxxx"
  // Use getMe endpoint which returns both user_id and shop_id
  console.log("[Etsy] Resolving shop ID via /application/users/me...");
  const me = await etsyFetch("/application/users/me");
  console.log("[Etsy] getMe response:", JSON.stringify(me).slice(0, 300));
  const userId = me?.user_id;
  const shopId = me?.shop_id || me?.shop?.shop_id;
  if (shopId) {
    etsyStore.shopId   = parseInt(shopId, 10);
    etsyStore.shopName = me?.shop?.shop_name || me?.login_name;
    console.log("[Etsy] shopId from getMe:", etsyStore.shopId);
    return etsyStore.shopId;
  }
  // Fallback: use user_id to look up their shop
  if (userId) {
    console.log("[Etsy] Fetching shop by userId:", userId);
    const shopData = await etsyFetch("/application/users/" + userId + "/shops");
    console.log("[Etsy] shop by userId response:", JSON.stringify(shopData).slice(0, 300));
    const sid = shopData?.shop_id || shopData?.results?.[0]?.shop_id;
    if (sid) {
      etsyStore.shopId   = parseInt(sid, 10);
      etsyStore.shopName = shopData?.shop_name || shopData?.results?.[0]?.shop_name;
      console.log("[Etsy] shopId resolved via userId:", etsyStore.shopId);
      return etsyStore.shopId;
    }
  }
  throw new Error("Cannot resolve Etsy shop ID. getMe=" + JSON.stringify(me).slice(0,200));
}

// ════════════════════════════════════════════════════════════════════════════
// ETSY OAUTH
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/etsy/debug", (req, res) => res.json({
  hasApiKey:!!ETSY_API_KEY, hasSecret:!!ETSY_SECRET,
  redirectUri:ETSY_REDIRECT||"NOT SET",
  connected:!!etsyStore.accessToken, shopName:etsyStore.shopName||null,
}));

app.get("/api/etsy/connect", (req, res) => {
  console.log("✅ /api/etsy/connect HIT");
  if (!ETSY_API_KEY) return res.status(500).json({ error: "Missing ETSY_API_KEY — add to Railway env vars" });
  if (!ETSY_REDIRECT) return res.status(500).json({ error: "Missing ETSY_REDIRECT_URI — add to Railway env vars" });

  const state = b64url(crypto.randomBytes(16));
  const ver   = makeVerifier();
  etsyStore.state        = state;
  etsyStore.codeVerifier = ver;

  const params = new URLSearchParams({
    response_type:         "code",
    redirect_uri:          ETSY_REDIRECT,
    scope:                 "listings_r listings_w shops_r transactions_r",
    client_id:             ETSY_API_KEY,
    state,
    code_challenge:        makeChallenge(ver),
    code_challenge_method: "S256",
  });

  const authUrl = "https://www.etsy.com/oauth/connect?" + params.toString();
  console.log("[Etsy] Redirecting — redirect_uri=" + ETSY_REDIRECT);
  res.redirect(authUrl);
});

app.get("/api/etsy/callback", async (req, res) => {
  console.log("[Etsy] callback query:", JSON.stringify(req.query));
  const {code, state, error, error_description} = req.query;
  if (error) return res.status(400).send(`<h2>Etsy Error</h2><p>${error}: ${error_description}</p><a href="/api/etsy/connect">Retry</a>`);
  if (!code) {
    console.error('[Etsy] No code — Etsy did not return a code. Check callback URL in Etsy developer portal.');
    console.error('[Etsy] Expected callback URL: ' + ETSY_REDIRECT);
    console.error('[Etsy] Query received: ' + JSON.stringify(req.query));
    return res.status(400).send(`<!DOCTYPE html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><style>body{font-family:monospace;background:#030108;color:#e8c97a;padding:2rem;line-height:1.8}code{background:#1a0d30;padding:2px 6px;border-radius:3px;color:#c084fc;word-break:break-all}a{color:#67e8f9}h2{color:#ff6b6b}</style></head><body>
<h2>⚠ Etsy OAuth: No Authorization Code</h2>
<p>Etsy redirected back without a code. This means the <strong>Callback URL</strong> in your Etsy app doesn't match.</p>
<p><strong>Your Etsy app's Callback URL must be set to exactly:</strong></p>
<p><code>${ETSY_REDIRECT}</code></p>
<p><strong>Steps to fix:</strong></p>
<ol>
<li>Go to <a href=https://www.etsy.com/developers/your-apps target=_blank>etsy.com/developers/your-apps</a></li>
<li>Click your app → <strong>Edit</strong></li>
<li>Set Callback URLs to: <code>${ETSY_REDIRECT}</code></li>
<li>Save, then <a href=/api/etsy/connect>try connecting again</a></li>
</ol>
<p>Query params received: <code>${JSON.stringify(req.query)}</code></p>
</body></html>`);
  }
  if (!state||state!==etsyStore.state) return res.status(400).send(`<h2>State mismatch</h2><a href="/api/etsy/connect">Start over</a>`);
  try {
    const tr = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"authorization_code",client_id:ETSY_API_KEY,redirect_uri:ETSY_REDIRECT,code,code_verifier:etsyStore.codeVerifier}),
    });
    if (!tr.ok) { const e=await tr.text(); console.error("[Etsy] token exchange failed:",e); return res.status(500).send(`<h2>Token Exchange Failed (${tr.status})</h2><pre>${e}</pre><a href="/api/etsy/connect">Retry</a>`); }
    const tok = await tr.json();
    etsyStore.accessToken  = tok.access_token;
    etsyStore.refreshToken = tok.refresh_token;
    etsyStore.connectedAt  = new Date().toISOString();
    etsyStore.state = null; etsyStore.codeVerifier = null;
    console.log("[Etsy] token exchange SUCCESS");
    try {
      const sd = await etsyFetch("/application/shops?limit=1");
      if (sd?.results?.[0]) { etsyStore.shopId=parseInt(sd.results[0].shop_id,10); etsyStore.shopName=sd.results[0].shop_name; }
      console.log(`[Etsy] shop: ${etsyStore.shopName}`);
    } catch(e) { console.warn("[Etsy] shop fetch failed (non-fatal):", e.message); }
    res.redirect("/?etsy=connected");
  } catch(e) { console.error("[Etsy] callback error:", e.message); res.status(500).send(`<h2>OAuth Failed</h2><p>${e.message}</p><a href="/api/etsy/connect">Retry</a>`); }
});

app.get("/api/etsy/status", (req, res) => {
  if (!ETSY_API_KEY) return res.json({connected:false,status:"unconfigured",message:"ETSY_API_KEY not set."});
  if (!etsyStore.accessToken) return res.json({connected:false,status:"disconnected",message:"Etsy disconnected — reconnect required."});
  res.json({connected:true,status:"connected",shopId:etsyStore.shopId,shopName:etsyStore.shopName,connectedAt:etsyStore.connectedAt,warning:"Token is in-memory — resets on redeploy."});
});

app.get("/api/etsy/disconnect", (req, res) => {
  console.log("[Etsy] Disconnecting — clearing token from memory");
  etsyStore.accessToken  = null;
  etsyStore.refreshToken = null;
  etsyStore.shopId       = null;
  etsyStore.shopName     = null;
  etsyStore.connectedAt  = null;
  etsyStore.state        = null;
  etsyStore.codeVerifier = null;
  res.json({ disconnected: true, message: "Token cleared. Visit /api/etsy/connect to reconnect." });
});

app.get("/api/etsy/shop", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({error:"Etsy not connected."});
  try {
    if (!etsyStore.shopId) { const d=await etsyFetch("/application/shops?limit=1"); if(d?.results?.[0]){etsyStore.shopId=parseInt(d.results[0].shop_id,10);etsyStore.shopName=d.results[0].shop_name;} }
    const sid = await getEtsyShopId(); res.json(await etsyFetch(`/application/shops/${sid}`));
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/etsy/listings", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({error:"Etsy not connected."});
  try { const lsid = await getEtsyShopId(); res.json(await etsyFetch(`/application/shops/${lsid}/listings?state=${req.query.state||"active"}&limit=${Math.min(parseInt(req.query.limit)||25,100)}`)); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/etsy/create-draft", async (req, res) => {
  if (!etsyStore.accessToken) return res.status(401).json({error:"Etsy not connected."});
  const {title,description,tags:t,price:p,type} = req.body;
  if (!title||!description) return res.status(400).json({error:"Title and description required."});
  try {
    const shopIdInt = await getEtsyShopId();
    const l = await etsyFetch(`/application/shops/${shopIdInt}/listings`, {method:"POST",body:JSON.stringify({quantity:999,title:title.slice(0,140),description,price:parseFloat(p)||18,who_made:"i_did",when_made:"made_to_order",taxonomy_id:2078,type:type||"download",tags:(t||[]).slice(0,13),state:"draft"})});
    res.json({success:true,listingId:l.listing_id,url:l.url,state:"draft"});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// PRINTIFY ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/printify/status", async (req, res) => {
  if (!PRINTIFY_KEY) return res.json({connected:false,message:"PRINTIFY_API_KEY not set."});
  const timer = setTimeout(()=>{ if(!res.headersSent) res.json({connected:false,message:"Printify timed out."}); },8000);
  try {
    const shops = await printifyFetch("/shops.json");
    clearTimeout(timer);
    if (res.headersSent) return;
    if (Array.isArray(shops)&&shops.length) { printifyStore.shopId=shops[0].id; printifyStore.shopTitle=shops[0].title; }
    res.json({connected:true,shopCount:Array.isArray(shops)?shops.length:0,shops:Array.isArray(shops)?shops.map(s=>({id:s.id,title:s.title})):[],activeShopId:printifyStore.shopId});
  } catch(e) { clearTimeout(timer); if(!res.headersSent) res.json({connected:false,message:e.message}); }
});

app.get("/api/printify/shops", async (req, res) => {
  try { res.json(await printifyFetch("/shops.json")); } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/printify/catalog", async (req, res) => {
  if (!PRINTIFY_KEY) return res.status(400).json({error:"PRINTIFY_API_KEY not configured."});
  try {
    const cat = await resolveBlueprints(req.query.refresh==="true");
    const {_all,...supported} = cat;
    res.json({supported,foundCount:Object.values(supported).filter(v=>v.found).length,totalBlueprints:(_all||[]).length,allBlueprints:_all||[],cachedAt:printifyStore.catalogFetchedAt});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/printify/blueprint-info/:blueprintId?", async (req, res) => {
  const bpId = parseInt(req.params.blueprintId||req.query.blueprintId);
  if (!bpId) return res.status(400).json({error:"blueprintId required"});
  try {
    const pr = await printifyFetch(`/catalog/blueprints/${bpId}/print_providers.json`);
    const providers = Array.isArray(pr)?pr:[];
    if (!providers.length) return res.status(404).json({error:`No providers for blueprint ${bpId}`});
    const scored = providers.map(p=>({...p,_score:scoreProvider(p)})).sort((a,b)=>b._score-a._score);
    let best=scored[0], vlist=[], used=best;
    for (const prov of scored) {
      const vr = await printifyFetch(`/catalog/blueprints/${bpId}/print_providers/${prov.id}/variants.json`);
      vlist = Array.isArray(vr)?vr:(Array.isArray(vr?.variants)?vr.variants:[]);
      if (vlist.length){used=prov;break;}
    }
    if (!vlist.length) return res.status(404).json({error:"No variants for blueprint " + bpId});
    const v = vlist[0];
    const allVariantIds = vlist.map(v2 => v2.id);
    const vTitle = v.title || (v.options ? Object.values(v.options).join("/") : "Variant " + v.id);
    console.log("[Printify] blueprint", bpId, "has", vlist.length, "variants — all will be enabled");
    res.json({
      blueprintId: bpId,
      provider: {id:used.id, title:used.title, score:used._score, location:used.location?.country||"?"},
      variant: {id:v.id, title:vTitle},
      variantCount: vlist.length,
      allVariantIds,
      allProviders: scored.map(p=>({id:p.id, title:p.title, score:p._score, location:p.location?.country||"?"}))
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/printify/products", async (req, res) => {
  try { const sid=await getPrintifyShopId(); res.json(await printifyFetch(`/shops/${sid}/products.json?limit=20&page=1`)); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// Search ALL shops for all products — use this to find where products ended up
app.get("/api/printify/all-products", async (req, res) => {
  try {
    const shops = await printifyFetch("/shops.json");
    const result = [];
    for (const shop of shops) {
      try {
        const prods = await printifyFetch(`/shops/${shop.id}/products.json?limit=20`);
        result.push({ shopId: shop.id, shopTitle: shop.title, products: (prods.data||prods||[]).map(p=>({id:p.id,title:p.title,created:p.created_at})) });
      } catch(e) { result.push({ shopId: shop.id, shopTitle: shop.title, error: e.message }); }
    }
    res.json(result);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/printify/upload-image", async (req, res) => {
  const {imageUrl,imageBase64,mimeType="image/png"} = req.body;
  if (!imageUrl&&!imageBase64) return res.status(400).json({error:"imageUrl or imageBase64 required"});
  const fname = `kitsari_${Date.now()}.png`;
  try {
    const payload = imageBase64 ? {file_name:fname,contents:imageBase64.replace(/^data:[^;]+;base64,/,"")} : {file_name:fname,url:imageUrl};
    const r = await printifyFetch("/uploads/images.json",{method:"POST",body:JSON.stringify(payload)});
    res.json({success:true,imageId:r.id,previewUrl:r.preview_url||null});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/printify/create-product", async (req, res) => {
  const {title,description,blueprintId,printProviderId,variantId,allVariantIds,printifyImageId,price:p} = req.body;
  if (!title)           return res.status(400).json({error:"title required"});
  if (!blueprintId)     return res.status(400).json({error:"blueprintId required"});
  if (!printProviderId) return res.status(400).json({error:"printProviderId required"});
  if (!variantId)       return res.status(400).json({error:"variantId required"});
  if (!printifyImageId) return res.status(400).json({error:"printifyImageId required — upload artwork first"});
  const bpId = parseInt(blueprintId);
  const prvId = parseInt(printProviderId);
  const varId = parseInt(variantId);
  // Use all variant IDs if provided (all sizes/colors), else fall back to single
  const variantIds = (Array.isArray(allVariantIds) && allVariantIds.length > 0)
    ? allVariantIds.map(id => parseInt(id))
    : [varId];
  const priceInCents = Math.round((parseFloat(p) || 18) * 100);
  console.log("[Printify] create-product bp=" + bpId + " prv=" + prvId + " variants=" + variantIds.length + " img=" + printifyImageId);
  try {
    const sid = await getPrintifyShopId();
    const prod = await printifyFetch("/shops/" + sid + "/products.json", {
      method: "POST",
      body: JSON.stringify({
        title:             title.slice(0, 140),
        description:       description || title,
        blueprint_id:      bpId,
        print_provider_id: prvId,
        variants:          variantIds.map(id => ({id, price: priceInCents, is_enabled: true})),
        print_areas: [{
          variant_ids:  variantIds,
          placeholders: [{position: "front", images: [{id: printifyImageId, x: 0.5, y: 0.5, scale: 1, angle: 0}]}],
        }],
      }),
    });
    res.json({success:true, printifyProductId:prod.id, title:prod.title, blueprintId:bpId, printProviderId:prvId, variantCount:variantIds.length});
  } catch(e) { res.status(500).json({error:e.message,debug:{blueprintId:bpId,printProviderId:prvId,variantId:varId,imageId:printifyImageId}}); }
});

app.post("/api/printify/publish-to-etsy", async (req, res) => {
  const { printifyProductId } = req.body;
  if (!printifyProductId) return res.status(400).json({ error: "printifyProductId required" });

  try {
    // Force fresh shop lookup
    printifyStore.shopId = null;
    const shopId = await getPrintifyShopId();
    console.log("[Printify→Etsy] Using shop:", shopId);

    // Verify product exists
    const prod = await printifyFetch("/shops/" + shopId + "/products/" + printifyProductId + ".json");
    console.log("[Printify→Etsy] Product found:", prod.id, prod.title);

    // Call publish.json — for Etsy-connected shops this pushes to Etsy.
    // For custom shops it only triggers the event (no-op for Etsy manual connection).
    try {
      await printifyFetch("/shops/" + shopId + "/products/" + printifyProductId + "/publish.json", {
        method: "POST",
        body: JSON.stringify({ title:true, description:true, images:true, variants:true, tags:true, keyFeatures:true, shipping_template:true }),
      });
      console.log("[Printify→Etsy] Publish triggered for product", printifyProductId);
    } catch(pubErr) {
      // publish.json may return 200 with empty body or 404 for custom shops — not fatal
      console.warn("[Printify→Etsy] publish.json warning (non-fatal):", pubErr.message);
    }

    // Confirm: if product was created in the Etsy-connected shop, it will appear
    // in Etsy shop manager → Listings automatically after the publish call.
    res.json({
      success: true,
      printifyProductId: prod.id,
      title: prod.title,
      shopId,
      message: "Product synced. Check your Etsy shop manager → Listings → Drafts. If connected correctly, the listing should appear there within a few minutes.",
      note: "Make sure this Printify shop is connected to Etsy: Printify dashboard → My Stores",
    });

  } catch(e) {
    console.error("[Printify→Etsy] FAILED:", e.message);

    // If 404, the product was created in the wrong Printify shop
    if (e.message.includes("404")) {
      // List all shops for debugging
      try {
        const allShops = await printifyFetch("/shops.json");
        console.log("[Printify→Etsy] All shops:", JSON.stringify(allShops.map(s => s.id + ":" + s.title)));
        return res.status(404).json({
          error: "Product not found in the selected Printify shop. Run the wizard again — a new product will be created in the correct shop.",
          shops: allShops.map(s => ({ id: s.id, title: s.title })),
          tip: "The shop used for product creation must match the shop connected to Etsy.",
        });
      } catch(listErr) {
        // ignore
      }
    }

    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ART GENERATION
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/art/generate", async (req, res) => {
  const {concept,stickerStyle="sigil",productType="sticker",theme} = req.body;
  try {
    const aiResp = await ask(`You are a visual art director for Celestial Yokai brand. Create a precise visual prompt for AI image generation.\nStyle: ${stickerStyle}\nConcept: ${concept||theme||"Kitsari fox sigil"}\nProduct: ${productType}\n\n## VISUAL PROMPT\nA single dense paragraph (80-120 words) for an AI image generator. Specify transparent background, vector-style, clean edges. Celestial Yokai aesthetic — mystical, anime-influenced, dark cosmic with gold/purple accents.\n\n## DESIGN NOTES\n3 bullet points of key design decisions.\n\n## COLOR PALETTE\nPrimary: [hex], Secondary: [hex], Accent: [hex]`, 800);
    const vp  = sec(aiResp,"VISUAL PROMPT");
    const svg = makeSigil(concept||theme||stickerStyle, stickerStyle);
    const b64 = Buffer.from(svg).toString("base64");
    res.json({success:true,visualPrompt:vp,fullAiResponse:aiResp,artworkDataUrl:`data:image/svg+xml;base64,${b64}`,artworkBase64:b64,artworkMimeType:"image/svg+xml",artworkType:"svg_placeholder"});
  } catch(e) { res.status(500).json({error:e.message}); }
});

function makeSigil(concept="", style="sigil") {
  const seed = concept.split("").reduce((a,c)=>a+c.charCodeAt(0),0);
  const rng  = n=>(((seed*9301+n*49297)%233280)/233280);
  const PAL  = {sigil:{p:"#c084fc",s:"#9b5cf6",a:"#e8c97a",g:"rgba(192,132,252,0.6)"},seal:{p:"#e8c97a",s:"#b45309",a:"#c084fc",g:"rgba(232,201,122,0.6)"},emblem:{p:"#67e8f9",s:"#0e7490",a:"#9b5cf6",g:"rgba(103,232,249,0.6)"},warning:{p:"#ff6b6b",s:"#c41e3a",a:"#e8c97a",g:"rgba(255,107,107,0.6)"},kitsari:{p:"#c084fc",s:"#e8c97a",a:"#ffffff",g:"rgba(192,132,252,0.7)"},faction:{p:"#4ade80",s:"#166534",a:"#e8c97a",g:"rgba(74,222,128,0.6)"}};
  const pal  = PAL[style]||PAL.sigil;
  const cx=600,cy=600,R=420;
  let paths="";
  paths+=`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${pal.p}" stroke-width="3" opacity="0.9"/>`;
  paths+=`<circle cx="${cx}" cy="${cy}" r="${R+8}" fill="none" stroke="${pal.p}" stroke-width="1" opacity="0.3"/>`;
  for(let r=1;r<=3;r++){const rd=R*(0.75-r*0.15);paths+=`<circle cx="${cx}" cy="${cy}" r="${rd}" fill="none" stroke="${pal.s}" stroke-width="${2-r*0.3}" opacity="${0.7-r*0.1}"/>`;}
  const petals=6+Math.floor(rng(2)*6),rot=rng(3)*360;
  for(let i=0;i<petals;i++){const a=(i/petals*360+rot)*Math.PI/180,x1=cx+Math.cos(a)*R*0.25,y1=cy+Math.sin(a)*R*0.25,x2=cx+Math.cos(a)*R*0.92,y2=cy+Math.sin(a)*R*0.92;paths+=`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${pal.a}" stroke-width="1.5" opacity="0.6"/>`;}
  if(style==="kitsari"||style==="sigil"){paths+=`<ellipse cx="${cx}" cy="${cy}" rx="90" ry="50" fill="${pal.p}" opacity="0.9"/><ellipse cx="${cx}" cy="${cy}" rx="50" ry="46" fill="#0a0118"/><circle cx="${cx+12}" cy="${cy-8}" r="10" fill="${pal.a}" opacity="0.9"/>`;}
  else if(style==="warning"){paths+=`<polygon points="${cx},${cy-90} ${cx-78},${cy+45} ${cx+78},${cy+45}" fill="${pal.p}" opacity="0.9"/><polygon points="${cx},${cy-55} ${cx-48},${cy+28} ${cx+48},${cy+28}" fill="#0a0118"/><text x="${cx}" y="${cy+18}" text-anchor="middle" font-size="64" font-family="serif" fill="${pal.a}" opacity="0.9">!</text>`;}
  else{paths+=`<rect x="${cx-45}" y="${cy-60}" width="90" height="120" rx="12" fill="${pal.p}" opacity="0.85"/><rect x="${cx-30}" y="${cy-42}" width="60" height="84" rx="6" fill="#0a0118"/><rect x="${cx-3}" y="${cy-22}" width="6" height="44" fill="${pal.a}" opacity="0.7"/><rect x="${cx-22}" y="${cy-3}" width="44" height="6" fill="${pal.a}" opacity="0.7"/>`;}
  const label=(concept||"CELESTIAL YOKAI").slice(0,24).toUpperCase();
  paths+=`<text x="${cx}" y="${cy+R+55}" text-anchor="middle" font-size="28" font-family="monospace" fill="${pal.a}" opacity="0.55" letter-spacing="4">${label}</text>`;
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200"><defs><filter id="glow"><feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><radialGradient id="bg" cx="50%" cy="50%" r="50%"><stop offset="0%" style="stop-color:#0a0118"/><stop offset="100%" style="stop-color:#030108"/></radialGradient></defs><rect width="1200" height="1200" fill="url(#bg)"/><g filter="url(#glow)" opacity="0.6"><circle cx="${cx}" cy="${cy}" r="${R*0.55}" fill="${pal.g}"/></g>${paths}</svg>`;
}

// ════════════════════════════════════════════════════════════════════════════
// AI COMMERCE ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/agent/kitsari", async (req, res) => {
  const {command} = req.body;
  if (!command?.trim()) return res.status(400).json({error:"Command required."});
  try { res.json({agent:"kitsari",response:await ask(command.trim())}); }
  catch(e) { res.status(500).json({error:"Transmission failed."}); }
});

app.post("/api/commerce/generate-product", async (req, res) => {
  const {productType="sticker",theme,stickerStyle,nftAngle} = req.body;
  const ctx = productType==="sticker"?`PRODUCT TYPE: Kiss-cut vinyl sticker\nSTICKER STYLE: ${stickerStyle||"sigil"}\nFormat: die-cut.`:productType==="poster"?`PRODUCT TYPE: Art print/poster.`:`PRODUCT TYPE: T-shirt.`;
  const prompt = `Generate a complete Celestial Yokai product draft.\n${ctx}\nTHEME: ${theme||"Kitsari/Lantern District"}\nNFT UTILITY: ${nftAngle||"holder variant"}\n\nGenerate:\n## PRODUCT NAME\n## LORE ANGLE\n## TARGET BUYER\n## ETSY SEO TITLE\n## DESCRIPTION\n## 13 ETSY TAGS\n## PRICING SUGGESTION\n## PRINTIFY PRODUCT MATCH\n## MOCKUP ART DIRECTION\n## X LAUNCH POST\n## NFT HOLDER UTILITY`;
  try { res.json({response:await ask(prompt,2200),productType,status:"ai_draft",publishLocked:true}); }
  catch(e) { res.status(500).json({error:"Draft generation failed."}); }
});

app.post("/api/commerce/product-idea", async (req, res) => {
  const {niche,medium} = req.body;
  try { res.json({response:await ask(`Generate 3 original Celestial Yokai product ideas.\nTheme: ${niche||"celestial yokai"}\nType: ${medium||"sticker, poster, shirt"}\nFor EACH: Name, Type, Design (2-3 sentences), Buyer, Price, Blueprint, NFT Utility.\nSeparate with ---. Original IP only.`,1800)}); }
  catch(e) { res.status(500).json({error:"Market spirits unavailable."}); }
});

app.post("/api/commerce/launch-post", async (req, res) => {
  const {productName,platform,tone,dropDate} = req.body;
  if (!productName) return res.status(400).json({error:"Product name required."});
  try { res.json({response:await ask(`Write a social launch package for: ${productName}\nPlatform: ${platform||"X and Instagram"}\nTone: ${tone||"mystical, hype"}\nTiming: ${dropDate||"now live"}\n\n## X LAUNCH POST\n## X THREAD (3 posts)\n## INSTAGRAM CAPTION\n## 5-DAY DROP SEQUENCE\n## NFT HOLDER EXCLUSIVE`,2000)}); }
  catch(e) { res.status(500).json({error:"Signal lost."}); }
});

app.post("/api/commerce/lore-content", async (req, res) => {
  const {topic,platform} = req.body;
  try { res.json({response:await ask(`Write lore content for Celestial Yokai universe.\nTopic: ${topic||"Kitsari/Lantern District"}\nPlatform: ${platform||"X"}\n## LORE POST\n## LORE THREAD\n## ENGAGEMENT HOOK\n## CAMPAIGN ANGLE`,1500)}); }
  catch(e) { res.status(500).json({error:"Lore unavailable."}); }
});

app.post("/api/commerce/market-scan", async (req, res) => {
  const {category,priceRange} = req.body;
  try { res.json({response:await ask(`Market signals for Celestial Night Market.\nCategory: ${category||"mystical anime stickers"}\nPrice: ${priceRange||"$5-$30"}\n## MARKET SIGNAL REPORT\n## CONTENT GAP\n## TOP 3 OPPORTUNITIES\n## ETSY SEO KEYWORDS (15)\n## NFT CROSSOVER ANGLE\nAnalyze trends only. Never copy sellers.`,1800)}); }
  catch(e) { res.status(500).json({error:"Market scan failed."}); }
});

app.get("/api/ledger/snapshot", async (req, res) => {
  if (!etsyStore.accessToken||!etsyStore.shopId) return res.json({connected:false,message:"Connect Etsy to populate Lunar Ledger."});
  try {
    const [sR,dR] = await Promise.allSettled([etsyFetch(`/application/shops/${etsyStore.shopId}`),etsyFetch(`/application/shops/${etsyStore.shopId||0}/listings?state=draft&limit=100`)]);
    const sh=sR.status==="fulfilled"?sR.value:null, dr=dR.status==="fulfilled"?dR.value:null;
    res.json({connected:true,shopName:etsyStore.shopName,shopId:etsyStore.shopId,connectedAt:etsyStore.connectedAt,favorites:sh?.num_favorers??"—",orders:sh?.transaction_sold_count??"—",listingCount:sh?.listing_active_count??"—",draftCount:dr?.count??0,currency:sh?.currency_code??"USD"});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/health", (req, res) => res.json({status:"online",etsy:etsyStore.accessToken?"connected":"disconnected",printify:PRINTIFY_KEY?"configured":"unconfigured"}));

// ── 3. STATIC FILES — after ALL API routes ────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── 4. SPA FALLBACK — after static ───────────────────────────────────────────
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({error:"API route not found",path:req.path});
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── 5. LISTEN ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✦ Kitsari Commerce Console — port ${PORT}`);
  console.log(`✦ Etsy:     ${ETSY_API_KEY?"credentials set":"NOT CONFIGURED"}`);
  console.log(`✦ Printify: ${PRINTIFY_KEY?"KEY SET":"not configured"}`);
  console.log(`✦ Redirect: ${ETSY_REDIRECT||"not set"}\n`);
  console.log("Route order: json → api routes → static → spa fallback");
});
