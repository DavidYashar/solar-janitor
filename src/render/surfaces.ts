import * as THREE from 'three'
import {
  LANDER_RING_RADIUS, LOD_COST_SURFACE, LOD_PROP_SLICE, LOD_TERRAIN_SLICE, SURFACE_RADIUS, TAU,
} from '../sim/config.ts'
import { cratersFor, landerSite, planetById, terrainHeight } from '../sim/planets.ts'
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
  /** rotor groups, spun by the caller while the planet is on screen */
  windmillBlades: THREE.Group[]
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
 * The displaced, vertex-coloured planet sphere: 8 249 vertices of terrain
 * noise, generated `LOD_TERRAIN_SLICE` vertices at a time. The geometry is
 * rewritten in place, so the original directions are copied out first.
 */
function* terrainStage(planet: PlanetDef, seed: number, group: THREE.Group): Generator<void, void, void> {
  const geometry = new THREE.SphereGeometry(SURFACE_RADIUS, 112, 72)
  const position = geometry.attributes.position
  const source = Float32Array.from(position.array as ArrayLike<number>)
  const colors = new Float32Array(position.count * 3)
  const low = new THREE.Color(planet.groundLow)
  const high = new THREE.Color(planet.groundHigh)
  const accent = new THREE.Color(planet.accent)
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
      const t = clampValue((height + 2.2) / 4.4, 0, 1)
      color.copy(low).lerp(high, t)
      if (planet.theme === 'earth') {
        if (height > 1.4) color.lerp(sand, 0.55)
        if (lon > 2.2 && lon < 3.1 && Math.abs(lat) < 0.5) color.lerp(rock, 0.5)
      } else if (planet.theme === 'moon') {
        if (height < -0.4) color.lerp(shade, clampValue((-height - 0.4) / 2.6, 0, 0.45))
      } else {
        if (height > 0.8) color.lerp(accent, 0.35)
        if (height < -0.9) color.lerp(shade, 0.3)
      }
      colors.set([color.r, color.g, color.b], i * 3)
    }
    yield
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.computeVertexNormals()
  group.add(new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 }),
  ))
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

/** A snapped windmill: thin mast, a bent strut and three battered blades. */
function buildWindmill(): { group: THREE.Group; blades: THREE.Group } {
  const group = new THREE.Group()
  const mastMaterial = new THREE.MeshStandardMaterial({ color: 0x8d8579, roughness: 0.85, metalness: 0.25, flatShading: true })
  const bladeMaterial = new THREE.MeshStandardMaterial({ color: 0xc2bcae, roughness: 0.7, flatShading: true })
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.3, 7.6, 6), mastMaterial)
  mast.position.y = 3.8
  group.add(mast)
  const strut = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.4, 0.12), mastMaterial)
  strut.position.set(0.78, 2.5, 0.18)
  strut.rotation.z = -0.34
  group.add(strut)
  const hub = new THREE.Group()
  hub.position.set(0, 7.1, 0.36)
  hub.rotation.x = -0.2
  const blades = new THREE.Group()
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Group()
    arm.rotation.z = (i / 3) * TAU + (i === 1 ? 0.55 : 0)
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.8, 0.07), bladeMaterial)
    blade.position.y = 1.7
    blade.rotation.y = i === 1 ? 1.1 : 0.05
    arm.add(blade)
    blades.add(arm)
  }
  hub.add(blades)
  group.add(hub)
  return { group, blades }
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
  windmillBlades: THREE.Group[],
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

  for (let i = 0; i < 3; i++) {
    const windmill = buildWindmill()
    let lat = site.lat
    let lon = site.lon
    for (let attempt = 0; attempt < 12; attempt++) {
      lat = site.lat + (rnd() * 2 - 1) * 0.5
      lon = site.lon + (rnd() * 2 - 1) * 0.5
      if (padDistance(lat, lon, site) > 0.26) break
    }
    placeGroup(windmill.group, radiusOf, lat, lon, 0, rnd() * TAU)
    group.add(windmill.group)
    windmillBlades.push(windmill.blades)
    yield
  }

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
    new THREE.SphereGeometry(SURFACE_RADIUS - 2.6, 40, 26),
    new THREE.MeshStandardMaterial({
      color: planet.groundLow, flatShading: true, roughness: 1, transparent: true, opacity: 1,
    }),
  )
  const terrainRadius = (lat: number, lon: number) => SURFACE_RADIUS + terrainHeight(lat, lon, seed, planetId)
  const windmillBlades: THREE.Group[] = []
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
    stages.push(() => marsPropStage(planet, seed, terrainRadius, detail, windmillBlades))
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
          windmillBlades,
          terrainRadius,
        }
      }
      return true
    },
  }
  return job
}
