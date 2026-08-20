// Run: node climate.test.mjs   (pure maths only; no network)
import assert from "node:assert/strict";
import { meanRateFrom, meanRain } from "./climate.mjs";

const close = (a, b, eps, what) =>
  assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b} (eps ${eps})`);

// Amazon basin: ~23103 mm over 10 years of daily records (3653 days incl. leap
// days) averages to a heavy, near-continuous drizzle.
const amazon = new Array(3653).fill(23103 / 3653);
close(meanRateFrom(amazon), 0.2636, 1e-4, "Amazon mean rate");

// Sahara: almost nothing falls in ten years.
const sahara = new Array(3653).fill(111 / 3653);
close(meanRateFrom(sahara), 0.00127, 1e-5, "Sahara mean rate");

// nulls/undefined/NaN in the record are missing-data markers, not zero rain
// days that should skew the mean down further — but per spec they are still
// treated as 0 mm, not dropped from the length or turned into NaN.
close(meanRateFrom([100, null, undefined, NaN]), 100 / (4 * 24), 1e-9, "nulls treated as 0");
assert.ok(!Number.isNaN(meanRateFrom([null, undefined, NaN])), "no NaN result");

// Empty array: no divide-by-zero.
assert.equal(meanRateFrom([]), 0, "empty array");

// An archive response of HTTP 200 with every day null is a data outage, not a
// rainless planet -- it is what models=era5_land actually returns. It must warn
// and fall back, never silently report 0 mm/h as if it were measured.
const grid = { z: 12, x0: 0, y0: 0, width: 2, height: 2 };
const warnings = [];
const realWarn = console.warn;
console.warn = (m) => warnings.push(m);
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ daily: { precipitation_sum: [null, null, null] } }),
});
assert.equal(await meanRain(grid), 0, "all-null archive falls back to 0");
console.warn = realWarn;
assert.equal(warnings.length, 1, "all-null archive warns exactly once");

console.log("climate.mjs: all checks passed");
