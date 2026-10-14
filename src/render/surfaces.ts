import * as THREE from 'three'
import {
  LANDER_RING_RADIUS, LOD_COST_SURFACE, LOD_PROP_SLICE, LOD_TERRAIN_SLICE, SURFACE_RADIUS,
  SURFACE_SCALE, TAU,
} from '../sim/config.ts'
import { cratersFor, landerSite, planetById, terrainHeight } from '../sim/planets.ts'
import { valueNoise } from '../sim/noise.ts'
import type { PlanetDef } from '../sim/planets.ts'

const UP = new THREE.Vector3(0, 1, 0)
const scratchDir = new THREE.Vector3()

/**
 * One landable world, built from the shared PlanetDef + terrainHeight pair.
 * Every prop rides `terrainRadius`, so the renderer and the sim agree.
 */
export interface SurfaceBuild {
  planetId: number
  group: THREE.Group
  lander: THREE.Group
  landingRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
  ringMaterial: THREE.MeshBasicMaterial
  padBeacon: THREE.Sprite
  terrainRadius(lat: number, lon: number): number
}

/**
 * A surface that streams in across frames (plan §9). `standIn` holds the
 * horizon while `detail` is still on the build queue; `build` only appears once
 * the last slice reports done, so callers can tell "warm" from "not yet".
 */
export interface SurfaceJob {
  planetId: number
  /** tier 0: a smooth crust that sits just under the terrain's deepest valley */
  standIn: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  /** tier 2: terrain, props and the lander pad all live here */
  detail: THREE.Group
  build: SurfaceBuild | null
  /** estimated ms for the whole surface */
  readonly costMs: number
  /** run one bounded slice of work; true when the surface is ready */
  slice(): boolean
}

// --------------------------------------------------------------- utilities

/** Tiny deterministic RNG so props land in the same spot on every reload. */
export function makeRnd(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

export function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** A half-drawn canvas, so a heavy texture can be painted across several frames. */
export interface CanvasBuild {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D | null
  rnd: () => number
}

export function canvasBuild(width: number, height: number, seed = 991): CanvasBuild {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return { canvas, ctx: canvas.getContext('2d'), rnd: makeRnd(seed) }
}

export function finishTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 2
  return texture
}

export function canvasTexture(
  width: number, height: number, draw: (ctx: CanvasRenderingContext2D, rnd: () => number) => void,
): THREE.CanvasTexture {
  const build = canvasBuild(width, height)
  if (build.ctx) draw(build.ctx, build.rnd)
  return finishTexture(build.canvas)
}

export function glowTexture(inner: string, outer: string): THREE.CanvasTexture {
  return canvasTexture(256, 256, ctx => {
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
    gradient.addColorStop(0, inner)
    gradient.addColorStop(0.3, inner)
    gradient.addColorStop(1, outer)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 256, 256)
  })
}

/** A one-pixel texture of one colour: a placeholder that keeps a shader's shape. */
function flatTexture(r: number, g: number, b: number): THREE.CanvasTexture {
  const build = canvasBuild(1, 1)
  if (build.ctx) {
    build.ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
    build.ctx.fillRect(0, 0, 1, 1)
  }
  return finishTexture(build.canvas)
}

// --------------------------------------------------------------------- soil

/**
 * The ground underfoot: the reference build's own soil - grit and stones set in
 * it - painted on a canvas and tiled.
 *
 * A small tile on purpose. The eye is two metres off the ground and magnifies
 * whatever is under it by tens of times, so the only thing worth putting in a
 * texture is what is smaller than a boot; anything larger repeats often enough
 * to read as a pattern, and belongs in the vertex colours instead. At six metres
 * the tile holds gravel at 170 texels to the metre and repeats far too often at
 * ground level for the eye to catch it doing so.
 *
 * It also has to tile, and the reference build's did not: their stones were
 * drawn once at random positions and simply clipped wherever they met the canvas
 * edge, so repeating that texture printed a line of half-stones across the
 * ground at every tile. Every element here is stamped again on the far side
 * wherever it crosses an edge, so the copies meet.
 *
 * The same pass draws the stones a second time as flat domes, which is what
 * becomes the normal map. Relief has to come from somewhere, and all a painted
 * shadow can do two metres off the ground is look painted.
 */
const SOIL_TEXELS = 1024
/** metres of ground one tile covers at the landing site; sets the repeat below */
const SOIL_SPAN = 6
const SOIL_REPEAT_X = Math.round((TAU * SURFACE_RADIUS * Math.cos(0.26)) / SOIL_SPAN)
const SOIL_REPEAT_Y = Math.round((Math.PI * SURFACE_RADIUS) / SOIL_SPAN)

export interface SoilMaps {
  colour: THREE.CanvasTexture
  normal: THREE.CanvasTexture
}

/**
 * Draw an element, and again on the far side wherever it would cross an edge:
 * nine draws at worst, one in the middle of the tile. Callers must not consume
 * random numbers inside `draw`, or the tile stops being reproducible.
 */
function stampWrapped(
  size: number, x: number, y: number, reach: number, draw: (x: number, y: number) => void,
): void {
  const xs = [x]
  const ys = [y]
  if (x - reach < 0) xs.push(x + size)
  if (x + reach > size) xs.push(x - size)
  if (y - reach < 0) ys.push(y + size)
  if (y + reach > size) ys.push(y - size)
  for (const px of xs) {
    for (const py of ys) draw(px, py)
  }
}

/** One stone in the soil, in colour and in relief. */
function paintStone(
  ctx: CanvasRenderingContext2D, depth: CanvasRenderingContext2D, size: number, rnd: () => number,
): void {
  const x = rnd() * size
  const y = rnd() * size
  const r = 2.9 + Math.pow(rnd(), 2.2) * 26
  const spin = rnd() * Math.PI
  // every stone a different shape: all of them the same ellipse is what makes a
  // scatter of grit read as a printed pattern
  const wide = 0.62 + rnd() * 0.5
  const flat = 0.45 + rnd() * 0.5
  // deliberately a light stone on a lighter ground: at fifty texels to the metre
  // a three-centimetre pebble is barely two texels across, and a dark one at that
  // size is a speck of noise rather than a stone. The relief is in the dome below
  // and the normal map that comes out of it - the colour only has to say "not
  // sand here".
  const grey = 98 + rnd() * 52
  const shadow = 0.13
  const lift = 0.09 + rnd() * 0.13
  const dome = 138 + Math.round(rnd() * 72)
  const reach = r * 1.5

  // the hollow it sits in, so it reads as set into the ground rather than on it
  ctx.fillStyle = `rgba(48, 24, 12, ${shadow})`
  stampWrapped(size, x, y, reach, (px, py) => {
    ctx.beginPath()
    ctx.ellipse(px + r * 0.34, py + r * 0.4, r * wide, r * flat, spin, 0, TAU)
    ctx.fill()
  })
  // the stone itself, cooler than the sand around it
  ctx.fillStyle = `rgb(${(grey + 26) | 0}, ${(grey * 0.95 + 16) | 0}, ${(grey * 0.92 + 12) | 0})`
  stampWrapped(size, x, y, reach, (px, py) => {
    ctx.beginPath()
    ctx.ellipse(px, py, r * wide, r * flat, spin, 0, TAU)
    ctx.fill()
  })
  // the facet that catches a low sun
  ctx.fillStyle = `rgba(255, 236, 206, ${lift})`
  stampWrapped(size, x, y, reach, (px, py) => {
    ctx.beginPath()
    ctx.ellipse(px - r * 0.2, py - r * 0.24, r * wide * 0.5, r * flat * 0.45, spin, 0, TAU)
    ctx.fill()
  })
  depth.fillStyle = `rgb(${dome}, ${dome}, ${dome})`
  stampWrapped(size, x, y, reach, (px, py) => {
    depth.beginPath()
    depth.ellipse(px, py, r * wide * 0.95, r * flat * 0.95, spin, 0, TAU)
    depth.fill()
  })
}

/**
 * The relief canvas as a normal map. Sobel over the domes, sampled with wrap so
 * the tile's own edges do not raise a ridge down the middle of the ground.
 */
function* soilNormal(source: HTMLCanvasElement, size: number): Generator<void, THREE.CanvasTexture, void> {
  const src = source.getContext('2d')
  const out = document.createElement('canvas')
  out.width = size
  out.height = size
  const dst = out.getContext('2d')
  if (!src || !dst) return flatTexture(128, 128, 255)
  const input = src.getImageData(0, 0, size, size).data
  const image = dst.createImageData(size, size)
  const at = (x: number, y: number) => input[((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4] / 255
  const strength = 3.2
  for (let yStart = 0; yStart < size; yStart += 64) {
    const yEnd = Math.min(size, yStart + 64)
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength
        // the image's y runs against v, and the texture is flipped to match
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength
        const length = Math.hypot(dx, dy, 1)
        const i = (y * size + x) * 4
        image.data[i] = 128 + (-dx / length) * 127
        image.data[i + 1] = 128 + (dy / length) * 127
        image.data[i + 2] = 128 + (1 / length) * 127
        image.data[i + 3] = 255
      }
    }
    yield
  }
  dst.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(out)
  // a normal map carries directions, not colour, so it must not be sRGB-decoded
  texture.colorSpace = THREE.NoColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(SOIL_REPEAT_X, SOIL_REPEAT_Y)
  texture.anisotropy = 8
  return texture
}

/**
 * Painted across frames like everything else on a surface: a quarter of a
 * million canvas operations is not a thing to do inside one frame.
 */
function* paintSoil(planetId: number): Generator<void, SoilMaps, void> {
  const size = SOIL_TEXELS
  const rnd = makeRnd(8123 + planetId)
  const colour = document.createElement('canvas')
  colour.width = size
  colour.height = size
  const ctx = colour.getContext('2d')
  const relief = document.createElement('canvas')
  relief.width = size
  relief.height = size
  const depth = relief.getContext('2d')
  if (!ctx || !depth) return { colour: finishTexture(colour), normal: flatTexture(128, 128, 255) }

  // bare soil, and the same grey on the relief canvas as its resting level. The
  // map is a detail layer rather than the colour: the planet's own palette is
  // multiplied over it, so the soil has to sit near white or the ground ends up
  // the product of two dark colours
  ctx.fillStyle = '#c9b49c'
  ctx.fillRect(0, 0, size, size)
  depth.fillStyle = '#808080'
  depth.fillRect(0, 0, size, size)
  yield

  // grit: the same trick at a tenth of the size, which is what stops the soil
  // reading as flat paint when it fills the whole screen
  for (let i = 0; i < 560; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const r = 1.6 + rnd() * 16.3
    const lighter = rnd() > 0.5
    const alpha = 0.026 + rnd() * 0.09
    ctx.fillStyle = lighter ? `rgba(236, 214, 182, ${alpha})` : `rgba(96, 62, 38, ${alpha})`
    stampWrapped(size, x, y, r, (px, py) => {
      ctx.beginPath()
      ctx.arc(px, py, r, 0, TAU)
      ctx.fill()
    })
    if (i % 80 === 0) yield
  }

  // and the stones sitting in it
  for (let i = 0; i < 100; i++) {
    paintStone(ctx, depth, size, rnd)
    if (i % 20 === 0) yield
  }
  yield

  const normal = yield* soilNormal(relief, size)
  const soil = finishTexture(colour)
  soil.wrapS = THREE.RepeatWrapping
  soil.wrapT = THREE.RepeatWrapping
  soil.repeat.set(SOIL_REPEAT_X, SOIL_REPEAT_Y)
  soil.anisotropy = 8
  return { colour: soil, normal }
}

const soilMaps = new Map<number, SoilMaps>()

/** Painted once per session: a surface can be rebuilt on every landing. */
function* soilTextures(planetId: number): Generator<void, SoilMaps, void> {
  const cached = soilMaps.get(planetId)
  if (cached) return cached
  const maps = yield* paintSoil(planetId)
  soilMaps.set(planetId, maps)
  return maps
}

export function dir(lat: number, lon: number, target = new THREE.Vector3()): THREE.Vector3 {
  const cosLat = Math.cos(lat)
  return target.set(cosLat * Math.cos(lon), Math.sin(lat), cosLat * Math.sin(lon))
}

export function surfacePoint(lat: number, lon: number, radius: number, target = new THREE.Vector3()): THREE.Vector3 {
  return dir(lat, lon, target).multiplyScalar(radius)
}

/** Angular distance from the landing pad, used to keep props out of the way. */
function padDistance(lat: number, lon: number, site: { lat: number; lon: number }): number {
  let dLon = lon - site.lon
  dLon = ((dLon + Math.PI * 3) % TAU) - Math.PI
  return Math.hypot(lat - site.lat, Math.cos(lat) * dLon)
}

function placeProp(
  dummy: THREE.Object3D, radiusOf: (lat: number, lon: number) => number, lat: number, lon: number,
  lift: number, scale: number, rnd: () => number,
) {
  dir(lat, lon, scratchDir)
  dummy.position.copy(scratchDir).multiplyScalar(radiusOf(lat, lon) + lift)
  dummy.quaternion.setFromUnitVectors(UP, scratchDir)
  dummy.rotateY(rnd() * TAU)
  dummy.rotateX((rnd() - 0.5) * 0.5)
  dummy.scale.set(scale, scale * (0.6 + rnd() * 0.5), scale)
  dummy.updateMatrix()
}

function placeGroup(
  group: THREE.Object3D, radiusOf: (lat: number, lon: number) => number, lat: number, lon: number,
  lift: number, yaw: number,
) {
  dir(lat, lon, scratchDir)
  group.position.copy(scratchDir).multiplyScalar(radiusOf(lat, lon) + lift)
  group.quaternion.setFromUnitVectors(UP, scratchDir)
  group.rotateY(yaw)
}

// ----------------------------------------------------------------- terrain

/**
 * The displaced, vertex-coloured planet sphere: the terrain mesh is generated
 * `LOD_TERRAIN_SLICE` vertices at a time. The geometry is rewritten in place, so
 * the original directions are copied out first.
 *
 * The grid is a fixed number of segments rather than a fixed spacing, and that is
 * the right way round now the world has a size of its own: the landscape in
 * `terrainHeight` scales with the ball, so the mesh that carries it has to scale
 * with the ball too, or the craters would outgrow the triangles under them.
 */
const TERRAIN_SEGMENTS_X = 224
const TERRAIN_SEGMENTS_Y = 144
/** one segment of that grid in metres: how far along the ground a slope is read */
const TERRAIN_STEP = (TAU * SURFACE_RADIUS) / TERRAIN_SEGMENTS_X

function* terrainStage(planet: PlanetDef, seed: number, group: THREE.Group): Generator<void, void, void> {
  const geometry = new THREE.SphereGeometry(SURFACE_RADIUS, TERRAIN_SEGMENTS_X, TERRAIN_SEGMENTS_Y)
  const position = geometry.attributes.position
  const source = Float32Array.from(position.array as ArrayLike<number>)
  const colors = new Float32Array(position.count * 3)
  const low = new THREE.Color(planet.groundLow)
  const high = new THREE.Color(planet.groundHigh)
  const rock = new THREE.Color(planet.rock)
  const sand = new THREE.Color(0xd9c98a)
  const shade = new THREE.Color(0x2a2e38)
  const vertex = new THREE.Vector3()
  const color = new THREE.Color()

  for (let start = 0; start < position.count; start += LOD_TERRAIN_SLICE) {
    const end = Math.min(position.count, start + LOD_TERRAIN_SLICE)
    for (let i = start; i < end; i++) {
      vertex.set(source[i * 3], source[i * 3 + 1], source[i * 3 + 2]).normalize()
      const lat = Math.asin(clampValue(vertex.y, -1, 1))
      const lon = Math.atan2(vertex.z, vertex.x)
      const height = terrainHeight(lat, lon, seed, planet.id)
      const radius = SURFACE_RADIUS + height
      position.setXYZ(i, vertex.x * radius, vertex.y * radius, vertex.z * radius)
      // read in the landscape's own units, so the bands below are the ones the
      // design was tuned at rather than sizes that follow the world about
      const h = height / SURFACE_SCALE
      const t = clampValue((h + 2.5) / 10, 0, 1)
      color.copy(low).lerp(high, t)
      if (planet.theme === 'earth') {
        if (h > 1.4) color.lerp(sand, 0.55)
        if (lon > 2.2 && lon < 3.1 && Math.abs(lat) < 0.5) color.lerp(rock, 0.5)
      } else if (planet.theme === 'moon') {
        if (h < -0.4) color.lerp(shade, clampValue((-h - 0.4) / 2.6, 0, 0.45))
      } else {
        // Mars, where the colour is about what the ground *is* rather than how
        // high it is: sand in the floor of the field, rock up on the ring and on
        // anything steep. Height alone would paint the ring the same bright dust
        // as the dunes, and a sunward crest of bright dust blows out to white and
        // stops reading as a mountain at all.
        const ahead = terrainHeight(lat, lon + TERRAIN_STEP / (SURFACE_RADIUS * Math.cos(lat)), seed, planet.id)
        const slope = clampValue(Math.abs(ahead - height) / (1.4 * SURFACE_SCALE), 0, 1)
        color.lerp(rock, slope * 0.5)
        if (h > 7) color.lerp(rock, clampValue((h - 7) / 16, 0, 0.6))
        // and the mottling, which lives here rather than in the soil tile: the
        // ground's tone changes over metres, and a tile small enough to be sharp
        // under a boot is far too small to hold a patch of ground this size
        // without printing its pattern across the field
        const patch = (valueNoise(lon * 7, lat * 7, seed ^ 0x51ed270b) - 0.5) * 0.2
          + (valueNoise(lon * 23, lat * 23, seed ^ 0x2f1b3c) - 0.5) * 0.1
        color.offsetHSL(0, 0, patch)
      }
      colors.set([color.r, color.g, color.b], i * 3)
    }
    yield
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.computeVertexNormals()
  let painted: THREE.MeshStandardMaterial
  if (planet.theme === 'mars') {
    // soil, and the same stones as relief. Smooth-shaded on purpose: flat shading
    // takes its normals from the geometry's derivatives and leaves a normal map
    // nowhere to sit, and the normal map is where the ground's close-up detail
    // lives.
    const soil = yield* soilTextures(planet.id)
    painted = new THREE.MeshStandardMaterial({
      map: soil.colour, normalMap: soil.normal, vertexColors: true, roughness: 1, metalness: 0,
    })
  } else {
    painted = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 })
  }
  const ground = new THREE.Mesh(geometry, painted)
  group.add(ground)
  yield
}

/** Sharp stars for the airless Moon sky. */
function buildStarField(): THREE.Points {
  const count = 700
  const positions = new Float32Array(count * 3)
  const rnd = makeRnd(8642)
  for (let i = 0; i < count; i++) {
    const star = scratchDir.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1)
    if (star.lengthSq() < 1e-6) star.set(0, 1, 0)
    star.normalize().multiplyScalar(600 + rnd() * 140)
    positions.set([star.x, star.y, star.z], i * 3)
  }
  return new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)),
    new THREE.PointsMaterial({
      color: 0xe8f0ff, size: 2.3, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.95,
    }),
  )
}

// ------------------------------------------------------------------- props

function* earthPropStage(
  planet: PlanetDef, seed: number, radiusOf: (lat: number, lon: number) => number, group: THREE.Group,
): Generator<void, void, void> {
  const rnd = makeRnd(seed ^ 0x51a7c3)
  const site = landerSite(planet.id)
  const dummy = new THREE.Object3D()
  const treeCapacity = 240
  const trunkMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.2, 0.26, 1.4, 5),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2f, flatShading: true }),
    treeCapacity,
  )
  const canopyMesh = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.5, 3.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x2f7d4f, flatShading: true }),
    treeCapacity,
  )
  let trees = 0
  let attempts = 0
  while (trees < 190 && attempts < 900) {
    attempts++
    const lat = (rnd() * 2 - 1) * 1.0
    const lon = rnd() * TAU
    if (padDistance(lat, lon, site) < 0.2) continue
    const radius = radiusOf(lat, lon)
    dir(lat, lon, scratchDir)
    const scale = 0.7 + rnd() * 0.9
    dummy.position.copy(scratchDir).multiplyScalar(radius + 0.6 * scale)
    dummy.quaternion.setFromUnitVectors(UP, scratchDir)
    dummy.rotateY(rnd() * TAU)
    dummy.scale.setScalar(scale)
    dummy.updateMatrix()
    trunkMesh.setMatrixAt(trees, dummy.matrix)
    dummy.position.copy(scratchDir).multiplyScalar(radius + 2.05 * scale)
    dummy.updateMatrix()
    canopyMesh.setMatrixAt(trees, dummy.matrix)
    trees++
    if (trees % LOD_PROP_SLICE === 0) yield
  }
  trunkMesh.count = trees
  canopyMesh.count = trees
  trunkMesh.instanceMatrix.needsUpdate = true
  canopyMesh.instanceMatrix.needsUpdate = true

  const rockMesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.9, 0),
    new THREE.MeshStandardMaterial({ color: planet.rock, flatShading: true }),
    110,
  )
  for (let i = 0; i < 110; i++) {
    const lat = (rnd() * 2 - 1) * 1.0
    const lon = rnd() * TAU
    placeProp(dummy, radiusOf, lat, lon, 0.25, 0.6 + rnd() * 1.5, rnd)
    rockMesh.setMatrixAt(i, dummy.matrix)
    if ((i + 1) % LOD_PROP_SLICE === 0) yield
  }
  rockMesh.instanceMatrix.needsUpdate = true
  group.add(trunkMesh, canopyMesh, rockMesh)
  yield
}

/** A dead rover: flat hull, four wheels, a tilted deck and a bent mast. */
function buildRoverWreck(): THREE.Group {
  const group = new THREE.Group()
  const hull = new THREE.MeshStandardMaterial({ color: 0xcdd3dc, roughness: 0.7, metalness: 0.25, flatShading: true })
  const panel = new THREE.MeshStandardMaterial({ color: 0x2f4f8f, roughness: 0.5, metalness: 0.4, flatShading: true })
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, 1.8), hull)
  body.position.y = 0.62
  group.add(body)
  for (const side of [-1, 1]) {
    for (const z of [-0.7, 0.7]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 8), hull)
      wheel.rotation.z = Math.PI / 2
      wheel.position.set(side * 1.32, 0.44, z)
      group.add(wheel)
    }
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 1.1), panel)
  deck.position.set(0, 1.16, 0.1)
  deck.rotation.set(-0.22, 0.1, 0.06)
  group.add(deck)
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.3, 6), hull)
  mast.position.set(-0.8, 1.85, -0.5)
  mast.rotation.set(0.28, 0, 0.34)
  group.add(mast)
  return group
}

function* moonPropStage(
  planet: PlanetDef, seed: number, radiusOf: (lat: number, lon: number) => number, group: THREE.Group,
): Generator<void, void, void> {
  const rnd = makeRnd(seed ^ 0x2f9a11)
  const site = landerSite(planet.id)
  const dummy = new THREE.Object3D()
  const craters = cratersFor(planet.id, seed)
  const rimRocks = craters.length * 14
  const boulderMesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.85, 0),
    new THREE.MeshStandardMaterial({ color: planet.rock, flatShading: true, roughness: 1 }),
    Math.max(1, rimRocks + 90),
  )
  let boulders = 0
  for (const crater of craters) {
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * TAU + rnd() * 0.45
      const lat = clampValue(crater.lat + Math.sin(angle) * crater.radius * 1.04, -1.15, 1.15)
      const lon = crater.lon + (Math.cos(angle) * crater.radius) / Math.max(0.3, Math.cos(lat))
      placeProp(dummy, radiusOf, lat, lon, 0.16, 0.5 + rnd() * 0.8, rnd)
      boulderMesh.setMatrixAt(boulders++, dummy.matrix)
      if (boulders >= boulderMesh.count) break
      if (boulders % LOD_PROP_SLICE === 0) yield
    }
  }
  for (let i = 0; i < 90; i++) {
    const lat = (rnd() * 2 - 1) * 1.0
    const lon = rnd() * TAU
    if (padDistance(lat, lon, site) < 0.24) continue
    placeProp(dummy, radiusOf, lat, lon, 0.2, 0.6 + rnd() * 1.7, rnd)
    boulderMesh.setMatrixAt(boulders++, dummy.matrix)
    if (boulders % LOD_PROP_SLICE === 0) yield
  }
  boulderMesh.count = boulders
  boulderMesh.instanceMatrix.needsUpdate = true
  group.add(boulderMesh)
  yield

  for (let i = 0; i < 2; i++) {
    const wreck = buildRoverWreck()
    const lat = site.lat + (i === 0 ? 0.27 : -0.33)
    const lon = site.lon + (i === 0 ? 0.23 : -0.19)
    placeGroup(wreck, radiusOf, lat, lon, 0.1, rnd() * TAU)
    group.add(wreck)
    yield
  }

  const fragmentMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.6, 0.06, 0.95),
    new THREE.MeshStandardMaterial({ color: 0x33507f, roughness: 0.5, metalness: 0.4, flatShading: true }),
    16,
  )
  for (let i = 0; i < 16; i++) {
    const lat = site.lat + (rnd() * 2 - 1) * 0.42
    const lon = site.lon + (rnd() * 2 - 1) * 0.42
    placeProp(dummy, radiusOf, lat, lon, 0.12, 0.5 + rnd() * 0.8, rnd)
    fragmentMesh.setMatrixAt(i, dummy.matrix)
  }
  fragmentMesh.instanceMatrix.needsUpdate = true
  group.add(fragmentMesh)
  yield
}

/** A lander probe half swallowed by the dunes. */
function buildProbeWreck(): THREE.Group {
  const group = new THREE.Group()
  const hull = new THREE.MeshStandardMaterial({ color: 0xb9b0a2, roughness: 0.8, metalness: 0.3, flatShading: true })
  const panel = new THREE.MeshStandardMaterial({ color: 0x35507f, roughness: 0.5, metalness: 0.4, flatShading: true })
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.3, 2.0), hull)
  body.position.y = -0.2
  body.rotation.z = 0.22
  group.add(body)
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.08, 1.2), panel)
    wing.position.set(side * 2.1, -0.42, 0.3)
    wing.rotation.set(0.12, side * -0.18, side * 0.36)
    group.add(wing)
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.0, 6), hull)
  mast.position.set(-0.7, 0.85, -0.6)
  mast.rotation.z = 0.62
  group.add(mast)
  return group
}

function* marsPropStage(
  planet: PlanetDef, seed: number, radiusOf: (lat: number, lon: number) => number, group: THREE.Group,
): Generator<void, void, void> {
  const rnd = makeRnd(seed ^ 0x7c3d55)
  const site = landerSite(planet.id)
  const dummy = new THREE.Object3D()

  const rockMesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.9, 0),
    new THREE.MeshStandardMaterial({ color: planet.rock, flatShading: true, roughness: 1 }),
    130,
  )
  for (let i = 0; i < 130; i++) {
    const lat = (rnd() * 2 - 1) * 1.0
    const lon = rnd() * TAU
    placeProp(dummy, radiusOf, lat, lon, 0.2, 0.5 + rnd() * 1.9, rnd)
    rockMesh.setMatrixAt(i, dummy.matrix)
    if ((i + 1) % LOD_PROP_SLICE === 0) yield
  }
  rockMesh.instanceMatrix.needsUpdate = true
  group.add(rockMesh)
  yield

  for (let i = 0; i < 2; i++) {
    const wreck = buildProbeWreck()
    const lat = site.lat + (i === 0 ? -0.22 : 0.3)
    const lon = site.lon + (i === 0 ? 0.34 : -0.28)
    placeGroup(wreck, radiusOf, lat, lon, -0.35, rnd() * TAU)
    group.add(wreck)
    yield
  }
}

// ------------------------------------------------------------------ lander

interface LanderParts {
  lander: THREE.Group
  landingRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
  ringMaterial: THREE.MeshBasicMaterial
  padBeacon: THREE.Sprite
}

function buildLander(
  planet: PlanetDef, radiusOf: (lat: number, lon: number) => number, group: THREE.Group,
): LanderParts {
  const site = landerSite(planet.id)
  const lander = new THREE.Group()
  placeGroup(lander, radiusOf, site.lat, site.lon, 0, 0)
  const legMaterial = new THREE.MeshStandardMaterial({ color: 0xd8a24a, flatShading: true, roughness: 0.6 })
  for (const angle of [0, 1, 2, 3]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 2.6, 0.28), legMaterial)
    const a = (angle / 4) * TAU + Math.PI / 4
    leg.position.set(Math.cos(a) * 2.2, 0.75, Math.sin(a) * 2.2)
    leg.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45)
    lander.add(leg)
  }

  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x7fffb0, transparent: true, opacity: 0.5 })
  const landingRing = new THREE.Mesh(new THREE.TorusGeometry(LANDER_RING_RADIUS, 0.2, 8, 64), ringMaterial)
  landingRing.rotation.x = -Math.PI / 2
  landingRing.position.y = 0.14
  lander.add(landingRing)

  const padBeacon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(140, 255, 190, 0.9)', 'rgba(60, 220, 140, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  padBeacon.position.set(0, 6.6, 0)
  padBeacon.scale.setScalar(7.5)
  lander.add(padBeacon)

  group.add(lander)
  return { lander, landingRing, ringMaterial, padBeacon }
}

// ------------------------------------------------------------------- build

/**
 * A surface that streams in across frames: a stand-in crust appears straight
 * away and the terrain, props and lander pad are generated under the frame
 * budget. The stand-in sits below the terrain's deepest valley, so the finished
 * world never leaves a grey dome poking out of a crater.
 */
export function createSurfaceJob(planetId: number, seed: number): SurfaceJob {
  const planet = planetById(planetId)
  const detail = new THREE.Group()
  const standIn = new THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>(
    new THREE.SphereGeometry(SURFACE_RADIUS - 7 * SURFACE_SCALE, 40, 26),
    new THREE.MeshStandardMaterial({
      color: planet.groundLow, flatShading: true, roughness: 1, transparent: true, opacity: 1,
    }),
  )
  const terrainRadius = (lat: number, lon: number) => SURFACE_RADIUS + terrainHeight(lat, lon, seed, planetId)
  let lander: LanderParts | null = null

  const stages: (() => Generator<void, void, void>)[] = [
    () => terrainStage(planet, seed, detail),
  ]
  if (planet.theme === 'moon') {
    stages.push(function* moonSky() {
      detail.add(buildStarField())
    })
  }
  if (planet.theme === 'earth') {
    stages.push(() => earthPropStage(planet, seed, terrainRadius, detail))
  } else if (planet.theme === 'moon') {
    stages.push(() => moonPropStage(planet, seed, terrainRadius, detail))
  } else {
    stages.push(() => marsPropStage(planet, seed, terrainRadius, detail))
  }
  stages.push(function* padStage() {
    lander = buildLander(planet, terrainRadius, detail)
  })

  let index = 0
  let current: Generator<void, void, void> | null = null
  const job: SurfaceJob = {
    planetId,
    standIn,
    detail,
    build: null,
    costMs: LOD_COST_SURFACE,
    slice() {
      while (index < stages.length) {
        current = current ?? stages[index]()
        const step = current.next()
        if (!step.done) return false
        current = null
        index++
      }
      if (!job.build && lander) {
        job.build = {
          planetId,
          group: detail,
          lander: lander.lander,
          landingRing: lander.landingRing,
          ringMaterial: lander.ringMaterial,
          padBeacon: lander.padBeacon,
          terrainRadius,
        }
      }
      return true
    },
  }
  return job
}
