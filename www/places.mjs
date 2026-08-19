// Place name -> location, via Photon (photon.komoot.io). Keyless, CORS-open and
// built on OSM data, so it agrees with the basemap the app already credits.

const API = "https://photon.komoot.io/api/";

/** Where a match sits, and how much of the map it deserves. */
function place(feature) {
  const p = feature.properties ?? {};
  const [lon, lat] = feature.geometry?.coordinates ?? [];
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  // Photon's extent is [west, north, east, south] — note the north/south order,
  // which is not the one most bbox formats use.
  const e = p.extent;
  const bounds =
    Array.isArray(e) && e.length === 4
      ? { west: e[0], north: e[1], east: e[2], south: e[3] }
      : null;

  // Enough to tell two places of the same name apart, without repeating the name
  // when Photon has already used it as the city or state.
  const context = [p.city, p.state, p.country]
    .filter((v, i, all) => v && v !== p.name && all.indexOf(v) === i)
    .join(", ");

  return { name: p.name || context || "Unnamed", context, lat, lon, bounds };
}

/**
 * Search for a place.
 * @param {string} query
 * @param {{limit?: number, signal?: AbortSignal}} options
 * @returns {Promise<Array<{name, context, lat, lon, bounds}>>}
 */
export async function findPlaces(query, { limit = 6, signal } = {}) {
  const trimmed = query.trim();
  if (!trimmed) return [];

  let response;
  try {
    response = await fetch(`${API}?q=${encodeURIComponent(trimmed)}&limit=${limit}`, { signal });
  } catch (e) {
    if (e.name === "AbortError") throw e; // a newer keystroke, not a failure
    throw new Error(`Could not reach the place search: ${e.message}`);
  }
  if (!response.ok) throw new Error(`Place search failed (HTTP ${response.status})`);

  const body = await response.json();
  return (body.features ?? []).map(place).filter(Boolean);
}
