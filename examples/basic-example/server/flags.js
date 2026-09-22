/**
 * Basic Example: 4 Core Flag Types in Togglekit
 *
 * 1. Toggle  (Boolean) -> "feature-toggle"
 * 2. Text    (String)  -> "headline-text"
 * 3. Number  (Number)  -> "discount-number"
 * 4. JSON    (Object)  -> "theme-config"
 */

export const project = { key: "demo", name: "Togglekit Demo" };

export const environment = {
  key: "development",
  name: "Development",
  isProduction: false,
};

export const flags = [
  // 1. Toggle (Boolean Flag)
  {
    key: "feature-toggle",
    name: "Feature Toggle",
    description: "Boolean flag enabling or disabling the promo banner and special mode.",
    kind: "boolean",
    clientAvailable: true,
    temporary: true,
    tags: ["demo", "boolean"],
    variations: [
      { name: "off", value: false },
      { name: "on", value: true },
    ],
    config: {
      enabled: true,
      offVariation: "off",
      fallthroughVariation: "on",
    },
  },

  // 2. Text (String Flag)
  {
    key: "headline-text",
    name: "Headline Text",
    description: "Dynamic headline copy rendered in web and mobile headers.",
    kind: "string",
    clientAvailable: true,
    temporary: true,
    tags: ["demo", "string"],
    variations: [
      { name: "welcome", value: "🚀 Welcome to Togglekit Live Flag Experience!" },
      { name: "announcement", value: "🎉 Flash Sale is Live: Limited Time Offers Available!" },
      { name: "maintenance", value: "⚡ Scheduled Optimization in Progress (Zero Downtime)." },
    ],
    config: {
      enabled: true,
      offVariation: "welcome",
      fallthroughVariation: "welcome",
    },
  },

  // 3. Number (Number Flag)
  {
    key: "discount-number",
    name: "Discount Percentage",
    description: "Numeric discount rate dynamically applied in checkout calculations.",
    kind: "number",
    clientAvailable: true,
    temporary: false,
    tags: ["demo", "number"],
    variations: [
      { name: "ten", value: 10 },
      { name: "twenty-five", value: 25 },
      { name: "fifty", value: 50 },
    ],
    config: {
      enabled: true,
      offVariation: "ten",
      fallthroughVariation: "twenty-five",
    },
  },

  // 4. JSON (Object Flag)
  {
    key: "theme-config",
    name: "Theme & UI Config",
    description: "Dynamic JSON configuration controlling UI colors, badges, and layout.",
    kind: "json",
    clientAvailable: true,
    temporary: false,
    tags: ["demo", "json"],
    variations: [
      {
        name: "indigo-theme",
        value: {
          theme: "indigo",
          accentColor: "#6366f1",
          badge: "PRO EDITION",
          cardRadius: 16,
          glow: true,
        },
      },
      {
        name: "emerald-theme",
        value: {
          theme: "emerald",
          accentColor: "#10b981",
          badge: "SUMMER DROP",
          cardRadius: 24,
          glow: true,
        },
      },
      {
        name: "amber-theme",
        value: {
          theme: "amber",
          accentColor: "#f59e0b",
          badge: "VIP ACCESS",
          cardRadius: 12,
          glow: false,
        },
      },
    ],
    config: {
      enabled: true,
      offVariation: "indigo-theme",
      fallthroughVariation: "indigo-theme",
    },
  },
];

export default { project, environment, flags };
