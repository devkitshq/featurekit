/**
 * The same three people as the browser demo, so the two clients can be run side
 * by side and shown to disagree for the right reasons.
 *
 * These are evaluation contexts: a stable `key` plus attributes the rules in
 * `examples/server/flags.js` target on. Nothing here decides anything — the
 * server does, and sends back values.
 */

export interface Persona {
  id: string;
  label: string;
  context: {
    key: string;
    name: string;
    plan: "free" | "pro" | "enterprise";
    tenureMonths: number;
    [attribute: string]: unknown;
  };
}

export const PERSONAS: readonly Persona[] = [
  {
    id: "ana",
    label: "Ana",
    context: { key: "u-ana", name: "Ana", plan: "free", tenureMonths: 2 },
  },
  {
    id: "ben",
    label: "Ben",
    context: { key: "u-ben", name: "Ben", plan: "pro", tenureMonths: 18 },
  },
  {
    id: "cleo",
    label: "Cleo",
    context: { key: "u-cleo", name: "Cleo", plan: "enterprise", tenureMonths: 40 },
  },
];
