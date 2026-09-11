/**
 * Context caps (§15).
 *
 * These limits are a memory-safety boundary. The client tier hashes,
 * normalises, evaluates and then *retains* a caller-supplied context for the
 * life of an SSE connection, so every one of those steps is proportional to an
 * object an untrusted browser chose the size of.
 */

import { describe, expect, it } from "vitest";
import { checkContext, DEFAULT_CONTEXT_LIMITS } from "../../src/contracts/context.js";

describe("checkContext", () => {
  it("accepts an ordinary single-kind context", () => {
    expect(checkContext({ key: "user-1", country: "NL", plan: "pro" }).ok).toBe(true);
  });

  it("accepts a multi-context", () => {
    const context = {
      kind: "multi",
      user: { key: "u1", country: "NL" },
      organization: { key: "acme", tier: "enterprise" },
    };
    expect(checkContext(context).ok).toBe(true);
  });

  it("requires a key", () => {
    expect(checkContext({ country: "NL" })).toEqual({ ok: false, reason: "CONTEXT_KEY_MISSING" });
    expect(checkContext({ key: "" })).toEqual({ ok: false, reason: "CONTEXT_KEY_MISSING" });
    expect(checkContext({ kind: "multi", user: { country: "NL" } })).toEqual({
      ok: false,
      reason: "CONTEXT_KEY_MISSING",
    });
  });

  it("rejects a non-object", () => {
    for (const value of [null, "user-1", 42, [], undefined]) {
      expect(checkContext(value).ok).toBe(false);
    }
  });

  it("caps the number of attributes", () => {
    const context: Record<string, unknown> = { key: "u1" };
    for (let i = 0; i < DEFAULT_CONTEXT_LIMITS.maxAttributes + 5; i++) context[`a${i}`] = i;
    expect(checkContext(context)).toEqual({
      ok: false,
      reason: "CONTEXT_TOO_MANY_ATTRIBUTES",
    });
  });

  it("caps the number of context kinds", () => {
    const context: Record<string, unknown> = { kind: "multi" };
    for (let i = 0; i < DEFAULT_CONTEXT_LIMITS.maxKinds + 2; i++) {
      context[`kind${i}`] = { key: `k${i}` };
    }
    expect(checkContext(context)).toEqual({ ok: false, reason: "CONTEXT_TOO_MANY_KINDS" });
  });

  it("caps string length", () => {
    const long = "x".repeat(DEFAULT_CONTEXT_LIMITS.maxStringLength + 1);
    expect(checkContext({ key: "u1", bio: long })).toEqual({
      ok: false,
      reason: "CONTEXT_VALUE_TOO_LONG",
    });
  });

  it("caps the key itself", () => {
    const key = "u".repeat(DEFAULT_CONTEXT_LIMITS.maxKeyLength + 1);
    expect(checkContext({ key })).toEqual({ ok: false, reason: "CONTEXT_KEY_TOO_LONG" });
  });

  it("caps array length", () => {
    const values = Array.from({ length: DEFAULT_CONTEXT_LIMITS.maxArrayLength + 1 }, (_, i) => i);
    expect(checkContext({ key: "u1", groups: values })).toEqual({
      ok: false,
      reason: "CONTEXT_ARRAY_TOO_LONG",
    });
  });

  it("rejects deep nesting rather than overflowing the stack", () => {
    // A 10,000-deep object is a stack overflow, and a stack overflow is an
    // uncatchable crash rather than a 400.
    let deep: Record<string, unknown> = { bottom: true };
    for (let i = 0; i < 10_000; i++) deep = { nested: deep };
    const result = checkContext({ key: "u1", ...deep });
    expect(result).toEqual({ ok: false, reason: "CONTEXT_TOO_DEEP" });
  });

  it("rejects NaN and Infinity", () => {
    expect(checkContext({ key: "u1", age: Number.NaN }).ok).toBe(false);
    expect(checkContext({ key: "u1", age: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it("accepts unicode keys and values within the caps", () => {
    // Emoji, combining marks, RTL override — all legitimate context values.
        expect(checkContext({ key: "用户-1", city: "Ωmega‮txet", tag: "🎉" }).ok).toBe(true);
  });

  it("is bounded in time for a wide, shallow context", () => {
    const context: Record<string, unknown> = { key: "u1" };
    for (let i = 0; i < DEFAULT_CONTEXT_LIMITS.maxAttributes - 1; i++) {
      context[`a${i}`] = "x".repeat(100);
    }
    const started = performance.now();
    expect(checkContext(context).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
