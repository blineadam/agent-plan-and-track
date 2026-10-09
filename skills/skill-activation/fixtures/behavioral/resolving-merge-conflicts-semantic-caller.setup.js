'use strict';

// Setup for the resolving-merge-conflicts-semantic-caller behavioral case.
// The copied fixture dir is the shared base commit. From it:
//   - branch feature/where-filter (side B) gives lib/store.py's `fetch` an
//     optional `where` filter, editing the same lines side A rewrites, and adds
//     a NEW file, export.py, that calls `fetch(` with that filter;
//   - main (side A) renames `fetch` to `fetch_all`, updates every caller that
//     exists on main (app.py, report.py, the tests), and rewrites the same
//     lines of lib/store.py differently.
// `git merge feature/where-filter` on main then stops with a real textual
// conflict in lib/store.py only. export.py exists only on side B, so it
// auto-merges cleanly and still calls the old name `fetch(`: no conflict
// marker points at it. The merge is left in progress (MERGE_HEAD present).
//
// The repo gets a local identity and a no-op editor so the agent's own
// `git commit` finishes headlessly instead of failing on a missing identity
// or hanging in an editor; neither changes what the skill has to do.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const cwd = process.cwd();

function git(args, { allowFailure = false, date } = {}) {
  const env = { ...process.env };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  const result = spawnSync('git', args, { cwd, stdio: 'inherit', env });
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(`error: git ${args.join(' ')} exited ${result.status}\n`);
    process.exit(result.status || 1);
  }
  return result.status;
}

function write(rel, content) {
  fs.writeFileSync(path.join(cwd, rel), content);
}

const STORE_A = `"""In-memory table store."""

_TABLES = {}


def insert(table, row):
    _TABLES.setdefault(table, []).append(row)


def fetch_all(table):
    """Return a copy of every row in \`table\`, in insertion order."""
    rows = _TABLES.get(table, [])
    return list(rows)


def clear():
    _TABLES.clear()
`;

const STORE_B = `"""In-memory table store."""

_TABLES = {}


def insert(table, row):
    _TABLES.setdefault(table, []).append(row)


def fetch(table, where=None):
    """Return the rows in \`table\`, optionally only those where(row) is true."""
    rows = _TABLES.get(table, [])
    return [row for row in rows if where is None or where(row)]


def clear():
    _TABLES.clear()
`;

const EXPORT_B = `from lib.store import fetch


def paid_orders_csv():
    rows = fetch("orders", where=lambda row: row["status"] == "paid")
    return "\\n".join(f"{row['id']},{row['total']}" for row in rows)
`;

const APP_A = `from lib.store import fetch_all, insert


def record_order(order_id, total, status="open"):
    insert("orders", {"id": order_id, "total": total, "status": status})


def order_count():
    return len(fetch_all("orders"))
`;

const REPORT_A = `from lib.store import fetch_all


def revenue():
    return sum(row["total"] for row in fetch_all("orders"))
`;

const TEST_A = `import unittest

from lib import store


class StoreTest(unittest.TestCase):
    def setUp(self):
        store.clear()

    def test_fetch_all_returns_inserted_rows(self):
        store.insert("orders", {"id": 1, "total": 5, "status": "open"})
        self.assertEqual(len(store.fetch_all("orders")), 1)

    def test_fetch_all_unknown_table_is_empty(self):
        self.assertEqual(store.fetch_all("missing"), [])


if __name__ == "__main__":
    unittest.main()
`;

git(['init', '-b', 'main']);
git(['config', 'user.email', 'fixture@example.invalid']);
git(['config', 'user.name', 'Fixture']);
git(['config', 'commit.gpgsign', 'false']);
git(['config', 'core.editor', 'true']);

// The fixture files are staged by name (not `git add -A`) so the tracked set
// does not depend on the caller's global excludes.
git(['add', '--', 'lib', 'app.py', 'report.py', 'tests'], {});
git(['commit', '-m', 'Add the in-memory order store and its callers'], {
  date: '2026-09-01T09:00:00+00:00',
});

// Side B: where-filter on fetch plus a new caller in a new file.
git(['checkout', '-b', 'feature/where-filter']);
write('lib/store.py', STORE_B);
write('export.py', EXPORT_B);
git(['add', '--', 'lib/store.py', 'export.py']);
git(['commit', '-m', 'Let fetch take a where filter and add a paid-orders CSV export'], {
  date: '2026-09-03T09:00:00+00:00',
});

// Side A: rename fetch to fetch_all everywhere it is called on main.
git(['checkout', 'main']);
write('lib/store.py', STORE_A);
write('app.py', APP_A);
write('report.py', REPORT_A);
write('tests/test_store.py', TEST_A);
git(['add', '--', 'lib/store.py', 'app.py', 'report.py', 'tests/test_store.py']);
git(['commit', '-m', 'Rename fetch to fetch_all and update its callers'], {
  date: '2026-09-04T09:00:00+00:00',
});

// The merge must stop on the lib/store.py conflict; any other outcome is a
// broken fixture.
const mergeStatus = git(['merge', '--no-edit', 'feature/where-filter'], { allowFailure: true });
if (mergeStatus === 0 || !fs.existsSync(path.join(cwd, '.git', 'MERGE_HEAD'))) {
  process.stderr.write('error: expected the merge to stop on a conflict with MERGE_HEAD present\n');
  process.exit(1);
}
