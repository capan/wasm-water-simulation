import { Universe } from "wasm-water-simulation";
import { fetchElevation } from "./elevation.mjs";
import {
  gridBounds, latLonToCell, metresPerCell, gridSize, clampCorner, MAX_GRID, ZOOM,
} from "./tiles.mjs";
import { radarFrames, fetchRain } from "./rain.mjs";
import { fetchSoil, infiltrationGrid } from "./soil.mjs";
import { findPlaces } from "./places.mjs";

// Chosen against the hypsometric ramp, not in isolation: the ramp runs from dark
// green to near-white, so no one colour has strong luminance contrast at both
// ends. This maximises the worst case across the six ramp stops (1.61, against
// 1.03 for the deep blue it replaced, which was invisible on mid-slope brown).
const WATER_COLOR = "#29a3ff";
const ACCENT = WATER_COLOR; // chrome and data share one colour

// Droplets spawned per cell per tick, per mm/h of radar rain. The single knob
// mapping a rain rate to a droplet count; droplets are indicative, not a
// hydrological volume. A droplet lives 50 ticks, so the steady-state share of
// cells holding water is rate * RAIN_FACTOR * 50 — about 1% in moderate rain,
// which reads as flowing streaks and leaves headroom under the cap.
const RAIN_FACTOR = 0.00005;
// Live droplets to stop at. Tick and draw cost both track this number, so it,
// and not the grid size, is what keeps the frame rate up under heavy rain —
// measured at roughly 2 ms per tick per 4k droplets on a 992-cell grid.
//
// It is an absolute count while the grid is not, so the same cap reads very
// differently at either end of the size range: on a 600-cell grid this is about
// 4% of cells, and on a small selection under extreme rain it is enough to cover
// every cell.
const WATER_CAP = 16000;
// Radar publishes roughly every 10 minutes; poll often enough that a new frame
// shows up promptly without hammering the index.
const RAIN_POLL_MS = 60_000;
// Long enough that typing a word is one request rather than six.
const SEARCH_DEBOUNCE_MS = 280;
// The simulation may tick far faster than anyone can watch. Pushing the picture
// to the map means encoding it as a PNG, which on a 992-cell grid is 23 ms of a
// 26 ms frame — so the display refreshes on its own clock and the simulation is
// left free to run at whatever rate it was asked for.
const OVERLAY_MS = 80;
// The manual slider spans nothing to a cloudburst, but the interesting range is
// the bottom of it: 2-20 mm/h is ordinary rain and is where the soil gate and
// the trails actually do something. A linear control would put all of that in
// the first two per cent of travel, so position maps to rate on a square curve
// and the position range is wider than the pixel width, for keyboard steps.
const MANUAL_MAX_MM = 1000;
const manualRateFor = (position) => ((position / 200) ** 2) * MANUAL_MAX_MM;
// The square curve lands on values like 864.9000000000001, so every place that
// shows a rate goes through here. One decimal while the numbers are small
// enough for it to matter, whole millimetres above that.
const formatRate = (mm) => (mm < 10 ? mm.toFixed(1) : String(Math.round(mm)));
// One replay step per this long. The tiles are HTTP-cached after the first
// lap, so a second pass round the loop costs nothing.
const REPLAY_STEP_MS = 900;
// How much of the trail layer is erased each tick, and how much each droplet
// adds as it passes. The pair is what makes drainage emerge rather than smear:
// a cell settles at stamp/(stamp+fade), so a channel every droplet crosses goes
// to ~0.8 while ground crossed once in twenty ticks sits near 0.17. Stamping
// harder washes that separation out — at 0.5 the two are only 2x apart and the
// whole grid saturates. Tuned alongside RAIN_FACTOR.
//
// The fade is a multiply in 8-bit, so it has a fixed point: any alpha below
// 0.5/fade rounds back to itself and stays forever. At 0.03 that floor was 17,
// a 6.5% haze over everywhere water had ever been. Fading faster lowers the
// floor to ~2.5%, invisible in practice, and sharpens the channels at the same
// time — the cost is shorter trails, which is the right thing to trade.
const TRAIL_FADE = 0.08;
const TRAIL_STAMP = 0.12;

const $ = (id) => document.getElementById(id);

// Everything about the running simulation lives here. Booting a new area swaps
// this object, so the DOM listeners below are registered once and never leak.
let sim = null;
let animationId = null;
let msWaitTicks = 300;
let lastRenderTime = 0;

const setStatus = (text, isError = false) => {
  $("status").textContent = text;
  $("status").className = isError ? "alert" : "";
};

// Controls that need a loaded simulation, and controls that additionally need
// a radar frame list. Both start disabled in the markup: a control that looks
// live but silently does nothing is worse than one that is visibly off.
const SIM_CONTROLS = ["play-pause", "step", "tick-range", "rain-toggle", "rain-mm"];
const RADAR_CONTROLS = ["replay", "frame-range"];
const SOIL_CONTROLS = ["soil-toggle"];
const enable = (ids, on) => ids.forEach((id) => ($(id).disabled = !on));

// ---------------------------------------------------------------- simulation

function boot(data, grid) {
  pause();
  sim?.universe.free();

  const { width, height } = grid;
  const universe = new Universe(data, width, height);
  const metres = metresPerCell(grid);
  sim = {
    universe, width, height, grid,
    rain: null, // {rates, wet, frameTime, covered}, filled in once radar arrives
    soil: null, // {rates, covered}, filled in once the soil survey arrives
    // Near-opaque so the relief reads true; the sliver of basemap that shows
    // through is enough to place it without muddying the colours.
    terrain: renderTerrain(data, width, height, universe, 235, metres),
    frame: makeCanvas(width, height),
    // Where water has recently been. Drainage is the interesting output of the
    // simulation and it is invisible frame to frame, because a droplet occupies
    // a cell for one tick; this is what makes the path itself the picture.
    trails: makeCanvas(width, height),
  };
  window.sim = sim; // handle for poking at a running simulation from the console
  enable(SIM_CONTROLS, true);
  draw(true);
  play();
}

const makeCanvas = (width, height) => {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
};

// Hypsometric ramp: the convention relief maps have used for a century, so it
// reads as terrain without a legend. Stops are normalised to the grid's own
// range, so a 100 m hill gets the same spread as an alpine valley — this shows
// the shape of what was selected, not absolute altitude.
const RELIEF = [
  [0.0, 74, 108, 74],
  [0.18, 108, 138, 78],
  [0.38, 158, 162, 96],
  [0.58, 186, 154, 102],
  [0.78, 150, 112, 82],
  [1.0, 238, 236, 232],
];

function relief(t) {
  let i = 1;
  while (i < RELIEF.length - 1 && t > RELIEF[i][0]) i++;
  const [t0, r0, g0, b0] = RELIEF[i - 1];
  const [t1, r1, g1, b1] = RELIEF[i];
  const k = (t - t0) / (t1 - t0);
  return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
}

// Light from the north-west at 45 degrees, which is the direction cartographers
// settled on because the eye reads any other one as craters instead of hills.
const SUN_AZIMUTH = (315 * Math.PI) / 180;
const SUN_ALTITUDE = (45 * Math.PI) / 180;
// Real slopes over a 15 km selection are gentle enough to look flat at true
// scale, so the vertical is exaggerated — standard practice for relief shading.
const RELIEF_EXAGGERATION = 3;

/**
 * Terrain never changes, so paint it once at one pixel per cell and blit it
 * scaled every frame. Hillshade is the usual 3x3 kernel: slope and aspect from
 * the eight neighbours, edges clamped to the cell itself.
 */
function renderTerrain(data, width, height, universe, alpha, metres) {
  const terrain = makeCanvas(width, height);
  const tctx = terrain.getContext("2d");
  const image = tctx.createImageData(width, height);
  const min = universe.min_height();
  const span = Math.max(1, universe.max_height() - min);
  const run = 8 * metres;

  const at = (x, y) =>
    data[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const [a, b, c] = [at(x - 1, y - 1), at(x, y - 1), at(x + 1, y - 1)];
      const [d, f] = [at(x - 1, y), at(x + 1, y)];
      const [g, h, k] = [at(x - 1, y + 1), at(x, y + 1), at(x + 1, y + 1)];
      const dzdx = ((c + 2 * f + k - (a + 2 * d + g)) / run) * RELIEF_EXAGGERATION;
      const dzdy = ((g + 2 * h + k - (a + 2 * b + c)) / run) * RELIEF_EXAGGERATION;

      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const lit =
        Math.cos(SUN_ALTITUDE) * Math.cos(slope) +
        Math.sin(SUN_ALTITUDE) * Math.sin(slope) * Math.cos(SUN_AZIMUTH - aspect);
      // Never fully black: a shaded slope should still show its own colour.
      const shade = 0.55 + 0.75 * Math.max(0, lit);

      const [r, gr, bl] = relief((data[i] - min) / span);
      image.data[i * 4] = Math.min(255, r * shade);
      image.data[i * 4 + 1] = Math.min(255, gr * shade);
      image.data[i * 4 + 2] = Math.min(255, bl * shade);
      image.data[i * 4 + 3] = alpha;
    }
  }
  tctx.putImageData(image, 0, 0);
  return terrain;
}

// Rain shading, painted once per radar frame at one pixel per cell and blitted
// like the terrain. Rates span three orders of magnitude, so the square root
// keeps a drizzle visible without washing out a downpour. The alpha ceiling is
// deliberately low: this is a tint saying "it is raining here", and the terrain,
// the trails and the droplets all have to stay readable through it. Rain and
// soil are both on by default and both cover the whole grid, so their alphas
// have to be read together — at 76 and 74 they left the relief contributing
// barely half the pixel.
function renderRainLayer(rates, width, height) {
  const layer = makeCanvas(width, height);
  const lctx = layer.getContext("2d");
  const image = lctx.createImageData(width, height);
  for (let i = 0; i < rates.length; i++) {
    if (rates[i] <= 0) continue;
    image.data[i * 4] = 116;
    image.data[i * 4 + 1] = 154;
    image.data[i * 4 + 2] = 255;
    image.data[i * 4 + 3] = 10 + 42 * Math.min(1, Math.sqrt(rates[i] / 25));
  }
  lctx.putImageData(image, 0, 0);
  return layer;
}

// Soil shading, painted once when the survey lands. Earthy rather than blue, so
// it cannot be mistaken for rain or for water, and only lightly opaque so the
// terrain relief underneath still reads — this is 250 m data drawn over 30 m
// cells, so it arrives as large blocks and a heavy alpha turns the map into a
// mosaic. Uncovered cells stay clear: a gap in the survey should look like a
// gap, not like a value.
function renderSoilLayer(rates, width, height) {
  const layer = makeCanvas(width, height);
  const lctx = layer.getContext("2d");
  const image = lctx.createImageData(width, height);
  for (let i = 0; i < rates.length; i++) {
    if (rates[i] <= 0) continue;
    // Group D (1 mm/h) to group A (10 mm/h) is one decade, so a log ramp puts
    // the four groups the data actually contains at even spacing.
    const t = Math.min(1, Math.max(0, Math.log10(rates[i])));
    image.data[i * 4] = 138 + 98 * t;
    image.data[i * 4 + 1] = 87 + 102 * t;
    image.data[i * 4 + 2] = 71 + 65 * t;
    image.data[i * 4 + 3] = 44;
  }
  lctx.putImageData(image, 0, 0);
  return layer;
}

/**
 * Compose one frame at a pixel per cell and hand it to the map. Leaflet stretches
 * it onto the grid's bounds, which is exact — the grid is an axis-aligned
 * rectangle in the same Web Mercator space the map uses.
 */
let lastOverlayPush = 0;

function draw(force = false) {
  if (!simOverlay) return;
  const now = performance.now();
  if (!force && now - lastOverlayPush < OVERLAY_MS) return;
  lastOverlayPush = now;
  const { universe, width, height, terrain, frame, rain } = sim;
  const water = universe.water_cells(); // flat [row, col, ...]
  const fctx = frame.getContext("2d");

  fctx.clearRect(0, 0, width, height);
  fctx.drawImage(terrain, 0, 0);
  if (soilOn() && sim.soil?.layer) fctx.drawImage(sim.soil.layer, 0, 0);
  if (rainOn() && rain?.layer) fctx.drawImage(rain.layer, 0, 0);
  fctx.drawImage(sim.trails, 0, 0);
  fctx.fillStyle = WATER_COLOR;
  for (let i = 0; i < water.length; i += 2) fctx.fillRect(water[i + 1], water[i], 1, 1);
  simOverlay.setUrl(frame.toDataURL());
}

/** Cell indices the radar says are wet, so the spawner skips the dry majority. */
const wetCells = (rates) => Uint32Array.from(
  (function* () { for (let i = 0; i < rates.length; i++) if (rates[i] > 0) yield i; })()
);

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/**
 * A step size that visits every index of a list of this length exactly once.
 * Any stride coprime with the length does; picking it afresh each tick keeps the
 * scatter from settling into a fixed pattern.
 */
function coprimeStride(length) {
  if (length < 3) return 1;
  let stride = 1 + Math.floor(Math.random() * (length - 1));
  while (gcd(stride, length) !== 1) stride = (stride % (length - 1)) + 1;
  return stride;
}

/**
 * One tick's worth of rain. Only the part of the rainfall the ground cannot
 * absorb becomes runoff, so a cell spawns on `rate - capacity` rather than on
 * `rate`: light rain on free-draining soil produces nothing at all, and the same
 * rain on clay produces streams.
 *
 * Cells the soil survey does not cover fall back to the whole rate, which is
 * what this did before soil existed. Guessing a capacity there would put
 * invented physics over water and over most of a city.
 */
function spawnRain() {
  const { rain, universe, width } = sim;
  if (!rain || !rainOn()) return;
  let budget = WATER_CAP - universe.water_cells_count();
  if (budget <= 0) return;

  const { wet, rates } = rain;
  const capacity = soilOn() ? sim.soil?.rates : null;

  // The budget usually runs out long before the list does, so which cells get
  // visited first decides where the rain lands. Walking end to end from a random
  // start spreads the *starting point* around but still spawns one contiguous
  // run of row-major indices, which is a horizontal band across the map. Step by
  // a stride coprime with the length instead: it still reaches every entry
  // exactly once, but an early stop leaves a subset scattered over the whole
  // grid rather than a block of adjacent rows.
  const start = Math.floor(Math.random() * wet.length);
  const stride = coprimeStride(wet.length);
  for (let n = 0, k = start; n < wet.length && budget > 0; n++, k = (k + stride) % wet.length) {
    const i = wet[k];
    const soaks = capacity ? capacity[i] : 0;
    const runoff = soaks > 0 ? rates[i] - soaks : rates[i];
    if (runoff > 0 && Math.random() < runoff * RAIN_FACTOR) {
      universe.handle_user_input(Math.floor(i / width), i % width);
      budget--;
    }
  }
}

/**
 * Age the trail layer by one tick and stamp the current water onto it. Fading
 * with `destination-out` scrubs alpha rather than painting over, so old trails
 * thin out towards transparent instead of towards a background colour — which
 * matters because this is composited over terrain, not over black.
 */
function advanceTrails() {
  const { trails, width, height, universe } = sim;
  const tctx = trails.getContext("2d");
  tctx.globalCompositeOperation = "destination-out";
  tctx.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
  tctx.fillRect(0, 0, width, height);

  tctx.globalCompositeOperation = "source-over";
  tctx.fillStyle = WATER_COLOR;
  tctx.globalAlpha = TRAIL_STAMP;
  const water = universe.water_cells();
  for (let i = 0; i < water.length; i += 2) tctx.fillRect(water[i + 1], water[i], 1, 1);
  tctx.globalAlpha = 1;
}

const renderLoop = (timestamp) => {
  if (timestamp - lastRenderTime >= msWaitTicks) {
    lastRenderTime = timestamp;
    spawnRain();
    sim.universe.tick();
    advanceTrails();
    draw();
    $("iteration").textContent = sim.universe.water_cells_count().toLocaleString();
  }
  animationId = requestAnimationFrame(renderLoop);
};

const play = () => {
  if (!sim || animationId !== null) return;
  $("play-pause").textContent = "⏸";
  $("play-pause").title = "Pause";
  lastRenderTime = 0;
  animationId = requestAnimationFrame(renderLoop);
};

const pause = () => {
  $("play-pause").textContent = "▶";
  $("play-pause").title = "Play";
  if (animationId !== null) cancelAnimationFrame(animationId);
  animationId = null;
};

// --------------------------------------------------------------------- input

$("play-pause").addEventListener("click", () => (animationId === null ? play() : pause()));

$("step").addEventListener("click", () => {
  if (!sim) return;
  pause();
  spawnRain();
  sim.universe.tick();
  advanceTrails();
  draw(true);
});

const tickRange = $("tick-range");
tickRange.addEventListener("input", () => {
  msWaitTicks = (100 - tickRange.value) * 10;
  $("speed-display").textContent = msWaitTicks
    ? `${(1000 / msWaitTicks).toFixed(1)}/s`
    : "every frame";
});
tickRange.value = 70;
tickRange.dispatchEvent(new Event("input"));

// ----------------------------------------------------------------------- map

// zoomSnap 0 lets fitBounds land on a fractional zoom, so a selected area fills
// the screen instead of dropping to the next whole zoom that happens to contain
// it — the difference between the simulation being the view and being a stamp.
// Zoom control lives bottom-right: the search bar owns top-left and the
// how-it-works link owns top-right.
const map = L.map("map", { zoomSnap: 0, zoomControl: false }).setView([40.75, 30.4], ZOOM);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  // The elevation licence wants its eleven national surveys credited; the full
  // list lives on /how, which is the reasonable place for it in this medium.
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a> | <a href="/how#attribution">Data sources</a>',
}).addTo(map);

let firstCorner = null;
let cornerMarker = null;
let previewBox = null;
let selecting = false;

/**
 * The box between the first corner and the pointer, pulled inside the limit.
 * Leaflet spells longitude `lng` and the tile maths spells it `lon`, so the
 * conversion happens here rather than being assumed anywhere.
 */
function previewFrom(latlng) {
  const anchor = { lat: firstCorner.lat, lon: firstCorner.lng };
  const corner = clampCorner(anchor, { lat: latlng.lat, lon: latlng.lng }, ZOOM);
  const bounds = L.latLngBounds(firstCorner, L.latLng(corner.lat, corner.lon));
  const size = gridSize({
    north: bounds.getNorth(), south: bounds.getSouth(),
    east: bounds.getEast(), west: bounds.getWest(),
  }, ZOOM);
  // Comparing the clamped corner with the pointer would always differ: it makes
  // a round trip through pixel space and comes back a float away. Ask the size
  // instead, which is the thing the message is actually about.
  const atLimit = size.width >= MAX_GRID - 1 || size.height >= MAX_GRID - 1;
  return { bounds, size, atLimit };
}

let selectionBox = null;
let simOverlay = null;
let busy = false;

const clearCorner = () => {
  firstCorner = null;
  for (const layer of [cornerMarker, previewBox]) if (layer) map.removeLayer(layer);
  cornerMarker = null;
  previewBox = null;
};

/** Arm or disarm corner-picking. Disarmed, the map is just a map. */
function setSelecting(on) {
  selecting = on;
  clearCorner();
  $("map").classList.toggle("selecting", on);
  $("select-area").setAttribute("aria-pressed", String(on));
  $("select-area").textContent = on ? "Cancel" : "Select area";
  if (on) {
    setStatus("Click the first corner on the map.");
  } else if (!sim) {
    setStatus("Pick an area to simulate — up to " + MAX_GRID + "x" + MAX_GRID + " cells, roughly 15 km across.");
  }
}

$("select-area").addEventListener("click", () => setSelecting(!selecting));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selecting) setSelecting(false);
});

/** Which cell a point on the map falls in, or null if it misses the grid. */
function cellUnder(latlng) {
  if (!sim) return null;
  const { col, row } = latLonToCell(sim.grid, latlng.lat, latlng.lng);
  const c = Math.floor(col);
  const r = Math.floor(row);
  return c >= 0 && r >= 0 && c < sim.width && r < sim.height ? { row: r, col: c } : null;
}

map.on("click", (event) => {
  // Not selecting: a click on the simulated area is water, and anywhere else is
  // just the map doing what maps do.
  if (!selecting) {
    const cell = cellUnder(event.latlng);
    if (!cell) return;
    sim.universe.handle_user_input(cell.row, cell.col);
    draw(true);
    return;
  }
  if (busy) return;
  if (!firstCorner) {
    firstCorner = event.latlng;
    cornerMarker = L.circleMarker(firstCorner, { radius: 4, color: ACCENT, weight: 2 }).addTo(map);
    setStatus("Now click the opposite corner.");
    return;
  }
  const { bounds } = previewFrom(event.latlng);
  setSelecting(false);
  select(bounds);
});

async function select(bounds) {
  busy = true;
  setStatus("Fetching elevation tiles…");
  try {
    const bbox = {
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest(),
    };
    const { data, width, height, grid } = await fetchElevation(bbox);

    for (const layer of [selectionBox, simOverlay]) if (layer) map.removeLayer(layer);
    const b = gridBounds(grid);
    const corners = [[b.south, b.west], [b.north, b.east]];
    selectionBox = L.rectangle(corners, { color: ACCENT, weight: 2, fill: false }).addTo(map);
    const blank = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    simOverlay = L.imageOverlay(blank, corners, { className: "sim-overlay" }).addTo(map);

    // The map is the only view now, so put it on what was just selected —
    // otherwise the simulation is a postage stamp wherever the map happened to be.
    map.fitBounds(corners, {
      paddingTopLeft: [40, 40],
      paddingBottomRight: [40, 130], // clear of the dock
    });
    boot(data, grid);
    setStatus(`Simulating ${width}x${height} cells at zoom ${grid.z}. Click the terrain to drop water.`);
    refreshRain();
    loadSoil(grid);
  } catch (error) {
    setStatus(error.message, true);
    console.error(error);
  } finally {
    busy = false;
  }
}

// The readout follows the pointer over the simulated area and says what the
// ground under it is; there are no stat tiles for it to live in any more.
map.on("mousemove", (event) => {
  // While picking the second corner, show the box that would be selected —
  // already clamped, so the edge stops following the pointer at the limit
  // rather than letting a selection be built that would only be refused later.
  if (selecting && firstCorner) {
    const { bounds, size, atLimit } = previewFrom(event.latlng);
    if (previewBox) previewBox.setBounds(bounds);
    else previewBox = L.rectangle(bounds, { color: ACCENT, weight: 1, dashArray: "4 3", fill: false }).addTo(map);
    setStatus(
      `${size.width}x${size.height} cells` +
        (atLimit ? ` — the largest area allowed` : ". Click the opposite corner.")
    );
  }

  const readout = $("readout");
  const cell = selecting ? null : cellUnder(event.latlng);
  $("map").classList.toggle("dropping", !!cell);
  if (!cell) {
    readout.style.display = "none";
    return;
  }
  const soaks = sim.soil?.rates[cell.row * sim.width + cell.col];
  readout.innerHTML =
    `<b>${sim.universe.get_cell_value(cell.row, cell.col)}</b> m` +
    `<br>${soaks === undefined ? "soil unknown" : soaks > 0 ? `soaks <b>${soaks.toFixed(1)}</b> mm/h` : "no soil survey"}` +
    `<br>${cell.row}, ${cell.col}`;
  readout.style.display = "block";

  // Flip to the other side of the pointer near an edge, so it never runs off.
  const box = readout.getBoundingClientRect();
  const { clientX: x, clientY: y } = event.originalEvent;
  readout.style.left = `${x + 16 + box.width > window.innerWidth ? x - 16 - box.width : x + 16}px`;
  readout.style.top = `${y + 16 + box.height > window.innerHeight ? y - 16 - box.height : y + 16}px`;
});

map.on("mouseout", () => ($("readout").style.display = "none"));

setStatus(
  `Pick an area to simulate — up to ${MAX_GRID}x${MAX_GRID} cells, roughly 15 km across.`
);

// ---------------------------------------------------------------------- rain

// The radar frame list is global, not per-simulation: re-selecting an area
// re-reads the same frames. `live` means the scrubber is parked on the newest
// frame and should follow new ones in; `manualRate` above zero overrides the
// radar with uniform synthetic rain.
let frames = [];
let frameIndex = 0;
let live = true;
let manualRate = 0;
let replayTimer = null;
let rainBusy = false;

const setRainStatus = (text) => {
  $("rain-status").textContent = text;
};

const rainOn = () => $("rain-toggle").checked;

/** Install a rain grid and repaint. `frameTime` null means "not from radar". */
function applyRain(rates, frameTime, covered) {
  sim.rain = {
    rates,
    wet: wetCells(rates),
    frameTime,
    covered,
    layer: renderRainLayer(rates, sim.width, sim.height),
  };
  showRadarAge();
  draw();
}

/** Fetch one radar frame onto the current grid. */
async function showFrame(index) {
  const grid = sim?.grid;
  const frame = frames[index];
  if (!grid || !frame || rainBusy) return;
  if (frame.time === sim.rain?.frameTime) return; // already showing it

  rainBusy = true;
  try {
    const { rates, covered, wet } = await fetchRain(grid, frame);
    if (sim?.grid !== grid) return; // a newer selection arrived while we waited
    // Manual rain may have been switched on while this was in flight; the fetch
    // that started before it must not overwrite what the user just asked for.
    if (manualRate) return;
    applyRain(rates, frame.time, covered);
    setRainStatus(
      covered === 0
        ? "No radar coverage here — rain is unknown, not zero."
        : wet === 0
          ? "Radar sees no rain here right now."
          : `Raining on ${wet} of ${rates.length} cells.`
    );
  } finally {
    rainBusy = false;
  }
}

/** Uniform synthetic rain, so heavy weather can be seen without hunting for it. */
function applyManualRain() {
  if (!sim) return;
  applyRain(new Float32Array(sim.width * sim.height).fill(manualRate), null, 1);
  setRainStatus(`Manual rain: ${formatRate(manualRate)} mm/h everywhere.`);
}

// Elevation is what the user waited for, so radar is fetched after the terrain
// is already on screen and simply appears when it lands. The 60 s poll runs the
// same function: RainViewer publishes a frame about every 10 minutes, so most
// polls recognise the frame they already have and stop after the index fetch.
async function refreshRain() {
  if (!sim) return;
  try {
    frames = await radarFrames();
    if (!frames.length) return setRainStatus("Radar has no recent frames.");

    const newest = frames.length - 1;
    $("frame-range").max = newest;
    enable(RADAR_CONTROLS, frames.length > 1);
    if (live) {
      frameIndex = newest;
      $("frame-range").value = newest;
    }
    showFrameTime();
    if (!manualRate) await showFrame(frameIndex);
  } catch (error) {
    // Keep raining from the grid we already have; the next poll may recover.
    setRainStatus(`Radar unavailable: ${error.message}`);
    console.error(error);
  }
}

// ------------------------------------------------------------ rain controls

function showFrameTime() {
  const frame = frames[frameIndex];
  $("frame-time").textContent = !frame
    ? ""
    : live
      ? "live"
      : new Date(frame.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Ticks on its own timer rather than in the render loop, so the age keeps
// counting up while the simulation is paused.
function showRadarAge() {
  const frameTime = sim?.rain?.frameTime;
  const minutes = frameTime && Math.round((Date.now() / 1000 - frameTime) / 60);
  $("radar-age").textContent = !frameTime
    ? ""
    : minutes < 1
      ? "radar: just now"
      : `radar: ${minutes} min ago`;
}
setInterval(showRadarAge, 1000);

const stopReplay = () => {
  clearInterval(replayTimer);
  replayTimer = null;
  $("replay").textContent = "▶";
};

$("replay").addEventListener("click", () => {
  if (replayTimer) return stopReplay();
  if (frames.length < 2) return;
  $("replay").textContent = "⏸";
  replayTimer = setInterval(() => {
    frameIndex = (frameIndex + 1) % frames.length;
    live = frameIndex === frames.length - 1;
    $("frame-range").value = frameIndex;
    showFrameTime();
    if (!manualRate) showFrame(frameIndex);
  }, REPLAY_STEP_MS);
});

$("frame-range").addEventListener("input", (event) => {
  stopReplay();
  frameIndex = Number(event.target.value);
  live = frameIndex === frames.length - 1; // parked on the newest frame = follow it
  showFrameTime();
  if (!manualRate) showFrame(frameIndex);
});

const rainMm = $("rain-mm");
rainMm.addEventListener("input", () => {
  manualRate = manualRateFor(Number(rainMm.value));
  $("rain-mm-display").textContent = !manualRate ? "off" : `${formatRate(manualRate)} mm/h`;
  if (manualRate) applyManualRain();
  else showFrame(frameIndex); // zero hands the grid back to the radar
});

$("rain-toggle").addEventListener("change", () => {
  if (sim) draw(true); // show or hide the shading immediately, even while paused
});

$("soil-toggle").addEventListener("change", () => {
  applySoil(); // drainage and shading are the same switch, so they cannot disagree
  if (sim) draw(true);
});

// One timer for the life of the page, reading whichever simulation is current.
// Nothing to tear down on re-selection, so no poll can outlive its grid — and a
// fetch already in flight is discarded by the grid check in showFrame.
setInterval(refreshRain, RAIN_POLL_MS);

// ---------------------------------------------------------------------- soil

// Soil does not change, so unlike the radar it is fetched once per area and
// never polled.
async function loadSoil(grid) {
  try {
    const texture = await fetchSoil(grid);
    if (sim?.grid !== grid) return; // a newer selection arrived while we waited

    const { rates, covered } = infiltrationGrid(texture);
    sim.soil = { rates, covered, layer: renderSoilLayer(rates, sim.width, sim.height) };
    enable(SOIL_CONTROLS, true);
    applySoil();
    draw(true);
    setSoilStatus(
      covered === 0
        ? "No soil survey here — drainage falls back to a flat rate."
        : `Soil mapped for ${Math.round(covered * 100)}% of cells.`
    );
  } catch (error) {
    // The simulation is perfectly usable without it: every cell falls back to
    // the rate that was flat before soil existed.
    setSoilStatus(`Soil data unavailable: ${error.message}`);
    console.error(error);
  }
}

/** Hand the grid to Rust for droplet lifetime, or take it away again. */
function applySoil() {
  if (!sim) return;
  if (soilOn() && sim.soil) sim.universe.set_absorption(sim.soil.rates);
  else sim.universe.clear_absorption();
}

const soilOn = () => $("soil-toggle")?.checked ?? true;

const setSoilStatus = (text) => {
  const el = $("soil-status");
  if (el) el.textContent = text;
};

// -------------------------------------------------------------------- search

// The map opens on one view and dragging is a poor way to cross a continent.
const searchBox = $("place-search");
const searchResults = $("place-results");
let matches = [];
let highlighted = -1;
let searchTimer = null;
let searchRequest = null;

const closeResults = () => {
  matches = [];
  highlighted = -1;
  searchResults.replaceChildren();
  searchBox.setAttribute("aria-expanded", "false");
};

function renderResults(note) {
  searchResults.replaceChildren();
  if (note) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = note;
    searchResults.append(li);
  }
  matches.forEach((match, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === highlighted));
    li.textContent = match.name;
    if (match.context) {
      const small = document.createElement("small");
      small.textContent = match.context;
      li.append(small);
    }
    // mousedown, not click: the input's blur would otherwise close the list first.
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      go(match);
    });
    searchResults.append(li);
  });
  searchBox.setAttribute("aria-expanded", String(searchResults.childElementCount > 0));
}

/** Move the map to a match — filling the screen with it when it has an extent. */
function go(match) {
  if (match.bounds) {
    const { south, west, north, east } = match.bounds;
    map.fitBounds([[south, west], [north, east]], { paddingBottomRight: [0, 110] });
  } else {
    map.flyTo([match.lat, match.lon], Math.max(map.getZoom(), ZOOM), { duration: 0.8 });
  }
  searchBox.value = match.name;
  searchBox.blur();
  closeResults();
}

searchBox.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchRequest?.abort();
  const query = searchBox.value;
  if (!query.trim()) return closeResults();

  searchTimer = setTimeout(async () => {
    searchRequest = new AbortController();
    try {
      matches = await findPlaces(query, { signal: searchRequest.signal });
      highlighted = -1;
      renderResults(matches.length ? null : "No matches");
    } catch (error) {
      if (error.name === "AbortError") return; // superseded by a newer keystroke
      matches = [];
      renderResults(error.message);
      console.error(error);
    }
  }, SEARCH_DEBOUNCE_MS);
});

searchBox.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeResults();
    searchBox.blur();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (matches.length) go(matches[Math.max(0, highlighted)]);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (!matches.length) return;
  event.preventDefault();
  const step = event.key === "ArrowDown" ? 1 : -1;
  highlighted = (highlighted + step + matches.length) % matches.length;
  renderResults();
  searchResults.children[highlighted]?.scrollIntoView({ block: "nearest" });
});

searchBox.addEventListener("blur", () => setTimeout(closeResults, 120));

// Typing in the box must not also be typing at the map underneath it.
for (const event of ["keydown", "keypress", "dblclick", "wheel", "mousedown"]) {
  L.DomEvent.on($("place-search").parentElement, event, L.DomEvent.stopPropagation);
}

// ------------------------------------------------------------------ presets

// A one-click shortlist of dramatic terrain. The span reads as ~410x400 cells
// at mid-latitudes but Mercator stretches height with latitude — Glen Coe at
// 56.7°N is 409x531 — so a higher-latitude entry needs rechecking against the
// 600 cap before it ships.
const PRESETS = [
  { name: "Geyve Gorge", lat: 40.47, lon: 30.29 },
  { name: "Lauterbrunnen", lat: 46.57, lon: 7.91 },
  { name: "Yosemite Valley", lat: 37.73, lon: -119.6 },
  { name: "Kaçkar Mountains", lat: 40.83, lon: 41.16 },
  { name: "Glen Coe", lat: 56.66, lon: -5.07 },
];
const PRESET_SPAN = { lat: 0.1, lon: 0.14 };

for (const preset of PRESETS) {
  const button = document.createElement("button");
  button.textContent = preset.name;
  button.addEventListener("click", () => {
    if (busy) return;
    setSelecting(false);
    const { lat, lon } = preset;
    select(L.latLngBounds(
      [lat - PRESET_SPAN.lat / 2, lon - PRESET_SPAN.lon / 2],
      [lat + PRESET_SPAN.lat / 2, lon + PRESET_SPAN.lon / 2]
    ));
  });
  $("presets").append(button);
}
