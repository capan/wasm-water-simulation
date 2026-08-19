// Run: node rain.test.mjs   (palette + rate maths; live tiles are checked in the browser)
import assert from "node:assert/strict";
import { dbzToMmPerHour, pixelToDbz } from "./rain.mjs";

const close = (a, b, eps, what) =>
  assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b} (eps ${eps})`);

// Marshall-Palmer, Z = 200 R^1.6. Reference values recomputed by hand:
// 20 dBZ -> Z=100  -> (0.5)^0.625  = 0.6477 mm/h  (light rain)
// 40 dBZ -> Z=1e4  -> (50)^0.625   = 11.53 mm/h   (moderate/heavy)
// 50 dBZ -> Z=1e5  -> (500)^0.625  = 48.62 mm/h   (downpour)
close(dbzToMmPerHour(20), 0.6477, 1e-3, "20 dBZ");
close(dbzToMmPerHour(40), 11.53, 1e-2, "40 dBZ");
close(dbzToMmPerHour(50), 48.62, 1e-2, "50 dBZ");

// Monotone, zero at the floor, and capped so hail echoes cannot run away.
assert.equal(dbzToMmPerHour(-32), 0);
for (let d = -31; d < 95; d++) {
  assert.ok(dbzToMmPerHour(d) <= dbzToMmPerHour(d + 1), `not monotone at ${d}`);
}
assert.ok(dbzToMmPerHour(95) <= 200, "rate cap");
assert.equal(dbzToMmPerHour(95), dbzToMmPerHour(65), "saturates above 65 dBZ");

// Palette round trip. Colours below are lifted from RainViewer's own Universal
// Blue table; the index they sit at fixes the dBZ.
const cases = [
  [[0, 0, 0, 0], -32], // fully transparent: no echo anywhere in the palette
  [[130, 123, 105, 73], 0], // index 32
  [[182, 169, 126, 130], 8], // index 40
  [[54, 186, 229, 255], 18], // index 50
  [[0, 98, 149, 255], 28], // index 60
  [[255, 197, 0, 255], 38], // index 70
  [[217, 27, 0, 255], 48], // index 80
  [[255, 139, 255, 255], 58], // index 90
  [[127, 191, 255, 255], 20], // index 180 — snow half, same dBZ scale
];
for (const [[r, g, b, a], dbz] of cases) {
  assert.equal(pixelToDbz(r, g, b, a), dbz, `pixel ${r},${g},${b},${a}`);
}

// A colour one step off any palette entry still lands on that entry, so a
// browser that shifts a channel during decode degrades instead of failing.
assert.equal(pixelToDbz(53, 186, 229, 255), 18, "nearest-entry fallback");

// Anything transparent is "no echo" regardless of what the RGB says — the
// out-of-range placeholder tile is transparent with a non-zero colour.
assert.equal(pixelToDbz(71, 112, 76, 0), -32, "transparent placeholder");

console.log("rain.mjs: all checks passed");
