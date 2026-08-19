// Web-Mercator tile math for AWS Terrain Tiles (terrarium).

export const TILE = 256;

export const ZOOM = 12;      // ~30 m/px at mid-latitudes, matches SRTM
export const MAX_GRID = 600;  // cells per side the simulation will accept

const scale = (z) => TILE * 2 ** z;

// lat/lon <-> global pixel coordinates at zoom z
const lonToPx = (lon, z) => ((lon + 180) / 360) * scale(z);
const latToPy = (lat, z) =>
  (0.5 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / (2 * Math.PI)) * scale(z);
const pxToLon = (px, z) => (px / scale(z)) * 360 - 180;
const pyToLat = (py, z) =>
  (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / scale(z))));

/**
 * Turn a lat/lon bbox into the pixel window + the tiles covering it.
 * Throws if the window is bigger than the simulation can take.
 * @param {{north:number,south:number,east:number,west:number}} bbox
 * @returns {{z, x0, y0, width, height, tiles: {z,x,y,px,py}[]}} x0/y0 are global pixel coords
 */
export function planGrid(bbox, z = ZOOM) {
  const { x0, y0, width, height } = gridSize(bbox, z);

  if (width > MAX_GRID || height > MAX_GRID) {
    throw new Error(
      `Area too large: ${width}x${height} cells (max ${MAX_GRID}x${MAX_GRID}). Pick a smaller area.`
    );
  }

  return { z, x0, y0, width, height, tiles: tilesFor({ z, x0, y0, width, height }) };
}

/**
 * The pixel window a bbox resolves to, without enumerating its tiles — cheap
 * enough to call while the pointer is moving.
 */
export function gridSize({ north, south, east, west }, z = ZOOM) {
  const x0 = Math.floor(lonToPx(west, z));
  const y0 = Math.floor(latToPy(north, z));
  return {
    x0,
    y0,
    width: Math.max(1, Math.ceil(lonToPx(east, z)) - x0),
    height: Math.max(1, Math.ceil(latToPy(south, z)) - y0),
  };
}

/**
 * Pull `corner` back towards `anchor` until the box between them is within the
 * grid limit, so a selection cannot be dragged past what the simulation accepts.
 * Each axis is clamped on its own, so running out of room sideways does not stop
 * the box growing downwards.
 *
 * The span is held one pixel under `MAX_GRID`: `gridSize` floors the near edge
 * and ceils the far one, which can add a cell, and a selection that reported
 * exactly the limit while dragging must not be rejected on release.
 */
export function clampCorner(anchor, corner, z = ZOOM) {
  const limit = MAX_GRID - 1;
  const clamp = (from, to) => Math.max(from - limit, Math.min(from + limit, to));
  return {
    lat: pyToLat(clamp(latToPy(anchor.lat, z), latToPy(corner.lat, z)), z),
    lon: pxToLon(clamp(lonToPx(anchor.lon, z), lonToPx(corner.lon, z)), z),
  };
}

/** Every tile covering a pixel window. `px`/`py` are the tile's unwrapped origin. */
export function tilesFor({ z, x0, y0, width, height }) {
  const n = 2 ** z;
  const tiles = [];
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + height - 1) / TILE); ty++) {
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + width - 1) / TILE); tx++) {
      // `x` wraps at the antimeridian; `px`/`py` keep the unwrapped pixel origin so
      // stitching stays correct there too.
      tiles.push({ z, x: ((tx % n) + n) % n, y: ty, px: tx * TILE, py: ty * TILE });
    }
  }
  return tiles;
}

/** Centre of grid cell (col,row) in lat/lon. */
export const cellToLatLon = ({ z, x0, y0 }, col, row) => ({
  lat: pyToLat(y0 + row + 0.5, z),
  lon: pxToLon(x0 + col + 0.5, z),
});

/** Inverse of `cellToLatLon`, in fractional cells so it can bound a region. */
export const latLonToCell = ({ z, x0, y0 }, lat, lon) => ({
  col: lonToPx(lon, z) - x0,
  row: latToPy(lat, z) - y0,
});

/**
 * Ground size of one cell, in metres. Web Mercator pixels shrink away from the
 * equator by cos(latitude), so this is taken at the grid's own centre — good
 * enough for slope, which only needs the ratio of height to distance.
 */
export function metresPerCell({ z, x0, y0, width, height }) {
  const lat = pyToLat(y0 + height / 2, z);
  return ((2 * Math.PI * 6378137) / scale(z)) * Math.cos((lat * Math.PI) / 180);
}

/** The bbox actually covered by a grid — pixel rounding makes it differ from the request. */
export const gridBounds = ({ z, x0, y0, width, height }) => ({
  north: pyToLat(y0, z),
  west: pxToLon(x0, z),
  south: pyToLat(y0 + height, z),
  east: pxToLon(x0 + width, z),
});

// --------------------------------------------------------------- tile pixels

// Tile payloads here are data, not pictures: terrarium packs 256 m into the red
// channel and radar packs a palette index into the whole colour. `<img>` +
// `drawImage` + `getImageData` is not bit-exact — the browser may colour-manage
// the PNG for a wide-gamut display or round-trip it through the GPU, and a
// single-step shift shows up as a 256 m spike or the wrong palette entry.
// ImageDecoder hands back the raw pixels with no canvas involved.
async function tileRgba(url, label) {
  let response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new Error(`Could not reach ${label}: ${e.message}`);
  }
  if (!response.ok) throw new Error(`Could not load ${label} (HTTP ${response.status})`);
  const bytes = await response.arrayBuffer();

  if (typeof ImageDecoder === "function") {
    const decoder = new ImageDecoder({ data: bytes, type: "image/png", colorSpaceConversion: "none" });
    const { image } = await decoder.decode();
    const size = image.allocationSize();
    if (size !== TILE * TILE * 4) {
      image.close();
      throw new Error(`Unexpected tile layout: ${image.codedWidth}x${image.codedHeight} ${image.format}`);
    }
    const rgba = new Uint8ClampedArray(size);
    await image.copyTo(rgba);
    const bgr = image.format?.startsWith("BGR");
    image.close();
    if (bgr) for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
    return rgba;
  }

  // Safari has no ImageDecoder yet. Ask for no colour conversion and a CPU-backed
  // canvas, which is the closest the canvas path gets to exact.
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb", alpha: false });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, TILE, TILE).data;
}

/**
 * Fetch every tile covering a pixel window and copy the decoded values into
 * `out` (one entry per window pixel, row-major).
 * @param {{z,x0,y0,width,height,tiles?}} win
 * @param {(tile) => string} urlFor
 * @param {(rgba: Uint8ClampedArray) => ArrayLike<number>} decode one value per tile pixel
 */
export async function fetchWindow(win, urlFor, decode, out, label = "tile") {
  const { x0, y0, width, height } = win;
  const list = win.tiles ?? tilesFor(win);
  const rgbas = await Promise.all(
    list.map((t) => tileRgba(urlFor(t), `${label} ${t.z}/${t.x}/${t.y}`))
  );

  // Typed-array moves only, so the stitch cannot perturb a single sample.
  list.forEach((tile, i) => {
    const values = decode(rgbas[i]);
    const ox = tile.px - x0;
    const oy = tile.py - y0;
    const sx0 = Math.max(0, -ox);
    const sx1 = Math.min(TILE, width - ox);
    if (sx1 <= sx0) return;
    for (let ty = Math.max(0, -oy); ty < Math.min(TILE, height - oy); ty++) {
      out.set(values.subarray(ty * TILE + sx0, ty * TILE + sx1), (oy + ty) * width + ox + sx0);
    }
  });
  return out;
}
