// Run: node soil.test.mjs   (decoder + coverage rules; live tiles are checked in the browser)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import {
  readTiff, gridMetres, isCovered, FULL,
  textureClass, hydrologicGroup, infiltrationFor, infiltrationGrid, INFILTRATION, UNKNOWN,
} from "./soil.mjs";
import { planGrid } from "./tiles.mjs";

const close = (a, b, eps, what) =>
  assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b} (eps ${eps})`);

// --------------------------------------------------------- the real thing

// A 64x64 sand fraction over Sakarya, straight from SoilGrids. The expected
// values below were read with an unrelated decoder, so this checks the parse,
// the inflate and the predictor reversal against something that did not come
// from this file.
{
  const bytes = await readFile(new URL("./testdata/sand-sakarya.tif", import.meta.url));
  const { width, height, data } = await readTiff(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  assert.equal(width, 64);
  assert.equal(height, 64);
  assert.equal(data.length, 64 * 64);

  for (const [row, col, expected] of [
    [0, 0, 262], [10, 10, 273], [32, 32, 0], [63, 63, 322], [20, 40, 0],
  ]) {
    assert.equal(data[row * 64 + col], expected, `pixel ${row},${col}`);
  }

  const nonzero = [...data].filter((v) => v > 0);
  assert.equal(nonzero.length, 2779, "count of covered pixels");
  assert.equal(Math.min(...nonzero), 248, "min sand");
  assert.equal(Math.max(...nonzero), 354, "max sand");
  assert.equal([...data].reduce((a, b) => a + b, 0), 788056, "checksum");

  // Sanity in the units the rest of the app cares about: g/kg -> per cent.
  const mean = nonzero.reduce((a, b) => a + b, 0) / nonzero.length / 10;
  assert.ok(mean > 20 && mean < 40, `Sakarya sand should be roughly 28%, got ${mean.toFixed(1)}%`);
}

// --------------------------------------------------- predictor, synthesised

// A stripped, non-tiled TIFF built here, so the horizontal predictor is checked
// against values chosen to break a naive implementation: a descending run needs
// the wrap-around, and the row boundary must reset the running total.
{
  const W = 4, H = 3;
  const pixels = [
    [10, 20, 15, 15],
    [0, -5, -5, 1000],
    [32767, -32768, 0, 7],
  ];
  const deltas = pixels.flatMap((row) =>
    row.map((v, i) => (i === 0 ? v : v - row[i - 1]))
  );
  const raw = Buffer.alloc(W * H * 2);
  deltas.forEach((d, i) => raw.writeInt16LE(((d % 65536) + 65536) % 65536 > 32767
    ? (((d % 65536) + 65536) % 65536) - 65536
    : ((d % 65536) + 65536) % 65536, i * 2));
  const body = deflateSync(raw);

  const tags = [
    [256, 3, 1, W], [257, 3, 1, H], [258, 3, 1, 16], [259, 3, 1, 8],
    [273, 4, 1, 0], [277, 3, 1, 1], [278, 3, 1, H], [279, 4, 1, body.length],
    [317, 3, 1, 2], [339, 3, 1, 2],
  ];
  const header = 8;
  const ifd = header + body.length;
  const buf = Buffer.alloc(ifd + 2 + tags.length * 12 + 4);
  buf.write("II", 0, "ascii");
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifd, 4);
  body.copy(buf, header);
  buf.writeUInt16LE(tags.length, ifd);
  tags.forEach(([tag, type, count, value], i) => {
    const at = ifd + 2 + i * 12;
    buf.writeUInt16LE(tag, at);
    buf.writeUInt16LE(type, at + 2);
    buf.writeUInt32LE(count, at + 4);
    if (tag === 273) buf.writeUInt32LE(header, at + 8);
    else if (type === 3) buf.writeUInt16LE(value, at + 8);
    else buf.writeUInt32LE(value, at + 8);
  });

  const out = await readTiff(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.deepEqual(Array.from(out.data), pixels.flat(), "predictor reversal");
}

// ------------------------------------------------------------ refusals

// A wrong answer that looks plausible is worse than an error, so the decoder
// refuses what it does not actually handle.
{
  const notTiff = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer;
  await assert.rejects(() => readTiff(notTiff), /Not a TIFF/);
}

// ------------------------------------------------------------ bbox maths

// The grid's metre bounds must describe the same rectangle as its pixel bounds:
// the width in metres has to match the cell count times the metres per cell.
{
  const grid = planGrid({ north: 40.8, south: 40.7, east: 30.45, west: 30.3 });
  const box = gridMetres(grid);
  const perPixel = (2 * 20037508.342789244) / (256 * 2 ** grid.z);
  close(box.east - box.west, grid.width * perPixel, 1e-6, "width in metres");
  close(box.north - box.south, grid.height * perPixel, 1e-6, "height in metres");
  assert.ok(box.west > 3370000 && box.west < 3400000, `Sakarya easting, got ${box.west}`);
  assert.ok(box.north > 4960000 && box.north < 5000000, `Sakarya northing, got ${box.north}`);
  assert.ok(box.north > box.south && box.east > box.west, "bounds not inverted");
}

// ------------------------------------------------------------ coverage

assert.ok(isCovered(284, 428, 288), "a real clay loam column is covered");
assert.ok(!isCovered(0, 0, 0), "all-zero is ocean or a gap");
assert.ok(!isCovered(-32768, 500, 500), "nodata sentinel is not coverage");
assert.ok(!isCovered(100, 100, 100), "a column summing well under 1000 is not real");
assert.ok(isCovered(FULL - 20, 10, 10), "rounding-width slack is allowed");

// ------------------------------------------------- texture triangle

// Corners and centre of the USDA triangle. The branches of the decision tree
// overlap, so order matters and a rearrangement shows up here.
{
  const cases = [
    [100, 0, 0, "sand", "A"],
    [0, 100, 0, "silt", "B"],
    [0, 0, 100, "clay", "D"],
    [85, 10, 5, "loamy sand", "A"],
    [65, 25, 10, "sandy loam", "A"],
    [40, 40, 20, "loam", "B"],
    [20, 60, 20, "silt loam", "B"],
    [60, 15, 25, "sandy clay loam", "C"],
    [33, 34, 33, "clay loam", "D"],
    [10, 57, 33, "silty clay loam", "D"],
    [52, 8, 40, "sandy clay", "D"],
    [7, 48, 45, "silty clay", "D"],
  ];
  for (const [sand, silt, clay, texture, group] of cases) {
    assert.equal(textureClass(sand, silt, clay), texture, `${sand}/${silt}/${clay} texture`);
    assert.equal(hydrologicGroup(texture), group, `${texture} group`);
  }
  // Every class must land in a group; an unmapped one would come back undefined
  // and silently poison the rate lookup.
  for (const [, , , texture] of cases) {
    assert.ok(INFILTRATION[hydrologicGroup(texture)] > 0, `${texture} has a rate`);
  }
}

// Groups are ordered: A drains fastest, D slowest. The whole feature rests on
// this contrast, so assert the ordering rather than the individual numbers.
{
  const { A, B, C, D } = INFILTRATION;
  assert.ok(A > B && B > C && C > D && D > 0, "infiltration decreases A -> D");
  assert.ok(A / D >= 5, `sand should drain several times faster than clay, got ${A / D}x`);
}

// ------------------------------------------------- fractions -> mm/h

// Sakarya's real numbers, in g/kg as SoilGrids returns them.
assert.equal(infiltrationFor(282, 427, 292), INFILTRATION.D, "Sakarya clay loam -> D");
// The Sahara sample: sandier, and must not land in the same group.
assert.ok(infiltrationFor(464, 313, 223) > INFILTRATION.D, "Sahara drains faster than Sakarya");

// A column that does not sum to roughly FULL is not a reading.
assert.equal(infiltrationFor(0, 0, 0), UNKNOWN, "ocean");
assert.equal(infiltrationFor(100, 100, 100), UNKNOWN, "sums to 300, rejected");
assert.equal(infiltrationFor(600, 600, 600), UNKNOWN, "sums to 1800, rejected");
assert.equal(infiltrationFor(-32768, 500, 500), UNKNOWN, "nodata sentinel");
assert.notEqual(infiltrationFor(FULL * 0.96 - 20, 10, 10), UNKNOWN, "just inside the tolerance");

// Fractions are normalised, so a column summing to 960 classifies the same as
// the same proportions summing to exactly 1000.
assert.equal(infiltrationFor(282, 427, 292), infiltrationFor(271, 410, 280), "normalised");

// ------------------------------------------------- whole grid

{
  const sand = Int16Array.from([282, 900, 0, 100]);
  const silt = Int16Array.from([427, 50, 0, 100]);
  const clay = Int16Array.from([292, 50, 0, 100]);
  const { rates, covered } = infiltrationGrid({ sand, silt, clay });
  assert.equal(rates.length, 4);
  assert.equal(rates[0], INFILTRATION.D, "clay loam cell");
  assert.equal(rates[1], INFILTRATION.A, "sandy cell");
  assert.equal(rates[2], UNKNOWN, "ocean cell stays unknown");
  assert.equal(rates[3], UNKNOWN, "bad sum stays unknown");
  close(covered, 0.5, 1e-9, "covered fraction");
  // Gaps must stay gaps: filling them with a guess would put invented physics
  // over open water and over most of a city.
  assert.ok([...rates].every((r) => r === UNKNOWN || r > 0), "no zero rates");
}

console.log("soil.mjs: all checks passed");
