# KRILL — Game Design Document

Status: draft v1 · Owner: design · Branch context: `feat/realism-pass`
Units: 1 world unit = 1 m (the humpback is 14 units long, and so is a real one). Real-world figures are cited so tuning can be checked against them. Where the doc compresses reality for play, it says so.

---

## 1. Critique of the current build

**What works**
- **The krill swarm.** Boids that part around the whale are the best thing in the game. Swimming into a cloud and watching it split is the fantasy. Keep it at the centre.
- **Whale weight.** Momentum, banking, a heading that lags the aim, the travelling tail wave and the throat pouch ballooning on a lunge all read as a large animal. The pouch's slow deflation is the start of a real feeding rhythm (see §4.3).
- **Mood.** Marine snow, god rays, caustics and depth fog get most of the way there.

**What is boring**
- **No decisions.** Hold W, point at pink dots, press RMB. Nothing is scarce and nothing can go wrong. Eaten krill respawn in 1.4–3.4 s at the same home point (`KrillManager` respawn queue), so the best strategy is to circle one cloud forever.
- **No reason to move.** Swarm homes drift slowly and follow the player's depth (`homeCenter.y += (whale.y - homeCenter.y)…`). The world comes to you, inside a 170 m circle.
- **No reason to change depth.** Krill follow you up and down, so depth is only a number on the HUD.
- **The growth meter is a treadmill.** Each level needs 1.5× more krill, the whale gets 6 % bigger and a banner appears. Growing up in minutes also breaks the realism pillar.

**What is broken or confusing**
- **Zones are fiction.** "Abyss" is 66–88 m and has kelp on the floor. The real abyssal zone starts around 4,000 m, and kelp does not grow below about 30 m. Monterey Canyon reaches past 3,000 m, so the real names are available and should be used.
- **The level-up banner mislabels.** It shows `Zone {level} — {zone at current depth}`, so "Zone 3 — Shallows" can appear. Levelling up never actually moves you deeper.
- **You cannot reach the surface.** `bounds.maxY = -L*0.35` stops the whale below the waterline. A whale that cannot breathe, blow or breach is the biggest realism gap in the build, and it blocks the owner's breach request. The camera is also clamped at −0.6 m and the scene has no above-water rendering. The near-surface screenshot is a white wash.
- **Sperm whales eat krill.** They do not. They hunt squid at 300–1,200 m by echolocation. Right now the species differ only in stats.
- **Speeds are about 3× real.** Humpback cruise is 10 m/s and lunge peaks near 24 m/s. Real cruise is 1.5–3 m/s, with bursts of 5–8 m/s. That is acceptable as a compression, but it should be a deliberate choice (see §3.4).
- **Fish schools are decoration.** Monterey humpbacks feed heavily on anchovy. Those schools should be prey.
- **Arcade chrome.** Frosted panels, emoji species cards, "You grew!" and a start screen that is 92–98 % opaque over a beautiful live ocean.

---

## 2. Design pillars

1. **Be the animal, not a pilot.** Every verb is something the species really does: blow, dive, lunge, bubble-net, click, breach, sing. Every limit comes from its physiology: breath, lunge cost, filter time, energy.
2. **A living, real bay.** Monterey Bay's actual canyon, shelf, kelp and weather. Prey moves for real reasons (diel migration, upwelling, fronts), so reading the ocean is the skill.
3. **The swarm is the opponent.** Krill and bait balls are the main encounter. Herding, splitting and engulfing a flock of 10⁴–10⁵ agents is the combat system.
4. **Quiet screen, loud moments.** The HUD stays nearly invisible. Spectacle (breaches, blows, pod calls) is rare and earned, and it lands hard.

---

## 3. Core loop and session structure

### 3.1 Moment to moment (10–40 s): hunt
Read the swarm, set up an approach (from below for a rorqual, a bubble net for a humpback, clicks for a sperm whale), commit to a lunge, filter, repeat. Each lunge costs oxygen and energy, so a bad approach is a real loss.

### 3.2 The dive cycle (about 2–5 min): the heart of the game
```
 SURFACE ─ breathe (3–6 blows), look for signs: birds, boats, slicks, spouts
    │
 DIVE ─── descend to the prey layer (depth depends on time of day)
    │
 FORAGE ─ 2–6 lunges / one bubble-net / one squid chase, O2 draining
    │
 ASCEND ─ must reach air; ascent is slow and cannot be skipped
    │
 BREACH? ─ if Surge is full, spend it for spectacle and signalling
    └──► SURFACE
```
Oxygen forces the vertical rhythm: you must come up. Diel vertical migration (DVM) decides how far down you go. Patch depletion decides where you go next.

### 3.3 Session (20–40 min) and long term
- **A session is a "day at sea"** in the Monterey feeding season. Goal: raise body **Condition** (blubber) from its start value to the season target. The end-of-day card reports kg eaten, dives, the best lunge and breaches.
- **Long term** is a **season calendar** (real: humpbacks April–December, blues June–October, sperm whales pass through year-round). Condition carries over between days. Growth happens between seasons, calf → juvenile → adult, not mid-session. A **Fluke ID journal** records sightings by whale-watch boats (a nod to Happywhale photo-ID, which is big in Monterey), along with found POIs and pod contacts. The future world map unlocks migration destinations (Baja, Hawaii, the Costa Rica Dome).
- **Failure state:** oxygen at 0 → **blackout**. The screen tunnels, control is lost, the whale is auto-lifted and loses 25 % Condition. A season that ends below target gives the "underweight — migration odds poor" outcome. An optional ship strike in Hardcore ends the run.

### 3.4 Reasons to move and to change depth
| Driver | Real basis | Effect |
|---|---|---|
| Patch depletion | Whales leave patches below a density threshold | Swarm biomass is finite and regenerates over game hours, not seconds |
| Diel vertical migration | *Euphausia pacifica* sits at ~150–250 m by day and rises toward the surface at night | Deep dives by day, easy shallow feeding at night, but night gives less light to see by |
| Upwelling fronts | NW winds → upwelling at Año Nuevo / Pt. Sur → krill aggregate on the canyon edges 3–10 days later | Real-time wind drives where the big swarms spawn (ties to the weather feed) |
| Surface cues | Diving seabirds mark bait balls | Surface-scanning is a skill: birds mean anchovy |
| Oxygen | Obligate breathers | Every dive ends at the surface |

**Time compression:** whale physiology runs at about **4×**. A 10-minute blue whale dive plays in about 150 s. The world is not scaled; bathymetry stays true. Vertical speeds may be up to 2× real so a sperm whale reaches 500 m in about 2.5 min.

---

## 4. Mechanic proposals

Cost: S ≤ 3 days, M ≤ 2 weeks, L > 2 weeks. Priority: P0 = next milestone, P1 = soon after, P2 = later.

### 4.1 Breath, oxygen and spouts — **P0 · M**
- **Real basis:** humpback feeding dives last 3–8 min, blue about 10 min (up to 20), sperm 45–60 min with an 8–10 min surface interval. Heart rate drops sharply on dives (a blue whale's goes down to 2 bpm, Goldbogen 2019). Blows are species-specific: humpback bushy, about 3 m; blue a tall column of 9 m or more; sperm angled forward-left, because the blowhole sits left of centre.
- **How it plays:** O2 drains with time. Lunges and bursts drain it faster. Surfacing with the blowhole in the air auto-triggers a blow. Each blow takes about 2 s and refills 20–30 %. Staying at the surface is safe but earns nothing.
- **Game budgets:** humpback 120 s, blue 150 s, sperm 360 s. A lunge costs 6 % (blue) to 8 % (humpback).
- **Controls:** automatic. Holding Space at the surface forces a slower, deeper breath.
- **UI:** diegetic first. Below 30 %: slower heartbeat audio, edge desaturation and a vignette creeping inward. Below 10 %: the screen tunnels. A thin breath arc appears only when O2 is under 50 %.
- **Blocker:** needs the surface boundary lifted and an above-water render path. This is shared work with the breach and with engineering item 2 (lighting).

### 4.2 Energy / Condition (replaces the growth meter) — **P0 · S**
- **Real basis:** a blue whale can eat up to about 16 t of krill a day (Savoca 2021). Lunges are expensive, which is why blues dive shorter than predicted (Croll 2001).
- **How it plays:** Condition 0–100 drains slowly from metabolism, plus the cost of lunges and breaches. Prey adds to it. One boid equals a mass of krill (tunable, about 2 kg), and the summary shows kilograms, not a raw count. The **stomach** caps intake per dive, which ends the "circle one cloud forever" exploit.
- **UI:** hidden during play. Shown on the pause screen and at dive and day summaries.

### 4.3 Species feeding (the core verbs)

**Rorqual lunge refinement (blue + humpback) — P0 · S.** Real engulfment: the whale accelerates to 3–4 m/s, opens its jaw about 80°, takes in water up to 100 %+ of its body mass, then filters for about 30–60 s. Keep the RMB charge/release. Add a **filter phase** after each lunge: 3–4 s game time with the pouch deflating (the animation already exists) and no new lunge. Speed drops sharply at mouth-open, which is realistic drag. Blues get the biggest mouth, the most krill per lunge and the slowest recovery. The lunge should push krill aside at the edge of the mouth (a boids flee pulse) so near misses scatter the swarm.

**Humpback bubble-net — P1 · M.** Real: humpbacks spiral upward, releasing a bubble curtain 3–30 m across, then lunge vertically up through the middle and break the surface mouth-open. How it plays: hold **E** to release bubbles along your path. Each bubble column is a short-lived boids `flee` external (the system already supports externals) that rises for 15–20 s. Circle the swarm 1–2 times, it compresses into the column, then lunge upward. The payoff is a surface lunge that can take 3× a normal lunge, and it feeds directly into the breach. Anchovy bait balls are edible for humpbacks. Diving seabirds mark them.

**Sperm whale deep dive + echolocation — P1 · L.** Real: dives to 400–1,200 m. Regular "usual clicks" every 0.5–1 s scan hundreds of metres ahead. A rapid "creak" or buzz means closing on prey (squid: *Gonatus*, Humboldt). The clicks are the loudest biological sound known (about 230 dB). How it plays: below about 200 m it is effectively dark. Hold **Q** to click. Each click lights up returns as brief, faint point clouds (an acoustic image, not a light). The click rate rises automatically as range closes, so the player hears the approach. Squid are small, fast boids groups (5–20) with evasive jinks, taken one at a time by suction. Needs deep water from the streamed world (engineering item 3).

### 4.4 The breach — **P0 · M** (full spec in §5)
Surge fills from eating. Hold **F** to power up from depth and launch. The airborne phase has a controllable twist, landing on the back or side makes a splash sized to the whale, and the reward is spectacle plus a long-range signal.

### 4.5 Day/night and krill DVM — **P1 · M**
Swarm target depth follows the sun: about 200 m by day and 10–40 m at night, with a migration speed of about 100 m per hour (compressed 4× in game time). Night swarms are denser near the surface but hard to see. Only moonlight, bioluminescent sparks when krill are disturbed, and silhouettes against the surface. Wired to real Monterey local time, with an optional "match my clock" toggle.

### 4.6 Song, calls and pods — **P2 · L**
Real: humpback song has been recorded in Monterey by MBARI's MARS hydrophone (891 m), mostly in autumn and winter. Blue whales make low B-calls, plus D-calls around feeding. Sperm whales use codas. How it plays: **Q** vocalizes (for sperm whales it is the click, see above). An AI whale answering reveals its position within a range that shrinks with ship noise and storm noise. A pod member will join a bubble net, and cooperative nets make bigger compression. Breaching is the long-range version of the same signal.

### 4.7 Threats — ships **P1 · M**, entanglement **P2 · M**, orcas **P2 · L**
- **Ships:** real Monterey shipping lanes, and ship strike is a leading cause of blue whale deaths. Engine noise is heard long before the hull is seen, and it masks calls. A strike is a big Condition loss, or the end of the run in Hardcore. This teaches real behaviour: dive when you hear a ship.
- **Entanglement:** Dungeness crab gear, a major Monterey problem in 2015–16. Vertical lines near the shelf. Getting caught drags on speed and oxygen until you surface near a disentanglement boat.
- **Orcas:** Monterey transients hunt gray whale calves in April–May. They do not hunt adult humpbacks, blues or sperm whales. Humpbacks mob them. So orcas are an ambient event: you can join the mob as a humpback, or shield a calf as a mother in a later mode. Never a boss fight.

### 4.8 Monterey POIs — **P1 · M** (content on top of engineering item 3)
Monterey Canyon (head at Moss Landing, more than 3,000 m deep), Soquel and Carmel canyons, the Point Lobos and Cannery Row kelp forests (too shallow for adult rorquals, which is a real constraint and a nursery/refuge area), the Santa Cruz shelf, the Año Nuevo upwelling plume, the MARS hydrophone node, and Davidson Seamount offshore. Each one is logged in the journal on discovery.

### 4.9 Cut list (fights realism)
In-session growth levels · depth zones used as levels · sperm whales eating krill · kelp below 30 m · score multipliers and combo text · orcas as enemies · emoji · power-ups · infinite instant krill respawn.

---

## 5. BREACH — implementation spec

### 5.1 Real-world basis
- Segre et al. 2017 (*eLife*): humpbacks leave the water at about **8 m/s**, reached from rest in about **6 fluke strokes** over roughly 2 body lengths of depth. A breach costs a lot of energy.
- **Clearance:** humpbacks usually clear 40–90 % of the body. Sperm whales often clear more. Blue whales rarely breach and mostly make partial breaches. Scaling makes a full breach harder for bigger animals.
- **Twist:** a humpback typically rolls about 90–180° about its long axis, flippers out, and lands on its back or side.
- **Bouts:** humpbacks breach in bouts, several in a row.
- **Signalling:** breaching rises in high wind and when groups are separating (Dunlop et al.). It is long-range communication. This hooks straight into real-time weather.

### 5.2 Surge: charging it with n krill
- `surge` 0–1. It fills with `eaten / breachKrill[species]`. Defaults: **humpback 150, blue 260, sperm 4 squid**. Add these to `TUNABLES`.
- A lunge that takes 40 or more boids adds a ×1.5 bonus. Bubble-net surface lunges fill it completely.
- Ready at 1.0. It never decays, and it persists across dives. **Bout rule:** a breach within 25 s of landing the last one costs only 0.5 of the meter (max 3 in a bout).
- Breaching costs 4 % Condition and 10 % O2, but you are at the surface anyway.

### 5.3 Trigger conditions (the breach window)
All of these must hold when **F** is pressed (gamepad: Y):
- `surge ≥ 1` (or ≥ 0.5 during a bout)
- depth of the whale's centre between **0.8 L and 4 L**
- local water depth ≥ **1.5 L** (no breaching in the kelp or on the shallow shelf)
- not in filter phase, not blacked out, no vessel within 1.5 L of the predicted landing point

If the window is not met, F shows a one-line reason in the prompt area ("Too shallow", "Too deep", "Surge not ready").

### 5.4 State machine
```
IDLE ──F(valid)──► RUNUP ──crosses y=0 or F released & depth<0.8L──► EXIT
RUNUP ──F released & depth>0.8L──► ABORT (keeps 80% surge) ──► IDLE
EXIT ──CoM above y=0──► AIRBORNE ──CoM returns to y=0──► IMPACT
IMPACT (0.25 s) ──► SUBMERGE (1.8 s, reduced control) ──► COOLDOWN (4 s) ──► IDLE
```

| State | Behaviour | Tuning (humpback / blue / sperm) |
|---|---|---|
| RUNUP | Auto-pitch toward a target climb angle while F is held. The mouse steers yaw only, with ±15° of pitch trim. Thrust is maxed and the tail beat frequency ramps up. Speed rises toward `vExitMax` along the body. **Launch quality** `q = speed/vExitMax × angleFactor`, where angleFactor = 1 at 70–80° and falls to 0.6 at 45°. | climb 75° / 60° / 80°; `vExitMax` 9.5 / 7.0 / 9.0 m/s; accel 2.2 / 1.2 / 2.0 m/s² |
| EXIT | Body crosses the surface (0.3–0.6 s). Lift the Y clamp. Kinematic: keep the velocity and apply g. Spawn the sheeting-water sprite at the waterline, which follows the contact ring. | — |
| AIRBORNE | Ballistic: `v.y -= 9.81·dt`, horizontal velocity kept with a light drag of 0.02. **Twist:** roll about the body axis at `ω = twistTarget/tAir`. The player's mouse X biases the direction and adds up to ±40 %, clamped to the species max. Pitch rotates toward horizontal and then nose-down (`pitchRate ≈ −1.1 rad/s`), so the landing is on the side or back. Flippers spread (humpback). No feeding, no O2 drain. | twist default 140° / 40° / 90°, max 200° / 70° / 130° |
| IMPACT | Compute **landing attitude**: roll 60–200° = back/side (full splash), below 60° = belly (70 % splash, "flop"). Spawn the splash, sound and camera shake. Water drag on entry: speed ×0.35. | — |
| SUBMERGE | Bubble curtain around the body, speed bleeds off, pitch eases back to level, controls are at 40 % and ramp to 100 %. | 1.8 s |

**Resulting numbers (real g, humpback, q = 1, 75°):** v_y ≈ 9.2 m/s → apex CoM +4.3 m, CoM airtime ≈ 1.9 s. **Clearance** = `clamp((h_apex + 0.5·L·sinθ) / (L·sinθ), 0, 1)`, which gives about 82 %. That is inside the real range, so no fake physics is needed. Blue at q = 1 (7 m/s, 60°): about 60 % clearance, a partial breach, which is truthful. Sperm at q = 1 (9 m/s, 80°): about 75 %.
**Time dilation:** `timeScale = 0.45` for 0.7 s centred on apex, easing in and out over 0.15 s. Perceived airtime ends up around 3 s. Optional in settings.

### 5.5 Splash scales with the whale
Driven by impact kinetic energy `E = ½·m·v²` with `m ∝ L³`:
- **Plume height** `H = 0.55·L·(v_impact/9)` → about 8 m for a humpback, about 9 m for a blue (heavier but slower on impact).
- **Crown radius** `R = 0.45·L`. Particle count `∝ L²` (humpback about 1,500 sprites, blue about 2,500). An outward ring wave travels at 3 m/s for 6 s, and a foam slick decals the surface for 60 s. The slick is visible from above as a "footprint" (real).
- Underwater: a cone of bubble curtain plus a white-out wash when the camera is within 1 L.

### 5.6 Camera
- **RUNUP:** camera drops below and to the side of the whale (azimuth 110° from the heading, 1.4 L back) and looks up at the silver surface. FOV +8.
- **EXIT → AIRBORNE:** a continuous move (no cut) to a **witness shot**: 2.5 L to the side, 0.3 L above the water, level horizon, framing the apex. The lens gets a water-line split and drip droplets for 1.5 s when the camera itself crosses y = 0. An option in settings keeps the follow-cam instead.
- **IMPACT:** 0.35 s shake (amplitude ∝ L). The camera follows the whale down through the splash. Refraction wobble and bubbles fill the view, then it returns to the normal follow-cam over 1.2 s.
- Requires the above-surface renderer: sky, sun, the surface from above and fog off above water.

### 5.7 Feedback
- **Audio:** run-up fluke thumps that speed up, plus a rising water rush → surface-break whoosh and sheeting water → near-silence and wind in the air, with a single blowhole exhale → impact: deep boom plus spray hiss. Underwater listeners get a long low thud. Pod AI within range responds (they breach back, or call).
- **HUD:** only the Surge ring (see §6) and the one-line prompt. No score text in the air. The post-breach toast fades in top-centre for 2.5 s, e.g. `Breach · 82% · twist 150° · heard 4.1 km`.
- **Signal range** `= 1.5 km × clearance × (1 + wind_kts/20)`. It reveals pod members, and it triggers whale-watch Fluke ID captures if a boat is within 500 m.

### 5.8 Edge cases
- Swimming up without pressing F: a rorqual surface lunge may break the surface. That is a "lunge-out", not a breach. It uses the same EXIT/AIRBORNE code with q ≤ 0.35 and no twist.
- The run-up hits kelp or the shelf, or the water becomes too shallow mid-run → ABORT.
- Pause or tab-hide mid-air: freeze the state. Airborne physics uses fixed 1/120 s substeps (dt is clamped at 0.05 today).
- Level, day or season rollover while airborne is deferred until SUBMERGE ends.
- Krill feeding is disabled from EXIT through IMPACT. Krill near the splash get a flee pulse.
- A camera occluded by the whale's own body in the witness shot: push the azimuth out ±30°.
- Blackout is impossible while airborne, because O2 refills at the surface.

---

## 6. HUD and UI

### 6.1 Visual direction: "ink on glass"
The current UI uses frosted panels (`backdrop-filter: blur`, 0.55–0.98 opacity) and gradients. Replace it all:
- **No panels, no backgrounds, no borders.** Text and hairlines sit directly on the live ocean. Menu overlays have **no** opaque layer. The only dimming allowed is a radial scrim, `radial-gradient(rgba(2,10,16,0.35) → transparent 70%)`, behind a text block, on the pause screen only.
- **Type:** Outfit (already loaded) at **weight 300** for labels and 200 for display. Numerals use `font-variant-numeric: tabular-nums`. Labels are 11 px, uppercase, `letter-spacing: 0.18em`. Values 15 px. Display 64–96 px at weight 200 with `letter-spacing: 0.04em`.
- **Colour:** one ink, `--ink: #EAF6F8`. Alpha levels: **0.9** active/alert, **0.6** contextual, **0.35** passive or secondary, **0** idle (auto-hidden after 4 s without change). One accent, `--bio: #8FF5E4` (bioluminescent cyan), for Ready/interactive only. One warning, `--amber: #FFC27A`, for low O2, ships and entanglement. No red, no gradients.
- **Legibility over a bright surface and a black abyss:** use a dual text-shadow on all HUD text, `0 0 1px rgba(0,12,20,.55), 0 0 14px rgba(0,12,20,.35)`. It is invisible on dark water and gives a soft halo on bright water. Hairlines are 1 px at the same alpha plus the same shadow. When the camera is within 3 m of the surface or above it, raise ink alpha by +0.1. Never use `mix-blend-mode: difference`, which is ugly on blue.
- **Motion:** fades only, 400 ms `cubic-bezier(.2,.7,.2,1)`. No slides, no bounces, no scale pops. The Ready state gets a breathing pulse at 0.25 Hz (alpha 0.6↔0.9). The low-O2 arc pulses at heart rate. Respect `prefers-reduced-motion` by removing the pulses.
- **Diegetic first:** depth shows in the fog colour and light, O2 in heartbeat audio and vignette, speed in FOV. The HUD confirms what the world already tells you.

### 6.2 In-game HUD
```
┌──────────────────────────────────────────────────────────────────────────┐
│ MONTEREY CANYON · 14:32 · NW 12kt                                  ─ 20 │
│  (α .35, fades out after 4s)                                       ─ 40 │
│                                                                    ▸ 57m│
│                                                                    ─ 60 │
│                                                                    ─ 80 │
│                          (depth tape appears only when depth changes)│
│                                                                          │
│                                ·   (no reticle; small dot only while     │
│                                      charging a lunge)                    │
│                                                                          │
│                                                                          │
│                              ◜‾‾‾‾‾◝                                      │
│                             (   ●   )  ← lunge charge: hairline ring     │
│                              ◟_____◞      fills clockwise, α .6           │
│                                                                          │
│  O₂ ╭──────────╮ (arc only when <50%; amber <25%)                       │
│ ───────────────────────────── S U R G E ─────────────────────── 62% ─── │
│   (1px hairline, α .35; hidden when 0)                                   │
└──────────────────────────────────────────────────────────────────────────┘
```
Removed: the krill counter (moves to summaries as kg), zone name/level, the growth bar and the persistent control hints (shown only the first time each verb is available).

### 6.3 Breach-ready state
```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                    ─ 20 │
│                                                                    ▸ 31m│
│                                                                          │
│                                                                          │
│                                                                          │
│                                                                          │
│                   ~~~~~~~~~~~ surface (bright) ~~~~~~~~~~~               │
│                                                                          │
│                         ◜‾‾‾‾‾‾‾◝                                         │
│                        (  BREACH  )   bio-cyan, pulsing .25Hz             │
│                         ◟_______◞                                         │
│                     hold F · climb steep                                 │
│                    (α .6; reason text in amber if window invalid)        │
│                                                                          │
│ ─────────────────────────── S U R G E ── READY ───────────────────────── │
│   (hairline turns bio-cyan, full width)                                  │
└──────────────────────────────────────────────────────────────────────────┘
 During RUNUP the ring becomes a launch-quality arc (0–100%) that fills
 with speed × angle; all HUD fades to 0 in AIRBORNE; post-breach toast:
          Breach · 82% clear · twist 150° · heard 4.1 km
```

### 6.4 Species select: the real whale, in the water
The live scene *is* the menu. The whale model idles in its own habitat: the humpback in bright shelf water with a bait ball, the blue in open blue with a krill layer, the sperm whale in the dark at the canyon wall. A slow orbit camera circles it. Switching species cross-fades the scene through a 1.2 s depth transition. No cards, no emoji, no stat bars. Show real facts instead of fake 1–5 ratings.
```
┌──────────────────────────────────────────────────────────────────────────┐
│ KRILL                                                                    │
│ (display 200, α .9)                                                      │
│                                                                          │
│                     [ live 3D whale, orbiting camera ]                   │
│                                                                          │
│ Humpback                                                                 │
│ Megaptera novaeangliae                         (italic 300, α .6)       │
│                                                                          │
│ 14 m · 30 t · dives 3–8 min                     (α .6, tabular)           │
│ Bubble-nets krill and anchovy. Breaches often. (α .6, max 40ch)          │
│                                                                          │
│                                                                          │
│   HUMPBACK        BLUE        SPERM          ←/→ or click   (labels α .35, │
│   ────────                                    selected α .9 + underline)│
│                                                          Dive in  ⏎      │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.5 Pause / map
The ocean stays live behind the map, slowed to 0.3× (already done), with the radial scrim. The map is drawn as bathymetric contour hairlines (every 100 m, bolder every 500 m) in ink at α 0.35. Land is a flat α 0.08 fill. The player is a bio-cyan arrow.
```
┌──────────────────────────────────────────────────────────────────────────┐
│ PAUSED                                          Day 12 · Aug · 14:32     │
│                                                 NW 12 kt · swell 1.5 m   │
│    Santa Cruz                                                            │
│      ╲___  ˜˜˜˜˜ 100m                                                    │
│          ╲__   ˜˜˜˜ 200m      ◉ Año Nuevo plume (krill forecast ↑)        │
│   Soquel ╲  ╲___                                                         │
│   Canyon  ╲     ╲_  ≈≈≈ 500m                                             │
│  Moss Landing ●   ╲    ≈≈≈≈ 1000m   ▲ you (bio-cyan)                     │
│         Monterey Canyon ╲___  ≈≈≈≈≈≈ 2000m      ◌ MARS hydrophone        │
│   Cannery Row ⌇⌇ kelp    ╲                                               │
│   Pt. Lobos   ⌇⌇         Carmel Canyon                                   │
│                                                                          │
│ CONDITION  ────────────●──────── 58 → target 75                          │
│ Today: 1,240 kg · 14 dives · 3 breaches · 2 Fluke IDs                    │
│                                                                          │
│ Resume ⏎      Journal      Settings      Quit        (text buttons, no box)│
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Prioritised roadmap

Engineering track: **E1** movement feel (done) · **E2** underwater lighting (in progress) · **E3** Monterey streamed world · **E4** rigged/sculpted whale · **E5** GPU boids.

| # | Item | Pri | Cost | Slots in | Depends on |
|---|---|---|---|---|---|
| 1 | **Surface & above-water rendering + lift the Y clamp** (sky, surface from above, split-lens) | P0 | M | Inside E2, now | — |
| 2 | **Breath/O2 + spouts + blackout fail state** | P0 | M | Right after E2 | 1 |
| 3 | **Breach + Surge** (§5) | P0 | M | With 2 | 1; better after E4 (twist/flippers) but works on the current mesh |
| 4 | **Condition/stomach economy + finite, depleting swarms** (remove growth levels and fake zones; lunge filter phase) | P0 | S | Parallel with 2 | — |
| 5 | **"Ink on glass" HUD + live species select + pause map shell** | P0 | S–M | Parallel with 2–4 | map content needs E3 |
| 6 | **Day/night + krill DVM + wind-driven upwelling spawns** | P1 | M | With E3 | E3 depth, weather API |
| 7 | **Humpback bubble-net + edible anchovy bait balls + seabird cues** | P1 | M | After E5 | E5 for swarm size and compression |
| 8 | **Sperm whale deep dive + echolocation + squid** | P1 | L | After E3 | E3 canyon depth |
| 9 | Ships + noise masking; Monterey POIs + journal/Fluke ID | P1 | M | After E3 | E3 |
| 10 | Pods, song, entanglement, orca events, seasons/migration | P2 | L | After E4/E5 | E4, E5 |

**Order in one line:** finish E2 *with* the surface → O2 + Breach + Condition + HUD (the first real game loop, playable on the current map) → E3 world with DVM, upwelling and POIs → E5 GPU boids with the bubble-net → E4 rig (breach twist, flippers and gape look their best here) → sperm deep game → social and threats.
