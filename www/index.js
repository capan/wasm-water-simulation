import { Universe } from "wasm-water-simulation";
import { fetchElevation } from "./elevation.mjs";
import { gridBounds, latLonToCell, MAX_GRID, ZOOM } from "./tiles.mjs";
import { radarFrames, fetchRain } from "./rain.mjs";
import { fetchSoil, infiltrationGrid } from "./soil.mjs";

const MAX_CANVAS_PX = 720; // longest canvas edge; cell size is derived from it
const WATER_COLOR = "#0339fc";

// Droplets spawned per cell per tick, per mm/h of radar rain. The single knob
// mapping a rain rate to a droplet count; droplets are indicative, not a
// hydrological volume. A droplet lives 50 ticks, so the steady-state share of
// cells holding water is rate * RAIN_FACTOR * 50 — about 1% in moderate rain,
// which reads as flowing streaks and leaves headroom under the cap.
const RAIN_FACTOR = 0.00005;
// Live droplets to stop at. Tick and draw cost both track this number, so it,
// and not the grid size, is what keeps the frame rate up under heavy rain.
const WATER_CAP = 4000;
// Radar publishes roughly every 10 minutes; poll often enough that a new frame
// shows up promptly without hammering the index.
const RAIN_POLL_MS = 60_000;
// One replay step per this long. The tiles are HTTP-cached after the first
// lap, so a second pass round the loop costs nothing.
const REPLAY_STEP_MS = 900;

const $ = (id) => document.getElementById(id);
const canvas = $("wasm-water-simulation");
const ctx = canvas.getContext("2d");
const statusLine = $("status");

// Everything about the running simulation lives here. Booting a new area swaps
// this object, so the DOM listeners below are registered once and never leak.
let sim = null;
let animationId = null;
let msWaitTicks = 300;
let lastRenderTime = 0;
// The slice of the grid the map is currently showing, in cells — drawn on the
// canvas so panning the map tells you which part of the terrain you are on.
let viewRect = null;

const setStatus = (text, isError = false) => {
  statusLine.textContent = text;
  statusLine.className = isError ? "hint error" : "hint";
};

/** The header pill is the one place that says what the app is doing. */
const setState = (label, state) => {
  const pill = $("state-pill");
  pill.textContent = label;
  pill.dataset.state = state;
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
  const cell = Math.max(1, Math.floor(MAX_CANVAS_PX / Math.max(width, height)));
  canvas.width = width * cell;
  canvas.height = height * cell;
  ctx.imageSmoothingEnabled = false; // reset by resizing the canvas

  sim = {
    universe, width, height, cell, grid,
    rain: null, // {rates, wet, frameTime, covered}, filled in once radar arrives
    soil: null, // {rates, covered}, filled in once the soil survey arrives
    terrain: renderTerrain(data, width, height, universe, 255),
    // 1 px per cell, translucent, blitted onto the map overlay
    overlay: renderTerrain(data, width, height, universe, 130),
    frame: makeCanvas(width, height),
  };
  window.sim = sim; // handle for poking at a running simulation from the console
  updateViewRect();
  canvas.classList.remove("hidden");
  $("empty-state").classList.add("hidden");
  enable(SIM_CONTROLS, true);
  draw();
  play();
}

const makeCanvas = (width, height) => {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
};

// Terrain never changes, so paint it once at one pixel per cell and blit it
// scaled every frame.
function renderTerrain(data, width, height, universe, alpha) {
  const terrain = makeCanvas(width, height);
  const tctx = terrain.getContext("2d");
  const image = tctx.createImageData(width, height);
  const min = universe.min_height();
  const span = Math.max(1, universe.max_height() - min);
  for (let i = 0; i < width * height; i++) {
    const shade = ((data[i] - min) * 255) / span;
    image.data[i * 4] = shade;
    image.data[i * 4 + 1] = shade;
    image.data[i * 4 + 2] = shade;
    image.data[i * 4 + 3] = alpha;
  }
  tctx.putImageData(image, 0, 0);
  return terrain;
}

// Rain shading, painted once per radar frame at one pixel per cell and blitted
// like the terrain. Rates span three orders of magnitude, so the square root
// keeps a drizzle visible without washing out a downpour. The alpha ceiling is
// deliberately low: this is a tint saying "it is raining here", and the terrain
// and the droplets both have to stay readable through it.
function renderRainLayer(rates, width, height) {
  const layer = makeCanvas(width, height);
  const lctx = layer.getContext("2d");
  const image = lctx.createImageData(width, height);
  for (let i = 0; i < rates.length; i++) {
    if (rates[i] <= 0) continue;
    image.data[i * 4] = 116;
    image.data[i * 4 + 1] = 154;
    image.data[i * 4 + 2] = 255;
    image.data[i * 4 + 3] = 14 + 62 * Math.min(1, Math.sqrt(rates[i] / 25));
  }
  lctx.putImageData(image, 0, 0);
  return layer;
}

// Soil shading, painted once when the survey lands. Earthy rather than blue, so
// it cannot be mistaken for rain or for water, and only lightly opaque so the
// terrain relief underneath still reads. Uncovered cells stay clear — a gap in
// the survey should look like a gap, not like a value.
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
    image.data[i * 4 + 3] = 74;
  }
  lctx.putImageData(image, 0, 0);
  return layer;
}

function draw(pushOverlay = true) {
  const { universe, width, height, cell, terrain, overlay, frame, rain } = sim;
  const water = universe.water_cells(); // flat [row, col, ...]
  const rainLayer = rainOn() ? rain?.layer : null;
  const soilLayer = soilOn() ? sim.soil?.layer : null;

  ctx.drawImage(terrain, 0, 0, canvas.width, canvas.height);
  if (soilLayer) ctx.drawImage(soilLayer, 0, 0, canvas.width, canvas.height);
  if (rainLayer) ctx.drawImage(rainLayer, 0, 0, canvas.width, canvas.height);
  ctx.fillStyle = WATER_COLOR;
  for (let i = 0; i < water.length; i += 2) {
    ctx.fillRect(water[i + 1] * cell, water[i] * cell, cell, cell);
  }

  drawViewRect();

  // Same picture at one pixel per cell, pushed onto the map. Leaflet stretches
  // it to the grid's bounds, which is exact — the grid is an axis-aligned
  // rectangle in the same Web Mercator space the map uses. Panning the map does
  // not change it, so a redraw triggered by the map skips the encode.
  if (!simOverlay || !pushOverlay) return;
  const fctx = frame.getContext("2d");
  fctx.clearRect(0, 0, width, height);
  fctx.drawImage(overlay, 0, 0);
  if (soilLayer) fctx.drawImage(soilLayer, 0, 0);
  if (rainLayer) fctx.drawImage(rainLayer, 0, 0);
  fctx.fillStyle = WATER_COLOR;
  for (let i = 0; i < water.length; i += 2) fctx.fillRect(water[i + 1], water[i], 1, 1);
  simOverlay.setUrl(frame.toDataURL());
}

// Two strokes so the box stays legible over both dark valleys and bright peaks:
// a dark backing line, then a white dashed line on top. White rather than blue
// keeps it from reading as water.
function drawViewRect() {
  if (!viewRect) return;
  const { cell } = sim;
  const box = [viewRect.x * cell, viewRect.y * cell, viewRect.w * cell, viewRect.h * cell];
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.strokeRect(...box);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(...box);
  ctx.restore();
}

/**
 * Clip the map's viewport to the grid, in cells. Null when the map is not
 * looking at the grid at all, and also when it contains the whole of it — a box
 * around everything says nothing worth drawing.
 */
function updateViewRect() {
  if (!sim) return (viewRect = null);
  const bounds = map.getBounds();
  const nw = latLonToCell(sim.grid, bounds.getNorth(), bounds.getWest());
  const se = latLonToCell(sim.grid, bounds.getSouth(), bounds.getEast());
  if (nw.col <= 0 && nw.row <= 0 && se.col >= sim.width && se.row >= sim.height) {
    return (viewRect = null);
  }
  const x = Math.max(0, nw.col);
  const y = Math.max(0, nw.row);
  const w = Math.min(sim.width, se.col) - x;
  const h = Math.min(sim.height, se.row) - y;
  viewRect = w > 0 && h > 0 ? { x, y, w, h } : null;
  if (sim) sim.viewRect = viewRect; // inspectable alongside the rest of the state
}

/** Cell indices the radar says are wet, so the spawner skips the dry majority. */
const wetCells = (rates) => Uint32Array.from(
  (function* () { for (let i = 0; i < rates.length; i++) if (rates[i] > 0) yield i; })()
);

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
  // Start somewhere random in the wet list: when the budget runs out mid-pass,
  // the shortfall should not always come out of the same corner of the grid.
  const start = Math.floor(Math.random() * wet.length);
  for (let n = 0; n < wet.length && budget > 0; n++) {
    const i = wet[(start + n) % wet.length];
    const soaks = capacity ? capacity[i] : 0;
    const runoff = soaks > 0 ? rates[i] - soaks : rates[i];
    if (runoff > 0 && Math.random() < runoff * RAIN_FACTOR) {
      universe.handle_user_input(Math.floor(i / width), i % width);
      budget--;
    }
  }
}

const renderLoop = (timestamp) => {
  if (timestamp - lastRenderTime >= msWaitTicks) {
    lastRenderTime = timestamp;
    spawnRain();
    sim.universe.tick();
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

const cellAt = (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
  const y = ((event.clientY - rect.top) * canvas.height) / rect.height;
  const clamp = (v, hi) => Math.max(0, Math.min(Math.floor(v / sim.cell), hi - 1));
  return { row: clamp(y, sim.height), col: clamp(x, sim.width) };
};

canvas.addEventListener("mousemove", (event) => {
  if (!sim) return;
  const { row, col } = cellAt(event);
  $("height").textContent = `${sim.universe.get_cell_value(row, col)} m`;
  $("row-col").textContent = `${row}, ${col}`;
  const soaks = sim.soil?.rates[row * sim.width + col];
  $("soil-readout").textContent =
    soaks === undefined ? "–" : soaks > 0 ? `${soaks.toFixed(1)} mm/h` : "no survey";
});

canvas.addEventListener("click", (event) => {
  if (!sim) return;
  const { row, col } = cellAt(event);
  sim.universe.handle_user_input(row, col);
  draw();
});

$("play-pause").addEventListener("click", () => (animationId === null ? play() : pause()));

$("step").addEventListener("click", () => {
  if (!sim) return;
  pause();
  spawnRain();
  sim.universe.tick();
  draw();
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

const map = L.map("map").setView([40.75, 30.4], ZOOM);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

let firstCorner = null;
let cornerMarker = null;
let selecting = false;

// `move` fires throughout a drag, so the box tracks the map live — coalesced to
// one redraw per frame, since Leaflet can fire it more than once in that time.
// The overlay push is skipped: it is positioned geographically, so Leaflet moves
// it for us and re-encoding the PNG on every drag event would be wasted work.
let viewRedraw = null;
map.on("move zoom", () => {
  if (!sim || viewRedraw !== null) return;
  viewRedraw = requestAnimationFrame(() => {
    viewRedraw = null;
    updateViewRect();
    draw(false);
  });
});
let selectionBox = null;
let simOverlay = null;
let busy = false;

const clearCorner = () => {
  firstCorner = null;
  if (cornerMarker) map.removeLayer(cornerMarker);
  cornerMarker = null;
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
    setState("Pick corners", "busy");
  } else if (!sim) {
    setStatus("Pick an area to simulate — up to " + MAX_GRID + "x" + MAX_GRID + " cells, roughly 15 km across.");
    setState("Idle", "idle");
  }
}

$("select-area").addEventListener("click", () => setSelecting(!selecting));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selecting) setSelecting(false);
});

map.on("click", (event) => {
  if (busy || !selecting) return;
  if (!firstCorner) {
    firstCorner = event.latlng;
    cornerMarker = L.circleMarker(firstCorner, { radius: 5, color: "#38bdf8", weight: 2 }).addTo(map);
    setStatus("Now click the opposite corner.");
    return;
  }
  const bounds = L.latLngBounds(firstCorner, event.latlng);
  setSelecting(false);
  select(bounds);
});

async function select(bounds) {
  busy = true;
  setStatus("Fetching elevation tiles…");
  setState("Loading terrain", "busy");
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
    selectionBox = L.rectangle(corners, { color: "#38bdf8", weight: 2, fill: false }).addTo(map);
    const blank = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    simOverlay = L.imageOverlay(blank, corners, { className: "sim-overlay" }).addTo(map);

    boot(data, grid);
    setStatus(`Simulating ${width}x${height} cells at zoom ${grid.z}. Click the terrain to drop water.`);
    setState(`${width}x${height}`, "ready");
    refreshRain();
    loadSoil(grid);
  } catch (error) {
    setStatus(error.message, true);
    setState("Error", "error");
    console.error(error);
  } finally {
    busy = false;
  }
}

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
  setRainStatus(`Manual rain: ${manualRate} mm/h everywhere.`);
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
  manualRate = Number(rainMm.value);
  $("rain-mm-display").textContent = manualRate ? `${manualRate} mm/h` : "off";
  if (manualRate) applyManualRain();
  else showFrame(frameIndex); // zero hands the grid back to the radar
});

$("rain-toggle").addEventListener("change", () => {
  if (sim) draw(); // show or hide the shading immediately, even while paused
});

$("soil-toggle").addEventListener("change", () => {
  applySoil(); // drainage and shading are the same switch, so they cannot disagree
  if (sim) draw();
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
    draw();
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
