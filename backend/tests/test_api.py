import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import Settings, create_app
from backend.auth import hash_password
from backend.store import Store
from backend.seed_partners import entries


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "cards.sqlite3")
        self.store.create_user("vibz-admin", hash_password("A-strong-secret-123"), "admin")
        self.store.create_user("portaria", hash_password("Another-secret-456"), "operator")
        settings = Settings(
            db_path=self.store.path,
            public_base_url="https://35.247.217.66.nip.io/vibz-admin/p",
            secure_cookie=False,
            cookie_path="/",
        )
        self.client = TestClient(create_app(settings, self.store))
        self.addCleanup(self.client.close)

    def login(self, username="vibz-admin", password="A-strong-secret-123"):
        response = self.client.post("/api/login", json={"username": username, "password": password})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["csrf_token"]

    def test_root_links_to_admin_page(self):
        root = self.client.get("/", follow_redirects=False)
        self.assertEqual(root.status_code, 307)
        self.assertEqual(root.headers["location"], "admin/")
        self.assertEqual(self.client.get("/admin/").status_code, 200)

    def test_login_csrf_roles_and_redeem(self):
        self.assertEqual(self.client.get("/api/cards").status_code, 401)
        self.assertEqual(self.client.post("/api/login", json={"username": "vibz-admin", "password": "wrong"}).status_code, 401)
        csrf = self.login()
        self.assertEqual(self.client.get("/api/session").json()["role"], "admin")
        origin_data = {"name": "Pousada Sol", "category": "Pousada"}
        self.assertEqual(self.client.post("/api/origins", json=origin_data).status_code, 403)
        origin = self.client.post("/api/origins", json=origin_data, headers={"X-CSRF-Token": csrf})
        self.assertEqual(origin.status_code, 201, origin.text)
        batch = self.client.post("/api/cards", json={"origin_id": origin.json()["id"], "count": 2}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(batch.status_code, 201, batch.text)
        first, second = batch.json()
        self.assertEqual([first["number"], second["number"]], ["VIBZ-000001", "VIBZ-000002"])
        self.assertIn("<svg", self.client.get(f"/api/cards/{first['token']}/qr.svg").text)
        lookup = self.client.post("/api/lookup", json={"qr": first["qr_url"]})
        self.assertEqual(lookup.json()["origin_name"], "Pousada Sol")
        self.assertEqual(self.client.post("/api/logout", headers={"X-CSRF-Token": csrf}).status_code, 204)
        self.assertEqual(self.client.get("/api/session").status_code, 401)

        operator_csrf = self.login("portaria", "Another-secret-456")
        self.assertEqual(self.client.post("/api/cards", json={"origin_id": origin.json()["id"], "count": 1}, headers={"X-CSRF-Token": operator_csrf}).status_code, 403)
        redeemed = self.client.post(f"/api/cards/{first['token']}/redeem", json={"wristband": "0387"}, headers={"X-CSRF-Token": operator_csrf})
        self.assertEqual(redeemed.status_code, 200, redeemed.text)
        self.assertEqual(redeemed.json()["status"], "redeemed")
        duplicate = self.client.post(f"/api/cards/{first['token']}/redeem", json={"wristband": "0388"}, headers={"X-CSRF-Token": operator_csrf})
        self.assertEqual(duplicate.status_code, 409)

    def test_public_pass_does_not_disclose_origin_or_status(self):
        origin = self.store.create_origin("Hotel Central", "Hotel", "admin")
        card = self.store.issue(origin["id"], 1, None, "admin")[0]
        page = self.client.get(f"/p/{card['token']}")
        self.assertEqual(page.status_code, 200)
        self.assertNotIn("Hotel Central", page.text)
        self.assertNotIn(card["number"], page.text)
        self.assertEqual(page.headers["cache-control"], "no-store")

    def test_password_reset_revokes_active_session(self):
        self.login()
        self.assertEqual(self.client.get("/api/session").status_code, 200)
        self.assertTrue(self.store.set_password("vibz-admin", hash_password("New-secret-value-789")))
        self.assertEqual(self.client.get("/api/session").status_code, 401)
        self.assertEqual(self.client.post("/api/login", json={"username": "vibz-admin", "password": "A-strong-secret-123"}).status_code, 401)
        self.assertEqual(self.client.post("/api/login", json={"username": "vibz-admin", "password": "New-secret-value-789"}).status_code, 200)

    def test_login_rate_limit_applies_across_usernames(self):
        for number in range(8):
            response = self.client.post("/api/login", json={"username": f"unknown-{number}", "password": "bad"})
            self.assertEqual(response.status_code, 401)
        locked = self.client.post("/api/login", json={"username": "vibz-admin", "password": "A-strong-secret-123"})
        self.assertEqual(locked.status_code, 429)

    def test_partner_listing_and_admin_updates(self):
        self.store.seed_partners(entries())
        self.assertEqual(self.client.get("/api/partners").status_code, 401)
        csrf = self.login()
        page = self.client.get("/api/partners?page=2&page_size=20")
        self.assertEqual(page.status_code, 200)
        self.assertEqual((page.json()["total"], page.json()["pages"], len(page.json()["items"])), (130, 7, 20))
        filtered = self.client.get("/api/partners?category=praia&q=Tawa")
        self.assertEqual(filtered.json()["total"], 1)
        identifier = filtered.json()["items"][0]["id"]
        self.assertEqual(self.client.patch(f"/api/partners/{identifier}", json={"status": "parceiro"}).status_code, 403)
        self.assertEqual(self.client.patch(f"/api/partners/{identifier}", json={"status": "unknown"}, headers={"X-CSRF-Token": csrf}).status_code, 422)
        updated = self.client.patch(f"/api/partners/{identifier}", json={"status": "interessado", "manager": "Ana"}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["status"], "interessado")
        self.assertEqual(self.client.get("/api/partners?status=parceiro").json()["total"], 0)
        self.assertEqual(self.client.get("/api/partners?status=interessado").json()["total"], 1)
        self.assertEqual(self.client.get("/api/partners?page=0").status_code, 422)

    def test_paged_cards_keep_origin_options_complete(self):
        csrf = self.login()
        for number in range(23):
            self.store.create_origin(f"Origem {number:02d}", "Pousada", "admin")
        self.assertEqual(self.client.get("/api/origins?page=2&page_size=20").json()["total"], 23)
        self.assertEqual(len(self.client.get("/api/origins/options").json()), 23)
        origin_id = self.client.get("/api/origins/options").json()[0]["id"]
        self.assertEqual(self.client.post("/api/cards", json={"origin_id": origin_id, "count": 21}, headers={"X-CSRF-Token": csrf}).status_code, 201)
        last = self.client.get("/api/cards?page=2&page_size=20").json()
        self.assertEqual((last["total"], last["pages"], len(last["items"])), (21, 2, 1))


if __name__ == "__main__":
    unittest.main()
