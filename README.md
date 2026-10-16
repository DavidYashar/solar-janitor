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

- **Three landable worlds**, each ~20–24 junk pieces plus one hidden relic and the
  same concrete launch apron to come down on: Earth (green hills, trees, shores),
  the Moon (a surveyed crater field, a cut trench, a rover's route, 0.35 g floaty
  hops) and Mars (a crater field inside a ring of peaks, half-buried probes,
  0.45 g). The janitor wears his helmet on the worlds with no air and a cap on the
  one with, and his legs stride as he walks.
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

**Gravity is real and invisible** (nothing is drawn for it): every world has a
sphere of influence, and inside it the tug flies like a spacecraft — thrust is an
acceleration, releasing the keys means coasting, and the world pulls you. Slowing
down near a world gets you caught in orbit around it (matching the station's
speed puts you in orbit *with* the station); dive at a world and you keep diving;
fly past fast and you are only deflected. Deep space is unchanged: out there the
tug still parks itself when you let go. Full model and numbers: plan §5.2.1.

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

`npm test` green (82 tests: saves, per-planet persistence, hazard behaviour,
quaternion flight maths, upgrade effects, ranks, determinism, a headless full
three-world run, and the LOD scheduler — hysteresis, warm-ahead ordering, the
frame budget, plus the renderer's budget loop driven with a fake scene graph),
`tsc --noEmit` clean and the production build clean (~686 kB JS / 190 kB
gzipped, plus 13 kB CSS and 397 kB of Earth maps — well inside the payload
budget, and *smaller at boot* than before: the space globes and the three
surfaces are no longer generated during startup). Stack: Vite, strict
TypeScript, Three.js, Web Audio, localStorage. Nearly everything is generated in
code: geometry, sounds and — except for Earth — the planet artwork. `src/sim/`
is pure TypeScript with zero three.js or DOM imports, which is what keeps the
whole game testable headlessly.

Performance budget (plan §9): one 2048² shadow map, and it exists only on a
surface — the space scene draws none; pixel ratio capped at 1.75 (1.0 in
low-quality mode), 300 particles and 320 dust motes per scene, both starfields
are `Points` clouds (2 200 + 700, allocation-free), and every repeated object —
junk, beacons, relic beams, cargo, trees, boulders, rocks — is an `InstancedMesh`.

## Performance: how to tell whether it runs smoothly

A browser never publishes "the maximum power available", so the answer is to
measure what actually happened and hold it against budgets. Press <kbd>`</kbd>
(backquote) in game for the overlay, or call `__solarPerf.report()` from the
console of a **shipped** build — both give the same numbers:

```
 60 fps   median 16.7 ms   p95 16.8   p99 16.9   max 17
jank 0/900   stutter 0   long tasks 2 (128 ms)
heap 37 / 4192 MB
draws 56   tris 25k   tex 12   prog 47
1254x745 @1.75   high   webgl2 true
```

What each one is for:

| Number | Why it matters | Budget |
|---|---|---|
| **p95 / p99 frame time** | the stutter a player actually feels; a mean hides it | p95 ≤ 16.7 ms (60 fps lock), p99 ≤ 33 ms |
| **jank / stutter counts** | frames over 1.5x / 2x the 16.7 ms budget | 0 in steady state |
| **long tasks** | main-thread blocks over 50 ms (Chromium) that freeze input | 0 while playing |
| **heap** | runaway allocation; mobile Safari kills tabs near ~200 MB | ≤ 150 MB |
| **draw calls** | CPU cost of submitting the scene | ≤ 200 |
| **triangles** | GPU vertex cost; this game stays tiny | ≤ 500 k |
| **textures / programs** | VRAM and shader-compile cost | textures ≤ 40, programs ≤ 60 |
| **drawing buffer @ pixel ratio** | fill rate is the usual bottleneck on integrated GPUs | ratio capped at 1.75, 1.0 in low quality |

Measured on this machine (Chromium, 1254x745 buffer, 1.75 ratio) with the
production build:

| Phase | median | p95 | p99 | max | jank | long tasks | heap | draws | tris |
|---|---|---|---|---|---|---|---|---|---|
| cold boot (menu, FCP 364 ms) | 16.7 | 16.8 | 133 | 233 | 2 | 3 | 29 MB | 61 | 31 k |
| cruising between worlds | 16.7 | 16.8 | 16.9 | 33 | 2 | 0 | 32 MB | 49 | 15 k |
| Mars surface, walking | 16.7 | 16.8 | 16.8 | **17** | **0** | **0** | 30 MB | 72 | 25 k |

The only real spikes are the boot (three long tasks, all before the title is
interactive) and the first render of a world. The bootstrap cost is why
`render/scene.ts` warms a surface the moment the streamer finishes building it:
`warmSurface()` compiles its programs and uploads its textures off-screen while
the ship is still on approach, which took the worst landing frame from ~217 ms
to ~66 ms in the dev harness (where every number is worse than production).

Tuning levers, in the order to reach for them: `world.setQuality(true)` (drops
the pixel ratio to 1), the reduced-motion setting (skips the warm-up and all
shake), and the per-world texture resolution (`public/textures` — 3.8 MB for all
twenty-two maps, of which Earth's two ground tiles are the largest single item at
1.7 MB).

## Credits & licences

Earth's colour, night-lights and cloud maps, the Moon's surface, Mars and the
Sun's photosphere — all in `public/textures/` — are from the **Solar System Scope**
texture pack, used under the
[Creative Commons Attribution 4.0 International licence](https://creativecommons.org/licenses/by/4.0/):

> Textures by [Solar System Scope](https://www.solarsystemscope.com/textures/) — CC BY 4.0.
> You may use, adapt, and share these textures for any purpose, even commercially.

| File | Source | Re-encoded |
|---|---|---|
| `earth_day.webp` | `2k_earth_daymap.jpg` | WebP q88, 2048×1024, 185 kB |
| `earth_night.webp` | `2k_earth_nightmap.jpg` | WebP q88, 2048×1024, 91 kB |
| `earth_clouds.webp` | `2k_earth_clouds.jpg` | greyscale → WebP q80, 1024×512, 121 kB |
| `moon_surface.webp` | `2k_moon.jpg` | WebP q85, 1024×512, 138 kB |
| `mars_surface.webp` | `2k_mars.jpg` | WebP q82, 2048×1024, 200 kB |
| `sun_surface.webp` | `2k_sun.jpg` | WebP q82, 2048×1024, 219 kB |

Mars's globe map is orbit-only now: the ground you land on is generated in code
(see below), so the map is never fetched at eye height. The cloud map is greyscale and drives the cloud deck's `alphaMap` — both on the globe and on the sky shell you look up at from the ground. The Moon is
downsampled to 1K because its disc stays under ~370 px on screen even at its
closest approach, so the extra resolution would never be visible. The Sun's map
drives a `MeshBasicMaterial` (the Sun is its own light), and the halo around it
thins as the ship gets close so the photosphere is what you see up close.
Everything else in the game — every mesh, every other texture, every sound — is
generated in code, with two exceptions: **Earth's ground and its plants**. The
ground is two photographs, and both are graded before they ship. Each repeats
hundreds of times across a valley fifteen hundred metres wide, so their low
frequencies are flattened first — a patch of shade would otherwise print itself
at a perfectly regular interval — and their tone is trimmed to sit under the
terrain's vertex colours rather than fight them. The ground is green on the
palette's authority; all the tiles carry is the detail.

| File | Role | Re-encoded |
|---|---|---|
| `earth_grass.webp` | Earth's floor, one tile per 5 m | WebP q92, 1024×1024, 469 kB |
| `earth_grass_normal.webp` | its relief, derived from the same frame | lossless WebP, 512×512, 645 kB |
| `earth_canopy.webp` | the slopes above the treeline, one tile per 16 m | WebP q90, 1024×1024, 298 kB |
| `earth_canopy_normal.webp` | its relief, derived from the same frame | lossless WebP, 512×512, 626 kB |
| `tree_1` … `tree_5` | the five tree species, one cut-out each | WebP q90 with alpha, 331 kB for all five |
| `plant_1` … `plant_7` | bushes and flowers for the undergrowth | WebP q90 with alpha, 454 kB for all seven |

Trees and undergrowth are both placed as **crossed quads** — one image on two
planes at right angles, bottom-anchored so the base meets the ground and scaled
taller than the subject by however much of its tile the subject fills. A single
card would vanish when seen edge-on, and the janitor walks among these. Each quad
is indexed twice, once each way round, so the card is solid from both sides
without `DoubleSide`, which would flip the normal on the back face and leave half
of every subject facing the ground and unlit. Normals point straight up: a plant
cut from a picture already has its shading painted in, so it is lit as ground
rather than as a surface.

The undergrowth is planted two ways, and the difference is the point. Out in the
meadow it goes down in **beds of a single species** — a slope of one flower reads
as planted, massed and deliberate, the way a flower farm looks, where a bed of
everything at once only reads as overgrown. Beside each cottage it goes down as a
**garden**: the same species, but mixed and set in rows at even spacing, jittered
by a hand's breadth so it reads as grown rather than printed. That is the one
place in the valley where the planting is laid out rather than left to scatter.

They are **cut, not blended** — `alphaTest` with alpha-to-coverage — because tens
of thousands of them facing every which way would need a sort order that cannot
exist. That makes the colour in the see-through pixels matter: a mipmap averages
colour and alpha together, so leaving them white grows a pale halo as the subject
shrinks, and at distance it was a scatter of specks around every crown. Each
cut-out is therefore **bled** — the visible colour is pushed outward across the
transparent area before it ships.

The relief is lossless on purpose. A normal map is noise-like — the worst case
for any lossy codec — and at q95 it still carried 12° of mean angular error that
did not improve with quality. Half resolution, losslessly, is both smaller and
correct.

The canopy source was **not** tileable: its opposite edges differed by 3.5× the
typical neighbouring-pixel difference, which is a visible line. It is therefore
blended with its own half-rolls before anything else, so opposite edges are built
from the same source pixels and meet by construction. The seam measured 1.34×
afterwards — better than the grass tile, which arrived tileable.

**Two textures on one mesh.** The terrain is a single sphere under a single
material, so the canopy has to arrive through the shader: `forest` is a per-vertex
mask baked in the same pass that paints the colours — off across the whole valley
floor, on above the treeline, with a noise wobble so the edge is a ragged treeline
rather than a height contour — and the fragment stage mixes the canopy over the
grass by it, colour map and relief map alike. The canopy carries its own UV scale
rather than its own repeat, because a mesh has one set of UVs and the two tiles
are different widths.

Each map loads lazily, only when its world refines to full detail, and if one is
missing the globe falls back to its painted canvas, so the game still runs
offline. Earth's ground tile loads the same way, and if it is missing the field
is merely untextured rather than unbuilt.

**Earth is a valley, and it set its own size.** The reference build is a karst
valley - a flat paddy floor, a meandering river, ten faceted peaks and a layered
range closing the far end - drawn on a 1300 m plane in real metres, with trees
nine to twenty-four metres and turbines a hundred and fifty. It could not be
dropped into a ball of ninety-six metres and stay recognisable, and the numbers
said so: their peaks stand 563 m from the landing pad, and on a 550 m ball their
summits sit ten degrees *below* the horizon, hidden by the curve of the ground
itself. At 700 m you get a twenty-metre smudge; at a kilometre they become
mountains, about a hundred metres of peak standing six degrees above the horizon.
So `EARTH_SURFACE_RADIUS` is 1000, and it is the same size that puts the whole
valley inside forty-two degrees - comfortably clear of the poles, where a
longitude-based mapping would tear.

Everything else scales off that. The terrain grid is ten metres a segment (the
river is forty across, so a channel is four or five vertices and the water ribbon
hides the rest); the river is indexed by z rather than searched, because finding
the nearest point on a 240-segment spline per vertex would be thirty million
operations; and the river bed follows the valley instead of sitting at the
constant height the reference uses, which makes it shoulder-deep in one place and
a gorge in the next. The grass is a canvas tile - blades, clumps, bare earth and
a few flowers - stamped nine times apiece so it repeats without a seam, with the
blades repeated as ridges in the normal map.

**Ten metres a segment is the reason props are placed on the mesh, not on the
curve.** A vertex every ten metres means what you stand on is the flat triangle
between three of them, and the landscape carries detail finer than that grid -
the river's cut bank, the shoulders of the peaks - so the triangle can sit two
and a half metres from the curve it was sampled at. Anything placed on the curve
therefore hangs in the air above the ground that is actually drawn, which is
exactly what the meadow did along the water. Props now walk the same lattice in
the same order with the same split across each quad, which is the only way to ask
the question the renderer answers. It costs one extra height sample per lattice
corner and it is cached, so a bed of twenty plants usually shares four of them.

The same ten metres is why the river needs a keep-out measured from the water
rather than from the line it runs along. The ribbon is drawn to 0.85 of the local
half-width, and the meander widens at every bend, so a fixed distance is either
too small where it curves or needlessly wide everywhere else; bushes and flowers
now stand clear of the actual edge, with three metres to spare.

**Mars is designed, not photographed.** Earth lands on its painted,
vertex-coloured ground on purpose — its lander site sits in open ocean on the
real map — and the Moon has a designed field of its own (below). Mars gets one
laid out in `src/sim/marsfield.ts` in metres and bearings from the landing pad:
fourteen craters placed by hand in the reference build's own vocabulary (a complex
bowl with a peak on its floor, a breached rim you walk in through, eroded and
ghost craters that are barely a ring of shadow, simple bowls between them, plus a
chain of three strung along one bearing) inside a continuous ring of peaks. The
globe in orbit still wears its photograph; what you stand on is a place. The seed
moves the grain and nothing else, so the landscape the janitor learns is the same
one every run.

**The world is sized by what you can see over the curve.** Mars's landing site is
a ball of radius 96, so the ground goes over the horizon 19.6 m from your boots and
a point `d` metres out is hidden unless it stands `(d − 19.6)² / 192` above the
pad. That relationship drives everything: the floor is a shallow saucer, because a
flat plain on a ball this size is a disc twenty metres across with the sky behind
it, and the ring sits at 73–139 m with crests of 49–83 m, which is what a mountain
has to be to appear on the skyline at all.

The ball's size is also the field's size, and that is the only reason the world is
this big: at radius 55 the ground you could work was forty metres across, and a
ring far enough out to hold more would have had to be taller than the ball it
stands on. At 96 the field is 73 m — three times the ground, bounded by mountains
on every bearing. The landscape itself is written for a radius-55 ball and
multiplied once by `SURFACE_SCALE`, which is what keeps its proportions: a crater
stays in scale with the field around it, the bowl keeps a slope you can walk, and
the ring keeps its place on the skyline.

The ground itself is a canvas, and a deliberately small one. At two metres the eye
magnifies whatever is under it by tens of times, so the only thing worth putting
in a texture is what is smaller than a boot: a six-metre tile holding gravel at
170 texels to the metre, repeating far too often at ground level for the eye to
catch it doing so. Anything larger than a boot lives in the vertex colours
instead, where a segment is 2.7 m. The stones are stamped nine times apiece so the
tile repeats without a seam — the reference build drew its stones once and let the
canvas edge clip them, which prints a line of half-stones across the ground at
every tile. The same pass draws the stones a second time as bare domes, and a
Sobel over those becomes the normal map. Relief has to come from somewhere: colour
cannot carry it at eye height, and all a painted shadow can do two metres off the
ground is look painted.

**The sky has something in it now.** The sun is a disc rather than a smudge. The
real one is 0.53° across and it is drawn at three times that, because at the sizes
this camera runs at anything smaller stops reading as a disc and starts reading as
a speck — and inside a wide aureole it has to hold its own against its own light.
Around it: a wide aureole, a crown of spikes turning against itself, and a
line of lens ghosts hung on the frame's own centre line.

The aureole is blended, not added, and that is the whole reason it has a colour.
Added light can only end up white — the sky behind the sun is already near the top
of its range, so red, green and blue all clip and the sun comes out a colourless
hole with a bright rim. Letting the aureole *cover* the sky instead is the only way
it can be the pale yellow you actually see looking up from Earth, so the sprite
carries an opaque lemon core that thins outward and lets the sky back in. The hue
lives in one per-world tint: Earth pale yellow, Mars orange, the Moon white,
because a world with no air has nothing to colour it.

The spikes start just outside the core rather than at the middle of the sprite. A
fan converging on a point stacks its own alpha there, and the additive pile-up
whitened the aureole from the inside out; moving the rays' inner stop out by 5% of
their reach keeps the core gold. Only the sun draws after the cloud deck —
otherwise the clouds, which are nearer, are drawn over the top of it and take a
quarter of its light away. Terrain still hides it, because terrain is opaque and
writes depth and the clouds do not.

Cloud is the Earth's own cloud map wrapped on a shell between the valley and the
sky dome — the same equirectangular map that skins the globe, seen from the inside,
where it becomes a sky you can look up at. The deck drifts the opposite way to the
dome, so the sky is not one rigid thing.

Looking up is the pointer's job, and it was the one control the surface camera
never had. The pointer's height tips the view by raising the point the camera
looks at and drawing the camera back as it goes: swinging the camera down instead
would only drive it into the ground behind him, and without the draw-back a
look-up becomes a first-person view of the sky with the janitor gone from his own
game.

**The Moon is a real place, and it is measured in metres.** Earth and Mars are
drawn for the size of ball they sit on, but the Moon's landscape was authored as
ground: a 380 m playfield of craters from one metre to forty-six, an 18 m trench
5.5 m deep, two mounds with a boulder valley between them, a rover's route and a
trodden path up through the saddle. Carried onto the old 96 m ball it would have
come out as a knot, so the Moon carries a radius of its own — 800 m, one unit to
the metre, the number the field was written in. The ground then goes over the
horizon 52 m from your boots, which is what puts the far crater rims on your
skyline instead of behind it.

The port is verified rather than eyeballed: 40 401 sample points across the field
agree with the reference to 0.000000 m. That check earns its keep, because the
generator's random stream is order-critical — its draws are consumed in sequence,
so inserting or dropping a single roll re-rolls every crater after it, and dropping
one `fresh` roll moved a crater 22 m before the diff caught it. Two rules follow. A
new crater population goes on the *end* of the list, so the draws already made are
undisturbed; and anything per-crater comes from a hash of the crater's own index
rather than from the stream.

**The craters are shaped, not round.** Each is a wobbled ellipse — an independent
semi-axis each way, plus three harmonics on the rim radius — sized from that
separate hash, so the reference's craters keep their exact positions and depths
while their outlines stop being circles. Three further populations were appended
afterwards, because a real regolith plain is mostly small holes: ninety at 22–46 m,
four hundred and thirty at 6–16 m, and fifteen hundred at 1.1–3.6 m.

**Six metres a segment, and the trench is why.** The Moon samples the field twice
as finely as Earth (838 × 419 segments, still one mesh and one draw call). The test
of that choice is the cut: four vertices across a feature 18 m wide and 5.5 m deep
is exactly the case a coarse grid would quietly fill in. Sampled along its
cross-section, it does not — the floor lands within 0.25 m of the curve and the
drawn surface never stands more than 1.9 m above it. What the grid cannot hold is
the trench's own wall, which comes out as a 6 m step rather than a slope; from the
rim that reads as a cut, and the near wall throws the floor into full shadow, which
is what a fall hazard should look like.

**The Moon's sun is solved for, not chosen.** The sun sprite sits 4 800 units out,
only six Moon radii, so its apparent height and its apparent bearing are a coupled
pair: move the landing site to raise the sun and you turn it as well. The look
being matched is a raking 22.2° sun, because long hard shadows are most of that
picture, so the site was found by search rather than picked by eye — 0.171 rad
north, 0.106 rad west is the ground nearest the equator that gives that elevation.
Two other things follow from the Moon having no air. The starfield is drawn here and
nowhere else in the game, and its sphere had to grow with the world: at the old
radius the stars were *inside* the ground. And the Earth hangs in the sky above it,
a lit marble three degrees wide at the bearing the geometry gives it.

**On an airless world the shadows are the landscape.** Every crater wall is a
silhouette and the sun is twenty-two degrees up, so the floors that never see the
sun are most of what the surface is. The catch is that the terrain is a single mesh
whose bounds are the whole ball, so it can never be frustum-culled out of the
shadow pass and every one of its triangles is submitted every frame — the kind of
cost worth measuring rather than assuming in either direction. Over 380 frames at
the surface the median frame is 17.3 ms with the terrain casting and 17.0 ms
without, and the p99 no worse. It stays. Earth's terrain still does not cast: its
hills are gentle, it has air, and at that light the silhouette costs more than it
buys.

**Every world lands on the same apron.** It is a helipad, because that is what a
landing pad looks like from above, and all three worlds wear one: a touchdown deck
at the middle, a ring of hazard chevrons warning you off its edge, and the markings
running out through concrete and bitumen to a yellow safety ring and a last band of
concrete outside that. The bands sit at the fractions of the radius they occupy in
the reference photograph — the yellow at 0.77 to 0.85, the outer concrete from 0.85
out — so the proportions are the reference's rather than invented here. It is one
texture over one disc rather than a mesh per ring, because every one of those bands
is paint on a flat surface and drawing them as geometry would cost a draw call each
and z-fight with the ground between them.

**It is flush, and that is the one place the game overrules the reference.** The
janitor's height comes from the terrain function, not from the geometry he can see,
so a raised deck would be something he walked through rather than onto — and a
0.5 m step is not representable at all when the ground is sampled every ten metres.
What buys the flatness instead is the apron: `PAD_APRON` is the same on all three
worlds, it levels the ground within 15 m of the pad's own height and blends back
into the landscape by 25, and it has to clear `PAD_RADIUS` with room to spare
because what the mesh draws is a triangle between vertices up to six metres apart
and the last of those can straddle the edge. Flattening that much changes each
world by less than a metre: Earth's pad keeps 83 m of clearance from the river at
its widest, and Mars's ring of peaks starts at 73 m and is never reached.

The disc is then built onto the ground rather than onto a plane, one vertex at a
time, by asking the terrain where the ground is. A flat disc cannot work: the apron
is a cap on a ball, so its edge would sink `r²/2R` below the ground it is laid on —
seven centimetres on Earth, and three quarters of a metre on Mars, where the ball is
ninety-six metres. Its rings of railing are chords between posts rather than
circles for the same reason. The touchdown deck is wider than the reference's,
because what lands on it is a ship whose legs are four and a half metres apart
rather than a helicopter on a pad built for a fleet, and the rail has a gate in it
on the one bearing with nothing parked on it — there is no collision in this game,
and a fence the janitor crosses every time he leaves is worse than a fence with a
way through. Rubble and rock now keep off the concrete too, on every world: the
apron is the one place the last crew clearly swept.

**The janitor is a skeleton now, because a walk needs somewhere to hinge.** He
used to be a pile of solids at fixed offsets, which meant the only thing that
could move was all of him; his hip, knee, shoulder and torso are groups now, so
his legs stride, his arms counter-swing and his body carries the weight with a
bob on every step and a lean that grows with speed. The stride is wound off
*distance travelled* rather than off time — a rate-in-seconds walk is fine at four
metres a second and has him skating at seven, which is the sprint — and it eases
in and out through a gait value, because a figure that snaps from a full stride to
standing still is worse than one that never walked at all. Off the ground his legs
tuck instead.

The detail is real but the draw calls are not. A figure with a chest plate, belt
and pouches, shoulder straps, a pack with tanks, knee pads, gloves and a boot with
a sole and a toe cap is thirty-odd small solids, and thirty-odd solids would be
thirty-odd draw calls and as many again into the shadow pass, for something two
metres tall. So each limb's pieces are baked into one buffer per colour before they
reach the scene: geometry copied, placed and concatenated. Only position and normal
survive the bake, because none of these materials has a map and there is nothing for
a UV to do. What was 13 meshes and two draw calls' worth of shading is now a rig
that costs fourteen more calls than the old figure did.

**What he wears depends on where he is.** Earth has an atmosphere, so on Earth he
is a man in a jumpsuit with a cap on; the Moon and Mars have none, so there the cap
is a helmet and the shell is the only thing between him and nothing. The visor does
not cast a shadow — it is a third opaque, and a shell of glass would drop a solid
black ball over his head — so for once the thing you would most want to be right is
also the thing that must stay out of the shadow map.

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
