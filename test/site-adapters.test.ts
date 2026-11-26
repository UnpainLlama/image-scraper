import { describe, expect, it } from "vitest";
import { discoverSexComApiPage, discoverSiteSpecificHtml, isSexComUrl } from "../src/site-adapters";

describe("image-only source adapters", () => {
  it("resolves Rule34 sample image URLs from listing thumbnails", () => {
    const result = discoverSiteSpecificHtml(
      '<span class="thumb"><a href="/index.php?page=post&s=view&id=123"><img src="//img.rule34.xxx/thumbnails/ab/cd/thumbnail_hash.jpg"></a></span>',
      "https://rule34.xxx/index.php?page=post&s=list&tags=test"
    );
    expect(result?.images.map(item => item.url)).toContain("https://img.rule34.xxx/samples/ab/cd/sample_hash.jpg");
    expect(result?.followPages).toBe(true);
  });

  it("resolves the original Rule34 image when a post page is supplied", () => {
    const result = discoverSiteSpecificHtml(
      '<img id="image" src="https://img.rule34.xxx/images/ab/cd/original.jpg"><video><source src="/clip.mp4"></video>',
      "https://rule34.xxx/index.php?page=post&s=view&id=123"
    );
    expect(result?.images.map(item => item.url)).toEqual(["https://img.rule34.xxx/images/ab/cd/original.jpg"]);
  });

  it("retains Rule34 listing pagination without crawling each post twice", () => {
    const result = discoverSiteSpecificHtml(
      '<a href="/index.php?page=post&s=list&tags=test&pid=42">next</a>',
      "https://rule34.xxx/index.php?page=post&s=list&tags=test"
    );
    expect(result?.pages).toContain("https://rule34.xxx/index.php?page=post&s=list&tags=test&pid=42");
    expect(result?.pages.some(url => url.includes("s=view"))).toBe(false);
  });

  it("follows Realbooru post pages and listing offsets from a list page", () => {
    const result = discoverSiteSpecificHtml(
      '<a href="/index.php?page=post&s=view&id=123"><img src="/thumbnails/ab/cd/thumbnail_hash.jpg"></a><a href="/index.php?page=post&s=list&tags=test&pid=42">next</a>',
      "https://realbooru.com/index.php?page=post&s=list&tags=test"
    );
    expect(result?.pages).toContain("https://realbooru.com/index.php?page=post&s=view&id=123");
    expect(result?.pages).toContain("https://realbooru.com/index.php?page=post&s=list&tags=test&pid=42");
    expect(result?.followPages).toBe(true);
  });

  it("extracts only the original Realbooru image from a post page", () => {
    const result = discoverSiteSpecificHtml(
      '<img id="image" src="https://img.realbooru.com/images/aa/bb/file.png"><video src="/clip.mp4"></video>',
      "https://realbooru.com/index.php?page=post&s=view&id=123"
    );
    expect(result?.images.map(item => item.url)).toEqual(["https://img.realbooru.com/images/aa/bb/file.png"]);
  });

  it("follows Elitebabes galleries and pagination, then extracts full-size images only", () => {
    const listing = discoverSiteSpecificHtml(
      '<ul class="list-gallery"><li><a href="/gallery-one/"><img src="https://cdn.elitebabes.com/content/a_masonry_400.jpg"></a></li></ul><a href="/page/2/">2</a>',
      "https://www.elitebabes.com/"
    );
    expect(listing?.pages).toContain("https://www.elitebabes.com/gallery-one/");
    expect(listing?.pages).toContain("https://www.elitebabes.com/page/2/");
    expect(listing?.followPages).toBe(true);
    const gallery = discoverSiteSpecificHtml(
      '<a href="https://cdn.elitebabes.com/content/a_full.jpg">full</a><img src="https://cdn.elitebabes.com/content/a_w400.jpg">',
      "https://www.elitebabes.com/gallery-one/"
    );
    expect(gallery?.images.map(item => item.url)).toEqual(["https://cdn.elitebabes.com/content/a_full.jpg"]);
  });

  it("discovers Buondua albums and continues album image pagination", () => {
    const listing = discoverSiteSpecificHtml(
      '<a class="item-link" href="/sample-album-456">album</a><a href="/?start=20">next</a>',
      "https://buondua.com/"
    );
    expect(listing?.pages).toContain("https://buondua.com/sample-album-456");
    expect(listing?.pages).toContain("https://buondua.com/?start=20");
    const album = discoverSiteSpecificHtml(
      '<img src="https://i2.buondua.com/2026/456/photo-001.jpeg"><a href="?page=2">2</a>',
      "https://buondua.com/sample-album-456"
    );
    expect(album?.images.map(item => item.url)).toEqual(["https://i2.buondua.com/2026/456/photo-001.jpeg"]);
    expect(album?.pages).toContain("https://buondua.com/sample-album-456?page=2");
    expect(album?.followPages).toBe(true);
  });

  it("uses the Sex.com JSON API and schedules the next bounded page", async () => {
    expect(isSexComUrl("https://www.sex.com/en/gifs")).toBe(true);
    const requested: string[] = [];
    const result = await discoverSexComApiPage("https://sex.com/en/gifs", async url => {
      requested.push(url);
      return JSON.stringify({ data: Array.from({ length: 40 }, (_, index) => ({ uri: "/media/" + index + ".gif" })) });
    });
    expect(requested[0]).toContain("https://www.sex.com/portal/api/gifs?");
    expect(result.images).toHaveLength(40);
    expect(result.images[0]?.url).toBe("https://imagex1.sx.cdn.live/media/0.gif");
    expect(result.pages[0]).toContain("_image_scraper_page=2");
    expect(result.followPages).toBe(true);
  });

  it("accepts absolute Sex.com CDN URIs instead of forcing the default media host", async () => {
    const result = await discoverSexComApiPage("https://www.sex.com/en/gifs", async () =>
      JSON.stringify({ data: [{ uri: "https://cdn.example.test/image.gif" }] })
    );
    expect(result.images.map(item => item.url)).toEqual(["https://cdn.example.test/image.gif"]);
  });

  it("does not emit video media URLs from Realbooru or Rule34 post pages", () => {
    const realbooru = discoverSiteSpecificHtml(
      '<video><source src="https://cdn.realbooru.com/file.mp4"></video><img id="image" src="https://cdn.realbooru.com/file.webp">',
      "https://realbooru.com/index.php?page=post&s=view&id=77"
    );
    const rule34 = discoverSiteSpecificHtml(
      '<video><source src="https://cdn.rule34.xxx/file.mp4"></video><img id="image" src="https://cdn.rule34.xxx/file.webp">',
      "https://rule34.xxx/index.php?page=post&s=view&id=77"
    );
    expect(realbooru?.images.map(item => item.url)).toEqual(["https://cdn.realbooru.com/file.webp"]);
    expect(rule34?.images.map(item => item.url)).toEqual(["https://cdn.rule34.xxx/file.webp"]);
  });
});
