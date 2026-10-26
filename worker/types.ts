/** Runtime bindings derive from Wrangler; real-mode vars and local secrets are optional overrides. */
export interface Env extends Omit<
  Cloudflare.Env,
  | "READ_CACHE"
  | "FEED_IMAGES"
  | "MODE"
  | "APP_ORIGIN"
  | "SYNC_PROFILE"
  | "SYNC_QUEUE"
  | "SYNC_QUEUE_DAILY_CAP"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "TOKEN_ENCRYPTION_KEY"
  | "YOUTUBE_API_KEY"
> {
  READ_CACHE?: KVNamespace;
  FEED_IMAGES?: R2Bucket;
  MODE: "demo" | "real";
  /** Android beta: bounded RSS; subscription/playlist snapshots remain imported. */
  SYNC_PROFILE?: "free";
  SYNC_QUEUE?: Queue<{ jobId: string; version: number }>;
  SYNC_QUEUE_DAILY_CAP?: string;
  SYNC_MAINTENANCE?: string;
  /** Opt-in until migration/callback/Access are configured by the operator. */
  WEBSUB_ENABLED?: string;
  WEBSUB_SECRET?: string;
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  YOUTUBE_API_KEY?: string;
}

export interface Video {
  id: string;
  /** Public API preview; it has no persisted watch state until saved. */
  transient?: boolean;
  title: string;
  channelId: string;
  channelTitle: string;
  thumbnailUrl: string;
  publishedAt: string;
  description: string;
  durationSeconds: number | null;
  isLive?: boolean | null;
  liveBroadcastContent?: "none" | "live" | "upcoming" | null;
  watched: boolean;
  positionSeconds: number;
  percent: number;
  manual: boolean;
  viewCount?: number | null;
  revision?: number;
  /** Present on items returned by the playlist endpoints. */
  playlistItemId?: string;
}

export interface Channel {
  id: string;
  title: string;
  thumbnailUrl: string;
  description: string;
  subscribed: boolean;
  subscriberCount?: number | null;
  lastSyncedAt: string | null;
  excluded?: boolean;
}

export interface PlaylistSummary {
  id: string;
  title: string;
  description: string;
  source: "local" | "youtube";
  followed?: boolean;
  itemCount: number;
  excluded?: boolean;
}

export interface PlaylistDetail extends PlaylistSummary {
  items: Video[];
  itemsSyncedAt?: string | null;
}

export interface SearchResource {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  channelTitle: string;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  pureBlack: boolean;
}

export interface SessionInfo {
  mode: "demo" | "real";
  connected: boolean;
  csrfToken: string;
  account?: { name: string };
  capabilities: {
    externalSync: boolean;
    oauth: boolean;
    youtubeWrites: boolean;
    rss: boolean;
    comments: boolean;
    publicData?: boolean;
    localPlaylists: boolean;
    automaticDiscovery?: boolean;
  };
}

export interface CommentItem {
  id: string;
  author: string;
  avatarUrl: string;
  publishedAt: string;
  text: string;
  likeCount: number;
  replyCount?: number;
}

export interface CommentPage {
  items: CommentItem[];
  nextCursor: string | null;
  mode?: "demo" | "real";
  demo?: boolean;
  message?: string;
}

export interface SyncRun {
  id: string;
  type: string;
  status: "running" | "success" | "partial" | "error" | "noop";
  startedAt: string;
  finishedAt: string | null;
  items: number;
  error: string | null;
  detail: string | null;
  mode: "demo" | "real";
}

export interface AccountRow {
  id: string;
  mode: "demo" | "real";
  name: string;
  youtube_channel_id: string | null;
  connected: number;
  scopes: string;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  account_id: string | null;
  csrf_token: string;
  created_at: string;
  expires_at: string;
}
