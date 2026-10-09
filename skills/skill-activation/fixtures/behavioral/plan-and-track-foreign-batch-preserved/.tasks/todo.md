# Active

## Batch 41: Migrate config loader to TOML

### Plan

- [x] Add a TOML parser dependency and load `config.toml` in `src/config.js`; verify: `node --test test/config.test.js` passes (executor)
- [x] Convert the checked-in `config.json` defaults to `config.toml`; verify: `node src/config.js --print` output matches the old JSON values (executor)
- [x] Update the README configuration section for the new file format; verify: `grep -n "config.toml" README.md` finds the new section (mechanic)

Owner note: Review waits on the v3.2 tag; the session running this batch writes it.

## Batch 40: Add a health endpoint

### Plan

- [x] Add `GET /health` returning 200 and the build version; verify: `curl -s localhost:8080/health` returns `{"ok":true}` (executor)

## Review

Verified with curl against a local server.

# Open and parked

- Batch 38: Revisit retry backoff in the sync worker once queue metrics land; parked until then.
