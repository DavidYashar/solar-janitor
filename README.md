# Solar System Janitor

A 3D low-gravity salvage arcade game built with [Three.js](https://threejs.org/) and
TypeScript for **Twigpine Project Treetop — Round 01**.

You are the last janitor of Sol. Sweep the junk off **Earth, the Moon and Mars**, haul
every load up to the ISS before your suit oxygen runs out, and spend the credits on
gear. Clean all three worlds to restore the system.

## The loop

- **Sweep.** Walk a surface and vacuum up the junk around you. Your suit holds 8 pieces
  to start, and upgrades raise that.
- **Breathe.** O₂ is the clock, and the lander is the only place to refill it. How far
  you range is your call, not a timer's.
- **Haul.** Take off, fly to the ISS and dock to unload. Credits buy thrusters, tanks,
  a bigger hold and tools; relic tools are hidden in the junk itself.
- **Fly.** Gravity is real. Inside a world's sphere of influence the tug coasts on its
  pull, thrust is an acceleration, and your speed is measured against the orbit you are
  in — so "match the station" is simply flying.

Each world brings its own hazard: meteor showers on the Moon, and dust storms on Mars
that blow in from a different direction every time and push you downwind.

## Controls

| Action | Keyboard |
| --- | --- |
| Move, on foot | mouse steers · `W`/`S` walk · `A`/`D` side-step · `Shift` sprint |
| Move, in flight | the mouse is the nose · `W`/`S` thrust · `←`/`→` strafe · `A`/`D` roll |
| Hop / boost | `Space` |
| Context action — vacuum, take off, land, deliver | `F` |
| Confirm | `Enter` or `Space` |
| Pause / mute | `P` or `Esc` · `M` |

Touch controls appear on mobile. In space the compass ring points at your objective:
the ISS while you are carrying a haul, otherwise the nearest world that still has junk.

## Run it

Requires **Node 22.12 or newer** — Vite 8 will not build below it. Node 24 recommended.

```bash
git clone https://github.com/DavidYashar/solar-janitor.git
cd solar-janitor
npm ci          # install the pinned dependency tree
npm run dev     # serve on http://localhost:5173
```

Open the printed URL and press **NEW SHIFT**.

| Command | What it does |
| --- | --- |
| `npm run dev` | dev server with hot reload |
| `npm test` | 100 headless regression tests |
| `npm run build` | type-check, then build to `dist/` |
| `npm run preview` | serve the production build locally |

There is no `.env`, no API key and no backend — the whole game is a static bundle, and
your progress is saved in the browser's `localStorage`.

## Deploy

`dist/` is a static bundle, so any static host will serve it. [`render.yaml`](./render.yaml)
configures a Render Static Site — build `npm ci && npm run build`, publish `dist`, with
security headers and cache rules included.

Serve it from a **domain root**, not a sub-path: textures and music load from absolute
paths (`/textures/…`, `/music/…`), so a sub-path gives a silently untextured, silent
game rather than a visible error.

## Credits & licences

All code, geometry, terrain, UI and sound effects are original to this project. Almost
everything is generated in code, with five exceptions — photographic tiles in
`public/textures/`: **Earth's ground and foliage, the Moon's ground, and Mars's ground
and stones**. Those are derived from photographs supplied by the project's owner, whose
provenance is the owner's to state; nothing is fetched from a third party for them.

- **Music** — the seven tracks in `public/music/` are from
  [Pixabay](https://pixabay.com/music/), used under the **Pixabay Content Licence**:
  free for commercial and non-commercial use, and attribution is not required (credited
  here anyway). They are not redistributed as standalone files, only as part of this
  game.
- **Planet maps** — Earth's colour, night and cloud maps, and the Moon's, Mars's and the
  Sun's photospheres, in `public/textures/`, are from the **Solar System Scope** texture
  pack, used under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):
  > Textures by [Solar System Scope](https://www.solarsystemscope.com/textures/) — CC BY 4.0.
- **Star map** — `sky_stars.avif` is *Deep Star Maps 2020* from
  [NASA's Scientific Visualization Studio](https://svs.gsfc.nasa.gov/4851/), which is
  public domain, so no licence terms attach to it — the credit belongs there anyway.

No licence has been chosen for this project's own source yet.
