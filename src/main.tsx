import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ViewTransition,
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
  useNavigationType,
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
  type SearchResource,
  type SessionInfo,
  type Settings,
  type Video,
} from "./api";
import { Icon, State, useResource, VideoCard } from "./ui";
import { Player } from "./player";
import { MotionPanel, usePresence } from "./motion";
import { videoType, type VideoType } from "../shared/video-type";
import { syncTypeLabels, syncStatusLabel, syncJobPhases, syncJobStatusLabel, isActiveSyncJob, syncJobCounters, syncJobNextAttempt, syncJobNotice, shortText, summarizeSyncDetail, type SyncJob, type SyncSummary } from "./sync-status";
import { useSyncStatus } from "./use-sync-status";
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
  ["/search", "search", "Buscar"],
  ["/channels", "channels", "Canales"],
  ["/playlists", "lists", "Listas"],
  ["/settings", "settings", "Configuración"],
];
function matchesSearch(query: string, ...values: string[]) {
  const normalize = (value: string) =>
    value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
  const needle = normalize(query.trim());
  return !needle || values.some((value) => normalize(value).includes(needle));
}
function App() {
  const [session, sessionSet] = useState<SessionInfo | null>(null),
    [settings, settingsSet] = useState<Settings>({ theme: "system", pureBlack: false }),
    [error, errorSet] = useState(""),
    [toast, toastSet] = useState("");
  const location = useLocation();
  const navigationType = useNavigationType();
  const watching = location.pathname.startsWith("/watch/");
  const watchId = location.pathname.match(/^\/watch\/([^/]+)$/)?.[1];
  const [activeVideoId, setActiveVideoId] = useState<string | null>(
    watchId ?? null,
  );
  const transitionEnabled = !watching && !activeVideoId;
  const hasViewTransitions = typeof document.startViewTransition === "function";
  const routeFallback = transitionEnabled && (!hasViewTransitions || navigationType === "POP");
  useEffect(() => {
    if (watchId) setActiveVideoId(watchId);
  }, [watchId]);
  useEffect(() => {
    if (session?.mode === "real" && !session.connected) setActiveVideoId(null);
  }, [session?.mode, session?.connected]);
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
    document.documentElement.dataset.theme =
      settings.theme === "dark" && settings.pureBlack ? "black" : settings.theme;
    document.documentElement.dataset.pureBlack = String(settings.pureBlack);
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
  }, [settings.theme, settings.pureBlack]);
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
  const routeContent = (
    <div
      className={`route-content ${routeFallback ? "route-fallback" : ""}`}
      key={routeFallback ? location.pathname : undefined}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/feed" replace />} />
        <Route path="/feed" element={<Feed />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/channels" element={<Channels />} />
        <Route path="/channels/:id" element={<ChannelPage />} />
        <Route path="/playlists" element={<Playlists />} />
        <Route path="/playlists/external/:id" element={<ExternalPlaylistPage />} />
        <Route path="/playlists/:id" element={<PlaylistPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/watch/:id" element={null} />
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
    </div>
  );
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
            className={`${watching ? "watch-main" : "page-main"} ${activeVideoId && !watching ? "has-mini-player" : ""}`}
          >
            {activeVideoId && (
              <Watch
                key={activeVideoId}
                id={activeVideoId}
                minimized={!watching || watchId !== activeVideoId}
                onClose={() => setActiveVideoId(null)}
              />
            )}
            {session.mode === "real" &&
            !session.connected &&
            location.pathname !== "/settings" ? (
              <Navigate to="/settings" replace />
            ) : (
              transitionEnabled ? (
                <ViewTransition default="none" update="page-fade">
                  {routeContent}
                </ViewTransition>
              ) : routeContent
            )}
          </main>
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
  description?: ReactNode;
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
function LoadMore({ cursor, busy, error, onLoad }: {
  cursor: string | null;
  busy: boolean;
  error?: string;
  onLoad: () => void;
}) {
  const marker = useRef<HTMLDivElement>(null);
  const load = useRef(onLoad);
  const requested = useRef<string | null>(null);
  load.current = onLoad;
  useEffect(() => {
    if (!cursor) {
      requested.current = null;
      return;
    }
    if (busy || error || requested.current === cursor || !marker.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      requested.current = cursor;
      observer.disconnect();
      load.current();
    }, { rootMargin: "320px 0px" });
    observer.observe(marker.current);
    return () => observer.disconnect();
  }, [cursor, busy, error]);
  if (!cursor) return null;
  return <div className="load-more" ref={marker}>
    {busy && <span role="status">Cargando más…</span>}
    {error && <State error>{error} <button onClick={() => {
      requested.current = cursor;
      load.current();
    }}>Reintentar</button></State>}
  </div>;
}
function SyncButton({ onDone, type = "subscriptions", label = "Actualizar" }: { onDone?: (job?: SyncJob) => void; type?: "subscriptions" | "rss"; label?: string } = {}) {
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
            type,
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
                type,
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
      {busy ? "Sincronizando…" : label}
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
  const status = search.get("status") || "pending";
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
    [version, setVersion] = useState(0);
  const { session } = useApp();
  const loadGeneration = useRef(0);
  const loadedQuery = useRef<string | null>(null);
  useEffect(() => {
    if (!session.capabilities.automaticDiscovery) return;
    let revision: string | null = null;
    let checking = false;
    const controller = new AbortController();
    const check = async () => {
      if (document.visibilityState !== "visible" || checking) return;
      checking = true;
      try {
        const next = await api<{ revision: string }>(
          "/api/feed/revision",
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          const changed = revision !== null && revision !== next.revision;
          revision = next.revision;
          if (changed) setVersion((v) => v + 1);
        }
      } catch {
        // A later visit or focus will retry; feed requests report their own errors.
      } finally {
        checking = false;
      }
    };
    void check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [session.capabilities.automaticDiscovery]);
  const query = new URLSearchParams({
    status,
    types: typesParam,
    limit: "18",
  }).toString();
  useEffect(() => {
    // Normalize older feed links, including the removed channel filter.
    if (rawTypes !== null && !search.has("channelId")) return;
    const next = new URLSearchParams(search);
    if (rawTypes === null) next.set("types", DEFAULT_FEED_TYPES);
    next.delete("channelId");
    setSearch(next, { replace: true });
  }, [rawTypes, search, setSearch]);
  useEffect(() => {
    loadGeneration.current++;
    let active = true;
    const queryChanged = loadedQuery.current !== query;
    loadedQuery.current = query;
    setBusy(true);
    // Keep the current cards visible while checking a newer feed revision.
    if (queryChanged) setVideos([]);
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
    if (!cursor || busy) return;
    const generation = loadGeneration.current;
    setBusy(true);
    setError("");
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
  return (
    <>
      <PageHeading title="Feed" />
      {session.mode === "demo" && (
        <div className="demo-banner">
          <Icon name="info" size={16} />
          <span>
            {session.capabilities.publicData
              ? "Demo · datos públicos"
              : "Demo · solo local"}
          </span>
          <Link to="/watch/aqz-KE-bpKQ">Vídeo de prueba</Link>
        </div>
      )}
      <section className="feed-section">
        <div className="feed-controls">
          <div className="feed-filter-row">
            <div className="segmented" aria-label="Filtrar vídeos">
              {[
                ["pending", "Pendientes"],
                ["all", "Todos"],
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
        </div>
        {error && !cursor && (
          <State error>
            {error}{" "}
            <button onClick={() => setVersion((v) => v + 1)}>Reintentar</button>
          </State>
        )}
        <div className="video-grid">
          {videos.map((v, index) => (
            <VideoOptionsCard key={v.id} video={v} onChange={change} swipeToWatch eagerThumbnail={index < 3} />
          ))}
        </div>
        {busy && !videos.length && (
          <>
            <div className="video-grid" aria-hidden="true">
              {Array.from({ length: 6 }, (_, i) => (
                <div className="video-skeleton" key={i}>
                  <div className="skeleton-thumb" />
                  <div className="skeleton-copy">
                    <div className="skeleton-line short" />
                    <div className="skeleton-line wide" />
                    <div className="skeleton-line short" />
                  </div>
                </div>
              ))}
            </div>
            <span className="sr-only" role="status">
              Cargando tu feed…
            </span>
          </>
        )}
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
        <LoadMore cursor={cursor} busy={busy} error={error} onLoad={() => void more()} />
      </section>
    </>
  );
}
function VideoOptionsCard({ video, onChange, swipeToWatch = false, eagerThumbnail = false, extra }: {
  video: Video;
  onChange: (video: Video) => void;
  swipeToWatch?: boolean;
  eagerThumbnail?: boolean;
  extra?: ReactNode;
}) {
  const [save, setSave] = useState(false);
  const [open, setOpen] = useState(false);
  const menuMounted = usePresence(open);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);
  return <div className="video-options-result">
    <VideoCard video={video} onChange={onChange} swipeToWatch={swipeToWatch} eagerThumbnail={eagerThumbnail} extra={extra} renderAction={({ toggleWatched, busy }) =>
      <div className="video-card-menu" ref={menu}>
        <button className="icon-button" aria-label={`Opciones de ${video.title}`}
          aria-expanded={open} title="Opciones del vídeo" onClick={() => setOpen((value) => !value)}>
          <Icon name="more" size={18} />
        </button>
        {menuMounted && <div className={`video-card-menu-items ${open ? "" : "is-closing"}`} inert={!open} aria-hidden={!open}>
          <button disabled={busy} onClick={() => {
            setOpen(false);
            toggleWatched();
          }}><Icon name="check" size={17} />{video.watched ? "Marcar pendiente" : "Marcar visto"}</button>
          <button onClick={() => {
            setOpen(false);
            setSave(true);
          }}><Icon name="save" size={17} />Guardar</button>
          <Link to={`/channels/${video.channelId}`}><Icon name="channels" size={17} />Ver canal</Link>
        </div>}
      </div>
    } />
    <MotionPanel open={save}><SaveVideo id={video.id} onDone={() => setSave(false)} /></MotionPanel>
  </div>;
}
function Channels() {
  const [q, setQ] = useState(""),
    [excluded, setExcluded] = useState(false),
    [version, setVersion] = useState(0),
    [newId, setNewId] = useState("");
  const { data, setData, error, loading } = useResource<{ items: Channel[] }>(
    `/api/channels?excluded=${excluded}`,
    version,
  );
  const visibleChannels = data?.items.filter((c) => matchesSearch(q, c.title, c.description)) ?? [];
  const { notify, session } = useApp();
  async function toggle(c: Channel) {
    try {
      await api(
        c.subscribed ? `/api/subscriptions/${c.id}` : "/api/subscriptions",
        c.subscribed ? "DELETE" : "POST",
        c.subscribed ? undefined : { channelId: c.id },
      );
      setData((current) => current && ({
        ...current,
        items: current.items.map((item) => item.id === c.id
          ? { ...item, subscribed: !c.subscribed }
          : item),
      }));
      setVersion((v) => v + 1);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function setExclusion(c: Channel) {
    try {
      await api(`/api/channels/${c.id}/exclusion`, "PATCH", { excluded: !c.excluded });
      setData((current) => current && {
        ...current,
        items: current.items.filter((item) => item.id !== c.id),
      });
    } catch (e) { notify((e as Error).message); }
  }
  return (
    <>
      <PageHeading
        title="Canales"
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
      <div className="segmented exclusion-filter" aria-label="Filtrar canales">
        <button className={!excluded ? "active" : ""} aria-pressed={!excluded} onClick={() => setExcluded(false)}>Canales</button>
        <button className={excluded ? "active" : ""} aria-pressed={excluded} onClick={() => setExcluded(true)}>Excluidos</button>
      </div>
      {loading && <State>Cargando canales…</State>}
      {error && <State error>{error}</State>}
      <div className="channels-grid">
        {visibleChannels.map((c) => (
          <article className="channel-card" key={c.id}>
            <Link
              to={`/channels/${c.id}`}
              className="channel-avatar"
              aria-label={`Abrir ${c.title}`}
            >
              {/* Los recursos de demo son miniaturas 16:9, no avatares. */}
              {c.thumbnailUrl && !c.thumbnailUrl.startsWith("/thumbs/") ? (
                <img src={c.thumbnailUrl} alt="" loading="lazy" />
              ) : (
                <span aria-hidden="true">
                  {c.title.replace(/^@/, "").slice(0, 1).toUpperCase()}
                </span>
              )}
            </Link>
            <div className="channel-copy">
              <h2>
                <Link to={`/channels/${c.id}`}>{c.title}</Link>
              </h2>
              <p>{c.description || "Sin descripción."}</p>
              <div className="channel-actions">
                <button
                  className={`button small ${c.subscribed ? "secondary" : ""}`}
                  onClick={() => toggle(c)}
                >
                  <Icon name={c.subscribed ? "check" : "plus"} size={16} />
                  {c.subscribed ? "Siguiendo" : "Seguir"}
                </button>
                <button className="button small secondary" onClick={() => setExclusion(c)}>
                  {!c.excluded && <Icon name="close" size={16} />}
                  {c.excluded ? "Volver a incluir" : "Excluir de la aplicación"}
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {data && !visibleChannels.length && (
        <State>
          {q
            ? "No hay canales que coincidan con la búsqueda."
            : excluded ? "No hay canales excluidos." : "Aún no hay canales suscritos."}
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
  return <ChannelPageContent key={id} id={id!} />;
}
type ChannelVideoPage = {
  channel?: Pick<Channel, "id" | "title" | "description" | "thumbnailUrl" | "subscribed" | "subscriberCount">;
  items: Video[];
  nextCursor: string | null;
};
function ChannelPageContent({ id }: { id: string }) {
  const { session, notify } = useApp();
  const [markOpen, setMarkOpen] = useState(false);
  const [before, setBefore] = useState("");
  const [marking, setMarking] = useState(false);
  const [version, setVersion] = useState(0);
  const { data: channels } = useResource<{ items: Channel[] }>("/api/channels");
  const { data, error, loading } = useResource<ChannelVideoPage>(
    `/api/channels/${id}/videos?limit=18`,
    version,
  );
  const savedChannel = channels?.items.find((c) => c.id === id);
  const channel = data?.channel || savedChannel;
  async function markChannel(byDate: boolean) {
    if ((byDate && !before) || marking) return;
    setMarking(true);
    try {
      const result = await api<{ updated: number }>("/api/watch-state/bulk", "POST", {
        scope: byDate ? "channel_before" : "channel",
        channelId: id,
        before: byDate ? new Date(`${before}T00:00:00`).toISOString() : undefined,
      });
      notify(result.updated
        ? `${result.updated} vídeos marcados como vistos`
        : byDate
          ? "No hay vídeos pendientes anteriores a esa fecha en este canal"
          : "No hay vídeos pendientes en este canal");
      setMarkOpen(false);
      if (result.updated) setVersion((value) => value + 1);
    } catch (cause) {
      notify((cause as Error).message);
    } finally {
      setMarking(false);
    }
  }
  return (
    <>
      <Link to="/channels" className="back-link">
        <Icon name="back" size={16} /> Canales
      </Link>
      <PageHeading
        title={channel?.title || "Canal"}
        action={<div className="channel-heading-actions">
          {data?.channel && <SubscribeChannel channelId={id} subscribed={data.channel.subscribed} />}
          {savedChannel && <button className="button small secondary" aria-expanded={markOpen}
            onClick={() => setMarkOpen((open) => !open)}>
            <Icon name="check" size={16} /> Marcar vídeos
          </button>}
        </div>}
        description={<>
          {channel?.subscriberCount != null && <span className="channel-subscribers">
            {new Intl.NumberFormat("es-ES").format(channel.subscriberCount)} suscriptores
          </span>}
          {channel?.description || (session.capabilities.publicData
            ? "Vídeos públicos de este canal en YouTube."
            : "Vídeos de este canal guardados en la biblioteca.")}
        </>}
      />
      <MotionPanel open={markOpen}><div className="bulk-panel channel-mark-panel">
        <button className="button small secondary" disabled={marking}
          onClick={() => void markChannel(false)}>
          Marcar todos como vistos
        </button>
        <label>Antes de <input type="date" value={before}
          onChange={(event) => setBefore(event.target.value)} /></label>
        <button className="button small" disabled={!before || marking}
          onClick={() => void markChannel(true)}>
          {marking ? "Marcando…" : "Marcar como vistos"}
        </button>
      </div></MotionPanel>
      <ChannelVideos id={id} data={data} error={error} loading={loading} />
    </>
  );
}
function ChannelVideos({ id, data, error, loading }: {
  id: string;
  data: ChannelVideoPage | null;
  error: string;
  loading: boolean;
}) {
  const [extra, setExtra] = useState<Video[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [moreError, setMoreError] = useState(""),
    [updates, setUpdates] = useState<Record<string, Video>>({});
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setExtra([]);
    setCursor(data?.nextCursor || null);
    setMoreError("");
    setUpdates({});
    setBusy(false);
  }, [id, data]);
  async function more() {
    if (!cursor || busy) return;
    const requestGeneration = generation.current;
    setBusy(true);
    setMoreError("");
    try {
      const d = await api<{ items: Video[]; nextCursor: string | null }>(
        `/api/channels/${id}/videos?limit=18&cursor=${encodeURIComponent(cursor)}`,
      );
      if (requestGeneration !== generation.current) return;
      setExtra((x) => [...x, ...d.items]);
      setCursor(d.nextCursor);
    } catch (e) {
      if (requestGeneration === generation.current) setMoreError((e as Error).message);
    } finally {
      if (requestGeneration === generation.current) setBusy(false);
    }
  }
  return (
    <>
      {error && <State error>{error}</State>}
      {loading && <State>Cargando vídeos…</State>}
      <div className="video-grid">
        {[...(data?.items || []), ...extra].map((v) => (
          <VideoOptionsCard
            key={v.id}
            video={updates[v.id] || v}
            onChange={(updated) => setUpdates((current) => ({ ...current, [updated.id]: updated }))}
          />
        ))}
      </div>
      {data && !data.items.length && (
        <State>Este canal aún no tiene vídeos en la biblioteca.</State>
      )}
      <LoadMore cursor={cursor} busy={busy} error={moreError} onLoad={() => void more()} />
    </>
  );
}
function RemoteListSync({ id, onDone, showEmpty = false, initialImport = false }: {
  id?: string;
  onDone: () => void;
  showEmpty?: boolean;
  initialImport?: boolean;
}) {
  const endpoint = id ? `/api/playlists/${id}/sync` : "/api/sync/status";
  const { notify, session } = useApp();
  const { data, setData, error, refresh } = useSyncStatus(session.mode === "demo" || session.connected, endpoint);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const activeSeen = useRef(false);
  const completedJob = useRef<string | null>(null);
  const job = data?.jobs?.find((j) =>
    id ? j.playlistId === id : j.type === "playlists" && !j.playlistId,
  );
  const active = !!job && isActiveSyncJob(job);
  useEffect(() => {
    if (active) activeSeen.current = true;
    else if (job?.status === "success" && (activeSeen.current || initialImport) && completedJob.current !== job.id) {
      activeSeen.current = false;
      completedJob.current = job.id;
      onDone();
    }
  }, [active, job?.id, job?.status, initialImport, onDone]);
  return (
    <div className={`settings-buttons${id ? " playlist-detail-sync" : ""}`} data-testid="remote-list-sync">
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
            if (!id) notify("Actualización del catálogo en cola.");
          } catch (e) {
            setFailure((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon name="sync" size={18} />
        {active ? (initialImport ? "Importando…" : "Actualizando…") : "Actualizar"}
      </button>
      {id && active && !showEmpty && <small role="status">Actualizando en segundo plano…</small>}
      {showEmpty && <State>
        {!data && !error ? "Comprobando la importación…"
          : active ? `Importando vídeos de YouTube…${job?.items ? ` ${job.items} procesados.` : ""} Aparecerán aquí al terminar; puedes salir de esta página.`
          : job?.status === "paused" ? `Importación en pausa. Se reintentará automáticamente${job.nextAttemptAt ? ` el ${syncJobNextAttempt(job.nextAttemptAt)}` : ""}.`
          : job?.status === "error" ? "No se pudieron importar los vídeos. Pulsa Actualizar para reintentar."
          : initialImport && job?.status === "success" ? "Terminando la importación…"
          : initialImport ? "Esta lista está pendiente de importar. Pulsa Actualizar para empezar."
          : "Esta lista no tiene vídeos disponibles."}
      </State>}
      {job?.status === "error" && (
        <small role="alert">Error al actualizar{job.message ? `: ${job.message}` : ""}</small>
      )}
      {(failure || error) && <small role="alert">{failure || error}</small>}
    </div>
  );
}
function Playlists() {
  const { session, notify } = useApp();
  const [version, setVersion] = useState(0),
    [open, setOpen] = useState(false),
    [excluded, setExcluded] = useState(false),
    [q, setQ] = useState("");
  const { data, setData, error, loading } = useResource<{ items: PlaylistSummary[] }>(
    `/api/playlists?excluded=${excluded}`,
    version,
  );
  const visiblePlaylists = data?.items.filter((p) => matchesSearch(q, p.title, p.description)) ?? [];
  async function setExclusion(p: PlaylistSummary) {
    try {
      await api(`/api/playlists/${p.id}/exclusion`, "PATCH", { excluded: !p.excluded });
      setData((current) => current && {
        ...current,
        items: current.items.filter((item) => item.id !== p.id),
      });
    } catch (e) { notify((e as Error).message); }
  }
  return (
    <>
      <PageHeading
        title="Listas"
        action={<div className="playlist-heading-actions">
          {session.mode === "real" && session.connected && !excluded && (
            <RemoteListSync onDone={() => setVersion((v) => v + 1)} />
          )}
          <button className="button" onClick={() => setOpen(!open)}>
            <Icon name="plus" size={18} />
            Nueva lista
          </button>
        </div>}
      />
      <div className="search-input">
        <Icon name="search" size={20} />
        <input
          aria-label="Buscar listas"
          placeholder="Buscar listas"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="segmented exclusion-filter" aria-label="Filtrar listas">
        <button className={!excluded ? "active" : ""} aria-pressed={!excluded} onClick={() => setExcluded(false)}>Listas</button>
        <button className={excluded ? "active" : ""} aria-pressed={excluded} onClick={() => setExcluded(true)}>Excluidos</button>
      </div>
      <MotionPanel open={open}>
        <PlaylistForm
          onDone={() => {
            setVersion((v) => v + 1);
            setOpen(false);
          }}
        />
      </MotionPanel>
      {loading && <State>Cargando listas…</State>}
      {error && <State error>{error}</State>}
      <div className="playlist-grid">
        {visiblePlaylists.map((p) => (
          <article className="playlist-card" key={p.id}>
            <Link className="playlist-card-link" to={`/playlists/${p.id}`}>
              <span className="playlist-icon">
                <Icon name={p.source === "local" ? "lists" : "save"} size={22} />
              </span>
              <div className="playlist-card-copy">
                <h2>{p.title}</h2>
                <p>{p.description || "Sin descripción."}</p>
                <span className="playlist-meta">
                  {p.itemCount} vídeos ·{" "}
                  {p.source === "local" ? "Local" : p.followed ? "Lista ajena" : "YouTube"}
                </span>
              </div>
              <Icon name="chevron" size={18} />
            </Link>
            <div className="playlist-card-actions">
              <button className="button small secondary" onClick={() => setExclusion(p)}>
                {!p.excluded && <Icon name="close" size={16} />}
                {p.excluded ? "Volver a incluir" : "Excluir de la aplicación"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {data && !visiblePlaylists.length && (
        <State>{q ? "No hay listas que coincidan con la búsqueda." : excluded ? "No hay listas excluidas." : "Crea tu primera lista o actualiza el catálogo de YouTube."}</State>
      )}
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
  const { notify, session } = useApp();
  const [title, setTitle] = useState(playlist?.title || ""),
    [description, setDescription] = useState(playlist?.description || ""),
    [source] = useState(session.mode === "real" ? "youtube" : "local"),
    [busy, setBusy] = useState(false);
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
    [confirm, setConfirm] = useState(false),
    [removingItem, setRemovingItem] = useState<string | null>(null);
  const { data, setData, error, loading } = useResource<PlaylistDetail>(
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
              `${data.items.length} vídeos · ${data.source === "local" ? "Lista local" : data.followed ? "Lista ajena" : "Lista de YouTube"}`
            }
            action={data.followed ? undefined :
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
                showEmpty={!!data.followed && data.items.length === 0}
                initialImport={!!data.followed && data.itemsSyncedAt == null}
              />
            )}
          {data.followed && <button className="danger-link" onClick={() => setConfirm((value) => !value)}>
            Dejar de seguir
          </button>}
          {data.followed && <MotionPanel open={confirm}><div className="bulk-panel">
            <button className="button danger" onClick={async () => {
              try { await api(`/api/playlists/${id}`, "DELETE"); navigate("/playlists"); }
              catch (cause) { notify((cause as Error).message); }
            }}>Confirmar</button>
          </div></MotionPanel>}
          {!data.followed && <MotionPanel open={edit}>
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
              <MotionPanel open={confirm}>
                <div className="bulk-panel">
                  Esta acción no se puede deshacer.
                  <button
                    className="button danger"
                    onClick={async () => {
                      try {
                        await api(`/api/playlists/${id}`, "DELETE");
                        navigate("/playlists");
                      } catch (e) {
                        notify((e as Error).message);
                      }
                    }}
                  >
                    Confirmar eliminación
                  </button>
                </div>
              </MotionPanel>
          </MotionPanel>}
          <div className="video-grid">
            {data.items.map((v) => (
              <VideoOptionsCard
                key={v.playlistItemId}
                video={v}
                onChange={(updated) => setData((current) => current && ({
                  ...current,
                  items: current.items.map((item) => item.id === updated.id
                    ? { ...updated, playlistItemId: item.playlistItemId }
                    : item),
                }))}
                extra={data.followed ? undefined :
                  <button
                    className="icon-button"
                    aria-label={removingItem === v.playlistItemId ? "Quitando de la lista…" : "Quitar de la lista"}
                    title="Quitar de la lista"
                    disabled={removingItem !== null}
                    onClick={async () => {
                      if (!v.playlistItemId) return;
                      setRemovingItem(v.playlistItemId);
                      try {
                        await api(
                          `/api/playlists/${id}/items/${v.playlistItemId}`,
                          "DELETE",
                        );
                        setData((current) => current && ({
                          ...current,
                          itemCount: Math.max(0, current.itemCount - 1),
                          items: current.items.filter((item) => item.playlistItemId !== v.playlistItemId),
                        }));
                      } catch (e) {
                        notify((e as Error).message);
                      } finally {
                        setRemovingItem(null);
                      }
                    }}
                  >
                    <span className={removingItem === v.playlistItemId ? "spin" : ""}>
                      <Icon name={removingItem === v.playlistItemId ? "sync" : "close"} size={17} />
                    </span>
                  </button>
                }
              />
            ))}
          </div>
          {!data.items.length && !data.followed && (
            <State>
              Aún no hay vídeos. Abre uno y elige «Guardar» para añadirlo.
            </State>
          )}
        </>
      )}
    </>
  );
}
type ExternalPlaylistPageData = {
  playlist: (SearchResource & { itemCount: number }) | null;
  items: Video[];
  nextPageToken: string | null;
  localPlaylistId: string | null;
};
function ExternalPlaylistPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const backQuery = params.get("q") || "";
  const { session, notify } = useApp();
  const navigate = useNavigate();
  const { data, error, loading } = useResource<ExternalPlaylistPageData>(
    `/api/playlists/external/${id}`,
  );
  const [items, setItems] = useState<Video[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [following, setFollowing] = useState(false);
  const [moreError, setMoreError] = useState("");
  useEffect(() => {
    setItems(data?.items || []);
    setCursor(data?.nextPageToken || null);
  }, [data]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    setMoreError("");
    try {
      const page = await api<ExternalPlaylistPageData>(
        `/api/playlists/external/${id}?pageToken=${encodeURIComponent(cursor)}`,
      );
      setItems((before) => [...before, ...page.items.filter((item) => !before.some((old) => old.id === item.id))]);
      setCursor(page.nextPageToken);
    } catch (cause) {
      setMoreError((cause as Error).message);
    } finally { setBusy(false); }
  }
  return <>
    <Link className="back-link" to={backQuery ? `/search?q=${encodeURIComponent(backQuery)}&type=playlist` : "/search?type=playlist"}>
      <Icon name="back" size={16} /> Buscar listas
    </Link>
    {loading && <State>Cargando lista…</State>}
    {error && <State error>{error}</State>}
    {data?.playlist && <>
      <PageHeading title={data.playlist.title}
        description={data.playlist.description || `${data.playlist.itemCount} vídeos · ${data.playlist.channelTitle}`}
        action={data.localPlaylistId ? <Link className="button secondary" to={`/playlists/${data.localPlaylistId}`}>
          <Icon name="check" size={18} /> En tus listas
        </Link> : session.mode === "real" && session.connected ? <button className="button" disabled={following}
          onClick={async () => {
            setFollowing(true);
            try {
              const result = await api<{ id: string }>("/api/playlists/follow", "POST", { remoteId: id });
              navigate(`/playlists/${result.id}`);
            } catch (cause) {
              notify((cause as Error).message);
              setFollowing(false);
            }
          }}><Icon name="plus" size={18} /> {following ? "Siguiendo…" : "Seguir"}</button> : undefined} />
      <p className="playlist-preview-owner">Lista de {data.playlist.channelTitle || "YouTube"} · {data.playlist.itemCount} vídeos</p>
      <div className="video-grid">{items.map((video) => <SearchVideoCard key={video.id} video={video} />)}</div>
      {!items.length && <State>Esta lista no tiene vídeos públicos disponibles.</State>}
      <LoadMore cursor={cursor} busy={busy} error={moreError} onLoad={() => void more()} />
    </>}
  </>;
}
function SubscribeChannel({ channelId, subscribed: knownSubscribed }: { channelId: string; subscribed?: boolean }) {
  const { session, notify } = useApp();
  const { data, loading, error } = useResource<{ subscribed: boolean }>(
    knownSubscribed === undefined ? `/api/subscriptions/${encodeURIComponent(channelId)}` : null,
  );
  const [busy, setBusy] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const following = subscribed || knownSubscribed === true || data?.subscribed === true;
  if ((knownSubscribed === undefined && loading) || following) return null;
  if (error)
    return (
      <small role="alert" className="error-text">
        {error}
      </small>
    );
  if (
    !loading &&
    !following &&
    session.mode === "real" &&
    !session.capabilities.youtubeWrites
  )
    return (
      <Link className="button small secondary" to="/settings">
        Permitir suscripciones
      </Link>
    );
  return (
    <button
      className="button small"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api("/api/subscriptions", "POST", { channelId });
          setSubscribed(true);
          notify(session.mode === "demo" ? "Canal seguido en la demo" : "Suscripción añadida en YouTube");
        } catch (e) {
          notify((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="plus" size={16} />
      {busy ? "Suscribiendo…" : "Suscribirse"}
    </button>
  );
}
function Watch({
  id,
  minimized,
  onClose,
}: {
  id: string;
  minimized: boolean;
  onClose: () => void;
}) {
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
  if (loading) return minimized ? null : <State>Cargando vídeo…</State>;
  if (error || !video)
    return (
      <State error>
        {error || "Vídeo no disponible."} <Link to="/feed">Volver al feed</Link>
      </State>
    );
  return (
    <div className={`watch-layout ${minimized ? "mini-player" : ""}`}>
      <div className="watch-primary">
        <Player
          video={video}
          onProgress={change}
          revisionRef={revisionRef}
          demo={session.mode === "demo"}
        />
        {minimized && (
          <div className="mini-player-controls">
            <Link
              to={`/watch/${id}`}
              className="mini-player-return"
              aria-label={`Volver al vídeo: ${video.title}`}
            >
              <span className="mini-player-title">{video.title}</span>
              <span className="mini-player-channel">{video.channelTitle}</span>
            </Link>
            <button
              className="mini-player-close"
              aria-label="Cerrar reproducción"
              title="Cerrar reproducción"
              onClick={onClose}
            >
              <Icon name="close" size={22} />
            </button>
          </div>
        )}
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
              <SubscribeChannel
                key={video.channelId}
                channelId={video.channelId}
              />
              {!video.transient && <button
                className={`button small ${video.watched ? "" : "secondary"}`}
                onClick={async () => {
                  try {
                    change(
                      await api<Video>(`/api/videos/${id}/watch-state`, "PUT", {
                        watched: !video.watched,
                      }),
                    );
                  } catch (e) {
                    notify((e as Error).message);
                  }
                }}
              >
                <Icon name="check" size={16} />
                {video.watched ? "Visto" : "Marcar visto"}
              </button>}
              <button
                className={`button small secondary ${save ? "selected" : ""}`}
                aria-expanded={save}
                onClick={() => setSave(!save)}
              >
                <Icon name="save" size={16} />
                Guardar
              </button>
              <button
                className="icon-button"
                aria-label="Compartir vídeo"
                title="Compartir vídeo"
                onClick={async () => {
                  const url = `https://www.youtube.com/watch?v=${id}`;
                  try {
                    if (navigator.share) {
                      await navigator.share({ url });
                      return;
                    }
                  } catch (e) {
                    if ((e as DOMException).name === "AbortError") return;
                  }
                  try {
                    await navigator.clipboard.writeText(url);
                    notify("Enlace copiado");
                  } catch {
                    notify("No se pudo compartir el vídeo");
                  }
                }}
              >
                <Icon name="share" size={18} />
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
          <MotionPanel open={save}><SaveVideo id={id} onDone={() => {
            setSave(false);
            void api<Video>(`/api/videos/${id}`).then(change)
              .catch((e) => notify((e as Error).message));
          }} /></MotionPanel>
          {video.transient && (
            <p className="muted-note">Guárdalo en una lista para registrar tu progreso.</p>
          )}
          <details className="description">
            <summary>
              Descripción
              <span className="disclosure">
                <Icon name="chevron" size={16} />
              </span>
            </summary>
            <p>{video.description || "No hay descripción disponible."}</p>
          </details>
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
            {comments ? <Comments videoId={id} /> : null}
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
      </aside>
    </div>
  );
}
function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") || "";
  const type = params.get("type") === "channel" ? "channel" : params.get("type") === "playlist" ? "playlist" : "video";
  const [draft, setDraft] = useState(query);
  const [items, setItems] = useState<(Video | SearchResource)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  useEffect(() => { setDraft(query); }, [query]);
  useEffect(() => {
    generation.current++;
    const current = generation.current;
    setItems([]);
    setCursor(null);
    setError("");
    if (query.trim().length < 2) { setBusy(false); return; }
    const controller = new AbortController();
    setBusy(true);
    api<{ items: (Video | SearchResource)[]; nextPageToken: string | null }>(
      `/api/search?q=${encodeURIComponent(query)}${type === "video" ? "" : `&type=${type}`}`, "GET", undefined, controller.signal,
    ).then((result) => {
      if (current === generation.current) {
        setItems(result.items);
        setCursor(result.nextPageToken);
      }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError((cause as Error).message);
    }).finally(() => {
      if (current === generation.current) setBusy(false);
    });
    return () => controller.abort();
  }, [query, type, version]);
  async function more() {
    if (!cursor || busy) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ items: (Video | SearchResource)[]; nextPageToken: string | null }>(
        `/api/search?q=${encodeURIComponent(query)}${type === "video" ? "" : `&type=${type}`}&pageToken=${encodeURIComponent(cursor)}`,
      );
      if (current !== generation.current) return;
      setItems((before) => [...before, ...result.items.filter((item) => !before.some((old) => old.id === item.id))]);
      setCursor(result.nextPageToken);
    } catch (cause) {
      if (current === generation.current) setError((cause as Error).message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return <>
    <PageHeading title="Buscar" description="Encuentra vídeos, canales y listas de YouTube." />
    <form className="global-search" role="search" onSubmit={(event) => {
      event.preventDefault();
      const next = draft.trim().replace(/\s+/g, " ");
      if (next.length >= 2 && next.length <= 120) setParams(type === "video" ? { q: next } : { q: next, type });
    }}>
      <Icon name="search" size={20} />
      <input autoFocus aria-label="Buscar en YouTube" placeholder="Buscar en YouTube" value={draft}
        maxLength={120} onChange={(event) => setDraft(event.target.value)} />
      <button className="button small" disabled={draft.trim().length < 2 || busy}>Buscar</button>
    </form>
    <div className="segmented search-tabs" aria-label="Tipo de resultado">
      {([ ["video", "Vídeos"], ["channel", "Canales"], ["playlist", "Listas"] ] as const).map(([value, label]) =>
        <button key={value} className={type === value ? "active" : ""} aria-pressed={type === value}
          onClick={() => setParams(value === "video" ? { q: query } : { q: query, type: value })}>{label}</button>)}
    </div>
    {!query && <State>Escribe lo que buscas y pulsa Buscar.</State>}
    {error && !cursor && <State error>{error} <button onClick={() => setVersion((n) => n + 1)}>Reintentar</button></State>}
    <div className={type === "video" ? "video-grid" : "search-resource-grid"}>
      {items.map((item) => type === "video"
        ? <SearchVideoCard key={item.id} video={item as Video} />
        : <SearchResourceCard key={item.id} resource={item as SearchResource} type={type} query={query} />)}
    </div>
    {busy && !items.length && <State>Buscando…</State>}
    {query && !busy && !error && !items.length && <State>No encontramos {type === "video" ? "vídeos" : type === "channel" ? "canales" : "listas"} para «{query}».</State>}
    <LoadMore cursor={cursor} busy={busy} error={error} onLoad={() => void more()} />
  </>;
}
function SearchResourceCard({ resource, type, query }: { resource: SearchResource; type: "channel" | "playlist"; query: string }) {
  const destination = type === "channel" ? `/channels/${resource.id}` : `/playlists/external/${resource.id}?q=${encodeURIComponent(query)}`;
  return <Link className={`search-resource-card ${type}`} to={destination}>
    <span className="search-resource-art">
      {resource.thumbnailUrl ? <img src={resource.thumbnailUrl} alt="" loading="lazy" /> :
        <Icon name={type === "channel" ? "channels" : "lists"} size={24} />}
    </span>
    <span className="search-resource-copy">
      <strong>{resource.title}</strong>
      <small>{type === "channel" ? "Canal" : `Lista · ${resource.channelTitle || "YouTube"}`}</small>
      {resource.description && <span>{resource.description}</span>}
    </span>
    <Icon name="chevron" size={18} />
  </Link>;
}
function SearchVideoCard({ video }: { video: Video }) {
  const [save, setSave] = useState(false);
  return <div className="search-result"><VideoCard video={video} action={<button className="icon-button" aria-label={`Guardar ${video.title} en una lista`}
    aria-expanded={save} title="Guardar en una lista" onClick={() => setSave((value) => !value)}>
    <Icon name="save" size={18} />
  </button>} /><MotionPanel open={save}><SaveVideo id={video.id} onDone={() => setSave(false)} /></MotionPanel></div>;
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
      {data?.items.filter((p) => !p.followed).map((p) => (
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
      {!loading && !data?.items.some((p) => !p.followed) && (
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
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    setExtraError("");
    try {
      const d = await api<CommentPage>(
        `${path}?cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((v) => [...v, ...d.items]);
      setCursor(d.nextCursor);
    } catch (e) {
      setExtraError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
      <LoadMore cursor={cursor} busy={busy} error={extraError} onLoad={() => void more()} />
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
function SettingsPage() {
  const { session, settings, updateSettings, notify, refreshSession } =
    useApp();
  const { data: syncStatus, error: syncError, refresh: refreshSyncStatus } = useSyncStatus(session.mode === "demo" || session.connected);
  const currentJob =
    syncStatus?.jobs?.find(isActiveSyncJob) || syncStatus?.jobs?.[0];
  const [consent, setConsent] = useState(false);
  const [confirm, setConfirm] = useState("");
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const privacyOpen = location.hash === "#privacy";
  useEffect(() => {
    if (!privacyOpen) return;
    const timer = setTimeout(() => {
      const section = document.getElementById("privacy");
      if (!section) return;
      const offset = window.innerWidth <= 700 ? 72 : 24;
      const top = section.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: Math.max(0, top) });
    }, 50);
    return () => clearTimeout(timer);
  }, [privacyOpen]);
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
              ? "Modo demo. Los cambios se guardan solo en Alveo."
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
              Para usar tu cuenta real, configura OAuth (README.md).
            </p>
          )}
        </section>
        <section className="settings-card">
          <h2>Apariencia</h2>
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
          <label className="pure-black-option">
            <input type="checkbox" checked={settings.pureBlack}
              onChange={(event) => updateSettings({ pureBlack: event.target.checked })
                .catch((e) => notify(e.message))} />
            <span>Negro puro <small>Cuando el tema sea oscuro, también en modo Sistema.</small></span>
          </label>
        </section>
        <section className="settings-card">
          <h2>Sincronización</h2>
          <p>
            {session.mode === "demo"
              ? session.capabilities.publicData
                ? "Actualiza datos públicos. No importa tu cuenta."
                : "Sin conexión externa en esta demo."
              : "Actualiza suscripciones y permite recuperar publicaciones por RSS."}
          </p>
          {session.mode === "real" && session.connected && (
            <div className="settings-buttons">
              <SyncButton type="rss" label="Reconciliar vídeos por RSS" onDone={() => refreshSyncStatus()} />
            </div>
          )}
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
                  Se actualiza solo. Puedes cerrar la página.
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
                Desconectar y borrar datos
              </button>
              <button
                className="danger-link"
                onClick={() => setConfirm("delete")}
              >
                Borrar datos de Alveo
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
            <MotionPanel open={!!confirm}>
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
            </MotionPanel>
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
