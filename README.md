# Ardennes GP

**A browser racing game on the real Circuit de Spa-Francorchamps** — an
F1-broadcast-style presentation over the real Ardennes layout, built with
Three.js, an original 120 Hz physics model, and open geodata. Qualify against a
field of rivals, then race them across true LiDAR elevation. Runs in any modern
browser, desktop or phone, no install.

### ▶ Play it now: **https://n1tr029.github.io/spagpRacer/**

![Into Eau Rouge–Raidillon](screenshots/race.jpg)

<p align="center"><em>Chasing the pack up through Eau Rouge and Raidillon</em></p>

![Cockpit view with touch controls on mobile](screenshots/cockpit.jpg)

<p align="center"><em>Cockpit view — live wheel LCD, rear-view mirror, and on-screen touch controls on mobile</em></p>

> A non-commercial fan project, not affiliated with or endorsed by Formula 1,
> the FIA, EA, Codemasters, or any team. The car and steering-wheel models are
> free-to-use community models from Sketchfab (credited in [Credits](#credits));
> "F1", team names, and liveries are trademarks of their respective owners.

## Features

- **Race weekend** — Quick Race, Qualifying → Race, or Practice, with a real
  standing start (five-light gantry, grid formation) and a post-race **podium**
  ceremony.
- **F1-style HUD** — battle tower with team colours, tyre compounds and live
  gaps; three-sector timing with purple/green splits; a minimap with every car.
- **Car systems** — **ERS** battery (harvest / deploy / overtake), functional
  **DRS** with the real Spa activation zones, shift lights, tyre temperatures,
  fuel + engine modes, adjustable brake bias.
- **Pit stops** — drive the pit lane under the limiter for a tyre change, with
  an animated **pit crew** cutscene.
- **Rules** — track-limits detection, penalties, and blue flags.
- **Presentation** — a rear-view mirror, trackside **broadcast cameras**, and a
  cinematic race-start camera.
- **The look** — bloom, colour grading, soft shadows, sky reflections, skidmarks
  and trackside furniture (High quality), with **Low / Medium / High** tiers so
  it runs smoothly on phones.
- **Mobile** — on-screen steering, pedals, DRS/ERS, and a camera button;
  fullscreen on Android, and web-app install for iOS.

## Quick start

```bash
npm install
npm run dev        # open the printed localhost URL
```

Pick a mode from the start menu and go. To build for hosting: `npm run build`
(the repo also has `npm run deploy` for GitHub Pages).

## Modes

- **Quick Race** — straight to a standing-start race against a field of rivals
  over 3, 5, or 10 laps. You start at the back; carve your way forward.
- **Quali + Race** — a qualifying session (3, 5, or 8 minutes) sets your grid
  slot, then rolls into the race. You start well back on the pit straight so you
  can wind up to speed for the flying lap.
- **Practice** — free running, no clock, just you and the circuit.

## Controls

**Keyboard**

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| W / ↑ | Throttle | Shift | ERS overtake boost |
| S / ↓ | Brake | Space | DRS |
| A D / ← → | Steer | E | ERS mode |
| C | Camera (chase → cockpit → nose) | Q | Engine mode (lean/std/rich) |
| F | Rear-view mirror | `[` `]` | Brake bias |
| V | Broadcast cameras | 1 / 2 / 3 | Next-stop tyre compound |
| L | Racing line | X | Assists (auto-brake + traction) |
| O | Cockpit setup panel | R | Reset · **Esc** menu · **M** mute |

**Mobile** — steering arrows and throttle/brake pedals, plus DRS, ERS, camera,
reset, menu, and fullscreen buttons. Play in landscape.

## Graphics quality

Pick **Low / Medium / High** on the menu (saved to your browser). It defaults to
**Low on phones** and **High on desktop**. Low renders the scene directly — no
post-processing, shadows, reflections, or mirror, at a reduced resolution — so it
stays smooth on mobile GPUs. High adds bloom, colour grading, SMAA, soft
shadows, sky reflections, and the rear-view mirror.

## Track accuracy

- **Layout** — real centerline stitched from the OpenStreetMap circuit relation
  (31 raceway segments: Eau Rouge, Raidillon, Kemmel, Pouhon, Blanchimont, …).
  Measured 6,995 m vs the real 7,004 m (~0.1% error).
- **Elevation** — true heights sampled per track point from the Walloon Region's
  open 50 cm LiDAR terrain model (MNT 2021–2022): 102 m of elevation change,
  including the Eau Rouge compression and the 41 m Raidillon climb.
- **Corner names** — from the OSM segment names, shown live as you drive.

The processed track ships in `src/track.json`, so no network access or data
rebuild is needed to play.

## Physics

Original single-track (bicycle) model at 120 Hz: slip-angle tire forces with a
friction circle, aero downforce and drag, brake/throttle load transfer, tyre
wear and temperature, ERS and DRS effects, a 7-speed gearbox. Assists (on by
default) manage braking points and traction so anyone can lap; turn them off
with **X** for the full challenge.

## Cockpit setup

Press **O** for a live setup panel (saved to your browser): move the steering
wheel in X / Y / Z, and set seat fore/aft, eye height, view pitch, and FOV.

## Credits

- **3D models** (free to use, via Sketchfab):
  [McLaren MCL39](https://sketchfab.com/3d-models/f1-2025-mclaren-mcl39-c6194270002b401bb25be7e35ab56e34)
  (player car) ·
  [F1 W11 steering wheel](https://sketchfab.com/3d-models/f1-steering-wheel-w11-97e6f81365714a78a784c4bc92903b7b).
  Please keep each author's Sketchfab credit when redistributing.
- **Track, forest, and grandstand data** — © OpenStreetMap contributors (ODbL);
  elevation from Service public de Wallonie open geodata.
- **Engine** — [three.js](https://threejs.org/), [Vite](https://vitejs.dev/).

See [CREDITS.md](CREDITS.md) for details.

## Bring your own assets

The large binaries (car/wheel/textures/engine) live in `public/` and are kept
out of the source branch for size — they're bundled at deploy time. Each is
optional and auto-detected; drop in your own to swap:

| File | What it does |
|------|--------------|
| `public/car.glb` | The car (~5.6 m, +Z forward). Name wheel meshes `FL_Wheel`, `FR_Wheel`, `RL_Wheel`, `RR_Wheel` for spin + steering; optional `FL_Cover`/`FR_Cover`. Auto-leveled to the track. |
| `public/wheel.glb` | The cockpit steering wheel; the live LCD composites onto its screen. |
| `public/textures/road.png`, `grass.png` | Tiling tarmac and grass. |
| `public/engine.wav` | Looping engine recording, pitch-shifted with the revs. |

Without them the game falls back to a built-in low-poly car, procedural surfaces,
and a synthesized engine. **Check each asset's license before redistributing.**

## License

Code: MIT (see `LICENSE`). Track geometry derives from OpenStreetMap
(© OpenStreetMap contributors, ODbL) and Service public de Wallonie open geodata.
3D models are credited above under their own Sketchfab licenses.
