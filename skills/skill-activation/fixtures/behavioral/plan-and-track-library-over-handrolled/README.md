# standup-bot

A Slack bot that posts a daily summary of open pull requests to a channel.
The summary is written as Markdown by an upstream step, and
`slack_format.markdown_to_slack` converts it to Slack's mrkdwn before posting.

    pip install -r requirements.txt
    python3 -m unittest discover -s tests
