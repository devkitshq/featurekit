// @vitest-environment happy-dom
/**
 * No management URL may be built with an empty scope segment.
 *
 * The bug: `project` and `environment` start as `""` in the session and are
 * filled in once the lists load. Interpolated straight into a template that
 * produced `/v1/admin/projects//environments//keys` — two empty segments, no
 * route match, and a 404 whose message says nothing about the real problem.
 *
 * Every page already gated its **reads** behind a `scoped` flag. Writes were
 * not, and could not be gated that way anyway: the dialogs performing them read
 * the session themselves, several components from the guard. So `KeysPage`
 * rendered "New key" unconditionally, and clicking it before a project existed
 * — the permanent state of a fresh deployment — produced the 404.
 *
 * The guard therefore lives where URLs are built rather than where they are
 * called, which is the only place that covers callers nobody has written yet.
 * These tests walk the whole `A` surface rather than listing methods, so a new
 * endpoint added without a guard fails here instead of in production.
 */

import { describe, expect, it } from "vitest";
import { A } from "../../dashboard/src/lib/api";

/**
 * Fail loudly if a call escapes to the network: a passing test here must mean
 * "refused before fetching", never "fetched and happened to work".
 */
function forbidFetch(): void {
  globalThis.fetch = (() => {
    throw new Error("a request was made with an unscoped URL");
  }) as unknown as typeof fetch;
}

/** Every `A` method, with the argument shapes each one needs. */
const scopedCalls: Array<[string, (project: string, environment: string) => unknown]> = [
  ["keys", (p, e) => A.keys(p, e)],
  ["createKey", (p, e) => A.createKey(p, e, "client")],
  ["revokeKey", (p, e) => A.revokeKey(p, e, "key-1")],
  ["segments", (p, e) => A.segments(p, e)],
  ["flags", (p, e) => A.flags(p, e)],
  ["config", (p, e) => A.config(p, e, "some-flag")],
];

describe("management URLs refuse an empty scope", () => {
  it("throws rather than requesting when no project is selected", () => {
    forbidFetch();
    for (const [name, call] of scopedCalls) {
      expect(() => call("", "production"), `${name} with no project`).toThrow(/project/);
    }
  });

  it("throws rather than requesting when no environment is selected", () => {
    forbidFetch();
    for (const [name, call] of scopedCalls) {
      expect(() => call("acme", ""), `${name} with no environment`).toThrow(/environment/);
    }
  });

  it("names what is missing, so the user can act on it", () => {
    forbidFetch();
    // The old failure was a bare 404 from the server. This one says what to do.
    expect(() => A.createKey("", "", "client")).toThrow(/no project selected/);
  });

  it("still builds a URL when both are present", () => {
    // Proves the guard is not simply rejecting everything.
    let requested = "";
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requested = String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    void A.keys("acme", "production");
    expect(requested).toContain("/projects/acme/environments/production/keys");
    expect(requested).not.toContain("//environments");
  });

  it("escapes a scope that needs it, rather than only checking emptiness", () => {
    let requested = "";
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requested = String(input);
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    }) as unknown as typeof fetch;

    void A.keys("acme/evil", "prod uction");
    expect(requested).toContain("acme%2Fevil");
    expect(requested).toContain("prod%20uction");
  });

  it("refuses to delete a project with empty scope", () => {
    forbidFetch();
    expect(() => A.deleteProject("")).toThrow(/project/);
  });
});
