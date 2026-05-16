/* ═══════════════════════════════════════════════════════════════
   CELESTIAL YOKAI MOTHERSHIP — FRONTEND APP
   ═══════════════════════════════════════════════════════════════ */

// ── Starfield ────────────────────────────────────────────────────────────────
(function generateStars() {
  const field = document.getElementById("starfield");
  const count = 160;
  for (let i = 0; i < count; i++) {
    const s = document.createElement("div");
    s.className = "star";
    const size = Math.random() * 2.5 + 0.5;
    s.style.cssText = `
      left: ${Math.random() * 100}%;
      top: ${Math.random() * 100}%;
      width: ${size}px;
      height: ${size}px;
      --d: ${(Math.random() * 4 + 2).toFixed(1)}s;
      --min-op: ${(Math.random() * 0.15 + 0.05).toFixed(2)};
      --max-op: ${(Math.random() * 0.5 + 0.4).toFixed(2)};
      animation-delay: ${(Math.random() * 5).toFixed(1)}s;
    `;
    field.appendChild(s);
  }
})();

// ── Status Line ──────────────────────────────────────────────────────────────
(function setStatus() {
  const el = document.getElementById("status-text");
  const now = new Date();
  const ts = now.toISOString().replace("T", " ").substring(0, 19);
  setTimeout(() => {
    el.textContent = `ONLINE // ${ts} UTC`;
  }, 800);
})();

// ── Char Counter ─────────────────────────────────────────────────────────────
const input = document.getElementById("kitsari-input");
const charCount = document.getElementById("char-count");
const MAX = 1000;

input.addEventListener("input", () => {
  const len = input.value.length;
  charCount.textContent = `${len} / ${MAX}`;
  charCount.style.color = len > MAX * 0.9 ? "var(--fox)" : "";
  if (len > MAX) input.value = input.value.substring(0, MAX);
});

// ── Species Registry ─────────────────────────────────────────────────────────
async function loadRegistry() {
  try {
    const res = await fetch("/api/species");
    const data = await res.json();
    renderRegistry(data.species);
  } catch (e) {
    console.error("Registry load failed:", e);
  }
}

function renderRegistry(species) {
  const grid = document.getElementById("registry-grid");
  grid.innerHTML = "";

  species.forEach((s, i) => {
    const card = document.createElement("div");
    card.className = `registry-card${s.status === "active" ? " is-active" : ""}`;
    card.style.setProperty("--species-glow", s.glowColor || "transparent");
    card.style.animationDelay = `${i * 0.07}s`;

    const statusIcon = s.status === "active" ? "●" : s.status === "locked" ? "⬡" : "○";

    card.innerHTML = `
      <div class="registry-card-glow"></div>
      <div class="registry-icon">${s.icon}</div>
      <div class="registry-district mono">${s.district.toUpperCase()}</div>
      <div class="registry-name" style="color:${s.color}">${s.name}</div>
      <div class="registry-tagline">${s.tagline}</div>
      <div class="registry-status ${s.status}">
        <span class="status-pip"></span>
        ${s.status.toUpperCase()}
      </div>
    `;
    grid.appendChild(card);
  });
}

// ── Simple Markdown Renderer ─────────────────────────────────────────────────
function renderMarkdown(text) {
  return text
    // Bold
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    // Headings (##)
    .replace(/^## (.+)$/gm, '<span style="font-family:\'Cinzel Decorative\',serif;font-size:1.05rem;color:var(--fox);display:block;margin:0.75rem 0 0.25rem">$1</span>')
    // Headings (#)
    .replace(/^# (.+)$/gm, '<span style="font-family:\'Cinzel Decorative\',serif;font-size:1.2rem;color:var(--fox);display:block;margin:0.75rem 0 0.3rem">$1</span>')
    // Bullet points
    .replace(/^[-•] (.+)$/gm, '<span style="display:block;padding-left:1rem;margin:0.1rem 0">✦ $1</span>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, '<span style="display:block;padding-left:1rem;margin:0.1rem 0">$1</span>')
    // Code inline
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,154,60,0.1);border:1px solid rgba(255,154,60,0.2);border-radius:4px;padding:0.1em 0.4em;font-family:\'Share Tech Mono\',monospace;font-size:0.85em">$1</code>')
    // Line breaks
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

// ── Send Command ─────────────────────────────────────────────────────────────
let lastResponse = "";

async function sendCommand() {
  const command = input.value.trim();
  if (!command) {
    showError("Please enter a command before transmitting.");
    return;
  }

  setLoading(true);
  hideAll();

  try {
    const res = await fetch("/api/agent/kitsari", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "Transmission failed. Check API key or try again.");
      return;
    }

    lastResponse = data.response;
    showResponse(data.response);
  } catch (err) {
    showError("Network error. Is the server running?");
  } finally {
    setLoading(false);
  }
}

// ── Copy Response ────────────────────────────────────────────────────────────
function copyResponse() {
  if (!lastResponse) return;
  navigator.clipboard.writeText(lastResponse).then(() => {
    const btn = document.querySelector(".copy-btn");
    const orig = btn.textContent;
    btn.textContent = "✓ COPIED";
    setTimeout(() => (btn.textContent = orig), 2000);
  });
}

// ── UI Helpers ───────────────────────────────────────────────────────────────
function hideAll() {
  document.getElementById("response-panel").style.display = "none";
  document.getElementById("loading-state").style.display = "none";
  document.getElementById("error-state").style.display = "none";
}

function setLoading(on) {
  const btn = document.getElementById("send-btn");
  const loading = document.getElementById("loading-state");
  btn.disabled = on;
  btn.querySelector(".btn-text").textContent = on ? "TRANSMITTING..." : "TRANSMIT";
  loading.style.display = on ? "flex" : "none";
}

function showResponse(text) {
  const panel = document.getElementById("response-panel");
  const body = document.getElementById("response-body");
  body.innerHTML = renderMarkdown(text);
  panel.style.display = "block";
}

function showError(msg) {
  const el = document.getElementById("error-state");
  document.getElementById("error-text").textContent = `⚠ ${msg}`;
  el.style.display = "block";
}

// ── Keyboard Shortcut: Ctrl/Cmd + Enter ─────────────────────────────────────
input.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendCommand();
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────
loadRegistry();
