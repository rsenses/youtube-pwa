import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { Link } from "react-router-dom";
import { api, dateLabel, duration, videoThumbnail, videoUrl, type Video } from "./api";
import { videoType } from "../shared/video-type";
export function Icon({ name, size = 22 }: { name: string; size?: number }) {
    const paths: Record<string, ReactNode> = {
        feed: (
            <>
                <path d="M4 5h16M4 12h16M4 19h10" />
                <circle cx="19" cy="19" r="1" />
            </>
        ),
        channels: (
            <>
                <rect x="3" y="4" width="18" height="13" rx="3" />
                <path d="m10 8 5 3-5 3zM8 21h8" />
            </>
        ),
        lists: (
            <>
                <path d="M4 5h12M4 11h12M4 17h7M19 14v7M15.5 17.5h7" />
            </>
        ),
        settings: (
            <>
                <path d="M4 6h16M4 12h16M4 18h16" />
                <circle cx="8" cy="6" r="2" fill="currentColor" />
                <circle cx="16" cy="12" r="2" fill="currentColor" />
                <circle cx="10" cy="18" r="2" fill="currentColor" />
            </>
        ),
        play: <path d="m9 5 11 7-11 7z" />,
        check: <path d="m5 12 4 4L19 6" />,
        plus: <path d="M12 5v14M5 12h14" />,
        back: <path d="m14 5-7 7 7 7" />,
        external: (
            <>
                <path d="M14 3h7v7M21 3 11 13" />
                <path d="M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
            </>
        ),
        share: (
            <>
                <path d="M12 16V3m0 0L7 8m5-5 5 5" />
                <path d="M5 13v7h14v-7" />
            </>
        ),
        search: (
            <>
                <circle cx="10" cy="10" r="6" />
                <path d="m15 15 6 6" />
            </>
        ),
        sync: (
            <>
                <path d="M20 8a8 8 0 0 0-13-3L3 9m0-6v6h6M4 16a8 8 0 0 0 13 3l4-4m0 6v-6h-6" />
            </>
        ),
        close: <path d="m6 6 12 12M6 18 18 6" />,
        more: (
            <>
                <circle cx="5" cy="12" r="1" />
                <circle cx="12" cy="12" r="1" />
                <circle cx="19" cy="12" r="1" />
            </>
        ),
        arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
        save: <path d="M6 3h12v18l-6-4-6 4z" />,
        moon: <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z" />,
        fullscreen: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
        pause: (
            <>
                <path d="M8 5v14M16 5v14" />
            </>
        ),
        info: (
            <>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" />
            </>
        ),
        chevron: <path d="m8 5 7 7-7 7" />,
        trash: (
            <>
                <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
            </>
        ),
    };
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {paths[name] || paths.feed}
        </svg>
    );
}
export function State({
    children,
    error = false,
}: {
    children: ReactNode;
    error?: boolean;
}) {
    return (
        <div
            className={`state ${error ? "error" : ""}`}
            role={error ? "alert" : "status"}
        >
            {children}
        </div>
    );
}
export function useResource<T>(path: string | null, version = 0) {
    const [data, setData] = useState<T | null>(null),
        [error, setError] = useState(""),
        [loading, setLoading] = useState(true);
    useEffect(() => {
        if (!path) {
            setLoading(false);
            setData(null);
            return;
        }
        const c = new AbortController();
        setLoading(true);
        setError("");
        setData(null);
        api<T>(path, "GET", undefined, c.signal)
            .then(setData)
            .catch((e) => {
                if (!c.signal.aborted) setError(e.message);
            })
            .finally(() => {
                if (!c.signal.aborted) setLoading(false);
            });
        return () => c.abort();
    }, [path, version]);
    return { data, setData, error, loading };
}
export function VideoCard({
    video,
    onChange,
    compact = false,
    swipeToWatch = false,
    extra,
    action,
    renderAction,
}: {
    video: Video;
    onChange?: (v: Video) => void;
    compact?: boolean;
    swipeToWatch?: boolean;
    extra?: ReactNode;
    action?: ReactNode;
    renderAction?: (controls: { toggleWatched: () => void; busy: boolean }) => ReactNode;
}) {
    const [busy, setBusy] = useState(false),
        [error, setError] = useState(""),
        [swipe, setSwipe] = useState(0);
    const start = useRef<{ x: number; y: number } | null>(null);
    const suppressClickUntil = useRef(0);
    const type = videoType(video);
    async function toggle() {
        setBusy(true);
        setError("");
        try {
            const v = await api<Video>(
                `/api/videos/${video.id}/watch-state`,
                "PUT",
                { watched: !video.watched },
            );
            onChange?.(v);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }
    function touchStart(event: TouchEvent<HTMLElement>) {
        if (!swipeToWatch || busy || video.watched || event.touches.length !== 1) return;
        start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    function touchMove(event: TouchEvent<HTMLElement>) {
        if (!start.current) return;
        const dx = event.touches[0].clientX - start.current.x;
        const dy = event.touches[0].clientY - start.current.y;
        if (Math.abs(dy) > 15 && Math.abs(dy) > Math.abs(dx)) {
            start.current = null;
            setSwipe(0);
            return;
        }
        if (dx > 18 && dx > Math.abs(dy) * 1.4) {
            suppressClickUntil.current = Date.now() + 500;
            setSwipe(Math.min(dx, 110));
        }
    }
    function touchEnd() {
        const completed = start.current && swipe >= 80;
        start.current = null;
        setSwipe(0);
        if (completed) void toggle();
    }
    return (
        <article
            className={`video-card ${compact ? "compact" : ""} ${video.watched ? "is-watched" : ""} ${swipe > 0 ? "is-swiping" : ""}`}
            style={swipeToWatch ? { transform: `translateX(${swipe}px)`, touchAction: "pan-y" } : undefined}
            onTouchStart={touchStart}
            onTouchMove={touchMove}
            onTouchEnd={touchEnd}
            onTouchCancel={() => { start.current = null; setSwipe(0); }}
            onClickCapture={(event) => {
                if (Date.now() < suppressClickUntil.current) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
        >
            {swipeToWatch && swipe > 0 && <span className="swipe-feedback" aria-hidden="true">{swipe >= 80 ? "Soltar para marcar visto" : "Desliza para marcar visto"}</span>}
            <Link
                to={videoUrl(video.id)}
                className="thumbnail"
                aria-label={`Ver ${video.title}`}
            >
                <img
                    src={videoThumbnail(video)}
                    alt=""
                    loading="lazy"
                />
                <span className="play-hover">
                    <Icon name="play" size={28} />
                </span>
                {type !== "video" && (
                    <span className={`type-tag ${type}`}>{type}</span>
                )}
                {video.durationSeconds !== null && (
                    <span className="duration">
                        {duration(video.durationSeconds)}
                    </span>
                )}
                {video.watched && (
                    <span className="watched-label">
                        <Icon name="check" size={13} />
                        Visto
                    </span>
                )}
                {!video.watched && video.percent > 0 && (
                    <span className="progress-track">
                        <span style={{ width: `${video.percent}%` }} />
                    </span>
                )}
            </Link>
            {extra && <div className="card-extra">{extra}</div>}
            <div className="video-copy">
                <Link
                    className="channel-label"
                    to={`/channels/${video.channelId}`}
                >
                    {video.channelTitle}
                </Link>
                <h3>
                    <Link to={videoUrl(video.id)}>{video.title}</Link>
                </h3>
                <div className="video-meta">
                    <time dateTime={video.publishedAt}>
                        {dateLabel(video.publishedAt)}
                    </time>
                    <span>·</span>
                    <span>
                        {video.transient
                            ? "Descubierto en YouTube"
                            : video.watched
                            ? "Visto"
                            : video.percent > 0
                              ? "En curso"
                              : "Pendiente"}
                    </span>
                </div>
                {error && (
                    <small role="alert" className="error-text">
                        {error}
                    </small>
                )}
            </div>
            <div className="card-actions">
                {renderAction?.({ toggleWatched: () => void toggle(), busy }) ?? action ?? (!video.transient && <button
                    className={`icon-button ${video.watched ? "active" : ""}`}
                    aria-label={
                        video.watched ? "Marcar pendiente" : "Marcar visto"
                    }
                    title={video.watched ? "Marcar pendiente" : "Marcar visto"}
                    onClick={toggle}
                    disabled={busy}
                >
                    <Icon name="check" size={18} />
                </button>)}
            </div>
        </article>
    );
}
