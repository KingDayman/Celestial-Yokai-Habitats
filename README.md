# ✦ Celestial Yokai Mothership

> A dark cosmic AI command center for the Celestial Yokai species.  
> MVP: Kitsari (Lantern District) — clever fox marketing agent powered by Claude.

---

## 🚀 Deploy on Railway Tonight

### Prerequisites
- A [Railway](https://railway.app) account (free tier works)
- Your Anthropic API key

---

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "✦ Launch Celestial Yokai Mothership MVP"
git remote add origin https://github.com/YOUR_USER/celestial-yokai-mothership.git
git push -u origin main
```

---

### Step 2 — Create Railway Project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo**
3. Select your `celestial-yokai-mothership` repo
4. Railway will auto-detect Node.js

---

### Step 3 — Add Environment Variable

In your Railway project dashboard:

1. Click your service → **Variables** tab
2. Add:
   ```
   ANTHROPIC_API_KEY = sk-ant-...your-key-here...
   ```

Railway automatically sets `PORT` — the app reads it via `process.env.PORT`.

---

### Step 4 — Deploy

Railway will build and deploy automatically on every push.  
You'll get a live URL like: `https://celestial-yokai-mothership.up.railway.app`

---

## 🛠 Local Development

```bash
# 1. Install dependencies
npm install

# 2. Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Start the server
npm start
# → Server running at http://localhost:3000
```

---

## 📁 Project Structure

```
celestial-yokai-mothership/
├── server.js          ← Express backend + API routes
├── species.js         ← 🗂 Species Registry (add all 8 here)
├── package.json
├── public/
│   ├── index.html     ← Mothership dashboard UI
│   ├── style.css      ← Dark cosmic styling
│   └── app.js         ← Frontend logic
└── README.md
```

---

## 🦊 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/species` | Returns all species registry data |
| `POST` | `/api/agent/kitsari` | Send a command to Kitsari |
| `GET` | `/health` | Server health check |

### Example: Send a command to Kitsari

```bash
curl -X POST http://localhost:3000/api/agent/kitsari \
  -H "Content-Type: application/json" \
  -d '{"command": "Write 3 X posts for a mystical fox art drop targeting NFT collectors."}'
```

---

## 🐾 Adding New Species

Open `species.js` and find a `dormant` species slot. Fill in:

```js
{
  id: "nubari",
  name: "Nubari",
  status: "active",            // ← Change from "dormant"
  systemPrompt: `You are Nubari, the Storm Serpent of the Tempest Spire...`,
  // ... rest of fields
}
```

The backend `/api/agent/:speciesId` route will automatically handle it.

---

## ✦ Species Registry

| # | Species | District | Status |
|---|---------|----------|--------|
| 1 | 🦊 Kitsari | Lantern District | **Active** |
| 2 | 🐉 Nubari | Tempest Spire | Dormant |
| 3 | 🦢 Miroku | Reflection Basin | Dormant |
| 4 | 👹 Vorath | Forge Hollows | Dormant |
| 5 | 🦝 Sylvex | Mossgrave Forest | Dormant |
| 6 | 🐇 Lunara | Eclipse Warrens | Dormant |
| 7 | 🐢 Tessoku | Ironwater Depths | Dormant |
| 8 | 🦁 Pharex | Aurum Sanctum | Locked |

---

*Built with Node.js, Express, and Anthropic Claude.*  
*Celestial Yokai Mothership © 2025*
