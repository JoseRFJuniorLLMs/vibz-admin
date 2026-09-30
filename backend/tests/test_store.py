import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from backend.store import Store, StoreError, parse_qr
from backend.seed_partners import entries


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "cards.sqlite3")
        self.origin = self.store.create_origin("Pousada Sol", "Pousada", "admin")

    def test_sequential_cards_across_concurrent_batches(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            batches = list(pool.map(
                lambda _: self.store.issue(self.origin["id"], 10, None, "admin"), range(4)
            ))
        cards = [card for batch in batches for card in batch]
        self.assertEqual(sorted(card["id"] for card in cards), list(range(1, 41)))
        self.assertEqual(len({card["token"] for card in cards}), 40)
        self.assertEqual(cards[0]["origin_name"], "Pousada Sol")

    def test_opaque_qr_and_one_time_redeem(self):
        card = self.store.issue(self.origin["id"], 1, None, "admin")[0]
        base = "https://35.247.217.66.nip.io/vibz/p"
        self.assertEqual(parse_qr(f"{base}/{card['token']}", base), card["token"])
        self.assertEqual(parse_qr(card["token"], base), card["token"])
        self.assertNotIn(card["number"], f"{base}/{card['token']}")
        with self.assertRaises(StoreError):
            parse_qr(f"https://evil.example/vibz/p/{card['token']}", base)
        first = self.store.redeem(card["token"], "0387", "operator")
        self.assertEqual(first["status"], "redeemed")
        self.assertEqual(first["wristband"], "0387")
        with self.assertRaises(StoreError) as second:
            self.store.redeem(card["token"], "9999", "operator")
        self.assertEqual(second.exception.status, 409)

    def test_concurrent_scans_only_one_redeems(self):
        card = self.store.issue(self.origin["id"], 1, None, "admin")[0]
        def redeem(wristband):
            try:
                return self.store.redeem(card["token"], wristband, "operator")["status"]
            except StoreError as exc:
                return exc.status
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(redeem, ("100", "101")))
        self.assertCountEqual(results, ["redeemed", 409])

    def test_invalid_origin_and_count_do_not_advance_sequence(self):
        with self.assertRaises(StoreError):
            self.store.issue("missing", 3, None, "admin")
        with self.assertRaises(StoreError):
            self.store.issue(self.origin["id"], 101, None, "admin")
        card = self.store.issue(self.origin["id"], 1, None, "admin")[0]
        self.assertEqual(card["id"], 1)

    def test_partner_seed_is_idempotent_and_keeps_edits(self):
        self.assertEqual(len(entries()), 130)
        self.assertEqual(self.store.seed_partners(entries()), 130)
        first = self.store.list_partners(1, 20)
        self.assertEqual(first["total"], 130)
        self.assertEqual(len(first["items"]), 20)
        self.assertTrue(all(item["status"] == "nao_contatado" for item in first["items"]))
        identifier = first["items"][0]["id"]
        self.store.update_partner(identifier, {"status": "contatado", "whatsapp": "22999999999"})
        self.assertEqual(self.store.seed_partners(entries()), 0)
        found = self.store.list_partners(1, 20, status="contatado")
        self.assertEqual(found["total"], 1)
        self.assertEqual(found["items"][0]["whatsapp"], "22999999999")
        self.assertEqual(len(self.store.list_partners(7, 20)["items"]), 10)
        self.assertFalse({item["id"] for item in first["items"]} &
                         {item["id"] for item in self.store.list_partners(2, 20)["items"]})

    def test_card_and_origin_pagination(self):
        self.store.issue(self.origin["id"], 25, None, "admin")
        newest = self.store.list_cards(1, 20)
        last = self.store.list_cards(2, 20)
        self.assertEqual((newest["total"], newest["pages"], len(last["items"])), (25, 2, 5))
        self.assertEqual(newest["items"][0]["number"], "VIBZ-000025")
        self.assertEqual(last["items"][-1]["number"], "VIBZ-000001")
        self.assertEqual(self.store.list_origins(1, 20)["total"], 1)


if __name__ == "__main__":
    unittest.main()
