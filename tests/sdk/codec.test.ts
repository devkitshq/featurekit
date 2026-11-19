import { describe, expect, it } from "vitest";
import { deserialize, fromBase64, serialize, toBase64, type Snapshot } from "../../src/sdk/index.js";

describe("snapshot codec", () => {
  it("encodes exactly as Buffer does, across chunk boundaries", () => {
    for (const length of [0, 1, 2, 3, 0x8000, 0x8000 * 3 + 1]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31) & 0xff);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });

  it("round-trips binary segment filters through JSON", () => {
    const filter = Uint8Array.from([0, 255, 9, 8, 7]);
    const snapshot = { version: 1, segments: { big: { filter } } } as unknown as Snapshot;
    const back = deserialize(serialize(snapshot)) as unknown as { segments: { big: { filter: unknown } } };
    expect(back.segments.big.filter).toEqual(filter);
  });
});
