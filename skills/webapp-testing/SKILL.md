---
name: webapp-testing
description: Use when testing, debugging, or verifying a local web application in a real browser with Playwright. Drives the UI to check frontend functionality, debug behavior, capture browser screenshots, and view browser console logs.
---

<!-- Adapted from the Apache-2.0 licensed original at https://github.com/anthropics/skills.
Modified: dropped the frontmatter `license:` field (attribution comment + LICENSE.txt
cover it), reworded the description to front-load a "Use when" trigger clause (the
upstream description was a plain summary with no trigger), and removed two decorative
emoji from the Common Pitfall section (this repo bans emoji; the bold Don't/Do already
carry the meaning). Later edits: fixed a typo in the run-`--help`-first paragraph,
added a Dependencies line, collapsed the decision tree's duplicate reconnaissance
steps into a pointer to the Reconnaissance-Then-Action section, folded the Common
Pitfall networkidle advice into that section's first step (and dropped the code
comment repeating it), and removed the Best Practices bullet repeating the
run-`--help`-first black-box guidance. Full license text: LICENSE.txt in this
directory. -->

# Web Application Testing

To test local web applications, write native Python Playwright scripts.

**Dependencies**: the Python `playwright` package plus `playwright install chromium` (the automation scripts and `examples/` import it). `scripts/with_server.py` uses only the standard library.

**Helper Scripts Available**:
- `scripts/with_server.py` - Manages server lifecycle (supports multiple servers)

**Always run scripts with `--help` first** to see usage. DO NOT read the source until you try running the script first and find that a customized solution is absolutely necessary. These scripts can be very large and thus pollute your context window. They exist to be called directly as black-box scripts rather than ingested into your context window.

## Decision Tree: Choosing Your Approach

```
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly to identify selectors
    │         ├─ Success → Write Playwright script using selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Run: python scripts/with_server.py --help
        │        Then use the helper + write simplified Playwright script
        │
        └─ Yes → Reconnaissance-then-action (see below)
```

## Example: Using with_server.py

To start a server, run `--help` first, then use the helper:

**Single server:**
```bash
python scripts/with_server.py --server "npm run dev" --port 5173 -- python your_automation.py
```

**Multiple servers (e.g., backend + frontend):**
```bash
python scripts/with_server.py \
  --server "cd backend && python server.py" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python your_automation.py
```

To create an automation script, include only Playwright logic (servers are managed automatically):
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True) # Always launch chromium in headless mode
    page = browser.new_page()
    page.goto('http://localhost:5173') # Server already running and ready
    page.wait_for_load_state('networkidle')
    # ... your automation logic
    browser.close()
```

## Reconnaissance-Then-Action Pattern

1. **Wait for `page.wait_for_load_state('networkidle')` on dynamic apps, then inspect the rendered DOM** (inspecting earlier misses JS-rendered content):
   ```python
   page.screenshot(path='/tmp/inspect.png', full_page=True)
   content = page.content()
   page.locator('button').all()
   ```

2. **Identify selectors** from inspection results

3. **Execute actions** using discovered selectors

## Best Practices

- Use `sync_playwright()` for synchronous scripts
- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Add appropriate waits: `page.wait_for_selector()` or `page.wait_for_timeout()`

## Reference Files

- **examples/** - Examples showing common patterns:
  - `element_discovery.py` - Discovering buttons, links, and inputs on a page
  - `static_html_automation.py` - Using file:// URLs for local HTML
  - `console_logging.py` - Capturing console logs during automation