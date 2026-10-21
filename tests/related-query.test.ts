import { describe, it, expect } from "vitest";
import { relatedQueries } from "../worker/related-query";
describe("thematic related searches", () => {
  it("prefers informative tags, not the full title or channel branding", () => {
    expect(
      relatedQueries({
        title: "Aprende JavaScript closures tutorial #12",
        channelTitle: "Mi Canal",
        tags: ["Mi Canal", "youtube", "tutorial", "JavaScript", "closures"],
      }),
    ).toEqual(["JavaScript closures"]);
  });
  it("ranks tags matching the title before unrelated creator tags", () => {
    expect(
      relatedQueries({
        title: "Rust memoria segura",
        tags: ["viajes", "Rust", "memoria"],
      })[0],
    ).toBe("Rust memoria");
  });
  it("falls back to useful title words and description hashtags when tags are absent", () => {
    expect(
      relatedQueries({
        title: "Cómo aprender React tutorial episodio 42",
        description: "https://example.com #TypeScript",
      }),
    ).toEqual(["React TypeScript"]);
  });
  it("ignores empty and generic tags", () => {
    expect(
      relatedQueries({
        title: "Blender iluminación",
        tags: ["", "youtube", "viral", "shorts", "4k"],
      }),
    ).toEqual(["Blender iluminación"]);
  });
  it("offers a distinct fallback if the tag query has no candidates", () => {
    expect(
      relatedQueries({
        title: "React hooks estado",
        tags: ["React", "JavaScript"],
      }),
    ).toEqual(["React JavaScript", "React hooks estado"]);
  });
  it("deduplicates case and accents without throwing away technical identifiers", () => {
    expect(
      relatedQueries({
        title: "C++ memoria",
        tags: ["C++", "c++", "memoria"],
      })[0],
    ).toBe("C++ memoria");
    expect(relatedQueries({ title: "Acción ACCION acción" })).toEqual([
      "Acción",
    ]);
  });
  it("does not issue an empty or promotional search", () => {
    expect(
      relatedQueries({
        title: "YouTube official HD 2026",
        tags: ["video", "subscribe"],
      }),
    ).toEqual([]);
  });
  it("bounds query size and strips search operators and links", () => {
    const queries = relatedQueries({
      title: "Rust | JavaScript -tutorial https://example.com",
      tags: Array(100).fill("Rust memory ownership"),
    });
    expect(queries.length).toBeLessThanOrEqual(2);
    expect(
      queries.every(
        (q) => q.length <= 140 && !q.includes("|") && !q.includes("https"),
      ),
    ).toBe(true);
  });
});
