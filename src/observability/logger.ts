/**
 * Structured logging.
 *
 * Two rules, both of which exist so that the telemetry itself cannot lie or
 * become the next outage:
 *
 * 1. **Nothing secret is ever logged.** SDK keys, access tokens, secure-mode
 *    signatures and `Authorization` headers are redacted by pino itself rather
 *    than by call-site discipline, because call-site discipline is what fails
 *    on the endpoint somebody adds next year.
 * 2. **Nothing high-cardinality is ever a log *field* that metrics then copy.**
 *    Context keys identify end users. They are legitimate in a debug line while
 *    diagnosing one request; they are never a label (see `metrics.ts`).
 *
 * Every request gets an id, and it appears in the log line, the error response
 * and the audit row for the same request. That triple is what makes a customer
 * report ("it returned 500 at 14:02") answerable.
 */

import { randomUUID } from "node:crypto";
import { pino, type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  level?: string;
  /** Pretty single-line output for a laptop; JSON everywhere else. */
  pretty?: boolean;
  /** Fixed fields on every line — service, version, instance. */
  base?: Record<string, unknown>;
}

/**
 * Paths pino redacts before serialisation.
 *
 * `censor` replaces rather than removes, so a redacted line still proves the
 * header was present — which is what you need when debugging a 401.
 */
const REDACTED = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "signature",
  "sdkKey",
  "token",
  "secret",
  "*.signature",
  "*.sdkKey",
  "*.token",
  "*.secret",
];

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    level: options.level ?? "info",
    base: options.base ?? {},
    redact: { paths: REDACTED, censor: "[redacted]" },
    // Wall-clock ISO rather than epoch millis: the first thing anyone does with
    // a log line at 3am is compare it to a graph.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(options.pretty === true
      ? { transport: { target: "pino/file", options: { destination: 1 } } }
      : {}),
  });
}

/**
 * A request id, taken from the caller when it supplied one so a trace spans the
 * load balancer, and generated when it did not.
 *
 * The caller's value is length-capped and stripped of anything that is not
 * url-safe: it lands in log lines and response headers, and an unbounded,
 * unfiltered header is log injection.
 */
export function requestIdFrom(header: string | undefined): string {
  if (header === undefined) return randomUUID();
  const cleaned = header.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : randomUUID();
}
