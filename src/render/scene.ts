import * as THREE from 'three'
import {
  EARTH_ORBIT, ISS_DOCK_OFFSET, ISS_ORBIT, JUNK_COLORS, MARS_ORBIT, METEOR_RADIUS, MOON_ORBIT,
  MOON_RADIUS, OXYGEN_WARN, SUN_RADIUS, SURFACE_RADIUS, TAU,
} from '../sim/config.ts'
import { canDock, canLand, holdCount, nearLander, scoopRadius } from '../sim/game.ts'
import { quatForward, quatUp } from '../sim/orient.ts'
import { PLANETS, planetById } from '../sim/planets.ts'
import type { PlanetTheme } from '../sim/planets.ts'
import type { Game, GameEvent, JunkClass, Vec3 } from '../sim/types.ts'
import {
  buildSurface, canvasTexture, clampValue, dir, glowTexture, makeRnd, surfacePoint, type SurfaceBuild,
} from './surfaces.ts'

const MAX_PARTICLES = 300
const MAX_JUNK = 160
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const UP = new THREE.Vector3(0, 1, 0)

export interface World {
  update(game: Game, dt: number): void
  resize(): void
  addShake(amount: number): void
  burst(event: GameEvent, color: number, count: number, speed?: number): void
  setQuality(low: boolean): void
  setReducedMotion(value: boolean): void
  dispose(): void
}

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

function makeLabel(text: string, color = '#dff2ff'): THREE.Sprite {
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

function basisFor(up: THREE.Vector3, forward: THREE.Vector3, right: THREE.Vector3): THREE.Matrix4 {
  right.crossVectors(up, forward).normalize()
  forward.crossVectors(right, up).normalize()
  return new THREE.Matrix4().makeBasis(right, up, forward)
}

// ------------------------------------------------------------------ world

export function createWorld(container: HTMLElement): World {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setClearColor(0x04060f)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  container.appendChild(renderer.domElement)

  const camera = new THREE.PerspectiveCamera(58, 1, 0.4, 4200)
  let maxPixelRatio = 1.75
  let reducedMotion = false
  let shake = 0
  let elapsed = 0
  let lastMode = ''

  const cameraPosition = new THREE.Vector3()
  const cameraTarget = new THREE.Vector3()
  const cameraUp = new THREE.Vector3(0, 1, 0)
  let firstFrame = true

  // scratch vectors (reused every frame, no per-frame allocation)
  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vC = new THREE.Vector3()
  const vD = new THREE.Vector3()
  const vE = new THREE.Vector3()
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

  // starfield
  {
    const starCount = 2200
    const positions = new Float32Array(starCount * 3)
    let state = 20261
    const rnd = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 4294967296
    }
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1)
      if (v.lengthSq() < 1e-6) v.set(0, 1, 0)
      v.normalize().multiplyScalar(1000 + rnd() * 900)
      positions.set([v.x, v.y, v.z], i * 3)
    }
    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)),
      new THREE.PointsMaterial({ color: 0xd6e6ff, size: 2.4, sizeAttenuation: false }),
    )
    stars.userData.spin = true
    spaceScene.add(stars)
    spaceScene.userData.stars = stars
  }

  // the Sun
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS, 48, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd06a }),
  )
  spaceScene.add(sun)
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255, 216, 128, 0.95)', 'rgba(255, 130, 40, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  sunGlow.scale.setScalar(SUN_RADIUS * 7)
  spaceScene.add(sunGlow)
  const corona = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS * 1.16, 32, 24),
    new THREE.MeshBasicMaterial({
      color: 0xff9a3c, transparent: true, opacity: 0.22, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  )
  spaceScene.add(corona)

  // ---------------------------------------------------------- earth system
  const earthSystem = new THREE.Group()
  spaceScene.add(earthSystem)
  const earthDef = planetById(0)

  const earthTexture = canvasTexture(512, 256, (ctx, rnd) => {
    const ocean = ctx.createLinearGradient(0, 0, 0, 256)
    ocean.addColorStop(0, '#1d4f9c')
    ocean.addColorStop(0.5, '#2f7fd0')
    ocean.addColorStop(1, '#1b4a8f')
    ctx.fillStyle = ocean
    ctx.fillRect(0, 0, 512, 256)
    for (let blob = 0; blob < 22; blob++) {
      const cx = 30 + rnd() * 452
      const cy = 40 + rnd() * 176
      const scale = 0.5 + rnd() * 1.1
      ctx.fillStyle = rnd() < 0.35 ? '#8fbf5a' : '#3f9a52'
      for (let piece = 0; piece < 9; piece++) {
        const angle = rnd() * TAU
        const distance = rnd() * 34 * scale
        const radius = (8 + rnd() * 20) * scale
        ctx.beginPath()
        ctx.ellipse(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance, radius, radius * 0.7, rnd() * TAU, 0, TAU)
        ctx.fill()
      }
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
    ctx.fillRect(0, 0, 512, 18)
    ctx.fillRect(0, 238, 512, 18)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
    for (let i = 0; i < 40; i++) {
      ctx.beginPath()
      ctx.ellipse(rnd() * 512, 30 + rnd() * 196, 10 + rnd() * 26, 4 + rnd() * 7, rnd() * TAU, 0, TAU)
      ctx.fill()
    }
  })
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(earthDef.spaceRadius, 64, 48),
    new THREE.MeshStandardMaterial({ map: earthTexture, roughness: 0.92, metalness: 0 }),
  )
  earthSystem.add(earth)

  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(earthDef.spaceRadius + 0.35, 48, 32),
    new THREE.MeshStandardMaterial({
      map: canvasTexture(512, 256, (ctx, rnd) => {
        ctx.clearRect(0, 0, 512, 256)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.72)'
        for (let i = 0; i < 90; i++) {
          const cx = rnd() * 512
          const cy = 20 + rnd() * 216
          for (let piece = 0; piece < 6; piece++) {
            ctx.beginPath()
            ctx.ellipse(cx + (rnd() - 0.5) * 40, cy + (rnd() - 0.5) * 18, 6 + rnd() * 20, 3 + rnd() * 8, 0, 0, TAU)
            ctx.fill()
          }
        }
      }),
      transparent: true, opacity: 0.82, depthWrite: false, roughness: 1,
    }),
  )
  earthSystem.add(clouds)

  earthSystem.add(new THREE.Mesh(
    new THREE.SphereGeometry(earthDef.spaceRadius * 1.06, 32, 24),
    new THREE.MeshBasicMaterial({
      color: earthDef.atmosphere, transparent: true, opacity: 0.2, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  ))
  const earthGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(120, 190, 255, 0.38)', 'rgba(60, 120, 255, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  earthGlow.scale.setScalar(earthDef.spaceRadius * 4.2)
  earthSystem.add(earthGlow)

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

  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(MOON_RADIUS, 32, 24),
    new THREE.MeshStandardMaterial({
      map: canvasTexture(256, 128, (ctx, rnd) => {
        ctx.fillStyle = '#b9bfc9'
        ctx.fillRect(0, 0, 256, 128)
        for (let i = 0; i < 60; i++) {
          const x = rnd() * 256
          const y = rnd() * 128
          const r = 2 + rnd() * 9
          ctx.fillStyle = `rgba(${120 + rnd() * 40 | 0}, ${126 + rnd() * 40 | 0}, ${140 + rnd() * 40 | 0}, 0.75)`
          ctx.beginPath()
          ctx.arc(x, y, r, 0, TAU)
          ctx.fill()
          ctx.strokeStyle = 'rgba(236, 240, 248, 0.5)'
          ctx.lineWidth = 1.4
          ctx.stroke()
        }
      }),
      roughness: 1,
    }),
  )

  // --------------------------------------------------------- moon & mars
  // the moon is its own body: the sim hands us a world position that already
  // includes Earth's orbit, so it lives at the root of the space scene.
  spaceScene.add(moon)
  const moonLabel = makeLabel('MOON', '#dfe6ff')
  moonLabel.position.set(0, MOON_RADIUS + 5, 0)
  moon.add(moonLabel)

  const marsSystem = new THREE.Group()
  spaceScene.add(marsSystem)
  const marsDef = planetById(2)

  const mars = new THREE.Mesh(
    new THREE.SphereGeometry(marsDef.spaceRadius, 64, 48),
    new THREE.MeshStandardMaterial({
      map: canvasTexture(512, 256, (ctx, rnd) => {
        ctx.fillStyle = '#a34a2b'
        ctx.fillRect(0, 0, 512, 256)
        for (let blob = 0; blob < 26; blob++) {
          ctx.fillStyle = `rgba(${86 + rnd() * 34 | 0}, ${42 + rnd() * 22 | 0}, ${28 + rnd() * 18 | 0}, 0.55)`
          const cx = rnd() * 512
          const cy = 30 + rnd() * 196
          for (let piece = 0; piece < 7; piece++) {
            ctx.beginPath()
            ctx.ellipse(
              cx + (rnd() - 0.5) * 74, cy + (rnd() - 0.5) * 52,
              16 + rnd() * 46, 10 + rnd() * 26, rnd() * TAU, 0, TAU,
            )
            ctx.fill()
          }
        }
        for (let streak = 0; streak < 20; streak++) {
          ctx.fillStyle = `rgba(${216 + rnd() * 34 | 0}, ${148 + rnd() * 44 | 0}, ${104 + rnd() * 34 | 0}, 0.26)`
          ctx.beginPath()
          ctx.ellipse(rnd() * 512, 20 + rnd() * 216, 22 + rnd() * 72, 8 + rnd() * 22, rnd() * 0.7, 0, TAU)
          ctx.fill()
        }
        ctx.fillStyle = 'rgba(242, 247, 255, 0.92)'
        ctx.fillRect(0, 0, 512, 13)
        ctx.fillRect(0, 243, 512, 13)
        ctx.fillStyle = 'rgba(242, 247, 255, 0.45)'
        for (let i = 0; i < 26; i++) {
          ctx.beginPath()
          ctx.ellipse(rnd() * 512, 6 + rnd() * 14, 14 + rnd() * 28, 4 + rnd() * 8, 0, 0, TAU)
          ctx.fill()
          ctx.beginPath()
          ctx.ellipse(rnd() * 512, 236 + rnd() * 14, 14 + rnd() * 28, 4 + rnd() * 8, 0, 0, TAU)
          ctx.fill()
        }
      }),
      roughness: 0.96,
      metalness: 0,
    }),
  )
  marsSystem.add(mars)

  marsSystem.add(new THREE.Mesh(
    new THREE.SphereGeometry(marsDef.spaceRadius * 1.07, 32, 24),
    new THREE.MeshBasicMaterial({
      color: marsDef.atmosphere, transparent: true, opacity: 0.18, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  ))
  const marsGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255, 168, 108, 0.34)', 'rgba(190, 80, 34, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  marsGlow.scale.setScalar(marsDef.spaceRadius * 4.2)
  marsSystem.add(marsGlow)

  // Phobos and Deimos, two lumpy pebbles that keep the red planet company
  const marsMoonlets = new THREE.Group()
  const moonletGeometry = new THREE.IcosahedronGeometry(1, 0)
  const moonletMaterial = new THREE.MeshStandardMaterial({ color: 0x9a9187, flatShading: true, roughness: 1 })
  const phobos = new THREE.Mesh(moonletGeometry, moonletMaterial)
  phobos.scale.set(1.5, 1.1, 1.25)
  phobos.position.set(marsDef.spaceRadius + 6.5, 1.4, 0)
  marsMoonlets.add(phobos)
  const deimos = new THREE.Mesh(moonletGeometry, moonletMaterial)
  deimos.scale.set(0.95, 0.78, 0.9)
  deimos.position.set(-(marsDef.spaceRadius + 11), -2.2, 3.6)
  marsMoonlets.add(deimos)
  marsSystem.add(marsMoonlets)

  const marsLabel = makeLabel('MARS', '#ffbf94')
  marsLabel.position.set(0, marsDef.spaceRadius + 12, 0)
  marsSystem.add(marsLabel)

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
  iss.add(issLabel)
  const earthLabel = makeLabel('EARTH')
  earthLabel.position.set(0, earthDef.spaceRadius + 12, 0)
  earthSystem.add(earthLabel)
  const labels = [issLabel, earthLabel, moonLabel, marsLabel]

  // ------------------------------------------------------------------ ship
  function buildShip(): {
    group: THREE.Group
    thruster: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>
    thrusterGlow: THREE.Sprite
  } {
    const group = new THREE.Group()
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xf2c94c, roughness: 0.5, metalness: 0.25 })
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x3a4256, roughness: 0.7, metalness: 0.3 })
    const hull = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 3.4), bodyMaterial)
    group.add(hull)
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.8, 1.5), bodyMaterial)
    nose.position.set(0, 0.05, 2.3)
    group.add(nose)
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 16, 12),
      new THREE.MeshStandardMaterial({
        color: 0x9fe8ff, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.72,
      }),
    )
    canopy.position.set(0, 0.6, 0.75)
    canopy.scale.set(1, 0.8, 1.25)
    group.add(canopy)
    const pod = new THREE.CylinderGeometry(0.5, 0.5, 2.6, 10)
    for (const side of [-1, 1]) {
      const cargo = new THREE.Mesh(pod, darkMaterial)
      cargo.rotation.x = Math.PI / 2
      cargo.position.set(side * 1.5, -0.1, -0.2)
      group.add(cargo)
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.9, 1.3), bodyMaterial)
      fin.position.set(side * 1.35, 0.5, -1.3)
      group.add(fin)
      const claw = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 1.5), darkMaterial)
      claw.position.set(side * 0.5, -0.35, 2.6)
      claw.rotation.x = 0.32
      group.add(claw)
    }
    const thruster = new THREE.Mesh(
      new THREE.ConeGeometry(0.62, 1.5, 12),
      new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.75 }),
    )
    thruster.rotation.x = -Math.PI / 2
    thruster.position.set(0, -0.05, -2.6)
    group.add(thruster)
    const thrusterGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture('rgba(190, 235, 255, 0.9)', 'rgba(90, 150, 255, 0)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    thrusterGlow.position.set(0, -0.05, -3.1)
    thrusterGlow.scale.setScalar(3.4)
    group.add(thrusterGlow)
    return { group, thruster, thrusterGlow }
  }

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
  surfaceScene.fog = new THREE.Fog(0xbfe4ff, 170, 560)
  const surfaceHemisphere = new THREE.HemisphereLight(0xcfe9ff, 0x2f5a3a, 1.2)
  surfaceScene.add(surfaceHemisphere)
  const surfaceKey = new THREE.DirectionalLight(0xfff4df, 2.0)
  surfaceKey.position.set(60, 120, 40)
  surfaceScene.add(surfaceKey)
  const surfaceFill = new THREE.DirectionalLight(0x9fd0ff, 0.45)
  surfaceFill.position.set(-70, -30, -60)
  surfaceScene.add(surfaceFill)

  const themeLooks: Record<PlanetTheme, ThemeLook> = {
    earth: {
      keyLight: 0xfff4df, keyIntensity: 2.0, skyLight: 0xcfe9ff, groundLight: 0x2f5a3a,
      hemiIntensity: 1.2, fill: 0x9fd0ff, fillIntensity: 0.45, sunTint: 0xffffff, sunScale: 130,
    },
    moon: {
      keyLight: 0xffffff, keyIntensity: 2.7, skyLight: 0x2c3a58, groundLight: 0x14161c,
      hemiIntensity: 0.4, fill: 0x4a5f8c, fillIntensity: 0.14, sunTint: 0xffffff, sunScale: 104,
    },
    mars: {
      keyLight: 0xffd2a4, keyIntensity: 1.95, skyLight: 0xd9a074, groundLight: 0x6b3524,
      hemiIntensity: 1.05, fill: 0xffb083, fillIntensity: 0.3, sunTint: 0xffbe8a, sunScale: 118,
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

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(760, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTextures[0], side: THREE.BackSide, fog: false }),
  )
  surfaceScene.add(sky)
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255, 246, 214, 1)', 'rgba(255, 214, 140, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }))
  sunSprite.position.set(240, 520, 160)
  sunSprite.scale.setScalar(130)
  surfaceScene.add(sunSprite)

  // three landable worlds, built once from the sim seed and toggled by planetId
  let terrainSeed = -1
  let activePlanetId = -1
  const surfaces: SurfaceBuild[] = []

  function radiusAt(planetId: number, lat: number, lon: number): number {
    const surface = surfaces[planetId]
    return surface ? surface.terrainRadius(lat, lon) : SURFACE_RADIUS
  }

  function applyPlanetTheme(planetId: number) {
    const planet = planetById(planetId)
    const look = themeLooks[planet.theme]
    sky.material.map = skyTextures[planet.id] ?? skyTextures[0]
    sky.material.needsUpdate = true
    sunSprite.material.color.setHex(look.sunTint)
    sunSprite.scale.setScalar(look.sunScale)
    surfaceHemisphere.color.setHex(look.skyLight)
    surfaceHemisphere.groundColor.setHex(look.groundLight)
    surfaceKey.color.setHex(look.keyLight)
    surfaceFill.color.setHex(look.fill)
    blobShadow.material.color.setHex(planet.theme === 'earth' ? 0x102415 : 0x14161c)
  }

  function disposeSurfaces() {
    cargoMesh.removeFromParent()
    parked.group.removeFromParent()
    for (const surface of surfaces) {
      surfaceScene.remove(surface.group)
      surface.group.traverse(object => {
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
    surfaces.length = 0
    activePlanetId = -1
  }

  function ensureSurfaces(game: Game) {
    const seed = game.seed >>> 0
    if (surfaces.length === 3 && terrainSeed === seed) return
    disposeSurfaces()
    terrainSeed = seed
    for (let planetId = 0; planetId < PLANETS.length; planetId++) {
      const surface = buildSurface(planetId, seed)
      surface.group.visible = false
      surfaceScene.add(surface.group)
      surfaces[planetId] = surface
    }
    setActivePlanet(game.planetId)
  }

  function setActivePlanet(planetId: number) {
    const surface = surfaces[planetId]
    if (!surface || activePlanetId === planetId) return
    activePlanetId = planetId
    for (let i = 0; i < surfaces.length; i++) {
      surfaces[i].group.visible = i === planetId
    }
    // the parked tug and the waiting cargo pile live on the active lander pad
    surface.lander.add(cargoMesh)
    surface.lander.add(parked.group)
    applyPlanetTheme(planetId)
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

  // hazard visuals: the Moon meteor telegraph
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
  const meteorStreak = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0xffb894, transparent: true, opacity: 0.7 }),
  )
  for (const object of [meteorShadow, meteorRing, meteorStreak]) {
    object.visible = false
    surfaceScene.add(object)
  }

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
  const beaconMaterial = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.2, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const beaconMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.05, 0.75, 9, 7, 1, true), beaconMaterial, MAX_JUNK,
  )
  beaconMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  beaconMesh.frustumCulled = false
  beaconMesh.count = 0
  surfaceScene.add(beaconMesh)

  // relics get their own taller beam and a spinning halo on top
  const relicBeamMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.09, 1.1, 15, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: JUNK_COLORS.relic, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    MAX_JUNK,
  )
  relicBeamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  relicBeamMesh.frustumCulled = false
  relicBeamMesh.count = 0
  surfaceScene.add(relicBeamMesh)
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
  parked.thrusterGlow.visible = false
  parked.thruster.scale.setScalar(0.001)

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
  {
    const suit = new THREE.MeshStandardMaterial({ color: 0xf2913c, roughness: 0.65, flatShading: true })
    const glove = new THREE.MeshStandardMaterial({ color: 0xf7d64c, roughness: 0.6, flatShading: true })
    const dark = new THREE.MeshStandardMaterial({ color: 0x3c4456, roughness: 0.7, flatShading: true })
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.44, 0.55, 4, 10), suit)
    torso.position.y = 1.15
    playerGroup.add(torso)
    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.92, 0.46), dark)
    backpack.position.set(0, 1.25, -0.42)
    playerGroup.add(backpack)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), suit)
    head.position.y = 1.94
    playerGroup.add(head)
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.44, 16, 12),
      new THREE.MeshStandardMaterial({
        color: 0xcdefff, transparent: true, opacity: 0.32, roughness: 0.1, metalness: 0.1, flatShading: true,
      }),
    )
    dome.position.y = 1.98
    playerGroup.add(dome)
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.5, 3, 6), suit)
      arm.position.set(side * 0.56, 1.16, 0.06)
      arm.rotation.z = side * 0.22
      playerGroup.add(arm)
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 6), glove)
      hand.position.set(side * 0.68, 0.76, 0.12)
      playerGroup.add(hand)
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.5, 3, 6), dark)
      leg.position.set(side * 0.24, 0.42, 0)
      playerGroup.add(leg)
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.46), glove)
      boot.position.set(side * 0.24, 0.1, 0.06)
      playerGroup.add(boot)
    }
    const mopStick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.7, 6), glove)
    mopStick.position.set(0.34, 1.5, -0.62)
    mopStick.rotation.set(0.32, 0, -0.22)
    playerGroup.add(mopStick)
    const mopHead = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.22, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xdfe8f2, roughness: 0.9, flatShading: true }),
    )
    mopHead.position.set(0.44, 0.68, -0.8)
    playerGroup.add(mopHead)
  }
  const carriedMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.34, 0.34, 0.34),
    new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.7 }),
    12,
  )
  carriedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  carriedMesh.count = 0
  playerGroup.add(carriedMesh)

  const scoopRing = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.05, 6, 48),
    new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.4 }),
  )
  scoopRing.rotation.x = -Math.PI / 2
  surfaceScene.add(scoopRing)
  const blobShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.9, 18),
    new THREE.MeshBasicMaterial({ color: 0x102415, transparent: true, opacity: 0.3, depthWrite: false }),
  )
  surfaceScene.add(blobShadow)

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
    clouds.rotation.y += dt * 0.014

    iss.position.set(game.issPos.x, game.issPos.y, game.issPos.z)
    iss.rotation.y = -game.issAngle
    for (let i = 0; i < spinningRings.length; i++) {
      spinningRings[i].rotation.z += dt * (i === 0 ? 0.7 : -0.55)
    }
    const docking = canDock(game)
    hatchMaterial.color.setHex(docking ? 0x8dff9d : canLand(game) ? 0xffe066 : 0x7fe4ff)
    hatch.scale.setScalar(docking ? 1.25 + Math.sin(elapsed * 8) * 0.08 : 1)
    shopGlow.material.opacity = 0.68 + Math.sin(elapsed * 2.4) * 0.2

    moon.position.set(game.moonPos.x, game.moonPos.y, game.moonPos.z)
    const marsPos = game.planetPos[2]
    marsSystem.position.set(marsPos.x, marsPos.y, marsPos.z)
    mars.rotation.y += dt * 0.02
    marsMoonlets.rotation.y += dt * 0.11

    const ship = game.ship
    const docked = game.mode === 'docked'
    if (docked) shipModel.group.position.set(game.dockPos.x, game.dockPos.y, game.dockPos.z)
    else shipModel.group.position.set(ship.x, ship.y, ship.z)
    shipModel.group.quaternion.set(ship.q.x, ship.q.y, ship.q.z, ship.q.w)
    const thrust = Math.max(0, ship.thrust)
    const glow = thrust > 0.12 ? (ship.boosting ? 1.5 : 0.85) : 0
    shipModel.thrusterGlow.material.opacity = Math.min(1, glow * 0.9 + 0.05)
    shipModel.thrusterGlow.scale.setScalar(glow * 3.2 + 1.2)
    shipModel.thruster.scale.set(1, Math.max(0.05, glow), 1)
    shipModel.thruster.material.opacity = 0.25 + glow * 0.5
    if (!docked) shipModel.group.position.y += Math.sin(elapsed * 26) * 0.03 * glow

    // key light comes from the Sun toward the action
    vA.copy(shipModel.group.position).normalize()
    spaceKey.position.copy(shipModel.group.position).addScaledVector(vA, 400)
    spaceKey.target.position.copy(shipModel.group.position)

    const stars = spaceScene.userData.stars as THREE.Points
    stars.rotation.y += dt * 0.002
    sunGlow.material.opacity = 0.85 + Math.sin(elapsed * 1.4) * 0.08
    corona.scale.setScalar(1 + Math.sin(elapsed * 1.1) * 0.015)

    for (const label of labels) {
      label.getWorldPosition(vB)
      const distance = vB.distanceTo(cameraPosition)
      const scale = clampValue(distance * 0.028, 5, 30)
      label.scale.set(scale, scale * 0.3, 1)
    }
  }

  function updateSurfaceScene(game: Game, dt: number) {
    const surface = surfaces[game.planetId]
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
    if (player.h > 0.05) {
      playerGroup.rotateX(-Math.min(0.45, player.h * 0.12))
    }

    const groundRadius = surface.terrainRadius(player.lat, player.lon)
    blobShadow.position.copy(up).multiplyScalar(groundRadius + 0.08)
    blobShadow.quaternion.setFromUnitVectors(Z_AXIS, up)
    blobShadow.scale.setScalar(Math.max(0.4, 1 - Math.min(0.55, player.h * 0.09)))

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

    // a puff of wind in the Martian rotors
    if (surface.windmillBlades.length > 0 && !reducedMotion) {
      const spin = dt * (0.5 + game.hazards.stormIntensity * 2.2)
      for (const blades of surface.windmillBlades) blades.rotation.z += spin
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

    // ground junk + beacons for the planet under our feet only
    const counts: Record<JunkClass, number> = { scrap: 0, tech: 0, hazardous: 0, relic: 0 }
    let beaconCount = 0
    let relicBeamCount = 0
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
      if (beaconCount < MAX_JUNK) {
        dummy.position.copy(up).multiplyScalar(radius + 4.6)
        dummy.quaternion.identity()
        dummy.updateMatrix()
        beaconMesh.setMatrixAt(beaconCount, dummy.matrix)
        beaconMesh.setColorAt(beaconCount, tmpColor.setHex(JUNK_COLORS[item.cls]))
        beaconCount++
      }
      if (item.cls !== 'relic') continue
      if (relicBeamCount < relicBeamMesh.instanceMatrix.count) {
        dummy.position.copy(up).multiplyScalar(radius + 7.6)
        dummy.quaternion.setFromUnitVectors(UP, up)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        relicBeamMesh.setMatrixAt(relicBeamCount, dummy.matrix)
        relicBeamCount++
      }
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
    beaconMesh.count = beaconCount
    beaconMesh.instanceMatrix.needsUpdate = true
    if (beaconMesh.instanceColor) beaconMesh.instanceColor.needsUpdate = true
    beaconMaterial.opacity = 0.13 + Math.sin(elapsed * 2.8) * 0.05
    relicBeamMesh.count = relicBeamCount
    relicBeamMesh.instanceMatrix.needsUpdate = true
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
    updateSurfaceMood(game)
    updateMeteorTelegraph(game)
    updateDustStorm(game, dt)
  }

  /** Moon hazard: a shadow that tightens under the incoming meteor. */
  function updateMeteorTelegraph(game: Game) {
    const surface = surfaces[game.planetId]
    const hazards = game.hazards
    const active = game.planetId === 1 && !!surface && hazards.meteorTelegraph >= 0 && hazards.meteorDelay > 0
    meteorShadow.visible = active
    meteorRing.visible = active
    meteorStreak.visible = active
    if (!active || !surface) return
    const t = clampValue(hazards.meteorTelegraph / hazards.meteorDelay, 0, 1)
    const up = dir(hazards.meteorLat, hazards.meteorLon, vA)
    const radius = surface.terrainRadius(hazards.meteorLat, hazards.meteorLon)
    const scale = METEOR_RADIUS * (1.6 - 0.6 * t)

    meteorShadow.position.copy(up).multiplyScalar(radius + 0.12)
    meteorShadow.quaternion.setFromUnitVectors(Z_AXIS, up)
    meteorShadow.scale.setScalar(scale)
    meteorShadow.material.opacity = 0.15 + t * 0.7

    meteorRing.position.copy(up).multiplyScalar(radius + 0.3)
    meteorRing.quaternion.setFromUnitVectors(Z_AXIS, up)
    meteorRing.scale.setScalar(METEOR_RADIUS * (1.05 + Math.sin(elapsed * 9) * 0.1) * (1.5 - 0.5 * t))
    meteorRing.material.opacity = 0.3 + t * 0.45 + Math.sin(elapsed * 12) * 0.08

    const positions = meteorStreak.geometry.attributes.position
    vB.copy(up).multiplyScalar(radius + 34 - t * 10)
    positions.setXYZ(0, vB.x, vB.y, vB.z)
    vB.copy(up).multiplyScalar(radius + 15 - t * 5)
    positions.setXYZ(1, vB.x, vB.y, vB.z)
    positions.needsUpdate = true
    meteorStreak.material.opacity = 0.35 + t * 0.5
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
    const surface = surfaces[game.planetId]
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
      camWish.copy(shipOrigin).addScaledVector(shipForward, -distance).addScaledVector(shipUp, height)
      camLook.copy(shipOrigin)
        .addScaledVector(shipForward, docked ? 0 : 6)
        .addScaledVector(shipUp, docked ? 0.6 : 1.2)
      camUpWish.copy(UP).lerp(shipUp, docked ? 0.4 : 0.75).normalize()
      if (firstFrame) {
        cameraPosition.copy(camWish)
        cameraTarget.copy(camLook)
        cameraUp.copy(camUpWish)
      } else {
        cameraPosition.lerp(camWish, 1 - Math.pow(0.0022, dt))
        cameraTarget.lerp(camLook, 1 - Math.pow(0.0016, dt))
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
      // a stable view is what makes pointer-relative arrows feel right: the
      // camera keeps looking north while the janitor turns toward the pointer,
      // so "up the screen" always means the same direction
      const forward = vD.copy(north)
      const playerPosition = surfacePoint(
        player.lat, player.lon, radiusAt(game.planetId, player.lat, player.lon) + player.h, camLook,
      )
      camWish.copy(playerPosition).addScaledVector(up, 7.4).addScaledVector(forward, -12.6)
      camUpWish.copy(playerPosition).addScaledVector(up, 1.7).addScaledVector(forward, 7)
      cameraUp.copy(up)
      if (firstFrame) {
        cameraPosition.copy(camWish)
        cameraTarget.copy(camUpWish)
      } else {
        cameraPosition.lerp(camWish, 1 - Math.pow(0.0028, dt))
        cameraTarget.lerp(camUpWish, 1 - Math.pow(0.0015, dt))
      }
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
      if (game.mode !== lastMode) {
        lastMode = game.mode
        firstFrame = true
      }
      ensureSurfaces(game)
      if (!inSpace) setActivePlanet(game.planetId)
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
    setQuality(low) {
      maxPixelRatio = low ? 1 : 1.75
      resize()
    },
    setReducedMotion(value) {
      reducedMotion = value
    },
    dispose() {
      disposeSurfaces()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
