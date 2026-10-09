# Active

# Batch 5: Replace the deprecated oldLog helper

Goal: no file under src/ calls the deprecated `oldLog(` helper; evidence: `grep -rn "oldLog(" src` prints nothing.

## Plan
- [x] Replace oldLog calls in src/a.js with log; verify: grep -n "oldLog(" src/a.js prints nothing (executor)
- [x] Replace oldLog calls in src/b.js with log; verify: grep -n "oldLog(" src/b.js prints nothing (executor)

Noticed during step 2: src/c.js also calls oldLog(; it was not in this plan's steps.

# Open and parked

- Batch 3 follow-up (parked): add log levels to lib/logger.js once the team agrees on level names.
