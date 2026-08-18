// Run: node elevation.test.mjs   (formula only; real-tile values are checked in the browser)
import assert from "node:assert/strict";
import { terrariumToMeters } from "./elevation.mjs";

// [R,G,B,A] triples with the elevation they must decode to.
const cases = [
  [[128, 0, 0, 255], 0], // 128*256 - 32768 = 0  -> sea level
  [[128, 100, 0, 255], 100],
  [[127, 156, 0, 255], -100], // 127*256 + 156 - 32768
  [[162, 144, 0, 255], 8848], // Everest: 8848 + 32768 = 162*256 + 144
  [[128, 0, 128, 255], 1], // B is the sub-metre channel: 0.5 rounds to 1
  [[0, 0, 0, 255], -32768], // encoding floor
];
const rgba = Uint8ClampedArray.from(cases.flatMap(([px]) => px));
assert.deepEqual(Array.from(terrariumToMeters(rgba)), cases.map(([, m]) => m));

console.log("elevation.mjs: all checks passed");
