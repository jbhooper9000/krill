# Krill: sound design

Every sound is generated at runtime with Web Audio in `src/game/Audio.js`. The game ships no sample files and adds no dependencies. The sources are oscillators, four generated noise textures (white, pink, brown and a sparse "crackle"), one `PeriodicWave` and one generated underwater impulse response.

The guiding rule comes from the design doc (§2.4, "quiet screen, loud moments"). The bed stays low and dark. The whale's own body is always present but soft. Blows, lunges and breaches are the loud moments.

## Architecture

- **One `AudioContext`.** It is created on the first `pointerdown`, `keydown` or `touchend` (`main.js`), because browsers block autoplay. `?noaudio` disables sound. Without Web Audio, every method is a no-op. Any exception inside the audio layer disables sound and logs one warning. It never breaks the game.
- **Category × medium routing.** The categories are `amb`, `whale` and `life`. Each one has a `water`, an `air` and a `far` input. `whale.both` feeds both media, so the player's own sounds are dry in air and muffled and reverberant underwater.
  - **Water path:** low-pass at 2.6 kHz, closing to 1.4 kHz by 150 m depth, plus a 35 % send to a convolver. The convolver uses a generated 3.2 s IR with surface and seafloor early reflections, and a tail that darkens from 7 kHz to 500 Hz as it decays.
  - **Far path (distant life):** low-pass at 1.4 kHz, 0.25 dry, 1.1 into the same reverb. Distant animals are mostly reverb.
  - **Air path:** dry.
  - **Crossfade:** 50 ms on `world.isCameraUnderwater`. Above water, 5 % of the water path stays audible.
- **Post chain.** The media feed a `tunnel` low-pass (pause, low O2, blackout), then the `world` gain (pause duck). Two buses bypass the tunnel: `body` (heartbeat) and `ui`. Everything then goes to a limiter (−8 dB threshold, 12:1) and the master gain (volume² taper), then out.
- **Ducking.** During breach-apex slow-motion (`controller.timeScale` falls to 0.45), the ambience and life categories drop to 30 %. Pausing drops the world to 40 % behind a 1.4 kHz low-pass.
- **Continuous beds.** Four looping noise sources (plus a decorrelated pink copy for the air) fan out to 12 filtered beds, plus one oscillator. Beds are never created or destroyed. `update()` moves their gains and filters with `setTargetAtTime` at about 20 Hz and skips redundant automation.
- **One-shots.** One-shots are short node chains. A silent `ConstantSource` clock disconnects each voice when it ends. Voices are counted, and low-priority voices (gulls, filter bubbles) are dropped above 48.

## Hooks

| File | What |
|---|---|
| `src/game/Game.js` | 4 one-liners marked `// [audio]`: `_onWhaleEvent` → `audio.event(type, data)`; physiology event → `audio.event(ev)`; day card → `audio.event('daycard')`; `_loop` → `audio.update(rawDt, this)`. |
| `src/main.js` | Creates `GameAudio`, sets `game.audio`, calls `ui.attachAudio`, and unlocks on the first gesture. |
| `src/ui/UI.js` | `attachAudio()` wires the settings. Ticks on species change, a "tock" on warning prompts, soft ticks on pause open and close. |
| `index.html`, `src/styles.css` | Pause-screen row: **Sound · on/off**, a volume line, and **Heartbeat · full/soft** (reduced-audio option). The settings persist in `localStorage['krill.audio']` inside a try/catch. |

Everything else is read from game state in `update()`:

- fluke phase: `whale._phase`
- `controller.speed`, `thrust`, `state.turn`, `lungeTimer`, `_filter`, `_runup`, `mode`, `timeScale`
- `phys.o2`, `phys.blackout`
- `krill.totalEaten`
- `world.daylight`, `world.wind`, `world.swell`, `world.isCameraUnderwater`
- `terrain.heightAt` (water depth and height above the floor, sampled twice a second)

## The sounds

Levels are offline renders (dBFS, before the master gain). The centroid is the spectral centroid of the active part.

### Ambience

| Sound | Real reference | Recipe |
|---|---|---|
| Deep bed | Wenz-curve low-frequency ocean noise: distant shipping, seismic, surf | Brown noise → LP 90–200 Hz. The LP opens near the surface. Gain 0.16, lower at night and at depth. |
| Sea noise | Knudsen wind-driven noise, 0.3–5 kHz | Pink → BP 900 Hz. Scales with `world.wind.kts` and fades with depth (e^−d/80). |
| Surf through water | Breakers on the Monterey shore heard in the shallows | Pink → LP 600 Hz. A swell-period surge envelope (`world.swell.period`). Only in < 90 m of water, full in < 15 m. |
| Snapping shrimp | *Alpheus* crackle on rocky reefs (loudest biological noise in warm shallows) | Crackle texture (70 Poisson clicks/s, heavy-tailed amplitudes, 2.5–9 kHz ring) → HP 2.2 kHz. Rises in shallows and near the floor, +40 % at dusk and night. |
| Midshipman hum | Plainfin midshipman night chorus, about 95 Hz, in the bay's shallows | Saw 96 Hz → LP 380. Night × shallow only, very faint. |
| Wind (air) | Marine wind over open water | Pink → BP 300–1200 Hz. The BP centre and gain follow a smoothed random gust walk and wind knots. A narrow whistle band (Q 12) appears above 12 kt. |
| Swell wash (air) | Swell rolling past a floating body | Pink → LP 900. The same swell-phase envelope, plus a lagged crest hiss (white → BP 2.5 kHz) for breaking tops. |
| Gulls (air) | Western gull "kyow" long call | Saw with a pitch arch (0.75f → f → 0.6f, f = 620–900 Hz) → formants 1.7 and 2.9 kHz. 1–4 notes, panned and distance-filtered. Day only, above water, more often near the coast. Peak −26 dB. |

### The player whale

| Sound | Real reference | Recipe |
|---|---|---|
| Fluke stroke | Displacement "whoosh" of each fluke beat (Segre 2017: 6 strokes from rest to exit) | One per half-cycle of `whale._phase`, so it is synced to the animated tail. Pink → BP sweeping 0.6f → 1.2–1.7f → 0.5f, with f = 260 Hz/√(L/14). Length is 60 % of the stroke period. Gain follows thrust. Peak −16 dB, centroid about 480 Hz. |
| Run-up thump | Hard sprint strokes before a breach | The stroke plus a 62→30 Hz sine thump and a brown-noise body. The thumps speed up with the stroke rate as thrust rises to sprint. Centroid 73 Hz. |
| Water rush | Flow noise rising with speed | Pink → BP 170–690 Hz. Gain ∝ (v/8)^1.5. Heard from about 1 m/s. In the air it is replaced by an air rush (white → BP 1 kHz). |
| Body creak | Stick-slip groan of tissue under a hard bank | Saw 13–22 Hz, a wavering pulse train → two resonances (280–460 Hz, ×2.3). Plays when \|turn\| > 0.65 above 1 m/s, at most every 2.5–6 s. |
| Lunge rush | Drag spike as the mouth opens at speed (Goldbogen, rorqual lunge) | White → BP sweeping 180 → 1100 Hz over 1 s, plus a pink LP roar. Its length matches the 1.15 s lunge. |
| Engulfment gulp | Mouth closing on a body-mass of water | Plays when `lungeTimer` crosses zero. An 80→26 Hz sine thump, a brown-noise whomp, a 220→95 Hz bloop and 8 Minnaert bubbles. Peak about 0 dB, 92 % of energy below 120 Hz. |
| Krill fizz | Crustaceans crackling in the mouth | Crackle → HP 2.6 kHz, 0.4 s. Plays at most every 0.18 s while `totalEaten` rises. Centroid 9 kHz, quiet (−50 dB RMS). |
| Filtering | Water pressed out through the baleen | A brown-noise gurgle, BP 200–360 Hz Q 3, with a random-walk level. A faint 3.5 kHz sieve hiss. Random bubbles at 5/s. Runs while `controller._filter > 0` (rorquals only; sperm whales have none). |
| Blow: humpback | Bushy ~3 m spout, about 2 s | White → BP 750 Hz Q 0.55 with a 22 Hz turbulence flutter, plus a chest roar LP 260. The level decays over 1.9 s. Centroid about 1 kHz. |
| Blow: blue | 9 m column, deep long roar | 3.0 s. BP 420 Hz with a heavy brown-noise LP 170 body and 12 Hz flutter. Centroid about 210 Hz, 60 % of energy below 120 Hz. |
| Blow: sperm | Sharp, angled, single left nostril | 0.95 s. BP 1.5 kHz Q 0.9, 20 ms attack, 35 Hz flutter, little low end. Centroid about 2.5 kHz. |
| Inhale | The short gasp before the blowhole shuts | 0.15–0.3 s after the exhale. Softer, BP rising 1.1f → 1.6f, a Q 6 whistle band, rising level with a hard cut. Humpback 0.8 s, blue 1.2 s, sperm 0.55 s. |
| Heartbeat | Diving bradycardia (a blue whale's heart falls to 2 bpm; Goldbogen 2019) | Lub (50 Hz) and dub (60 Hz, +0.3 s), each a sine with a pitch drop plus a brown thump. Below 30 % O2 the period is 1.1 + (0.3 − O2)·2.5 s, so it slows as air runs out and matches the HUD pulse. In blackout it slows further, from 2.2 s up to 3.6 s. Body bus: clear while the world is tunnelled. "Heartbeat · soft" plays it at 30 %. |
| Blackout tunnel | Hypoxic tunnel hearing | Below 12 % O2 underwater the world low-pass closes toward 1.8 kHz. In blackout it closes to 360 Hz and the world drops to 60 %. |

### Breach (design doc §5.7)

1. **Run-up.** The stroke thumps speed up and the rush climbs. In the test log the master centroid rose from 500 to 1,200 Hz during the run-up.
2. **Exit** (`breach` event). A surface-break whoosh (white → BP 250 → 2200 Hz in 0.3 s) and a pink roar, then 2.8 s of sheeting water (pink HP 700) with droplet crackle.
3. **Air.** The camera crosses the surface, which plays a plunge-up drip. The world falls to near-silence: wind, swell and the fading cascade. Slow-motion ducks the ambience to 30 %. There is a single exhale 0.45 s after exit, with no inhale.
4. **Impact** (`splash` event). The level scales with impact speed × attitude, so a belly flop is softer.
   - **In air:** a 52→24 Hz boom, a brown-noise body, a 1.1 kHz crack, a 3.5 s spray hiss (HP 2.6 kHz) and falling droplets.
   - **Underwater:** a separate long low thud (34→17 Hz over 2.5 s, brown LP 100) and an entrained-air roar. The underwater reverb stretches the thud further.

### Surface crossing

When the camera crosses the surface, a plunge sound plays (at most every 0.35 s):

- **Going down:** pink noise with a low-pass sweeping 3.2 kHz → 320 Hz, a 95→40 Hz thump and 12 bubbles.
- **Coming up:** a bright 0.7 → 3.8 kHz shed and a few high drips.

The 50 ms medium crossfade does the rest.

### Distant life

All distant life plays on the far path.

- **Humpback song.** At dusk and night only. MBARI's MARS hydrophone records song in Monterey most autumn and winter nights. Phrases are 3–6 units from four themes.
  - **Unit types:**
    - **moan:** 110–260 Hz, drifting ±25 %
    - **whoop:** upsweep ×2.2–3.2
    - **cry:** 400–800 Hz, falling
    - **grunt:** 60–110 Hz, pulsed at 12–18 Hz
  - **Voice:** a saw + triangle source with 4–6.5 Hz vibrato, through two formants (350–600 Hz and 900–1,400 Hz) and a body LP.
  - **Spacing:** a phrase every (15–45 s)/night.
- **Blue whale A/B call.** Any time of day, every 70–170 s (70 % chance). The source is a `PeriodicWave` on a 16–17.5 Hz fundamental. The 3rd harmonic (about 48 Hz) is strongest, as in NE Pacific B-calls. Harmonics up to about 200 Hz keep it audible on laptop speakers.
  - **A call:** 7 s, pulsed at 1.5 Hz.
  - **B call:** 11 s, 3–6 s later, a tonal downsweep of −6 %.
  - Centroid about 60–67 Hz, 93 % of energy below 120 Hz. Mostly felt, as intended.
- **Ship.** Rare: every 3–7 min, 60 % chance, 55–90 s long. It is a diesel firing-rate drone (saw 8.5–11 Hz → LP 170) plus propeller cavitation (pink → BP 1.5 kHz) amplitude-modulated at blade rate. It fades in over 45 % of its length and has a small Doppler drop at closest approach. Design doc §4.7 says "engine noise is heard long before the hull is seen", which is why the approach is so long.

### UI

| Sound | Recipe |
|---|---|
| Tick (species change, volume set) | Sine 1.9 kHz → 1.5 kHz, 60 ms, −41 dB RMS |
| Tock (warning prompt, e.g. breach denied) | Triangle 420 Hz, 100 ms |
| Pause open / close | Sine 900 Hz down / 1.2 kHz up |
| Day card | Two soft bells a fifth apart (C5, G5), partials 1 / 2 / 2.76 / 5.4, decays up to 2.8 s |

## Verification

Run `PT_GPU=1 node tools/playtest.mjs humpback audio`. The harness can't listen, so it checks the sound structurally:

1. It unlocks the context through a CDP `userGesture` evaluation.
2. It renders every recipe in an `OfflineAudioContext` and reports peak and RMS, onset, active length, spectral centroid and the share of energy below 120 Hz (`GameAudio.renderOffline`, `renderAll`).
3. It renders the whole live graph offline for 10 s with every bed and a busy set of one-shots, as a CPU benchmark (`GameAudio.benchmark`).
4. It plays the game with a 100 ms log of master, water, air and body RMS, spectral centroid and voices (`startLog` / `stopLog`). The phases are: idle, swim, turn, lunge, low O2, blackout → blows, breach, night song, blue call, ship, a shallow reef at night, pause and mute. It writes `.playtest/<species>-audio-log.json` and prints a per-phase summary with the events that fired.

`node tools/playtest.mjs humpback noaudio` deletes `AudioContext` before the page loads. It plays and pauses, and checks for no errors and a "Sound · unavailable" control.

`krill.audio.debug()` (with `?test` or `?autostart`) returns:

- context state
- one-shot count, loop sources and loop voices
- per-bus levels in dB
- master centroid and tunnel cutoff
- every bed gain
- main-thread `updateMs`
- the last 12 events

## CPU

- **Live graph:** 5 loop sources (4 noise + 1 decorrelated pink) plus 1 oscillator feed 13 beds, about 40 persistent nodes and one 3.2 s stereo convolver. A busy moment adds about 10–16 one-shots.
- **Offline benchmark:** the full graph renders at about 15× real time on the dev machine, about 7 % of one core (Chrome also moves long convolutions off the render thread).
- **Main thread:** `update()` costs about 0.02–0.04 ms per frame.
- **Muted or hidden:** the context is suspended while muted and while the tab is hidden.

## Known gaps

- Sounds are not positional. The player's whale is non-spatial, since the camera follows it. Distant life uses random stereo pan, not world positions. The ship does not exist in the world, so it can't yet mask calls or warn of a strike (design doc §4.7).
- There is no sperm-whale click or creak yet. That comes with the squid loop (design doc §4.3). The sperm blow exists.
- There are no pod or AI responses (whales breaching back or calling back).
- There is no bubble-net sound (the feature doesn't exist yet).
- Song themes are random, not an evolving seasonal song.
- The mix was levelled by metering only (offline renders and the live log). Nobody has listened to it yet. It needs tuning by ear on headphones, laptop speakers and a subwoofer. The blue call and the impact thud are deliberately sub-heavy.
