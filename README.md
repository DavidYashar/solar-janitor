# Solar System Janitor

A 3D low-gravity salvage arcade game built with [Three.js](https://threejs.org/) and
TypeScript for **Twigpine Project Treetop — Round 01**. This is the `solar-janitor`
game of the `gameTwitgpine` workspace; the living design document is
[`../orbit-janitor/GAME-PLAN.md`](../orbit-janitor/GAME-PLAN.md).

You are the last janitor of Sol. Sweep junk off Earth, haul it to the ISS before
your suit oxygen runs out, and spend your credits on gear. Clean the whole solar
system to win the run.

## Current build — M1 slice

- **Earth surface**: walk the whole sphere, low-gravity hops, vacuum pickup
  (carry 8), the lander refills O₂ and takes deposits into the 30-slot hold, and a
  compass always points home.
- **Space**: Sun, Earth, Moon and the spinning ISS on their orbits; arcade tug
  flight; radar HUD.
- **The loop**: take off → fly → dock at the ISS → deliver for credits and score
  (batch bonuses) → shop upgrades (including the Emergency Beacon) → land and keep
  sweeping. Win = Earth fully cleaned; lose = KO (the Beacon rescues you once).
- Touch support: joystick + one context action button that follows the situation.
- Full-freedom flight (pitch/yaw/roll) and further worlds are planned for M2.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move (surface) / steer (space) | `WASD` / arrows | left stick |
| Hop (surface) | `Space` | HOP |
| Boost (space) | `Shift` | HOP / BOOST |
| Context action — deposit, take off, land, dock | `F` | ACTION |
| Confirm on menus | `Enter` / `Space` | tap |
| Pause | `P` / `Esc` | PAUSE |
| Mute | `M` | SOUND |

Walking near junk vacuums it up. Watch the O₂ bar — the lander is the only refill.

## Run it

Node 22.12+ (Node 24 recommended). This workspace keeps a portable Node runtime:

```powershell
$env:PATH = "C:\Users\yasha\vsCode\gameTwitgpine\.tools\node-v24.15.0-win-x64;$env:PATH"
$env:npm_config_cache = "C:\Users\yasha\vsCode\gameTwitgpine\.tools\npm-cache"
npm install
npm run dev       # open the printed localhost URL
npm test          # 21 headless simulation regression tests
npm run build     # strict type-check + production bundle in dist/
npm run preview   # serve the production build
```

## Status & stack

M1 vertical slice — code complete, `npm test` green (21 tests), production build
passing, and **browser-verified end-to-end** (12 Oct: title → surface sweep →
takeoff → flight → ISS docking → delivery → shop → landing, zero console errors).
Stack: Vite, strict TypeScript,
Three.js, Web Audio, localStorage. All geometry, textures and sounds are generated
procedurally in code — no external assets, no backend, no accounts.
