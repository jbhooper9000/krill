# KRILL 🐋

A cinematic third-person whale game for the browser. You are a whale gliding through
a living ocean, hunting swarms of krill simulated with boids. Eat enough krill and
you grow — diving deeper into darker, stranger waters.

Built with **Three.js** (WebGL2) as pure ES modules — no bundler, no build step.

## Run it

```bash
npm install        # installs three.js
npm run dev        # starts the static server
```

Then open **http://localhost:5199** (or the port printed). If 5199 is taken, set
`PORT`:

```bash
# PowerShell
$env:PORT = 5200; npm run dev
```

## Controls

| Input            | Action                              |
| ---------------- | ----------------------------------- |
| `W` / hold LMB   | Swim forward                        |
| Mouse            | Steer (look direction)              |
| `Space`          | Rise                                |
| `Shift` / `Ctrl` | Dive                                |
| Hold `RMB`       | Charge a **lunge**, release to burst |
| Mouse wheel      | Zoom camera                         |
| `Esc`            | Pause                               |
| `T`              | Open the live tuning panel          |

Click the canvas once to re-capture the mouse after pausing.

## The game

- Choose **Humpback**, **Blue**, or **Sperm** whale. Each has different size,
  speed, mouth radius, lunge power and starting depth.
- Krill drift in boid swarms and scatter when you approach — lunge into a cloud
  to gulp the most at once.
- A growth meter fills as you eat. When full, you grow and dive into the next
  depth zone: **Shallows → Twilight → Midnight → Abyss**.
- Press **`T`** mid-game for a live tuning panel — sliders for krill size/count/
  spacing/speed, swim speed, turn rate, camera distance, lunge power and growth
  pace. Values apply instantly and are defined in `src/game/Tuning.js`.

## Architecture

```
src/
  main.js                 entry point + menu wiring
  game/
    Game.js               orchestrator + render loop + growth/level logic
    World.js              ocean surface shader, sea floor, caustics, god rays,
                          marine snow, kelp, rocks, per-zone fog/lighting
    Whale.js              procedural whale (parametric body + extruded fins),
                          PBR skin, tail-beat animation
    PlayerController.js   third-person camera + whale movement + lunge
    Boids.js              spatial-hash boids engine
    KrillManager.js       krill swarms + fish schools (instanced), feeding
    Effects.js            bloom + color grade + vignette post-processing
    Input.js              keyboard/mouse/pointer-lock
    species.js            species + depth-zone config
    textures.js           procedural canvas textures (skin, sand, caustics…)
  ui/UI.js                HUD + menus
```

All art is procedural (no external assets): the whale, krill, fish, sand,
caustics and sky are generated at runtime.
