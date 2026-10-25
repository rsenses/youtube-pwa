import type { SyncRun } from "./api";

export const syncTypeLabels: Record<string, string> = {
  all: "Todo",
  subscriptions: "Suscripciones",
  rss: "RSS",
  playlists: "Listas",
  metadata: "Metadatos",
};
export function syncStatusLabel(status?: string) {
  switch (status) {
    case "success":
      return "Correcta";
    case "partial":
      return "Parcial";
    case "error":
      return "Error";
    case "running":
      return "En curso";
    case "noop":
      return "Sin cambios";
    default:
      return "Desconocida";
  }
}
type SyncJobStatus =
  "queued" | "running" | "retrying" | "paused" | "success" | "error";
type SyncJobPhase =
  | "subscriptions"
  | "rss"
  | "playlists"
  | "playlist_items"
  | "metadata"
  | "done";
export interface SyncJob {
  id: string;
  type?: string;
  playlistId?: string;
  status: SyncJobStatus;
  phase?: SyncJobPhase | null;
  items?: number | null;
  processedChannels?: number | null;
  processedPlaylists?: number | null;
  message?: string | null;
  nextAttemptAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}
export interface SyncSummary {
  status?: SyncRun["status"];
  type?: string;
  message?: string;
  items?: number;
  more?: boolean;
  mode?: "demo" | "real";
  job?: SyncJob | null;
}
export interface SyncStatusResponse {
  runs: SyncRun[];
  mode?: "demo" | "real";
  message?: string;
  jobs?: SyncJob[];
}
export const syncJobPhases: Record<SyncJobPhase, string> = {
  subscriptions: "Suscripciones",
  rss: "RSS",
  playlists: "Listas",
  playlist_items: "Elementos de listas",
  metadata: "Metadatos",
  done: "Completada",
};
export function syncJobStatusLabel(status: SyncJobStatus) {
  switch (status) {
    case "queued":
      return "En cola";
    case "running":
      return "En curso";
    case "retrying":
      return "Reintentando";
    case "paused":
      return "En pausa";
    case "success":
      return "Correcta";
    case "error":
      return "Error";
  }
}
export function isActiveSyncJob(job?: SyncJob | null) {
  return !!job && ["queued", "running", "retrying"].includes(job.status);
}
function syncJobCounter(
  value: number | null | undefined,
  one: string,
  many: string,
) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const count = Math.max(0, Math.trunc(value));
  return `${count} ${count === 1 ? one : many}`;
}
export function syncJobCounters(job: SyncJob) {
  return [
    syncJobCounter(job.items, "elemento", "elementos"),
    syncJobCounter(job.processedChannels, "canal", "canales"),
    syncJobCounter(job.processedPlaylists, "lista", "listas"),
  ]
    .filter(Boolean)
    .join(" · ");
}
export function syncJobNextAttempt(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
export function syncJobNotice(job: SyncJob) {
  switch (job.status) {
    case "success":
      return job.items
        ? `Sincronización completada · ${job.items} elementos.`
        : "Sincronización completada.";
    case "error":
      return job.message
        ? `Error de sincronización: ${shortText(job.message)}`
        : "Error de sincronización. Se conservaron los datos locales.";
    case "paused":
      return job.nextAttemptAt
        ? `Sincronización en pausa · reintento automático ${syncJobNextAttempt(job.nextAttemptAt)}.`
        : "Sincronización en pausa · reintento automático pendiente.";
    case "retrying":
      return "Sincronización con reintento automático en el servidor.";
    case "running":
      return "Sincronización en curso en el servidor · puedes cerrar la página.";
    default:
      return "Sincronización en cola · continúa en el servidor aunque cierres la página.";
  }
}
function syncCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}
export function shortText(value: string, max = 160) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function summarizeSyncCounters(value: Record<string, unknown>, scope?: string) {
  const parts: string[] = [],
    prefix = scope ? `${scope}: ` : "",
    label = (count: number, one: string, many: string) =>
      `${count} ${count === 1 ? one : many}`;
  const processed = syncCount(value.processed),
    complete =
      typeof value.complete === "boolean"
        ? value.complete
        : typeof value.listComplete === "boolean"
          ? value.listComplete
          : syncCount(value.complete),
    failed = syncCount(value.failed),
    pending = syncCount(value.pending),
    items = syncCount(value.items),
    skipped = syncCount(value.skipped),
    pages = syncCount(value.pages ?? value.listPages),
    imported = syncCount(value.importedPlaylists),
    pendingPlaylists = syncCount(value.pendingPlaylists),
    purged = syncCount(value.purged),
    errors = Array.isArray(value.errors) ? value.errors.length : null,
    imports = Array.isArray(value.imports) ? value.imports : null;
  if (processed !== null) {
    let line = label(processed, "procesado", "procesados");
    if (complete !== null)
      line +=
        typeof complete === "boolean"
          ? complete
            ? ", completo"
            : ", incompleto"
          : `, ${label(complete, "completo", "completos")}`;
    if (failed !== null) line += `, ${label(failed, "fallido", "fallidos")}`;
    if (pending !== null)
      line += `, ${label(pending, "pendiente", "pendientes")}`;
    if (items !== null) line += `, ${label(items, "nuevo", "nuevos")}`;
    if (skipped !== null) line += `, ${label(skipped, "omitido", "omitidos")}`;
    if (imported !== null)
      line += `, ${label(imported, "lista importada", "listas importadas")}`;
    if (pendingPlaylists !== null)
      line += `, ${label(pendingPlaylists, "lista pendiente", "listas pendientes")}`;
    parts.push(`${prefix}${line}`);
  } else {
    const bits: string[] = [];
    if (imported !== null)
      bits.push(label(imported, "importada", "importadas"));
    if (pendingPlaylists !== null)
      bits.push(label(pendingPlaylists, "pendiente", "pendientes"));
    if (pages !== null) bits.push(label(pages, "página", "páginas"));
    if (complete !== null)
      bits.push(
        typeof complete === "boolean"
          ? complete
            ? "completo"
            : "incompleto"
          : label(complete, "completo", "completos"),
      );
    if (items !== null) bits.push(label(items, "nuevo", "nuevos"));
    if (purged !== null) bits.push(label(purged, "retirado", "retirados"));
    if (imports)
      bits.push(
        `${imports.filter((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).complete === true).length}/${imports.length} listas completas`,
      );
    if (bits.length) parts.push(`${prefix}${bits.join(", ")}`);
  }
  if (errors !== null && errors > 0)
    parts.push(`${prefix}${label(errors, "error", "errores")}`);
  return parts;
}
export function summarizeSyncDetail(detail: string | null | undefined) {
  if (!detail) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    const text = detail.trim();
    return text.startsWith("{") || text.startsWith("[") ? "" : shortText(text);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const data = parsed as Record<string, unknown>,
    parts: string[] = [];
  if (Array.isArray(data.summaries)) {
    for (const entry of data.summaries.slice(0, 4)) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>,
        type =
          typeof item.type === "string"
            ? syncTypeLabels[item.type] || item.type
            : "Paso",
        status =
          typeof item.status === "string"
            ? syncStatusLabel(item.status).toLowerCase()
            : "sin estado",
        count = syncCount(item.items),
        nested =
          typeof item.detail === "string"
            ? summarizeSyncDetail(item.detail)
            : "";
      parts.push(
        `${type}: ${status}${
          nested
            ? ` · ${nested}`
            : count
              ? ` · ${count} ${count === 1 ? "elemento" : "elementos"}`
              : ""
        }`,
      );
    }
    if (Array.isArray(data.errors) && data.errors.length)
      parts.push(
        `${data.errors.length} ${data.errors.length === 1 ? "error" : "errores"}`,
      );
    if (
      data.metadata &&
      typeof data.metadata === "object" &&
      !Array.isArray(data.metadata)
    )
      parts.push(
        ...summarizeSyncCounters(
          data.metadata as Record<string, unknown>,
          "Metadatos",
        ),
      );
    return shortText(parts.join(" · "), 240);
  }
  for (const key of ["rss", "subscriptions", "playlists", "metadata"]) {
    const nested = data[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested))
      parts.push(
        ...summarizeSyncCounters(
          nested as Record<string, unknown>,
          syncTypeLabels[key],
        ),
      );
  }
  if (parts.length) return shortText(parts.join(" · "), 220);
  parts.push(...summarizeSyncCounters(data));
  if (parts.length) return shortText(parts.join(" · "), 220);
  return typeof data.note === "string" ? shortText(data.note) : "";
}
