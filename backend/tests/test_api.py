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
        admin_page = self.client.get("/admin/")
        self.assertEqual(admin_page.status_code, 200)
        self.assertEqual(admin_page.headers["cache-control"], "no-store")
        self.assertIn("admin.js?v=20261002-v6-fixes", admin_page.text)
        self.assertEqual(self.client.get("/static/admin.js").headers["cache-control"], "no-store")

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
        self.assertEqual(redeemed.json()["redeemed_by_username"], "portaria")

        redeemed_no_wristband = self.client.post(f"/api/cards/{second['token']}/redeem", json={"wristband": ""}, headers={"X-CSRF-Token": operator_csrf})
        self.assertEqual(redeemed_no_wristband.status_code, 200, redeemed_no_wristband.text)
        self.assertEqual(redeemed_no_wristband.json()["status"], "redeemed")
        self.assertEqual(redeemed_no_wristband.json()["wristband"], "")
        self.assertEqual(redeemed_no_wristband.json()["redeemed_by_username"], "portaria")

        scanned = self.client.get("/api/cards?status=redeemed")
        self.assertEqual(scanned.status_code, 200)
        self.assertEqual(scanned.json()["total"], 2)
        self.assertEqual(scanned.json()["items"][0]["redeemed_by_username"], "portaria")

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

    def test_only_admin_can_list_and_create_users(self):
        self.assertEqual(self.client.get("/api/users").status_code, 401)
        operator_csrf = self.login("portaria", "Another-secret-456")
        self.assertEqual(self.client.get("/api/users").status_code, 403)
        data = {"username": "nova.operadora", "password": "A-long-password-789", "role": "operator"}
        self.assertEqual(self.client.post("/api/users", json=data, headers={"X-CSRF-Token": operator_csrf}).status_code, 403)
        admin_csrf = self.login()
        listing = self.client.get("/api/users?page=1&page_size=20")
        self.assertEqual(listing.json()["total"], 2)
        self.assertNotIn("password_hash", listing.text)
        self.assertEqual(self.client.post("/api/users", json=data).status_code, 403)
        self.assertEqual(self.client.post("/api/users", json={**data, "password": "short"}, headers={"X-CSRF-Token": admin_csrf}).status_code, 422)
        created = self.client.post("/api/users", json=data, headers={"X-CSRF-Token": admin_csrf})
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(created.json()["role"], "operator")
        self.assertNotIn("password", created.text)
        self.assertEqual(self.client.get("/api/users").json()["total"], 3)
        self.assertEqual(self.client.post("/api/users", json=data, headers={"X-CSRF-Token": admin_csrf}).status_code, 409)
        self.assertEqual(self.client.post("/api/login", json={"username": "nova.operadora", "password": data["password"]}).status_code, 200)

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
        priority_only = self.client.patch(f"/api/partners/{identifier}", json={"priority": "alta"}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(priority_only.json()["manager"], "Ana")
        self.assertEqual(self.client.get("/api/partners?status=parceiro").json()["total"], 0)
        self.assertEqual(self.client.get("/api/partners?status=interessado").json()["total"], 1)
        self.assertEqual(self.client.get("/api/partners?q=%25").json()["total"], 0)
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

    def test_prospects_appear_as_origin_choices_and_register_on_issue(self):
        self.store.seed_partners(entries())
        csrf = self.login()
        options = self.client.get("/api/origins/options").json()
        self.assertEqual(len(options), 130)
        self.assertTrue(all(option["source"] == "prospect" for option in options))
        self.assertEqual(self.client.get("/api/origins").json()["total"], 0)
        chosen = next(option for option in options if option["name"] == "Pousada Bucaneiro")
        invalid = self.client.post("/api/cards", json={"origin_id": chosen["id"], "count": 101}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(self.client.get("/api/origins").json()["total"], 0)
        uncontracted = self.client.post("/api/cards", json={"origin_id": chosen["id"], "count": 2}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(uncontracted.status_code, 400)
        self.store.update_partner(chosen["id"], {"status": "parceiro"})
        issued = self.client.post("/api/cards", json={"origin_id": chosen["id"], "count": 2}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(issued.status_code, 201, issued.text)
        self.assertEqual(issued.json()[0]["origin_name"], "Pousada Bucaneiro")
        self.assertEqual(self.client.get("/api/origins").json()["total"], 1)
        refreshed = self.client.get("/api/origins/options").json()
        self.assertEqual(len(refreshed), 130)
        self.assertEqual(next(option for option in refreshed if option["name"] == "Pousada Bucaneiro")["source"], "origin")
        again = self.client.post("/api/cards", json={"origin_id": chosen["id"], "count": 1}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(again.status_code, 201, again.text)
        self.assertEqual(self.client.get("/api/origins").json()["total"], 1)

    def test_admissions_report_and_scanned_filter(self):
        csrf = self.login()
        origin = self.store.create_origin("Pousada Tartaruga", "Pousada", "admin")
        issued = self.store.issue(origin["id"], 5, None, "admin")
        token = issued[0]["token"]

        rep = self.client.get("/api/reports/admissions?days=30")
        self.assertEqual(rep.status_code, 200)
        data = rep.json()
        self.assertIn("summary", data)
        self.assertEqual(data["summary"]["total_issued"], 5)
        self.assertEqual(data["summary"]["total_admissions"], 0)
        self.assertEqual(data["summary"]["total_unused"], 5)

        scanned = self.client.get("/api/cards?status=redeemed")
        self.assertEqual(scanned.status_code, 200)
        self.assertEqual(scanned.json()["total"], 0)

        redeem_res = self.client.post(f"/api/cards/{token}/redeem", json={"wristband": "P-01"}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(redeem_res.status_code, 200)
        self.assertEqual(redeem_res.json()["status"], "redeemed")

        scanned = self.client.get("/api/cards?status=redeemed")
        self.assertEqual(scanned.json()["total"], 1)
        self.assertEqual(scanned.json()["items"][0]["wristband"], "P-01")

        rep_after = self.client.get("/api/reports/admissions?days=30")
        self.assertEqual(rep_after.json()["summary"]["total_admissions"], 1)
        self.assertEqual(rep_after.json()["summary"]["total_unused"], 4)


if __name__ == "__main__":
    unittest.main()
