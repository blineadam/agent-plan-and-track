#!/usr/bin/env node
/**
 * render.js: revision-local server lifecycle and headless Playwright capture.
 *
 * Not a CLI entry point. Required by smoke.js, which drives the manifest
 * contract documented in references/manifest.md. Exposes two functions:
 *
 *   withServer(revisionPath, startup, fn)
 *     Starts startup.argv (after {port} substitution) in revisionPath, polls
 *     startup.ready_url until it answers with a status under 400 or the
 *     command exits or startup.timeout_seconds elapses, then calls
 *     fn(url) and always stops the process afterward (SIGTERM, SIGKILL after
 *     10s). Returns fn's resolved value. Throws on a startup failure, with
 *     the captured stdout+stderr tail in the error message. While the child
 *     is running, installs SIGINT/SIGTERM handlers that run the same
 *     cleanup (stop the process tree, remove the startup log directory)
 *     and exit 130/143, so an interrupted caller leaves nothing behind; the
 *     handlers are removed once the child stops.
 *
 *   captureSide(browser, url, manifest, outputDir, side)
 *     Opens one clean context per manifest surface on the caller-supplied
 *     browser, applies manifest.state, runs the surface's actions, writes a
 *     full-viewport screenshot, and returns a per-surface record (full_png
 *     path, crop rect, console/page errors, loaded font faces,
 *     expected_controls results) keyed by surface name. The caller owns the
 *     browser's lifecycle.
 *
 * Exit codes: none (library module; errors are thrown).
 *
 * Dependencies: Node core modules (child_process, fs, http, https, net, os,
 * path, url) plus the `playwright` package; no other npm dependencies.
 * `playwright` must be resolvable (installed globally for Node, or reachable
 * via NODE_PATH); a missing package throws a one-line Error.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const collectFontFaces = () =>
  Array.from(document.fonts).map(({ family, weight, status }) => ({ family, weight, status }));

function requirePlaywright() {
  try {
    return require('playwright');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && /Cannot find module 'playwright'/.test(error.message)) {
      throw new Error('playwright must be resolvable (install it globally or set NODE_PATH)');
    }
    throw error;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function replaceValues(value, port) {
  if (typeof value === 'string') return value.split('{port}').join(String(port));
  if (Array.isArray(value)) return value.map((item) => replaceValues(item, port));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = replaceValues(item, port);
    return result;
  }
  return value;
}

// Inherits ordinary shell and temporary-directory variables, POSIX and
// Windows alike; declare project settings in startup.env instead.
function startupEnvironment(overrides) {
  const inherited = {};
  const keys = [
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'SHELL',
    'TMPDIR',
    'USER',
    'SYSTEMROOT',
    'SystemRoot',
    'SYSTEMDRIVE',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'COMSPEC',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
  ];
  for (const key of keys) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  return { ...inherited, ...overrides };
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function tail(logPath) {
  const content = fs.readFileSync(logPath, 'utf8');
  return content.slice(-4000);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function probe(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode < 400);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    let timer = null;
    const onExit = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
    }
  });
}

// Kills the startup command's whole process tree, not just the direct
// child: startup.argv can be a shell wrapper that backgrounds the real
// server, and a direct-child-only kill would orphan it.
function killTree(child, signal) {
  if (process.platform === 'win32') {
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
      const taskkill = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {}
      });
    } catch {
      try {
        child.kill();
      } catch {}
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error && (error.code === 'ESRCH' || error.code === 'EPERM')) {
      try {
        child.kill(signal);
      } catch {}
    }
  }
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  killTree(child, 'SIGTERM');
  const exited = await waitForExit(child, 10000);
  if (!exited) {
    killTree(child, 'SIGKILL');
    await waitForExit(child, null);
  }
}

/** Start the manifest command and stop it after capture. */
async function withServer(revisionPath, startup, fn) {
  const resolvedRevisionPath = path.resolve(revisionPath);
  const port = await freePort();
  const command = replaceValues(startup.argv, port);
  const cwd = path.resolve(resolvedRevisionPath, startup.cwd || '.');
  if (!isInside(resolvedRevisionPath, cwd)) {
    throw new Error('startup.cwd must stay inside each revision checkout');
  }
  const environment = startupEnvironment(replaceValues(startup.env || {}, port));
  const readyUrl = replaceValues(startup.ready_url, port);
  const timeoutSeconds = startup.timeout_seconds ?? 90;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-log-'));
  const logPath = path.join(tempDir, 'startup.log');
  const logFd = fs.openSync(logPath, 'a+');
  let child;
  // One cleanup shared by the finally block and the signal handlers: a
  // handler's process.exit never returns to this frame, so it must stop the
  // server and remove the log directory itself.
  let stopped = null;
  const stop = () =>
    (stopped ??= (async () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (child) await terminate(child);
      fs.closeSync(logFd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    })());
  const onSigint = () => stop().then(() => process.exit(130));
  const onSigterm = () => stop().then(() => process.exit(143));
  try {
    child = spawn(command[0], command.slice(1), {
      cwd,
      env: environment,
      stdio: ['ignore', logFd, logFd],
      detached: process.platform !== 'win32',
    });
    let spawnError = null;
    child.on('error', (error) => {
      spawnError = error;
    });
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`startup command failed to start: ${spawnError.message}`);
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`startup command exited with ${child.exitCode ?? child.signalCode}:\n${tail(logPath)}`);
      }
      if (await probe(readyUrl)) {
        const url = replaceValues(startup.url || readyUrl, port);
        return await fn(url);
      }
      await sleep(100);
    }
    throw new Error(
      `server did not become ready within ${timeoutSeconds} seconds: ${readyUrl}\n${tail(logPath)}`
    );
  } finally {
    await stop();
  }
}

async function rect(page, crop) {
  if (Array.isArray(crop)) return crop;
  const selector = crop.selector;
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`crop selector ${JSON.stringify(selector)} has no visible box`);
  return [box.x, box.y, box.width, box.height];
}

async function act(page, action, side) {
  if (action.head_only && side === 'base') return;
  const kind = action.type;
  if (kind === 'click') {
    await page.locator(action.selector).first().click();
  } else if (kind === 'wait_for_selector') {
    await page.locator(action.selector).first().waitFor({ state: action.state || 'visible' });
  } else if (kind === 'wait') {
    await page.waitForTimeout(action.milliseconds);
  } else {
    throw new Error(`unrecognized action: ${JSON.stringify(action)}`);
  }
  await page.waitForTimeout(action.settle_milliseconds ?? 100);
}

async function installRoutes(page, routes) {
  // Playwright dispatches to the most recently registered matching route, so
  // register in reverse array order to make the first declared route win,
  // matching the declaration-order contract in references/manifest.md.
  for (const spec of [...routes].reverse()) {
    await page.route(spec.url, async (route) => {
      const options = {};
      for (const key of ['status', 'headers', 'body', 'json']) {
        if (key in spec) options[key] = spec[key];
      }
      await route.fulfill(options);
    });
  }
}

async function installState(page, state, captureOrigin) {
  const storage = {
    local: state.local_storage || {},
    session: state.session_storage || {},
  };
  await page.addInitScript(`
    if (window.top === window && location.origin === ${JSON.stringify(captureOrigin)}) {
      const storage = ${JSON.stringify(storage)};
      for (const [key, value] of Object.entries(storage.local)) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(storage.session)) sessionStorage.setItem(key, value);
    }
  `);
  for (const script of state.init_scripts || []) {
    await page.addInitScript(`
      if (window.top === window && location.origin === ${JSON.stringify(captureOrigin)}) {
        ${script}
      }
    `);
  }
}

function surfaceUrl(baseUrl, surfacePath) {
  const trimmedBase = baseUrl.replace(/\/+$/, '') + '/';
  const trimmedPath = (surfacePath || '').replace(/^\/+/, '');
  return new URL(trimmedPath, trimmedBase).toString();
}

/** Capture each declared surface in a clean browser context. */
async function captureSide(browser, url, manifest, outputDir, side) {
  const browserConfig = manifest.browser;
  const state = manifest.state || {};
  const scale = browserConfig.device_scale_factor ?? 1;
  const parsedUrl = new URL(url);
  const captureOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const results = {};
  for (const surface of manifest.surfaces) {
    const context = await browser.newContext({
      viewport: { width: browserConfig.viewport[0], height: browserConfig.viewport[1] },
      deviceScaleFactor: scale,
      reducedMotion: browserConfig.reduced_motion || 'reduce',
      colorScheme: browserConfig.color_scheme || 'light',
      locale: browserConfig.locale || 'en-US',
      timezoneId: browserConfig.timezone_id || 'UTC',
    });
    try {
      if (browserConfig.fixed_time) {
        await context.clock.setFixedTime(browserConfig.fixed_time);
      }
      if (state.cookies && state.cookies.length) {
        await context.addCookies(state.cookies);
      }
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => {
        pageErrors.push(String(error));
      });
      await installRoutes(page, state.routes || []);
      await installState(page, state, captureOrigin);
      await page.goto(surfaceUrl(url, surface.path));
      const ready = surface.ready;
      if (ready) {
        await page.locator(ready.selector).first().waitFor({ state: ready.state || 'visible' });
      }
      await page.waitForFunction("document.fonts.status === 'loaded'");
      await page.waitForTimeout(surface.settle_milliseconds ?? 100);
      for (const action of surface.actions || []) {
        await act(page, action, side);
      }
      // An action can start a new font load, so wait again before the
      // screenshot.
      await page.waitForFunction("document.fonts.status === 'loaded'");
      const fullPng = path.join(outputDir, `${surface.name}-${side}-full.png`);
      await page.screenshot({ path: fullPng });
      const controls = [];
      for (const expected of surface.expected_controls || []) {
        const locator = page.getByRole(expected.role, { name: expected.name, exact: true }).first();
        const found = (await locator.count()) > 0;
        controls.push({
          name: expected.name,
          role: expected.role,
          found,
          visible: found ? await locator.isVisible() : false,
        });
      }
      results[surface.name] = {
        full_png: fullPng,
        rect: await rect(page, surface.crop),
        console_errors: consoleErrors,
        page_errors: pageErrors,
        font_faces: await page.evaluate(collectFontFaces),
        controls,
      };
    } finally {
      await context.close();
    }
  }
  return results;
}

module.exports = { withServer, captureSide, requirePlaywright };
