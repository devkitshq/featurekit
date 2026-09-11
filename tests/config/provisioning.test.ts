import { describe, expect, it } from "vitest";
import {
  flagFileSchema,
  resolveConfigVariations,
  resolveVariationIndex,
} from "../../src/provisioning.js";

const variations = [
  { name: "off", value: false },
  { name: "on", value: true },
  { name: "ten", value: 10 },
];

describe("resolveVariationIndex", () => {
  it("resolves numbers directly", () => {
    expect(resolveVariationIndex(0, variations)).toBe(0);
    expect(resolveVariationIndex(1, variations)).toBe(1);
    expect(resolveVariationIndex(2, variations)).toBe(2);
  });

  it("resolves variation names to their array indices", () => {
    expect(resolveVariationIndex("off", variations)).toBe(0);
    expect(resolveVariationIndex("on", variations)).toBe(1);
    expect(resolveVariationIndex("ten", variations)).toBe(2);
  });

  it("returns undefined for undefined input", () => {
    expect(resolveVariationIndex(undefined, variations)).toBeUndefined();
  });

  it("returns numeric string as number if no name matches", () => {
    expect(resolveVariationIndex("1", variations)).toBe(1);
  });
});

describe("resolveConfigVariations", () => {
  it("maps named variations across offVariation, fallthrough, rules, and rollouts", () => {
    const rawConfig = {
      enabled: true,
      offVariation: "off",
      fallthroughVariation: "on",
      rules: [
        {
          clauses: [{ contextKind: "user", attribute: "plan", op: "in", values: ["enterprise"] }],
          variation: "ten",
        },
      ],
      fallthroughRollout: {
        variations: [
          { variation: "off", weight: 50_000 },
          { variation: "on", weight: 50_000 },
        ],
      },
    };

    const resolved = resolveConfigVariations(rawConfig as any, variations);
    expect(resolved.offVariation).toBe(0);
    expect(resolved.fallthroughVariation).toBe(1);
    expect(resolved.rules?.[0]?.variation).toBe(2);
    expect(resolved.fallthroughRollout?.variations?.[0]?.variation).toBe(0);
    expect(resolved.fallthroughRollout?.variations?.[1]?.variation).toBe(1);
  });
});

describe("flagFileSchema with named variations", () => {
  it("validates flag files that use named variation references", () => {
    const file = {
      project: { key: "acme", name: "Acme Cloud" },
      environment: { key: "development", name: "Development", isProduction: false },
      flags: [
        {
          key: "test-flag",
          name: "Test Flag",
          kind: "boolean",
          temporary: true,
          clientAvailable: true,
          tags: ["test"],
          variations: [
            { name: "off", value: false },
            { name: "on", value: true },
          ],
          config: {
            enabled: true,
            offVariation: "off",
            fallthroughVariation: "on",
            rules: [
              {
                clauses: [{ contextKind: "user", attribute: "plan", op: "in", values: ["pro"] }],
                variation: "on",
              },
            ],
          },
        },
      ],
    };

    const parsed = flagFileSchema.safeParse(file);
    expect(parsed.success).toBe(true);
  });
});
