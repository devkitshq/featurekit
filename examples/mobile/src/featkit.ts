/**
 * The client, and the twenty lines of React that sit on it.
 *
 * `featkit-client` ships no framework bindings, so this file is the whole
 * adapter — and it is short enough to read in one sitting, which is the point.
 * It is copied from `docs/client-tier/adapters.md`; nothing here is React
 * Native-specific except one line of `fetchImpl`.
 *
 * **The streaming fetch.** The SDK keeps values current over a Server-Sent
 * Events response, which it reads with `response.body.getReader()`. React
 * Native's built-in `fetch` buffers the whole body and exposes no
 * `ReadableStream`, so that stream can never open — the SDK notices, degrades
 * to re-fetching state on a timer, and you get flags a second or two stale
 * instead of pushed. `expo/fetch` is a WinterCG fetch with real streaming, so
 * passing it gives the phone the same live connection a browser has.
 *
 * @see https://docs.expo.dev/versions/latest/sdk/expo/#fetch-api
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { fetch as expoFetch } from "expo/fetch";
import { FeatkitClient, type EvaluationContextLike } from "featkit-client";

/** Falls back to the platform fetch: values still arrive, just not streamed. */
export const streamingFetch: typeof fetch =
  typeof expoFetch === "function" ? (expoFetch as unknown as typeof fetch) : globalThis.fetch;

export const hasStreaming = typeof expoFetch === "function";

let client: FeatkitClient | null = null;

/**
 * Built once, on purpose.
 *
 * Re-creating the client resets the sequence guard that keeps a slow response
 * for one persona from landing on another's screen. A context change is an
 * `identify()`, never a new client.
 */
export function createClient(options: {
  clientKey: string;
  baseUrl: string;
  context: EvaluationContextLike;
  onError: (error: unknown) => void;
}): FeatkitClient {
  client ??= new FeatkitClient({
    clientKey: options.clientKey,
    baseUrl: options.baseUrl,
    context: options.context,
    fetchImpl: streamingFetch,
    stream: true,
    onError: options.onError,
  });
  return client;
}

export function featkit(): FeatkitClient {
  if (client === null) throw new Error("featkit: createClient() has not run yet");
  return client;
}

export const featurekit = featkit;

/**
 * Subscribe to both events, not just `change`.
 *
 * `identify()` for a new context key empties the held values synchronously —
 * before the network is asked — and announces it as a *state* transition. A
 * subscription to `change` alone keeps rendering the previous persona's flags
 * until the response lands, which is the exact bug the synchronous discard
 * exists to prevent.
 */
function useSubscribe(): (onChange: () => void) => () => void {
  return useCallback((onChange: () => void) => {
    const fk = featkit();
    const offChange = fk.on("change", onChange);
    const offState = fk.on("state", onChange);
    return () => {
      offChange();
      offState();
    };
  }, []);
}

/**
 * Synchronous, never suspends, never `undefined`.
 *
 * The default is required for the same reason it is on the server: an optional
 * one produces `undefined` during an outage, and `if (undefined)` is a wrong
 * answer that reads like a right one. Its type is also the expected type, so
 * `useFlag("new-checkout", false)` is a `boolean` with no annotation.
 */
export function useFlag<T>(flagKey: string, defaultValue: T): T {
  const subscribe = useSubscribe();

  // The snapshot is `detail`, not `get`: React compares snapshots by identity,
  // and `detail` is the object the SDK holds, replaced only on a real change.
  // `get(key, {…})` would hand back the *default* for a missing object-valued
  // flag — a fresh literal every call, which React reads as a change and
  // re-renders forever.
  const snapshot = useMemo(() => () => featkit().detail(flagKey), [flagKey]);
  const detail = useSyncExternalStore(subscribe, snapshot, snapshot);

  // `detail` drives the re-render; `get` produces the value, so the fallback
  // for a missing or wrong-typed flag is the SDK's, not a second copy here.
  return detail === undefined ? defaultValue : featkit().get(flagKey, defaultValue);
}

/** Every value currently held, for the "what this device was told" panel. */
export function useAllValues(): Readonly<Record<string, { value: unknown; reason: string }>> {
  const subscribe = useSubscribe();
  const snapshot = useMemo(() => () => featkit().allValues(), []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Connection state, for a "flags may be stale" indicator. */
export function useFeatkitState(): string {
  const subscribe = useCallback(
    (onChange: () => void) => featkit().on("state", onChange),
    [],
  );
  const snapshot = useMemo(() => () => featkit().state, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export const useFeaturekitState = useFeatkitState;
