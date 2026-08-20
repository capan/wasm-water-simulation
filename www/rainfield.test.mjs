// Run: node rainfield.test.mjs
import assert from "node:assert/strict";
import * as field from "./rainfield.mjs";

const close = (a, b, eps, what) =>
  assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b} (eps ${eps})`);

// Climate-only: no radar, gain 1 -> every cell sits at the climate mean.
{
  field.setSize(3, 3);
  field.setClimate(0.264);
  field.setGain(1);
  const r = field.rates();
  for (let i = 0; i < r.length; i++) close(r[i], 0.264, 1e-6, `climate-only cell ${i}`);
}

// Radar floor: a coverage-hole cell (radar 0) reads the climate mean, a wet
// cell (radar 12) reads its own, higher rate.
{
  field.setSize(3, 3);
  const radar = new Float32Array(9); // all 0 = coverage hole everywhere
  radar[4] = 12; // one wet cell
  field.setRadar(radar);
  field.setClimate(0.264);
  field.setGain(1);
  const r = field.rates();
  close(r[0], 0.264, 1e-6, "radar hole floored to climate");
  close(r[4], 12, 1e-6, "radar value above climate wins");
}

// Gain multiplies the base field but not the brush.
{
  field.setSize(20, 20);
  const radar = new Float32Array(400).fill(12);
  field.setRadar(radar);
  field.setClimate(0.264);
  field.setGain(10);
  field.clearBrush();
  field.paint(10, 10, false); // BRUSH_RADIUS 3, well clear of the grid edges
  const r = field.rates();
  close(r[10 * 20 + 10], 120 + field.BRUSH_RATE, 1e-4, "painted cell: base*gain + brush");
  close(r[0 * 20 + 0], 120, 1e-4, "unpainted cell: base*gain only");
}

// Painting at the (0,0) corner never writes out of bounds and never wraps
// onto the far edge of the row above (or, at row 0, of the same row).
{
  field.setSize(10, 10);
  field.setRadar(null);
  field.setClimate(0);
  field.setGain(1);
  field.clearBrush();
  field.paint(0, 0, false);
  const r = field.rates();
  assert.equal(r[0 * 10 + 9], 0, "top-right corner untouched by a corner paint");
  assert.equal(r[1 * 10 + 9], 0, "right edge of row 1 untouched by a corner paint");
  // sanity: the paint itself did land where expected
  assert.equal(r[0 * 10 + 0], field.BRUSH_RATE, "corner cell itself was painted");
}

// Erase zeroes a previously painted disc.
{
  field.setSize(10, 10);
  field.setRadar(null);
  field.setClimate(0);
  field.setGain(1);
  field.clearBrush();
  field.paint(5, 5, false);
  assert.equal(field.rates()[5 * 10 + 5], field.BRUSH_RATE, "painted before erase");
  field.paint(5, 5, true);
  assert.equal(field.rates()[5 * 10 + 5], 0, "erased back to zero");
}

// setSize clears the brush.
{
  field.setSize(5, 5);
  field.setRadar(null);
  field.setClimate(0);
  field.setGain(1);
  field.paint(2, 2, false);
  assert.equal(field.rates()[2 * 5 + 2], field.BRUSH_RATE, "painted before resize");
  field.setSize(5, 5);
  const r = field.rates();
  for (let i = 0; i < r.length; i++) assert.equal(r[i], 0, `brush cleared after setSize, cell ${i}`);
}

// rates() reuses one buffer instead of allocating per call.
{
  field.setSize(4, 4);
  const first = field.rates();
  const second = field.rates();
  assert.equal(first, second, "same array instance when nothing changed");
  field.setClimate(1);
  const third = field.rates();
  assert.equal(second, third, "same array instance even after a change");
}

// A resize is a new area: radar and climate from the old window must not
// survive it, or rates() indexes a stale array of the wrong length.
field.setSize(4, 4);
field.setRadar(new Float32Array(16).fill(9));
field.setClimate(0.3);
field.setSize(2, 2);
assert.deepEqual(Array.from(field.rates()), [0, 0, 0, 0], "resize drops stale radar and climate");

console.log("rainfield.mjs: all checks passed");
