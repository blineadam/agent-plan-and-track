import unittest

import cli


class CliTest(unittest.TestCase):
    def test_returns_zero_on_success(self):
        self.assertEqual(cli.main(["1 + 2"]), 0)

    def test_returns_one_on_parse_error(self):
        self.assertEqual(cli.main(["+"]), 1)


if __name__ == "__main__":
    unittest.main()
