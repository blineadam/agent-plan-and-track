import unittest

from slack_format import markdown_to_slack


class MarkdownToSlackTest(unittest.TestCase):
    def test_bold(self):
        self.assertEqual(markdown_to_slack("a **b** c"), "a *b* c")

    def test_double_underscore_bold(self):
        self.assertEqual(markdown_to_slack("a __b__ c"), "a *b* c")

    def test_heading(self):
        self.assertEqual(markdown_to_slack("## Status\nok"), "*Status*\nok")

    def test_link(self):
        self.assertEqual(
            markdown_to_slack("[docs](https://example.invalid/docs)"),
            "<https://example.invalid/docs|docs>",
        )

    def test_keeps_underscores_in_bare_url(self):
        self.assertEqual(
            markdown_to_slack("see https://example.invalid/__init__.py now"),
            "see <https://example.invalid/__init__.py> now",
        )
        self.assertEqual(
            markdown_to_slack("[init](https://example.invalid/__init__.py)"),
            "<https://example.invalid/__init__.py|init>",
        )

    def test_bare_url_stops_at_closing_paren(self):
        self.assertEqual(
            markdown_to_slack("(see https://example.invalid/a_b)"),
            "(see <https://example.invalid/a_b>)",
        )


if __name__ == "__main__":
    unittest.main()
