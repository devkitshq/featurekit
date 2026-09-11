/**
 * Data loading, small enough to read.
 *
 * A dashboard's data is a handful of endpoints, each of which reloads when a
 * write succeeds. That is a `useEffect` and a counter, not a cache library —
 * and the counter is explicit, so "why did this not refresh" is answerable by
 * reading one call site rather than someone's invalidation rules.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface Resource<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  /** Refetch now. Returns the promise so a caller can await a reload. */
  reload: () => Promise<void>;
}

export function useResource<T>(
  load: () => Promise<T>,
  deps: unknown[],
  options: { enabled?: boolean } = {},
): Resource<T> {
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(enabled);
  /** Only the newest request may set state: a slow first response must not win. */
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async () => {
    if (!enabled) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const next = await loadRef.current();
      if (mine !== generation.current) return;
      setData(next);
      setError(null);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void run();
    // The dependency array is the caller's; `run` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  return { data, error, loading, reload: run };
}

/**
 * Run a mutation, tracking whether it is in flight and what it said.
 *
 * Every write in this dashboard goes through here so that no button can be
 * pressed twice and no failure is silent.
 */
export function useAction<Args extends unknown[], T>(
  action: (...args: Args) => Promise<T>,
): {
  run: (...args: Args) => Promise<T | null>;
  busy: boolean;
  error: ApiError | Error | null;
  reset: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(async (...args: Args): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await actionRef.current(...args);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy, error, reset: () => setError(null) };
}

/** A value that survives a reload, for things like the selected environment. */
export function useStored(key: string, initial: string): [string, (next: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: string) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* private mode; the selection just will not persist */
      }
    },
    [key],
  );
  return [value, set];
}

/** `?` opens the shortcut sheet, `/` focuses search — a tool, not a page. */
export function useHotkey(key: string, handler: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === key) {
        event.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, handler]);
}
