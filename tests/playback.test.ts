import { describe, expect, it } from "vitest";
import { queueReducer, type QueueState } from "../src/playback";
import type { Video } from "../src/api";
const video = (id: string) => ({ id, title: id } as Video);
const initial: QueueState = { current: "a", pending: [video("b"), video("c"), video("d")] };
describe("cola local", () => {
  it("prepara el primer vídeo y evita duplicados sin cambiar el actual", () => {
    const first = queueReducer({ current: null, pending: [] }, { type: "add", video: video("a") });
    expect(first).toEqual({ current: "a", pending: [] });
    expect(queueReducer(first, { type: "add", video: video("a") })).toBe(first);
    expect(queueReducer(initial, { type: "add", video: video("b") })).toBe(initial);
    expect(queueReducer(first, { type: "add", video: video("b") })).toEqual({ current: "a", pending: [video("b")] });
  });
  it("avanza una sola vez por vídeo y no hace nada al agotarse", () => {
    const next = queueReducer(initial, { type: "next", id: "a" });
    expect(next).toEqual({ current: "b", pending: [video("c"), video("d")] });
    expect(queueReducer(next, { type: "next", id: "a" })).toBe(next);
    const empty = { current: "a", pending: [] };
    expect(queueReducer(empty, { type: "next", id: "a" })).toBe(empty);
  });
  it("reordena, elimina y vacía sin interrumpir el actual", () => {
    const moved = queueReducer(initial, { type: "move", id: "d", offset: -1 });
    expect(moved.pending.map(v => v.id)).toEqual(["b", "d", "c"]);
    expect(initial.pending.map(v => v.id)).toEqual(["b", "c", "d"]);
    expect(queueReducer(initial, { type: "move", id: "b", offset: -1 })).toBe(initial);
    expect(queueReducer(moved, { type: "remove", id: "d" }).pending.map(v => v.id)).toEqual(["b", "c"]);
    expect(queueReducer(initial, { type: "clear" })).toEqual({ current: "a", pending: [] });
  });
  it("selecciona otro vídeo conservando los demás pendientes", () => {
    expect(queueReducer(initial, { type: "jump", id: "c" })).toEqual({ current: "c", pending: [video("b"), video("d")] });
    expect(queueReducer(initial, { type: "play", id: "b" })).toEqual({ current: "b", pending: [video("c"), video("d")] });
    expect(queueReducer(initial, { type: "close" })).toEqual({ current: null, pending: [] });
  });
});
