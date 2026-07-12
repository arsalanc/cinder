// CINDER — weather
// Ambient surface weather: dry spells punctuated by rain, cold snaps, or
// storms. Rain returns water to maps that lock it up as biomass; storms throw
// real lightning (ELEC bolts that electrify pools and torch trees). What
// actually falls is decided per column by the sky temperature — rain over
// warm ground, snow over ice biomes or during a cold snap ('snow' mode drags
// the whole map's temperature down, so rain turns to snow as the cold bites
// and pools freeze over). Precipitation spawns at the sky row, so sealed
// sandbox builds are unaffected.
// updateWeather() is called from the main loop's fixed step — headless tests
// only get weather when they ask for it.

'use strict';

const weather = {
  mode: 'clear',    // 'clear' | 'rain' | 'snow' | 'storm'
  timer: 1200,      // frames until the next mode roll
  boltCd: 0,        // frames until the next lightning strike (storms)
  override: 'auto', // sandbox control: 'auto' (sporadic) | 'off' | forced mode
};

// Creative-mode weather control. 'auto' = the normal sporadic cycle,
// 'off' = permanent clear skies, anything else = that weather, always on.
function setWeatherOverride(v) {
  weather.override = v;
  if (v === 'auto') setWeather('clear', 600 + rand() * 1200);
  else if (v === 'off') setWeather('clear', 999999);
  else setWeather(v, 999999);
}

function setWeather(mode, durationFrames) {
  weather.mode = mode;
  weather.timer = durationFrames;
  weather.boltCd = 60;
  ambientChill = mode === 'snow' ? -30 : 0; // cold snap; thaws when it ends
}

function rollWeather() {
  if (weather.mode !== 'clear') {
    // events are bursts; clear spells are long
    setWeather('clear', 1800 + rand() * 3600);
    return;
  }
  const r = rand();
  setWeather(r < 0.45 ? 'rain' : r < 0.7 ? 'snow' : 'storm',
             900 + rand() * 900); // 15-30s events
}

function resetWeather() {
  weather.override = 'auto'; // runs always use the sporadic cycle
  weather.mode = 'clear';
  weather.timer = 900 + rand() * 1800;
  ambientChill = 0;
}

function updateWeather() {
  if (weather.override === 'off') return;
  if (weather.override === 'auto' && --weather.timer <= 0) rollWeather();
  if (weather.mode === 'clear') return;

  // precipitation falls from the sky row
  const drops = weather.mode === 'storm' ? 2 : 1;
  for (let k = 0; k < drops; k++) {
    if (rand() < 0.5) continue;
    const x = 1 + ((rand() * (SIM_W - 2)) | 0);
    const i = idx(x, 1);
    if (grid[i] === E.EMPTY) {
      // the sky temperature decides what falls: snow over cold ground
      // (ice biomes, or anywhere mid cold snap), rain everywhere else
      setCell(i, tempAt(x, 4) < 0 ? E.SNOW : E.WATER);
    }
  }

  if (weather.mode === 'storm' && --weather.boltCd <= 0) {
    weather.boltCd = 180 + rand() * 240;
    lightningStrike();
  }
}

function lightningStrike() {
  const x = 4 + ((rand() * (SIM_W - 8)) | 0);
  let y = 1;
  while (y < SIM_H - 2 && grid[idx(x, y)] === E.EMPTY) y++;
  if (y <= 2) return; // struck a rooftop at the very sky row; skip
  // visible bolt: a brief column of crackling sparks
  for (let by = 1; by < y; by++) {
    const j = idx(x, by);
    if (grid[j] === E.EMPTY) {
      setCell(j, E.ELEC);
      life[j] = 3 + ((rand() * 4) | 0);
    }
  }
  // ground effect: torch what burns, electrify what conducts
  const target = grid[idx(x, y)];
  if (FLAMMABLE[target] > 0) {
    setCell(idx(x, y), E.FIRE);
    life[idx(x, y)] = BURN_LIFE[target];
  } else {
    electrify(x, y - 1, 3);
  }
  playSfx('thunder');
}
