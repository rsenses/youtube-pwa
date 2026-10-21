import { describe, it, expect } from "vitest";
import { videoType } from "../shared/video-type";
describe("video type labels", () => {
  it.each([
    [null, null, "video"],
    [0, "none", "video"],
    [179, "none", "short"],
    [180, "none", "video"],
    [181, "none", "video"],
    [30, "live", "live"],
    [300, "upcoming", "video"],
    [30, "none", "short"],
    [null, "live", "live"],
    [null, "upcoming", "video"],
  ] as const)(
    "classifies duration %s and broadcast %s as %s",
    (durationSeconds, liveBroadcastContent, expected) => {
      expect(videoType({ durationSeconds, liveBroadcastContent })).toBe(
        expected,
      );
    },
  );
});
