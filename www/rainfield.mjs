// Owns "how much rain falls on each cell". Composes three sources — live
// radar, a climate baseline, and a user brush — into one mm/h field per
// simulation cell. Pure logic: no fetching, no DOM.
export const BRUSH_RATE = 50; // mm/h a brush dab adds (heavy rain)
export const BRUSH_RADIUS = 3; // cells

let width = 0;
let height = 0;
let radar = null; // Float32Array mm/h per cell, or null when radar has nothing
let climate = 0; // mm/h, the window's long-term mean
let gain = 1;
let brush = new Float32Array(0);
let out = new Float32Array(0);
let dirty = true;

/** (Re)allocate the brush and output buffers for a new grid size. */
export function setSize(w, h) {
  width = w;
  height = h;
  brush = new Float32Array(w * h);
  out = new Float32Array(w * h);
  // A resize means a new area was selected, so the radar frame and the
  // climate mean both belong to the old window. Drop them rather than
  // index a stale, wrong-length array until the next fetch lands.
  radar = null;
  climate = 0;
  dirty = true;
}

/** Float32Array mm/h per cell, row-major, or null to clear. */
export function setRadar(rates) {
  radar = rates;
  dirty = true;
}

export function setClimate(mmPerHour) {
  climate = mmPerHour;
  dirty = true;
}

export function setGain(g) {
  gain = g;
  dirty = true;
}

/** Stamp a filled disc of radius BRUSH_RADIUS centred on (row, col). */
export function paint(row, col, erase) {
  const value = erase ? 0 : BRUSH_RATE;
  const r2 = BRUSH_RADIUS * BRUSH_RADIUS;
  const rowLo = Math.max(0, row - BRUSH_RADIUS);
  const rowHi = Math.min(height - 1, row + BRUSH_RADIUS);
  const colLo = Math.max(0, col - BRUSH_RADIUS);
  const colHi = Math.min(width - 1, col + BRUSH_RADIUS);
  for (let r = rowLo; r <= rowHi; r++) {
    const dr = r - row;
    for (let c = colLo; c <= colHi; c++) {
      const dc = c - col;
      if (dr * dr + dc * dc <= r2) brush[r * width + c] = value;
    }
  }
  dirty = true;
}

export function clearBrush() {
  brush.fill(0);
  dirty = true;
}

/** Recomposed mm/h field, one Float32Array reused across calls. */
export function rates() {
  if (dirty) {
    for (let i = 0; i < out.length; i++) {
      // rain.mjs cannot tell a radar coverage hole from a covered, genuinely
      // dry cell — both decode to 0. So `max` puts the climate mean under
      // every cell rather than only under the holes, which is why a clear day
      // still drizzles at the baseline rate. A per-cell coverage mask out of
      // rain.mjs would separate the two; nothing needs that yet.
      const base = radar ? Math.max(radar[i], climate) : climate;
      out[i] = base * gain + brush[i];
    }
    dirty = false;
  }
  return out;
}
