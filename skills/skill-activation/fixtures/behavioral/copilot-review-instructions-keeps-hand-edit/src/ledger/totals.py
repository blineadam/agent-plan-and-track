from collections import defaultdict


def totals_by_category(rows, month=None):
    sums = defaultdict(float)
    for row in rows:
        if month and not row["date"].startswith(month):
            continue
        sums[row["category"]] += float(row["amount"])
    return dict(sums)
