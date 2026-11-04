import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, type Video } from "./api";
interface YTPlayer {
    destroy(): void;
    loadVideoById(options: { videoId: string; startSeconds: number }): void;
    playVideo(): void;
    getCurrentTime(): number;
    getDuration(): number;
    getPlayerState(): number;
    getIframe(): HTMLIFrameElement;
    getVolume(): number;
    setVolume(volume: number): void;
    isMuted(): boolean;
    mute(): void;
    unMute(): void;
}
interface YTConstructor {
    new (element: HTMLElement, options: Record<string, unknown>): YTPlayer;
}
declare global {
    interface Window {
        YT?: { Player: YTConstructor };
        onYouTubeIframeAPIReady?: () => void;
    }
}
let apiPromise: Promise<void> | null = null;
function loadYouTube() {
    if (window.YT?.Player) return Promise.resolve();
    if (!apiPromise)
        apiPromise = new Promise<void>((resolve, reject) => {
            const previous = window.onYouTubeIframeAPIReady;
            const timeout = window.setTimeout(
                () =>
                    reject(
                        new Error(
                            "YouTube no ha respondido. Comprueba la conexión o los bloqueadores.",
                        ),
                    ),
                18000,
            );
            window.onYouTubeIframeAPIReady = () => {
                clearTimeout(timeout);
                previous?.();
                resolve();
            };
            const script = document.createElement("script");
            script.src = "https://www.youtube.com/iframe_api";
            script.onerror = () => {
                clearTimeout(timeout);
                reject(
                    new Error("No se pudo cargar el reproductor de YouTube."),
                );
            };
            document.head.appendChild(script);
        }).catch((e) => {
            apiPromise = null;
            throw e;
        });
    return apiPromise;
}
const playerErrors: Record<number, string> = {
    2: "El identificador del vídeo no es válido.",
    5: "No se puede reproducir este vídeo en este navegador.",
    100: "El vídeo ya no está disponible o es privado.",
    101: "El propietario no permite reproducir este vídeo aquí.",
    150: "El propietario no permite reproducir este vídeo aquí.",
    153: "YouTube no ha recibido la identificación del origen (Referer). Abre la app desde su URL HTTPS o localhost, sin ocultar el referente.",
};
export function Player({
    video,
    onProgress,
    revisionRef,
    demo,
    onEnded,
    onUnavailable,
}: {
    video: Video;
    onProgress: (v: Video) => void;
    revisionRef: MutableRefObject<number>;
    demo: boolean;
    onEnded: () => void;
    onUnavailable: () => void;
}) {
    const [error, setError] = useState(""),
        [saveError, setSaveError] = useState(""),
        [ready, setReady] = useState(false);
    const fictional = demo && video.id.startsWith("demo");
    const host = useRef<HTMLDivElement>(null),
        player = useRef<YTPlayer | null>(null),
        callback = useRef(onProgress);
    const latest = useRef({ video, onEnded, onUnavailable });
    latest.current = { video, onEnded, onUnavailable };
    const loadedId = useRef<string | null>(null);
    const handledEnd = useRef(false);
    const hasPlayed = useRef(true);
    const transitionTimer = useRef<number | undefined>(undefined);
    const [blocked, setBlocked] = useState(false);
    const volumeIndicator = useRef<HTMLDivElement>(null);
    const gesture = useRef<{ pointerId: number; startY: number; startVolume: number; target: number; active: boolean; verified: boolean } | null>(null);
    const volumeCheck = useRef<number | undefined>(undefined);
    callback.current = onProgress;
    const hideVolume = () => {
        if (volumeIndicator.current) volumeIndicator.current.hidden = true;
    };
    const endGesture = () => {
        gesture.current = null;
        window.clearTimeout(volumeCheck.current);
        volumeCheck.current = undefined;
        hideVolume();
    };
    const showVolume = (volume: number, status = "") => {
        const indicator = volumeIndicator.current;
        if (!indicator) return;
        indicator.style.setProperty("--volume", String(volume));
        indicator.textContent = `${volume}%${status ? `\n${status}` : ""}`;
        indicator.hidden = false;
    };
    const onGestureMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const current = gesture.current;
        const p = player.current;
        if (!current || event.pointerId !== current.pointerId || !p) return;
        const distance = current.startY - event.clientY;
        if (!current.active && Math.abs(distance) < 12) return;
        current.active = true;
        const volume = Math.max(0, Math.min(100, Math.round(
            current.startVolume + distance / (event.currentTarget.parentElement?.clientHeight || event.currentTarget.clientHeight) * 100,
        )));
        if (volume === current.target) return;
        current.target = volume;
        try {
            if (volume > 0 && p.isMuted()) p.unMute();
            if (volume === 0) p.mute();
            p.setVolume(volume);
        } catch {
            endGesture();
            return;
        }
        if (current.verified) showVolume(volume);
        if (volumeCheck.current !== undefined) return;
        volumeCheck.current = window.setTimeout(() => {
            volumeCheck.current = undefined;
            if (gesture.current !== current) return;
            try {
                const actual = p.getVolume();
                current.verified = Number.isFinite(actual) && Math.abs(actual - current.target) <= 1 && (current.target === 0 || !p.isMuted());
                if (Number.isFinite(actual))
                    showVolume(actual, current.verified ? "" : "Sin cambio");
                else if (volumeIndicator.current) volumeIndicator.current.textContent = "No disponible";
            } catch {
                current.verified = false;
                if (volumeIndicator.current) volumeIndicator.current.textContent = "No disponible";
            }
        }, 120);
    };
    const persistNow = useRef<() => void>(() => {});
    useEffect(() => {
        if (fictional || !host.current) return;
        let cancelled = false;
        loadYouTube().then(() => {
            if (cancelled || !host.current || !window.YT) return;
            const mount = document.createElement("div");
            host.current.replaceChildren(mount);
            const initial = latest.current.video;
            loadedId.current = initial.id;
            hasPlayed.current = true;
            handledEnd.current = false;
            player.current = new window.YT.Player(mount, {
                videoId: initial.id, width: "100%", height: "100%",
                playerVars: { playsinline: 1, iv_load_policy: 3, rel: 0,
                    origin: window.location.origin, start: Math.floor(initial.positionSeconds) },
                events: {
                    onReady: () => {
                        if (cancelled) return;
                        const iframe = player.current?.getIframe();
                        if (iframe) {
                            iframe.title = "Reproductor oficial de YouTube";
                            iframe.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
                        }
                        setReady(true);
                    },
                    onStateChange: (event: { data: number }) => {
                        if (cancelled) return;
                        if (event.data === 1) {
                            clearTimeout(transitionTimer.current);
                            setBlocked(false);
                            setError("");
                            handledEnd.current = false;
                            hasPlayed.current = true;
                        }
                        if (event.data === 0 || event.data === 2) persistNow.current();
                        if (event.data === 0 && hasPlayed.current && !handledEnd.current) {
                            handledEnd.current = true;
                            latest.current.onEnded();
                        }
                    },
                    onError: (event: { data: number }) => {
                        if (cancelled || handledEnd.current) return;
                        clearTimeout(transitionTimer.current);
                        setError(playerErrors[event.data] || "YouTube no puede reproducir este vídeo.");
                        handledEnd.current = true;
                        latest.current.onUnavailable();
                    },
                    onAutoplayBlocked: () => {
                        if (cancelled) return;
                        clearTimeout(transitionTimer.current);
                        setBlocked(true);
                    },
                },
            });
        }).catch(e => { if (!cancelled) setError(e.message); });
        return () => {
            endGesture();
            if (player.current?.getPlayerState() === 1) persistNow.current();
            cancelled = true;
            clearTimeout(transitionTimer.current);
            setReady(false);
            player.current?.destroy();
            player.current = null;
            loadedId.current = null;
        };
    }, [fictional]);
    // Preserve the existing progress cadence; queue operations never make API requests.
    useEffect(() => {
        let cancelled = false, inFlight = false, lastTime = 0;
        const persist = async () => {
            const p = player.current;
            if (!p || video.transient || inFlight || cancelled || !hasPlayed.current || loadedId.current !== video.id) return;
            const seconds = p.getCurrentTime(), duration = p.getDuration();
            if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(duration) || duration <= 0 || Math.abs(seconds - lastTime) < 1) return;
            lastTime = seconds;
            inFlight = true;
            try {
                const result = await api<Video>(`/api/videos/${video.id}/progress`, "PUT", {
                    positionSeconds: seconds, durationSeconds: duration, revision: revisionRef.current,
                });
                if (!cancelled && (result.revision ?? 0) >= revisionRef.current) {
                    revisionRef.current = result.revision ?? revisionRef.current;
                    callback.current(result);
                    setSaveError("");
                }
            } catch {
                if (!cancelled) setSaveError("No se ha podido guardar el progreso. La reproducción continúa.");
            } finally { inFlight = false; }
        };
        persistNow.current = () => { void persist(); };
        const timer = window.setInterval(() => {
            if (player.current?.getPlayerState() === 1) void persist();
        }, 30000);
        return () => {
            if (player.current?.getPlayerState() === 1) void persist();
            cancelled = true;
            clearInterval(timer);
        };
    }, [video.id, video.transient, revisionRef]);
    useEffect(() => {
        if (!ready || !player.current || loadedId.current === video.id) return;
        clearTimeout(transitionTimer.current);
        endGesture();
        setError(""); setSaveError(""); setBlocked(false);
        handledEnd.current = false;
        hasPlayed.current = false;
        loadedId.current = video.id;
        // A silent failure must leave an explicit recovery action, not skip slow videos.
        transitionTimer.current = window.setTimeout(() => setBlocked(true), 15000);
        try {
            player.current.loadVideoById({ videoId: video.id, startSeconds: Math.floor(video.positionSeconds) });
        } catch {
            clearTimeout(transitionTimer.current);
            setError("No se pudo cargar el vídeo. Puedes saltar al siguiente.");
            handledEnd.current = true;
            latest.current.onUnavailable();
        }
    }, [video.id, ready]);
    return (
        <section className="player-section" aria-label="Reproducción">
            <div className="player-viewport">
                {fictional ? (
                    <p className="player-placeholder">
                        Vídeo ficticio de la demo. Abre un vídeo real del feed
                        para reproducirlo.
                    </p>
                ) : (
                    <div className="youtube-host" ref={host} />
                )}
                {ready && !fictional && (
                    <>
                        <div className="volume-gesture-zone" onPointerDown={(event) => {
                            if (event.pointerType !== "touch" || !player.current) return;
                            try {
                                const volume = player.current.getVolume();
                                if (!Number.isFinite(volume)) {
                                    if (volumeIndicator.current) {
                                        volumeIndicator.current.textContent = "No disponible";
                                        volumeIndicator.current.hidden = false;
                                    }
                                    return;
                                }
                                showVolume(volume, player.current.isMuted() ? "Silencio" : "");
                                gesture.current = {
                                    pointerId: event.pointerId,
                                    startY: event.clientY,
                                    startVolume: volume,
                                    target: volume,
                                    active: false,
                                    verified: false,
                                };
                                event.currentTarget.setPointerCapture(event.pointerId);
                            } catch { /* The player may still be initializing. */ }
                        }} onPointerMove={onGestureMove} onPointerUp={endGesture} onPointerCancel={endGesture} aria-hidden="true" />
                        <div className="volume-indicator" ref={volumeIndicator} hidden aria-hidden="true" />
                    </>
                )}
            </div>
            {blocked && <p className="player-notice" role="status">La reproducción necesita tu intervención. <button className="button small" onClick={() => player.current?.playVideo()}>Continuar reproducción</button> Si no arranca, pulsa ▶ en el reproductor de YouTube.</p>}
            {error && (
                <p className="player-notice" role="alert">
                    {error}{" "}
                    <a
                        href={`https://www.youtube.com/watch?v=${video.id}`}
                        target="_blank"
                        rel="noopener"
                    >
                        Abrir en YouTube ↗
                    </a>
                </p>
            )}
            {saveError && (
                <p className="player-notice" role="status">
                    {saveError}
                </p>
            )}
        </section>
    );
}
