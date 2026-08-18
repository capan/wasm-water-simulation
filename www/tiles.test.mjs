// Run: node tiles.test.mjs
import assert from "node:assert/strict";
import { planGrid, gridBounds, cellToLatLon, latLonToCell, MAX_GRID } from "./tiles.mjs";

const close = (a, b, eps, what) =>
  assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b} (eps ${eps})`);

// Berlin at z=12 is tile 2200/1343 on every slippy-map calculator.
{
  const g = planGrid({ north: 52.52, south: 52.51, east: 13.41, west: 13.405 });
  assert.deepEqual(g.tiles[0], { z: 12, x: 2200, y: 1343, px: 563200, py: 343808 });
  assert.equal(g.x0, 563332);
  assert.equal(g.y0, 343885);
}

// A bbox straddling a tile boundary must pull every tile it touches.
{
  const g = planGrid({ north: 40.8, south: 40.7, east: 30.45, west: 30.30 });
  assert.ok(g.tiles.length >= 4, `expected multiple tiles, got ${g.tiles.length}`);
  const xs = new Set(g.tiles.map((t) => t.x));
  const ys = new Set(g.tiles.map((t) => t.y));
  assert.equal(g.tiles.length, xs.size * ys.size); // full rectangle, no gaps
}

// Round trip: the grid's own bounds map back to the requested corner.
{
  const bbox = { north: 40.8, south: 40.7, east: 30.45, west: 30.30 };
  const g = planGrid(bbox);
  const b = gridBounds(g);
  close(b.north, bbox.north, 1e-3, "north");
  close(b.west, bbox.west, 1e-3, "west");
  close(b.south, bbox.south, 1e-3, "south");
  close(b.east, bbox.east, 1e-3, "east");

  const c = cellToLatLon(g, 0, 0);
  close(c.lat, bbox.north, 1e-3, "cell 0,0 lat");
  close(c.lon, bbox.west, 1e-3, "cell 0,0 lon");
}

// Too-large areas are rejected, not silently truncated.
assert.throws(
  () => planGrid({ north: 45, south: 35, east: 35, west: 25 }),
  /Area too large/
);

// Exactly at the limit is fine.
{
  const g = planGrid({ north: 40.8, south: 40.7, east: 30.45, west: 30.30 });
  assert.ok(g.width <= MAX_GRID && g.height <= MAX_GRID);
}

// latLonToCell inverts cellToLatLon, and the grid's own bounds land on its corners.
{
  const g = planGrid({ north: 40.8, south: 40.7, east: 30.45, west: 30.30 });
  for (const [col, row] of [[0, 0], [7, 3], [g.width - 1, g.height - 1]]) {
    const { lat, lon } = cellToLatLon(g, col, row);
    const back = latLonToCell(g, lat, lon);
    close(back.col, col + 0.5, 1e-6, `col ${col} round trip`);
    close(back.row, row + 0.5, 1e-6, `row ${row} round trip`);
  }
  const b = gridBounds(g);
  const nw = latLonToCell(g, b.north, b.west);
  const se = latLonToCell(g, b.south, b.east);
  close(nw.col, 0, 1e-6, "north-west col");
  close(nw.row, 0, 1e-6, "north-west row");
  close(se.col, g.width, 1e-6, "south-east col");
  close(se.row, g.height, 1e-6, "south-east row");
}

console.log("tiles.mjs: all checks passed");
