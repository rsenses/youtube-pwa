import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, type Video } from "./api";
interface YTPlayer {
    destroy(): void;
    getCurrentTime(): number;
    getDuration(): number;
    getPlayerState(): number;
    getIframe(): HTMLIFrameElement;
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
        [saveError, setSaveError] = useState("");
    const fictional = demo && video.id.startsWith("demo");
    const host = useRef<HTMLDivElement>(null),
        player = useRef<YTPlayer | null>(null),
        callback = useRef(onProgress),
        position = useRef(video.positionSeconds);
    callback.current = onProgress;
    useEffect(() => {
        if (fictional || !host.current) return;
        let cancelled = false;
        let timer: number | undefined;
        let lastTime = 0;
        let inFlight = false;
        const persist = async () => {
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
                            setError("");
                            const p = player.current;
                            if (p) {
                                p.getIframe().title =
                                    "Reproductor oficial de YouTube";
                            }
                            timer = window.setInterval(() => {
                                if (player.current?.getPlayerState() === 1)
                                    void persist();
                            }, 5000);
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
            cancelled = true;
            clearInterval(timer);
            player.current?.destroy();
            player.current = null;
        };
    }, [fictional, video.id, revisionRef]);
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
