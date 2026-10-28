import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, type Video } from "./api";
interface YTPlayer {
    destroy(): void;
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
}: {
    video: Video;
    onProgress: (v: Video) => void;
    revisionRef: MutableRefObject<number>;
    demo: boolean;
}) {
    const [error, setError] = useState(""),
        [saveError, setSaveError] = useState(""),
        [ready, setReady] = useState(false);
    const fictional = demo && video.id.startsWith("demo");
    const host = useRef<HTMLDivElement>(null),
        player = useRef<YTPlayer | null>(null),
        callback = useRef(onProgress),
        position = useRef(video.positionSeconds);
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
    useEffect(() => {
        if (fictional || !host.current) return;
        let cancelled = false;
        let timer: number | undefined;
        let lastTime = 0;
        let inFlight = false;
        const persist = async () => {
            if (video.transient) return;
            const p = player.current;
            if (!p || inFlight || cancelled) return;
            let seconds = 0,
                duration = 0;
            try {
                seconds = p.getCurrentTime();
                duration = p.getDuration();
            } catch {
                return;
            }
            if (
                !Number.isFinite(seconds) ||
                seconds < 0 ||
                !Number.isFinite(duration) ||
                duration <= 0
            )
                return;
            if (Math.abs(seconds - lastTime) < 1) return;
            lastTime = seconds;
            inFlight = true;
            try {
                const result = await api<Video>(
                    `/api/videos/${video.id}/progress`,
                    "PUT",
                    {
                        positionSeconds: seconds,
                        durationSeconds: duration,
                        revision: revisionRef.current,
                    },
                );
                if (
                    !cancelled &&
                    (result.revision ?? 0) >= revisionRef.current
                ) {
                    revisionRef.current =
                        result.revision ?? revisionRef.current;
                    callback.current(result);
                    setSaveError("");
                }
            } catch {
                if (!cancelled)
                    setSaveError(
                        "No se ha podido guardar el progreso. La reproducción continúa.",
                    );
            } finally {
                inFlight = false;
            }
        };
        loadYouTube()
            .then(() => {
                if (cancelled || !host.current || !window.YT) return;
                const mount = document.createElement("div");
                host.current.replaceChildren(mount);
                player.current = new window.YT.Player(mount, {
                    videoId: video.id,
                    width: "100%",
                    height: "100%",
                    playerVars: {
                        playsinline: 1,
                        iv_load_policy: 3,
                        rel: 0,
                        origin: window.location.origin,
                        start: Math.floor(position.current),
                    },
                    events: {
                        onReady: () => {
                            if (cancelled) return;
                            setReady(true);
                            setError("");
                            const p = player.current;
                            if (p) {
                                p.getIframe().title =
                                    "Reproductor oficial de YouTube";
                            }
                            if (!video.transient)
                                timer = window.setInterval(() => {
                                    if (player.current?.getPlayerState() === 1)
                                        void persist();
                                }, 30000);
                        },
                        onStateChange: (event: { data: number }) => {
                            if (event.data === 0 || event.data === 2)
                                void persist();
                        },
                        onError: (event: { data: number }) =>
                            setError(
                                playerErrors[event.data] ||
                                    "YouTube no puede reproducir este vídeo. Puedes abrirlo en YouTube.",
                            ),
                        onAutoplayBlocked: () =>
                            setError(
                                "Pulsa el botón de reproducción dentro del reproductor de YouTube para empezar.",
                            ),
                    },
                });
            })
            .catch((e) => {
                if (!cancelled) setError(e.message);
            });
        return () => {
            endGesture();
            setReady(false);
            if (player.current?.getPlayerState() === 1) void persist();
            cancelled = true;
            clearInterval(timer);
            player.current?.destroy();
            player.current = null;
        };
    }, [fictional, video.id, video.transient, revisionRef]);
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
