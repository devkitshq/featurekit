/**
 * Starting Postgres in Docker for development is opt-in: the
 * testcontainers packages are dev dependencies and are not installed with
 * featurekit-server. Both ways it can fail must say what to do, not surface a
 * module-resolution or container-runtime error.
 */

import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/index.js";
import { devServiceModule, startDevContainer } from "../../src/server.js";

function moduleNotFound(name: string): Error {
  return Object.assign(new Error(`Cannot find package '${name}' imported from server.js`), {
    code: "ERR_MODULE_NOT_FOUND",
  });
}

describe("development containers", () => {
  it("explains how to proceed when the testcontainers package is not installed", async () => {
    const attempt = devServiceModule(() => Promise.reject(moduleNotFound("@testcontainers/postgresql")), "@testcontainers/postgresql");
    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toThrow(/npm i -D @testcontainers\/postgresql/);
    await expect(attempt).rejects.toThrow(/pass databaseUrl/);
  });

  it("does not disguise a different missing module as this one", async () => {
    const other = moduleNotFound("some-transitive-dependency");
    await expect(devServiceModule(() => Promise.reject(other), "@testcontainers/postgresql")).rejects.toBe(other);
  });

  it("returns the module when it is installed", async () => {
    await expect(devServiceModule(() => Promise.resolve({ ok: true }), "@testcontainers/postgresql")).resolves.toEqual({ ok: true });
  });

  it("names Docker when a container cannot start", async () => {
    const attempt = startDevContainer(() => Promise.reject(new Error("Could not find a working container runtime strategy")));
    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toThrow(/Start Docker/);
    await expect(attempt).rejects.toThrow(/container runtime strategy/);
  });
});
