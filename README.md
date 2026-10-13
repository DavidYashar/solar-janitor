# Solar System Janitor

A 3D low-gravity salvage arcade game built with [Three.js](https://threejs.org/) and
TypeScript for **Twigpine Project Treetop — Round 01**. This is the `solar-janitor`
game of the `gameTwitgpine` workspace; the living design document is
[`../orbit-janitor/GAME-PLAN.md`](../orbit-janitor/GAME-PLAN.md).

You are the last janitor of Sol. Sweep the junk off **Earth, the Moon and Mars**,
haul every load up to the ISS before your suit oxygen runs out, and spend the
credits on gear. Clean all three worlds to restore the system.

## Current build — M2 content

- **Progressive world streaming (M3, plan §9).** Every world in the game is
  distance-tiered and generated *while you play*: a **glow impostor** becomes a
  **low-poly globe**, which becomes the hand-painted **detailed globe**; a
  landable surface starts as a smooth **stand-in crust** and refines into the
  full terrain, props and lander pad. All of it is built in bounded slices under
  a per-frame millisecond budget (3 ms; 6.5 ms while a tier the player needs
  *right now* is still missing), so flying at a world never hitches the frame.
  - The queue is ordered by **approach urgency** (`distance − closing × 6 s`),
    so whatever you are boosting at warms first, and landing/docking targets are
    always finished before you get close. Tiers promote at one distance and only
    demote at a wider one, so a ship hovering on a boundary cannot thrash the
    builder; once built, geometry is kept and simply hidden when you leave.
  - `window.__solar.lodStats()` (dev builds) prints the built/shown tier per
    world, the queue depth and the ms spent last frame.

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
  Steered by pointing with the mouse; the arrow keys thrust and side-step.
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
| Surface move | mouse steers (chase camera behind the janitor) · `W`/`↑` walk, `S`/`↓` back, `A`/`D`/`←`/`→` side-step | left stick steers + moves |
| Surface hop / space boost | `Space` | HOP / BOOST |
| Sprint (surface) / boost (space) | `Shift` | — |
| Fly: steer | the mouse is your pointer — the nose follows it | drag the right-hand look pad |
| Fly: thrust | `W`/`S` or `↑`/`↓` | left stick up/down |
| Fly: strafe | `←`/`→` | left stick sideways |
| Fly: roll | `A` / `D` | ROLL ◀ / ROLL ▶ |
| Context action — deposit, take off, land, dock | `F` | ACTION |
| Confirm on menus | `Enter` / `Space` | tap |
| Pause | `P` / `Esc` | PAUSE |
| Mute | `M` | SOUND |

The mouse is your pointer everywhere: on foot the janitor faces it and the
arrows walk relative to it; in flight the nose follows it and the arrows thrust
and side-step. Walking near junk vacuums it up (carry 8 to start). Watch the O₂ bar — the lander
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
npm test          # 72 headless regression tests
npm run build     # strict type-check + production bundle in dist/
npm run preview   # serve the production build
```

## Status & stack

M2 content complete and **browser-verified end-to-end** (12 Oct — landed on all
three worlds, rode out a Mars dust storm, unlocked Storm Sense, bought upgrades,
and saved/continued across a reload, with zero console errors). **M3 LOD
streaming is implemented and headlessly tested (13 Oct); the visual check in a
real browser is still outstanding** — see the box below for the exact steps.

`npm test` green (72 tests: saves, per-planet persistence, hazard behaviour,
quaternion flight maths, upgrade effects, ranks, determinism, a headless full
three-world run, and the LOD scheduler — hysteresis, warm-ahead ordering, the
frame budget, plus the renderer's budget loop driven with a fake scene graph),
`tsc --noEmit` clean and the production build clean (~629 kB JS / 170 kB
gzipped, plus 13 kB CSS and 397 kB of Earth maps — well inside the payload
budget, and *smaller at boot* than before: the space globes and the three
surfaces are no longer generated during startup). Stack: Vite, strict
TypeScript, Three.js, Web Audio, localStorage. Nearly everything is generated in
code: geometry, sounds and — except for Earth — the planet artwork. `src/sim/`
is pure TypeScript with zero three.js or DOM imports, which is what keeps the
whole game testable headlessly.

Performance budget (plan §9): no shadow maps, pixel ratio capped at 1.75 (1.0 in
low-quality mode), 300 particles and 320 dust motes per scene, both starfields
are `Points` clouds (2 200 + 700, allocation-free), and every repeated object —
junk, beacons, relic beams, cargo, trees, boulders, rocks — is an `InstancedMesh`.

## Credits & licences

Earth's colour, night-lights and cloud maps in `public/textures/` are from the
**Solar System Scope** texture pack, used under the
[Creative Commons Attribution 4.0 International licence](https://creativecommons.org/licenses/by/4.0/):

> Textures by [Solar System Scope](https://www.solarsystemscope.com/textures/) — CC BY 4.0.
> You may use, adapt, and share these textures for any purpose, even commercially.

| File | Source | Re-encoded |
|---|---|---|
| `earth_day.webp` | `2k_earth_daymap.jpg` | WebP q88, 2048×1024, 185 kB |
| `earth_night.webp` | `2k_earth_nightmap.jpg` | WebP q88, 2048×1024, 91 kB |
| `earth_clouds.webp` | `2k_earth_clouds.jpg` | greyscale → WebP q80, 1024×512, 121 kB |

The cloud map is greyscale and drives the cloud deck's `alphaMap`. Everything
else in the game — every mesh, every other texture, every sound — is generated
in code. If the maps are missing the globe falls back to its painted canvas, so
the game still runs offline.

### How to check the streaming in a browser (M3)

1. `npm run dev`, open the URL, press START.
2. Take off from Earth and boost to Mars (`window.__solar.teleportTo(2, 1400)` in
   the console jumps you 1 400 u out with a clean approach). Watch the red dot:
   it is a glow, then a flat low-poly sphere around 620 u, then the painted globe
   with its atmosphere around 300 u — each swap settles rather than popping.
3. `window.__solar.lodStats()` prints built/shown tiers, queue depth and ms spent.
   `spendMs` must stay under ~6.5 ms even while two worlds refine at once.
4. Land on Mars: the dust-hazed surface must be complete before the landing
   fade ends (the queue warms it from ~800 u out — `built: "mars-surface": 2`).
5. Fly back out to 2 000 u: tiers demote (geometry stays built, `shown` drops to
   0, the frame cost returns to 0.000 ms).
