from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from bs4 import BeautifulSoup

from scraper.sites import get_site, list_sites
from scraper.static_html import extract_media_urls, scrape_static_pages


class ImageOnlyRegistryTests(unittest.TestCase):
    def test_supported_sites_are_image_only_registry(self) -> None:
        self.assertEqual(
            list_sites(),
            ["sex.com", "rule34", "realbooru", "elitebabes", "buondua", "static"],
        )

    def test_video_site_is_not_registered(self) -> None:
        self.assertIsNone(get_site("pornhub"))

    def test_all_supported_adapters_resolve(self) -> None:
        for name in list_sites():
            with self.subTest(site=name):
                self.assertIsNotNone(get_site(name))

    def test_static_discovery_ignores_video_sources(self) -> None:
        soup = BeautifulSoup(
            """<html><body>
            <video><source src="https://cdn.test/clip.mp4" type="video/mp4"></video>
            <picture><source srcset="https://cdn.test/poster.webp" type="image/webp"><img src="https://cdn.test/fallback.jpg"></picture>
            <img src="https://cdn.test/other.m3u8">
            </body></html>""",
            "html.parser",
        )
        urls = extract_media_urls(soup, "https://site.test/gallery")
        self.assertEqual(
            urls,
            ["https://cdn.test/poster.webp", "https://cdn.test/fallback.jpg"],
        )

    def test_static_r2_mode_skips_local_disk_space_check(self) -> None:
        soup = BeautifulSoup("<html><body>No images here</body></html>", "html.parser")
        with (
            patch("scraper.static_html.config.STORAGE_BACKEND", "r2"),
            patch("scraper.static_html.free_space_mb", side_effect=AssertionError("R2 is not a local disk")),
            patch("scraper.static_html.fetch_page", return_value=(soup, "https://site.test/", str(soup))),
        ):
            stats = scrape_static_pages(
                session=None,
                start_url="https://site.test/",
                dest_dir=Path("/tmp/pscraper-test"),
                max_pages=1,
            )
        self.assertEqual(stats["pages"], 1)


if __name__ == "__main__":
    unittest.main()
