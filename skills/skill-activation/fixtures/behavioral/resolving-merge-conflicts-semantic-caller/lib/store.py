"""In-memory table store."""

_TABLES = {}


def insert(table, row):
    _TABLES.setdefault(table, []).append(row)


def fetch(table):
    """Return every row in `table`."""
    rows = _TABLES.get(table, [])
    return list(rows)


def clear():
    _TABLES.clear()
