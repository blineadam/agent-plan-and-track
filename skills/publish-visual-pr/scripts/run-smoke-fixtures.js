#!/usr/bin/env node
/**
 * run-smoke-fixtures.js: free end-to-end proof that smoke.js works.
 *
 * Builds five temporary git checkouts of tiny static pages (base/head pairs,
 * each differing only in a button label), serves each with a one-file Node
 * http server started via startup.argv, and runs smoke.js against seven
 * manifests, plus one pure unit block:
 *
 *   0. checkFonts is pure, so its weight-matching logic (single value,
 *      normal/bold, variable-font range) is exercised directly against
 *      synthetic records, without a browser.
 *   1. permitted_changes covers the panel region -> exit 0, "panel:
 *      base=PASS head=PASS", report.json with surfaces.panel.diff.status
 *      "PASS", and non-empty panel-base.png/panel-head.png crops.
 *   2. permitted_changes does not cover the change -> exit 1, diff.status
 *      "FAIL" with a non-null diff_bbox.
 *   3. expected_controls names a control that exists only on head -> base
 *      reports FINDING, head reports PASS. Reuses case 1's base checkout,
 *      which is byte-for-byte the same fixture HTML.
 *   4. expected_fonts names a font that never loads -> head's fonts check
 *      FAILs with that font in detail.missing, and record.font_faces is an
 *      array (proves page.evaluate invokes a real function rather than
 *      leaving an arrow-function string uninvoked). Reuses case 1's
 *      checkouts.
 *   5. device_scale_factor 2, with permitted_changes set to exactly the
 *      changed button's CSS rect -> PASS; shrunk to a rect that excludes the
 *      button -> FAIL with a non-null diff_bbox (proves permitted-rect
 *      device-px conversion at a non-1 scale).
 *   6. startup.argv backgrounds the real server behind a shell wrapper, so
 *      the server is a grandchild -> exit 0, and no process matching a
 *      distinctive marker survives smoke.js (proves terminate() kills the
 *      whole process tree, not just the direct child).
 *   7. the manifest declares two surfaces with the same name -> exit 1 with
 *      the duplicate-name error on stderr, and a marker file that
 *      startup.argv would have created is never written (proves the
 *      manifest is rejected before any server starts).
 *
 * Usage: node run-smoke-fixtures.js
 *
 * Exit codes: 0 every assertion passed, 1 any assertion failed.
 *
 * Dependencies: Node core modules (child_process, fs, os, path) only, plus
 * this repo's own render.js (for requirePlaywright). It resolves
 * `playwright` the same way smoke.js does (installed globally for Node, or
 * reachable via NODE_PATH), only to fail fast with a one-line message before
 * spawning any child process if the package is missing; the actual browser
 * automation happens in the smoke.js child processes this script spawns.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const render = require('./render');
const checks = require('./checks');

const SCRIPT_DIR = __dirname;
const SMOKE = path.join(SCRIPT_DIR, 'smoke.js');
const SMOKE_TIMEOUT_MS = 120000;

let failures = 0;

function report(label, condition, detail) {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${label}${detail ? ` (${detail})` : ''}`);
  }
}

function git(cwd, gitHome, args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', ...args],
    { cwd, env: { ...process.env, HOME: gitHome }, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

const SERVE_JS = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const port = Number(process.argv[2]);
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}).listen(port, '127.0.0.1');
`;

function pageHtml({ buttonLabel, includeExport }) {
  return `<!doctype html>
<html>
<body style="margin:0;">
<div data-test="app-ready" style="margin:20px;">
  <div data-test="panel" style="width:220px; height:100px; background:#ffffff; border:1px solid #000000; font-family:sans-serif;">
    <button data-test="save-button">${buttonLabel}</button>
    ${includeExport ? '<button data-test="export-button">Export</button>' : ''}
  </div>
</div>
</body>
</html>
`;
}

// A fixed-layout page for the device_scale_factor 2 fixture: the panel and
// its button sit at absolute CSS positions/sizes (no default border/padding,
// no native button theming) so the button's rendered rect is exactly
// [80, 100, 120, 40] in CSS px, confirmed against a live boundingBox() before
// this value was hardcoded here.
function scale2PageHtml({ buttonLabel }) {
  return `<!doctype html>
<html>
<body style="margin:0;">
  <div data-test="panel" style="position:absolute; left:20px; top:20px; width:400px; height:200px; background:#ffffff; margin:0; padding:0; border:0; box-sizing:border-box; font-family:sans-serif;">
    <button data-test="save-button" style="position:absolute; left:60px; top:80px; width:120px; height:40px; box-sizing:border-box; margin:0; padding:0; border:0; appearance:none; -webkit-appearance:none; background:#dddddd;">${buttonLabel}</button>
  </div>
</body>
</html>
`;
}

function buildRepo(root, gitHome, html) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), html);
  fs.writeFileSync(path.join(root, 'serve.js'), SERVE_JS);
  git(root, gitHome, ['init', '--quiet']);
  git(root, gitHome, ['add', '.']);
  git(root, gitHome, ['commit', '--quiet', '-m', 'fixture revision']);
  return git(root, gitHome, ['rev-parse', 'HEAD']).trim();
}

function writeManifest(
  manifestPath,
  {
    basePath,
    baseSha,
    headPath,
    headSha,
    outputDir,
    permittedChanges,
    expectedControls,
    expectedFonts,
    deviceScaleFactor,
    viewport,
    readySelector,
    cropSelector,
  }
) {
  const manifest = {
    base: { path: basePath, commit: baseSha },
    head: { path: headPath, commit: headSha },
    output_dir: outputDir,
    startup: {
      cwd: '.',
      argv: ['node', 'serve.js', '{port}'],
      ready_url: 'http://127.0.0.1:{port}/',
      url: 'http://127.0.0.1:{port}/',
      env: {},
      timeout_seconds: 30,
    },
    browser: {
      viewport: viewport || [400, 300],
      device_scale_factor: deviceScaleFactor ?? 1,
      reduced_motion: 'reduce',
      color_scheme: 'light',
      locale: 'en-US',
      timezone_id: 'UTC',
    },
    surfaces: [
      {
        name: 'panel',
        path: '/',
        ready: { selector: readySelector || '[data-test="app-ready"]', state: 'visible' },
        crop: { selector: cropSelector || '[data-test="panel"]' },
        permitted_changes: permittedChanges,
        expected_controls: expectedControls || [],
        expected_fonts: expectedFonts || [],
      },
    ],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function runSmoke(manifestPath) {
  const result = spawnSync(process.execPath, [SMOKE, '--manifest', manifestPath], {
    encoding: 'utf8',
    env: process.env,
    timeout: SMOKE_TIMEOUT_MS,
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error(`smoke.js timed out after ${SMOKE_TIMEOUT_MS}ms for manifest ${manifestPath}`);
  }
  return result;
}

function nonEmptyFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

async function main() {
  render.requirePlaywright();

  // Case 0: checkFonts is pure, so exercise its weight-matching logic
  // directly against synthetic records instead of a captured browser
  // record.
  const case0VariableRange = checks.checkFonts(
    { font_faces: [{ family: 'Inter', weight: '100 900', status: 'loaded' }] },
    [{ family: 'Inter', weight: 400 }]
  );
  report(
    'case0 variable-font range contains the expected weight',
    case0VariableRange.status === 'PASS',
    JSON.stringify(case0VariableRange)
  );

  const case0NormalMatch = checks.checkFonts(
    { font_faces: [{ family: '"Example Sans"', weight: 'normal', status: 'loaded' }] },
    [{ family: 'Example Sans', weight: 400 }]
  );
  report(
    "case0 'normal' face matches weight 400",
    case0NormalMatch.status === 'PASS',
    JSON.stringify(case0NormalMatch)
  );

  const case0NormalMismatch = checks.checkFonts(
    { font_faces: [{ family: '"Example Sans"', weight: 'normal', status: 'loaded' }] },
    [{ family: 'Example Sans', weight: 700 }]
  );
  report(
    "case0 'normal' face does not match weight 700",
    case0NormalMismatch.status === 'FAIL',
    JSON.stringify(case0NormalMismatch)
  );

  const case0OutOfRange = checks.checkFonts(
    { font_faces: [{ family: 'Inter', weight: '100 300', status: 'loaded' }] },
    [{ family: 'Inter', weight: 400 }]
  );
  report(
    'case0 variable-font range excludes the expected weight',
    case0OutOfRange.status === 'FAIL',
    JSON.stringify(case0OutOfRange)
  );

  const case0Unloaded = checks.checkFonts(
    { font_faces: [{ family: 'Inter', weight: '400', status: 'unloaded' }] },
    [{ family: 'Inter', weight: 400 }]
  );
  report(
    'case0 unloaded face does not match',
    case0Unloaded.status === 'FAIL',
    JSON.stringify(case0Unloaded)
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-smoke-fixture-'));
  const gitHome = path.join(tempRoot, 'git-home');
  fs.mkdirSync(gitHome, { recursive: true });
  try {
    const baseRoot = path.join(tempRoot, 'base-repo');
    const headRoot = path.join(tempRoot, 'head-repo');
    const baseHtml = pageHtml({ buttonLabel: 'Save', includeExport: false });
    const headHtml = pageHtml({ buttonLabel: 'Save All', includeExport: false });
    const baseSha = buildRepo(baseRoot, gitHome, baseHtml);
    const headSha = buildRepo(headRoot, gitHome, headHtml);

    // Case 1: permitted_changes covers the panel region (where the label
    // changed) -> base=PASS head=PASS.
    const case1Output = path.join(tempRoot, 'case1-output');
    const case1Manifest = path.join(tempRoot, 'case1-manifest.json');
    writeManifest(case1Manifest, {
      basePath: baseRoot,
      baseSha,
      headPath: headRoot,
      headSha,
      outputDir: case1Output,
      permittedChanges: [20, 20, 220, 100],
    });
    const case1 = runSmoke(case1Manifest);
    report('case1 exit code 0', case1.status === 0, `status=${case1.status} stderr=${case1.stderr}`);
    report('case1 stdout line', case1.stdout.includes('panel: base=PASS head=PASS'), `stdout=${case1.stdout}`);
    const case1ReportPath = path.join(case1Output, 'report.json');
    const case1Report = fs.existsSync(case1ReportPath) ? JSON.parse(fs.readFileSync(case1ReportPath, 'utf8')) : null;
    report('case1 report.json present', case1Report !== null);
    report(
      'case1 surfaces.panel.diff.status === PASS',
      !!case1Report && case1Report.surfaces.panel.diff.status === 'PASS',
      case1Report ? JSON.stringify(case1Report.surfaces.panel.diff) : 'no report'
    );
    report(
      'case1 panel-base.png / panel-head.png written and non-empty',
      nonEmptyFile(path.join(case1Output, 'panel-base.png')) &&
        nonEmptyFile(path.join(case1Output, 'panel-head.png'))
    );

    // Case 2: permitted_changes does not cover the change -> exit 1, FAIL
    // with a non-null diff_bbox.
    const case2Output = path.join(tempRoot, 'case2-output');
    const case2Manifest = path.join(tempRoot, 'case2-manifest.json');
    writeManifest(case2Manifest, {
      basePath: baseRoot,
      baseSha,
      headPath: headRoot,
      headSha,
      outputDir: case2Output,
      permittedChanges: [0, 0, 1, 1],
    });
    const case2 = runSmoke(case2Manifest);
    report('case2 exit code 1', case2.status === 1, `status=${case2.status} stderr=${case2.stderr}`);
    const case2ReportPath = path.join(case2Output, 'report.json');
    const case2Report = fs.existsSync(case2ReportPath) ? JSON.parse(fs.readFileSync(case2ReportPath, 'utf8')) : null;
    const case2Diff = case2Report ? case2Report.surfaces.panel.diff : null;
    report(
      'case2 surfaces.panel.diff.status === FAIL with non-null diff_bbox',
      !!case2Diff && case2Diff.status === 'FAIL' && case2Diff.detail.diff_bbox !== null,
      case2Diff ? JSON.stringify(case2Diff) : 'no report'
    );

    // Case 3: expected_controls names a control that exists only on head ->
    // base reports FINDING, head reports PASS. Reuses case 1's base
    // checkout, which is byte-for-byte the same fixture HTML.
    const case3HeadRoot = path.join(tempRoot, 'case3-head-repo');
    const case3HeadHtml = pageHtml({ buttonLabel: 'Save', includeExport: true });
    const case3HeadSha = buildRepo(case3HeadRoot, gitHome, case3HeadHtml);
    const case3Output = path.join(tempRoot, 'case3-output');
    const case3Manifest = path.join(tempRoot, 'case3-manifest.json');
    writeManifest(case3Manifest, {
      basePath: baseRoot,
      baseSha,
      headPath: case3HeadRoot,
      headSha: case3HeadSha,
      outputDir: case3Output,
      permittedChanges: [20, 20, 220, 100],
      expectedControls: [{ role: 'button', name: 'Export' }],
    });
    const case3 = runSmoke(case3Manifest);
    report(
      'case3 stdout line base=FINDING head=PASS',
      case3.stdout.includes('panel: base=FINDING head=PASS'),
      `stdout=${case3.stdout} stderr=${case3.stderr}`
    );
    report('case3 exit code 0', case3.status === 0, `status=${case3.status}`);

    // Case 4: expected_fonts names a font that never loads -> head's fonts
    // check FAILs with that font in detail.missing, and record.font_faces is
    // an array. Reuses case 1's checkouts.
    const case4Output = path.join(tempRoot, 'case4-output');
    const case4Manifest = path.join(tempRoot, 'case4-manifest.json');
    writeManifest(case4Manifest, {
      basePath: baseRoot,
      baseSha,
      headPath: headRoot,
      headSha,
      outputDir: case4Output,
      permittedChanges: [20, 20, 220, 100],
      expectedFonts: [{ family: 'Definitely Missing Sans', weight: 400 }],
    });
    const case4 = runSmoke(case4Manifest);
    const case4ReportPath = path.join(case4Output, 'report.json');
    const case4Report = fs.existsSync(case4ReportPath) ? JSON.parse(fs.readFileSync(case4ReportPath, 'utf8')) : null;
    const case4Fonts = case4Report ? case4Report.surfaces.panel.head.checks.fonts : null;
    report(
      'case4 surfaces.panel.head.checks.fonts.status === FAIL with missing font',
      !!case4Fonts &&
        case4Fonts.status === 'FAIL' &&
        case4Fonts.detail.missing.some((font) => font.family === 'Definitely Missing Sans'),
      case4Fonts ? JSON.stringify(case4Fonts.detail.missing) : `no report (stderr=${case4.stderr})`
    );
    report(
      'case4 surfaces.panel.head.record.font_faces is an array',
      !!case4Report && Array.isArray(case4Report.surfaces.panel.head.record.font_faces),
      case4Report ? typeof case4Report.surfaces.panel.head.record.font_faces : 'no report'
    );

    // Case 5: device_scale_factor 2, permitted_changes set to exactly the
    // changed button's CSS rect -> PASS; shrunk to exclude the button ->
    // FAIL with a non-null diff_bbox.
    const scale2BaseRoot = path.join(tempRoot, 'scale2-base-repo');
    const scale2HeadRoot = path.join(tempRoot, 'scale2-head-repo');
    const scale2BaseHtml = scale2PageHtml({ buttonLabel: 'Save' });
    const scale2HeadHtml = scale2PageHtml({ buttonLabel: 'Save All' });
    const scale2BaseSha = buildRepo(scale2BaseRoot, gitHome, scale2BaseHtml);
    const scale2HeadSha = buildRepo(scale2HeadRoot, gitHome, scale2HeadHtml);
    const buttonRect = [80, 100, 120, 40];

    const case5PassOutput = path.join(tempRoot, 'case5-pass-output');
    const case5PassManifest = path.join(tempRoot, 'case5-pass-manifest.json');
    writeManifest(case5PassManifest, {
      basePath: scale2BaseRoot,
      baseSha: scale2BaseSha,
      headPath: scale2HeadRoot,
      headSha: scale2HeadSha,
      outputDir: case5PassOutput,
      permittedChanges: buttonRect,
      deviceScaleFactor: 2,
      viewport: [500, 300],
      readySelector: '[data-test="panel"]',
    });
    const case5Pass = runSmoke(case5PassManifest);
    report(
      'case5 pass exit code 0',
      case5Pass.status === 0,
      `status=${case5Pass.status} stderr=${case5Pass.stderr}`
    );
    const case5PassReportPath = path.join(case5PassOutput, 'report.json');
    const case5PassReport = fs.existsSync(case5PassReportPath)
      ? JSON.parse(fs.readFileSync(case5PassReportPath, 'utf8'))
      : null;
    report(
      'case5 pass surfaces.panel.diff.status === PASS',
      !!case5PassReport && case5PassReport.surfaces.panel.diff.status === 'PASS',
      case5PassReport ? JSON.stringify(case5PassReport.surfaces.panel.diff) : 'no report'
    );

    const case5FailOutput = path.join(tempRoot, 'case5-fail-output');
    const case5FailManifest = path.join(tempRoot, 'case5-fail-manifest.json');
    writeManifest(case5FailManifest, {
      basePath: scale2BaseRoot,
      baseSha: scale2BaseSha,
      headPath: scale2HeadRoot,
      headSha: scale2HeadSha,
      outputDir: case5FailOutput,
      permittedChanges: [0, 0, 1, 1],
      deviceScaleFactor: 2,
      viewport: [500, 300],
      readySelector: '[data-test="panel"]',
    });
    const case5Fail = runSmoke(case5FailManifest);
    const case5FailReportPath = path.join(case5FailOutput, 'report.json');
    const case5FailReport = fs.existsSync(case5FailReportPath)
      ? JSON.parse(fs.readFileSync(case5FailReportPath, 'utf8'))
      : null;
    const case5FailDiff = case5FailReport ? case5FailReport.surfaces.panel.diff : null;
    report(
      'case5 fail surfaces.panel.diff.status === FAIL with non-null diff_bbox',
      !!case5FailDiff && case5FailDiff.status === 'FAIL' && case5FailDiff.detail.diff_bbox !== null,
      case5FailDiff ? JSON.stringify(case5FailDiff) : `no report (stderr=${case5Fail.stderr})`
    );

    // Case 6: startup.argv is a shell wrapper that backgrounds the real
    // server ("node serve.js $0 & wait"), making it a grandchild rather than
    // a direct child. A direct-child-only kill would orphan it; terminate()
    // must kill the whole process tree. The marker is a distinctive string
    // so pgrep -f cannot match an unrelated process.
    const case6Marker = 'pvp-treekill-marker-7f2c9';
    const case6Output = path.join(tempRoot, 'case6-output');
    const case6Manifest = path.join(tempRoot, 'case6-manifest.json');
    fs.writeFileSync(
      case6Manifest,
      JSON.stringify(
        {
          base: { path: baseRoot, commit: baseSha },
          head: { path: headRoot, commit: headSha },
          output_dir: case6Output,
          startup: {
            cwd: '.',
            argv: ['sh', '-c', `node serve.js $0 ${case6Marker} & wait`, '{port}'],
            ready_url: 'http://127.0.0.1:{port}/',
            url: 'http://127.0.0.1:{port}/',
            env: {},
            timeout_seconds: 30,
          },
          browser: {
            viewport: [400, 300],
            device_scale_factor: 1,
            reduced_motion: 'reduce',
            color_scheme: 'light',
            locale: 'en-US',
            timezone_id: 'UTC',
          },
          surfaces: [
            {
              name: 'panel',
              path: '/',
              ready: { selector: '[data-test="app-ready"]', state: 'visible' },
              crop: { selector: '[data-test="panel"]' },
              permitted_changes: [20, 20, 220, 100],
              expected_controls: [],
              expected_fonts: [],
            },
          ],
        },
        null,
        2
      )
    );
    const case6 = runSmoke(case6Manifest);
    report('case6 exit code 0', case6.status === 0, `status=${case6.status} stderr=${case6.stderr}`);
    const case6Pgrep = spawnSync('pgrep', ['-f', case6Marker], { encoding: 'utf8' });
    report(
      'case6 no server process survives smoke.js (no pgrep -f marker match)',
      case6Pgrep.status === 1 && case6Pgrep.stdout.trim() === '',
      `pgrep status=${case6Pgrep.status} stdout=${case6Pgrep.stdout} stderr=${case6Pgrep.stderr}`
    );

    // Case 7: two surfaces declared with the same name must be rejected by
    // loadManifest before any server starts. The marker-file trick proves
    // that: startup.argv would touch the marker file if it ever ran.
    const case7Marker = path.join(tempRoot, 'case7-marker');
    const case7Output = path.join(tempRoot, 'case7-output');
    const case7Manifest = path.join(tempRoot, 'case7-manifest.json');
    fs.writeFileSync(
      case7Manifest,
      JSON.stringify(
        {
          base: { path: baseRoot, commit: baseSha },
          head: { path: headRoot, commit: headSha },
          output_dir: case7Output,
          startup: {
            cwd: '.',
            argv: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(case7Marker)}, '')`],
            ready_url: 'http://127.0.0.1:{port}/',
            url: 'http://127.0.0.1:{port}/',
            env: {},
            timeout_seconds: 30,
          },
          browser: {
            viewport: [400, 300],
            device_scale_factor: 1,
            reduced_motion: 'reduce',
            color_scheme: 'light',
            locale: 'en-US',
            timezone_id: 'UTC',
          },
          surfaces: [
            {
              name: 'panel',
              path: '/',
              ready: { selector: '[data-test="app-ready"]', state: 'visible' },
              crop: { selector: '[data-test="panel"]' },
            },
            {
              name: 'panel',
              path: '/',
              ready: { selector: '[data-test="app-ready"]', state: 'visible' },
              crop: { selector: '[data-test="panel"]' },
            },
          ],
        },
        null,
        2
      )
    );
    const case7 = runSmoke(case7Manifest);
    report('case7 exit code 1', case7.status === 1, `status=${case7.status} stderr=${case7.stderr}`);
    report(
      'case7 stderr reports the duplicate surface name',
      case7.stderr.includes('surface name "panel" is declared more than once'),
      `stderr=${case7.stderr}`
    );
    report(
      'case7 no server started (marker file not created)',
      !fs.existsSync(case7Marker),
      `marker exists=${fs.existsSync(case7Marker)}`
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(failures === 0 ? 'All assertions passed.' : `${failures} assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
