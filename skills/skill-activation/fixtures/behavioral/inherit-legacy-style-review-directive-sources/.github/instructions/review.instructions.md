---
applyTo: "src/**"
excludeAgent: "cloud-agent"
---

# Review rules for src

## Money

Flag an amount of money held as a `float` or `Decimal`, or named without a `_cents` suffix. Money is integer cents throughout; see `.ai-style-rules.md`.

## Errors

Flag a function that returns `None` to signal failure. Raise a subclass of `ShipcalcError` from `src/shipcalc/errors.py` instead.
