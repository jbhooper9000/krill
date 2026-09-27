# KRILL — Platform Assessment: Browser vs Unity

Status: draft v1 · Companion to `GAME_DESIGN.md` · Current stack: three.js r170, WebGL2, about 2.5k lines of JS, no build step, headless-Chrome playtest harness.

**Question.** Does the browser cap the realism the owner wants? If it does, would Unity lift that cap, and at what cost to reach, laptop performance and development speed?

**Caveat.** Platform facts move quickly. Check the flagged items (†) against current vendor docs before committing.

---

## 1. The options

| Option | What it really is |
|---|---|
| **A. three.js WebGL2** (today) | Maximum reach. No compute shaders, so GPU boids and FFT water need workarounds. |
| **B. three.js WebGPURenderer + TSL** (r170+) | Compute shaders, storage buffers and indirect draws. TSL node materials compile to WGSL, and to GLSL on the WebGL2 fallback. The fallback has little or no real compute. WebGPU ships in Chrome/Edge (desktop, Android), Safari 26 and Firefox on Windows. Linux and some older GPUs lag.† |
| **C. Unity URP** (desktop, or web export) | A mid-tier pipeline. Web export works; Unity 6 WebGPU is still experimental.† No built-in ocean; that needs a third-party asset (Crest, KWS). Visually close to option B. |
| **D. Unity HDRP** (desktop only) | The best built-in realism: Water System, volumetric fog and lights, SSS diffusion profiles. **No web export.** Tuned for discrete GPUs. Unity has signalled that its future rendering investment goes to URP or a unified pipeline, with HDRP largely in maintenance.† |

The key point: **"Unity" as a way to more realism means HDRP, and HDRP means a downloadable desktop game.** Unity + web (URP) buys little over option B.

---

## 2. Feature-by-feature ceilings

Scale: ● ready-made · ◐ achievable with custom work · ○ ceiling or large risk

| Feature (realism target) | three.js WebGPU (B) | Unity URP (C) | Unity HDRP (D) |
|---|---|---|---|
| Underwater volumetrics and light shafts | ◐ custom half-res raymarch or froxel pass in compute; today's shafts are billboards | ◐ assets or custom | ● volumetric fog, local fog volumes, volumetric shadows |
| Water surface above and below, with waterline | ◐ FFT ocean in compute (known technique, ~2–3 wks) plus a custom waterline split | ◐ Crest or KWS (paid) | ● Water System: FFT, underwater view, waterline, foam, deformers usable for breach splashes |
| Caustics | ◐ projected caustic texture, or a caustics compute pass from the surface normals | ◐ | ● built into Water System |
| Whale skin / SSS | ◐ MeshPhysical (clearcoat, sheen), wrap lighting | ◐ | ● diffusion profiles |
| Skeletal rig, sculpted whales | ● glTF from Blender, skinning, morph targets (throat pouch) | ● FBX, Mecanim, Animation Rigging | ● same |
| GPU boids, 100k–1M krill | ◐ WebGPU compute: spatial hash, instanced/indirect draw | ● compute shaders + `RenderMeshIndirect` | ● same |
| Streaming Monterey bathymetry | ● HTTP tiles, quadtree LOD, the web's home turf | ◐ Terrain component is awkward at 60 km scale; custom mesh streaming | ◐ same |
| Real-time weather and time of day | ● `fetch` to NDBC/NWS/Open-Meteo (CORS proxy needed) | ● desktop / ◐ web (same CORS) | ● |
| Audio (underwater, song) | ◐ Web Audio: HRTF panner, convolver, biquads, AudioWorklet | ● FMOD/Wwise integrations | ● |
| Mid-range laptop performance | ◐ good if we budget for it | ◐ | ○ HDRP on integrated GPUs is marginal |
| Reach | ● a link | ◐ a big download, or a slow web build | ○ download only, Windows/Mac |
| AI-assisted dev velocity | ● all text, hot reload, harness exists | ○ editor-centric | ○ same, plus heavier builds |
| Cost | ● MIT, free | ◐ Personal free under a revenue cap, Pro about $2k+/seat/yr† | ◐ same |

### Notes on the entries that matter

**Volumetrics, water and caustics.** This is where the honest gap is. HDRP gets the water look nearly for free: surface from below, total internal reflection, the waterline and volumetric shafts. In three.js each is a custom rendering project. None is research-grade; there are public WebGPU examples of FFT oceans, raymarched fog and caustics. Together they are roughly **6–10 engineer-weeks** of rendering work, and they will look "very good", not "AAA". This also overlaps the in-progress lighting item (E2), so part of the cost is already committed.

**Skin/SSS matters less than it sounds.** Whale skin is thick and barely translucent. Realism comes from wet specular, micro-normal detail, scarring and barnacles, diatom film, and correct light extinction in the water. That is all standard PBR plus good textures, and it is not a platform differentiator.

**Skeletal animation.** Parity. glTF is a first-class path in three.js, and our tail wave, banking and pouch logic is procedural code on top of a rig either way. Unity's editor is nicer for an animator previewing clips. That only matters if we hire one.

**Boids at scale.** The compute is the same GPU work on either platform; the hardware is the ceiling, not the engine. WebGPU adds some validation overhead and has buffer-size limits (bind size is often 128–256 MB by default, and 1M boids at 32 B each is 32 MB, fine). Expected on the **same hardware**: about 250k krill at 60 fps on an integrated laptop GPU and about 1M on a desktop RTX 3060-class card, for both platforms. VFX Graph is **not** the right tool; it has no cheap neighbour queries. In Unity you would write a compute shader anyway, so this is a tie.

**Bathymetry.** The data is small. MBARI's Monterey Bay multibeam grid is about 25 m, so the bay is a few million samples, single-digit MB as 16-bit. NOAA's coastal relief/CUDEM data gives nearshore detail, and GEBCO covers offshore. Canyon walls are steep, but a heightfield plus rock meshes covers them. Streaming is easy on either platform, and the tiling pipeline (Python/Node → 16-bit tiles + JSON) is engine-agnostic.

**Weather and time.** Trivial on both. NDBC buoy 46042 (Monterey), NWS and Open-Meteo. A browser game can *be* "live Monterey right now" behind a link. That is a product advantage, not just a technical one.

**Audio.** The realism is in our logic (propagation loss, low-pass at depth, ship-noise masking, a Doppler-free underwater feel), not the middleware. Web Audio is sufficient. FMOD is nicer for a sound designer.

**Performance on mid-range laptops.** "Hyper-realistic" and "mid-range laptop" pull against each other on *any* platform. HDRP at its good settings needs a discrete GPU. A browser build will need quality tiers (volumetric resolution, boid count, water FFT size) whatever we do.

**Dev velocity with AI assistance.** Big and under-rated. Today every change is a text diff, the game reloads instantly, and `tools/playtest.mjs` lets an agent screenshot and inspect state headlessly. In Unity, scenes, prefabs, materials and Shader Graphs live in YAML/JSON the editor owns. Many tasks (lighting a scene, placing a volume, tuning a Water System) are GUI work an agent cannot do reliably. Batchmode testing and screenshots are possible but slower to set up and slower per iteration (domain reloads, imports, builds). Expect agent-driven velocity to drop substantially in Unity, with more of the work landing on a human in the editor.

**Cost and licensing.** three.js is MIT. Unity Personal is free under a revenue cap (raised to $200k with Unity 6†). Pro is paid per seat per year. The runtime fee was cancelled in 2024. Budget about $100–300 of assets (a water package if on URP). Not decisive either way.

---

## 3. What carries over if we port

- **Carries over fully:** `GAME_DESIGN.md`, all tuning values (`Tuning.js` / `species.js` → ScriptableObjects), the bathymetry/weather data pipeline, glTF whale models and rigs (glTFast imports them), and reference captures and playtest scenarios as specs.
- **Carries over as logic:** the boids algorithm and spatial hash. If we write it in WGSL now, the move to HLSL is mechanical. The same goes for movement/lunge/breach state machines if they stay pure simulation code (no three.js types in the rules).
- **Rewritten:** all rendering (GLSL/TSL → HLSL/Shader Graph), the HTML/CSS UI (→ UI Toolkit, whose USS is CSS-like, so the "ink on glass" spec survives) and the harness.
- **Size of a port today:** about 3–5 weeks for parity, dominated by rendering and UI. It grows with every custom rendering feature we build in the browser, so the decision should come **before** the water/volumetrics work, not after.

---

## 4. Recommendation

**Stay in the browser and move to three.js WebGPURenderer + TSL now.** Reasons:

1. The loved core (large boids swarms) runs on the same GPU compute either way; no gain from Unity.
2. The "live Monterey" product (real bay, real weather, real time, a shareable link) is strongest on the web.
3. AI-assisted iteration speed is our biggest production asset, and Unity erodes it.
4. The realism gap is concentrated in water rendering (surface, volumetrics, caustics). That is a bounded, known rendering problem we would partly pay for anyway in E2.

**Do this regardless of platform** (low-regret): keep the simulation (movement, O2, Condition, breach, swarm rules) in engine-free modules. Write the boids in WGSL compute. Build the bathymetry pipeline as standalone scripts.

### Decision point
Run the spikes below and decide at the end of E2 (underwater lighting).

- **Stay** if the browser underwater spike reaches the owner's reference look (a side-by-side with real footage and an HDRP capture) at **≥ 45 fps at 1080p on the target laptop**, *and* 250k krill hold 60 fps there.
- **Switch to Unity HDRP (desktop)** if the owner, after a blind side-by-side, picks the HDRP water/volumetric look *and* accepts: download-only distribution, discrete-GPU minimum spec, and slower agent-driven development. That is a product change (a PC game), not only an engine change.
- **Do not switch to Unity URP / web.** It costs the port for roughly option-B visuals.

### De-risking spikes (1–2 days each)
1. **WebGPU boids.** 250k and 1M krill with a spatial-hash compute pass and indirect instanced draw, whale flee/attract externals included. Measure on an Iris Xe / 680M-class laptop and an RTX 3060-class desktop. Pass: 250k at 60 fps on the laptop.
2. **Browser water look.** A WebGPU FFT (or Gerstner) surface seen from below and above with a waterline split, half-res raymarched shafts shadowed by the surface normals, and projected caustics. Pass: owner-approved screenshots from five fixed cameras (the current `shots` scenario) at ≥ 45 fps on the laptop.
3. **Unity HDRP reference.** Water System + volumetric fog with the current whale exported to glTF, the same five camera shots, and 100k compute boids. Measure fps on the same laptop. Log how many edits an agent could make text-only versus in the editor. This is the realism bar and the velocity reality check.
4. **Bathymetry tiles** (engine-agnostic, start now): MBARI 25 m plus CUDEM nearshore → 16-bit quadtree tiles, rendered as a streamed heightfield of the canyon head at Moss Landing.

### Is a hybrid sensible?
**Partly.** "Prototype mechanics in the browser now, and possibly ship the final game in Unity" is low-regret *for the next 2–3 months*. The approved loop (breath, Condition, finite swarms, DVM, breach, squid hunting) is platform-independent and fastest to iterate here. It is **not** sensible to build the expensive browser water/volumetric renderer and *then* port; that pays for rendering twice. So: mechanics and data in the browser now, the spikes above, then one irreversible platform call before committing to the water renderer.
