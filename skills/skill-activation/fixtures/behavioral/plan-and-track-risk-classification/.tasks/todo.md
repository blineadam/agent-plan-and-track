# Runner Deadline Handling

Batch 1: Add the child-process spawn wrapper: done 2026-07-30, PR #201
Batch 2: Document the runner CLI usage: done 2026-08-01. Added a README section covering the command-line flags.

## Batch 3: Give the runner a termination deadline

### Plan

- [ ] Step 1: give the child-process runner a fixed-deadline termination path so a stuck command doesn't hang the batch forever; verify: `node src/runner.js sleep 10` exits once the deadline elapses (executor)
- [ ] Step 2: note the new termination behavior in this file's usage section once it's confirmed working; verify: the note reads back correctly (executor)
