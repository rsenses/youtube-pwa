import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  api,
  setSession,
  dateLabel,
  type Channel,
  type CommentItem,
  type CommentPage,
  type PlaylistDetail,
  type PlaylistSummary,
  type SessionInfo,
  type Settings,
  type SyncRun,
  type Video,
} from "./api";
import { Icon, State, useResource, VideoCard } from "./ui";
import { Player } from "./player";
import { videoType, type VideoType } from "../shared/video-type";
import "./styles.css";
const AppContext = createContext<{
  session: SessionInfo;
  settings: Settings;
  updateSettings: (s: Partial<Settings>) => Promise<void>;
  notify: (text: string) => void;
  refreshSession: () => Promise<void>;
}>(null!);
const useApp = () => useContext(AppContext);
const navigation = [
  ["/feed", "feed", "Feed"],
  ["/channels", "channels", "Canales"],
  ["/playlists", "lists", "Listas"],
  ["/settings", "settings", "Configuración"],
];
const syncTypeLabels: Record<string, string> = {
  all: "Todo",
  subscriptions: "Suscripciones",
  rss: "RSS",
  playlists: "Listas",
  metadata: "Metadatos",
};
function syncStatusLabel(status?: string) {
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
interface SyncJob {
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
interface SyncSummary {
  status?: SyncRun["status"];
  type?: string;
  message?: string;
  items?: number;
  more?: boolean;
  mode?: "demo" | "real";
  job?: SyncJob | null;
}
interface SyncStatusResponse {
  runs: SyncRun[];
  mode?: "demo" | "real";
  message?: string;
  jobs?: SyncJob[];
}
const syncJobPhases: Record<SyncJobPhase, string> = {
  subscriptions: "Suscripciones",
  rss: "RSS",
  playlists: "Listas",
  playlist_items: "Elementos de listas",
  metadata: "Metadatos",
  done: "Completada",
};
function syncJobStatusLabel(status: SyncJobStatus) {
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
function isActiveSyncJob(job?: SyncJob | null) {
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
function syncJobCounters(job: SyncJob) {
  return [
    syncJobCounter(job.items, "elemento", "elementos"),
    syncJobCounter(job.processedChannels, "canal", "canales"),
    syncJobCounter(job.processedPlaylists, "lista", "listas"),
  ]
    .filter(Boolean)
    .join(" · ");
}
function syncJobNextAttempt(value?: string | null) {
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
function mergeSyncJobs(jobs: SyncJob[] | undefined, job: SyncJob) {
  return [job, ...(jobs || []).filter((item) => item.id !== job.id)].slice(
    0,
    10,
  );
}
function syncJobNotice(job: SyncJob) {
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
function shortText(value: string, max = 160) {
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
function summarizeSyncDetail(detail: string | null | undefined) {
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
function App() {
  const [session, sessionSet] = useState<SessionInfo | null>(null),
    [settings, settingsSet] = useState<Settings>({
      watchThreshold: 80,
      theme: "system",
    }),
    [error, errorSet] = useState(""),
    [toast, toastSet] = useState("");
  const location = useLocation();
  const refreshSession = useCallback(async () => {
    const s = await api<SessionInfo>("/api/session");
    setSession(s);
    sessionSet(s);
    if (s.mode === "demo" || s.connected) {
      settingsSet(await api<Settings>("/api/settings"));
    }
  }, []);
  useEffect(() => {
    refreshSession().catch((e) => errorSet(e.message));
  }, [refreshSession]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const updateChromeColor = () =>
      meta?.setAttribute(
        "content",
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim(),
      );
    updateChromeColor();
    systemTheme.addEventListener("change", updateChromeColor);
    return () => systemTheme.removeEventListener("change", updateChromeColor);
  }, [settings.theme]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => toastSet(""), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  async function updateSettings(value: Partial<Settings>) {
    const s = await api<Settings>("/api/settings", "PATCH", value);
    settingsSet(s);
    toastSet("Preferencias guardadas");
  }
  if (error)
    return (
      <main className="boot">
        <Logo />
        <State error>No se pudo cargar Alveo. {error}</State>
        <button onClick={() => window.location.reload()}>Reintentar</button>
      </main>
    );
  if (!session)
    return (
      <main className="boot">
        <Logo />
        <State>Cargando…</State>
      </main>
    );
  const watching = location.pathname.startsWith("/watch/");
  return (
    <AppContext.Provider
      value={{
        session,
        settings,
        updateSettings,
        notify: toastSet,
        refreshSession,
      }}
    >
      <div className={`app-shell ${watching ? "watching" : ""}`}>
        <aside className="sidebar">
          <Link to="/feed" className="brand" aria-label="Alveo, ir al feed">
            <Logo />
          </Link>
          <nav aria-label="Navegación principal">
            {navigation.map(([path, icon, label]) => (
              <NavLink
                key={path}
                to={path}
                className={({ isActive }) =>
                  isActive ? "nav-link selected" : "nav-link"
                }
              >
                <Icon name={icon} />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="profile">
              <span className="profile-avatar">
                {session.mode === "demo" ? "D" : "Y"}
              </span>
              <div>
                <strong>{session.account?.name || "Cuenta local"}</strong>
                <small>
                  {session.mode === "demo"
                    ? "Demo local"
                    : session.connected
                      ? "YouTube conectado"
                      : "Sin conectar"}
                </small>
              </div>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <Link
              to="/feed"
              className="mobile-brand"
              aria-label="Alveo, ir al feed"
            >
              <Logo />
            </Link>
          </header>
          <main
            id="main-content"
            className={watching ? "watch-main" : "page-main"}
          >
            {session.mode === "real" &&
            !session.connected &&
            location.pathname !== "/settings" ? (
              <Navigate to="/settings" replace />
            ) : (
              <Routes>
                <Route path="/" element={<Navigate to="/feed" replace />} />
                <Route path="/feed" element={<Feed />} />
                <Route path="/channels" element={<Channels />} />
                <Route path="/channels/:id" element={<ChannelPage />} />
                <Route path="/playlists" element={<Playlists />} />
                <Route path="/playlists/:id" element={<PlaylistPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/watch/:id" element={<WatchRoute />} />
                <Route
                  path="*"
                  element={
                    <State>
                      No encontramos esta página.{" "}
                      <Link to="/feed">Volver al feed</Link>
                    </State>
                  }
                />
              </Routes>
            )}
          </main>
          <footer className="page-footer">
            <span>Alveo</span>
            <Link to="/settings#privacy">Privacidad</Link>
          </footer>
        </div>
        <nav className="bottom-nav" aria-label="Navegación móvil">
          {navigation.map(([path, icon, label]) => (
            <NavLink key={path} to={path}>
              <Icon name={icon} size={22} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        {toast && (
          <div className="toast" role="status">
            <Icon name="check" size={18} />
            {toast}
            <button aria-label="Cerrar aviso" onClick={() => toastSet("")}>
              <Icon name="close" size={15} />
            </button>
          </div>
        )}
      </div>
    </AppContext.Provider>
  );
}
function Logo() {
  return (
    <span className="logo">
      <span className="logo-mark">
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path
            d="M8 7h9c7 0 9 6 4 10L11 25"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="m8 15 8-8M8 24l14-13"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span>
        alveo<span className="logo-period">.</span>
      </span>
    </span>
  );
}
function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div className="page-heading-copy">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="page-heading-action">{action}</div>}
    </div>
  );
}
function SyncButton({ onDone }: { onDone?: (job?: SyncJob) => void } = {}) {
  const { notify, session } = useApp();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="button secondary sync-button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          let result = await api<SyncSummary>("/api/sync", "POST", {
            type: "all",
          });
          const job = result.job;
          if (job) {
            // The queue owns the work: this response is an acknowledgement,
            // so `more` must not start the legacy foreground loop.
            notify(syncJobNotice(job));
          } else {
            // Legacy/local fallback keeps driving the bounded foreground loop.
            let steps = 1;
            while (result.more && mounted.current && steps < 500) {
              result = await api<SyncSummary>("/api/sync", "POST", {
                type: "all",
              });
              steps++;
            }
            if (session.mode === "demo") {
              notify(
                session.capabilities.publicData
                  ? "Modo demo: las lecturas públicas siguen activas. Importar tu cuenta requiere OAuth."
                  : "Modo demo: no se hacen consultas externas.",
              );
            } else if (result.type === "rss" && result.message) {
              notify(result.message);
            } else if (result.status === "partial") {
              notify(
                "Sincronización parcial. Se conservaron los datos locales.",
              );
            } else if (result.status === "error") {
              notify(
                "Error de sincronización. Se conservaron los datos locales.",
              );
            } else if (result.status === "noop") {
              notify("No había cambios que sincronizar.");
            } else if (result.status === "success") {
              notify(
                result.items
                  ? `Sincronización completada · ${result.items} elementos.`
                  : "Sincronización completada.",
              );
            } else {
              notify(
                "Sincronización terminada. Revisa el estado en Configuración.",
              );
            }
          }
          onDone?.(job || undefined);
        } catch (e) {
          notify((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className={busy ? "spin" : ""}>
        <Icon name="sync" size={17} />
      </span>
      {busy ? "Sincronizando…" : "Actualizar"}
    </button>
  );
}
const DEFAULT_FEED_TYPES = "video,live";
const feedVideoTypes: Array<{ value: VideoType; label: string }> = [
  { value: "video", label: "Vídeos" },
  { value: "live", label: "Directos" },
  { value: "short", label: "Shorts" },
];
function Feed() {
  const [search, setSearch] = useSearchParams();
  const status = search.get("status") || "pending",
    channel = search.get("channelId") || "";
  const rawTypes = search.get("types"),
    types = feedVideoTypes
      .map((t) => t.value)
      .filter((t) =>
        new Set((rawTypes ?? DEFAULT_FEED_TYPES).split(",")).has(t),
      ),
    typesParam = types.join(",");
  const [videos, setVideos] = useState<Video[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0),
    [bulk, setBulk] = useState(false),
    [before, setBefore] = useState("");
  const { data: channels } = useResource<{ items: Channel[] }>("/api/channels");
  const { notify, session } = useApp();
  const loadGeneration = useRef(0);
  const query = new URLSearchParams({
    status,
    channelId: channel,
    types: typesParam,
    limit: "18",
  }).toString();
  useEffect(() => {
    // Legacy links without a type filter adopt the product default (video + live).
    if (rawTypes !== null) return;
    const next = new URLSearchParams(search);
    next.set("types", DEFAULT_FEED_TYPES);
    setSearch(next, { replace: true });
  }, [rawTypes, search, setSearch]);
  useEffect(() => {
    loadGeneration.current++;
    let active = true;
    setBusy(true);
    setVideos([]);
    setCursor(null);
    setError("");
    api<{ items: Video[]; nextCursor: string | null }>(`/api/feed?${query}`)
      .then((d) => {
        if (active) {
          setVideos(d.items);
          setCursor(d.nextCursor);
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [query, version]);
  function toggleType(value: VideoType) {
    const next = feedVideoTypes
      .map((t) => t.value)
      .filter((t) => (t === value ? !types.includes(t) : types.includes(t)));
    const s = new URLSearchParams(search);
    s.delete("cursor");
    s.set("types", next.join(","));
    setSearch(s);
  }
  async function more() {
    const generation = loadGeneration.current;
    setBusy(true);
    try {
      const d = await api<{ items: Video[]; nextCursor: string | null }>(
        `/api/feed?${query}&cursor=${encodeURIComponent(cursor!)}`,
      );
      if (generation !== loadGeneration.current) return;
      setVideos((v) => [...v, ...d.items]);
      setCursor(d.nextCursor);
    } catch (e) {
      if (generation === loadGeneration.current) setError((e as Error).message);
    } finally {
      if (generation === loadGeneration.current) setBusy(false);
    }
  }
  function change(v: Video) {
    setVideos((items) =>
      items
        .map((i) => (i.id === v.id ? v : i))
        .filter(
          (i) =>
            types.includes(videoType(i)) &&
            (status === "all" ||
              (status === "watched" ? i.watched : !i.watched)),
        ),
    );
  }
  function filter(key: string, value: string) {
    const s = new URLSearchParams(search);
    value ? s.set(key, value) : s.delete(key);
    setSearch(s);
  }
  async function mark(scope: "all" | "channel" | "before") {
    if (scope === "before" && !before) return;
    setBusy(true);
    try {
      await api("/api/watch-state/bulk", "POST", {
        scope,
        channelId: channel || undefined,
        before:
          scope === "before"
            ? new Date(`${before}T00:00:00`).toISOString()
            : undefined,
      });
      notify("Vídeos marcados como vistos");
      setVersion((v) => v + 1);
      setBulk(false);
    } catch (e) {
      notify((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Feed"
        description="Vídeos de tus canales."
        action={<SyncButton onDone={() => setVersion((v) => v + 1)} />}
      />
      {session.mode === "demo" && (
        <div className="demo-banner">
          <span>
            {session.capabilities.publicData
              ? "Modo demo: datos públicos reales, sin conectar tu cuenta."
              : "Modo demo: los cambios se guardan solo en local."}
          </span>
          <Link to="/watch/aqz-KE-bpKQ">Abrir vídeo de prueba</Link>
        </div>
      )}
      <section className="feed-section">
        <div className="feed-controls">
          <div className="feed-filter-row">
            <div className="segmented" aria-label="Filtrar vídeos">
              {[
                ["pending", "Pendientes"],
                ["all", "Todos"],
                ["watched", "Vistos"],
              ].map(([value, label]) => (
                <button
                  className={status === value ? "active" : ""}
                  key={value}
                  onClick={() => filter("status", value)}
                  aria-pressed={status === value}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              className="type-filters"
              role="group"
              aria-label="Filtrar por tipo"
            >
              {feedVideoTypes.map((type) => (
                <button
                  key={type.value}
                  className={types.includes(type.value) ? "active" : ""}
                  aria-pressed={types.includes(type.value)}
                  onClick={() => toggleType(type.value)}
                >
                  {type.label}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-actions">
            <label className="channel-select">
              <span className="sr-only">Filtrar por canal</span>
              <select
                value={channel}
                onChange={(e) => filter("channelId", e.target.value)}
              >
                <option value="">Todos los canales</option>
                {channels?.items
                  .filter((c) => c.subscribed)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className={`icon-button ${bulk ? "active" : ""}`}
              aria-label="Opciones de marcado masivo"
              aria-expanded={bulk}
              onClick={() => setBulk(!bulk)}
            >
              <Icon name="more" />
            </button>
          </div>
        </div>
        {bulk && (
          <div className="bulk-panel">
            <span>Marcar vídeos</span>
            <button
              className="button small secondary"
              disabled={busy}
              onClick={() => mark("all")}
            >
              Marcar todos como vistos
            </button>
            {channel && (
              <button
                className="button small secondary"
                disabled={busy}
                onClick={() => mark("channel")}
              >
                Marcar este canal
              </button>
            )}
            <label>
              Antes de{" "}
              <input
                type="date"
                value={before}
                onChange={(e) => setBefore(e.target.value)}
              />
            </label>
            <button
              className="button small"
              disabled={!before || busy}
              onClick={() => mark("before")}
            >
              Aplicar fecha
            </button>
          </div>
        )}
        {error && (
          <State error>
            {error}{" "}
            <button onClick={() => setVersion((v) => v + 1)}>Reintentar</button>
          </State>
        )}
        <div className="video-grid">
          {videos.map((v) => (
            <VideoCard key={v.id} video={v} onChange={change} />
          ))}
        </div>
        {busy && <State>Cargando tu feed…</State>}
        {!busy && !error && videos.length === 0 && (
          <div className="empty-state">
            <h2>
              {types.length === 0
                ? "No hay tipos seleccionados"
                : status === "pending"
                  ? "No hay vídeos pendientes"
                  : "No hay vídeos en este filtro"}
            </h2>
            <p>
              {types.length === 0
                ? "Activa al menos un tipo para ver vídeos."
                : status === "pending"
                  ? "Cuando haya novedades de tus canales aparecerán aquí."
                  : "Prueba con otro filtro o actualiza la sincronización."}
            </p>
            {status !== "all" && types.length > 0 && (
              <button
                className="button secondary"
                onClick={() => filter("status", "all")}
              >
                Ver todos los vídeos
              </button>
            )}
          </div>
        )}
        {cursor && !busy && (
          <div className="load-more">
            <button className="button secondary" onClick={more}>
              Cargar más vídeos <Icon name="plus" size={17} />
            </button>
          </div>
        )}
      </section>
    </>
  );
}
function Channels() {
  const [q, setQ] = useState(""),
    [version, setVersion] = useState(0),
    [newId, setNewId] = useState("");
  const { data, error, loading } = useResource<{ items: Channel[] }>(
    `/api/channels?q=${encodeURIComponent(q)}`,
    version,
  );
  const { notify, session } = useApp();
  async function toggle(c: Channel) {
    try {
      await api(
        c.subscribed ? `/api/subscriptions/${c.id}` : "/api/subscriptions",
        c.subscribed ? "DELETE" : "POST",
        c.subscribed ? undefined : { channelId: c.id },
      );
      setVersion((v) => v + 1);
      notify(c.subscribed ? "Suscripción cancelada" : "Suscripción añadida");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <>
      <PageHeading
        title="Canales"
        description="Suscripciones y búsqueda."
        action={<SyncButton onDone={() => setVersion((v) => v + 1)} />}
      />
      <div className="search-input">
        <Icon name="search" size={20} />
        <input
          aria-label="Buscar canales"
          placeholder="Buscar canales"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {loading && <State>Cargando canales…</State>}
      {error && <State error>{error}</State>}
      <div className="channels-grid">
        {data?.items.map((c) => (
          <article className="channel-card" key={c.id}>
            <Link
              to={`/channels/${c.id}`}
              className="channel-avatar"
              aria-label={`Abrir ${c.title}`}
            >
              <img
                src={c.thumbnailUrl || "/thumbs/01.svg"}
                alt=""
                loading="lazy"
              />
            </Link>
            <div className="channel-copy">
              <h2>
                <Link to={`/channels/${c.id}`}>{c.title}</Link>
              </h2>
              <p>{c.description || "Sin descripción."}</p>
              <button
                className={`button small ${c.subscribed ? "secondary" : ""}`}
                onClick={() => toggle(c)}
              >
                <Icon name={c.subscribed ? "check" : "plus"} size={16} />
                {c.subscribed ? "Siguiendo" : "Seguir"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {data && !data.items.length && (
        <State>
          {q
            ? "No hay canales que coincidan con la búsqueda."
            : "Aún no hay canales suscritos."}
        </State>
      )}
      {session.mode === "real" && (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/api/subscriptions", "POST", {
                channelId: newId.trim(),
              });
              setNewId("");
              setVersion((v) => v + 1);
              notify("Suscripción añadida en YouTube");
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        >
          <input
            aria-label="ID del nuevo canal"
            placeholder="ID de canal de YouTube (UC…)"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            required
          />
          <button className="button">Suscribirse en YouTube</button>
        </form>
      )}
    </>
  );
}
function ChannelPage() {
  const { id } = useParams();
  const { data: channels } = useResource<{ items: Channel[] }>("/api/channels");
  const channel = channels?.items.find((c) => c.id === id);
  return (
    <>
      <Link to="/channels" className="back-link">
        <Icon name="back" size={16} /> Canales
      </Link>
      <PageHeading
        title={channel?.title || "Canal"}
        description={
          channel?.description ||
          "Vídeos de este canal guardados en la biblioteca."
        }
      />
      <ChannelVideos id={id!} />
    </>
  );
}
function ChannelVideos({ id }: { id: string }) {
  const [version, setVersion] = useState(0),
    [extra, setExtra] = useState<Video[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const { data, error, loading } = useResource<{
    items: Video[];
    nextCursor: string | null;
  }>(`/api/channels/${id}/videos?limit=12`, version);
  const { notify } = useApp();
  useEffect(() => {
    setExtra([]);
    setCursor(data?.nextCursor || null);
  }, [data]);
  return (
    <>
      {error && <State error>{error}</State>}
      {loading && <State>Cargando vídeos…</State>}
      <div className="video-grid">
        {[...(data?.items || []), ...extra].map((v) => (
          <VideoCard
            key={v.id}
            video={v}
            onChange={() => setVersion((x) => x + 1)}
          />
        ))}
      </div>
      {data && !data.items.length && (
        <State>Este canal aún no tiene vídeos en la biblioteca.</State>
      )}
      {cursor && (
        <button
          className="button secondary"
          onClick={async () => {
            try {
              const d = await api<{
                items: Video[];
                nextCursor: string | null;
              }>(
                `/api/channels/${id}/videos?limit=12&cursor=${encodeURIComponent(cursor)}`,
              );
              setExtra((x) => [...x, ...d.items]);
              setCursor(d.nextCursor);
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        >
          Cargar más
        </button>
      )}
    </>
  );
}
function RemoteListSync({ id, onDone }: { id?: string; onDone: () => void }) {
  const endpoint = id ? `/api/playlists/${id}/sync` : "/api/sync/status";
  const { data, setData, error, refresh } = useSyncStatus(endpoint);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const { notify } = useApp();
  const activeSeen = useRef(false);
  const job = data?.jobs?.find((j) =>
    id ? j.playlistId === id : j.type === "playlists" && !j.playlistId,
  );
  const active = !!job && isActiveSyncJob(job);
  useEffect(() => {
    if (active) activeSeen.current = true;
    else if (job?.status === "success" && activeSeen.current) {
      activeSeen.current = false;
      onDone();
    }
  }, [active, job?.status, onDone]);
  return (
    <div className="settings-buttons" data-testid="remote-list-sync">
      <button
        className="button secondary"
        disabled={busy || active}
        onClick={async () => {
          setBusy(true);
          setFailure("");
          try {
            const next = await api<SyncSummary>(
              id ? `/api/playlists/${id}/sync` : "/api/sync",
              "POST",
              id ? {} : { type: "playlists" },
            );
            if (next.job) {
              activeSeen.current = true;
              setData({ runs: [], jobs: [next.job] });
            }
            refresh();
            notify(
              id
                ? "Actualización de esta lista en cola."
                : "Actualización del catálogo en cola.",
            );
          } catch (e) {
            setFailure((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {id ? "Actualizar desde YouTube" : "Actualizar catálogo de YouTube"}
      </button>
      {job && (
        <small role="status">
          {syncJobStatusLabel(job.status)}
          {job.status === "error" && job.message ? `: ${job.message}` : ""}
        </small>
      )}
      {(failure || error) && <small role="alert">{failure || error}</small>}
    </div>
  );
}
function Playlists() {
  const { session } = useApp();
  const [version, setVersion] = useState(0),
    [open, setOpen] = useState(false);
  const { data, error, loading } = useResource<{ items: PlaylistSummary[] }>(
    "/api/playlists",
    version,
  );
  return (
    <>
      <PageHeading
        title="Listas"
        action={
          <button className="button" onClick={() => setOpen(!open)}>
            <Icon name="plus" size={18} />
            Nueva lista
          </button>
        }
      />
      {session.mode === "real" && session.connected && (
        <RemoteListSync onDone={() => setVersion((v) => v + 1)} />
      )}
      {open && (
        <PlaylistForm
          onDone={() => {
            setVersion((v) => v + 1);
            setOpen(false);
          }}
        />
      )}
      {loading && <State>Cargando listas…</State>}
      {error && <State error>{error}</State>}
      <div className="playlist-grid">
        {data?.items.map((p) => (
          <Link className="playlist-card" key={p.id} to={`/playlists/${p.id}`}>
            <span className="playlist-icon">
              <Icon name={p.source === "local" ? "lists" : "save"} size={22} />
            </span>
            <div className="playlist-card-copy">
              <h2>{p.title}</h2>
              <p>{p.description || "Sin descripción."}</p>
              <span className="playlist-meta">
                {p.itemCount} vídeos ·{" "}
                {p.source === "local" ? "Local" : "YouTube"}
              </span>
            </div>
            <Icon name="chevron" size={18} />
          </Link>
        ))}
      </div>
      {data && !data.items.length && (
        <State>Crea tu primera lista o actualiza el catálogo de YouTube.</State>
      )}
      <p className="muted-note">
        Las listas locales no se sincronizan con YouTube.
      </p>
    </>
  );
}
function PlaylistForm({
  onDone,
  playlist,
}: {
  onDone: () => void;
  playlist?: PlaylistDetail;
}) {
  const [title, setTitle] = useState(playlist?.title || ""),
    [description, setDescription] = useState(playlist?.description || ""),
    [source, setSource] = useState("local"),
    [busy, setBusy] = useState(false);
  const { notify, session } = useApp();
  return (
    <form
      className="edit-panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api(
            playlist ? `/api/playlists/${playlist.id}` : "/api/playlists",
            playlist ? "PATCH" : "POST",
            { title, description, source },
          );
          notify("Lista guardada");
          onDone();
        } catch (e) {
          notify((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Nombre
        <input
          value={title}
          maxLength={200}
          required
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Descripción
        <textarea
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {!playlist && session.mode === "real" && (
        <label>
          Guardar en
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="local">Solo en Alveo</option>
            <option value="youtube">YouTube (privada)</option>
          </select>
        </label>
      )}
      <button className="button" disabled={busy}>
        Guardar lista
      </button>
    </form>
  );
}
function PlaylistPage() {
  const { id } = useParams();
  const [version, setVersion] = useState(0),
    [edit, setEdit] = useState(false),
    [confirm, setConfirm] = useState(false);
  const { data, error, loading } = useResource<PlaylistDetail>(
    `/api/playlists/${id}`,
    version,
  );
  const { notify, session } = useApp(),
    navigate = useNavigate();
  return (
    <>
      <Link className="back-link" to="/playlists">
        <Icon name="back" size={16} /> Listas
      </Link>
      {loading && <State>Cargando lista…</State>}
      {error && <State error>{error}</State>}
      {data && (
        <>
          <PageHeading
            title={data.title}
            description={
              data.description ||
              `${data.items.length} vídeos · ${data.source === "local" ? "Lista local" : "Lista de YouTube"}`
            }
            action={
              <button
                className="button secondary"
                onClick={() => setEdit(!edit)}
              >
                Editar lista
              </button>
            }
          />
          {data.source === "youtube" &&
            session.mode === "real" &&
            session.connected && (
              <RemoteListSync
                id={id!}
                onDone={() => setVersion((v) => v + 1)}
              />
            )}
          {edit && (
            <>
              <PlaylistForm
                playlist={data}
                onDone={() => {
                  setEdit(false);
                  setVersion((v) => v + 1);
                }}
              />
              <button
                className="danger-link"
                onClick={() => setConfirm(!confirm)}
              >
                Eliminar lista
                {data.source === "youtube" ? " de YouTube" : ""}
              </button>
              {confirm && (
                <div className="bulk-panel">
                  Esta acción no se puede deshacer.
                  <button
                    className="button danger"
                    onClick={async () => {
                      try {
                        await api(`/api/playlists/${id}`, "DELETE");
                        navigate("/playlists");
                        notify("Lista eliminada");
                      } catch (e) {
                        notify((e as Error).message);
                      }
                    }}
                  >
                    Confirmar eliminación
                  </button>
                </div>
              )}
            </>
          )}
          <div className="video-grid">
            {data.items.map((v) => (
              <VideoCard
                key={v.playlistItemId}
                video={v}
                onChange={() => setVersion((x) => x + 1)}
                extra={
                  <button
                    className="icon-button"
                    aria-label="Quitar de la lista"
                    title="Quitar de la lista"
                    onClick={async () => {
                      try {
                        await api(
                          `/api/playlists/${id}/items/${v.playlistItemId}`,
                          "DELETE",
                        );
                        setVersion((x) => x + 1);
                        notify("Vídeo retirado de la lista");
                      } catch (e) {
                        notify((e as Error).message);
                      }
                    }}
                  >
                    <Icon name="close" size={17} />
                  </button>
                }
              />
            ))}
          </div>
          {!data.items.length && (
            <State>
              Aún no hay vídeos. Abre uno y elige «Guardar» para añadirlo.
            </State>
          )}
        </>
      )}
    </>
  );
}
function WatchRoute() {
  const { id } = useParams();
  return <Watch key={id} id={id!} />;
}
function Watch({ id }: { id: string }) {
  const {
    data: video,
    setData: setVideo,
    error,
    loading,
  } = useResource<Video>(`/api/videos/${id}`);
  const [related, setRelated] = useState(false);
  const {
    data: suggestions,
    setData: setSuggestions,
    error: suggestionsError,
    loading: suggestionsLoading,
  } = useResource<{
    items: Video[];
    source?: string;
  }>(video && related ? `/api/videos/${id}/suggestions` : null);
  const { session, notify } = useApp();
  const [save, setSave] = useState(false),
    [comments, setComments] = useState(false);
  const revisionRef = useRef(0);
  const change = useCallback(
    (v: Video) => {
      revisionRef.current = v.revision ?? revisionRef.current;
      setVideo(v);
    },
    [setVideo],
  );
  useEffect(() => {
    if (video) revisionRef.current = video.revision ?? 0;
  }, [video]);
  if (loading) return <State>Cargando vídeo…</State>;
  if (error || !video)
    return (
      <State error>
        {error || "Vídeo no disponible."} <Link to="/feed">Volver al feed</Link>
      </State>
    );
  return (
    <div className="watch-layout">
      <div className="watch-primary">
        <div className="watch-back">
          <Link className="back-link" to="/feed">
            <Icon name="back" size={18} /> Feed
          </Link>
        </div>
        <Player
          video={video}
          onProgress={change}
          revisionRef={revisionRef}
          demo={session.mode === "demo"}
        />
        <div className="watch-details">
          <h1>{video.title}</h1>
          <div className="watch-channel">
            <Link
              to={`/channels/${video.channelId}`}
              className="watch-channel-name"
            >
              <span className="channel-initial">{video.channelTitle[0]}</span>
              <div>
                <strong>{video.channelTitle}</strong>
                <small>
                  {dateLabel(video.publishedAt)}
                  {video.viewCount != null
                    ? ` · ${new Intl.NumberFormat("es", { notation: "compact" }).format(video.viewCount)} visualizaciones`
                    : ""}
                </small>
              </div>
            </Link>
            <div className="watch-actions">
              <button
                className={`button small ${video.watched ? "" : "secondary"}`}
                onClick={async () => {
                  try {
                    change(
                      await api<Video>(`/api/videos/${id}/watch-state`, "PUT", {
                        watched: !video.watched,
                      }),
                    );
                    notify(
                      video.watched
                        ? "Marcado como pendiente"
                        : "Marcado como visto",
                    );
                  } catch (e) {
                    notify((e as Error).message);
                  }
                }}
              >
                <Icon name="check" size={16} />
                {video.watched ? "Visto" : "Marcar visto"}
              </button>
              <button
                className={`button small secondary ${save ? "selected" : ""}`}
                aria-expanded={save}
                onClick={() => setSave(!save)}
              >
                <Icon name="save" size={16} />
                Guardar
              </button>
              <a
                className="icon-button"
                href={`https://www.youtube.com/watch?v=${id}`}
                target="_blank"
                rel="noopener"
                aria-label="Abrir en YouTube"
                title="Abrir en YouTube"
              >
                <Icon name="external" size={18} />
              </a>
            </div>
          </div>
          {save && <SaveVideo id={id} onDone={() => setSave(false)} />}
          <details className="description">
            <summary>
              Descripción <Icon name="plus" size={16} />
            </summary>
            <p>{video.description || "No hay descripción disponible."}</p>
          </details>
          <div className="watch-state-note">
            <span className="status-dot" />
            {video.watched
              ? "Visto en Alveo"
              : video.positionSeconds > 0
                ? `${Math.round(video.percent)} % · progreso guardado en Alveo`
                : "Pendiente · Abrir no lo marca como visto"}
            <span>
              {video.isLive !== false
                ? "Duración no confirmada o directo: marcado manual"
                : "Estado propio, no historial de YouTube"}
            </span>
          </div>
          <section className="comments-section">
            <div className="section-title">
              <h2>Comentarios</h2>
              <button
                className="text-button"
                onClick={() => setComments(!comments)}
              >
                {comments ? "Ocultar" : "Cargar comentarios"}{" "}
                <Icon name="chevron" size={16} />
              </button>
            </div>
            {comments ? (
              <Comments videoId={id} />
            ) : (
              <p className="muted-note">
                No se cargan hasta que los pidas.
                {session.mode === "demo" && !session.capabilities.publicData
                  ? " En esta demo se necesitan datos públicos para verlos."
                  : " Comentarios reales de YouTube."}
              </p>
            )}
          </section>
        </div>
      </div>
      <aside className="watch-related">
        <div className="section-title">
          <h2>Vídeos relacionados</h2>
          <span>
            {session.capabilities.publicData
              ? "Búsqueda YouTube"
              : "Biblioteca"}
          </span>
        </div>
        <button
          className="button secondary"
          aria-expanded={related}
          onClick={() => setRelated((value) => !value)}
        >
          {related
            ? "Ocultar vídeos relacionados"
            : "Cargar vídeos relacionados"}
        </button>
        {related &&
          suggestions?.items
            .filter((v) => v.id !== id)
            .slice(0, 5)
            .map((v) => (
              <VideoCard
                key={v.id}
                video={v}
                compact
                onChange={(updated) =>
                  setSuggestions((current) =>
                    current
                      ? {
                          ...current,
                          items: current.items.map((item) =>
                            item.id === updated.id ? updated : item,
                          ),
                        }
                      : current,
                  )
                }
              />
            ))}
        {related && suggestionsLoading && (
          <State>Buscando vídeos relacionados…</State>
        )}
        {related && suggestionsError && <State error>{suggestionsError}</State>}
        {related &&
          !suggestionsLoading &&
          !suggestionsError &&
          !suggestions?.items.length && (
            <p className="muted-note">Sin más vídeos conocidos por ahora.</p>
          )}
        <div className="related-note">
          {session.capabilities.publicData
            ? "Búsqueda temática por etiquetas; si faltan, título y hashtags. Solo al solicitarla."
            : "Solo contenido de tu biblioteca."}
        </div>
      </aside>
    </div>
  );
}
function SaveVideo({ id, onDone }: { id: string; onDone: () => void }) {
  const { data, error, loading } = useResource<{ items: PlaylistSummary[] }>(
    "/api/playlists",
  );
  const { notify } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <div className="save-panel">
      <h3>Guardar en una lista</h3>
      {loading && <span>Cargando…</span>}
      {error && <State error>{error}</State>}
      {data?.items.map((p) => (
        <button
          key={p.id}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/playlists/${p.id}/items`, "POST", {
                videoId: id,
              });
              notify(`Guardado en ${p.title}`);
              onDone();
            } catch (e) {
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="lists" size={18} />
          <strong>{p.title}</strong>
          <span>{p.source === "youtube" ? "YouTube" : "Local"}</span>
          <Icon name="plus" size={17} />
        </button>
      ))}
      {!loading && !data?.items.length && (
        <Link to="/playlists">Crear lista</Link>
      )}
    </div>
  );
}
function Comments({
  videoId,
  parentId,
}: {
  videoId?: string;
  parentId?: string;
}) {
  const path = parentId
    ? `/api/comments/${parentId}/replies`
    : `/api/videos/${videoId}/comments`;
  const { data, error, loading } = useResource<CommentPage>(path);
  const [items, setItems] = useState<CommentItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [extraError, setExtraError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setItems(data?.items || []);
    setCursor(data?.nextCursor || null);
  }, [data]);
  return (
    <>
      {loading && <State>Cargando comentarios…</State>}
      {error && <State error>{error}</State>}
      {data && !items.length && (
        <State>
          {data.demo
            ? data.message ||
              "Configura una API key local para consultar comentarios públicos."
            : "No hay comentarios disponibles."}
        </State>
      )}
      {items.map((c) => (
        <Comment key={c.id} comment={c} />
      ))}
      {extraError && <State error>{extraError}</State>}
      {cursor && (
        <button
          className="button small secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const d = await api<CommentPage>(
                `${path}?cursor=${encodeURIComponent(cursor)}`,
              );
              setItems((v) => [...v, ...d.items]);
              setCursor(d.nextCursor);
              setExtraError("");
            } catch (e) {
              setExtraError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Cargar más
        </button>
      )}
    </>
  );
}
function Comment({ comment: c }: { comment: CommentItem }) {
  const [replies, setReplies] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  return (
    <article className="comment">
      <div className="comment-avatar">
        {c.avatarUrl && !avatarFailed ? (
          <img
            src={c.avatarUrl}
            alt=""
            loading="lazy"
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          c.author.replace(/^@/, "").slice(0, 1).toUpperCase()
        )}
      </div>
      <div>
        <strong>{c.author}</strong>
        <time>{dateLabel(c.publishedAt)}</time>
        <p>{c.text}</p>
        <small>{c.likeCount} Me gusta</small>
        {!!c.replyCount && (
          <button className="text-button" onClick={() => setReplies(!replies)}>
            {replies ? "Ocultar" : `Ver ${c.replyCount} respuestas`}
          </button>
        )}
        {replies && <Comments parentId={c.id} />}
      </div>
    </article>
  );
}
const SYNC_STATUS_POLL_MS = 3000;
function useSyncStatus(endpoint = "/api/sync/status") {
  const { session } = useApp();
  const enabled = session.mode === "demo" || session.connected;
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
function SettingsPage() {
  const { session, settings, updateSettings, notify, refreshSession } =
    useApp();
  const {
    data: syncStatus,
    setData: setSyncStatus,
    error: syncError,
    refresh: refreshSyncStatus,
  } = useSyncStatus();
  const currentJob =
    syncStatus?.jobs?.find(isActiveSyncJob) || syncStatus?.jobs?.[0];
  const [consent, setConsent] = useState(false);
  const [threshold, setThreshold] = useState(settings.watchThreshold),
    [confirm, setConfirm] = useState("");
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    if (import.meta.env.PROD && "serviceWorker" in navigator)
      navigator.serviceWorker.getRegistration().then((r) => setInstalled(!!r));
  }, []);
  const params = new URLSearchParams(useLocation().search);
  return (
    <>
      <PageHeading title="Configuración" />
      {params.get("connect") === "error" && (
        <State error>
          No se pudo completar la conexión. Revisa la configuración OAuth local.
        </State>
      )}
      <div className="settings-grid">
        <section className="settings-card">
          <h2>Cuenta de YouTube</h2>
          <p>
            {session.mode === "demo"
              ? "Modo demo. Los cambios no afectan a tu cuenta de YouTube."
              : session.connected
                ? `Conectada: ${session.account?.name}`
                : "Conecta tu cuenta para importar suscripciones y listas."}
          </p>
          <div className="pill-row">
            <span className="pill">
              {session.mode === "demo"
                ? session.capabilities.publicData
                  ? "API pública"
                  : "Demo"
                : session.connected
                  ? "Conectada"
                  : "No conectado"}
            </span>
            <span
              className={`pill edit-auth ${session.capabilities.youtubeWrites ? "authorized" : "denied"}`}
            >
              {session.capabilities.youtubeWrites
                ? "Edición autorizada"
                : "Edición no autorizada"}
            </span>
          </div>
          {session.mode === "real" && !session.connected && (
            <label className="consent-label">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              He leído y acepto la privacidad descrita abajo y los términos de
              YouTube.
            </label>
          )}
          {session.mode === "real" && (
            <div className="settings-buttons">
              <a
                className={`button ${!consent && !session.connected ? "is-disabled" : ""}`}
                aria-disabled={!consent && !session.connected}
                href="/auth/google/start"
                onClick={(event) => {
                  if (!consent && !session.connected) event.preventDefault();
                }}
              >
                {session.connected
                  ? "Volver a conectar"
                  : "Conectar con Google"}
              </a>
              {session.connected && !session.capabilities.youtubeWrites && (
                <a
                  className="button secondary"
                  href="/auth/google/start?scope=write"
                >
                  Permitir edición en YouTube
                </a>
              )}
            </div>
          )}
          {session.mode === "demo" && (
            <p className="muted-note">
              Para activar el modo real, sigue los pasos de{" "}
              <code>README.md</code>. Las credenciales nunca se introducen en el
              navegador.
            </p>
          )}
        </section>
        <section className="settings-card">
          <h2>Marcar como visto</h2>
          <p>
            Marca el vídeo automáticamente al alcanzar este porcentaje. No
            sincroniza el historial de YouTube.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await updateSettings({
                  watchThreshold: threshold,
                });
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            <div className="threshold-value">
              {threshold}
              <span>%</span>
            </div>
            <label>
              <span className="sr-only">Umbral de visto</span>
              <input
                type="range"
                min="1"
                max="100"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </label>
            <button className="button small secondary">Guardar umbral</button>
          </form>
          <p className="muted-note">
            El marcado manual tiene prioridad. Directos y duración desconocida:
            usa el marcado manual.
          </p>
        </section>
        <section className="settings-card">
          <h2>Apariencia</h2>
          <p>Tema de la interfaz.</p>
          <div className="theme-options">
            {[
              ["system", "Sistema"],
              ["light", "Claro"],
              ["dark", "Oscuro"],
            ].map(([value, label]) => (
              <button
                aria-pressed={settings.theme === value}
                className={settings.theme === value ? "active" : ""}
                key={value}
                onClick={() =>
                  updateSettings({
                    theme: value as Settings["theme"],
                  }).catch((e) => notify(e.message))
                }
              >
                {label}
              </button>
            ))}
          </div>
          <h3>Instalar en Android</h3>
          <p className="muted-note">
            En Chrome, abre la versión compilada y elige «Añadir a pantalla de
            inicio».
          </p>
          <span className="pill">
            {installed
              ? "Service Worker registrado"
              : "Caché estática disponible en preview"}
          </span>
        </section>
        <section className="settings-card">
          <h2>Sincronización</h2>
          <p>
            {session.mode === "demo"
              ? session.capabilities.publicData
                ? "La vista de vídeo consulta datos públicos reales. Este botón no importa tu cuenta: eso requiere OAuth."
                : "En esta demo no se contacta con YouTube ni con feeds RSS."
              : "Importa cambios de YouTube y descubre vídeos de tus canales."}
          </p>
          <SyncButton
            onDone={(job) => {
              if (job)
                setSyncStatus((previous) =>
                  previous
                    ? {
                        ...previous,
                        jobs: mergeSyncJobs(previous.jobs, job),
                      }
                    : { runs: [], jobs: [job] },
                );
              refreshSyncStatus();
            }}
          />
          {currentJob && (
            <div className="sync-run" data-testid="sync-job">
              <div className="sync-run-head">
                <strong>Sincronización en servidor</strong>
                <span className={`sync-status ${currentJob.status}`}>
                  {syncJobStatusLabel(currentJob.status)}
                </span>
              </div>
              <small className="sync-summary">
                Fase:{" "}
                {currentJob.phase
                  ? syncJobPhases[currentJob.phase] || "Preparando"
                  : "Preparando"}
                {syncJobCounters(currentJob)
                  ? ` · ${syncJobCounters(currentJob)}`
                  : ""}
                {currentJob.updatedAt
                  ? ` · actualizado ${dateLabel(currentJob.updatedAt)}`
                  : ""}
              </small>
              {currentJob.message && currentJob.status !== "success" && (
                <small
                  className={
                    currentJob.status === "error"
                      ? "sync-error"
                      : "sync-summary"
                  }
                >
                  {shortText(currentJob.message)}
                </small>
              )}
              {currentJob.nextAttemptAt &&
                (currentJob.status === "paused" ||
                  currentJob.status === "retrying") && (
                  <small className="sync-summary">
                    Reintento automático:{" "}
                    {syncJobNextAttempt(currentJob.nextAttemptAt)}
                  </small>
                )}
              {isActiveSyncJob(currentJob) && (
                <small className="sync-summary">
                  Se actualizará automáticamente cada 3 s. Puedes cerrar la
                  página: el servidor continúa.
                </small>
              )}
            </div>
          )}
          {syncError && (
            <small className="sync-error">
              Estado no disponible: {syncError}
            </small>
          )}
          <div className="sync-history">
            {syncStatus?.runs?.slice(0, 4).map((r) => {
              const summary = summarizeSyncDetail(r.detail);
              return (
                <div className="sync-run" key={r.id}>
                  <div className="sync-run-head">
                    <strong>{syncTypeLabels[r.type] || r.type}</strong>
                    <span className={`sync-status ${r.status}`}>
                      {syncStatusLabel(r.status)}
                    </span>
                  </div>
                  <small className="sync-summary">
                    {dateLabel(r.startedAt)}
                    {r.items ? ` · ${r.items} elementos` : ""}
                    {summary ? ` · ${summary}` : ""}
                  </small>
                  {r.error && (
                    <small className="sync-error">{shortText(r.error)}</small>
                  )}
                </div>
              );
            })}
            {syncStatus && !syncStatus.runs?.length && (
              <small className="sync-summary">
                No hay sincronizaciones registradas.
              </small>
            )}
          </div>
        </section>
      </div>
      <section className="privacy-section" id="privacy">
        <h2>Privacidad y datos</h2>
        <p>
          {session.capabilities.publicData
            ? "Con API pública configurada, metadatos, comentarios y vídeos del canal se consultan en YouTube y se guardan temporalmente en D1. Las suscripciones de prueba y los guardados siguen siendo locales. "
            : "Sin API key, la demo usa metadatos ficticios y recursos locales. "}
          Al abrir un vídeo se carga el reproductor oficial de YouTube. La
          reproducción se inicia con sus controles. La reproducción oficial
          puede incluir anuncios, cookies y restricciones de YouTube. No
          descargamos vídeos ni bloqueamos su publicidad.
        </p>
        <p>
          En modo real almacenamos tus suscripciones, listas, preferencias y
          estado propio en D1 local. Los tokens se cifran en el backend. Los
          metadatos externos se renuevan o eliminan según su vigencia. Puedes
          desconectar y borrar tus datos sin eliminar tus listas ni
          suscripciones de YouTube.
        </p>
        <p>
          Al usar la integración aceptas los{" "}
          <a
            href="https://www.youtube.com/t/terms"
            target="_blank"
            rel="noopener"
          >
            Términos de YouTube
          </a>
          . Consulta la{" "}
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noopener"
          >
            Privacidad de Google
          </a>{" "}
          y{" "}
          <a
            href="https://security.google.com/settings/security/permissions"
            target="_blank"
            rel="noopener"
          >
            gestiona los permisos de tu cuenta
          </a>
          . Esta prueba de concepto no es un producto de Google ni cuenta con
          una aprobación de YouTube.
        </p>
        {session.mode === "real" && session.connected && (
          <>
            <div className="settings-buttons">
              <button
                className="button secondary"
                onClick={() => setConfirm("disconnect")}
              >
                Desconectar y borrar datos autorizados
              </button>
              <button
                className="danger-link"
                onClick={() => setConfirm("delete")}
              >
                Borrar mis datos de Alveo
              </button>
              <button
                className="text-button"
                onClick={async () => {
                  await api("/auth/logout", "POST", {});
                  await refreshSession();
                }}
              >
                Cerrar sesión
              </button>
            </div>
            {confirm && (
              <div className="bulk-panel">
                <p>
                  Se borrarán los datos locales de esta cuenta. Tus datos en
                  YouTube no se eliminan.
                </p>
                <button
                  className="button danger"
                  onClick={async () => {
                    try {
                      await api(
                        confirm === "delete"
                          ? "/api/account/data"
                          : "/api/account/disconnect",
                        confirm === "delete" ? "DELETE" : "POST",
                        {},
                      );
                      await refreshSession();
                      setConfirm("");
                      notify("Datos de cuenta eliminados");
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  Confirmar borrado local
                </button>
                <button
                  className="button secondary"
                  onClick={() => setConfirm("")}
                >
                  Cancelar
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* La app sigue disponible sin caché estática. */
    });
  });
}
