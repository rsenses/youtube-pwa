import { describe, expect, it } from "vitest";
import { MAX_FEED_BYTES, channelFeedUrl, parseAtomFeed } from "../worker/rss";

const VALID_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
  <id>yt:channel:UCabcdefghijklmnopqrstuv</id>
  <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
  <title>Demo Feed</title>
  <link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
  <author>
    <name>Demo Channel</name>
    <uri>https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv</uri>
  </author>
  <published>2026-10-01T00:00:00+00:00</published>
  <entry>
    <id>yt:video:abcdefghijk</id>
    <yt:videoId>abcdefghijk</yt:videoId>
    <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
    <title>Hello &amp; welcome</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abcdefghijk"/>
    <published>2026-10-01T10:00:00+00:00</published>
    <author><name>Demo Channel</name></author>
    <media:group>
      <media:description>Line one
Line two with &lt;tag&gt; and &amp; entity</media:description>
      <media:thumbnail url="https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" width="480" height="360"/>
      <media:community>
        <media:statistics views="12345"/>
      </media:community>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:lmnopqrstuv</id>
    <yt:videoId>lmnopqrstuv</yt:videoId>
    <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
    <title>Second video</title>
    <published>2026-10-02T10:00:00.000Z</published>
    <author><name>Demo Channel</name></author>
    <media:group>
      <media:description>Description two</media:description>
      <media:thumbnail url="https://evil.example/tracker.jpg"/>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:broken</id>
    <yt:videoId>broken</yt:videoId>
    <title>Missing publish date</title>
    <author><name>Demo Channel</name></author>
  </entry>
</feed>`;

describe("Atom feed parsing", () => {
  it("maps valid entries, decodes entities and reports skipped entries", () => {
    const feed = parseAtomFeed(VALID_FEED);
    expect(feed.title).toBe("Demo Feed");
    expect(feed.feedId).toBe("yt:channel:UCabcdefghijklmnopqrstuv");
    expect(feed.entries).toHaveLength(2);
    expect(feed.skipped).toBe(1);

    const [first, second] = feed.entries;
    expect(first.videoId).toBe("abcdefghijk");
    expect(first.channelId).toBe("UCabcdefghijklmnopqrstuv");
    expect(first.channelTitle).toBe("Demo Channel");
    expect(first.title).toBe("Hello & welcome");
    expect(first.publishedAt).toBe("2026-10-01T10:00:00.000Z");
    expect(first.description).toContain("Line two with <tag> and & entity");
    expect(first.description.split("\n")).toHaveLength(2);
    expect(first.thumbnailUrl).toBe(
      "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg",
    );
    expect(first.viewCount).toBe(12345);
    expect(first.durationSeconds).toBeNull();

    expect(second.videoId).toBe("lmnopqrstuv");
    // The video id determines the thumbnail even when Atom supplies another host.
    expect(second.thumbnailUrl).toBe("https://i.ytimg.com/vi/lmnopqrstuv/mqdefault.jpg");
    expect(second.viewCount).toBeNull();
  });

  it("accepts a feed with a single entry", () => {
    const single = VALID_FEED.replace(/<entry>[\s\S]*<\/entry>/, "").replace(
      "</feed>",
      `<entry>
        <yt:videoId>abcdefghijk</yt:videoId>
        <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
        <title>Single</title>
        <published>2026-10-01T10:00:00Z</published>
      </entry></feed>`,
    );
    const feed = parseAtomFeed(single);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].videoId).toBe("abcdefghijk");
    expect(feed.entries[0].channelTitle).toBe("Demo Channel");
  });

  it("uses the feed channel id when an entry omits yt:channelId", () => {
    const feed = parseAtomFeed(
      VALID_FEED.replace(
        "<yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>\n    <title>Hello",
        "<title>Hello",
      ),
    );
    expect(feed.entries[0].channelId).toBe("UCabcdefghijklmnopqrstuv");
  });

  it("rejects empty, non-Atom, DOCTYPE and oversized documents", () => {
    expect(() => parseAtomFeed("")).toThrow(/empty/);
    expect(() => parseAtomFeed("<rss><channel/></rss>")).toThrow(
      /not an Atom feed/,
    );
    expect(() =>
      parseAtomFeed(
        '<!DOCTYPE feed [<!ENTITY x "y">]><feed><title>x</title></feed>',
      ),
    ).toThrow(/DOCTYPE/);
    expect(() => parseAtomFeed("x".repeat(MAX_FEED_BYTES + 1))).toThrow(
      /allowed size/,
    );
  });
});

describe("channel feed URL", () => {
  it("builds only YouTube feed URLs from channel ids", () => {
    expect(channelFeedUrl("UCabcdefghijklmnopqrstuv")).toBe(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv",
    );
    expect(() => channelFeedUrl("https://evil.example/feed")).toThrow(
      /Invalid channel id/,
    );
    expect(() => channelFeedUrl("../etc/passwd")).toThrow(/Invalid channel id/);
  });
});
