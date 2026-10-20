"""Convert the Markdown our summarizer emits into Slack mrkdwn."""
import re

LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
BARE_URL = re.compile(r"https?://[^\s)]+")
BOLD = re.compile(r"\*\*(.+?)\*\*|__(.+?)__")
HEADING = re.compile(r"^#{1,6}\s+(.*)$", re.MULTILINE)
PLACEHOLDER = re.compile(r"\x00(\d+)\x00")


def markdown_to_slack(text):
    """Return text with bold, headings, and links rewritten as Slack mrkdwn."""
    stash = []

    def keep(value):
        # URLs are parked behind placeholders so emphasis conversion cannot
        # rewrite the underscores or asterisks inside them.
        stash.append(value)
        return f"\x00{len(stash) - 1}\x00"

    text = LINK.sub(lambda m: f"<{keep(m.group(2))}|{m.group(1)}>", text)
    text = BARE_URL.sub(lambda m: keep(f"<{m.group(0)}>"), text)
    text = BOLD.sub(lambda m: f"*{m.group(1) or m.group(2)}*", text)
    text = HEADING.sub(lambda m: f"*{m.group(1)}*", text)
    return PLACEHOLDER.sub(lambda m: stash[int(m.group(1))], text)
