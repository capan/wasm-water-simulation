// Live precipitation from RainViewer radar, resampled onto a simulation grid.
import { TILE, tilesFor, fetchWindow } from "./tiles.mjs";

const API = "https://api.rainviewer.com/public/weather-maps.json";
const COVERAGE = "https://tilecache.rainviewer.com/v2/coverage/0/256";

// RainViewer's public tiles stop here; deeper zooms serve a "Zoom Level Not
// Supported" placeholder. One radar pixel is ~1.2 km, which is about the
// resolution of the underlying radar mosaic anyway, so the simulation grid just
// samples it nearest-neighbour.
export const RADAR_ZOOM = 7;

// The tile server ignores the colour-scheme id in the URL and always serves
// "Universal Blue", so decoding means inverting that palette. Index i is the
// radar's own byte: dBZ = (i & 127) - 32, and i >= 128 marks snow. Table taken
// from rainviewer.com/api/color-schemes.html, RRGGBBAA per entry.
const PALETTE_HEX =
  "000000000000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000006361591466635a1969665c1e6c685d246f6b5f29" +
  "726e612e75706234787364397c75653e7f786744827b6949857d6a4e88806c548b826d59" +
  "8e856f5e928871649e93756eaa9e7978b6a97e82c2b4828ccec08796d2c48ba0d6c88faa" +
  "dacc93b4ded097be88ddeeff6cd1ebff51c5e8ff36bae5ff1baee2ff00a3e0ff009ad5ff" +
  "0091caff0088bfff007fb4ff0077aaff0070a3ff00699cff006295ff005b8eff005588ff" +
  "005180ff004e78ff004a70ff004768ffffee00ffffe000ffffd200ffffc500ffffb700ff" +
  "ffaa00ffff9f00ffff9500ffff8b00ffff8100ffff4400fff23600ffe62800ffd91b00ff" +
  "cd0d00ffc10000ffa80000ff8f0000ff760000ff5d0000ffffaaffffff9fffffff95ffff" +
  "ff8bffffff81ffffff77ffffff6cffffff62ffffff58ffffff4effffffffffffffffffff" +
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ff00ff" +
  "00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff" +
  "00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff" +
  "00ff00ff00ff00ff00000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000cfffff00ceffff0ccdffff19" +
  "ccffff26cbffff33cbffff3fcaffff4cc9ffff59c8ffff66c7ffff72c7ffff7fc6ffff8c" +
  "c5ffff99c4ffffa5c3ffffb2c3ffffbfc2ffffccc1ffffd8c0ffffe5bffffff2bfffffff" +
  "b8f8ffffb2f2ffffabebffffa5e5ffff9fdfffff98d8ffff92d2ffff8bcbffff85c5ffff" +
  "7fbfffff78b8ffff72b2ffff6babffff65a5ffff5f9fffff5b9bffff5898ffff5595ffff" +
  "5292ffff4f8fffff4b8bffff4888ffff4585ffff4282ffff3f7fffff3b7bffff3878ffff" +
  "3575ffff3272ffff2f6fffff2b6bffff2868ffff2565ffff2262ffff1f5fffff1b5bffff" +
  "1858ffff1555ffff1252ffff0f4fffff0c4bffff0948ffff0645ffff0242ffff003fffff" +
  "003bffff0038ffff0035ffff0032ffff002fffff002bffff0028ffff0025ffff0022ffff" +
  "001fffff001bffff0018ffff0015ffff0012ffff000fffff000cffff0009ffff0006ffff" +
  "0002ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff" +
  "0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff" +
  "0000ffff0000ffff0000ffff0000ffff";

const NO_ECHO = -32; // the palette's floor — "nothing here"

const key = (r, g, b, a) => ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;

// colour -> dBZ. Lowest index wins: the palette repeats one colour across the
// transparent low end and across the saturated top, and the lower dBZ is the
// safer read.
const paletteDbz = (() => {
  const map = new Map();
  for (let i = 255; i >= 0; i--) {
    const p = i * 8;
    const [r, g, b, a] = [0, 2, 4, 6].map((o) => parseInt(PALETTE_HEX.slice(p + o, p + o + 2), 16));
    map.set(key(r, g, b, a), (i & 127) - 32);
  }
  return map;
})();

/**
 * One RGBA pixel -> dBZ. Exact palette hits are the norm; the nearest entry is
 * a fallback for browsers whose decode path shifts a channel (see tiles.mjs).
 */
export function pixelToDbz(r, g, b, a) {
  if (a === 0) return NO_ECHO;
  const hit = paletteDbz.get(key(r, g, b, a));
  if (hit !== undefined) return hit;
  let best = NO_ECHO;
  let bestDist = Infinity;
  for (let i = 0; i < 256; i++) {
    const p = i * 8;
    const d =
      (parseInt(PALETTE_HEX.slice(p, p + 2), 16) - r) ** 2 +
      (parseInt(PALETTE_HEX.slice(p + 2, p + 4), 16) - g) ** 2 +
      (parseInt(PALETTE_HEX.slice(p + 4, p + 6), 16) - b) ** 2 +
      (parseInt(PALETTE_HEX.slice(p + 6, p + 8), 16) - a) ** 2;
    if (d < bestDist) [bestDist, best] = [d, (i & 127) - 32];
  }
  paletteDbz.set(key(r, g, b, a), best); // misses repeat across a whole tile
  return best;
}

/**
 * Marshall-Palmer: Z = 200 R^1.6 with Z = 10^(dBZ/10), so R = (Z/200)^(1/1.6).
 * Capped because the palette saturates above 65 dBZ (hail, not rain) and the
 * relation runs away there.
 */
export const dbzToMmPerHour = (dbz) =>
  dbz <= NO_ECHO ? 0 : Math.min((10 ** (Math.min(dbz, 65) / 10) / 200) ** (1 / 1.6), 200);

const decodeDbz = (rgba, out = new Int8Array(rgba.length / 4)) => {
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = pixelToDbz(rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]);
  }
  return out;
};

// The coverage mask is the inverse of what it looks like: transparent means a
// radar can see this pixel, opaque black means it cannot. Without it "no rain"
// and "no radar" are the same transparent tile.
const decodeCoverage = (rgba, out = new Int8Array(rgba.length / 4)) => {
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] === 0 ? 1 : 0;
  return out;
};

/**
 * Every radar frame RainViewer is currently serving, oldest first — about two
 * hours of past frames, plus nowcast frames when it has them. Empty if it is
 * listing none.
 */
export async function radarFrames() {
  const response = await fetch(API);
  if (!response.ok) throw new Error(`Radar index unavailable (HTTP ${response.status})`);
  const { host, radar } = await response.json();
  return [...(radar?.past ?? []), ...(radar?.nowcast ?? [])].map(({ time, path }) => ({
    time,
    url: `${host}${path}/${TILE}`,
  }));
}

/** The radar-zoom pixel window covering a simulation grid. */
const radarWindow = ({ z, x0, y0, width, height }) => {
  const shift = Math.max(0, z - RADAR_ZOOM);
  const rx0 = x0 >> shift;
  const ry0 = y0 >> shift;
  return {
    z: z - shift,
    shift,
    x0: rx0,
    y0: ry0,
    width: (((x0 + width - 1) >> shift) - rx0) + 1,
    height: (((y0 + height - 1) >> shift) - ry0) + 1,
  };
};

/**
 * Rain rate per simulation cell for one radar frame.
 * @param {object} grid a `planGrid` result
 * @param {{url: string}} frame from `latestFrame`
 * @returns {Promise<{rates: Float32Array, covered: number, wet: number}>}
 *   `rates` is mm/h per cell, row-major, same dimensions as the grid.
 *   `covered` is the fraction of cells a radar can actually see — 0 means the
 *   area has no radar coverage, which is not the same as no rain.
 */
export async function fetchRain(grid, frame) {
  const win = radarWindow(grid);
  const pixels = win.width * win.height;
  const [dbz, coverage] = await Promise.all([
    fetchWindow(win, (t) => `${frame.url}/${t.z}/${t.x}/${t.y}/0/0_0.png`,
      decodeDbz, new Int8Array(pixels), "radar tile"),
    fetchWindow(win, (t) => `${COVERAGE}/${t.z}/${t.x}/${t.y}/0/0_0.png`,
      decodeCoverage, new Int8Array(pixels), "radar coverage tile"),
  ]);

  const rates = new Float32Array(grid.width * grid.height);
  let covered = 0;
  let wet = 0;
  for (let row = 0; row < grid.height; row++) {
    const ry = ((grid.y0 + row) >> win.shift) - win.y0;
    for (let col = 0; col < grid.width; col++) {
      const p = ry * win.width + ((grid.x0 + col) >> win.shift) - win.x0;
      const rate = dbzToMmPerHour(dbz[p]);
      rates[row * grid.width + col] = rate;
      if (coverage[p]) covered++;
      if (rate > 0) wet++;
    }
  }
  return { rates, covered: covered / rates.length, wet };
}
