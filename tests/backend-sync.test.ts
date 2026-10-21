import { describe, expect, it } from "vitest";
import { backoffDelayMs, isSyncType, mapSyncRun } from "../worker/sync";

describe("sync helpers", () => {
  it("backs off exponentially with a six-hour cap", () => {
    expect(backoffDelayMs(1)).toBe(5 * 60 * 1000);
    expect(backoffDelayMs(2)).toBe(10 * 60 * 1000);
    expect(backoffDelayMs(3)).toBe(20 * 60 * 1000);
    expect(backoffDelayMs(100)).toBe(6 * 60 * 60 * 1000);
  });

  it("accepts only the documented sync types", () => {
    expect(isSyncType("all")).toBe(true);
    expect(isSyncType("subscriptions")).toBe(true);
    expect(isSyncType("rss")).toBe(true);
    expect(isSyncType("playlists")).toBe(true);
    expect(isSyncType("metadata")).toBe(false);
    expect(isSyncType("")).toBe(false);
  });

  it("maps persisted sync runs", () => {
    const run = mapSyncRun({
      id: "run-1",
      type: "rss",
      status: "partial",
      started_at: "2026-10-12T09:00:00.000Z",
      finished_at: "2026-10-12T09:00:02.000Z",
      items: 3,
      error: "one channel failed",
      detail: '{"processed":2}',
      mode: "real",
    });
    expect(run).toMatchObject({
      id: "run-1",
      type: "rss",
      status: "partial",
      items: 3,
      mode: "real",
    });
    expect(run.error).toBe("one channel failed");
  });

  it("maps unknown statuses to an explicit noop and demo mode", () => {
    const run = mapSyncRun({ status: "mystery", mode: "demo" });
    expect(run.status).toBe("noop");
    expect(run.mode).toBe("demo");
    expect(run.error).toBeNull();
  });
});
