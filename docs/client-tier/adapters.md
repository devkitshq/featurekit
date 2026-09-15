# Framework adapters

`featkit-client` ships no framework bindings. Not "not yet" — it is the
design.

A binding is twenty lines wrapping two methods that already exist:

```ts
client.get(flagKey, defaultValue)      // synchronous read, no promise
client.on("change", handler)           // returns an unsubscribe function
```

A package per framework turns those twenty lines into a version matrix. Every
framework you support is a release you owe on their schedule, every major
version is a breaking change you did not choose, and a project on the framework
you have not packaged yet is told to wait. Meanwhile the adapter that would
have unblocked them is shorter than the issue they filed.

So: copy the one you need into your own codebase. It is yours, you can read it,
and it stops being our release cadence.

Each of these assumes a client built once at module scope or in your app's
composition root:

```ts
import { FeatkitClient } from "featkit-client";

export const featkit = new FeatkitClient({
  clientKey: process.env.FEATKIT_CLIENT_KEY,
  baseUrl: "https://flags.acme.com",
  context: { key: user.id, plan: user.plan },
  stream: true,
});
```

Build it **once**. Re-creating it resets the sequence guard that keeps a slow
response for one user off another user's screen.

---

## React

`useSyncExternalStore` is exactly this shape, which is why the binding is small.

```tsx
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { featkit } from "./featkit";

export function useFlag<T>(flagKey: string, defaultValue: T): T {
  const subscribe = useCallback((onChange: () => void) => {
    // Both events: `change` is a value moving, `state` is an identify()
    // dropping the previous user's values before the network answers. A UI
    // that misses the second shows the old user's flags for a frame.
    const offChange = featkit.on("change", onChange);
    const offState = featkit.on("state", onChange);
    return () => {
      offChange();
      offState();
    };
  }, []);

  // The snapshot is `detail`, not `get`, and the difference matters: React
  // compares snapshots by identity, so `getSnapshot` must return the same
  // reference while nothing has changed. `detail` is the object the SDK holds
  // and replaces only on a real change. `get(key, {…})` would return the
  // *default* for a missing object-valued flag — a fresh literal on every call,
  // which React sees as a change every time and re-renders forever.
  const getSnapshot = useMemo(() => () => featkit.detail(flagKey), [flagKey]);

  // The third argument is the server snapshot. Passing the same function means
  // SSR and hydration read the same bootstrap values, which is what removes
  // the flag flicker.
  const detail = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // `detail` drives the re-render; `get` produces the value, so the fallback
  // for a missing or wrong-typed flag is the one your whole app already uses
  // rather than a second copy of it that drifts.
  return detail === undefined ? defaultValue : featkit.get(flagKey, defaultValue);
}

export function useFeatkitState(): string {
  const subscribe = useCallback((onChange: () => void) => featkit.on("state", onChange), []);
  return useSyncExternalStore(
    subscribe,
    () => featkit.state,
    () => featkit.state,
  );
}
```

Vue and Svelte have no such identity constraint, so those two call `get`
directly. React is the one that needs the two-step.

## Vue

```ts
import { onScopeDispose, shallowRef, watchEffect, type Ref } from "vue";
import { featkit } from "./featkit";

export function useFlag<T>(flagKey: string, defaultValue: T): Ref<T> {
  const read = (): T => featkit.get(flagKey, defaultValue);

  const value = shallowRef(read());
  const update = () => {
    value.value = read();
  };

  const offChange = featkit.on("change", update);
  const offState = featkit.on("state", update);
  onScopeDispose(() => {
    offChange();
    offState();
  });

  return value;
}
```

## Svelte

A store is the subscribe contract almost verbatim.

```ts
import { readable, type Readable } from "svelte/store";
import { featkit } from "./featkit";

export function flag<T>(flagKey: string, defaultValue: T): Readable<T> {
  const read = (): T => featkit.get(flagKey, defaultValue);

  return readable(read(), (set) => {
    const update = () => set(read());
    const offChange = featkit.on("change", update);
    const offState = featkit.on("state", update);
    return () => {
      offChange();
      offState();
    };
  });
}
```

## Plain JavaScript

No framework, no adapter.

```js
featkit.on("change", () => render());
await featkit.ready();

function render() {
  document.body.classList.toggle("new-checkout", featkit.get("new-checkout", false));
}
```

---

## The three things every adapter must get right

**Subscribe to `state`, not only `change`.** An `identify()` for a new context
key empties the held values synchronously — before the network is asked — and
announces it as a state transition, not a change. An adapter listening only to
`change` will keep rendering the previous user's flags until the response
lands. That is the exact bug the synchronous discard exists to prevent,
reintroduced in the last twenty lines.

**Let `get` own the default.** It already falls back for a missing flag and for
a value whose type does not match the default's — a flag retyped in the
dashboard while a client holds the old value otherwise hands a string to
`if (flag)`, and `"false"` is truthy. An adapter that reaches for `detail()` and
reimplements that check will eventually implement it differently.

**Never construct the client per component.** One instance, built once. Reads
are synchronous precisely so that a component can call one during render
without a promise, a suspense boundary, or a client of its own.

## React Native

Nothing on this page changes. Use the React adapter as written; the SDK is the
same one a browser uses.

The one runtime difference is not a binding: React Native's built-in `fetch`
buffers whole bodies and exposes no `ReadableStream`, so the SSE stream cannot
open and the SDK falls back to re-fetching on a timer. Pass a streaming fetch
and it behaves exactly as it does in a browser:

```ts
import { fetch as expoFetch } from "expo/fetch";

new FeatkitClient({ ...options, fetchImpl: expoFetch as unknown as typeof fetch });
```

See [`examples/mobile`](../../examples/mobile), which is this page's React
adapter and that one line, in a working app.
