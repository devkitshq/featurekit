/**
 * Snapshot wire codec.
 *
 * Segment filters are `Uint8Array`. `JSON.stringify` turns one into
 * `{"0":1,"1":2,...}` and `JSON.parse` gives back a plain object — a filter
 * that answers `false` for **every** member. Silent, and only visible weeks
 * later as "the flag didn't turn on for that customer". So binary
 * fields are tagged on the wire and revived here.
 *
 * `btoa`/`atob` rather than `Buffer`: this file is compiled into browser and
 * edge bundles, where `Buffer` does not exist. The server uses this codec too.
 */

import type { Snapshot } from "../evaluation/types.js";

const BINARY_TAG = "$fkBytes";

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a multi-megabyte filter in one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
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
