import argparse
import csv

from ledger.totals import totals_by_category


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ledger")
    sub = parser.add_subparsers(dest="command", required=True)
    totals = sub.add_parser("totals")
    totals.add_argument("--month")
    totals.add_argument("path")
    args = parser.parse_args(argv)

    with open(args.path, newline="") as handle:
        rows = list(csv.DictReader(handle))
    for category, amount in sorted(totals_by_category(rows, args.month).items()):
        print(f"{category}\t{amount:.2f}")
