import { createContext, useContext, useReducer, useRef, type ReactNode } from "react";
import type { Video } from "./api";

export type QueueState = { current: string | null; pending: Video[] };
export type QueueAction =
  | { type: "play"; id: string }
  | { type: "add"; video: Video }
  | { type: "next"; id: string }
  | { type: "jump"; id: string }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; offset: number }
  | { type: "clear" }
  | { type: "close" };
export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "add":
      if (state.current === action.video.id || state.pending.some(v => v.id === action.video.id)) return state;
      return state.current ? { ...state, pending: [...state.pending, action.video] } : { current: action.video.id, pending: [] };
    case "play":
      return { current: action.id, pending: state.pending.filter(v => v.id !== action.id) };
    case "next":
      if (state.current !== action.id || !state.pending.length) return state;
      return { current: state.pending[0].id, pending: state.pending.slice(1) };
    case "jump":
      if (!state.pending.some(v => v.id === action.id)) return state;
      return { current: action.id, pending: state.pending.filter(v => v.id !== action.id) };
    case "remove":
      return { ...state, pending: state.pending.filter(v => v.id !== action.id) };
    case "move": {
      const from = state.pending.findIndex(v => v.id === action.id), to = from + action.offset;
      if (from < 0 || to < 0 || to >= state.pending.length) return state;
      const pending = [...state.pending];
      [pending[from], pending[to]] = [pending[to], pending[from]];
      return { ...state, pending };
    }
    case "clear": return { ...state, pending: [] };
    case "close": return { current: null, pending: [] };
  }
}
function usePlaybackState(initial: string | null) {
  const [state, dispatch] = useReducer(queueReducer, { current: initial, pending: [] });
  const videos = useRef(new Map<string, Video>());
  const remember = (video: Video) => { videos.current.set(video.id, video); };
  return { ...state, dispatch, remember, getVideo: (id: string) => videos.current.get(id),
    add: (video: Video) => { remember(video); dispatch({ type: "add", video }); } };
}
const PlaybackContext = createContext<ReturnType<typeof usePlaybackState>>(null!);
export const usePlayback = () => useContext(PlaybackContext);
export function PlaybackProvider({ children, initial }: { children: ReactNode; initial: string | null }) {
  return <PlaybackContext.Provider value={usePlaybackState(initial)}>{children}</PlaybackContext.Provider>;
}
