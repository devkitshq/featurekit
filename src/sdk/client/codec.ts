/**
 * Snapshot wire codec.
 *
 * Segment filters are `Uint8Array`. `JSON.stringify` turns one into
 * `{"0":1,"1":2,...}` and `JSON.parse` gives back a plain object — a filter
 * that answers `false` for **every** member. Silent, and only visible weeks
 * later as "the flag didn't turn on for that customer" (§9.7). So binary
 * fields are tagged on the wire and revived here.
 *
 * The base64 is hand-rolled rather than using `Buffer`: this file is compiled
 * into browser and edge bundles, where `Buffer` does not exist. It must stay
 * byte-identical to the server's codec in `src/redis/snapshot-store.ts`.
 */

import type { Snapshot } from "../evaluation/types.js";

const BINARY_TAG = "$fkBytes";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    acc = (acc << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function serialize(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, (_key, value: unknown) =>
    value instanceof Uint8Array ? { [BINARY_TAG]: toBase64(value) } : value,
  );
}

export function deserialize(text: string): Snapshot {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && BINARY_TAG in value) {
      const encoded = (value as Record<string, unknown>)[BINARY_TAG];
      if (typeof encoded === "string") return fromBase64(encoded);
    }
    return value;
  }) as Snapshot;
}
