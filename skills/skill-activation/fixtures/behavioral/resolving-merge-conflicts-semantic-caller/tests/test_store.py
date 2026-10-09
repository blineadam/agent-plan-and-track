import unittest

from lib import store


class StoreTest(unittest.TestCase):
    def setUp(self):
        store.clear()

    def test_fetch_returns_inserted_rows(self):
        store.insert("orders", {"id": 1, "total": 5, "status": "open"})
        self.assertEqual(len(store.fetch("orders")), 1)

    def test_fetch_unknown_table_is_empty(self):
        self.assertEqual(store.fetch("missing"), [])


if __name__ == "__main__":
    unittest.main()
