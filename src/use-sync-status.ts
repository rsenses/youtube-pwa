import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { isActiveSyncJob, type SyncStatusResponse } from "./sync-status";

const SYNC_STATUS_POLL_MS = 3000;
export function useSyncStatus(enabled: boolean, endpoint = "/api/sync/status") {
  const [data, setData] = useState<SyncStatusResponse | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError("");
      return;
    }
    const controller = new AbortController();
    api<SyncStatusResponse>(endpoint, "GET", undefined, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [version, enabled, endpoint]);
  const active = enabled && !!data?.jobs?.some(isActiveSyncJob);
  useEffect(() => {
    if (!active) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const schedule = () => {
      timer = setTimeout(async () => {
        try {
          const next = await api<SyncStatusResponse>(
            endpoint,
            "GET",
            undefined,
            controller.signal,
          );
          if (cancelled) return;
          setData(next);
          setError("");
          if (next.jobs?.some(isActiveSyncJob)) schedule();
        } catch (e) {
          if (!cancelled && (e as Error).name !== "AbortError") {
            setError((e as Error).message);
            schedule();
          }
        }
      }, SYNC_STATUS_POLL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [active, endpoint]);
  return { data, setData, error, refresh };
}
