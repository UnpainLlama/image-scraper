import { describe, expect, it } from "vitest";
import { discoverSexComApiPage, discoverSiteSpecificHtml, isSexComUrl, normalizeSiteListingUrl } from "../src/site-adapters";

describe("image-only source adapters", () => {
  it("resolves Rule34 sample image URLs and strips cache query strings", () => {
    const result = discoverSiteSpecificHtml(
      '<span class="thumb"><a href="/index.php?page=post&s=view&id=123"><img src="//img.rule34.xxx/thumbnails/ab/cd/thumbnail_hash.jpg?cache=1"></a></span>',
      "https://rule34.xxx/index.php?page=post&s=list&tags=test"
    );
    expect(result?.images.map(item => item.url)).toContain("https://img.rule34.xxx/samples/ab/cd/sample_hash.jpg");
    expect(result?.followPages).toBe(true);
  });

  it("continues Rule34 listing offsets by 42 when the page has no explicit next link", () => {
    const result = discoverSiteSpecificHtml(
      '<span class="thumb"><a href="/index.php?page=post&s=view&id=123"><img src="/thumbnails/thumbnail_a.jpg"></a></span>',
      "https://rule34.xxx/index.php?page=post&s=list&tags=test&pid=84"
    );
    expect(result?.pages).toEqual([
      "https://rule34.xxx/index.php?page=post&s=list&tags=test&pid=126"
    ]);
  });

  it("resolves the original Rule34 image when a post page is supplied", () => {
    const result = discoverSiteSpecificHtml(
      '<img id="image" src="https://img.rule34.xxx/images/ab/cd/original.jpg"><video><source src="/clip.mp4"></video>',
      "https://rule34.xxx/index.php?page=post&s=view&id=123"
    );
    expect(result?.images.map(item => item.url)).toEqual(["https://img.rule34.xxx/images/ab/cd/original.jpg"]);
  });

  it("does not enqueue another Rule34 page for an empty listing", () => {
    const result = discoverSiteSpecificHtml(
      '<div class="empty">No posts</div>',
      "https://rule34.xxx/index.php?page=post&s=list&tags=test&pid=126"
    );
    expect(result?.pages).toEqual([]);
    expect(result?.images).toEqual([]);
  });

  it("follows Realbooru post pages and listing offsets by 42", () => {
    const result = discoverSiteSpecificHtml(
      '<a href="/index.php?page=post&s=view&id=123"><img src="/thumbnails/thumbnail_hash.jpg"></a>',
      "https://realbooru.com/index.php?page=post&s=list&tags=test&pid=42"
    );
    expect(result?.pages).toContain("https://realbooru.com/index.php?page=post&s=view&id=123");
    expect(result?.pages).toContain("https://realbooru.com/index.php?page=post&s=list&tags=test&pid=84");
    expect(result?.followPages).toBe(true);
  });

  it("uses Realbooru's non-thumbnail /images fallback when #image is absent", () => {
    const result = discoverSiteSpecificHtml(
      '<a href="https://img.realbooru.com/images/aa/bb/full-image.webp">original</a><img src="https://img.realbooru.com/thumbnails/aa/bb/thumbnail-image.jpg">',
      "https://realbooru.com/index.php?page=post&s=view&id=123"
    );
    expect(result?.images.map(item => item.url)).toEqual(["https://img.realbooru.com/images/aa/bb/full-image.webp"]);
  });

  it("follows EliteBabes galleries and sequential list pages, then extracts full-size images only", () => {
    const listing = discoverSiteSpecificHtml(
      '<ul class="list-gallery"><li><a href="/gallery-one/"><img src="https://cdn.elitebabes.com/content/a_masonry_400.jpg"></a></li></ul>',
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

  it("increments EliteBabes tag-list page numbers", () => {
    const listing = discoverSiteSpecificHtml(
      '<ul class="list-gallery"><li><a href="/gallery-one/"><img src="https://cdn.elitebabes.com/content/a.jpg"></a></li></ul>',
      "https://www.elitebabes.com/tag/models/page/3/"
    );
    expect(listing?.pages).toContain("https://www.elitebabes.com/tag/models/page/4/");
  });

  it("discovers Buondua albums and synthesizes the next listing offset by 20", () => {
    const listing = discoverSiteSpecificHtml(
      '<a class="item-link" href="/sample-album-456">album</a>',
      "https://buondua.com/"
    );
    expect(listing?.pages).toContain("https://buondua.com/sample-album-456");
    expect(listing?.pages).toContain("https://buondua.com/?start=20");
  });

  it("continues Buondua album image pagination", () => {
    const album = discoverSiteSpecificHtml(
      '<img src="https://i2.buondua.com/2026/456/photo-001.jpeg"><a href="?page=2">2</a><a href="?page=3">3</a>',
      "https://buondua.com/sample-album-456"
    );
    expect(album?.images.map(item => item.url)).toEqual(["https://i2.buondua.com/2026/456/photo-001.jpeg"]);
    expect(album?.pages).toContain("https://buondua.com/sample-album-456?page=2");
  });

  it("discovers GIF files in EliteBabes galleries and Buondua albums", () => {
    const eliteBabes = discoverSiteSpecificHtml(
      '<a href="https://cdn.elitebabes.com/content/animated.gif">animated gallery image</a>',
      "https://www.elitebabes.com/gallery-one/"
    );
    expect(eliteBabes?.images.map(item => item.url)).toEqual([
      "https://cdn.elitebabes.com/content/animated.gif"
    ]);

    const buondua = discoverSiteSpecificHtml(
      '<img src="https://i2.buondua.com/2026/456/animated.gif">',
      "https://buondua.com/sample-album-456"
    );
    expect(buondua?.images.map(item => item.url)).toEqual([
      "https://i2.buondua.com/2026/456/animated.gif"
    ]);
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

  it("normalizes bare Rule34 and Realbooru hosts to their listing endpoints", () => {
    const rule34 = new URL(normalizeSiteListingUrl("https://rule34.xxx/?tags=fox_girl"));
    expect(rule34.pathname).toBe("/index.php");
    expect(rule34.searchParams.get("page")).toBe("post");
    expect(rule34.searchParams.get("s")).toBe("list");
    expect(rule34.searchParams.get("tags")).toBe("fox_girl");

    const realbooru = new URL(normalizeSiteListingUrl("https://realbooru.com/"));
    expect(realbooru.pathname).toBe("/index.php");
    expect(realbooru.searchParams.get("s")).toBe("list");
  });

  it("does not rewrite an explicitly supplied booru post URL", () => {
    const post = "https://rule34.xxx/index.php?page=post&s=view&id=123";
    expect(normalizeSiteListingUrl(post)).toBe(post);
  });


  it("preserves EliteBabes list-thumbnail mode separately from full-size galleries", () => {
    const html = '<ul class="list-gallery"><li><a href="/gallery-one/"><img src="https://cdn.elitebabes.com/content/a_masonry_400.jpg"></a></li></ul>';
    const thumbnails = discoverSiteSpecificHtml(html, "https://www.elitebabes.com/", { eliteBabesMode: "images" });
    expect(thumbnails?.images.map(item => item.url)).toEqual([
      "https://cdn.elitebabes.com/content/a_masonry_400.jpg"
    ]);
    expect(thumbnails?.pages).toContain("https://www.elitebabes.com/page/2/");

    const galleries = discoverSiteSpecificHtml(html, "https://www.elitebabes.com/", { eliteBabesMode: "galleries" });
    expect(galleries?.images).toEqual([]);
    expect(galleries?.pages).toContain("https://www.elitebabes.com/gallery-one/");
  });

});