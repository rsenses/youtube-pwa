import { afterEach, expect, it, vi } from "vitest";
import { updatePlaylist } from "../worker/youtube";
afterEach(() => vi.unstubAllGlobals());
it("preserves defaultLanguage and does not modify privacy while renaming a playlist", async () => {
  const requests: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      requests.push({
        url: input,
        method: init.method || "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json(
        init.method === "PUT"
          ? { id: "PL_test" }
          : {
              items: [
                {
                  id: "PL_test",
                  snippet: {
                    title: "Antes",
                    description: "Descripción",
                    defaultLanguage: "es",
                  },
                },
              ],
            },
      );
    }),
  );
  await updatePlaylist("mock-only", {
    id: "PL_test",
    title: "Después",
    description: "Descripción",
  });
  expect(requests).toHaveLength(2);
  expect(new URL(requests[1].url).searchParams.get("part")).toBe("snippet");
  expect(requests[1].body).toEqual({
    id: "PL_test",
    snippet: {
      title: "Después",
      description: "Descripción",
      defaultLanguage: "es",
    },
  });
});
