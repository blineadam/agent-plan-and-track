# Screenshot manifest

Run the bundled capture command against two prepared Git checkouts. Node needs the `playwright`
package resolvable and its Chromium build. Node does not search npm's global `lib/node_modules`, so
install into a prefix and point `NODE_PATH` at it:

```bash
npm install --prefix <dir> playwright
NODE_PATH=<dir>/node_modules node ~/.claude/skills/publish-visual-pr/scripts/smoke.js --manifest /absolute/path/to/visual-proof.json
```

The script starts `startup.argv` once in each checkout, captures every surface in a clean headless
Chromium context, writes full-viewport screenshots, focused crops, and `report.json` to `output_dir`,
then stops the server. It exits 1 for an undeclared visual change, a missing required control or font,
or an unapproved page or console error on the head revision. Baseline findings remain visible in the
report without making the proposed revision fail.

```json
{
  "base": { "path": "/absolute/path/to/base", "commit": "a1b2c3d4" },
  "head": { "path": "/absolute/path/to/head", "commit": "e5f6a7b8" },
  "output_dir": "/absolute/path/to/output",
  "startup": {
    "cwd": ".",
    "argv": ["python", "-m", "http.server", "{port}", "--bind", "127.0.0.1"],
    "ready_url": "http://127.0.0.1:{port}/",
    "url": "http://127.0.0.1:{port}/",
    "env": {},
    "timeout_seconds": 90
  },
  "browser": {
    "viewport": [1440, 900],
    "device_scale_factor": 2,
    "reduced_motion": "reduce",
    "color_scheme": "light",
    "locale": "en-US",
    "timezone_id": "UTC",
    "fixed_time": "2026-01-01T12:00:00Z"
  },
  "state": {
    "local_storage": { "example-state": "prepared" },
    "session_storage": {},
    "cookies": [],
    "init_scripts": [],
    "routes": [
      { "url": "**/api/example", "status": 200, "json": { "ready": true } }
    ]
  },
  "console_exceptions": [
    {
      "contains": "documented offline error",
      "reason": "The local screenshot environment deliberately runs without the optional service."
    }
  ],
  "surfaces": [
    {
      "name": "settings",
      "path": "/settings",
      "ready": { "selector": "[data-test='app-ready']", "state": "visible" },
      "actions": [
        { "type": "click", "selector": "[data-test='open-settings']" },
        { "type": "wait_for_selector", "selector": "[data-test='settings-panel']" }
      ],
      "crop": { "selector": "[data-test='settings-panel']" },
      "permitted_changes": [20, 80, 500, 400],
      "expected_controls": [{ "role": "button", "name": "Save" }],
      "expected_fonts": [{ "family": "Example Sans", "weight": 400 }]
    }
  ]
}
```

`base` and `head` are checkout paths and immutable commit prefixes. The command rejects a checkout
whose current `HEAD` does not match or whose tracked files are dirty. Prepare dependencies before
capture and keep the two checkouts separate.

Use `{port}` in startup values where the runner should insert an unused local port. `argv` is run
without a shell. `cwd` is relative to and must remain inside each revision root. The child process
inherits only ordinary shell and temporary-directory variables, POSIX and Windows alike; declare
project settings in `env`.
`ready_url` is polled before each capture, and `url` defaults to it.

`state` applies before navigation in every clean context. Storage values are strings. Storage and
custom init scripts run only in the top frame at the capture application's origin. Routes fulfill
matching requests in declaration order. Include only the stubs needed to make the stated behavior
deterministic. The origin guard matters because [Playwright init scripts also run when child frames
attach or navigate](https://playwright.dev/docs/api/class-page#page-add-init-script).

Each surface begins at `url + path`. Use `ready` for the stable element that proves the page has
finished replacing its loading state. `click`, `wait_for_selector`, and `wait` are the supported
actions. Add `head_only: true` to an action only when the base has no corresponding control. Crops
and `permitted_changes` use CSS-pixel `[x, y, width, height]` rectangles; a crop may instead use a
selector. If `permitted_changes` is omitted, only the crop region may differ. Required controls are
checked by accessible role and name. Font checks are opt-in, but record every family and weight whose
loading affects the evidence. A weight matches a loaded face when the face reports that single value,
when the face reports `normal` (400) or `bold` (700) and the weight equals it, or when the face reports
a variable font's declared `"<min> <max>"` range and the weight falls inside it inclusively. Every
console exception needs the substring to match and a source-based reason; the report preserves both.

Treat the manifest as trusted executable input because it supplies a startup command and JavaScript.
Use synthetic state instead of production credentials. The report omits storage values, cookie
values, startup environment values, route bodies, and init-script contents, but screenshots and
console errors can still contain private application data. Inspect them before uploading images.
