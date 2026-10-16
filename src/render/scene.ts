import * as THREE from 'three'
import {
  EARTH_ORBIT, ISS_DOCK_OFFSET, ISS_ORBIT, JUNK_COLORS, LOD_COST_DETAIL, LOD_COST_STANDIN,
  LOD_SPACE_TUNING, LOD_SURFACE_TUNING, MARS_ORBIT, METEOR_RADIUS, MOON_ORBIT, OXYGEN_WARN,
  SPACE_SCALE, SUN_RADIUS, TAU,
} from '../sim/config.ts'
import { canDock, canLand, holdCount, landTarget, nearLander, scoopRadius } from '../sim/game.ts'
import { quatForward, quatUp } from '../sim/orient.ts'
import { PLANETS, planetById } from '../sim/planets.ts'
import type { PlanetTheme } from '../sim/planets.ts'
import type { Game, GameEvent, JunkClass, Vec3 } from '../sim/types.ts'
import { createSpaceBody, loadMap, makeLabel, whenReady } from './bodies.ts'
import type { SpaceBody } from './bodies.ts'
import { createLodStreamer, generatorBuild, oneshotBuild } from './lod.ts'
import type { LodBuild, LodQuery } from './lod.ts'
import { buildJanitor, poseJanitor } from './janitor.ts'
import { buildShip } from './ship.ts'
import {
  canvasTexture, clampValue, createSurfaceJob, dir, discTexture, flareTexture, glowTexture, lunarEarthTexture,
  makeRnd, raysTexture, riverFlow, sunGlowTexture, surfacePoint, windRotors,
} from './surfaces.ts'
import type { SurfaceBuild, SurfaceJob } from './surfaces.ts'

const MAX_PARTICLES = 300
const MAX_JUNK = 160
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const UP = new THREE.Vector3(0, 1, 0)
/** white, for pulling the sun disc's tint back towards it while the haze stays gold */
const FLARE_WHITE = new THREE.Color(0xffffff)

export interface World {
  update(game: Game, dt: number): void
  resize(): void
  addShake(amount: number): void
  burst(event: GameEvent, color: number, count: number, speed?: number): void
  /** the Moon meteor has landed: light it up where it hit */
  meteorStrike(lat: number, lon: number): void
  setQuality(low: boolean): void
  setReducedMotion(value: boolean): void
  /** live view of the LOD streamer, for browser playtests and debug output */
  lodStats(): LodStats
  /** what the GPU was actually asked to do last frame (plan §9 budgets) */
  renderStats(): RenderStats
  dispose(): void
}

/** Per-frame renderer counters plus the device limits behind them. */
export interface RenderStats {
  calls: number
  triangles: number
  points: number
  lines: number
  programs: number
  geometries: number
  textures: number
  pixelRatio: number
  drawingBuffer: { width: number; height: number }
  maxTextureSize: number
  maxRenderbuffer: number
  maxAttributes: number
  anisotropy: number
  webgl2: boolean
  quality: 'low' | 'high'
}

/** What the streamer is doing right now: built tiers, what is on screen, cost. */
export interface LodStats {
  /** tier generated per world: 0 glow · 1 stand-in · 2 detail */
  built: Record<string, number>
  /** tier actually on screen (never higher than what is built) */
  shown: Record<string, number>
  /** promotions still queued */
  pending: number
  /** ms of streaming work done in the last frame */
  spendMs: number
}

const LOD_NAMES = ['earth', 'moon', 'mars']

interface Particle {
  position: THREE.Vector3
  velocity: THREE.Vector3
  life: number
  maxLife: number
  color: THREE.Color
  size: number
  gravity: number
  centre: THREE.Vector3
}

/** Per-theme lighting: the sun sprite, the key light and the sky bounce. */
interface ThemeLook {
  keyLight: number
  keyIntensity: number
  skyLight: number
  groundLight: number
  hemiIntensity: number
  fill: number
  fillIntensity: number
  sunTint: number
  sunScale: number
}

// --------------------------------------------------------------- utilities

function basisFor(up: THREE.Vector3, forward: THREE.Vector3, right: THREE.Vector3): THREE.Matrix4 {
  right.crossVectors(up, forward).normalize()
  forward.crossVectors(right, up).normalize()
  return new THREE.Matrix4().makeBasis(right, up, forward)
}

/**
 * A stable pseudo-random number for a direction.
 *
 * Used to lump out a rock: an icosahedron repeats each corner once per face it
 * touches, so a fresh number per vertex pulls the copies apart and the rock comes
 * out in pieces. Hashing the direction itself gives every copy the same answer.
 */
function hashDirection(v: THREE.Vector3): number {
  const key = (Math.round(v.x * 512) * 73856093)
    ^ (Math.round(v.y * 512) * 19349663)
    ^ (Math.round(v.z * 512) * 83492791)
  let mixed = Math.imul(key ^ (key >>> 15), 2246822519) >>> 0
  mixed = Math.imul(mixed ^ (mixed >>> 13), 3266489917) >>> 0
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 4294967295
}

// ------------------------------------------------------------------ world

export function createWorld(container: HTMLElement): World {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setClearColor(0x04060f)
  // one shadow map, from the sun, and it is the soft filter that makes a 6 cm
  // texel read as a fuzzier edge than it is (see SUN_SHADOW_SPAN)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  container.appendChild(renderer.domElement)

  // near plane stays tight for the tug's fine detail, far has to reach the
  // scaled-out starfield (SPACE_SCALE) without breaking depth precision
  const camera = new THREE.PerspectiveCamera(58, 1, 0.6, 30000)
  let maxPixelRatio = 1.75
  let reducedMotion = false
  let shake = 0
  let elapsed = 0
  let lastMode = ''

  const cameraPosition = new THREE.Vector3()
  const cameraTarget = new THREE.Vector3()
  const cameraUp = new THREE.Vector3(0, 1, 0)
  const followForward = new THREE.Vector3(0, 0, 1)
  const followUp = new THREE.Vector3(0, 1, 0)
  let followDistance = 13
  let followHeight = 4.2
  let firstFrame = true

  /** metres of air the ground camera keeps under it, and probes along the way back */
  const CAMERA_CLEARANCE = 1.3
  const CAMERA_PROBES = 6

  /**
   * Lift a camera point until the ground on the way back to the janitor stops being
   * in the way.
   *
   * The trailing camera sits 8.8 m behind him, so facing downhill it is uphill of
   * him and buried in the slope - and from inside the hill the near faces are
   * culled away, which is the flat band of sky across the bottom of the frame.
   * Probes run along the line rather than only under the camera, because a ridge
   * between the two hides him just as thoroughly.
   *
   * A probe at fraction f of the way back rises by only f of whatever the camera
   * rises, so each shortfall is divided by its f before it is compared - and the
   * clearance wanted at a probe scales with f for the same reason. A flat margin
   * would be wrong: the line starts at his feet, where the ground is a hand's
   * breadth below it, and demanding a metre and a half there lifts a camera on
   * level ground for no reason at all.
   */
  function clearGround(point: THREE.Vector3, eye: THREE.Vector3, planetId: number): void {
    const reach = point.length()
    let lift = 0
    for (let i = 1; i <= CAMERA_PROBES; i++) {
      const fraction = i / CAMERA_PROBES
      vF.lerpVectors(eye, point, fraction)
      const distance = vF.length()
      vF.divideScalar(distance)
      const ground = radiusAt(planetId, Math.asin(clampValue(vF.y, -1, 1)), Math.atan2(vF.z, vF.x))
      const shortfall = (ground - distance) / fraction + CAMERA_CLEARANCE
      if (shortfall > lift) lift = shortfall
    }
    if (lift > 0) point.setLength(reach + lift)
  }

  /**
   * Is the sun behind a hill? The ghosts are the one screen-space part of this,
   * and without asking they shine happily through the ground.
   */
  function sunOccluded(eye: THREE.Vector3, planetId: number): boolean {
    vG.copy(SUN_DIRECTION).multiplyScalar(SURFACE_SUN_DISTANCE)
    // quadratically spaced, so the samples crowd the ground near the camera: a hill
    // three hundred metres away hides the sun as thoroughly as a mountain at three
    // thousand, and an even spread would step straight over it
    for (let i = 1; i <= 16; i++) {
      const at = (i / 16) * (i / 16)
      vH.lerpVectors(eye, vG, at)
      const reach = vH.length()
      vH.divideScalar(reach)
      const ground = radiusAt(planetId, Math.asin(clampValue(vH.y, -1, 1)), Math.atan2(vH.z, vH.x))
      if (ground > reach) return true
    }
    return false
  }

  /**
   * Hang the lens ghosts for this frame in the camera's own basis, mirrored through
   * the middle of the frame the way a real one runs: the further from the sun they
   * sit, the further the other side of centre they land.
   */
  function updateFlare(planetId: number, visible: boolean): void {
    if (!visible || sunOccluded(camera.position, planetId)) {
      for (const ghost of flareGhosts) ghost.sprite.visible = false
      return
    }
    camera.updateMatrixWorld()
    vG.copy(SUN_DIRECTION).multiplyScalar(SURFACE_SUN_DISTANCE).project(camera)
    const off = vG.z > 1 || Math.abs(vG.x) > 2 || Math.abs(vG.y) > 2
    const reach = Math.tan((camera.fov * Math.PI) / 360) * FLARE_DISTANCE
    // the camera's own axes, off its quaternion: matrixWorld is a frame stale here
    vH.set(1, 0, 0).applyQuaternion(camera.quaternion)
    vE.set(0, 1, 0).applyQuaternion(camera.quaternion)
    vF.set(0, 0, 1).applyQuaternion(camera.quaternion)
    for (const { sprite, def } of flareGhosts) {
      sprite.visible = !off
      if (off) continue
      sprite.position.copy(camera.position)
        .addScaledVector(vF, -FLARE_DISTANCE)                 // the camera looks down its own -Z
        .addScaledVector(vH, -vG.x * def.at * reach * camera.aspect)
        .addScaledVector(vE, -vG.y * def.at * reach)
      const size = def.size * reach * 2
      sprite.scale.set(size, size, 1)
    }
  }

  // scratch vectors (reused every frame, no per-frame allocation)
  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vC = new THREE.Vector3()
  const vD = new THREE.Vector3()
  const vE = new THREE.Vector3()
  const vF = new THREE.Vector3()
  const vG = new THREE.Vector3()
  const vH = new THREE.Vector3()
  const shipForward = new THREE.Vector3(0, 0, 1)
  const shipUp = new THREE.Vector3(0, 1, 0)
  const shipOrigin = new THREE.Vector3()
  const camWish = new THREE.Vector3()
  const camLook = new THREE.Vector3()
  const camUpWish = new THREE.Vector3(0, 1, 0)
  const flightForward: Vec3 = { x: 0, y: 0, z: 1 }
  const flightUp: Vec3 = { x: 0, y: 1, z: 0 }
  const dummy = new THREE.Object3D()
  const tmpColor = new THREE.Color()

  // ------------------------------------------------------------ space scene
  const spaceScene = new THREE.Scene()
  spaceScene.add(new THREE.AmbientLight(0x3b5688, 1.55))
  const spaceKey = new THREE.DirectionalLight(0xfff3dd, 2.1)
  spaceScene.add(spaceKey)
  spaceScene.add(spaceKey.target)
  const spaceFill = new THREE.DirectionalLight(0x5f86ff, 0.5)
  spaceFill.position.set(-1, 0.6, -0.8)
  spaceScene.add(spaceFill)

  // starfield: one Points cloud, no per-star objects to allocate or cull
  {
    const starCount = 2200
    const positions = new Float32Array(starCount * 3)
    let state = 20261
    const rnd = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 4294967296
    }
    for (let i = 0; i < starCount; i++) {
      let x = rnd() * 2 - 1
      let y = rnd() * 2 - 1
      let z = rnd() * 2 - 1
      const length = Math.hypot(x, y, z)
      if (length < 1e-3) {
        x = 0
        y = 1
        z = 0
      } else {
        x /= length
        y /= length
        z /= length
      }
      const distance = (1000 + rnd() * 900) * SPACE_SCALE
      positions[i * 3] = x * distance
      positions[i * 3 + 1] = y * distance
      positions[i * 3 + 2] = z * distance
    }
    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)),
      new THREE.PointsMaterial({ color: 0xd6e6ff, size: 2.4, sizeAttenuation: false }),
    )
    stars.userData.spin = true
    spaceScene.add(stars)
    spaceScene.userData.stars = stars
  }

  // the Sun: a self-luminous globe. The flat colour holds until the photosphere
  // map arrives, then the map takes over and a slow spin keeps it alive.
  const sunMaterial = new THREE.MeshBasicMaterial({ color: 0xffd06a })
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS, 64, 48),
    sunMaterial,
  )
  spaceScene.add(sun)
  const sunMap = loadMap('/textures/sun_surface.webp')
  whenReady(sunMap, () => {
    sunMaterial.map = sunMap.texture
    sunMaterial.color.setHex(0xffffff)
    sunMaterial.needsUpdate = true
  })
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255, 216, 128, 0.95)', 'rgba(255, 130, 40, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  sunGlow.scale.setScalar(SUN_RADIUS * 7)
  spaceScene.add(sunGlow)

  /**
   * The tight glow that hugs the disc.
   *
   * It used to be a shell: a sphere a sixth bigger than the photosphere, painted
   * one flat colour. A shell reads as a sticker, because it is one - the same
   * brightness from every angle and a hard edge where it stops, which is not what
   * anything burning looks like. This is a gradient instead, and its bright band
   * is tuned to land where the photosphere's edge does, so the disc hides the
   * middle of it and what shows is brightest at the limb and gone by the time it
   * matters. Two soft layers now, no seam anywhere between the surface and space.
   */
  const sunCorona = new THREE.Sprite(new THREE.SpriteMaterial({
    map: canvasTexture(256, 256, ctx => {
      const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
      gradient.addColorStop(0, 'rgba(255, 246, 220, 1)')
      gradient.addColorStop(0.38, 'rgba(255, 236, 178, 0.95)')
      gradient.addColorStop(0.62, 'rgba(255, 178, 74, 0.42)')
      gradient.addColorStop(1, 'rgba(255, 118, 26, 0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 256, 256)
    }),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  sunCorona.scale.setScalar(SUN_RADIUS * 2.6)
  spaceScene.add(sunCorona)

  // ---------------------------------------------------------- earth system
  const earthSystem = new THREE.Group()
  spaceScene.add(earthSystem)
  const earthBody = createSpaceBody(0, earthSystem)
  earthSystem.add(earthBody.glow)

  function orbitRing(radius: number, color: number, opacity: number): THREE.Line {
    const points: THREE.Vector3[] = []
    for (let i = 0; i <= 128; i++) {
      const angle = (i / 128) * TAU
      points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius))
    }
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    )
  }
  earthSystem.add(orbitRing(ISS_ORBIT, 0x7fd0ff, 0.26))
  earthSystem.add(orbitRing(MOON_ORBIT, 0xa9b7ff, 0.18))

  // --------------------------------------------------------- moon & mars
  // the moon is its own body: the sim hands us a world position that already
  // includes Earth's orbit, so it lives at the root of the space scene.
  const moonRoot = new THREE.Group()
  spaceScene.add(moonRoot)
  const moonBody = createSpaceBody(1, moonRoot)
  moonRoot.add(moonBody.glow)

  const marsSystem = new THREE.Group()
  spaceScene.add(marsSystem)
  const marsBody = createSpaceBody(2, marsSystem)
  marsSystem.add(marsBody.glow)

  // mars tracks its own lane around the Sun
  spaceScene.add(orbitRing(EARTH_ORBIT, 0x6f9fd0, 0.1))
  spaceScene.add(orbitRing(MARS_ORBIT, 0xc08050, 0.13))

  // ------------------------------------------------------------------- ISS
  const iss = new THREE.Group()
  earthSystem.add(iss)
  const hullMaterial = new THREE.MeshStandardMaterial({ color: 0xd9dfe8, roughness: 0.55, metalness: 0.35 })
  const panelMaterial = new THREE.MeshStandardMaterial({ color: 0x2b4f9a, roughness: 0.4, metalness: 0.5 })
  const ringMaterial = new THREE.MeshStandardMaterial({ color: 0xe7eaef, roughness: 0.6, metalness: 0.25 })

  const truss = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 12.4), hullMaterial)
  iss.add(truss)
  const core = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 4, 12), hullMaterial)
  core.rotation.z = Math.PI / 2
  iss.add(core)
  const lab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 2.6), hullMaterial)
  iss.add(lab)

  // four solar arrays hang below the truss like the real station
  for (const z of [-6.4, -3.2, 3.2, 6.4]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.12, 1.9), panelMaterial)
    panel.position.set(0, -1.3, z)
    iss.add(panel)
  }

  const spinningRings: THREE.Mesh[] = []
  for (let i = 0; i < 2; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.5 + i * 0.9, 0.16, 6, 40), ringMaterial)
    ring.rotation.x = Math.PI / 2
    ring.position.y = 1.8 + i * 1.1
    spinningRings.push(ring)
    iss.add(ring)
  }

  // the docking arm points radially away from Earth; its hatch is the dock point
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, ISS_DOCK_OFFSET, 10), hullMaterial)
  arm.rotation.z = Math.PI / 2
  arm.position.set(ISS_DOCK_OFFSET / 2, 0, 0)
  iss.add(arm)
  const hatchMaterial = new THREE.MeshBasicMaterial({ color: 0x7fe4ff })
  const hatch = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.16, 8, 24), hatchMaterial)
  hatch.rotation.y = Math.PI / 2
  hatch.position.set(ISS_DOCK_OFFSET, 0, 0)
  iss.add(hatch)

  const shopWindow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 0.95),
    new THREE.MeshBasicMaterial({ color: 0xffdf9b }),
  )
  shopWindow.position.set(0.5, 1.1, 1.32)
  iss.add(shopWindow)
  const shopGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255, 226, 150, 0.85)', 'rgba(255, 170, 60, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  shopGlow.scale.setScalar(5.4)
  shopGlow.position.set(0.5, 1.2, 1.5)
  iss.add(shopGlow)

  const issLabel = makeLabel('ISS', '#ffe1a3')
  issLabel.position.set(0, 7.4, 0)
  // the station is one of the two things SPACE_SCALE does not touch, so its
  // label is sized against the real world, not the scaled one
  issLabel.userData.scaleRef = 1
  iss.add(issLabel)
  const bodyLabels = [...earthBody.labels, ...moonBody.labels, ...marsBody.labels]
  const labels = [issLabel, ...bodyLabels]

  // ------------------------------------------------------------------ ship
  // the tug itself lives in render/ship.ts: procedural faceted hull, canopy,
  // swept wings, tail fin and engine pod, with the plume at -Z for the loop

  const shipModel = buildShip()
  spaceScene.add(shipModel.group)

  // -------------------------------------------------------- space particles
  const spaceParticles: Particle[] = []
  const spaceParticleMesh = new THREE.InstancedMesh(
    new THREE.TetrahedronGeometry(0.42, 0),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }),
    MAX_PARTICLES,
  )
  spaceParticleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  spaceParticleMesh.frustumCulled = false
  spaceParticleMesh.count = 0
  spaceScene.add(spaceParticleMesh)

  // ---------------------------------------------------------- surface scene
  const surfaceScene = new THREE.Scene()
  /**
   * How far out the sky sits, and where the sun hangs in it. Both are the far
   * plane of a landing site rather than part of any one world, and the worlds are
   * not the same size: Earth's valley is a ball of a kilometre, so a dome sized
   * for the Moon's ninety-six metres would leave you standing outside it, looking
   * at the inside of the ground.
   */
  const SURFACE_SKY_RADIUS = 6000
  const SURFACE_SUN_DISTANCE = 4800
  /** the halo's size at that distance: wide enough that the sun reads as a light in the sky */
  const SUN_BASE_SCALE = 1500
  const SUN_DIRECTION = new THREE.Vector3(240, 520, 160).normalize()
  /** a cloud deck hanging between the valley floor and the sky dome */
  const SURFACE_CLOUD_RADIUS = 3400
  /**
   * The sun is 0.53 degrees across, and a disc is the whole point: a soft blob is
   * a light source, but it takes a hard edge to read as the sun. Three times life
   * size is what it takes for the disc to hold its own against the aureole around
   * it at the sizes this camera runs at; smaller and it starts reading as a speck
   * inside its own glare.
   */
  const SUN_DISC_SCALE = 2 * SURFACE_SUN_DISTANCE * Math.tan(0.00925 * 1.5)
  /** how far the sun's spikes reach: far enough to read as a crown, not a sticker */
  const SUN_RAY_SCALE = 1400
  /** where the lens ghosts are hung, in metres in front of the camera */
  const FLARE_DISTANCE = 2
  /** how far the pointer can tip the chase camera, in radians either way */
  const SURFACE_PITCH_MAX = 1.15
  /**
   * The sun's shadow camera is a box that travels with the janitor, not a box
   * around the world: the valley is 1 500 m across and a single map over all of
   * it would put one texel on every three metres, which is wider than a fence
   * post. A hundred and forty metres of ground per map puts a texel under seven
   * centimetres, and nothing outside that box is near enough to notice that it is
   * not casting.
   */
  const SUN_SHADOW_SPAN = 70
  const SUN_SHADOW_MAP = 2048
  /** how far back along the sun ray the shadow camera sits, for its depth range */
  const SUN_SHADOW_DISTANCE = 300
  surfaceScene.fog = new THREE.Fog(0xbfe4ff, 170, 560)
  const surfaceHemisphere = new THREE.HemisphereLight(0xcfe9ff, 0x2f5a3a, 1.2)
  surfaceScene.add(surfaceHemisphere)
  // The key light is the sun - the same one drawn in the sky, aimed from the
  // janitor at the disc - so a shadow points where the light in the sky says it
  // should. It is a parallel light, but on a ball a kilometre across seen from
  // 4 800 m out the sun is not far enough away for parallel to be exact, and the
  // direction to the drawn disc is the one that matches what you can see.
  const surfaceKey = new THREE.DirectionalLight(0xfff4df, 2.0)
  surfaceKey.position.set(60, 120, 40)
  surfaceKey.castShadow = true
  surfaceKey.shadow.mapSize.set(SUN_SHADOW_MAP, SUN_SHADOW_MAP)
  surfaceKey.shadow.camera.left = -SUN_SHADOW_SPAN
  surfaceKey.shadow.camera.right = SUN_SHADOW_SPAN
  surfaceKey.shadow.camera.top = SUN_SHADOW_SPAN
  surfaceKey.shadow.camera.bottom = -SUN_SHADOW_SPAN
  surfaceKey.shadow.camera.near = 40
  surfaceKey.shadow.camera.far = SUN_SHADOW_DISTANCE + 220
  // three reads the shadow camera's projection every frame but only recomputes it
  // when asked, so a box resized without this stays at the default ten metres
  surfaceKey.shadow.camera.updateProjectionMatrix()
  // the cut-outs sort themselves out (see markShadows in surfaces.ts); what is
  // left here is solid geometry, where a texel of normal offset is the right
  // medicine and the depth bias only has to cover the rounding
  surfaceKey.shadow.bias = -0.00015
  surfaceKey.shadow.normalBias = 0.09
  surfaceScene.add(surfaceKey)
  surfaceScene.add(surfaceKey.target)
  const surfaceFill = new THREE.DirectionalLight(0x9fd0ff, 0.45)
  surfaceFill.position.set(-70, -30, -60)
  surfaceScene.add(surfaceFill)

  /** aim the key light from a point on the ground at the sun it belongs to */
  const sunAim = new THREE.Vector3()
  function aimKeyLightAt(at: THREE.Vector3) {
    sunAim.copy(sunSprite.position).sub(at).normalize()
    surfaceKey.target.position.copy(at)
    surfaceKey.position.copy(at).addScaledVector(sunAim, SUN_SHADOW_DISTANCE)
  }

  const themeLooks: Record<PlanetTheme, ThemeLook> = {
    earth: {
      // bright overcast daylight, the way the reference photographs are lit:
      // a strong cool-white key, a blue sky fill and very little else
      keyLight: 0xfff6e2, keyIntensity: 2.6, skyLight: 0xcfe4ff, groundLight: 0x4a7a3a,
      hemiIntensity: 1.35, fill: 0xa8c8ff, fillIntensity: 0.4, sunTint: 0xfff0a8, sunScale: 130,
    },
    moon: {
      keyLight: 0xffffff, keyIntensity: 3.5, skyLight: 0x2c3a58, groundLight: 0x14161c,
      hemiIntensity: 0.4, fill: 0x4a5f8c, fillIntensity: 0.14, sunTint: 0xffffff, sunScale: 104,
    },
    mars: {
      // the reference build lights its own surface much harder than the other
      // worlds here and the ground needs it: this soil is a darker, redder thing
      // than the photograph it replaced, and at the old key it read as brick
      keyLight: 0xffd9a8, keyIntensity: 2.9, skyLight: 0xe8b98c, groundLight: 0x8a4a30,
      hemiIntensity: 1.15, fill: 0xffc49a, fillIntensity: 0.35, sunTint: 0xffc98f, sunScale: 118,
    },
  }
  const stormFog = new THREE.Color(0xb2561f)
  const skyColor = new THREE.Color()
  const skyTextures = PLANETS.map(planet => canvasTexture(64, 256, ctx => {
    const gradient = ctx.createLinearGradient(0, 0, 0, 256)
    gradient.addColorStop(0, planet.skyTop)
    gradient.addColorStop(0.58, planet.skyMid)
    gradient.addColorStop(1, planet.skyHorizon)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 64, 256)
  }))

  // The sky and the sun are the far plane of a landing site, not part of any one
  // world - and the worlds are not the same size. Earth's valley is a ball of a
  // kilometre, so a dome sized for the Moon's ninety-six metres would leave you
  // standing outside it, looking at the inside of the ground.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(SURFACE_SKY_RADIUS, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTextures[0], side: THREE.BackSide, fog: false }),
  )
  surfaceScene.add(sky)
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunGlowTexture(),
    transparent: true, depthWrite: false, fog: false,
  }))
  sunSprite.position.copy(SUN_DIRECTION).multiplyScalar(SURFACE_SUN_DISTANCE)
  sunSprite.scale.setScalar(SUN_BASE_SCALE)
  surfaceScene.add(sunSprite)
  // and the disc inside that glare, at an angle you could actually measure
  const sunDisc = new THREE.Sprite(new THREE.SpriteMaterial({
    map: discTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }))
  sunDisc.position.copy(SUN_DIRECTION).multiplyScalar(SURFACE_SUN_DISTANCE)
  sunDisc.scale.setScalar(SUN_DISC_SCALE)
  surfaceScene.add(sunDisc)

  // the crown: two ray layers turning against each other, so the spikes shimmer
  // rather than sitting there as one flat decal
  const rayLayers = [1, 0.62].map((shrink, index) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: raysTexture(), transparent: true, opacity: index === 0 ? 1 : 0.6,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }))
    sprite.position.copy(SUN_DIRECTION).multiplyScalar(SURFACE_SUN_DISTANCE)
    sprite.scale.setScalar(SUN_RAY_SCALE * shrink)
    surfaceScene.add(sprite)
    return sprite
  })

  /**
   * Nothing but the sun itself draws after the cloud deck. It is the one thing in
   * the sky that is allowed to burn through a thin veil, and left in the normal
   * transparent order - farthest first - the clouds are drawn over the top of it
   * and take a quarter of its light away. Terrain still hides it, because terrain
   * is opaque and writes depth; the clouds are not and do not.
   *
   * The aureole around the disc is blended, not added. Added light can only ever
   * end up white: the sky behind it is already near the top of its range, so
   * red, green and blue all clip and the sun comes out a colourless hole. Letting
   * it cover the sky instead is the only way it can be gold.
   */
  for (const sprite of [sunSprite, sunDisc, ...rayLayers]) sprite.renderOrder = 1

  /**
   * The Earth, for the Moon's sky.
   *
   * It is not lit by the key light, and that is on purpose: it is a world two
   * hundred and forty thousand miles away being lit by the same sun that lights
   * this one, and pointing our directional light at it would light the wrong side
   * of it and swing its terminator about as the janitor walks. A flat unlit disc
   * at the right size and in the right place is the honest cheat.
   *
   * Fixed in the sky, because the Moon is tidally locked: it hangs at about
   * forty-seven degrees over the landing site, which is where a real one would
   * be from a site near the sub-Earth point, and it is drawn a little larger than
   * life for the same reason the sun is.
   */
  const EARTH_SKY_DISTANCE = 4200
  const EARTH_SKY_RADIUS = 110
  const EARTH_SKY_DIRECTION = new THREE.Vector3(0.7901, -0.5344, -0.3271).normalize()
  const earthInSky = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_SKY_RADIUS, 48, 32),
    new THREE.MeshBasicMaterial({ map: lunarEarthTexture(1024), fog: false }),
  )
  earthInSky.position.copy(EARTH_SKY_DIRECTION).multiplyScalar(EARTH_SKY_DISTANCE)
  earthInSky.rotation.z = 0.41
  earthInSky.visible = false
  surfaceScene.add(earthInSky)

  /**
   * Lens ghosts. They are a screen-space effect - the whole point of them is that
   * they lie on the line through the middle of the frame - so rather than parenting
   * them to the camera, which the space scene shares, they are placed in front of
   * it every frame in its own basis.
   */
  const flareGhosts = [
    { at: 0.34, size: 0.044, tint: 0xfff2d6 },
    { at: 0.64, size: 0.025, tint: 0xc6ffd6 },
    { at: 0.98, size: 0.064, tint: 0xffd7ac },
    { at: 1.3, size: 0.031, tint: 0xd6ccff },
    { at: 1.66, size: 0.05, tint: 0xffe4bd },
  ].map((def) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flareTexture(), color: def.tint, transparent: true, opacity: 0.36,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }))
    sprite.visible = false
    surfaceScene.add(sprite)
    return { sprite, def }
  })

  /**
   * A cloud deck, for the worlds that have air. The cloud map is equirectangular,
   * so it wraps a shell as happily as it wraps the globe - and seen from inside,
   * that shell is a sky rather than a planet, which is the point: this is the one
   * place in the game where looking up should show you something.
   */
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(SURFACE_CLOUD_RADIUS, 32, 16),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.BackSide,
      depthWrite: false, fog: false, alphaMap: loadMap('/textures/earth_clouds.webp', 2, false).texture,
    }),
  )
  clouds.visible = false
  surfaceScene.add(clouds)

  // the LOD streamer: one queue, one per-frame budget, every world in the game
  const lod = createLodStreamer()
  const SURFACE_ID_BASE = 10

  // space bodies: impostor → low-poly globe → hand-painted detail, all streamed
  const spaceBodies: SpaceBody[] = [earthBody, moonBody, marsBody]
  for (const body of spaceBodies) {
    lod.register({
      id: body.id,
      tuning: LOD_SPACE_TUNING,
      root: body.root,
      impostor: { object: body.glow, fade: [body.glow.material] },
      build(tier) {
        if (tier === 1) return oneshotBuild(1, { object: body.makeLowTier() })
        const group = new THREE.Group()
        return generatorBuild(2, { object: group }, body.detailBuilder(group))
      },
      estimate(tier) {
        return tier === 1 ? LOD_COST_STANDIN : LOD_COST_DETAIL
      },
    })
  }

  function radiusAt(planetId: number, lat: number, lon: number): number {
    const build = surfaceBuild(planetId)
    return build ? build.terrainRadius(lat, lon) : planetById(planetId).surfaceRadius
  }

  function applyPlanetTheme(planetId: number) {
    const planet = planetById(planetId)
    const look = themeLooks[planet.theme]
    sky.material.map = skyTextures[planet.id] ?? skyTextures[0]
    sky.material.needsUpdate = true
    sunSprite.material.color.setHex(look.sunTint)
    sunSprite.scale.setScalar(SUN_BASE_SCALE * (look.sunScale / 130))
    // the core stays white-hot while everything around it goes gold: that is what
    // you actually see when you look at a sun, a white centre in a haze of it
    // the core stays white-hot inside the pale halo - that is what you actually
    // see when you look up at it - so the disc is pulled most of the way to white
    // while the aureole and the spikes keep the colour
    sunDisc.material.color.setHex(look.sunTint).lerp(FLARE_WHITE, 0.28)
    for (const ray of rayLayers) ray.material.color.setHex(look.sunTint)
    // only the worlds with air have anything to put in the sky
    clouds.visible = planet.theme === 'earth'
    // and the Moon is the one place you can see home from
    earthInSky.visible = planet.theme === 'moon'
    // he only wears the helmet where there is nothing to breathe: on Earth the
    // cap is the hat he actually wears, and the shell is strapped to the lander
    janitor.helmet.visible = planet.theme !== 'earth'
    janitor.cap.visible = planet.theme === 'earth'
    surfaceHemisphere.color.setHex(look.skyLight)
    surfaceHemisphere.groundColor.setHex(look.groundLight)
    surfaceKey.color.setHex(look.keyLight)
    surfaceFill.color.setHex(look.fill)
  }

  // three landable worlds, streamed in ahead of the janitor (plan §9)
  let terrainSeed = -1
  let activePlanetId = -1
  const surfaceRoots: THREE.Group[] = []
  const surfaceJobs: SurfaceJob[] = []
  /** worlds whose shaders and textures have already been handed to the GPU */
  const warmedSurfaces = new Set<number>()
  const warmCamera = new THREE.PerspectiveCamera()

  function surfaceBuild(planetId: number): SurfaceBuild | null {
    return surfaceJobs[planetId]?.build ?? null
  }

  function disposeSurfaceJobs() {
    cargoMesh.removeFromParent()
    parked.group.removeFromParent()
    for (let planetId = 0; planetId < surfaceRoots.length; planetId++) {
      lod.unregister(SURFACE_ID_BASE + planetId)
      const root = surfaceRoots[planetId]
      if (!root) continue
      surfaceScene.remove(root)
      root.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
          object.geometry.dispose()
        }
        if (
          object instanceof THREE.Mesh || object instanceof THREE.Points
          || object instanceof THREE.Line || object instanceof THREE.Sprite
        ) {
          for (const item of Array.isArray(object.material) ? object.material : [object.material]) {
            const texture = (item as { map?: THREE.Texture | null }).map
            if (texture) texture.dispose()
            item.dispose()
          }
        }
      })
    }
    surfaceRoots.length = 0
    surfaceJobs.length = 0
    activePlanetId = -1
  }

  /** New seed = new worlds: throw the old surfaces away and queue the new ones. */
  function syncSurfaceJobs(game: Game) {
    const seed = game.seed >>> 0
    if (surfaceJobs.length === PLANETS.length && terrainSeed === seed) return
    disposeSurfaceJobs()
    terrainSeed = seed
    for (let planetId = 0; planetId < PLANETS.length; planetId++) {
      const job = createSurfaceJob(planetId, seed)
      const root = new THREE.Group()
      root.visible = false
      root.add(job.standIn)
      surfaceScene.add(root)
      surfaceRoots[planetId] = root
      surfaceJobs[planetId] = job
      lod.register({
        id: SURFACE_ID_BASE + planetId,
        tuning: LOD_SURFACE_TUNING,
        root,
        impostor: { object: job.standIn, fade: [job.standIn.material] },
        build: (): LodBuild => ({
          to: 2,
          layer: { object: job.detail, pop: 1 },
          slice: () => job.slice(),
          commit: () => {},
        }),
        estimate: () => job.costMs,
      })
    }
  }

  /**
   * The hard guarantee behind the warm-ahead queue: whoever we are standing on
   * is real, whatever the scheduler was busy with. In practice the queue got
   * there first (the approach was queued seconds before the landing zone), so
   * this only fires on a cold boot or an instant "START".
   */
  function ensureActiveSurface(game: Game) {
    const job = surfaceJobs[game.planetId]
    if (!job || job.build) return
    let guard = 0
    while (!job.slice() && guard++ < 256) {
      /* run the whole build out in one go: the ground cannot wait for the queue */
    }
  }

  function setActivePlanet(planetId: number) {
    if (activePlanetId === planetId) return
    const build = surfaceBuild(planetId)
    if (!build) return
    activePlanetId = planetId
    for (let i = 0; i < surfaceRoots.length; i++) surfaceRoots[i].visible = i === planetId
    // the parked tug and the waiting cargo pile live on the active lander pad
    build.lander.add(cargoMesh)
    build.lander.add(parked.group)
    applyPlanetTheme(planetId)
  }

  // -------------------------------------------------------------- LOD feed
  const viewerPos = new THREE.Vector3()
  const bodyOffset = new THREE.Vector3()
  const spaceQueries: LodQuery[] = PLANETS.map((_, id) => ({ id, distance: 0, closing: 0, minTier: 0 }))
  const surfaceQueries: LodQuery[] = PLANETS.map((_, id) => ({
    id: SURFACE_ID_BASE + id, distance: 0, closing: 0, minTier: 0,
  }))
  const lodQueries: LodQuery[] = [...spaceQueries, ...surfaceQueries]

  /**
   * Tell the streamer where the janitor is and how fast the worlds are coming
   * at him. The ship always holds a valid world position — parked on a pad, on
   * the launch rail or docked — so one measurement covers every mode.
   */
  function updateLod(game: Game, dt: number) {
    const ship = game.ship
    viewerPos.set(ship.x, ship.y, ship.z)
    const landing = landTarget(game)
    for (let id = 0; id < PLANETS.length; id++) {
      const pos = game.planetPos[id]
      bodyOffset.set(pos.x - viewerPos.x, pos.y - viewerPos.y, pos.z - viewerPos.z)
      const distance = bodyOffset.length()
      const closing = distance > 1e-3
        ? (ship.vx * bodyOffset.x + ship.vy * bodyOffset.y + ship.vz * bodyOffset.z) / distance
        : 0
      const space = spaceQueries[id]
      space.distance = distance
      space.closing = closing
      space.minTier = 0
      const surface = surfaceQueries[id]
      surface.distance = distance
      surface.closing = closing
      // standing on a world, or cleared to land on it: full detail is not optional
      surface.minTier = (game.mode === 'surface' && game.planetId === id) || landing === id ? 2 : 0
    }
    lod.update(lodQueries, dt)

    // Pre-warm a world the streamer has finished building but the GPU has never
    // seen: the first render of a surface costs ~120 ms of shader compiles and
    // texture uploads, which would otherwise land mid-landing. Compiling on the
    // approach moves that cost somewhere nobody is looking at a fade.
    for (let id = 0; id < PLANETS.length; id++) {
      if (warmedSurfaces.has(id) || lod.tierOf(SURFACE_ID_BASE + id) < 2) continue
      const build = surfaceBuild(id)
      if (!build) continue
      warmedSurfaces.add(id)
      // the shared surface dressing (sky, dust, meteors) only needs warming once
      if (warmedSurfaces.size === 1) warmSurface(surfaceScene)
      warmSurface(build.group)
    }
  }

  /**
   * Hand the GPU a scene's programs and textures ahead of the first draw.
   * `compile` walks only visible objects, so the root is shown for the walk and
   * hidden again — no rendering happens, so nothing reaches the screen.
   */
  function warmSurface(root: THREE.Object3D) {
    if (reducedMotion) return
    const wasVisible = root.visible
    root.visible = true
    renderer.compile(root, warmCamera)
    root.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (!material) return
      for (const entry of Array.isArray(material) ? material : [material]) {
        const maps = entry as unknown as Record<string, THREE.Texture | undefined>
        for (const key of ['map', 'alphaMap', 'emissiveMap', 'normalMap', 'roughnessMap', 'aoMap']) {
          const texture = maps[key]
          if (texture) renderer.initTexture(texture)
        }
      }
    })
    root.visible = wasVisible
  }

  /** Sky, fog and light follow the planet, and get eaten by a Mars storm. */
  function updateSurfaceMood(game: Game) {
    const planet = planetById(game.planetId)
    const look = themeLooks[planet.theme]
    const storm = planet.theme === 'mars' ? clampValue(game.hazards.stormIntensity, 0, 1) : 0
    const fog = surfaceScene.fog as THREE.Fog
    fog.color.setHex(planet.fogColor).lerp(stormFog, storm * 0.9)
    fog.near = planet.fogNear + (11 - planet.fogNear) * storm
    fog.far = planet.fogFar + (96 - planet.fogFar) * storm
    surfaceKey.intensity = look.keyIntensity * (1 - storm * 0.55)
    surfaceHemisphere.intensity = look.hemiIntensity * (1 - storm * 0.4)
    surfaceFill.intensity = look.fillIntensity * (1 - storm * 0.3)
    sunSprite.material.opacity = (0.9 + Math.sin(elapsed * 1.6) * 0.06) * (1 - storm * 0.85)
    skyColor.setScalar(1 - storm * 0.42).lerp(stormFog, storm * 0.45)
    sky.material.color.copy(skyColor)
  }

  // hazard visuals: the Moon meteor, and what it leaves behind
  /**
   * The stone that comes down with the shower.
   *
   * There was no rock before. The telegraph was a shadow, a ring and a
   * nineteen-metre line, and the line was the only part of it that existed
   * anywhere except on the ground. The stone is a real body at a real distance
   * now, so the approach reads the way an approach should - a speck while it is
   * high, a boulder by the time it is close - out of the same perspective that
   * turns a planet from a point of light into a world as you fly at it.
   */
  const METEOR_START_HEIGHT = 300
  const METEOR_START_REACH = 260
  const METEOR_TRAIL = 38

  const meteorStone = new THREE.Mesh(
    (() => {
      const geometry = new THREE.IcosahedronGeometry(METEOR_RADIUS, 2)
      const position = geometry.attributes.position
      const vertex = new THREE.Vector3()
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).normalize()
        // hashed off the unit direction, so the copies a polyhedron makes of each
        // corner for its separate faces all get the same displacement. Rolling a
        // fresh number per vertex tears the rock open at every shared edge.
        const lump = 0.78 + hashDirection(vertex) * 0.44
        position.setXYZ(i, vertex.x * METEOR_RADIUS * lump, vertex.y * METEOR_RADIUS * lump, vertex.z * METEOR_RADIUS * lump)
      }
      geometry.computeVertexNormals()
      return geometry
    })(),
    new THREE.MeshStandardMaterial({
      color: 0x6b625a, roughness: 0.95, metalness: 0.04, flatShading: true,
      emissive: 0xd4480f, emissiveIntensity: 1.1,
    }),
  )
  const meteorHeat = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255, 226, 176, 1)', 'rgba(255, 96, 20, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  const meteorTrail = new THREE.Group()
  // a cone rather than a streak: it has to lie along the way the stone is
  // travelling, and a sprite's one axis is the camera's up, not the path's. It is
  // long and faint because most of the time you are looking at it end-on, and a
  // short bright one reads as a disc stuck on the back of the rock.
  for (const width of [0.7, 1.6]) {
    meteorTrail.add(new THREE.Mesh(
      new THREE.ConeGeometry(METEOR_RADIUS * width, METEOR_TRAIL, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff8a44, transparent: true, opacity: width < 1 ? 0.3 : 0.11,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    ))
  }
  const meteorShadow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 40),
    new THREE.MeshBasicMaterial({
      color: 0x3a0806, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide,
    }),
  )
  const meteorRing = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.09, 6, 48),
    new THREE.MeshBasicMaterial({
      color: 0xff7048, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  )
  for (const object of [meteorStone, meteorHeat, meteorTrail, meteorShadow, meteorRing]) {
    object.visible = false
    surfaceScene.add(object)
  }

  // and the strike itself: a flash, a shock ring running out along the ground,
  // a scorch it leaves, and a column of dust going up
  const impactFlash = new THREE.Mesh(
    new THREE.SphereGeometry(1, 14, 10),
    new THREE.MeshBasicMaterial({
      color: 0xffe0ac, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  )
  const impactRing = new THREE.Mesh(
    new THREE.RingGeometry(0.78, 1, 56),
    new THREE.MeshBasicMaterial({
      color: 0xffb367, transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  )
  // a second ring trailing the first: one wave of dust off a strike reads as a
  // decal painted on the ground, two read as ground being moved
  const impactRing2 = new THREE.Mesh(
    new THREE.RingGeometry(0.86, 1, 56),
    new THREE.MeshBasicMaterial({
      color: 0xd8894a, transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  )
  const impactScorch = new THREE.Mesh(
    new THREE.CircleGeometry(1, 40),
    new THREE.MeshBasicMaterial({
      color: 0x120c07, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    }),
  )
  const impactPlume = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(214, 198, 174, 0.9)', 'rgba(150, 132, 112, 0)'),
    transparent: true, depthWrite: false,
  }))
  for (const object of [impactFlash, impactRing, impactRing2, impactScorch, impactPlume]) {
    object.visible = false
    surfaceScene.add(object)
  }
  const impact = { active: false, t: 0 }
  const impactUp = new THREE.Vector3()
  const impactAt = new THREE.Vector3()
  const meteorIncoming = new THREE.Vector3()
  const meteorTangent = new THREE.Vector3()
  const meteorPath = new THREE.Vector3()

  // hazard visuals: the Mars dust field, drifting around the janitor
  const DUST_COUNT = 320
  const dustOffsets = new Float32Array(DUST_COUNT * 3)
  const dustSizes = new Float32Array(DUST_COUNT)
  {
    const rnd = makeRnd(4242)
    for (let i = 0; i < DUST_COUNT; i++) {
      dustOffsets[i * 3] = (rnd() * 2 - 1) * 38
      dustOffsets[i * 3 + 1] = 0.3 + rnd() * 16
      dustOffsets[i * 3 + 2] = (rnd() * 2 - 1) * 38
      dustSizes[i] = 0.5 + rnd() * 1.4
    }
  }
  const dustMesh = new THREE.InstancedMesh(
    new THREE.TetrahedronGeometry(0.5, 0),
    new THREE.MeshBasicMaterial({ color: 0xdba576, transparent: true, opacity: 0, depthWrite: false }),
    DUST_COUNT,
  )
  dustMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  dustMesh.frustumCulled = false
  dustMesh.count = 0
  dustMesh.visible = false
  surfaceScene.add(dustMesh)

  // junk on the ground, plus faint pickup beacons so sweeps stay readable
  const JUNK_CLASSES: JunkClass[] = ['scrap', 'tech', 'hazardous', 'relic']
  const junkGeometry: Record<JunkClass, THREE.BufferGeometry> = {
    scrap: new THREE.BoxGeometry(1.15, 0.75, 0.95),
    tech: new THREE.IcosahedronGeometry(0.62, 0),
    hazardous: new THREE.CylinderGeometry(0.42, 0.42, 1.0, 10),
    relic: new THREE.OctahedronGeometry(0.8, 0),
  }
  const junkMaterial: Record<JunkClass, THREE.MeshStandardMaterial> = {
    scrap: new THREE.MeshStandardMaterial({ color: JUNK_COLORS.scrap, flatShading: true, roughness: 0.85 }),
    tech: new THREE.MeshStandardMaterial({
      color: JUNK_COLORS.tech, flatShading: true, roughness: 0.4, metalness: 0.3,
      emissive: 0x1d4a5c, emissiveIntensity: 0.7,
    }),
    hazardous: new THREE.MeshStandardMaterial({
      color: JUNK_COLORS.hazardous, flatShading: true, roughness: 0.6,
      emissive: 0x2a5a12, emissiveIntensity: 0.9,
    }),
    // relics have to read from a long way off: hot gold, lit from inside
    relic: new THREE.MeshStandardMaterial({
      color: JUNK_COLORS.relic, flatShading: true, roughness: 0.28, metalness: 0.55,
      emissive: 0xc07a12, emissiveIntensity: 1.5,
    }),
  }
  const junkMeshes = {} as Record<JunkClass, THREE.InstancedMesh>
  for (const cls of JUNK_CLASSES) {
    const mesh = new THREE.InstancedMesh(junkGeometry[cls], junkMaterial[cls], MAX_JUNK)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.count = 0
    surfaceScene.add(mesh)
    junkMeshes[cls] = mesh
  }
  // No pickup beacons: junk is found by looking at the ground, not by following a
  // marker to it. The relic keeps its halo and its glow - one piece, hidden on
  // purpose, and the only thing on the surface that has to be findable from a
  // distance.
  const relicHaloMesh = new THREE.InstancedMesh(
    new THREE.TorusGeometry(1.5, 0.07, 6, 20),
    new THREE.MeshBasicMaterial({
      color: 0xffe0a0, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    4,
  )
  relicHaloMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  relicHaloMesh.frustumCulled = false
  relicHaloMesh.count = 0
  surfaceScene.add(relicHaloMesh)
  // one glow sprite per planet, and only the active planet ever shows it
  const relicGlows = PLANETS.map(() => {
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture('rgba(255, 219, 138, 0.9)', 'rgba(255, 158, 40, 0)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    glow.scale.setScalar(6.5)
    glow.visible = false
    surfaceScene.add(glow)
    return glow
  })

  // the lander tug and the cargo pile it guards
  const parked = buildShip()
  parked.group.scale.setScalar(1.3)
  parked.group.position.set(0, 2.2, 0)
  parked.heroLight.intensity = 0        // daylight surface needs no fill, and it would pool on the ground
  parked.setThrust(0, false)            // engines off: the bells read as dark holes

  const cargoCapacity = 30
  const cargoMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.6, 0.6, 0.6),
    new THREE.MeshStandardMaterial({ color: 0xc98f5a, flatShading: true }),
    cargoCapacity,
  )
  cargoMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  cargoMesh.frustumCulled = false
  surfaceScene.add(cargoMesh)

  // the janitor
  const playerGroup = new THREE.Group()
  surfaceScene.add(playerGroup)
  const janitor = buildJanitor()
  playerGroup.add(janitor.group)
  const carriedMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.34, 0.34, 0.34),
    new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.7 }),
    12,
  )
  carriedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  carriedMesh.count = 0
  playerGroup.add(carriedMesh)
  /**
   * The janitor casts, and he is the one thing out here that moves, so his shadow
   * is what proves the light in the sky is the light on the ground. The visor
   * does not cast: it is a third opaque, and a shell of glass would drop a solid
   * black ball over his head. (His own parts are marked in the rig; this is for
   * the cargo he is carrying.)
   */
  carriedMesh.receiveShadow = true
  carriedMesh.castShadow = true

  const scoopRing = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.05, 6, 48),
    new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.4 }),
  )
  scoopRing.rotation.x = -Math.PI / 2
  surfaceScene.add(scoopRing)
  // the fake blob under the janitor is gone: he casts a real shadow now (the key
  // light is the sun), and two shadows under one pair of boots looks like a bug

  // ----------------------------------------------------- surface particles
  const surfaceParticles: Particle[] = []
  const surfaceParticleMesh = new THREE.InstancedMesh(
    new THREE.TetrahedronGeometry(0.36, 0),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }),
    MAX_PARTICLES,
  )
  surfaceParticleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  surfaceParticleMesh.frustumCulled = false
  surfaceParticleMesh.count = 0
  surfaceScene.add(surfaceParticleMesh)

  // -------------------------------------------------------------- helpers
  function spawnParticles(
    list: Particle[], position: THREE.Vector3, color: number, count: number, speed: number,
    gravity: number, centre: THREE.Vector3,
  ) {
    const total = reducedMotion ? Math.ceil(count * 0.4) : count
    for (let i = 0; i < total && list.length < MAX_PARTICLES; i++) {
      const velocity = new THREE.Vector3(
        Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1,
      ).normalize().multiplyScalar(speed * (0.35 + Math.random()))
      list.push({
        position: position.clone(),
        velocity,
        life: 0.5 + Math.random() * 0.55,
        maxLife: 1,
        color: new THREE.Color(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.2),
        size: 0.7 + Math.random() * 0.9,
        gravity,
        centre: centre.clone(),
      })
    }
  }

  /**
   * Ejecta: what a strike throws, rather than what a bang drops.
   *
   * The generic spawn is a ball, which is right for a hop or a landing and wrong
   * for an impact - a crater throws its material up and out, and a ball of debris
   * reads as something bursting in mid-air instead of punching the ground. This
   * throws a cone instead, and the caller fires it twice: heavy chips fast with
   * the ground's own pull on them, and fine dust slow with almost none.
   */
  function spawnEjecta(
    list: Particle[], from: THREE.Vector3, up: THREE.Vector3, count: number,
    speed: number, gravity: number, color: number, spread = 1.2,
  ) {
    const total = reducedMotion ? Math.ceil(count * 0.4) : count
    const tangent = new THREE.Vector3(0, 1, 0)
    if (Math.abs(up.y) > 0.9) tangent.set(1, 0, 0)
    tangent.crossVectors(up, tangent).normalize()
    const binormal = new THREE.Vector3().crossVectors(up, tangent)
    const direction = new THREE.Vector3()
    for (let i = 0; i < total && list.length < MAX_PARTICLES; i++) {
      const around = Math.random() * TAU
      const tilt = Math.pow(Math.random(), 0.65) * spread
      direction.copy(up).multiplyScalar(Math.cos(tilt))
        .addScaledVector(tangent, Math.sin(tilt) * Math.cos(around))
        .addScaledVector(binormal, Math.sin(tilt) * Math.sin(around))
      const life = 0.85 + Math.random() * 1.15
      list.push({
        position: from.clone().addScaledVector(direction, Math.random() * 1.6),
        velocity: direction.clone().multiplyScalar(speed * (0.45 + Math.random() * 0.9)),
        life,
        maxLife: life,
        color: new THREE.Color(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.3),
        size: 0.35 + Math.random() * 1.05,
        gravity,
        centre: new THREE.Vector3(0, 0, 0),
      })
    }
  }

  function updateParticles(list: Particle[], mesh: THREE.InstancedMesh, dt: number) {
    let alive = 0
    for (const particle of list) {
      particle.life -= dt
      if (particle.life <= 0) continue
      if (particle.gravity !== 0) {
        vA.copy(particle.centre).sub(particle.position).normalize().multiplyScalar(particle.gravity * dt)
        particle.velocity.add(vA)
      }
      particle.position.addScaledVector(particle.velocity, dt)
      particle.velocity.multiplyScalar(1 - 1.5 * dt)
      list[alive] = particle
      alive++
    }
    list.length = alive
    for (let i = 0; i < list.length && i < MAX_PARTICLES; i++) {
      const particle = list[i]
      dummy.position.copy(particle.position)
      dummy.rotation.set(particle.life * 5, particle.life * 4, 0)
      dummy.scale.setScalar(particle.size * Math.max(0.12, particle.life / particle.maxLife))
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      mesh.setColorAt(i, particle.color)
    }
    mesh.count = Math.min(list.length, MAX_PARTICLES)
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  // ------------------------------------------------------- scene updates
  function updateSpaceScene(game: Game, dt: number) {
    const earthPos = game.planetPos[0]
    earthSystem.position.set(earthPos.x, earthPos.y, earthPos.z)
    earthBody.spin(dt)

    // issPos is a world (Sun-centred) position but iss is a child of
    // earthSystem, which already sits at Earth - so subtract to get local
    iss.position.set(
      game.issPos.x - earthPos.x,
      game.issPos.y - earthPos.y,
      game.issPos.z - earthPos.z,
    )
    iss.rotation.y = -game.issAngle
    for (let i = 0; i < spinningRings.length; i++) {
      spinningRings[i].rotation.z += dt * (i === 0 ? 0.7 : -0.55)
    }
    const docking = canDock(game)
    hatchMaterial.color.setHex(docking ? 0x8dff9d : canLand(game) ? 0xffe066 : 0x7fe4ff)
    hatch.scale.setScalar(docking ? 1.25 + Math.sin(elapsed * 8) * 0.08 : 1)
    shopGlow.material.opacity = 0.68 + Math.sin(elapsed * 2.4) * 0.2

    moonRoot.position.set(game.moonPos.x, game.moonPos.y, game.moonPos.z)
    const marsPos = game.planetPos[2]
    marsSystem.position.set(marsPos.x, marsPos.y, marsPos.z)
    marsBody.spin(dt)

    const ship = game.ship
    const docked = game.mode === 'docked'
    if (docked) shipModel.group.position.set(game.dockPos.x, game.dockPos.y, game.dockPos.z)
    else shipModel.group.position.set(ship.x, ship.y, ship.z)
    shipModel.group.quaternion.set(ship.q.x, ship.q.y, ship.q.z, ship.q.w)
    const thrust = Math.max(0, ship.thrust)
    const firing = thrust > 0.12
    shipModel.setThrust(firing ? thrust : 0, firing && ship.boosting)
    if (!docked) shipModel.group.position.y += Math.sin(elapsed * 26) * 0.03 * (firing ? (ship.boosting ? 1.5 : 0.85) : 0)

    // key light comes from the Sun toward the action: parked between the Sun
    // and the ship so the lit hemisphere faces the Sun, as it should
    vA.copy(shipModel.group.position).normalize()
    spaceKey.position.copy(shipModel.group.position).addScaledVector(vA, -420)
    spaceKey.target.position.copy(shipModel.group.position)

    const stars = spaceScene.userData.stars as THREE.Points
    stars.rotation.y += dt * 0.002
    // the photosphere turns slowly, so the granulation is not a dead texture
    sun.rotation.y += dt * 0.012
    // up close the surface should dominate, so the halo thins as the ship nears
    // the Sun and comes back to full strength out in the system
    const sunRange = clampValue((shipModel.group.position.length() - SUN_RADIUS * 1.2) / (SUN_RADIUS * 3), 0, 1)
    sunGlow.material.opacity = (0.85 + Math.sin(elapsed * 1.4) * 0.08) * (0.3 + 0.7 * sunRange)
    sunCorona.material.opacity = 0.7 * (0.12 + 0.88 * sunRange)
    sunCorona.scale.setScalar(SUN_RADIUS * 2.6 * (1 + Math.sin(elapsed * 1.1) * 0.018))

    for (const label of labels) {
      label.getWorldPosition(vB)
      const distance = vB.distanceTo(cameraPosition)
      // labels hold their on-screen size: the reference is the world the object
      // belongs to, so a scaled planet's plate grows with it and the station's
      // does not
      const ref = (label.userData.scaleRef as number | undefined) ?? SPACE_SCALE
      const scale = clampValue((distance / ref) * 0.028, 5, 30) * ref
      label.scale.set(scale, scale * 0.3, 1)
    }
  }

  function updateSurfaceScene(game: Game, dt: number) {
    const surface = surfaceBuild(game.planetId)
    if (!surface) return
    const player = game.player
    const playerRadius = surface.terrainRadius(player.lat, player.lon) + player.h
    const up = dir(player.lat, player.lon, vA)
    const north = vB.set(
      -Math.sin(player.lat) * Math.cos(player.lon),
      Math.cos(player.lat),
      -Math.sin(player.lat) * Math.sin(player.lon),
    ).normalize()
    const east = vC.crossVectors(up, north).normalize()
    const forward = vD.copy(north).multiplyScalar(Math.cos(player.facing))
      .addScaledVector(east, Math.sin(player.facing)).normalize()

    playerGroup.position.copy(up).multiplyScalar(playerRadius)
    playerGroup.quaternion.setFromRotationMatrix(basisFor(up, forward, vE))
    playerGroup.visible = game.transition?.kind !== 'takeoff'
    poseJanitor(janitor, Math.hypot(player.vN, player.vE), player.h > 0.05, dt, elapsed)
    if (player.h > 0.05) {
      playerGroup.rotateX(-Math.min(0.45, player.h * 0.12))
    }
    aimKeyLightAt(playerGroup.position)

    const groundRadius = surface.terrainRadius(player.lat, player.lon)
    scoopRing.position.copy(up).multiplyScalar(groundRadius + 0.12)
    scoopRing.quaternion.setFromUnitVectors(Z_AXIS, up)
    scoopRing.scale.setScalar(scoopRadius(game))
    scoopRing.material.opacity = 0.2 + Math.sin(elapsed * 3) * 0.06

    // lander
    const inRing = nearLander(game)
    surface.ringMaterial.color.setHex(game.oxygen < OXYGEN_WARN ? 0xffb0a0 : inRing ? 0x9dffb0 : 0x7fffb0)
    surface.ringMaterial.opacity = inRing ? 0.8 : 0.4 + Math.sin(elapsed * 2.2) * 0.1
    surface.padBeacon.material.opacity = inRing ? 0.95 : 0.45 + Math.sin(elapsed * 2.4) * 0.16
    if (game.transition?.kind === 'takeoff') {
      const t = Math.min(1, game.transition.t / game.transition.duration)
      parked.group.position.set(0, 2.2 + t * t * 30, 0)
      parked.group.scale.setScalar(1.3 * (1 - t * 0.2))
    } else {
      parked.group.position.set(0, 2.2, 0)
      parked.group.scale.setScalar(1.3)
    }
    if (game.transition?.kind === 'landing') {
      const t = Math.min(1, game.transition.t / game.transition.duration)
      surface.landingRing.scale.setScalar(1 + (1 - t) * 0.14 + Math.sin(elapsed * 9) * 0.05)
    } else {
      surface.landingRing.scale.setScalar(1)
    }

    // cargo pile beside the pad: what is waiting in the hold
    const stored = holdCount(game)
    for (let i = 0; i < cargoCapacity; i++) {
      const layer = Math.floor(i / 10)
      const index = i % 10
      const side = layer % 2 === 0 ? 1 : -1
      dummy.position.set(
        side * (3.4 + Math.floor(index / 5) * 0.66),
        0.3 + Math.floor(index / 5) * 0.02,
        -3.6 + layer * 1.05 + (index % 5) * 0.66,
      )
      dummy.rotation.set(0, 0, 0)
      dummy.scale.setScalar(i < stored ? 1 : 0.0001)
      dummy.updateMatrix()
      cargoMesh.setMatrixAt(i, dummy.matrix)
    }
    cargoMesh.instanceMatrix.needsUpdate = true

    // ground junk for the planet under our feet only
    const counts: Record<JunkClass, number> = { scrap: 0, tech: 0, hazardous: 0, relic: 0 }
    let relicHaloCount = 0
    let glowPlaced = false
    for (const glow of relicGlows) glow.visible = false
    const relicGlow = relicGlows[game.planetId]
    for (const item of game.junk) {
      if (item.status !== 'ground' || item.planet !== game.planetId) continue
      const radius = surface.terrainRadius(item.lat, item.lon)
      dir(item.lat, item.lon, up)
      dummy.position.copy(up).multiplyScalar(radius + 0.45)
      dummy.quaternion.setFromUnitVectors(UP, up)
      dummy.rotateY(item.yaw + elapsed * item.spin * 0.35)
      dummy.scale.setScalar(item.cls === 'relic' ? 1.2 : 1)
      dummy.updateMatrix()
      const count = counts[item.cls]
      if (count < MAX_JUNK) {
        junkMeshes[item.cls].setMatrixAt(count, dummy.matrix)
        counts[item.cls] = count + 1
      }
      if (item.cls !== 'relic') continue
      if (relicHaloCount < relicHaloMesh.instanceMatrix.count) {
        dummy.position.copy(up).multiplyScalar(radius + 2.6 + Math.sin(elapsed * 1.9) * 0.22)
        dummy.quaternion.setFromUnitVectors(UP, up)
        dummy.rotateY(elapsed * 1.5)
        dummy.rotateX(elapsed * 0.9)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        relicHaloMesh.setMatrixAt(relicHaloCount, dummy.matrix)
        relicHaloCount++
      }
      if (relicGlow && !glowPlaced) {
        relicGlow.position.copy(up).multiplyScalar(radius + 1.9 + Math.sin(elapsed * 2.2) * 0.25)
        relicGlow.material.opacity = 0.55 + Math.sin(elapsed * 3.1) * 0.16
        relicGlow.visible = true
        glowPlaced = true
      }
    }
    for (const cls of JUNK_CLASSES) {
      junkMeshes[cls].count = counts[cls]
      junkMeshes[cls].instanceMatrix.needsUpdate = true
    }
    relicHaloMesh.count = relicHaloCount
    relicHaloMesh.instanceMatrix.needsUpdate = true

    // carried junk rides on the backpack
    let carried = 0
    for (const item of game.junk) {
      if (item.status !== 'carried' || item.planet !== game.planetId) continue
      dummy.position.set(-0.28 + (carried % 3) * 0.28, 1.75 + Math.floor(carried / 3) * 0.34, -0.52)
      dummy.quaternion.identity()
      dummy.rotation.set(0.3, carried * 0.7, 0.2)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      carriedMesh.setMatrixAt(carried, dummy.matrix)
      carriedMesh.setColorAt(carried, tmpColor.setHex(JUNK_COLORS[item.cls]))
      carried++
      if (carried >= 12) break
    }
    carriedMesh.count = carried
    carriedMesh.instanceMatrix.needsUpdate = true
    if (carriedMesh.instanceColor) carriedMesh.instanceColor.needsUpdate = true

    sky.rotation.y += dt * 0.004
    // and the deck drifts the other way, so the sky is not one rigid thing
    clouds.rotation.y -= dt * 0.011
    // the crown turns too, the two layers against each other, so the spikes
    // shimmer instead of sitting there as one flat decal
    rayLayers[0].material.rotation += dt * 0.021
    rayLayers[1].material.rotation -= dt * 0.034
    // the river runs: scroll the ripple downstream, so standing water between
    // two banks becomes a river that is going somewhere
    const flow = riverFlow()
    flow.offset.y -= dt * 0.42
    // and the wind park turns, which is the difference between a turbine and a
    // mast with three planks on it
    const spin = dt * (0.5 + (game.hazards.stormIntensity ?? 0) * 2.4)
    for (const rotor of windRotors) rotor.rotation.z += spin
    updateSurfaceMood(game)
    updateMeteor(game, dt)
    updateDustStorm(game, dt)
  }

  /** Moon hazard: the stone on its way down, and what is left when it lands. */
  function updateMeteor(game: Game, dt: number) {
    const surface = surfaceBuild(game.planetId)
    const hazards = game.hazards
    const falling = game.planetId === 1 && !!surface
      && hazards.meteorTelegraph >= 0 && hazards.meteorDelay > 0
    meteorStone.visible = falling
    meteorHeat.visible = falling
    meteorTrail.visible = falling
    meteorShadow.visible = falling
    meteorRing.visible = falling

    if (falling && surface) {
      const t = clampValue(hazards.meteorTelegraph / hazards.meteorDelay, 0, 1)
      const up = dir(hazards.meteorLat, hazards.meteorLon, vA)
      const radius = surface.terrainRadius(hazards.meteorLat, hazards.meteorLon)

      // It has to come in on a slant, not from straight up. The target is twenty
      // metres away, so a stone dropped from directly overhead stands at
      // eighty-six degrees of elevation - past the top of a camera that can only
      // look up thirty-six - and the whole approach happens out of frame. Angled
      // off a tangent it comes down across the sky instead, and you watch it the
      // whole way. The bearing is hashed off the impact point, so it is fixed for
      // the volley and different next time.
      meteorTangent.set(0, 1, 0)
      if (Math.abs(up.y) > 0.9) meteorTangent.set(1, 0, 0)
      meteorIncoming.crossVectors(up, meteorTangent).normalize()
      meteorTangent.crossVectors(up, meteorIncoming).normalize()
      const swing = hashDirection(up) * TAU
      meteorIncoming.multiplyScalar(Math.cos(swing)).addScaledVector(meteorTangent, Math.sin(swing))
      // and the way it is travelling, which is what the trail lies along
      meteorPath.copy(up).multiplyScalar(METEOR_START_HEIGHT)
        .addScaledVector(meteorIncoming, METEOR_START_REACH).normalize()

      // Most of the warning is spent high and small, and then it closes fast: a
      // square law drops it out of the sky in the last third with nothing left to
      // watch, and a linear one never looks like it is falling at all.
      const close = Math.pow(1 - t, 1.5)
      meteorStone.position.copy(up).multiplyScalar(radius + METEOR_START_HEIGHT * close)
      meteorStone.position.addScaledVector(meteorIncoming, METEOR_START_REACH * close)
      meteorStone.rotation.set(elapsed * 1.9, elapsed * 2.6, elapsed * 1.1)

      // it grows into its own heat on the way down: airless or not, something
      // arriving this fast has a leading face you would not want to look at
      meteorHeat.position.copy(meteorStone.position)
      meteorHeat.scale.setScalar(METEOR_RADIUS * (3.4 + t * 2.2))
      meteorHeat.material.opacity = 0.4 + t * 0.55

      meteorTrail.position.copy(meteorStone.position).addScaledVector(meteorPath, METEOR_TRAIL * 0.5)
      meteorTrail.quaternion.setFromUnitVectors(UP, meteorPath)

      // and the ground marker underneath it, tightening as it closes
      meteorShadow.position.copy(up).multiplyScalar(radius + 0.12)
      meteorShadow.quaternion.setFromUnitVectors(Z_AXIS, up)
      meteorShadow.scale.setScalar(METEOR_RADIUS * (1.6 - 0.6 * t))
      meteorShadow.material.opacity = 0.15 + t * 0.7

      meteorRing.position.copy(up).multiplyScalar(radius + 0.3)
      meteorRing.quaternion.setFromUnitVectors(Z_AXIS, up)
      meteorRing.scale.setScalar(METEOR_RADIUS * (1.05 + Math.sin(elapsed * 9) * 0.1) * (1.5 - 0.5 * t))
      meteorRing.material.opacity = 0.3 + t * 0.45 + Math.sin(elapsed * 12) * 0.08
    }

    updateMeteorImpact(dt)
  }

  /**
   * The strike, over the seven seconds it takes to play out: a flash that blooms
   * and is gone, a shock ring running out along the ground faster than the eye
   * follows it, a column of dust standing up out of the hole, and a scorch that
   * is still there long after the noise has stopped.
   */
  function updateMeteorImpact(dt: number) {
    if (!impact.active) return
    impact.t += dt
    const t = impact.t

    impactFlash.position.copy(impactAt)
    impactRing.position.copy(impactAt)
    impactRing.quaternion.setFromUnitVectors(Z_AXIS, impactUp)
    impactRing2.position.copy(impactAt)
    impactRing2.quaternion.setFromUnitVectors(Z_AXIS, impactUp)
    impactScorch.position.copy(impactAt)
    impactScorch.quaternion.setFromUnitVectors(Z_AXIS, impactUp)

    const flash = clampValue(t / 0.34, 0, 1)
    impactFlash.visible = flash < 1
    impactFlash.scale.setScalar(1.6 + flash * 9)
    impactFlash.material.opacity = (1 - flash) * (1 - flash)

    const shock = clampValue(t / 0.62, 0, 1)
    impactRing.visible = shock < 1
    impactRing.scale.setScalar(METEOR_RADIUS * (0.7 + shock * 5.2))
    impactRing.material.opacity = (1 - shock) * (1 - shock) * 0.95

    const shock2 = clampValue((t - 0.17) / 0.78, 0, 1)
    impactRing2.visible = t > 0.17 && shock2 < 1
    impactRing2.scale.setScalar(METEOR_RADIUS * (1.1 + shock2 * 6.6))
    impactRing2.material.opacity = (1 - shock2) * (1 - shock2) * 0.6

    const plume = clampValue(t / 1.5, 0, 1)
    impactPlume.visible = plume < 1
    impactPlume.position.copy(impactAt).addScaledVector(impactUp, 1 + plume * 11)
    impactPlume.scale.set(7 + plume * 26, 6 + plume * 20, 1)
    impactPlume.material.opacity = (1 - plume) * (1 - plume) * 0.8

    const cool = clampValue(t / 7, 0, 1)
    impactScorch.visible = true
    impactScorch.scale.setScalar(METEOR_RADIUS * (1.15 + cool * 0.5))
    impactScorch.material.opacity = (1 - cool) * (1 - cool) * 0.72

    if (t >= 7) {
      impact.active = false
      for (const object of [impactFlash, impactRing, impactRing2, impactScorch, impactPlume]) {
        object.visible = false
      }
    }
  }

  /** Mars hazard: dust that wraps around the janitor, driven by stormIntensity. */
  function updateDustStorm(game: Game, dt: number) {
    const intensity = planetById(game.planetId).theme === 'mars'
      ? clampValue(game.hazards.stormIntensity, 0, 1)
      : 0
    if (intensity < 0.02) {
      dustMesh.visible = false
      dustMesh.count = 0
      return
    }
    const surface = surfaceBuild(game.planetId)
    if (!surface) return
    const player = game.player
    const up = dir(player.lat, player.lon, vA)
    const north = vB.set(
      -Math.sin(player.lat) * Math.cos(player.lon),
      Math.cos(player.lat),
      -Math.sin(player.lat) * Math.sin(player.lon),
    ).normalize()
    const east = vC.crossVectors(up, north).normalize()
    const base = surface.terrainRadius(player.lat, player.lon)
    const drift = (5 + intensity * 22) * dt
    const count = Math.max(
      1, Math.round(DUST_COUNT * Math.min(1, intensity * 1.6) * (reducedMotion ? 0.5 : 1)),
    )
    for (let i = 0; i < count; i++) {
      const index = i * 3
      dustOffsets[index] += drift
      if (dustOffsets[index] > 38) dustOffsets[index] -= 76
      dustOffsets[index + 2] += drift * 0.4
      if (dustOffsets[index + 2] > 38) dustOffsets[index + 2] -= 76
      dustOffsets[index + 1] += Math.sin(elapsed * 0.8 + i) * dt * 1.6
      if (dustOffsets[index + 1] > 16.3) dustOffsets[index + 1] = 0.3
      else if (dustOffsets[index + 1] < 0.3) dustOffsets[index + 1] = 16.3
      dummy.position.copy(up).multiplyScalar(base + dustOffsets[index + 1])
        .addScaledVector(east, dustOffsets[index])
        .addScaledVector(north, dustOffsets[index + 2])
      dummy.rotation.set(elapsed * 3 + i, elapsed * 2.4 + i * 0.6, 0)
      dummy.scale.setScalar(dustSizes[i])
      dummy.updateMatrix()
      dustMesh.setMatrixAt(i, dummy.matrix)
    }
    dustMesh.instanceMatrix.needsUpdate = true
    dustMesh.count = count
    dustMesh.visible = true
    dustMesh.material.opacity = 0.5 * intensity
  }

  function updateCamera(game: Game, dt: number, inSpace: boolean) {
    if (inSpace) {
      const ship = game.ship
      const docked = game.mode === 'docked'
      quatForward(ship.q, flightForward)
      quatUp(ship.q, flightUp)
      shipForward.set(flightForward.x, flightForward.y, flightForward.z)
      shipUp.set(flightUp.x, flightUp.y, flightUp.z)
      if (docked) shipOrigin.set(game.dockPos.x, game.dockPos.y, game.dockPos.z)
      else shipOrigin.set(ship.x, ship.y, ship.z)
      const distance = docked ? 19 : 13
      const height = docked ? 8 : 4.2
      // The offset itself is rigid: lagging the camera behind a target that
      // outruns it is what pulled the view off the tug at boost (the gap grows
      // with speed). The ease lives in the smoothed basis and in the pull-back
      // into dock, so framing holds at a crawl and at full throttle alike.
      const basisBlend = firstFrame ? 1 : 1 - Math.pow(0.0022, dt)
      followForward.lerp(shipForward, basisBlend).normalize()
      followUp.lerp(shipUp, basisBlend).normalize()
      const rangeBlend = firstFrame ? 1 : 1 - Math.pow(0.004, dt)
      followDistance += (distance - followDistance) * rangeBlend
      followHeight += (height - followHeight) * rangeBlend
      camWish.copy(shipOrigin).addScaledVector(followForward, -followDistance).addScaledVector(followUp, followHeight)
      camLook.copy(shipOrigin)
        .addScaledVector(followForward, docked ? 0 : 6)
        .addScaledVector(followUp, docked ? 0.6 : 1.2)
      camUpWish.copy(UP).lerp(shipUp, docked ? 0.4 : 0.75).normalize()
      cameraPosition.copy(camWish)
      cameraTarget.copy(camLook)
      if (firstFrame) {
        cameraUp.copy(camUpWish)
      } else {
        cameraUp.lerp(camUpWish, 1 - Math.pow(docked ? 0.05 : 0.03, dt))
        // a fully inverted roll can cancel the blend: fall back to the wish up
        if (cameraUp.lengthSq() < 1e-4) cameraUp.copy(camUpWish)
        cameraUp.normalize()
      }
    } else {
      const player = game.player
      const up = dir(player.lat, player.lon, vA)
      const north = vB.set(
        -Math.sin(player.lat) * Math.cos(player.lon),
        Math.cos(player.lat),
        -Math.sin(player.lat) * Math.sin(player.lon),
      ).normalize()
      const east = vC.set(-Math.sin(player.lon), 0, Math.cos(player.lon))
      // third person: the camera always trails behind wherever the janitor is
      // facing, so the pointer steers him and up-screen is "ahead of him"
      const forward = vD.copy(north).multiplyScalar(Math.cos(player.facing)).addScaledVector(east, Math.sin(player.facing))
      const playerPosition = surfacePoint(
        player.lat, player.lon, radiusAt(game.planetId, player.lat, player.lon) + player.h, camLook,
      )
      // The pointer's height tips the view by raising the point the camera looks
      // at, and drawing the camera back as it goes. Swinging the camera down
      // instead would only drive it into the ground behind him, and without the
      // draw-back a look-up becomes a first-person view of the sky with the
      // janitor gone from his own game.
      const tip = Math.sin(clampValue(player.lookPitch, -1, 1) * SURFACE_PITCH_MAX)
      camWish.copy(playerPosition)
        .addScaledVector(up, 4.3 + tip * 2)
        .addScaledVector(forward, -8.8 - Math.max(0, tip) * 4)
      camUpWish.copy(playerPosition)
        .addScaledVector(up, 1.6 + tip * 14)
        .addScaledVector(forward, 2.4)
      cameraUp.copy(up)
      if (firstFrame) {
        cameraPosition.copy(camWish)
        cameraTarget.copy(camUpWish)
      } else {
        cameraPosition.lerp(camWish, 1 - Math.pow(0.0028, dt))
        cameraTarget.lerp(camUpWish, 1 - Math.pow(0.0015, dt))
      }
      // applied to the wish and then again to the smoothed position: the camera lags
      // the wish, so clearing only the wish would leave it inside the hill on the way
      clearGround(camWish, playerPosition, game.planetId)
      clearGround(cameraPosition, playerPosition, game.planetId)
    }
    firstFrame = false
    camera.position.copy(cameraPosition)
    camera.up.copy(cameraUp)
    if (shake > 0) {
      const amount = shake * (reducedMotion ? 0.25 : 1)
      camera.position.x += (Math.random() - 0.5) * amount
      camera.position.y += (Math.random() - 0.5) * amount
      camera.position.z += (Math.random() - 0.5) * amount
      shake = Math.max(0, shake - dt * 2.2)
    }
    camera.lookAt(cameraTarget)
    // after lookAt, because the ghosts are placed in the camera's own basis
    updateFlare(game.planetId, game.mode === 'surface')
  }

  // ------------------------------------------------------------- interface
  function resize() {
    const width = container.clientWidth || window.innerWidth
    const height = container.clientHeight || window.innerHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio))
    renderer.setSize(width, height, false)
    camera.aspect = width / Math.max(1, height)
    camera.updateProjectionMatrix()
  }
  resize()

  return {
    update(game, dt) {
      elapsed += dt
      const inSpace = game.mode !== 'surface'
      if (game.mode !== lastMode) {        // only a change of world resets the framing; docking eases into place
        const worldChanged = (lastMode === 'surface') !== (game.mode === 'surface')
        lastMode = game.mode
        if (worldChanged) firstFrame = true
      }
      syncSurfaceJobs(game)
      updateLod(game, dt)
      if (!inSpace) {
        // the ground underfoot is never allowed to be missing
        ensureActiveSurface(game)
        setActivePlanet(game.planetId)
      }
      updateCamera(game, dt, inSpace)
      if (inSpace) updateSpaceScene(game, dt)
      else updateSurfaceScene(game, dt)
      updateParticles(spaceParticles, spaceParticleMesh, dt)
      updateParticles(surfaceParticles, surfaceParticleMesh, dt)
      renderer.render(inSpace ? spaceScene : surfaceScene, camera)
    },
    resize,
    addShake(amount) {
      shake = Math.min(1.6, shake + amount)
    },
    burst(event, color, count, speed = 10) {
      if (event.place === 'surface') {
        const planetId = activePlanetId >= 0 ? activePlanetId : 0
        const at = surfacePoint(
          event.lat, event.lon, radiusAt(planetId, event.lat, event.lon) + event.h + 0.8, vA,
        )
        spawnParticles(surfaceParticles, at, color, count, speed, 12, new THREE.Vector3(0, 0, 0))
      } else {
        spawnParticles(
          spaceParticles,
          new THREE.Vector3(event.x, event.y, event.z),
          color, count, speed, 0, new THREE.Vector3(0, 0, 0),
        )
      }
    },
    meteorStrike(lat, lon) {
      const planetId = activePlanetId >= 0 ? activePlanetId : 1
      const build = surfaceBuild(planetId)
      dir(lat, lon, impactUp)
      impactAt.copy(impactUp).multiplyScalar(
        build ? build.terrainRadius(lat, lon) : planetById(planetId).surfaceRadius,
      )
      impact.active = true
      impact.t = 0
      // the material a crater throws, in two sizes: chips that come back down
      // almost at once, and dust that hangs and then drifts
      spawnEjecta(surfaceParticles, impactAt, impactUp, 34, 26, 20, 0x6d645c, 1.05)
      spawnEjecta(surfaceParticles, impactAt, impactUp, 26, 13, 5, 0xcbbfa9, 1.35)
    },
    setQuality(low) {
      maxPixelRatio = low ? 1 : 1.75
      resize()
    },
    setReducedMotion(value) {
      reducedMotion = value
      lod.setReducedMotion(value)
    },
    lodStats() {
      const built: Record<string, number> = {}
      const shown: Record<string, number> = {}
      for (let id = 0; id < LOD_NAMES.length; id++) {
        built[LOD_NAMES[id]] = lod.tierOf(id)
        shown[LOD_NAMES[id]] = lod.shownOf(id)
        built[`${LOD_NAMES[id]}-surface`] = lod.tierOf(SURFACE_ID_BASE + id)
        shown[`${LOD_NAMES[id]}-surface`] = lod.shownOf(SURFACE_ID_BASE + id)
      }
      return { built, shown, pending: lod.pending(), spendMs: Math.round(lod.lastSpend() * 1000) / 1000 }
    },
    renderStats() {
      const gl = renderer.getContext()
      const info = renderer.info
      const capabilities = renderer.capabilities
      return {
        calls: info.render.calls,
        triangles: info.render.triangles,
        points: info.render.points,
        lines: info.render.lines,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        pixelRatio: renderer.getPixelRatio(),
        drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        maxRenderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
        maxAttributes: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number,
        anisotropy: capabilities.getMaxAnisotropy(),
        webgl2: capabilities.isWebGL2,
        quality: maxPixelRatio === 1 ? 'low' : 'high',
      }
    },
    dispose() {
      disposeSurfaceJobs()
      lod.reset()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
