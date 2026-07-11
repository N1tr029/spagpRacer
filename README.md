# Ardennes GP — Spa-Francorchamps Time Trial

A browser racing game on the real Circuit de Spa-Francorchamps, built with
Three.js and open data. Chase the delta, beat your best lap.

All code and built-in art are original. The game is not affiliated with and
contains no assets from Formula 1, F1 25, EA, or Codemasters. Optional
drop-in slots let you play with your own car model, steering wheel, track
textures, and engine audio (see **Bring your own assets**).

## Quick start

```bash
npm install
npm run dev        # open the printed localhost URL
```

Press any key to start your engine.

## Controls

| Key | Action |
|-----|--------|
| W / ↑ | Throttle |
| S / ↓ | Brake |
| A, D / ← → | Steer |
| C | Camera: chase → cockpit → nose |
| L | Racing line on/off |
| X | Assists (auto-brake + traction) on/off |
| R | Reset to track |
| M | Mute |

Lap timing starts at the finish line. LAST/BEST and a live delta to your
best lap show top-left; corner names flash as you reach them.

## Track accuracy

- **Layout** — real centerline stitched from the OpenStreetMap circuit
  relation (31 raceway segments: Eau Rouge, Raidillon, Kemmel, Pouhon,
  Blanchimont, …). Measured 6,995 m vs the real 7,004 m (~0.1% error).
  Map data © OpenStreetMap contributors, ODbL.
- **Elevation** — true heights sampled per track point from the Walloon
  Region's open 50 cm LiDAR terrain model (MNT 2021–2022,
  geoservices.wallonie.be): 102 m of real elevation change, including the
  Eau Rouge compression and the 41 m Raidillon climb.
- **Corner names** — from the OSM segment names, shown live as you drive.

The processed track (centerline, widths, elevation, corner names) ships in
`src/track.json`, so no network access or data rebuild is needed to play.

## Physics

Original single-track (bicycle) model at 120 Hz: slip-angle tire forces with
a friction circle, aero downforce and drag, brake/throttle load transfer,
7-speed gearbox. Assists (on by default) manage braking points and traction
so anyone can lap; turn them off with X for the full challenge. Off-track
excursions cost grip; barriers are soft.

Onboard extras: cockpit camera under the halo with animated steering wheel
and live LCD, rubbered-in racing groove, armco with catch fencing, painted
runoff, grandstand, gantries, brake markers, live minimap, and
delta-to-best timing at every 4 m checkpoint.

## Bring your own assets

The game works fully with its built-in low-poly car, procedural wheel,
painted track, and synthesized V6 engine. Drop any of these files into
`public/` to upgrade the look and sound — each is optional and auto-detected:

| File | What it does |
|------|--------------|
| `public/car.glb` | Replaces the built-in car (~5.6 m long, +Z forward). Name wheel meshes `FL_Wheel`, `FR_Wheel`, `RL_Wheel`, `RR_Wheel` to get spin + steering; optional `FL_Cover`/`FR_Cover` aero covers steer without spinning. |
| `public/wheel.glb` | Replaces the procedural steering wheel in cockpit view; the live LCD is composited onto its screen area. |
| `public/textures/road.png` | Tiling asphalt for the track ribbon. |
| `public/textures/grass.png` | Tiling grass for shoulders and terrain. |
| `public/engine.wav` | Looping engine recording, pitch-shifted with the revs (replaces the synth). |

Sketchfab and similar sites have downloadable F1-style cars and wheels;
free engine loops exist on freesound.org. **Check each asset's license
yourself** — most model licenses allow personal use but not redistribution,
which is why none are included here.

## License

Code: MIT (see `LICENSE`). Track geometry derives from OpenStreetMap
(© OpenStreetMap contributors, ODbL) and Service public de Wallonie open
geodata.
