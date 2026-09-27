# Playtest 3: critic re-review of `feat/realism-pass`

Date: 2026-09-27 · Build: `d8d1da8` (loop fixes, rendering round 3, swarm round 2 + fix, terrain round 3: coast and kelp)

**Method:** 13 runs with `PT_GPU=1`: `coast`, `readability` ×2, `breach --view side`, `daycard`, plus scripted `steps` runs.
- **Full dive cycle:** a scripted input bot drove two complete dive cycles through the real input path at the real lunge economy (dive → find patch → lunge until O2 or stomach runs out → ascend → breach → breathe → repeat). It changed only aim and keys, not game state.
- **Layer isolation:** separate runs toggled scene layers to find the source of the coastline puffs and the kelp stripes.

Screenshots are in `.playtest/critic3/<run>/`.

---

## Verdict

**Visuals:** several shots now sit at the Blue Planet bar:
- the humpback and blue at 20 m in green Monterey water: readable form, pleats and mottled skin (`read/humpback-read-side-20m.png`, `read/blue-read-side-20m.png`)
- the ascent into Snell's window (`cycle/humpback-cyc-ascend.png`)
- the inside of a kelp forest (`coast/humpback-coast-kelp-inside.png`)
- the night bioluminescence

What still breaks the illusion:
- a hard **Voronoi "crackle-glaze" caustic net** on shallow sand and on whale backs
- daytime swarms that read as **green smoke** rather than krill
- **krill swarm volumes floating over the beach**: these are the "tan puffs"
- **mid-distance kelp** rendered as identical bottle-brush columns
- a still cotton-ball airborne splash

**Loop:** it now runs end to end with no scaffolding. A full cycle takes about 80 s of game time: dive about 20 s, 4–5 lunges, ascend, breach, about 25 s of blows, then dive again. The day card appears on the next breath after 24 h. It is **pleasant and legible, but not yet fun**, because there is no skill gradient:
- every lunge into a patch hits the 70-krill cap
- the ×1.5 bonus fires on every lunge, so the Surge fills and you breach **every** dive
- the stomach never binds (peak 0.68)
- the prey cue makes finding a patch trivial

There are no decisions yet, only a rhythm.

---

## 1. Re-score of open items

Legend: **fixed** · **improved** · **not fixed** · **regressed** · *not re-tested*

| Item | Status | Evidence (round 3) |
|---|---|---|
| N1 One lunge ends forage | **improved** | Bot log, dive 1: lunges 1–5 took **70 each** (140 → 280 → 350). No intake while cruising (the total stays flat between lunges). Stomach peaked at 0.68. The economy is sane now, but see NEW-3: every lunge maxes out and the Surge fills every dive |
| N2 Whale dissolves at follow distance | **fixed** | Form, pleats, flipper and fluke read at 20 m. At 55 m the silhouette is clean (`read/humpback-read-side-20m.png`, `read/humpback-read-follow-55m.png`); blue mottling reads (`read/blue-read-side-20m.png`) |
| N3 Day swarm not visible by eye | **improved** | Now visible: at 42 m a lit disc behind the whale (`cycle/humpback-cyc-hunt.png`), and a cloud at 30 m (`misc/humpback-day-swarm-30m.png`, `misc/humpback-day-lunge-side.png`). But it reads as **green smoke or algae**, not rust/brown krill (NEW-5) |
| N4 Dotted halo, fishnet lattice | **fixed** | No silhouette halo in any `read/*` shot, and no lattice in open water |
| N5 Coast breaks illusion | **improved** | Grey, seated, textured boulders; the pink polyhedra are gone; scrub-green bluffs; the skirt curtain is gone (`coast/humpback-coast-pinos-above.png`, `beach-above.png`). New: krill puffs on land (NEW-1), and surf/foam bands drawn on dry sand (NEW-10) |
| N6 Kelp looks like bamboo | **improved** | The forest interior and surface canopy mats are now convincing (`coast/humpback-coast-kelp-inside.png`, `kelp-below.png`, `kelp-above.png`). Remaining: mid-distance stripes, stripy blades, and straight bamboo-like stipes (NEW-4) |
| N7 HUD discipline | **improved** | The depth hint now clears at the layer (bot log: the hint changed at 16–25 m). New context errors, NEW-8:<br>• the surface-only breath hint shows mid-dive<br>• a breach-window reason nags at 70 m<br>• the prey-cue arc still draws in hidden-HUD captures (`read/*`) |
| N8 Sperm eats krill | **not fixed** | No diet gate. See move 5 |
| N9 Idle whale sinks after blackout | **fixed** | Bot surface phase with no input: y holds at −1, and O2 refills 0.04 → 1.0 in about 25 s |
| N10 Day card mid-dive | **fixed** | At 14 m: prompt "The day is done — surface to rest", no card. At the surface: card "Day 1 at sea · Underweight" (`end/humpback-daycard-surface.png`). Caveat in NEW-8: the prompt fades out after about 3 s |
| N11 Canyon black from the rim | *not re-tested* | — |
| N12 Perf 15–16 fps headless | **not fixed / unverified** | In the kelp forest: 68.5 ms per frame with everything, 68.5 ms without flora, 64.1 ms without terrain (`coast` log). Frame time doesn't track scene load, so this is likely a headless cap. It needs a real-browser profile |
| N13 Pause map labels | *not re-tested* | — |
| #19 Fin edges glow at depth | **improved** | At 50 m the flipper's white underside still lifts blue (`read/humpback-read-fins-50m.png`). That's plausible, since real white pectorals read ghostly at depth, but the scalloped edge is still brightest |
| R1 #3 Sperm anatomy | **improved** | The box head reads (`models/sperm-model-side.png`); the diet is still wrong (N8) |
| R1 #7 Water, floor | **improved** | Monterey green, rippled sand and rocks; blocked by the caustic net (NEW-2) |
| R1 #8 Splash | **improved** | Plume, crown and foam are there. In the air, a white cotton-ball cluster surrounds the body (`breach/humpback-breach-air-1.png`) |
| R1 #11 Surface from above | **fixed** | The whale at the surface reads correctly (`cycle/humpback-cyc-dive.png`), with no glassy glow |
| R1 #18 Snell's window | **fixed** | A crisp bright window with a ripple-broken rim (`cycle/humpback-cyc-ascend.png`) |
| R1 #20 Swim beat | *not re-tested in motion* | — |

**Counts (20 items):** fixed **6** · improved **9** · not fixed **2** · regressed **0** · not re-tested **3**.

---

## 2. New issues (ranked)

| # | Sev | Area | What's wrong | Evidence | Fix | Owner |
|---|---|---|---|---|---|---|
| NEW-1 | **major** | Krill placement | **The tan "puffs" at the coast are krill swarm volumes over land.** Terrain was correct to say they aren't terrain.<br>• Looking from the Santa Cruz shallows: krill homes at y = **+6 to +13** over floors at **+1.7 to +4.6** (dry beach).<br>• Hiding the four `KrillSwarmView`s removes every puff.<br>• Cause 1: `KrillManager.update` clamps `homeCenter.y = max(y, heightAt + 8)` with no sea-level cap.<br>• Cause 2: `_recycle` → `_pickSite` still returns a shallow or land site when no candidate in the 180–420 m ring is deep, and the home drift (about 1.2 m/s) walks patches ashore.<br>• The same fault puts patches into 12–16 m kelp water (*E. pacifica* live off the shelf; `misc/humpback-day-swarm-30m.png`) | `puff/humpback-puff2-0-lookat-krill.png` vs `puff2-1-nokrill.png`; `coast/humpback-coast-kelp-above.png` (horizon); `pinos-above.png` (right) | • Reject sites with water < 45 m. If none are found, keep the patch or pick a site toward deeper water.<br>• Cap `homeCenter.y ≤ min(−6, floor + …)`.<br>• Dissolve and recycle a patch whose local water depth drops below about 25 m.<br>• Clamp the drift so it stays in water deeper than 45 m | `KrillManager.js` (`update` ~L219, `_pickSite`, `_recycle`) |
| NEW-2 | **major** | Caustics | **A hard Voronoi net ("crackle glaze", giraffe pattern)** on shallow sand and on whale and sperm backs at 8–16 m. Every cell is the same size and the lines are razor-thin polygons with straight edges. Real caustics are curved, braided, soft-edged filaments with rounded cells that blur with depth.<br>Cause: `kwCaustics` in `WaterMedium.js` uses F2−F1 cell edges with a Gaussian width of only `w = 0.07 + 0.005·depth` cell units. Two layers at a fixed scale. There's no screen-space filtering, so it also aliases at distance | `coast/humpback-coast-reef-25m.png`, `coast/humpback-coast-pinos-under.png`, `puff/humpback-puff-0-all.png`, `misc/humpback-day-lunge-side.png` (on the whale), `models/sperm-model-side.png` | • Domain-warp `q` with low-frequency noise before the cell lookup, so filaments curve.<br>• Widen `w` in the shallows (0.15–0.25) and lower the peak cap.<br>• Fade contrast with `fwidth(q)` (screen-space AA).<br>• Or bake a tileable caustic texture, sample it twice at different scales with a slight RGB offset, and take the min |
| NEW-3 | **major** (fun) | Loop balance | **The Surge fills every dive, and lunges have no skill gradient.**<br>• A full lunge always hits the `lungeKrill` 70 cap inside a patch.<br>• The ≥ 40-per-lunge ×1.5 bonus triggers on **every** lunge (70 ≥ 40), so each lunge gives 105/300 of a Surge.<br>• Bot: Surge full after 4 lunges in dive 1 **and** in dive 2, so a breach every dive. The design says about 3 dives per breach.<br>• The stomach peaks at 0.68, so it never matters.<br>• Condition rises about 4 per cycle, reaching the 80 target in about 10 dives, around 13 minutes into a 40-minute day | Bot log (`cycle` run): `eaten 140/280/350`, `surge 0.7 → 1.0` in dive 1; `420/560/700`, `0.3 → 0.93 → 1.0` in dive 2 | • Base yield on local krill density × mouth sweep × approach angle (from below or steep = more). Only a great lunge should hit the cap.<br>• Make the bonus relative, e.g. ≥ 90 % of cap from a steep upward approach, or drop it.<br>• `breachKrill` to about 600 so a breach takes about 3 dives.<br>• Stomach about 250 so a full stomach forces a digest/rest beat.<br>• Put the Condition target at dusk for a good player | `Game.js` (`_updateSurge`), `KrillManager.js`, `species.js` |
| NEW-4 | **major** | Kelp LOD | **The "vertical stripes" at mid distance are the far-LOD cards.** Isolating the layer (`lods[1]` only) shows every plant from 22–90 m as the **same painted silhouette**. The cards are all at nearly the same `ry` (all blades stream with one current), so they line up into identical serrated bottle-brush columns. There's a hard switch at 22 m and no crossfade.<br>Separately, near blades show fine parallel "corduroy" lines (the ruffle lines in the blade texture shimmer), and the stipes are dead-straight poles | `misc/humpback-kelp-mid-all.png`, `misc/humpback-kelp-mid-cardsonly.png`, `coast/humpback-coast-kelp-below.png`, `pinos-under.png` | • 3–4 card texture variants; randomise `ry` per instance and apply the current as a shader bend.<br>• Dithered crossfade over 18–26 m.<br>• Mipmaps or anisotropy on the blade texture, with softer ruffle lines.<br>• Curve the stipes and let them lean with the surge | `Flora.js` (`makePlantTexture`, `_genKelp`, LOD bands, blade texture) |
| NEW-5 | **major** | Swarm look | **The daytime patch reads as green smoke.**<br>• At 30 m it's a soft glowing green-grey fog bank next to the whale; at 42 m a lit green disc.<br>• There's no rust or pink pigment and no particulate texture at mid range.<br>• The "lit skin" makes it glow rather than absorb.<br>Real day swarms read as a dark brown-rust mass (red pigment absorbs the green light) with shimmering specks at the edge | `misc/humpback-day-swarm-30m.png`, `misc/humpback-day-lunge-side.png`, `cycle/humpback-cyc-hunt.png` | • Absorptive rust core (low single-scatter albedo in green), with the lit skin only on the sun-facing rim.<br>• Carry the specks out to about 40 m so the body looks granular.<br>• Add a subtle glint shimmer | `SwarmRender.js` |
| NEW-6 | minor | Night | At 55 m at night the frame is **pure black**: the whale isn't visible, and the patch shows only while the lunge disturbs it. The photophore flashes render as **square pixels**. DVM rises slowly (the patch was still at 55 m with the layer at 14 m), so a player who dives at dusk finds black water | `end/humpback-night-swarm.png`, `end/humpback-night-lunge.png` | • A moonlit silhouette floor from above.<br>• Bioluminescent (dinoflagellate) wake sparks outlining the moving body and flukes.<br>• Round, soft photophore sprites.<br>• Faster DVM when the clock is compressed | `SwarmRender.js`, `WaterMedium.js`, `Splash.js` |
| NEW-7 | minor | Loop pacing | Once Condition reaches the target (about 13 minutes in), the rest of the 40-minute day has no goal. The card only appears after 24 game hours | Bot Condition 40 → 47.8 in 2 cycles; `Physiology.js`, `Game._checkDayEnd` | Offer to end the day once the target is reached, or make dusk the "last feeding" beat | `Game.js` |
| NEW-8 | minor | HUD context | • "Each blow refills your air · hold **Space** at the surface…" shows at 25–44 m **during the dive**.<br>• The breach-window reason "too deep · rise toward the surface" appears unprompted while hunting at 70 m.<br>• "The day is done — surface to rest" fades to opacity 0 after about 3 s, so a player at depth loses it.<br>• The prey cue said "Krill **behind** you · 70 m" while the whale was diving straight at the nearest patch (steep pitch, heading ambiguous).<br>• The prey-cue arc still draws when `#hud` is hidden | `cycle/humpback-cyc-patch.png`, bot log t = 10–13 and t = 37–47, `end` run log (`op: "0"`), `read/*` | • Show the breath hint only when `atSurface`.<br>• Show window reasons only on an F press.<br>• Keep the day-over prompt as a persistent quiet line.<br>• Compute the cue in 3D camera space and use the same "nearest patch" as the hint.<br>• Parent the arc to `#hud` | `UI.js`, `index.html` |
| NEW-9 | minor | Coast material | White surf/foam bands are drawn on **dry sand** above the waterline, and the land behind Point Pinos is a flat grey plateau with puddles | `coast/humpback-coast-pinos-above.png` | Mask surf to `h ∈ [−1.5, +0.3]`, and give the land more slope detail | `Terrain.js` (coast shader) |
| NEW-10 | minor | Breach look | The airborne humpback reads piebald (a large bright white belly with black blotches) and small in the side witness shot. The splash around it is a cluster of white cotton balls | `breach/humpback-breach-air-1.png` | Reduce the white area and exposure in air light. Streak droplets along velocity and add a sheet/curtain mesh at the exit | `Whale.js` (skin maps), `Splash.js` |
| NEW-11 | polish | Harness | `daycard` is stale: under the new rule it never surfaces, so the card never shows (`card Paused \|` in the log). `readability`, `coast` and `steps` leave the prey-cue arc on screen | `daycard` run log | Surface the whale in `daycard`, and hide `#prey-cue` in `hideHud` | `tools/playtest.mjs` |

---

## 3. Blue Planet bar and fun

**At the bar now:**
- whale close-ups in green water, humpback and blue
- the ascent into Snell's window
- the kelp forest interior and its canopy from below
- the night bioluminescent lunge
- time-of-day skies

**Below the bar:**
- the caustic net (on everything shallow, and so on every surfacing)
- the green-smoke daytime swarm
- mid-distance kelp stripes
- krill puffs on the beach
- the airborne splash

**Is the loop fun?** It is **legible and calm, not fun yet.** The full cycle played cleanly with no soft-locks:
1. Breathe (about 25 s, O2 0.04 → 1.0).
2. Dive to the patch (about 20 s, found at 43–51 m, the HUD cue helped).
3. 4–5 lunges with filter pauses (O2 0.85 → 0.28).
4. Ascend and breach: "80 % clear · twist 138°".
5. Breathe, and repeat.

It lacks three things:
- **Stakes in the lunge.** Every lunge maxes out.
- **Scarcity of spectacle.** A breach every dive is not "rare and earned".
- **A reason to travel.** Patches sit 60–190 m apart, pointed to by the HUD, with patch depletion only starting to bite around dive 4–5.

Fix NEW-3 first and the same loop becomes a game.

---

## 4. Next 5 highest-value moves

1. **Give lunges a skill gradient and slow the Surge (NEW-3, NEW-7).**
   - Density × angle yield, so only great lunges cap.
   - A relative or no bonus, and `breachKrill` about 600, so a breach takes about 3 dives.
   - Stomach about 250, so there is a digest/rest beat.
   - The target reached around dusk.

   This is the largest fun return for the least work, in `KrillManager.js`, `Game.js` and `species.js`.
2. **Audio: yes, now.** The loop is legible and the visuals are near the bar, so audio is now the cheapest big immersion win. The O2 design (§4.1 heartbeat) already depends on it. Start with:
   - an underwater ambience bed that changes with depth and time of day
   - blows (species-specific)
   - the fluke-stroke thump and water rush with speed
   - a lunge gulp and the krill "fizz"
   - a low-O2 heartbeat
   - the breach exit whoosh, the in-air wind, and a surface-slam boom (heard as a thud underwater)
   - distant humpback song at night

   Use a single WebAudio graph with a low-pass filter below the surface.
3. **Two shader passes: caustics and swarm pigment (NEW-2, NEW-5).**
   - Warped, softer, filtered caustic filaments.
   - An absorptive rust-brown swarm core with a lit rim and granular specks to about 40 m.

   These are the two most-seen defects in daylight play.
4. **Placement hygiene: krill and kelp (NEW-1, NEW-4, NEW-9).**
   - Krill never shallower than 45 m of water and never above sea level.
   - Kelp far-card variants with random yaw and an LOD crossfade.
   - Surf masked to the wet band.
5. **Decide the sperm whale.** My view: **pull it from the species menu (or show it as "Sperm whale — deep dive, coming soon") until the squid loop exists.**
   - A krill-lunging sperm whale is now the single most visible realism lie, and it teaches the wrong verbs.
   - If it must stay playable, the smallest honest placeholder is:
     - feeding disabled above 300 m
     - a dark "deep scattering layer" of squid-proxy boids in the canyon below 300–500 m
     - suction capture with no lunge pouch
     - a click key that briefly reveals nearby returns (design §4.3)

   Alongside this, give night a readable floor (a moonlit silhouette and a bioluminescent wake, NEW-6).
