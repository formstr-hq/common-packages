import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncData<T> {
  data: T;
  loading: boolean;
  error: unknown;
  refresh(): Promise<void>;
  /** Optimistic local update, so a write shows up before relays echo it back. */
  set(value: T | ((current: T) => T)): void;
}

/**
 * The SDK is request/response — it exposes no subscription API — so every read
 * here is explicit. Nothing in this app pretends to be live.
 */
export function useAsyncData<T>(
  load: (() => Promise<T>) | null,
  initial: T,
  deps: unknown[],
): AsyncData<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Guards against a slow earlier load overwriting a newer one.
  const runId = useRef(0);

  const refresh = useCallback(async () => {
    if (!load) {
      setData(initial);
      return;
    }
    const id = (runId.current += 1);
    setLoading(true);
    setError(null);
    try {
      const result = await load();
      if (runId.current === id) setData(result);
    } catch (err) {
      if (runId.current === id) setError(err);
    } finally {
      if (runId.current === id) setLoading(false);
    }
    // `load` and `initial` are intentionally not deps — callers pass fresh
    // closures every render, and `deps` is the real identity of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh, set: setData };
}
