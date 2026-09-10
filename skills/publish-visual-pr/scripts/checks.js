#!/usr/bin/env node
/**
 * checks.js: assertions for screenshots captured by render.js.
 *
 * Not a CLI entry point. Required by smoke.js. Exposes:
 *
 *   checkConsole(record, exceptions)   FAIL when a page/console error is not
 *                                      named by a manifest console_exceptions
 *                                      entry (substring match).
 *   checkFonts(record, expected)       FAIL when a manifest-required font
 *                                      face is not loaded.
 *   checkControls(record)              FAIL when a required accessible
 *                                      control is missing or hidden.
 *   diffAndCrop(page, beforeFullPng, afterFullPng, cropRect, permittedRects,
 *               scale, beforeCropPath, afterCropPath)
 *                                      Writes focused crops and reports
 *                                      visual changes outside permittedRects.
 *                                      Pixel math runs inside the given
 *                                      Playwright page via <canvas>, since
 *                                      this port has no image library
 *                                      dependency; the caller owns that
 *                                      page's lifecycle.
 *
 * Diff semantics (matches the retired checks.py exactly): a pixel is masked
 * when its max per-channel absolute difference is >= 16. permittedRects (CSS
 * px) are converted to device px with floor(start) / ceil(end) at `scale`
 * and zeroed from the mask. stray_pixels is the count of masked pixels
 * before neighbour filtering. diff_bbox is the bounding box, in CSS px, of
 * masked pixels that have at least one masked 4-neighbour (isolated
 * single-pixel noise is excluded from the box but still counted in
 * stray_pixels). status is FAIL when diff_bbox is non-null.
 *
 * Exit codes: none (library module; errors are thrown).
 *
 * Dependencies: Node core modules (fs) only. Pixel/canvas work runs inside
 * the caller-supplied Playwright page, so this file itself never calls
 * `require('playwright')`.
 */
'use strict';

const fs = require('fs');

function checkConsole(record, exceptions) {
  const errors = [...record.console_errors, ...record.page_errors];
  const unmatched = errors.filter(
    (error) => !exceptions.some((exception) => error.includes(exception.contains))
  );
  return {
    status: unmatched.length ? 'FAIL' : 'PASS',
    detail: { errors, unmatched },
  };
}

function stripQuotes(value) {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '"' || value[start] === "'")) start += 1;
  while (end > start && (value[end - 1] === '"' || value[end - 1] === "'")) end -= 1;
  return value.slice(start, end);
}

function normalizeWeight(weight) {
  if (weight === 'normal') return 400;
  if (weight === 'bold') return 700;
  return Number(weight);
}

// face.weight is the CSS font-weight descriptor text: a single value, the
// keywords normal/bold, or (for a variable font) a "<min> <max>" range.
function weightMatches(faceWeight, targetWeight) {
  const parts = String(faceWeight).trim().split(/\s+/);
  if (parts.length === 2) {
    const min = Number(parts[0]);
    const max = Number(parts[1]);
    return targetWeight >= min && targetWeight <= max;
  }
  return normalizeWeight(faceWeight) === targetWeight;
}

function checkFonts(record, expected) {
  const faces = record.font_faces;
  const missing = [];
  for (const font of expected) {
    const family = font.family;
    const hasWeight = font.weight !== undefined && font.weight !== null && font.weight !== '';
    const targetWeight = hasWeight ? normalizeWeight(font.weight) : null;
    const matched = faces.some(
      (face) =>
        face.status === 'loaded' &&
        stripQuotes(face.family) === family &&
        (!hasWeight || weightMatches(face.weight, targetWeight))
    );
    if (!matched) missing.push(font);
  }
  return { status: missing.length ? 'FAIL' : 'PASS', detail: { missing, faces } };
}

function checkControls(record) {
  const missing = record.controls
    .filter((item) => !item.found || !item.visible)
    .map((item) => item.name);
  return { status: missing.length ? 'FAIL' : 'PASS', detail: { missing } };
}

function toDataUrl(pngPath) {
  const base64 = fs.readFileSync(pngPath).toString('base64');
  return `data:image/png;base64,${base64}`;
}

function writeDataUrlPng(dataUrl, outputPath) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));
}

/* eslint-disable */
// Runs inside the Playwright page via page.evaluate. Browser globals
// (Image, document, localStorage-free canvas work) are intentional here.
async function diffAndCropInPage({ beforeDataUrl, afterDataUrl, cropRect, permittedRects, scale }) {
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('image failed to load'));
      image.src = src;
    });
  }

  const [beforeImage, afterImage] = await Promise.all([loadImage(beforeDataUrl), loadImage(afterDataUrl)]);
  const width = beforeImage.naturalWidth;
  const height = beforeImage.naturalHeight;

  function toImageData(image) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  }

  const before = toImageData(beforeImage);
  const after = toImageData(afterImage);
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    const dr = Math.abs(before[p] - after[p]);
    const dg = Math.abs(before[p + 1] - after[p + 1]);
    const db = Math.abs(before[p + 2] - after[p + 2]);
    mask[i] = Math.max(dr, dg, db) >= 16 ? 255 : 0;
  }

  for (const [rx, ry, rw, rh] of permittedRects) {
    const left = Math.max(0, Math.floor(rx * scale));
    const top = Math.max(0, Math.floor(ry * scale));
    const right = Math.min(width, Math.ceil((rx + rw) * scale));
    const bottom = Math.min(height, Math.ceil((ry + rh) * scale));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        mask[y * width + x] = 0;
      }
    }
  }

  let strayPixels = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 255) strayPixels += 1;
  }

  function at(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return mask[y * width + x];
  }

  let minX = null;
  let minY = null;
  let maxX = null;
  let maxY = null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] !== 255) continue;
      const hasMaskedNeighbour =
        at(x + 1, y) === 255 || at(x - 1, y) === 255 || at(x, y + 1) === 255 || at(x, y - 1) === 255;
      if (!hasMaskedNeighbour) continue;
      if (minX === null || x < minX) minX = x;
      if (minY === null || y < minY) minY = y;
      if (maxX === null || x + 1 > maxX) maxX = x + 1;
      if (maxY === null || y + 1 > maxY) maxY = y + 1;
    }
  }
  const bbox = minX === null ? null : [minX, minY, maxX, maxY];

  function crop(image, rectangle) {
    const [x, y, w, h] = rectangle;
    const left = Math.round(x * scale);
    const top = Math.round(y * scale);
    const right = Math.round((x + w) * scale);
    const bottom = Math.round((y + h) * scale);
    const cropWidth = Math.max(0, right - left);
    const cropHeight = Math.max(0, bottom - top);
    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    return canvas.toDataURL('image/png');
  }

  return {
    bbox,
    strayPixels,
    beforeCropDataUrl: crop(beforeImage, cropRect),
    afterCropDataUrl: crop(afterImage, cropRect),
  };
}
/* eslint-enable */

/** Write focused crops and report visual changes outside permitted rectangles. */
async function diffAndCrop(
  page,
  beforeFullPng,
  afterFullPng,
  cropRect,
  permittedRects,
  scale,
  beforeCropPath,
  afterCropPath
) {
  const result = await page.evaluate(diffAndCropInPage, {
    beforeDataUrl: toDataUrl(beforeFullPng),
    afterDataUrl: toDataUrl(afterFullPng),
    cropRect,
    permittedRects,
    scale,
  });
  writeDataUrlPng(result.beforeCropDataUrl, beforeCropPath);
  writeDataUrlPng(result.afterCropDataUrl, afterCropPath);
  const cssBbox = result.bbox === null ? null : result.bbox.map((value) => value / scale);
  return {
    status: cssBbox === null ? 'PASS' : 'FAIL',
    detail: { diff_bbox: cssBbox, permitted_rects: permittedRects, stray_pixels: result.strayPixels },
  };
}

module.exports = { checkConsole, checkFonts, checkControls, diffAndCrop };
