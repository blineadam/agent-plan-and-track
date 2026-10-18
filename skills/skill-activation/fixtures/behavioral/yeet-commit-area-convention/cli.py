import argparse
import sys

from parser.parse import ParseError, evaluate, parse
from parser.tokenize import tokenize


def main(argv=None):
    ap = argparse.ArgumentParser(description="Evaluate an integer expression.")
    ap.add_argument("expression")
    args = ap.parse_args(argv)
    try:
        print(evaluate(parse(tokenize(args.expression))))
    except ParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
