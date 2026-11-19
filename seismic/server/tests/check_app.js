/* Pure-function checks of web/app.js (run: node tests/check_app.js). Covers the review findings that live in the
 * page's helper functions: ticks on stored lines, picks in a partial last block, request sizes, filter notes. */
'use strict';
const assert = require('assert');
const path = require('path');
const A = require(path.join(__dirname, '..', '..', 'app.js'));

// ---- ticks of a line axis are stored line numbers (Adele inlines are 4175 + 2k: all odd)
const onGrid = (v, first, step) => Number.isInteger((v - first) / step);
for (const [lo, hi, target] of [[4174, 4776, 7], [4400, 4442, 5], [4476, 4484, 4], [4175, 4775, 2], [4175, 4775, 30]]) {
  const t = A.gridTicks(lo, hi, target, 4175, 2);
  assert(t.length >= 2, 'at least two ticks for ' + lo + '..' + hi + ': ' + t);
  assert(t.every((v) => onGrid(v, 4175, 2) && v >= lo && v <= hi), 'inline ticks on stored lines: ' + t);
}
assert.deepStrictEqual(A.gridTicks(4476, 4484, 4, 4175, 2), [4477, 4479, 4481, 4483]);
// step 1: every integer is a stored line, so round numbers are used
assert.deepStrictEqual(A.gridTicks(5670, 8400, 6, 5670, 1), [6000, 6500, 7000, 7500, 8000]);
// even-numbered lines with step 2: round numbers are stored lines
assert(A.gridTicks(1000, 1400, 4, 1000, 2).every((v) => v % 100 === 0));
// decreasing line numbers (negative step) and a reversed interval
const neg = A.gridTicks(5970, 5670, 5, 5970, -1);
assert(neg.length >= 3 && neg.every((v) => Number.isInteger(v) && v >= 5670 && v <= 5970));
assert.deepStrictEqual(A.gridTicks(5, 5, 4, 0, 1), []);

// ---- a pick in the last (partial) block stays inside the image window
for (const [n, f] of [[957, 2], [353, 4], [501, 4], [1001, 3], [10, 1]]) {
  const m = Math.ceil(n / f);
  for (const flip of [false, true]) {
    const ax = A.makeAxis(7172, 1, n, m, f, flip);
    const last = 7172 + n - 1;
    for (const fr of [0, 0.001, 0.25, 0.5, 0.999, 0.9999, 1]) {
      const v = A.axisFracToSampleValue(ax, fr);
      assert(v >= 7172 && v <= last && Number.isInteger(v), 'inside the window: ' + v);
      // the old code (continuous value snapped to the global grid) overshoots by up to f - 1 samples
    }
    assert.strictEqual(A.axisFracToSampleValue(ax, flip ? 0 : 1), last);
    assert.strictEqual(A.axisFracToSampleValue(ax, flip ? 1 : 0), 7172);
    // a marker drawn at the picked value lies under the pointer (within one block)
    for (const fr of [0.1, 0.37, 0.8]) {
      const back = A.axisValueToFrac(ax, A.axisFracToSampleValue(ax, fr));
      assert(Math.abs(back - fr) <= 1 / m + 1e-9);
    }
  }
}
// time axis (non-integer step)
{
  const ax = A.makeAxis(2300, 4, 352, 176, 2, false);
  assert.strictEqual(A.axisFracToSampleValue(ax, 1), 2300 + 351 * 4);
}

// ---- request sizes
const pixels = (src, limit) => Math.ceil(src / A.blockFactor(src, limit));
assert.strictEqual(pixels(352, A.requestLimit(352, 351, 1024, false)), 352);    // one sample too many no longer halves it
assert.strictEqual(pixels(2731, A.requestLimit(2731, 1488, 1600, false)), 1366);
assert.strictEqual(pixels(2731, A.requestLimit(2731, 1050, 1600, false)), 1366);
assert.strictEqual(pixels(1001, A.requestLimit(1001, 300, 1024, true)), 251);   // preview: as small as the plot
for (let src = 1; src <= 6000; src += 7) {
  for (const P of [50, 351, 700, 1488, 2400]) {
    for (const M of [1024, 1100, 1600]) {
      const full = pixels(src, A.requestLimit(src, P, M, false)), prev = pixels(src, A.requestLimit(src, P, M, true));
      assert(full <= M && prev <= M, 'never above the cap');
      assert(full >= Math.min(src, P, Math.floor(M / 2)), 'never fewer pixels than the screen shows: ' + [src, P, M, full]);
      assert(prev <= Math.max(64, P) && prev <= full, 'preview is not larger: ' + [src, P, M, prev, full]);
    }
  }
}

// ---- filter notes
assert(Math.abs(A.transitionHz(201, 4) - 4.104) < 0.01);
assert.strictEqual(A.transitionHz(0, 4), 0);
assert.strictEqual(A.edgeZoneMs({ attr: 'amp', taps: 201 }, 4), 400);
assert.strictEqual(A.edgeZoneMs({ attr: 'rms', taps: 201, win_ms: 100 }, 4), 400 + 48);
assert.strictEqual(A.edgeZoneMs({ attr: 'amp', taps: 0 }, 4), 0);
assert.strictEqual(A.edgeZoneMs({ attr: 'rms', taps: 0, win_ms: 100 }, 4), 0);
assert(A.jpegQuality('ifreq', false) < A.jpegQuality('env', true) && A.jpegQuality('env', true) < A.jpegQuality('amp', false));
assert.strictEqual(A.jpegQuality('amp', true), A.jpegQuality('sd', true));

// ---- band validation: a high corner that would be sent as "fhi=0" is refused in the page
assert(A.validateBand(0, 0.0001, 125) !== '');
assert.strictEqual(A.validateBand(5, 60, 125), '');
assert.strictEqual(A.bandParams(true, 0, 0.0001, 125), null);

console.log('check_app.js: all checks passed');
