# Active

# Batch 7: Move temperature helpers to the descriptive units API and add Kelvin support

Goal: src/ calls only the descriptive conversion names, Kelvin conversions, formatting, and a freeze alert exist, docs/units.md documents every conversion, `node check.js` prints `all checks passed`, and CHANGELOG.md records it all; evidence: `node check.js` output and `grep -rn "cToF(" src` printing only the deprecated alias in src/units.js.

## Plan

### Phase 1: rename
- [ ] Rename `cToF` to `celsiusToFahrenheit` in src/units.js and keep `cToF` exported as a deprecated alias of it; verify: `node -e "require('./src/units').celsiusToFahrenheit(100)"` exits 0 (mechanic)
- [ ] Switch src/report.js to `celsiusToFahrenheit`; verify: `grep -n "cToF(" src/report.js` prints nothing (mechanic)
- [ ] Switch src/alerts.js to `celsiusToFahrenheit`; verify: `grep -n "cToF(" src/alerts.js` prints nothing (mechanic)
- [ ] Add `fahrenheitToCelsius(f, opts)` to src/units.js with a rounding option; the option name is still open (`precision` or `digits`, either is acceptable), so pick one and note it here; verify: `node -e "require('./src/units').fahrenheitToCelsius(212)"` exits 0 (mechanic)
- [ ] Switch every remaining `cToF(` caller outside src/units.js to `celsiusToFahrenheit`; verify: `grep -rn "cToF(" --include=*.js .` shows only src/units.js and files you may not edit (mechanic)

Phase 1 checkpoint: the rename is shippable on its own from here.

### Phase 2: Kelvin
- [ ] Add `celsiusToKelvin(c)` and `kelvinToCelsius(k)` to src/units.js; behavior below absolute zero is still open (throw a RangeError or clamp to the limit, either is acceptable), so pick one and note it here; verify: `node -e "require('./src/units').celsiusToKelvin(0)"` exits 0 (mechanic)
- [ ] Add `formatKelvin(celsius)` to src/report.js returning the Kelvin value to one decimal followed by ` K` (0 gives `273.1 K` or `273.2 K` depending on rounding, either is fine); verify: `node -e "console.log(require('./src/report').formatKelvin(0))"` ends in ` K` (mechanic)
- [ ] Add `isFreezing(celsius)` to src/alerts.js, true at or below 0 C; verify: `node -e "process.exit(require('./src/alerts').isFreezing(0) ? 0 : 1)"` exits 0 (mechanic)
- [ ] Create docs/units.md documenting every exported conversion in src/units.js with one example each; table or list layout is still open, either is acceptable; verify: `grep -c "celsiusToKelvin\|kelvinToCelsius\|fahrenheitToCelsius\|celsiusToFahrenheit" docs/units.md` is at least 4 (mechanic)
- [ ] Add src/index.js re-exporting everything from src/units.js, src/report.js, and src/alerts.js; verify: `node -e "require('./src')"` exits 0 (mechanic)
- [ ] Run the batch check; verify: `node check.js` prints `all checks passed` (mechanic)
- [ ] Add CHANGELOG.md entries under Unreleased for the rename, the inverse, and the Kelvin support; verify: `grep -n "kelvinToCelsius" CHANGELOG.md` matches (mechanic)

# Open and parked
