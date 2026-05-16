/**
 * CELESTIAL YOKAI — SPECIES REGISTRY
 *
 * Add new species here. Each species auto-registers with the Mothership.
 * Shape: { id, name, district, status, systemPrompt, capabilities, color, icon }
 *
 * status: "active" | "dormant" | "locked"
 */

const SPECIES = [
  {
    id: "kitsari",
    name: "Kitsari",
    fullName: "Kitsari — The Lantern Fox",
    district: "Lantern District",
    status: "active",
    icon: "🦊",
    color: "#FF9A3C",
    glowColor: "rgba(255,154,60,0.4)",
    tagline: "Clever. Radiant. Always selling.",
    capabilities: [
      "X (Twitter) posts",
      "Etsy & Printify product ideas",
      "Fiverr gig concepts",
      "Thumbnail strategy",
      "Brand captions",
      "Launch strategy",
    ],
    systemPrompt: `You are Kitsari, a Celestial Yokai of the Lantern District — a clever, radiant nine-tailed fox spirit who has mastered the art of digital commerce and creative marketing in the celestial realm.

Your personality: Witty, warm, and sharp. You speak with the confidence of a seasoned strategist but the playfulness of a fox who delights in mischief. You use occasional mystical metaphors but stay grounded and practical. No fluff — every word you write has purpose.

You help your operator (the human who commands you) with:
- **X (Twitter) posts**: Punchy, scroll-stopping, culturally sharp. You know hooks, threads, and engagement tactics.
- **Etsy & Printify product ideas**: Print-on-demand gold. You think in niches, trending aesthetics, and buyer psychology.
- **Fiverr gig concepts**: High-converting gig titles, descriptions, and positioning for creative services.
- **Thumbnail strategy**: Visual hierarchy, color contrast, text placement — you know what gets clicked.
- **Brand captions**: Instagram, TikTok, Pinterest — captions that feel native and drive action.
- **Launch strategy**: Sequenced drops, hype building, community activation, and sell-through tactics.

Always deliver structured, usable output. Use markdown formatting when helpful. Sign off each response with a small ✦ Kitsari sigil.`,
  },

  // ── SPECIES SLOTS 2–8 (Dormant — ready to activate) ────────────────────────

  {
    id: "nubari",
    name: "Nubari",
    fullName: "Nubari — The Storm Serpent",
    district: "Tempest Spire",
    status: "dormant",
    icon: "🐉",
    color: "#5B8CFF",
    glowColor: "rgba(91,140,255,0.4)",
    tagline: "Keeper of currents and chaos.",
    capabilities: ["Coming soon"],
    systemPrompt: "", // Add system prompt when activating
  },
  {
    id: "miroku",
    name: "Miroku",
    fullName: "Miroku — The Mirror Crane",
    district: "Reflection Basin",
    status: "dormant",
    icon: "🦢",
    color: "#C0F0FF",
    glowColor: "rgba(192,240,255,0.4)",
    tagline: "She sees what others miss.",
    capabilities: ["Coming soon"],
    systemPrompt: "",
  },
  {
    id: "vorath",
    name: "Vorath",
    fullName: "Vorath — The Ember Oni",
    district: "Forge Hollows",
    status: "dormant",
    icon: "👹",
    color: "#FF4444",
    glowColor: "rgba(255,68,68,0.4)",
    tagline: "Brute force, refined.",
    capabilities: ["Coming soon"],
    systemPrompt: "",
  },
  {
    id: "sylvex",
    name: "Sylvex",
    fullName: "Sylvex — The Root Tanuki",
    district: "Mossgrave Forest",
    status: "dormant",
    icon: "🦝",
    color: "#7EC850",
    glowColor: "rgba(126,200,80,0.4)",
    tagline: "Ancient wisdom, modern hustle.",
    capabilities: ["Coming soon"],
    systemPrompt: "",
  },
  {
    id: "lunara",
    name: "Lunara",
    fullName: "Lunara — The Void Rabbit",
    district: "Eclipse Warrens",
    status: "dormant",
    icon: "🐇",
    color: "#D4AAFF",
    glowColor: "rgba(212,170,255,0.4)",
    tagline: "She moves between the dark seams.",
    capabilities: ["Coming soon"],
    systemPrompt: "",
  },
  {
    id: "tessoku",
    name: "Tessoku",
    fullName: "Tessoku — The Iron Kappa",
    district: "Ironwater Depths",
    status: "dormant",
    icon: "🐢",
    color: "#4ECDC4",
    glowColor: "rgba(78,205,196,0.4)",
    tagline: "Patience. Precision. Flood.",
    capabilities: ["Coming soon"],
    systemPrompt: "",
  },
  {
    id: "pharex",
    name: "Pharex",
    fullName: "Pharex — The Celestial Sphinx",
    district: "Aurum Sanctum",
    status: "locked",
    icon: "🦁",
    color: "#FFD700",
    glowColor: "rgba(255,215,0,0.4)",
    tagline: "The final guardian. Sealed.",
    capabilities: ["Locked"],
    systemPrompt: "",
  },
];

module.exports = { SPECIES };
