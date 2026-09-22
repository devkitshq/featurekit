/**
 * `togglekit/secure-mode` is a public contract, so it is tested as one.
 *
 * The gap this closes was real: secure mode is mandatory in production, the
 * signature has to be minted by the customer's own backend, and until now
 * neither `signContext` nor `contextHash` was exported. Every integrator was
 * reimplementing an HMAC over an undocumented string, and the sorted-key
 * canonicalisation by hand — where the failure mode is a 401 in production, at
 * the moment secure mode is switched on, with no clue as to which of the two
 * halves is wrong.
 *
 * These tests pin the two things an integrator can get wrong invisibly: that
 * the entry point exports what the docs say it does, and that a signature made
 * with it verifies against the server's own verifier — including the
 * attribute-bound form, which is the one that actually authenticates the
 * attributes rather than just the identity.
 */

import { describe, expect, it } from "vitest";
import { canonicalize, contextHash, signContext, verifyContext } from "../../src/secure-mode.js";
import { contextHash as fanoutContextHash } from "../../src/evaluation-service/fanout.js";

const SECRETS = ["a-secret-at-least-thirty-two-characters"] as const;
const OPTIONS = { secrets: SECRETS, maxTtlSeconds: 86_400 };
const soon = (): number => Math.floor(Date.now() / 1000) + 3600;

describe("togglekit/secure-mode", () => {
  it("signs a context the server's own verifier accepts", () => {
    const context = { key: "u-ana", plan: "free", tenureMonths: 2 };
    const expiresAt = soon();
    const signature = signContext(context.key, expiresAt, SECRETS, contextHash(context));

    expect(
      verifyContext(
        { key: context.key, expiresAt, signature, attributesHash: contextHash(context) },
        OPTIONS,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects the same signature once an attribute is changed", () => {
    // The escalation the attribute-bound form exists to stop: a user holding a
    // valid signature for their own key claiming a plan they do not have.
    const real = { key: "u-ana", plan: "free", tenureMonths: 2 };
    const claimed = { key: "u-ana", plan: "enterprise", tenureMonths: 2 };
    const expiresAt = soon();
    const signature = signContext(real.key, expiresAt, SECRETS, contextHash(real));

    const result = verifyContext(
      { key: claimed.key, expiresAt, signature, attributesHash: contextHash(claimed) },
      OPTIONS,
    );
    expect(result).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("is the same hash the client tier echoes, not a second implementation", () => {
    // If these ever diverge, a correctly-signed context starts failing and the
    // reason will look like a secret mismatch.
    const context = { key: "u-cleo", plan: "enterprise", tenureMonths: 40 };
    expect(contextHash(context)).toBe(fanoutContextHash(context));
  });

  it("hashes independently of key order, so a backend may build the object any way", () => {
    expect(contextHash({ key: "u-ben", plan: "pro", tenureMonths: 18 })).toBe(
      contextHash({ tenureMonths: 18, key: "u-ben", plan: "pro" }),
    );
  });

  it("canonicalises nested objects and arrays deterministically", () => {
    // Published so other languages can reimplement it; pinned so they can trust
    // what they read.
    expect(canonicalize({ b: 1, a: [3, { z: 1, y: 2 }] })).toBe('{"a":[3,{"y":2,"z":1}],"b":1}');
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(undefined)).toBe("null");
  });

  it("still accepts the key-only form the server documents as legacy", () => {
    const expiresAt = soon();
    const signature = signContext("u-ana", expiresAt, SECRETS);
    expect(
      verifyContext(
        { key: "u-ana", expiresAt, signature, attributesHash: contextHash({ key: "u-ana" }) },
        OPTIONS,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a TTL longer than the server's ceiling, however validly signed", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 400_000;
    const signature = signContext("u-ana", expiresAt, SECRETS);
    expect(verifyContext({ key: "u-ana", expiresAt, signature }, OPTIONS)).toEqual({
      ok: false,
      reason: "SIGNATURE_TTL_TOO_LONG",
    });
  });
});
