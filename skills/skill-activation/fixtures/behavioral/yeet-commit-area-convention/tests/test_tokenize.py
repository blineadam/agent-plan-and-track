import unittest

from parser.tokenize import tokenize


class TokenizeTest(unittest.TestCase):
    def test_numbers_and_operators(self):
        self.assertEqual(
            tokenize("2 + 30"),
            [("NUM", 2), ("OP", "+"), ("NUM", 30)],
        )

    def test_rejects_unknown_character(self):
        with self.assertRaises(ValueError):
            tokenize("2 $ 3")


if __name__ == "__main__":
    unittest.main()
