# Playtest 2: critic re-review of `feat/realism-pass`

Date: 2026-09-27 · Build: `5932c81` (merges bathymetry fix, terrain round 2, day/night + Monterey water, creatures, swarm VFX, gameplay fixes and UI round 2)
Method: 16 runs of `tools/playtest.mjs` with `PT_GPU=1` (real GPU, about 15–16 fps headless at 1280×720), plus scripted `steps` runs and offline re-checks of the bathymetry assets with the same scripts as round 1. Screenshots are in `.playtest/critic2/<run>/`. The round-1 issue numbers refer to `docs/review/PLAYTEST_1.md`.

---

## Verdict

This is a real step change. The build now has moments that clear the Blue Planet bar:
- a bioluminescent krill swarm at night, parting around a dark whale (`swarm/humpback-night-swarm-lunge.png`)
- the blue whale's silhouette from below against Snell's window (`models/blue-model-below.png`)
- a close humpback with scalloped white flippers and a knobbly back (`outline/humpback-dist-0.7L.png`)
- a breach with a real plume, crown and foam (`breach/humpback-breach-splash-3.png`)

The bathymetry is now correct, which I checked independently.

The **core loop is now legible**: the first-dive hint, the "Krill ahead · 38 m" cue, an amber O2 arc with a number, a blackout prompt that shows above the veil, a ~30 s surface interval and a day card. **It is not yet fun**, for three reasons:
1. **One lunge fills the stomach and the Surge.** A single scripted lunge took 290 krill (580 kg), so the forage phase collapses to one move.
2. **By day the swarm is still found by the HUD, not by eye.** Beyond about 15 m it doesn't read.
3. **The new Monterey water swallows the whale at the default follow distance.** Blues and mid-distance whales become flat cut-outs, with a dotted halo from the light-shaft pass.

The coastline is now the ugliest place in the game: flat-shaded pink boulders on white dunes, visible terrain skirts, and kelp that looks like bamboo.

---

## 1. Re-score of every PLAYTEST_1 issue

Legend: **fixed** · **improved** (better, not done) · **not fixed** · **regressed**

| # | R1 issue | Status | Evidence (round 2) |
|---|---|---|---|
| 1 | Bathymetry N–S squash, seam cliffs, levels disagree | **fixed** | Offline re-check with the round-1 scripts:<br>• all 24 sampled L0 N–S seams are **0.0 m** (were 7–552 m)<br>• L0 tiles match the bay grid in place (mean error 0.7–5 m, offsets 0.00)<br>• Santa Cruz wharf: L0 −9 / bay −10 / region −7 (bay was +105)<br>• Moss Landing: 1 / −1 / −4 |
| 2 | Krill swarm invisible, can't hunt | **improved** | • ≤ 14 m by day: individual krill specks read (`swarm/humpback-swarm-approach-14m.png`)<br>• Night: glorious (`swarm/humpback-night-swarm-20m.png`, `night-swarm-lunge.png`)<br>• 28–50 m by day: only a faint dark ghost (`swarm-approach-28m.png`, `-50m.png`, `swarm-side-40m.png`)<br>• The HUD prey cue now does the finding (see N3) |
| 3 | Sperm whale is a rorqual clone | **improved** | • Box head, blunt profile, wrinkled back and dorsal hump now present (`models/sperm-model-front34.png`)<br>• Still eats krill: no diet gate in `KrillManager`/`Game` |
| 4 | Toy-aircraft appendages, no pleats | **fixed** | Scalloped humpback flipper with a white leading edge, knobbly dorsal hump, throat pleats and a proper notched fluke from below (`outline/humpback-dist-0.7L.png`, `breach/humpback-breach-air-0.png`, `models/blue-model-below.png`) |
| 5 | Night never rendered | **fixed** | `tod/*`: dawn is pink-lavender, golden hour is warm, night is navy sky over near-black water. The underwater light falls to 0.009 at night (`humpback-tod-night-under.png`) |
| 6 | Filter phase never triggers | **fixed** | The scripted lunge logged `filter: 2.75 → 1.65` after the mouth closed (`swarm` run) |
| 7 | Tropical water, featureless floor | **improved** | • Monterey green water throughout<br>• The 76 m shelf now has sand ripples and scattered rocks (`floor/humpback-shelf-76m-lit.png`)<br>• But visibility is now so short that it hides the whale (N2) |
| 8 | Popcorn splash | **improved** | • Plume, crown curtain, whitewater and foam ring now present (`breach/humpback-breach-splash-3.png`)<br>• Near camera, the spray is still big soft white discs (`splash-5.png`)<br>• The sheeting runoff reads as white polka dots on the body (`air-1.png`, `air-2.png`) |
| 9 | Patches never deplete, no day end | **fixed** | • Regrow is 12 game h, i.e. 1.25 krill/s, below the 4.7/s max intake<br>• The day card works: "Underweight — migration odds poor" → "Next day" advances to `day 2` (`daycard/humpback-daycard.png`)<br>• New balance problem in N1 |
| 10 | Surface interval trivial, deep breath worse | **fixed** | • Blows now give +12 % every 3.5 s, so 0 → 100 % takes about 29 s<br>• Deep breath gives +24 % every 5 s: 0.048/s vs 0.034/s, so it's now better<br>• Bob-farming is guarded (`_sinceSurface > 4`)<br>• Blackout recovery logged cleanly (`breathe` run) |
| 11 | Submerged whale glows from above; waterline seam | **improved** (partial evidence) | • The submerged body under the breach splash is no longer glassy cyan (`breach/humpback-breach-splash-3.png`)<br>• The shaft shader now draws a meniscus<br>• I did not re-shoot the `above-waterline` view |
| 12 | Onboarding: air and food not taught; O2 arc faint; blackout text hidden | **fixed** | • Hints now say "dive to about 55 m" and "Air running low — surface to breathe ↑"<br>• The amber arc shows "O₂ 18 %"<br>• The blackout text sits above the veil<br>(all in `onboard/humpback-onboard-1…6.png`) |
| 13 | Krill = 93 % of triangles | **fixed** (by design) | Krill are now a density volume, specks and impostors (`SwarmRender.js`), with no per-krill spheres. The headless GPU ran at 15–16 fps; that needs a real-browser measure (N12) |
| 14 | Fish 1.65 m, 70 per school | **fixed** | 70 boids × 24 = 1,680 fish per school at 0.15 m (`FishSchoolView`). At 22 m the bait ball reads as a faint ring of specks (`swarm/humpback-baitball-22m.png`) |
| 15 | Krill 18 cm and sparse up close | **fixed** | Impostors are 4.5 cm (`uLen 0.045`), about 2× *E. pacifica*, which is acceptable |
| 16 | Launch q always 1; O2 drains airborne; READY during blackout | **fixed** | • Run-up accelerates 2.4 → 9.9 m/s over about 27 m (`breach` log), so q now depends on depth<br>• `airborne` skips physiology<br>• `breachReady` is gated on `!blackout` |
| 17 | Flat sea, lavender sky | **fixed** | Swell, sky gradient, clouds and a warm sun tint (`tod/humpback-tod-golden-above.png`, `breach/*`) |
| 18 | Snell's window torn-paper | **improved** | A bright, soft window with a ripple-broken rim (`tod/humpback-tod-noon-up.png`). The edge is still blotchy dark patches rather than a crisp ~97° circle |
| 19 | Fin edges glow cyan in the dark | **not fixed** | Flipper tips are still bright cyan at 44–57 m (`onboard/humpback-onboard-4-patch.png`, `feed/humpback-feed.png`, `swarm/humpback-swarm-approach-50m.png`) |
| 20 | Beat too fast; rigid flippers | **improved** (code only) | "Real beat rates" and flipper sculling were merged (`Whale.js` ~L1050). Not judged in motion this round |
| 21 | No await on terrain; camera NaN; harness | **fixed** | `start()` awaits `terrain.ready`, there is a NaN guard in `_updateCamera`, and `hud` uses `floorAt` |
| 22 | Blue 24 m vs 22 m; no pause map; stats line | **fixed** | • Blue is now 24 m in `species.js`<br>• The pause screen has a contour map with POIs and the player arrow (`pause/humpback-pause.png`)<br>• "Nothing eaten yet — the day has just begun" |

**Counts (22 issues):** fixed **14** · improved **7** · not fixed **1** · regressed **0**. Water visibility (#7) is improved in colour, but it caused the new N2.

---

## 2. New issues (ranked)

| # | Sev | Area | What's wrong | Evidence | Suggested fix | Likely owner |
|---|---|---|---|---|---|---|
| N1 | **blocker** (fun) | Economy | **One lunge ends the forage phase.**<br>• A single lunge into a patch took **290 krill = 580 kg**: 88 in the first 0.9 s, 290 by 1.8 s.<br>• Stomach is 420 krill, so one lunge fills about 70 % and a second triggers "Stomach full" and a 90 s digest.<br>• Surge: 290 × 1.5 / 150 is about 2.9, so **breach-ready after one lunge**.<br>• Condition gains about +5.8 per lunge.<br>• Cruising closed-mouth through a patch also takes 92 krill in about 3 s (`feed`).<br>• Real humpback lunges take tens to low hundreds of kg.<br>• The design wants 2–6 lunges per dive and about 3 dives per breach | `swarm` run log (`eaten: 88 → 290`); `feed` run log (`eaten: 7 → 92` with no lunge) | Tie yield to engulfed volume × local density with a cap (e.g. humpback 25–60 krill per lunge at 2 kg). Make passive cruising intake near zero, since rorquals don't graze with the mouth shut. Re-derive `breachKrill` so that surge fills in about 3 dives | `KrillManager.js` (mouth radius/feeding loop), `species.js`, `Tuning.js` |
| N2 | **major** | Water / camera | **The whale dissolves at the default follow distance.**<br>• The follow camera is 1.1 L, i.e. 15.6 m for a humpback and 26 m for a blue.<br>• At 1.3 L the humpback is a flat, washed silhouette; at 2 L it's a ghost.<br>• At that range the blue is barely there (`models/blue-model-side.png`).<br>• The menu hero whale has lost all internal shading (`menu/humpback-menu.png` vs round 1's, `menu-next.png` blue).<br>• Real 10–15 m Monterey visibility still shows form and shading on a whale at 15 m, because contrast falls off smoothly and doesn't flatten | `outline/humpback-dist-0.7L.png` → `dist-1.3L.png` → `dist-2.0L.png`; `tod/humpback-tod-noon-under.png` | • Lower the in-scatter/extinction in the shaft pass for the near field, or make veil strength depend on the target's distance, not the 90 m march.<br>• Set camera distance per species as a fraction of visibility.<br>• Give the menu its own clearer "hero" water preset | `Effects.js` (`ShaftShader`), `WaterMedium.js`, `Tuning.js` (`cameraDist`), `Game.js` preview |
| N3 | **major** | Swarm visibility (day) | A patch at 28–50 m reads only as a faint darker smudge, so players steer by the "Krill ahead · 38 m" text rather than by eye. That contradicts pillar 4 ("the HUD confirms what the world already tells you"). Real daytime krill aggregations read as a dense brown-grey cloud or wall with a sharp edge, often backlit from below | `swarm/humpback-swarm-approach-28m.png`, `-50m.png`, `swarm-side-40m.png`; `onboard/humpback-onboard-4-patch.png` | Raise the volume's optical density and extinction (darker, browner core), add a crisp density edge and forward-scatter rim when backlit, and draw specks further out (currently `dc < 75`). Make the prey cue appear only after the swarm has been out of view for a while | `SwarmRender.js`, `UI.js` |
| N4 | **major** | Post / artifact | A **dotted "cut-out" halo traces every whale silhouette** at mid distance. It persists with FXAA off and comes from the shaft ray-march: per-pixel IGN jitter across the depth discontinuity with 16 samples and no temporal filter. The same pass shows a screen-wide **diamond "fishnet" lattice** in open water (visible in the menu) | `outline/humpback-dist-2.0L.png`, `dist-2.0L-nofxaa.png`, `menu/humpback-menu.png`, `onboard/humpback-onboard-0-swim.png` (right half), `tod/humpback-tod-golden-under.png` | Depth-aware bilateral blur or TAA on the shaft result. Clamp the march to the nearest depth in a 3×3 neighbourhood at edges. Break the noise-texture tiling (rotate the octaves, add a third octave) | `Effects.js` (`ShaftShader`, `beam()`), `textures.js` |
| N5 | **major** | Coast | **The coastline breaks the illusion.**<br>• Land renders as white dunes.<br>• Reef rocks are untextured flat-shaded polyhedra in saturated pink, orange and grey, and some sit on dry sand above the waterline.<br>• A vertical striped "curtain" (the chunk skirts) shows along the shore at the waterline.<br>These are all visible whenever the whale surfaces near Cannery Row, Pacific Grove or Santa Cruz | `floor/humpback-kelp-canneryrow.png`, `floor/humpback-kelp-canneryrow-side.png`, `floor/humpback-kelp-santacruz.png` | • Skip rocks where the local height is above −0.5 m.<br>• Give rocks a rock albedo/normal texture and muted colours; pink coralline only below −3 m, as a tint.<br>• Clip skirts below the water or hide them above sea level.<br>• Land material: dark cliffs, cypress-green and grey granite, not snow-white sand | `Flora.js`, `Terrain.js` (land material, skirts) |
| N6 | **major** | Kelp | Giant kelp reads as **bamboo or wheat**: thin straight green stalks with dagger leaves, about 1 plant per 40 m², no surface canopy, and near-camera blades as flat yellow ribbons. Real *Macrocystis* is olive-to-golden-brown, has wide wrinkled blades on every stipe with gas bladders, and forms a dense mat at the surface, which is the defining look from below | `kelp2/humpback-kelp-follow.png`, `kelp-lowangle.png`, `kelp-wide.png` | Build fronds as ribbon strips with many broad blades and pneumatocysts. Add a canopy layer (flattened blades spread 2–5 m at y ≈ −0.3), golden-brown translucent shading, and sway from the swell. Increase density to 1 per 10–25 m² on reef | `Flora.js` |
| N7 | minor | HUD discipline | The first-dive hint stays up after reaching depth ("dive to about 55 m" shown at 57 m) and during the breach. The prey-cue arc is outside `#hud`, so it stays visible airborne and in hidden-HUD captures. Design §6.3 says all HUD fades to 0 when airborne | `feed/humpback-feed.png`, `breach/humpback-breach-air-0.png`, `breach-splash-3.png`, `outline/*` (arc visible with the HUD hidden) | Dismiss the depth hint on reaching `krillY ± 10 m`. Put the prey cue inside `#hud` and respect `hud.airborne` | `UI.js`, `index.html`, `styles.css` |
| N8 | minor | Sperm | Still eats krill with a rorqual mouth-radius model (§4.9 cut list); the menu says squid | `KrillManager.update` (no species gate); `species.js` sperm | Until squid exist, give sperm a "deep scattering layer" prey placeholder, or disable krill intake and show "squid hunting coming soon" on the card | `KrillManager.js`, `Game.js` |
| N9 | minor | Breath | After a blackout recovery, the idle whale sinks back out of the 0.6 m `atSurface` band (y −1.3 → −1.7 vs threshold −1.72) because the default aim pitch is −0.08. Idle breathing can stop part-way | `breathe` run log | Lie level at the surface when idle (as the `forceClimb` branch does), or widen the band to about 1 m | `PlayerController.js` |
| N10 | minor | Day card | The day ends at 24 game h from the start, so the card appears at 09:00 the next morning and can interrupt mid-dive or mid-air (design §5.8 says defer while airborne) | `daycard` run (card timestamp 09:00); `Game._checkDayEnd` | End the day at dusk or when the player next surfaces after dusk, and defer while `mode === 'air'` or under 10 m below the surface | `Game.js` |
| N11 | minor | Snell's window / canyon | • From 280 m on the canyon rim, looking down, the canyon is pure black (`floor/humpback-canyon-start-lookdown.png`). That's realistic, but the game's signature place is never seen.<br>• The window's rim is still blotchy | `floor/humpback-canyon-start-lookdown.png`, `tod/humpback-tod-noon-up.png` | Show the canyon from the shallow rim by day. A spawn with the drop-off in view at 30–40 m could give a subtle silhouette of the wall against the lighter water | `Terrain.js`, `regions.json` start |
| N12 | minor (verify) | Performance | The real GPU in headless Chrome gave 15–16 fps at 1280×720 in every GPU run | `fps` line in every `PT_GPU=1` run | Profile in a real browser (volume slices, shaft march of 16 taps, impostor overdraw). This may be headless throttling | `SwarmRender.js`, `Effects.js` |
| N13 | polish | Pause map | The "Monterey Canyon" label overprints "Southern Monterey Bay shelf". A heavy coastline stroke crosses Moss Landing | `pause/humpback-pause.png` | Label collision pass, and render the coastline at hairline weight | `PauseMap.js` |

---

## 3. Blue Planet bar and the core loop

**Visuals:**
- **At the bar:** night bioluminescence, whales from below against the window, close whale anatomy, and time-of-day skies.
- **Near it:** the breach and splash, and the shelf floor.
- **Below it:** the mid-distance whale (flat cut-out plus dotted halo), the daytime swarm, the coast and the kelp.

The biggest remaining gap is *legibility of form at 15–30 m*, which is where the camera lives.

**Loop:**

| Step | Legible? | Fun? |
|---|---|---|
| Breathe | Yes: blows, the amber arc, a 30 s interval, deep breath is worth it | Fine, a calm beat now |
| Dive | Yes: the "55 m" hint | Fine (13–15 s) |
| Find krill | Via the HUD cue, not the eye | Weak (N3) |
| Lunge | Yes, and the filter works | **Broken: one lunge = full stomach and full Surge** (N1) |
| Ascend | Yes: the air prompt | OK |
| Breach | Yes: the run-up now needs depth, and 82 % clear with a 138° twist feels great | Great, but earned too cheaply (N1) |
| Day card | Yes, and it looks good | Arrives at an odd time (N10) |

Verdict on the loop: legible end to end for the first time, and not yet fun, because the forage phase has no decisions. Fix N1 and N3 and it should be.

---

## 4. Next 5 highest-value moves

1. **Rebalance the lunge economy (N1).** Aim for about 25–60 krill per humpback lunge, no passive intake, the stomach full after 4–6 good lunges, and the surge after about 3 dives. It's a one-file tuning change with the biggest effect on fun.
2. **Clean the water veil (N2, N4).** Fix the shaft-pass depth-edge halo and fishnet tiling, then retune near-field extinction and per-species camera distance so a whale at the follow camera keeps its shading. The menu hero shot should look as good as round 1's did.
3. **Make the daytime swarm the thing you see (N3).** A dense, brown, sharp-edged cloud readable at 30–50 m, backlit from below, with specks drawn further out. Then the prey cue can retreat to a fallback.
4. **A coast and kelp pass (N5, N6).** Canopy-forming golden kelp, textured rocks only underwater, a hidden skirt curtain and a real land material. This makes the shallow Monterey postcard (Cannery Row) shippable.
5. **HUD discipline and small loop fixes (N7, N9, N10, N8, #19).** Hints dismiss on success, the cue lives in `#hud` and fades airborne, the whale stays level at the surface, the day ends at dusk, sperm diet is gated, and fin edges stop glowing at depth.
