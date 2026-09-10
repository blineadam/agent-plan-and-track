#!/usr/bin/env node
/**
 * smoke.js: capture manifest-defined base and head revisions with headless
 * Playwright and report undeclared visual changes.
 *
 * Usage:
 *   node smoke.js --manifest /absolute/path/to/visual-proof.json
 *
 * Validates the manifest (surface name characters, case-insensitive surface
 * name uniqueness since names become file names, console_exceptions
 * fields), verifies both checkouts (HEAD prefix match, no tracked changes),
 * starts startup.argv once per checkout, captures every surface in a clean
 * headless Chromium context, writes full-viewport screenshots, focused
 * crops, and report.json to output_dir, then stops the server. See
 * references/manifest.md for the full manifest contract.
 *
 * Prints one line per surface: `<name>: base=PASS|FINDING head=PASS|FAIL`.
 *
 * Exit codes:
 *   0   every surface's head result is PASS
 *   1   a head surface FAILed (undeclared visual change, a missing required
 *       control or font, or an unapproved console/page error), or the
 *       manifest/checkouts/startup command failed validation
 *   2   --manifest was not given
 *
 * Dependencies: Node core modules (fs, path) plus the `playwright` package,
 * required directly by this file and by render.js (checks.js never requires
 * it); no other npm dependencies. `playwright` must be resolvable (set
 * NODE_PATH to a node_modules directory that contains it); a missing package
 * throws a one-line Error, printed here without a stack, before exiting 1.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const checks = require('./checks');
const render = require('./render');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') {
      result.manifest = argv[i + 1];
      i += 1;
    }
  }
  if (!result.manifest) {
    console.error('usage: smoke.js --manifest /absolute/path.json');
    process.exit(2);
  }
  return result;
}

function loadManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const exception of manifest.console_exceptions || []) {
    if (!exception.contains || !exception.reason) {
      throw new Error("each console exception needs non-empty 'contains' and 'reason' fields");
    }
  }
  const seenNames = new Set();
  for (const surface of manifest.surfaces) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(surface.name)) {
      throw new Error(
        `surface name ${JSON.stringify(surface.name)} must contain only letters, digits, '.', '_', or '-'`
      );
    }
    // Surface names become file names, so a collision differing only in
    // case is still a collision on a case-insensitive filesystem.
    const key = surface.name.toLowerCase();
    if (seenNames.has(key)) {
      throw new Error(
        `surface name ${JSON.stringify(surface.name)} collides with another surface name (compared case-insensitively because names become file names)`
      );
    }
    seenNames.add(key);
  }
  return manifest;
}

function reportManifest(manifest) {
  const state = manifest.state || {};
  const startup = manifest.startup;
  // launch can carry proxy credentials or other secrets; never echo it.
  const { launch, ...browserWithoutLaunch } = manifest.browser;
  return {
    base: { commit: manifest.base.commit },
    head: { commit: manifest.head.commit },
    startup: {
      cwd: startup.cwd || '.',
      env_keys: Object.keys(startup.env || {}).sort(),
      timeout_seconds: startup.timeout_seconds ?? 90,
    },
    browser: browserWithoutLaunch,
    state: {
      local_storage_keys: Object.keys(state.local_storage || {}).sort(),
      session_storage_keys: Object.keys(state.session_storage || {}).sort(),
      cookie_names: (state.cookies || []).map((cookie) => cookie.name || '').sort(),
      init_script_count: (state.init_scripts || []).length,
      routes: (state.routes || []).map((route) => ({ url: route.url, status: route.status ?? 200 })),
    },
    console_exceptions: manifest.console_exceptions || [],
    surfaces: manifest.surfaces,
  };
}

function verifyRevision(revision, name) {
  const revisionPath = path.resolve(revision.path);
  const head = spawnSync('git', ['-C', revisionPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) {
    throw new Error(`git rev-parse HEAD failed for ${name} checkout: ${head.stderr}`);
  }
  const headSha = head.stdout.trim();
  if (!headSha.startsWith(revision.commit)) {
    throw new Error(`${name} checkout is at ${headSha}, expected ${revision.commit}`);
  }
  const status = spawnSync(
    'git',
    ['-C', revisionPath, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf8' }
  );
  if (status.status !== 0) {
    throw new Error(`git status failed for ${name} checkout: ${status.stderr}`);
  }
  const trackedChanges = status.stdout.trim();
  if (trackedChanges) {
    throw new Error(`${name} checkout has tracked changes:\n${trackedChanges}`);
  }
  return revisionPath;
}

function unionRect(first, second) {
  const x = Math.min(first[0], second[0]);
  const y = Math.min(first[1], second[1]);
  const right = Math.max(first[0] + first[2], second[0] + second[2]);
  const bottom = Math.max(first[1] + first[3], second[1] + second[3]);
  return [x, y, right - x, bottom - y];
}

function permittedRects(surface, fallback) {
  const value = surface.permitted_changes ?? fallback;
  if (value && typeof value[0] === 'number') return [value];
  return value;
}

const PLAYWRIGHT_MISSING_MESSAGE = 'playwright must be resolvable: set NODE_PATH to a node_modules directory that contains it';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { chromium } = render.requirePlaywright();
  const manifest = loadManifest(args.manifest);
  const output = path.resolve(manifest.output_dir);
  fs.mkdirSync(output, { recursive: true });

  const browser = await chromium.launch({ ...(manifest.browser.launch || {}), headless: true });
  try {
    const basePath = verifyRevision(manifest.base, 'base');
    const headPath = verifyRevision(manifest.head, 'head');

    const base = await render.withServer(basePath, manifest.startup, (baseUrl) =>
      render.captureSide(browser, baseUrl, manifest, output, 'base')
    );
    const head = await render.withServer(headPath, manifest.startup, (headUrl) =>
      render.captureSide(browser, headUrl, manifest, output, 'head')
    );

    const report = { manifest: reportManifest(manifest), surfaces: {} };
    let failed = false;

    for (const surface of manifest.surfaces) {
      const name = surface.name;
      const baseRecord = base[name];
      const headRecord = head[name];
      const crop = unionRect(baseRecord.rect, headRecord.rect);
      const diffPage = await browser.newPage();
      let diff;
      try {
        diff = await checks.diffAndCrop(
          diffPage,
          baseRecord.full_png,
          headRecord.full_png,
          crop,
          permittedRects(surface, crop),
          manifest.browser.device_scale_factor ?? 1,
          path.join(output, `${name}-base.png`),
          path.join(output, `${name}-head.png`)
        );
      } finally {
        await diffPage.close();
      }
      const baseChecks = {
        console: checks.checkConsole(baseRecord, manifest.console_exceptions || []),
        fonts: checks.checkFonts(baseRecord, surface.expected_fonts || []),
        controls: checks.checkControls(baseRecord),
      };
      const headChecks = {
        console: checks.checkConsole(headRecord, manifest.console_exceptions || []),
        fonts: checks.checkFonts(headRecord, surface.expected_fonts || []),
        controls: checks.checkControls(headRecord),
      };
      report.surfaces[name] = {
        crop,
        base: { record: baseRecord, checks: baseChecks },
        head: { record: headRecord, checks: headChecks },
        diff,
      };
      const baseStatuses = Object.values(baseChecks).map((result) => result.status);
      const requiredStatuses = [...Object.values(headChecks).map((result) => result.status), diff.status];
      failed = failed || requiredStatuses.includes('FAIL');
      const baseLabel = baseStatuses.includes('FAIL') ? 'FINDING' : 'PASS';
      const headLabel = requiredStatuses.includes('FAIL') ? 'FAIL' : 'PASS';
      console.log(`${name}: base=${baseLabel} head=${headLabel}`);
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  } finally {
    await browser.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof Error && error.message === PLAYWRIGHT_MISSING_MESSAGE) {
      console.error(error.message);
    } else {
      console.error(error && error.stack ? error.stack : String(error));
    }
    process.exit(1);
  });
