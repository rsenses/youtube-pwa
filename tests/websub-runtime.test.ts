import { expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { CHANNEL_REDIRECT_MODE } from "../worker/channel-sync";

// Unlike a vi.stubGlobal(fetch), this crosses Workerd's native fetch boundary.
// No network: every outbound request is fulfilled by the local service fixture.
it.each([202, 302])(
  "supports the production redirect mode in Workerd without following HTTP %s",
  async (status) => {
    let outbound = 0;
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        compatibilityDate: "2026-10-20",
        outboundService: () => {
          outbound++;
          return new Response(null, {
            status,
            headers: { location: "https://must-not-follow.test/" },
          });
        },
        script: `export default { async fetch() {
      const response = await fetch("https://pubsubhubbub.appspot.com/subscribe", {
        method: "POST", body: "fixture", redirect: ${JSON.stringify(CHANNEL_REDIRECT_MODE)}
      });
      return new Response(String(response.status));
    } }`,
      }),
    );
    try {
      const response = await mf.dispatchFetch("https://local.test/");
      expect(await response.text()).toBe(String(status));
      expect(outbound).toBe(1);
      expect(CHANNEL_REDIRECT_MODE).toBe("manual");
    } finally {
      await mf.dispose();
    }
  },
);
