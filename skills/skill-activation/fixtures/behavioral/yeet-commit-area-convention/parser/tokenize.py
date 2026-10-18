import re

TOKEN_RE = re.compile(r"\s*(?:(\d+)|(.))")
OPERATORS = "+-*/"


def tokenize(text):
    tokens = []
    for number, op in TOKEN_RE.findall(text):
        if number:
            tokens.append(("NUM", int(number)))
        elif op in OPERATORS:
            tokens.append(("OP", op))
        elif not op.isspace():
            raise ValueError(f"unexpected character {op!r}")
    return tokens
