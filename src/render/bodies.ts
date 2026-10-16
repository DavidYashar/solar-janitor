import * as THREE from 'three'
import { SPACE_SCALE, TAU } from '../sim/config.ts'
import { planetById } from '../sim/planets.ts'
import { canvasBuild, canvasTexture, finishTexture, glowTexture } from './surfaces.ts'

/**
 * The three space-map worlds (plan §9). Each one starts life as a glow
 * impostor, becomes a flat low-poly sphere as the janitor takes an interest and
 * only then builds its detailed globe — and the expensive part (a hand-painted
 * canvas texture, an atmosphere shell, a cloud deck) is generated a slice at a
 * time, so flying at a planet never hitches.
 *
 * The bodies only fill in *content*: the groups that get positioned in the
 * space scene every frame stay in `scene.ts`, so the Earth-local ISS maths and
 * the world-space Moon and Mars are untouched.
 */

export interface SpaceBody {
  id: number
  /** group that carries the body through the space map */
  root: THREE.Group
  /** tier 0: the impostor every body starts as */
  glow: THREE.Sprite
  /** name plate; labels are cheap and never tiered */
  labels: THREE.Sprite[]
  /** tier 1: a flat low-poly globe, created on demand */
  makeLowTier(): THREE.Mesh
  /** tier 2: the detailed globe, generated across frames into the given group */
  detailBuilder(into: THREE.Group): Generator<void, void, void>
  /** spin whatever detail exists right now (clouds, moonlets) */
  spin(dt: number): void
}

/** A detail object that turns by itself once it exists. */
interface Spinner {
  object: THREE.Object3D
  rate: number
}

/** A name plate: a rounded dark pill with a bright caption. */
export function makeLabel(text: string, color = '#dff2ff'): THREE.Sprite {
  const texture = canvasTexture(320, 96, ctx => {
    ctx.fillStyle = 'rgba(5, 12, 24, 0.62)'
    ctx.beginPath()
    ctx.roundRect(8, 18, 304, 60, 14)
    ctx.fill()
    ctx.strokeStyle = 'rgba(160, 220, 255, 0.35)'
    ctx.lineWidth = 3
    ctx.stroke()
    ctx.font = '700 40px "Segoe UI", system-ui, sans-serif'
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 160, 49)
  })
  return new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }),
  )
}

function rgba(hex: number, alpha: number): string {
  const r = (hex >> 16) & 0xff
  const g = (hex >> 8) & 0xff
  const b = hex & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Every body's impostor is the same idea: a soft halo in its own colour. */
function buildGlow(id: number): THREE.Sprite {
  const planet = planetById(id)
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(rgba(planet.atmosphere, 0.38), rgba(planet.atmosphere, 0)),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  glow.scale.setScalar(planet.spaceRadius * 4.2)
  return glow
}

/** The 2:1 photograph a world wears in orbit. */
function bodyMap(id: number): MapSlot {
  if (id === 0) return earthMapSet().day
  if (id === 1) return moonMapSet()
  return marsMapSet()
}

/**
 * Start every world's globe map loading now, rather than when something first flies at
 * it. The set is 735 kB in total and all of it has to be fetched eventually, so the only
 * thing this changes is when - and what it buys is that a world is wearing its own
 * photograph by the time you are close enough to see it. `createWorld` calls this once.
 */
export function warmBodyMaps() {
  earthMapSet()
  moonMapSet()
  marsMapSet()
}

/**
 * The stand-in for a world that is still far away: the same photograph the full globe
 * wears, on a coarser sphere.
 *
 * It used to be a flat colour under flat shading - a faceted ball - which is exactly
 * what "the planet is only its raw shape until you get close" looked like. The map is a
 * couple of hundred kilobytes, so the stand-in wears it too; the only thing left to give
 * it away is the coarseness of the sphere it sits on.
 */
function buildLowTier(id: number): THREE.Mesh {
  const planet = planetById(id)
  const map = bodyMap(id)
  const material = new THREE.MeshStandardMaterial({
    color: planet.spaceColor, roughness: 0.92, metalness: 0,
  })
  whenReady(map, () => {
    material.map = map.texture
    material.color.setHex(0xffffff)
    material.roughness = 0.82
    material.needsUpdate = true
  })
  return new THREE.Mesh(new THREE.SphereGeometry(planet.spaceRadius, 32, 24), material)
}

/**
 * An atmosphere, seen from outside: a shell that glows where you are looking through
 * the most of it.
 *
 * It used to be a `BackSide` sphere painted one flat colour additively, which draws a
 * ring with a hard outer edge at the shell's silhouette — the "sticker" look. Two
 * things were wrong with it, and this fixes both.
 *
 * **The falloff.** What you actually look through, for a ray passing a globe at impact
 * parameter `b`, is a chord of length `sqrt(shell² - b²)`: longest right at the planet's
 * limb, zero at the shell's edge. So the fragment shader measures `b` — the distance
 * from the globe's centre to the ray the camera is looking along — and takes the glow
 * from that, which fades to nothing at the shell instead of stopping. It is the one
 * measurement a shell cannot fake from its own normals, because a fragment's normal is
 * the same all the way round the limb.
 *
 * **The terminator.** Air glows because sunlight scatters in it, and that only happens
 * on the day side; a flat ring is the same brightness at midnight, which is what made
 * it read as a drawn circle rather than as air. The glow is scaled by how far round
 * from the sub-solar point the piece of shell is, with a soft terminator and a floor
 * so the night limb keeps a thin rim. No uniform is needed for this: the Sun is at
 * the world origin, so the direction from a planet to it is that planet's own position
 * negated, which the vertex shader can hand down.
 *
 * Additive and depth-write-off, so a globe behind it is not occluded by its own air
 * and the night-side hull is not washed out.
 */
function buildAtmosphere(id: number, scale: number): THREE.Mesh {
  const planet = planetById(id)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(planet.atmosphere) },
      planetRadius: { value: planet.spaceRadius },
      shellRadius: { value: planet.spaceRadius * scale },
      strength: { value: 0.85 },
      falloff: { value: 2.6 },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying vec3 vCentre;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vCentre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 glowColor;
      uniform float planetRadius;
      uniform float shellRadius;
      uniform float strength;
      uniform float falloff;
      varying vec3 vWorld;
      varying vec3 vCentre;
      void main() {
        // How much air this line of sight passes through, as the distance from the
        // planet's centre to the ray the camera is looking along to reach this fragment.
        //
        // It has to be measured against the CENTRE and not against the view direction to
        // the fragment itself - that second thing is the same vector as the ray, so the
        // perpendicular component of it against itself is zero and every fragment comes
        // out at an impact parameter of nothing. Which is not a falloff at all: it draws
        // the flat hard-edged ring this whole shader exists to get rid of.
        vec3 ray = vWorld - cameraPosition;
        vec3 view = normalize(ray);
        vec3 toCentre = vCentre - cameraPosition;
        vec3 nearest = cameraPosition + view * dot(toCentre, view);
        float impact = length(vCentre - nearest);
        float span = max(1e-3, shellRadius - planetRadius);
        float thickness = 1.0 - clamp((impact - planetRadius) / span, 0.0, 1.0);
        // and whether that air is in daylight
        vec3 outward = normalize(vWorld - vCentre);
        vec3 toSun = normalize(-vCentre);
        float day = smoothstep(-0.42, 0.38, dot(outward, toSun));
        float alpha = strength * pow(thickness, falloff) * mix(0.14, 1.0, day);
        if (alpha <= 0.002) discard;
        gl_FragColor = vec4(glowColor, alpha);
      }
    `,
    transparent: true,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  return new THREE.Mesh(new THREE.SphereGeometry(planet.spaceRadius * scale, 48, 32), material)
}

// ---------------------------------------------------------------- textures

/**
 * Photographic 2:1 maps shipped in `public/textures`, credited in the README.
 * They load in the background; the painted canvas goes up first and each
 * material upgrades to the photograph the moment it lands, so nothing waits on
 * the network and anything that never arrives simply stays painted.
 */
interface MapSlot {
  texture: THREE.Texture
  ready: boolean
  failed: boolean
  pending: (() => void)[]
}

export function loadMap(url: string, anisotropy = 4, srgb = true): MapSlot {
  const slot: MapSlot = { ready: false, failed: false, pending: [], texture: null as unknown as THREE.Texture }
  slot.texture = new THREE.TextureLoader().load(
    url,
    () => {
      slot.ready = true
      for (const apply of slot.pending) apply()
      slot.pending.length = 0
    },
    undefined,
    () => { slot.failed = true },
  )
  // a bump map carries directions, not colour, so it must not be sRGB-decoded
  if (srgb) slot.texture.colorSpace = THREE.SRGBColorSpace
  slot.texture.anisotropy = anisotropy
  return slot
}

/** Run `apply` now if the map is already in, otherwise when it lands. */
export function whenReady(slot: MapSlot, apply: () => void) {
  if (slot.ready) apply()
  else if (!slot.failed) slot.pending.push(apply)
}

interface EarthMaps {
  day: MapSlot
  night: MapSlot
  clouds: MapSlot
}

let earthMaps: EarthMaps | null = null

/** Kick the Earth maps off once and share them between detail rebuilds. */
function earthMapSet(): EarthMaps {
  if (!earthMaps) {
    earthMaps = {
      day: loadMap('/textures/earth_day.webp'),
      night: loadMap('/textures/earth_night.webp'),
      clouds: loadMap('/textures/earth_clouds.webp', 2),
    }
  }
  return earthMaps
}

let moonMap: MapSlot | null = null

/** The Moon is a third of Earth's size on screen, so one 1K map covers it. */
function moonMapSet(): MapSlot {
  if (!moonMap) moonMap = loadMap('/textures/moon_surface.webp', 2)
  return moonMap
}

let marsMap: MapSlot | null = null

/** Mars is nearly Earth-sized on screen when landing, so it gets the full 2K. */
function marsMapSet(): MapSlot {
  if (!marsMap) marsMap = loadMap('/textures/mars_surface.webp')
  return marsMap
}

// ------------------------------------------------------------------- earth

function* earthDetail(id: number, into: THREE.Group, spun: Spinner[]): Generator<void, void, void> {
  const planet = planetById(id)
  const maps = earthMapSet()
  const base = canvasBuild(512, 256, 991)
  const ctx = base.ctx
  const rnd = base.rnd
  if (ctx) {
    const ocean = ctx.createLinearGradient(0, 0, 0, 256)
    ocean.addColorStop(0, '#1d4f9c')
    ocean.addColorStop(0.5, '#2f7fd0')
    ocean.addColorStop(1, '#1b4a8f')
    ctx.fillStyle = ocean
    ctx.fillRect(0, 0, 512, 256)
  }
  yield

  for (let blob = 0; blob < 22; blob++) {
    const cx = 30 + rnd() * 452
    const cy = 40 + rnd() * 176
    const scale = 0.5 + rnd() * 1.1
    const tint = rnd() < 0.35 ? '#8fbf5a' : '#3f9a52'
    if (ctx) ctx.fillStyle = tint
    for (let piece = 0; piece < 9; piece++) {
      const angle = rnd() * TAU
      const distance = rnd() * 34 * scale
      const radius = (8 + rnd() * 20) * scale
      const rotation = rnd() * TAU
      if (!ctx) continue
      ctx.beginPath()
      ctx.ellipse(
        cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance,
        radius, radius * 0.7, rotation, 0, TAU,
      )
      ctx.fill()
    }
    if ((blob + 1) % 4 === 0) yield
  }

  if (ctx) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
    ctx.fillRect(0, 0, 512, 18)
    ctx.fillRect(0, 238, 512, 18)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
  }
  for (let i = 0; i < 40; i++) {
    const x = rnd() * 512
    const y = 30 + rnd() * 196
    const rx = 10 + rnd() * 26
    const ry = 4 + rnd() * 7
    const rotation = rnd() * TAU
    if (!ctx) continue
    ctx.beginPath()
    ctx.ellipse(x, y, rx, ry, rotation, 0, TAU)
    ctx.fill()
  }
  yield

  // the painted globe goes up immediately; the photograph replaces it on arrival
  const globeMaterial = new THREE.MeshStandardMaterial({
    map: finishTexture(base.canvas), roughness: 0.92, metalness: 0,
  })
  whenReady(maps.day, () => {
    globeMaterial.map = maps.day.texture
    globeMaterial.roughness = 0.82
    globeMaterial.needsUpdate = true
  })
  whenReady(maps.night, () => {
    globeMaterial.emissive = new THREE.Color(0xffffff)
    globeMaterial.emissiveMap = maps.night.texture
    globeMaterial.emissiveIntensity = 2.6
    globeMaterial.needsUpdate = true
  })
  into.add(new THREE.Mesh(
    new THREE.SphereGeometry(planet.spaceRadius, 64, 48),
    globeMaterial,
  ))
  yield
  const cloudCanvas = canvasBuild(512, 256, 991)
  const cloudCtx = cloudCanvas.ctx
  const cloudRnd = cloudCanvas.rnd
  if (cloudCtx) {
    cloudCtx.clearRect(0, 0, 512, 256)
    cloudCtx.fillStyle = 'rgba(255, 255, 255, 0.72)'
  }
  for (let cluster = 0; cluster < 90; cluster++) {
    const cx = cloudRnd() * 512
    const cy = 20 + cloudRnd() * 216
    for (let piece = 0; piece < 6; piece++) {
      const x = cx + (cloudRnd() - 0.5) * 40
      const y = cy + (cloudRnd() - 0.5) * 18
      const rx = 6 + cloudRnd() * 20
      const ry = 3 + cloudRnd() * 8
      if (!cloudCtx) continue
      cloudCtx.beginPath()
      cloudCtx.ellipse(x, y, rx, ry, 0, 0, TAU)
      cloudCtx.fill()
    }
    if ((cluster + 1) % 18 === 0) yield
  }
  yield

  const cloudMaterial = new THREE.MeshStandardMaterial({
    map: finishTexture(cloudCanvas.canvas),
    transparent: true, opacity: 0.82, depthWrite: false, roughness: 1,
  })
  // the real cloud deck is a greyscale map: it drives alpha over white
  whenReady(maps.clouds, () => {
    cloudMaterial.map = null
    cloudMaterial.color.setHex(0xffffff)
    cloudMaterial.alphaMap = maps.clouds.texture
    cloudMaterial.opacity = 0.92
    cloudMaterial.needsUpdate = true
  })
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(planet.spaceRadius + 0.35 * SPACE_SCALE, 48, 32),
    cloudMaterial,
  )
  into.add(clouds, buildAtmosphere(id, 1.13))
  spun.push({ object: clouds, rate: 0.014 })
  yield
}

// -------------------------------------------------------------------- moon

function* moonDetail(id: number, into: THREE.Group, _spun: Spinner[]): Generator<void, void, void> {
  const planet = planetById(id)
  const maps = moonMapSet()
  const base = canvasBuild(256, 128, 991)
  const ctx = base.ctx
  const rnd = base.rnd
  if (ctx) {
    ctx.fillStyle = '#b9bfc9'
    ctx.fillRect(0, 0, 256, 128)
  }
  yield

  for (let crater = 0; crater < 60; crater++) {
    const x = rnd() * 256
    const y = rnd() * 128
    const radius = 2 + rnd() * 9
    const red = 120 + rnd() * 40
    const green = 126 + rnd() * 40
    const blue = 140 + rnd() * 40
    if (ctx) {
      ctx.fillStyle = `rgba(${red | 0}, ${green | 0}, ${blue | 0}, 0.75)`
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, TAU)
      ctx.fill()
      ctx.strokeStyle = 'rgba(236, 240, 248, 0.5)'
      ctx.lineWidth = 1.4
      ctx.stroke()
    }
    if ((crater + 1) % 15 === 0) yield
  }

  // painted craters go up immediately, then the real surface replaces them
  const globeMaterial = new THREE.MeshStandardMaterial({ map: finishTexture(base.canvas), roughness: 1 })
  whenReady(maps, () => {
    globeMaterial.map = maps.texture
    globeMaterial.roughness = 0.96
    globeMaterial.needsUpdate = true
  })
  into.add(new THREE.Mesh(
    new THREE.SphereGeometry(planet.spaceRadius, 48, 36),
    globeMaterial,
  ))
  yield
}

// -------------------------------------------------------------------- mars

function* marsDetail(id: number, into: THREE.Group, spun: Spinner[]): Generator<void, void, void> {
  const planet = planetById(id)
  const maps = marsMapSet()
  const base = canvasBuild(512, 256, 991)
  const ctx = base.ctx
  const rnd = base.rnd
  if (ctx) {
    ctx.fillStyle = '#a34a2b'
    ctx.fillRect(0, 0, 512, 256)
  }
  yield

  for (let blob = 0; blob < 26; blob++) {
    const red = 86 + rnd() * 34
    const green = 42 + rnd() * 22
    const blue = 28 + rnd() * 18
    const cx = rnd() * 512
    const cy = 30 + rnd() * 196
    if (ctx) ctx.fillStyle = `rgba(${red | 0}, ${green | 0}, ${blue | 0}, 0.55)`
    for (let piece = 0; piece < 7; piece++) {
      const x = cx + (rnd() - 0.5) * 74
      const y = cy + (rnd() - 0.5) * 52
      const rx = 16 + rnd() * 46
      const ry = 10 + rnd() * 26
      const rotation = rnd() * TAU
      if (!ctx) continue
      ctx.beginPath()
      ctx.ellipse(x, y, rx, ry, rotation, 0, TAU)
      ctx.fill()
    }
    if ((blob + 1) % 5 === 0) yield
  }

  for (let streak = 0; streak < 20; streak++) {
    const red = 216 + rnd() * 34
    const green = 148 + rnd() * 44
    const blue = 104 + rnd() * 34
    const x = rnd() * 512
    const y = 20 + rnd() * 216
    const rx = 22 + rnd() * 72
    const ry = 8 + rnd() * 22
    const rotation = rnd() * 0.7
    if (ctx) {
      ctx.fillStyle = `rgba(${red | 0}, ${green | 0}, ${blue | 0}, 0.26)`
      ctx.beginPath()
      ctx.ellipse(x, y, rx, ry, rotation, 0, TAU)
      ctx.fill()
    }
    if ((streak + 1) % 7 === 0) yield
  }

  if (ctx) {
    ctx.fillStyle = 'rgba(242, 247, 255, 0.92)'
    ctx.fillRect(0, 0, 512, 13)
    ctx.fillRect(0, 243, 512, 13)
    ctx.fillStyle = 'rgba(242, 247, 255, 0.45)'
  }
  for (let i = 0; i < 26; i++) {
    const x = rnd() * 512
    const y = 6 + rnd() * 14
    const rx = 14 + rnd() * 28
    const ry = 4 + rnd() * 8
    const x2 = rnd() * 512
    const y2 = 236 + rnd() * 14
    const rx2 = 14 + rnd() * 28
    const ry2 = 4 + rnd() * 8
    if (!ctx) continue
    ctx.beginPath()
    ctx.ellipse(x, y, rx, ry, 0, 0, TAU)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(x2, y2, rx2, ry2, 0, 0, TAU)
    ctx.fill()
  }
  yield

  // painted Mars goes up immediately, then the real surface replaces it
  const globeMaterial = new THREE.MeshStandardMaterial({ map: finishTexture(base.canvas), roughness: 0.96, metalness: 0 })
  whenReady(maps, () => {
    globeMaterial.map = maps.texture
    globeMaterial.needsUpdate = true
  })
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(planet.spaceRadius, 64, 48),
    globeMaterial,
  )
  into.add(globe)
  spun.push({ object: globe, rate: 0.02 })
  yield

  // Phobos and Deimos, two lumpy pebbles that keep the red planet company.
  // They are worlds too, so they follow SPACE_SCALE with everything else.
  const moonlets = new THREE.Group()
  const pebble = new THREE.IcosahedronGeometry(SPACE_SCALE, 0)
  const pebbleMaterial = new THREE.MeshStandardMaterial({ color: 0x9a9187, flatShading: true, roughness: 1 })
  const phobos = new THREE.Mesh(pebble, pebbleMaterial)
  phobos.scale.set(1.5, 1.1, 1.25)
  phobos.position.set(planet.spaceRadius + 6.5 * SPACE_SCALE, 1.4 * SPACE_SCALE, 0)
  moonlets.add(phobos)
  const deimos = new THREE.Mesh(pebble, pebbleMaterial)
  deimos.scale.set(0.95, 0.78, 0.9)
  deimos.position.set(-(planet.spaceRadius + 11 * SPACE_SCALE), -2.2 * SPACE_SCALE, 3.6 * SPACE_SCALE)
  moonlets.add(deimos)
  into.add(moonlets, buildAtmosphere(id, 1.13))
  spun.push({ object: moonlets, rate: 0.11 })
  yield
}

// ------------------------------------------------------------------- build

export function createSpaceBody(id: number, root: THREE.Group): SpaceBody {
  const planet = planetById(id)
  const glow = buildGlow(id)
  const label = makeLabel(planet.name.toUpperCase(), planet.theme === 'mars' ? '#ffbf94' : '#dfe6ff')
  label.position.set(0, planet.spaceRadius + 12 * SPACE_SCALE, 0)
  root.add(label)
  const spun: Spinner[] = []

  return {
    id,
    root,
    glow,
    labels: [label],
    makeLowTier() {
      return buildLowTier(id)
    },
    detailBuilder(into) {
      return id === 1 ? moonDetail(id, into, spun) : id === 2 ? marsDetail(id, into, spun) : earthDetail(id, into, spun)
    },
    spin(dt) {
      for (const entry of spun) entry.object.rotation.y += dt * entry.rate
    },
  }
}
