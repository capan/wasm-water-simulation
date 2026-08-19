// Soil texture from SoilGrids (ISRIC), 250 m and global, no key needed.
//
// The WMS renders PNG through a six-colour ramp, which throws the numbers away,
// so this asks for GeoTIFF and reads the values. That normally means a GeoTIFF
// library; it does not here, because these particular files are a narrow case —
// single band, 16-bit, deflate, tiled — and deflate is a native browser API.
// See `readTiff` for the exact subset that is supported, and what it refuses.

const WMS = "https://maps.isric.org/mapserv";
const R = 20037508.342789244; // half the Web Mercator world, in metres

/** Fractions are g/kg, so a full soil column sums to about this. */
export const FULL = 1000;

// 0-5 cm: the surface layer is the one that decides whether rain soaks in.
const DEPTH = "0-5cm";
export const PROPERTIES = ["sand", "silt", "clay"];

/**
 * The grid's own bounds in EPSG:3857 metres. Derived from the tile pixel origin
 * rather than from lat/lon, so it cannot disagree with `planGrid` by a rounding
 * step — both are linear in the same Web Mercator space.
 */
export function gridMetres({ z, x0, y0, width, height }) {
  const perPixel = (2 * R) / (256 * 2 ** z);
  return {
    west: x0 * perPixel - R,
    east: (x0 + width) * perPixel - R,
    north: R - y0 * perPixel,
    south: R - (y0 + height) * perPixel,
  };
}

const soilUrl = (property, { west, south, east, north }, width, height) =>
  `${WMS}?map=/map/${property}.map&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=` +
  `&LAYERS=${property}_${DEPTH}_mean&CRS=EPSG:3857` +
  `&BBOX=${west},${south},${east},${north}&WIDTH=${width}&HEIGHT=${height}&FORMAT=image/tiff`;

// ------------------------------------------------------------------- decoding

const TAG = {
  width: 256, height: 257, bits: 258, compression: 259, samples: 277,
  predictor: 317, tileWidth: 322, tileHeight: 323, tileOffsets: 324,
  tileCounts: 325, stripOffsets: 273, stripCounts: 279, rowsPerStrip: 278,
  sampleFormat: 339,
};

/** Inflate a zlib stream with the platform's own decompressor. */
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Minimal TIFF reader for the shape SoilGrids returns: one 16-bit band, deflate,
 * horizontal predictor, tiled or stripped. Anything else throws rather than
 * returning quietly wrong numbers — a silently mis-decoded soil map would look
 * entirely plausible.
 * @returns {Promise<{width: number, height: number, data: Int16Array}>}
 */
export async function readTiff(buffer) {
  const view = new DataView(buffer);
  const order = view.getUint16(0, true);
  const le = order === 0x4949; // "II"
  if (!le && order !== 0x4d4d) throw new Error("Not a TIFF");
  if (view.getUint16(2, le) !== 42) throw new Error("Not a classic TIFF");

  const entries = new Map();
  const ifd = view.getUint32(4, le);
  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    entries.set(view.getUint16(at, le), {
      type: view.getUint16(at + 2, le),
      count: view.getUint32(at + 4, le),
      value: view.getUint32(at + 8, le),
      at: at + 8,
    });
  }
  const one = (tag, fallback) => (entries.has(tag) ? entries.get(tag).value : fallback);
  const many = (tag) => {
    const e = entries.get(tag);
    if (!e) return [];
    if (e.count === 1) return [e.value];
    const short = e.type === 3;
    const out = [];
    for (let i = 0; i < e.count; i++) {
      out.push(short ? view.getUint16(e.value + i * 2, le) : view.getUint32(e.value + i * 4, le));
    }
    return out;
  };

  const width = one(TAG.width);
  const height = one(TAG.height);
  const compression = one(TAG.compression, 1);
  if (one(TAG.bits, 8) !== 16) throw new Error(`Unsupported bit depth ${one(TAG.bits, 8)}`);
  if (one(TAG.samples, 1) !== 1) throw new Error("Expected a single band");
  if (compression !== 8 && compression !== 32946) {
    throw new Error(`Unsupported TIFF compression ${compression}`);
  }
  const signed = one(TAG.sampleFormat, 1) === 2;
  const predictor = one(TAG.predictor, 1);
  if (predictor !== 1 && predictor !== 2) throw new Error(`Unsupported predictor ${predictor}`);

  const tiled = entries.has(TAG.tileOffsets);
  const blockWidth = tiled ? one(TAG.tileWidth) : width;
  const blockHeight = tiled ? one(TAG.tileHeight) : one(TAG.rowsPerStrip, height);
  const offsets = many(tiled ? TAG.tileOffsets : TAG.stripOffsets);
  const counts = many(tiled ? TAG.tileCounts : TAG.stripCounts);
  const across = Math.ceil(width / blockWidth);

  const data = new Int16Array(width * height);
  for (let b = 0; b < offsets.length; b++) {
    const raw = await inflate(new Uint8Array(buffer, offsets[b], counts[b]));
    const block = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const ox = tiled ? (b % across) * blockWidth : 0;
    const oy = tiled ? Math.floor(b / across) * blockHeight : b * blockHeight;
    const rows = Math.min(blockHeight, Math.floor(raw.length / (blockWidth * 2)));

    for (let r = 0; r < rows; r++) {
      const y = oy + r;
      if (y >= height) break;
      let previous = 0;
      for (let c = 0; c < blockWidth; c++) {
        const at = (r * blockWidth + c) * 2;
        if (at + 1 >= raw.length) break;
        let v = signed ? block.getInt16(at, le) : block.getUint16(at, le);
        // Horizontal differencing: each value is stored relative to its
        // left-hand neighbour, so the row has to be summed back up.
        if (predictor === 2) {
          v = (v + previous) & 0xffff;
          previous = v;
          if (signed && v > 0x7fff) v -= 0x10000;
        }
        const x = ox + c;
        if (x < width) data[y * width + x] = v;
      }
    }
  }
  return { width, height, data };
}

// -------------------------------------------------------------------- fetching

async function fetchProperty(property, box, width, height) {
  const where = `${property} soil data`;
  let response;
  try {
    response = await fetch(soilUrl(property, box, width, height));
  } catch (e) {
    throw new Error(`Could not reach ${where}: ${e.message}`);
  }
  if (!response.ok) throw new Error(`Could not load ${where} (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  // MapServer reports failures as an XML body under a 200, so sniff the magic.
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (head[0] === 0x3c) throw new Error(`${where}: the server returned an error, not an image`);

  const tiff = await readTiff(buffer);
  if (tiff.width !== width || tiff.height !== height) {
    throw new Error(`${where}: expected ${width}x${height}, got ${tiff.width}x${tiff.height}`);
  }
  return tiff.data;
}

/**
 * Soil texture for every cell of a simulation grid.
 *
 * The WMS resamples server-side, so this asks for exactly the grid's dimensions
 * and there is nothing to resample here. Soil is 250 m data and a cell is about
 * 30 m, so neighbouring cells mostly share a value — that is the source talking,
 * not a bug.
 *
 * @param {object} grid a `planGrid` result
 * @returns {Promise<{sand: Int16Array, silt: Int16Array, clay: Int16Array, valid: number}>}
 *   fractions in g/kg per cell; `valid` is the share of cells the survey covers.
 */
export async function fetchSoil(grid) {
  const { width, height } = grid;
  const box = gridMetres(grid);
  const [sand, silt, clay] = await Promise.all(
    PROPERTIES.map((p) => fetchProperty(p, box, width, height))
  );

  let valid = 0;
  for (let i = 0; i < sand.length; i++) {
    if (isCovered(sand[i], silt[i], clay[i])) valid++;
  }
  return { sand, silt, clay, valid: valid / sand.length };
}

/**
 * Whether the survey actually has a reading here. Oceans and gaps come back as
 * zero or a nodata sentinel, and a genuine column sums to roughly `FULL`; a
 * rounding-width tolerance keeps real readings from being thrown away.
 */
export const isCovered = (sand, silt, clay) => {
  if (sand <= 0 || silt <= 0 || clay <= 0) return false;
  const total = sand + silt + clay;
  return total > FULL * 0.95 && total < FULL * 1.05;
};

// ----------------------------------------------------- texture -> infiltration

/**
 * USDA texture class from the three fractions as percentages. This is the
 * standard decision tree off the texture triangle, in the order the boundaries
 * are defined — the branches overlap, so the order is part of the definition and
 * cannot be rearranged.
 */
export function textureClass(sand, silt, clay) {
  if (silt + 1.5 * clay < 15) return "sand";
  if (silt + 1.5 * clay >= 15 && silt + 2 * clay < 30) return "loamy sand";
  if ((clay >= 7 && clay < 20 && sand > 52 && silt + 2 * clay >= 30) ||
      (clay < 7 && silt < 50 && silt + 2 * clay >= 30)) return "sandy loam";
  if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return "loam";
  if ((silt >= 50 && clay >= 12 && clay < 27) ||
      (silt >= 50 && silt < 80 && clay < 12)) return "silt loam";
  if (silt >= 80 && clay < 12) return "silt";
  if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return "sandy clay loam";
  if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return "clay loam";
  if (clay >= 27 && clay < 40 && sand <= 20) return "silty clay loam";
  if (clay >= 35 && sand > 45) return "sandy clay";
  if (clay >= 40 && silt >= 40) return "silty clay";
  return "clay";
}

/** NRCS hydrologic soil group — the runoff behaviour each texture is grouped into. */
const GROUP = {
  sand: "A", "loamy sand": "A", "sandy loam": "A",
  loam: "B", "silt loam": "B", silt: "B",
  "sandy clay loam": "C",
  "clay loam": "D", "silty clay loam": "D", "sandy clay": "D",
  "silty clay": "D", clay: "D",
};

export const hydrologicGroup = (texture) => GROUP[texture];

/**
 * Infiltration capacity in mm/h per hydrologic soil group, from the NRCS
 * minimum rates for each group's saturated condition (TR-55).
 *
 * Saturated, not initial, and that is deliberate: dry soil takes water far
 * faster at first and slows as it wets (Horton). Modelling that decay needs
 * per-cell moisture carried across ticks, which this does not do — so the
 * saturated end-member is the honest choice, being what ground settles to
 * under sustained rain. It biases towards runoff, which is the visible case.
 */
export const INFILTRATION = { A: 10.0, B: 5.5, C: 2.5, D: 1.0 };

/** Cells the survey has no reading for. Callers must not treat this as a rate. */
export const UNKNOWN = -1;

/** mm/h for one cell's fractions, in g/kg, or `UNKNOWN`. */
export function infiltrationFor(sand, silt, clay) {
  if (!isCovered(sand, silt, clay)) return UNKNOWN;
  // Normalise to percentages: the three do not always sum to exactly `FULL`.
  const total = sand + silt + clay;
  const pct = (v) => (v / total) * 100;
  return INFILTRATION[hydrologicGroup(textureClass(pct(sand), pct(silt), pct(clay)))];
}

/**
 * Infiltration capacity per cell for a whole grid.
 *
 * Uncovered cells stay `UNKNOWN` rather than being filled with a guess. The
 * survey has real gaps — open water, and most of a dense city — and inventing a
 * texture there would put invented physics exactly where the app is most often
 * pointed. What an unknown cell does is the caller's decision, not this one's.
 *
 * @param {{sand: Int16Array, silt: Int16Array, clay: Int16Array}} soil
 * @returns {{rates: Float32Array, covered: number}} rates in mm/h
 */
export function infiltrationGrid({ sand, silt, clay }) {
  const rates = new Float32Array(sand.length);
  let covered = 0;
  for (let i = 0; i < sand.length; i++) {
    rates[i] = infiltrationFor(sand[i], silt[i], clay[i]);
    if (rates[i] !== UNKNOWN) covered++;
  }
  return { rates, covered: covered / rates.length };
}
