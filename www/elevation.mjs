// Fetches AWS Terrain Tiles and decodes them to metres.
import { planGrid, fetchWindow } from "./tiles.mjs";

const tileUrl = ({ z, x, y }) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** Terrarium encoding: elevation = R*256 + G + B/256 - 32768 (metres). */
export function terrariumToMeters(rgba, out = new Int32Array(rgba.length / 4)) {
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = Math.round(rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768);
  }
  return out;
}

/**
 * bbox -> elevation grid in metres.
 * @param {{north,south,east,west}} bbox
 * @returns {Promise<{data: Int32Array, width: number, height: number, grid: object}>}
 */
export async function fetchElevation(bbox, z) {
  const grid = planGrid(bbox, z); // throws on too-large areas
  const { width, height } = grid;
  const data = new Int32Array(width * height);
  await fetchWindow(grid, tileUrl, terrariumToMeters, data, "elevation tile");
  return { data, width, height, grid };
}
