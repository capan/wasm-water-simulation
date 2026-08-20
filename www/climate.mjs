// Long-term mean rainfall from Open-Meteo's ERA5-Land archive, used as a
// baseline rain rate for the selected area.
import { cellToLatLon } from "./tiles.mjs";

const API = "https://archive-api.open-meteo.com/v1/archive";

export const CLIMATE_START = "2020-01-01";
export const CLIMATE_END = "2024-12-31";

// ERA5's native grid is ~28 km; a simulation selection is a few km across, so
// the whole window sits inside a single ERA5 cell. There is nothing to
// interpolate between, so this returns one number for the window, not a
// per-cell array.
export function meanRateFrom(precipitationSum) {
  if (precipitationSum.length === 0) return 0;
  const total = precipitationSum.reduce((sum, mm) => sum + (Number(mm) || 0), 0);
  return total / (precipitationSum.length * 24);
}

/**
 * Mean rain rate (mm/h) for a grid's window, averaged over CLIMATE_START..CLIMATE_END.
 * @param {object} grid a `planGrid` result
 * @returns {Promise<number>} 0 if the climatology could not be fetched.
 */
export async function meanRain(grid) {
  const { lat, lon } = cellToLatLon(grid, grid.width / 2, grid.height / 2);
  const url =
    `${API}?latitude=${lat}&longitude=${lon}` +
    `&start_date=${CLIMATE_START}&end_date=${CLIMATE_END}` +
    `&daily=precipitation_sum&models=era5&timezone=UTC`;
  // models=era5, not era5_land: the land model has finer cells (~11 km) but
  // returns null for every day of precipitation_sum. That reads as HTTP 200
  // with no data, i.e. a silently rainless planet. Verified 2026-08-20.

  let response;
  try {
    response = await fetch(url);
  } catch (e) {
    console.warn(`Could not reach climate archive: ${e.message}`);
    return 0;
  }
  if (!response.ok) {
    console.warn(`Climate archive unavailable (HTTP ${response.status})`);
    return 0;
  }

  try {
    const json = await response.json();
    const daily = json.daily.precipitation_sum;
    if (!Array.isArray(daily)) throw new Error("missing daily.precipitation_sum");
    if (daily.every((mm) => mm === null)) throw new Error("all days null");
    return meanRateFrom(daily);
  } catch (e) {
    console.warn(`Malformed climate archive response: ${e.message}`);
    return 0;
  }
}
