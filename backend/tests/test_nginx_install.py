"""The installer must preserve unrelated Nginx routes on both success and failure."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.deploy import install_nginx


class InstallNginxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.sites = [root / "http", root / "https"]
        self.snippets = root / "snippets"
        self.sources = root / "sources"
        self.sources.mkdir()
        for site in self.sites:
            site.write_text("server {\n server_name _;\n location /stf/ {}\n}\n", encoding="utf-8")
        (self.sources / "http.conf").write_text("location /vibz/ { return 301 https://example.test; }\n", encoding="utf-8")
        (self.sources / "https.conf").write_text("location /vibz/ { proxy_pass http://127.0.0.1:8792/; }\n", encoding="utf-8")
        targets = ((self.sites[0], "http.conf", "server_name _;"),
                   (self.sites[1], "https.conf", "server_name _;"))
        self.addCleanup(patch.stopall)
        patch.object(install_nginx, "TARGETS", targets).start()
        patch.object(install_nginx, "SNIPPETS", self.snippets).start()
        patch.object(install_nginx, "HERE", self.sources).start()

    def test_inserts_both_routes_and_keeps_existing_route(self):
        with patch.object(install_nginx.subprocess, "run") as run:
            install_nginx.install()
        self.assertEqual(run.call_count, 2)
        for site in self.sites:
            self.assertIn("location /stf/", site.read_text(encoding="utf-8"))
            self.assertIn("include", site.read_text(encoding="utf-8"))
        self.assertTrue((self.snippets / "http.conf").exists())
        self.assertTrue((self.snippets / "https.conf").exists())

    def test_nginx_validation_failure_restores_both_sites(self):
        original = [site.read_text(encoding="utf-8") for site in self.sites]
        with patch.object(install_nginx.subprocess, "run", side_effect=[RuntimeError("nginx failed"), None, None]):
            with self.assertRaisesRegex(RuntimeError, "nginx failed"):
                install_nginx.install()
        self.assertEqual([site.read_text(encoding="utf-8") for site in self.sites], original)
        self.assertFalse((self.snippets / "http.conf").exists())
        self.assertFalse((self.snippets / "https.conf").exists())


if __name__ == "__main__":
    unittest.main()
