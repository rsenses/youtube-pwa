import type { SessionInfo } from "../worker/types";
import type { Video } from "../worker/types";
export type {
  Video,
  Channel,
  PlaylistSummary,
  PlaylistDetail,
  SearchResource,
  Settings,
  SessionInfo,
  CommentPage,
  CommentItem,
  SyncRun,
} from "../worker/types";
let csrf = "";
export function setSession(session: SessionInfo) {
  csrf = session.csrfToken;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal,
    headers:
      method === "GET"
        ? {}
        : { "Content-Type": "application/json", "x-csrf-token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "La API no ha devuelto datos JSON. Recarga la aplicación; si persiste, revisa el despliegue o vuelve a entrar por Access.",
    );
  const data = await response.json().catch(() => {
    throw new Error("La API ha devuelto una respuesta JSON inválida.");
  });
  if (!response.ok)
    throw new Error(
      typeof data === "object" &&
        data !== null &&
        "error" in data &&
        typeof data.error === "string"
        ? data.error
        : `Error ${response.status}`,
    );
  return data as T;
}
export const videoUrl = (id: string) => `/watch/${encodeURIComponent(id)}`;
export function videoThumbnail(video: Video): string {
  if (video.thumbnailUrl.startsWith("/api/feed/thumbnails/")) return video.thumbnailUrl;
  // The video id is authoritative. Previously stored Atom images can be shared
  // between unrelated entries, so avoid displaying those cached URLs.
  return /^[A-Za-z0-9_-]{11}$/.test(video.id) && !video.thumbnailUrl.startsWith("/thumbs/")
    ? `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`
    : video.thumbnailUrl || "/thumbs/01.svg";
}
export function duration(seconds: number | null) {
  if (seconds === null) return "";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function dateLabel(date: string) {
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(date));
}
