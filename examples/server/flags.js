/**
 * The flags this demo runs on — as data, in your repository.
 *
 * `server.js` pushes this into the control plane over the management API on
 * every start, so the demo is the same on a fresh database as on your fifth
 * run. It is the shape a real config-as-code sync takes (§11.3).
 *
 * Two things to know before editing:
 *
 * - **Variations can be referenced by name** (e.g. `"on"`, `"off"`) or by index (`0`, `1`).
 *   Referencing by name ensures that reordering variations is completely safe.
 * - **This file owns definitions, not operational state.** On restart, flag
 *   definitions (names, descriptions, tags, variations) are kept up to date.
 *   Live operational targeting and on/off flips from the dashboard are preserved
 *   unless you pass `--reset`.
 */

export const project = { key: "acme", name: "Acme Cloud" };

export const environment = {
  key: "development",
  name: "Development",
  // Left non-production: a production environment makes the client tier demand
  // an HMAC-signed context (§16), which means minting a signature per browser
  // session before anything renders. Real, and off the happy path for a demo.
  isProduction: false,
};

/** Percentage rollouts are integers out of 100,000. 20% is 20_000. */
const pct = (percent) => Math.round(percent * 1000);

export const flags = [
  {
    key: "new-checkout",
    name: "New checkout flow",
    description: "Checkout 2.0 — one-click, saved card, instant provisioning.",
    kind: "boolean",
    clientAvailable: true,
    temporary: true,
    tags: ["checkout"],
    variations: [
      { name: "off", value: false },
      { name: "on", value: true },
    ],
    config: {
      enabled: true,
      offVariation: "off",
      fallthroughVariation: "off",
      rules: [
        {
          description: "Paid plans get the new checkout",
          clauses: [
            { contextKind: "user", attribute: "plan", op: "in", values: ["pro", "enterprise"] },
          ],
          variation: "on",
        },
      ],
    },
  },

  {
    key: "loyalty-discount",
    name: "Loyalty discount (%)",
    description: "Discount applied at checkout. A number flag, not a boolean.",
    kind: "number",
    clientAvailable: true,
    temporary: false,
    tags: ["pricing"],
    variations: [
      { name: "none", value: 0 },
      { name: "ten", value: 10 },
      { name: "twenty-five", value: 25 },
    ],
    config: {
      enabled: true,
      offVariation: "none",
      fallthroughVariation: "none",
      rules: [
        {
          description: "Enterprise customers get 25%",
          clauses: [
            { contextKind: "user", attribute: "plan", op: "in", values: ["enterprise"] },
          ],
          variation: "twenty-five",
        },
        {
          // Order matters: an enterprise customer with long tenure matched
          // above and never reaches this rule.
          description: "Twelve months or more gets 10%",
          clauses: [
            {
              contextKind: "user",
              attribute: "tenureMonths",
              op: "greaterThanOrEqual",
              values: [12],
            },
          ],
          variation: "ten",
        },
      ],
    },
  },

  {
    key: "checkout-flow",
    name: "Checkout flow variant",
    description: "Which checkout experience a customer lands in.",
    kind: "string",
    clientAvailable: true,
    temporary: true,
    tags: ["checkout", "experiment"],
    variations: [
      { name: "classic", value: "classic" },
      { name: "express", value: "express" },
    ],
    config: {
      enabled: true,
      offVariation: "classic",
      // A 50/50 split, bucketed by context key against this environment's salt.
      // The same user keeps the same arm across reloads, processes and SDKs —
      // that is what the salt is for.
      fallthroughRollout: {
        contextKind: "user",
        variations: [
          { variation: "classic", weight: pct(50) },
          { variation: "express", weight: pct(50) },
        ],
      },
      rules: [
        {
          description: "Enterprise always gets express",
          clauses: [
            { contextKind: "user", attribute: "plan", op: "in", values: ["enterprise"] },
          ],
          variation: "express",
        },
      ],
    },
  },

  {
    key: "promo-banner",
    name: "Announcement banner",
    description: "Empty means no banner. A string flag driving copy, not a toggle.",
    kind: "string",
    clientAvailable: true,
    temporary: true,
    tags: ["growth"],
    variations: [
      { name: "hidden", value: "" },
      { name: "upgrade", value: "Upgrade to Pro and save 10% on every cluster." },
      { name: "maintenance", value: "Scheduled maintenance on Sunday 02:00–04:00 UTC." },
    ],
    config: {
      enabled: true,
      offVariation: "hidden",
      fallthroughVariation: "hidden",
      rules: [
        {
          description: "Free plans see the upgrade prompt",
          clauses: [{ contextKind: "user", attribute: "plan", op: "in", values: ["free"] }],
          variation: "upgrade",
        },
      ],
    },
  },

  {
    key: "internal-pricing-model",
    name: "Pricing model (server only)",
    description:
      "clientAvailable: false. Evaluated by server SDKs and never sent to a browser — " +
      "open devtools on the app and confirm it is absent.",
    kind: "string",
    clientAvailable: false,
    temporary: false,
    tags: ["internal"],
    variations: [
      { name: "list", value: "list-price" },
      { name: "elastic", value: "elastic-v2" },
    ],
    config: {
      enabled: true,
      offVariation: "list",
      fallthroughVariation: "elastic",
    },
  },
];

export default { project, environment, flags };
