/**
 * W3C trace context (§16, review PR-D5).
 *
 * A request id correlates featkit's own log lines. It does not correlate
 * them with anything *else*, and the question an operator actually has at 3am
 * is "the checkout service saw a slow flag fetch at 14:02 — what was featkit
 * doing?". Answering that needs the trace id the caller already has.
 *
 * So `traceparent` is parsed when present and generated when not, and the trace
 * id goes into every log line for the request. This is deliberately the
 * *propagation* half of tracing and not an exporter: featkit makes no
 * outbound HTTP calls, so there are no spans of its own worth shipping, and
 * adding an OpenTelemetry SDK to the dependency tree of a package whose selling
 * point is a small dependency tree needs a better reason than symmetry.
 *
 * The format is fixed by the spec:
 *
 *     version "-" trace-id "-" parent-id "-" trace-flags
 *     00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *
 * Anything that does not match exactly is discarded rather than repaired: a
 * malformed header is an upstream bug, and inventing a trace id that looks like
 * theirs would join two unrelated traces together.
 */

import { randomBytes } from "node:crypto";

export interface TraceContext {
  traceId: string;
  /** This request's span. A child of `parentId` when the caller supplied one. */
  spanId: string;
  parentId: string | null;
  /** True when the caller marked the trace as sampled. */
  sampled: boolean;
  /** The header to pass to anything called downstream. */
  traceparent: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** All-zero ids are explicitly invalid per the specification. */
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Continue the caller's trace, or start one.
 *
 * Case-insensitive on input because some proxies uppercase hex, strict on
 * output because the spec requires lowercase.
 */
export function traceContextFrom(header: string | undefined): TraceContext {
  const match = header === undefined ? null : TRACEPARENT.exec(header.trim().toLowerCase());

  if (match !== null) {
    const [, traceId, parentId, flags] = match as unknown as [string, string, string, string];
    if (traceId !== ZERO_TRACE && parentId !== ZERO_SPAN) {
      const spanId = newSpanId();
      return {
        traceId,
        spanId,
        parentId,
        sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01,
        traceparent: `00-${traceId}-${spanId}-${flags}`,
      };
    }
  }

  // No usable parent: this request is the root of its own trace. Sampled by
  // default, because a trace nobody sampled is a trace nobody can read, and
  // featkit is not the component that should be deciding otherwise.
  const traceId = newTraceId();
  const spanId = newSpanId();
  return {
    traceId,
    spanId,
    parentId: null,
    sampled: true,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

/** The fields that belong on every log line for a request. */
export function traceFields(trace: TraceContext): Record<string, string> {
  return trace.parentId === null
    ? { traceId: trace.traceId, spanId: trace.spanId }
    : { traceId: trace.traceId, spanId: trace.spanId, parentSpanId: trace.parentId };
}
