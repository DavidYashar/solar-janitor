# Solar System Janitor

A 3D low-gravity salvage arcade game built with [Three.js](https://threejs.org/) and
TypeScript for **Twigpine Project Treetop — Round 01**. This is the `solar-janitor`
game of the `gameTwitgpine` workspace; the living design document is
[`../orbit-janitor/GAME-PLAN.md`](../orbit-janitor/GAME-PLAN.md).

You are the last janitor of Sol. Sweep the junk off **Earth, the Moon and Mars**,
haul every load up to the ISS before your suit oxygen runs out, and spend the
credits on gear. Clean all three worlds to restore the system.

## Current build — M2 content

- **Three landable worlds**, each ~20–24 junk pieces plus one hidden relic:
  Earth (green hills, trees, shores), the Moon (grey crater fields, boulder rims,
  dead rovers, 0.35 g floaty hops) and Mars (rust dunes, broken windmills,
  half-buried probes, 0.45 g).
- **Hazards, all telegraphed:** Moon meteor showers (a shadow circle tightens for
  2.5 s, then the rock lands — being mid-hop clears you) and Mars dust storms
  (every ~45 s: 35 % faster O₂ drain, thick haze, a sideways shove). Earth's ground
  stays safe; its danger is the debris in orbit.
- **Full-freedom flight:** pitch + yaw + roll about the ship's own axes, thrust
  along the facing vector, strongly damped arcade feel with a gentle auto-bank.
- **Relics → tools:** first delivery of each world's relic permanently unlocks
  Eye in the Sky (Earth — the radar tracks every junk piece), Surefoot Stride
  (Moon — +20 % speed, softer landings) and Storm Sense (Mars — hazards telegraph
  3 s earlier). Relics are never sold.
- **Full 14-item ISS catalogue** with working effects: O₂ tanks I & II, recycler
  mask, magboots, grav harness, hazard weave, wide scoop, cargo gloves, junk
  scanner, emergency beacon, thruster kit, nav computer, cargo racks and docking
  assist.
- **Save & continue:** the run autosaves at checkpoints (docking, delivery,
  landing, purchases) and the title screen offers CONTINUE. Versioned, validated
  `localStorage` save — a corrupt or stale save silently falls back to a new shift.
- **Ranks & results:** score, worlds cleaned, junk delivered, best batch, relic
  tools, shift time, and a BRONZE → SILVER → GOLD → PLATINUM → LEGEND rank, with a
  persistent best score.
- **Partial cleanup persists:** junk you leave behind on a world is still there
  when you fly back. Win = every world delivered.
- Touch play is first-class: left stick, look pad, roll paddles and one context
  button whose label follows the situation (DEPOSIT · TAKE OFF · DOCK · LAND ·
  SLOW DOWN TO LAND · SHOP).

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Surface move | `WASD` / arrows (camera-relative) | left stick |
| Surface hop / space boost | `Space` | HOP / BOOST |
| Sprint (surface) / boost (space) | `Shift` | — |
| Fly: thrust | `W` / `S` | left stick up/down |
| Fly: pitch & yaw | mouse (click to lock) or arrows | drag the right-hand look pad |
| Fly: roll | `A` / `D` | ROLL ◀ / ROLL ▶ |
| Context action — deposit, take off, land, dock | `F` | ACTION |
| Confirm on menus | `Enter` / `Space` | tap |
| Pause | `P` / `Esc` | PAUSE |
| Mute | `M` | SOUND |

Walking near junk vacuums it up (carry 8 to start). Watch the O₂ bar — the lander
is the only refill — and the compass ring always points home. In space the compass
points at your objective: the ISS when you are carrying a haul, otherwise the
nearest world that still has junk on it.

Ranks: SILVER 4 000 · GOLD 7 000 · PLATINUM 9 500 · LEGEND 12 000
(plan §5.6 listed career totals; these are tuned so a full three-world run can
actually reach LEGEND).

## Run it

Node 22.12+ (Node 24 recommended). This workspace keeps a portable Node runtime:

```powershell
$env:PATH = "C:\Users\yasha\vsCode\gameTwitgpine\.tools\node-v24.15.0-win-x64;$env:PATH"
$env:npm_config_cache = "C:\Users\yasha\vsCode\gameTwitgpine\.tools\npm-cache"
npm install
npm run dev       # open the printed localhost URL
npm test          # 53 headless simulation regression tests
npm run build     # strict type-check + production bundle in dist/
npm run preview   # serve the production build
```

## Status & stack

M2 content complete — `npm test` green (53 tests: saves, per-planet persistence,
hazard behaviour, quaternion flight maths, upgrade effects, ranks, determinism and
a headless full three-world run), `tsc --noEmit` clean and the production build
clean (~608 kB JS / 162 kB gzipped, plus 13 kB CSS — well inside the payload
budget). Stack: Vite, strict TypeScript, Three.js, Web Audio, localStorage. All
geometry, textures and sounds are generated procedurally in code — no external
assets, no backend, no accounts. `src/sim/` is pure TypeScript with zero three.js
or DOM imports, which is what keeps the whole game testable headlessly.
