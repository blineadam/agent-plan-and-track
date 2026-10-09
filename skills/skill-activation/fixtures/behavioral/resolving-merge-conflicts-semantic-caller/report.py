from lib.store import fetch


def revenue():
    return sum(row["total"] for row in fetch("orders"))
