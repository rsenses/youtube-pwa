export type VideoType = "video" | "live" | "short";

/** Classification based on the latest available metadata, not YouTube's Shorts format. */
export function videoType(video: {
  liveBroadcastContent?: string | null;
  durationSeconds: number | null;
}): VideoType {
  if (video.liveBroadcastContent === "live") return "live";
  if (
    video.durationSeconds !== null &&
    video.durationSeconds > 0 &&
    video.durationSeconds < 180
  )
    return "short";
  return "video";
}
