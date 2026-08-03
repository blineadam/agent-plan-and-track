# Line Wrapping Helper

## Batch 1: Fix the wrap-width constant

### Plan

- [ ] Step 1: correct the line-wrap-width constant so it matches the module's own documented limit; verify: `node -e "console.log(require('./src/format.js').MAX_LINE_WIDTH)"` prints 80 (executor)
