import unittest

import greet


class GreetTest(unittest.TestCase):
    def test_greeting(self):
        self.assertEqual(greet.greeting("Ada"), "Hello, Ada!")


if __name__ == "__main__":
    unittest.main()
