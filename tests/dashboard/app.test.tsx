// @vitest-environment happy-dom
/**
 * The dashboard, rendered against a stubbed management API.
 *
 * There is no browser in CI, so these are the behaviours worth asserting
 * without one — the ones where a mistake is silent rather than visibly broken:
 *
 * - An unauthenticated boot shows a **login form**, and a deployment with no
 *   accounts shows the command that creates one instead.
 * - Every mutation carries the **CSRF header**. The server refuses without it,
 *   so a request built by hand somewhere in the app would fail only in
 *   production, on the one action nobody clicked during review.
 * - A **production** environment is called out in the UI. This is the guard
 *   against the most expensive mistake the dashboard allows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { App } from "../../dashboard/src/app";
import { SessionProvider } from "../../dashboard/src/lib/session";
import { ToastProvider } from "../../dashboard/src/components/ui";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const calls: Call[] = [];

/** The smallest API that lets the app boot as a signed-in owner. */
function stubApi(routes: Record<string, unknown>, options: { authenticated?: boolean } = {}) {
  const authenticated = options.authenticated ?? true;

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
    });

    if (url.includes("/auth/me") && !authenticated) {
      return new Response(JSON.stringify({ error: "MISSING_TOKEN" }), { status: 401 });
    }

    // Longest fragment first: `/recent` and `/admin/projects/.../environments`
    // are both substrings of the same URL, and matching the shorter one first
    // would answer the wrong request.
    const fragments = Object.keys(routes).sort((a, b) => b.length - a.length);
    for (const fragment of fragments) {
      const body = routes[fragment];
      if (url.includes(fragment)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

const OWNER = {
  member: { id: "m1", email: "owner@acme.test", name: null, role: "owner", hasPassword: true, lastLoginAt: null, createdAt: new Date().toISOString() },
  principal: { kind: "session", role: "owner", email: "owner@acme.test", environmentIds: null },
};

function renderApp() {
  return render(
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>,
  );
}

beforeEach(() => {
  calls.length = 0;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard shell", () => {
  it("shows the login form when nobody is signed in", async () => {
    vi.stubGlobal("fetch", stubApi({ "/auth/bootstrap": { members: 3 } }, { authenticated: false }));

    await act(async () => {
      renderApp();
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy());
    expect(screen.getByText(/email/i)).toBeTruthy();
  });

  it("tells a fresh deployment which command creates the first account", async () => {
    vi.stubGlobal("fetch", stubApi({ "/auth/bootstrap": { members: 0 } }, { authenticated: false }));

    await act(async () => {
      renderApp();
    });

    // A login form nobody can pass is the worst possible first screen.
    await waitFor(() => expect(screen.getByText(/no accounts yet/i)).toBeTruthy());
    expect(screen.getByText(/admin:user/)).toBeTruthy();
  });

  it("marks a production environment, everywhere it appears", async () => {
    vi.stubGlobal(
      "fetch",
      stubApi({
        "/auth/me": OWNER,
        "/admin/projects/acme/environments": {
          environments: [
            {
              id: "e1",
              key: "production",
              name: "Production",
              color: null,
              isProduction: true,
              snapshotVersion: 4,
              createdAt: new Date().toISOString(),
            },
          ],
        },
        "/admin/projects": { projects: [{ id: "p1", key: "acme", name: "Acme", environments: ["production"] }] },
        "/recent": { flags: [] },
        "/health": { status: "ok", version: "test", checks: {} },
        "/flags": { environment: "production", flags: [] },
      }),
    );

    await act(async () => {
      renderApp();
    });

    await waitFor(() => expect(screen.getByText(/editing production/i)).toBeTruthy());
  });

  it("sends the CSRF header on every mutation and none on reads", async () => {
    vi.stubGlobal(
      "fetch",
      stubApi({
        "/auth/me": OWNER,
        "/admin/projects/acme/environments": {
          environments: [
            {
              id: "e1",
              key: "development",
              name: "Development",
              color: null,
              isProduction: false,
              snapshotVersion: 1,
              createdAt: new Date().toISOString(),
            },
          ],
        },
        "/admin/projects": { projects: [{ id: "p1", key: "acme", name: "Acme", environments: ["development"] }] },
        "/recent": { flags: [] },
        "/health": { status: "ok", version: "test", checks: {} },
        "/flags": { environment: "development", flags: [] },
      }),
    );

    await act(async () => {
      renderApp();
    });
    await waitFor(() => expect(calls.some((call) => call.url.includes("/auth/me"))).toBe(true));

    // Prove the rule directly against the API client, which is the thing every
    // screen goes through.
    const { api } = await import("../../dashboard/src/lib/api");
    await api.post("/v1/admin/projects", { key: "x", name: "x" });
    await api.get("/v1/admin/projects");

    const mutation = calls.findLast((call) => call.method === "POST");
    const read = calls.findLast((call) => call.method === "GET");
    expect(mutation?.headers["x-featurekit-csrf"]).toBe("1");
    expect(read?.headers["x-featurekit-csrf"]).toBeUndefined();
  });
});
