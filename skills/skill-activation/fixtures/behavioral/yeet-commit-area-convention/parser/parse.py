class ParseError(Exception):
    pass


PRECEDENCE = {"+": 1, "-": 1, "*": 2, "/": 2}


def parse(tokens):
    if not tokens:
        raise ParseError("empty expression")
    pos = 0

    def expr(min_prec):
        nonlocal pos
        kind, value = tokens[pos]
        if kind != "NUM":
            raise ParseError(f"expected a number, got {value!r}")
        pos += 1
        left = value
        while pos < len(tokens):
            _, op = tokens[pos]
            prec = PRECEDENCE[op]
            if prec < min_prec:
                break
            pos += 1
            left = (op, left, expr(prec + 1))
        return left

    return expr(1)


def evaluate(node):
    if isinstance(node, int):
        return node
    op, left, right = node
    a, b = evaluate(left), evaluate(right)
    return {"+": a + b, "-": a - b, "*": a * b, "/": a // b}[op]
