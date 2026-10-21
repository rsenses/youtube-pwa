import { afterEach, describe, it, expect, vi } from "vitest";
import { api } from "../src/api";
afterEach(() => vi.unstubAllGlobals());
describe("API protocol failures", () => {
  it("rejects an HTML SPA or Access page rather than returning an empty object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>SPA</html>", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    await expect(api("/api/channels")).rejects.toThrow(
      "La API no ha devuelto datos JSON",
    );
  });
  it("rejects malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{", {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(api("/api/channels")).rejects.toThrow(
      "respuesta JSON inválida",
    );
  });
  it("preserves valid responses and HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ items: [] }))
        .mockResolvedValueOnce(
          Response.json({ error: "Conecta Google" }, { status: 401 }),
        ),
    );
    await expect(api("/api/channels")).resolves.toEqual({ items: [] });
    await expect(api("/api/channels")).rejects.toThrow("Conecta Google");
  });
});
