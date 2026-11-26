import { describe, expect, it } from "vitest";
import { discoverFromHtml, discoverFromCss, discoverStaticPage } from "../src/discovery";

describe("image discovery", () => {
  it("finds img, srcset, meta, linked images, CSS backgrounds and same-origin pages", () => {
    const html = [
      '<img src="/a.jpg" srcset="/a-small.jpg 1x, /a-large.webp 2x">',
      '<meta property="og:image" content="https://cdn.example.net/cover.png">',
      '<a href="/gallery/next">Next</a>',
      '<a href="/files/poster.avif">Poster</a>',
      '<div style="background-image:url(/background.png)"></div>',
      '<style>.hero{background:url("/hero.webp")}</style>',
      '<link rel="stylesheet" href="/site.css">'
    ].join("");
    const result = discoverFromHtml(html, "https://example.com/");
    expect(result.images.map(item => item.url)).toContain("https://example.com/a.jpg");
    expect(result.images.map(item => item.url)).toContain("https://example.com/a-large.webp");
    expect(result.images.map(item => item.url)).toContain("https://cdn.example.net/cover.png");
    expect(result.images.map(item => item.url)).toContain("https://example.com/background.png");
    expect(result.pages).toContain("https://example.com/gallery/next");
    expect(result.stylesheets).toContain("https://example.com/site.css");
  });

  it("extracts CSS url() references", () => {
    expect(discoverFromCss(".x{background:url('../images/a.gif')}", "https://example.com/css/site.css"))
      .toEqual(["https://example.com/images/a.gif"]);
  });

  it("skips font and non-image files in CSS and applies the per-page cap", () => {
    const css = ".a{background:url(/a.png)}@font-face{src:url(/font.woff2)}.b{background:url(/b.jpg)}";
    expect(discoverFromCss(css, "https://example.com/site.css", 1))
      .toEqual(["https://example.com/a.png"]);
  });

  it("skips font URLs in inline CSS", () => {
    const result = discoverFromHtml(
      '<style>@font-face{src:url(/font.woff)}.a{background:url(/background.png)}</style>',
      "https://example.com/",
      10
    );
    expect(result.images.map(item => item.url)).toEqual(["https://example.com/background.png"]);
  });
});


describe("static terminal pagination", () => {
  it("follows only the explicit next page control", () => {
    const html = [
      '<img src="/image.jpg">',
      '<a href="/about">About</a>',
      '<a rel="next" href="/page/2">Next</a>',
      '<a href="/page/3" class="next-link">Next page</a>'
    ].join("");
    const result = discoverStaticPage(html, "https://example.com/");
    expect(result.images.map(item => item.url)).toContain("https://example.com/image.jpg");
    expect(result.pages).toEqual(["https://example.com/page/2"]);
    expect(result.followPages).toBe(true);
  });

  it("does not follow cross-origin next links", () => {
    const result = discoverStaticPage(
      '<a rel="next" href="https://other.example/page/2">Next</a>',
      "https://example.com/"
    );
    expect(result.pages).toEqual([]);
  });
});
