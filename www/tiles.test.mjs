// Run: node tiles.test.mjs
import assert from "node:assert/strict";
import {
  planGrid, gridBounds, cellToLatLon, latLonToCell, metresPerCell,
  gridSize, clampCorner, MAX_GRID,
} from "./tiles.mjs";

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

// Cell size on the ground. At zoom 12 a pixel is about 38 m at the equator and
// shrinks by cos(latitude); a zoom step in halves it.
{
  const near = (lat) => planGrid({ north: lat + 0.02, south: lat - 0.02, east: 30.32, west: 30.3 });
  close(metresPerCell(near(0.0)), 38.22, 0.05, "equator");
  close(metresPerCell(near(40.75)), 38.22 * Math.cos((40.75 * Math.PI) / 180), 0.05, "Sakarya");
  assert.ok(metresPerCell(near(60)) < metresPerCell(near(0)), "shrinks away from the equator");

  const g12 = planGrid({ north: 40.76, south: 40.74, east: 30.32, west: 30.3 }, 12);
  const g13 = planGrid({ north: 40.76, south: 40.74, east: 30.32, west: 30.3 }, 13);
  close(metresPerCell(g12) / metresPerCell(g13), 2, 1e-3, "one zoom step halves it");
}

// A clamped corner must always produce a grid the simulation will accept, from
// any direction and however far the pointer is dragged.
{
  const anchor = { lat: 40.75, lon: 30.4 };
  const far = [
    { lat: 41.9, lon: 31.6 },   // south-east of the anchor, well past the limit
    { lat: 39.6, lon: 29.2 },   // north-west
    { lat: 41.9, lon: 29.2 },   // mixed
    { lat: 39.6, lon: 31.6 },
    { lat: 55.0, lon: 60.0 },   // absurdly far
  ];
  for (const corner of far) {
    const c = clampCorner(anchor, corner);
    const bbox = {
      north: Math.max(anchor.lat, c.lat), south: Math.min(anchor.lat, c.lat),
      east: Math.max(anchor.lon, c.lon), west: Math.min(anchor.lon, c.lon),
    };
    const { width, height } = gridSize(bbox);
    assert.ok(width <= MAX_GRID && height <= MAX_GRID,
      `clamped ${JSON.stringify(corner)} still ${width}x${height}`);
    // and it must not be rejected on release either
    assert.doesNotThrow(() => planGrid(bbox), `planGrid rejected a clamped ${width}x${height}`);
    // the clamp should be doing real work, not collapsing the box
    assert.ok(width > MAX_GRID * 0.9 && height > MAX_GRID * 0.9,
      `clamp shrank too far: ${width}x${height}`);
  }
}

// A corner already inside the limit is left where it is.
{
  const anchor = { lat: 40.75, lon: 30.4 };
  const near = { lat: 40.72, lon: 30.44 };
  const c = clampCorner(anchor, near);
  close(c.lat, near.lat, 1e-9, "latitude untouched");
  close(c.lon, near.lon, 1e-9, "longitude untouched");
}

// Each axis clamps independently: a box that is too wide but short keeps its height.
{
  const anchor = { lat: 40.75, lon: 30.4 };
  const c = clampCorner(anchor, { lat: 40.73, lon: 34.0 });
  close(c.lat, 40.73, 1e-9, "height is within the limit, so it is kept");
  assert.ok(c.lon < 34.0, "width was over the limit, so it was pulled back");
}

// gridSize agrees with planGrid on the same bbox.
{
  const bbox = { north: 40.8, south: 40.7, east: 30.45, west: 30.3 };
  const g = planGrid(bbox);
  const s = gridSize(bbox);
  assert.equal(s.width, g.width);
  assert.equal(s.height, g.height);
  assert.equal(s.x0, g.x0);
  assert.equal(s.y0, g.y0);
}

console.log("tiles.mjs: all checks passed");
