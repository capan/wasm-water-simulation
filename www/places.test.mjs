// Run: node places.test.mjs   (shaping only; the live service is checked in the browser)
import assert from "node:assert/strict";
import { findPlaces } from "./places.mjs";

const withFetch = async (impl, run) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = real; }
};
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

// A real Photon response for "geyve", trimmed. `extent` is [W, N, E, S] — the
// north/south pair is the wrong way round compared with most bbox formats, and
// getting it backwards silently flips the map to the other side of the equator.
{
  const results = await withFetch(
    ok({ features: [{
      geometry: { type: "Point", coordinates: [30.2902514, 40.5090547] },
      properties: { name: "Geyve", state: "Sakarya", country: "Türkiye",
                    extent: [30.0709492, 40.6614858, 30.5578202, 40.3355641] },
    }] }),
    () => findPlaces("geyve")
  );
  assert.equal(results.length, 1);
  const [g] = results;
  assert.equal(g.name, "Geyve");
  assert.equal(g.context, "Sakarya, Türkiye");
  assert.equal(g.lat, 40.5090547, "latitude comes second in the coordinate pair");
  assert.equal(g.lon, 30.2902514);
  assert.deepEqual(g.bounds, { west: 30.0709492, north: 40.6614858, east: 30.5578202, south: 40.3355641 });
  assert.ok(g.bounds.north > g.bounds.south, "north must be north of south");
}

// No extent: a point result still resolves, just without bounds to fit.
{
  const [p] = await withFetch(
    ok({ features: [{
      geometry: { type: "Point", coordinates: [28.9758715, 41.006381] },
      properties: { name: "İstanbul", city: "Fatih", state: "İstanbul", country: "Türkiye" },
    }] }),
    () => findPlaces("istanbul")
  );
  assert.equal(p.bounds, null);
  // "İstanbul" is both the name and the state; the context should not repeat it.
  assert.equal(p.context, "Fatih, Türkiye");
}

// Junk in the response must not become a map jump to nowhere.
{
  const results = await withFetch(
    ok({ features: [
      { geometry: null, properties: { name: "No geometry" } },
      { geometry: { coordinates: ["x", "y"] }, properties: { name: "Not numbers" } },
      { geometry: { coordinates: [1, 2] }, properties: { name: "Fine" } },
    ] }),
    () => findPlaces("mixed")
  );
  assert.deepEqual(results.map((r) => r.name), ["Fine"]);
}

// An empty query must not hit the network at all.
{
  let called = false;
  const results = await withFetch(
    async () => { called = true; return ok({ features: [] })(); },
    () => findPlaces("   ")
  );
  assert.equal(called, false, "blank query should short-circuit");
  assert.deepEqual(results, []);
}

// Failures surface as errors the UI can show, except aborts, which are routine
// when a newer keystroke supersedes an in-flight request.
await withFetch(async () => ({ ok: false, status: 503 }),
  () => assert.rejects(() => findPlaces("x"), /HTTP 503/));
await withFetch(async () => { throw new TypeError("Failed to fetch"); },
  () => assert.rejects(() => findPlaces("x"), /Could not reach the place search/));
await withFetch(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
  () => assert.rejects(() => findPlaces("x"), /aborted/));

console.log("places.mjs: all checks passed");
