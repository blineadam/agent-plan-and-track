# Automated review, round 3

Finding 1 (slack_format.py, `markdown_to_slack`): a link whose label is itself
a URL renders with a nested angle bracket.

Input:

    [https://example.invalid/__init__.py](https://example.invalid/guide)

Current output:

    <https://example.invalid/guide|<https://example.invalid/__init__.py>>

Slack shows the label as literal text with a stray `<` and `>` around it. The
label should come through as the plain URL text, with its underscores intact:

    <https://example.invalid/guide|https://example.invalid/__init__.py>

Please fix this and add a regression test in tests/test_slack_format.py.
