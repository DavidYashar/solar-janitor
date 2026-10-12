import * as THREE from 'three'
import {
  ISS_DOCK_OFFSET, ISS_ORBIT, JUNK_COLORS, LANDER_RING_RADIUS, MOON_ORBIT, MOON_RADIUS,
  OXYGEN_WARN, SUN_RADIUS, SURFACE_RADIUS, TAU,
} from '../sim/config.ts'
import { canDock, canLand, holdCount, nearLander, scoopRadius } from '../sim/game.ts'
import { landerSite, planetById, surfaceHeight } from '../sim/planets.ts'
import type { Game, GameEvent, JunkClass } from '../sim/types.ts'

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

// --------------------------------------------------------------- utilities

function canvasTexture(
  width: number, height: number, draw: (ctx: CanvasRenderingContext2D, rnd: () => number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  let state = 991
  const rnd = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  if (ctx) draw(ctx, rnd)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 2
  return texture
}

function glowTexture(inner: string, outer: string): THREE.CanvasTexture {
  return canvasTexture(256, 256, ctx => {
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
    gradient.addColorStop(0, inner)
    gradient.addColorStop(0.3, inner)
    gradient.addColorStop(1, outer)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 256, 256)
  })
}

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

function dir(lat: number, lon: number, target = new THREE.Vector3()): THREE.Vector3 {
  const cosLat = Math.cos(lat)
  return target.set(cosLat * Math.cos(lon), Math.sin(lat), cosLat * Math.sin(lon))
}

function surfacePoint(lat: number, lon: number, radius: number, target = new THREE.Vector3()): THREE.Vector3 {
  return dir(lat, lon, target).multiplyScalar(radius)
}

function basisFor(up: THREE.Vector3, forward: THREE.Vector3, right: THREE.Vector3): THREE.Matrix4 {
  right.crossVectors(up, forward).normalize()
  forward.crossVectors(right, up).normalize()
  return new THREE.Matrix4().makeBasis(right, up, forward)
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
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
  let firstFrame = true

  // scratch vectors (reused every frame, no per-frame allocation)
  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vC = new THREE.Vector3()
  const vD = new THREE.Vector3()
  const vE = new THREE.Vector3()
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
  earthSystem.add(moon)

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
  const moonLabel = makeLabel('MOON', '#dfe6ff')
  moonLabel.position.set(0, MOON_RADIUS + 5, 0)
  earthSystem.add(moonLabel)
  const labels = [issLabel, earthLabel, moonLabel]

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
  surfaceScene.add(new THREE.HemisphereLight(0xcfe9ff, 0x2f5a3a, 1.2))
  const surfaceKey = new THREE.DirectionalLight(0xfff4df, 2.0)
  surfaceKey.position.set(60, 120, 40)
  surfaceScene.add(surfaceKey)
  const surfaceFill = new THREE.DirectionalLight(0x9fd0ff, 0.45)
  surfaceFill.position.set(-70, -30, -60)
  surfaceScene.add(surfaceFill)

  const planetDef = planetById(0)
  const worldSeed = 12345

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(760, 32, 16),
    new THREE.MeshBasicMaterial({
      map: canvasTexture(64, 256, ctx => {
        const gradient = ctx.createLinearGradient(0, 0, 0, 256)
        gradient.addColorStop(0, '#0d2c66')
        gradient.addColorStop(0.45, '#4a8fd6')
        gradient.addColorStop(0.72, '#a8d8f5')
        gradient.addColorStop(1, '#e6f4ff')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, 64, 256)
      }),
      side: THREE.BackSide,
      fog: false,
    }),
  )
  surfaceScene.add(sky)
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255, 246, 214, 1)', 'rgba(255, 214, 140, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }))
  sunSprite.position.set(240, 520, 160)
  sunSprite.scale.setScalar(130)
  surfaceScene.add(sunSprite)

  function terrainRadius(lat: number, lon: number): number {
    return SURFACE_RADIUS + surfaceHeight(lat, lon, worldSeed)
  }

  // planet surface: displaced low-poly sphere with height-tinted vertices
  const groundGeometry = new THREE.SphereGeometry(SURFACE_RADIUS, 112, 72)
  {
    const position = groundGeometry.attributes.position
    const colors = new Float32Array(position.count * 3)
    const low = new THREE.Color(planetDef.groundLow)
    const high = new THREE.Color(planetDef.groundHigh)
    const sand = new THREE.Color(0xd9c98a)
    const rock = new THREE.Color(0x808c96)
    const vertex = new THREE.Vector3()
    const color = new THREE.Color()
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).normalize()
      const lat = Math.asin(clampValue(vertex.y, -1, 1))
      const lon = Math.atan2(vertex.z, vertex.x)
      const height = surfaceHeight(lat, lon, worldSeed)
      const radius = SURFACE_RADIUS + height
      position.setXYZ(i, vertex.x * radius, vertex.y * radius, vertex.z * radius)
      const t = clampValue((height + 2.2) / 4.4, 0, 1)
      color.copy(low).lerp(high, t)
      if (height > 1.4) color.lerp(sand, 0.55)
      if (lon > 2.2 && lon < 3.1 && Math.abs(lat) < 0.5) color.lerp(rock, 0.5)
      colors.set([color.r, color.g, color.b], i * 3)
    }
    groundGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    groundGeometry.computeVertexNormals()
  }
  surfaceScene.add(new THREE.Mesh(
    groundGeometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 }),
  ))

  // trees and rocks
  {
    let state = 777
    const rnd = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 4294967296
    }
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
      // keep the landing pad clear
      if (Math.abs(lat) < 0.34 && Math.abs(lon - 0.6) < 0.55) continue
      const radius = terrainRadius(lat, lon)
      dir(lat, lon, vA)
      const scale = 0.7 + rnd() * 0.9
      dummy.position.copy(vA).multiplyScalar(radius + 0.6 * scale)
      dummy.quaternion.setFromUnitVectors(UP, vA)
      dummy.rotateY(rnd() * TAU)
      dummy.scale.setScalar(scale)
      dummy.updateMatrix()
      trunkMesh.setMatrixAt(trees, dummy.matrix)
      dummy.position.copy(vA).multiplyScalar(radius + 2.05 * scale)
      dummy.updateMatrix()
      canopyMesh.setMatrixAt(trees, dummy.matrix)
      trees++
    }
    trunkMesh.count = trees
    canopyMesh.count = trees

    const rockMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.95, 0),
      new THREE.MeshStandardMaterial({ color: 0x8b929b, flatShading: true }),
      110,
    )
    for (let i = 0; i < 110; i++) {
      const lat = (rnd() * 2 - 1) * 1.0
      const lon = rnd() * TAU
      const radius = terrainRadius(lat, lon)
      dir(lat, lon, vA)
      dummy.position.copy(vA).multiplyScalar(radius + 0.25)
      dummy.quaternion.setFromUnitVectors(UP, vA)
      dummy.rotateY(rnd() * TAU)
      dummy.rotateX((rnd() - 0.5) * 0.5)
      const scale = 0.6 + rnd() * 1.5
      dummy.scale.set(scale, scale * (0.6 + rnd() * 0.5), scale)
      dummy.updateMatrix()
      rockMesh.setMatrixAt(i, dummy.matrix)
    }
    for (const mesh of [trunkMesh, canopyMesh, rockMesh]) {
      mesh.instanceMatrix.needsUpdate = true
      surfaceScene.add(mesh)
    }
  }

  // junk on the ground, plus faint pickup beacons so sweeps stay readable
  const junkGeometry: Record<JunkClass, THREE.BufferGeometry> = {
    scrap: new THREE.BoxGeometry(1.15, 0.75, 0.95),
    tech: new THREE.IcosahedronGeometry(0.62, 0),
    hazardous: new THREE.CylinderGeometry(0.42, 0.42, 1.0, 10),
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
  }
  const junkMeshes = {} as Record<JunkClass, THREE.InstancedMesh>
  for (const cls of ['scrap', 'tech', 'hazardous'] as JunkClass[]) {
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

  // the lander: the parked tug, a landing ring and a cargo pile
  const site = landerSite(0)
  const landerUp = dir(site.lat, site.lon).clone()
  const landerGroup = new THREE.Group()
  landerGroup.position.copy(surfacePoint(site.lat, site.lon, terrainRadius(site.lat, site.lon)))
  landerGroup.quaternion.setFromUnitVectors(UP, landerUp)
  surfaceScene.add(landerGroup)

  const parked = buildShip()
  parked.group.scale.setScalar(1.3)
  parked.group.position.set(0, 2.2, 0)
  parked.thrusterGlow.visible = false
  parked.thruster.scale.setScalar(0.001)
  landerGroup.add(parked.group)

  for (const angle of [0, 1, 2, 3]) {
    const leg = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 2.6, 0.28),
      new THREE.MeshStandardMaterial({ color: 0x4a5162, roughness: 0.7, flatShading: true }),
    )
    const a = (angle / 4) * TAU + Math.PI / 4
    leg.position.set(Math.cos(a) * 2.2, 0.75, Math.sin(a) * 2.2)
    leg.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45)
    landerGroup.add(leg)
  }

  const ringMaterialLander = new THREE.MeshBasicMaterial({ color: 0x7fffb0, transparent: true, opacity: 0.5 })
  const landingRing = new THREE.Mesh(
    new THREE.TorusGeometry(LANDER_RING_RADIUS, 0.2, 8, 64), ringMaterialLander,
  )
  landingRing.rotation.x = -Math.PI / 2
  landingRing.position.y = 0.14
  landerGroup.add(landingRing)
  const padBeacon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(140, 255, 190, 0.9)', 'rgba(60, 220, 140, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  padBeacon.position.set(0, 6.6, 0)
  padBeacon.scale.setScalar(7.5)
  landerGroup.add(padBeacon)

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
    earthSystem.position.set(game.earthPos.x, game.earthPos.y, game.earthPos.z)
    clouds.rotation.y += dt * 0.014

    iss.position.set(ISS_ORBIT * Math.cos(game.issAngle), 0, ISS_ORBIT * Math.sin(game.issAngle))
    iss.rotation.y = -game.issAngle
    for (let i = 0; i < spinningRings.length; i++) {
      spinningRings[i].rotation.z += dt * (i === 0 ? 0.7 : -0.55)
    }
    const docking = canDock(game)
    hatchMaterial.color.setHex(docking ? 0x8dff9d : canLand(game) ? 0xffe066 : 0x7fe4ff)
    hatch.scale.setScalar(docking ? 1.25 + Math.sin(elapsed * 8) * 0.08 : 1)
    shopGlow.material.opacity = 0.68 + Math.sin(elapsed * 2.4) * 0.2

    moon.position.set(MOON_ORBIT * Math.cos(game.moonAngle), 0, MOON_ORBIT * Math.sin(game.moonAngle))

    const ship = game.ship
    shipModel.group.position.set(ship.x, ship.y, ship.z)
    shipModel.group.rotation.y = ship.yaw
    const thrust = Math.max(0, ship.thrust)
    const glow = thrust > 0.12 ? (ship.boosting ? 1.5 : 0.85) : 0
    shipModel.thrusterGlow.material.opacity = Math.min(1, glow * 0.9 + 0.05)
    shipModel.thrusterGlow.scale.setScalar(glow * 3.2 + 1.2)
    shipModel.thruster.scale.set(1, Math.max(0.05, glow), 1)
    shipModel.thruster.material.opacity = 0.25 + glow * 0.5
    shipModel.group.position.y += Math.sin(elapsed * 26) * 0.03 * glow

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
    const player = game.player
    const playerRadius = terrainRadius(player.lat, player.lon) + player.h
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

    const groundRadius = terrainRadius(player.lat, player.lon)
    blobShadow.position.copy(up).multiplyScalar(groundRadius + 0.08)
    blobShadow.quaternion.setFromUnitVectors(Z_AXIS, up)
    blobShadow.scale.setScalar(Math.max(0.4, 1 - Math.min(0.55, player.h * 0.09)))

    scoopRing.position.copy(up).multiplyScalar(groundRadius + 0.12)
    scoopRing.quaternion.setFromUnitVectors(Z_AXIS, up)
    scoopRing.scale.setScalar(scoopRadius(game))
    scoopRing.material.opacity = 0.2 + Math.sin(elapsed * 3) * 0.06

    // lander
    landerGroup.position.copy(surfacePoint(site.lat, site.lon, terrainRadius(site.lat, site.lon)))
    const inRing = nearLander(game)
    ringMaterialLander.color.setHex(game.oxygen < OXYGEN_WARN ? 0xffb0a0 : inRing ? 0x9dffb0 : 0x7fffb0)
    ringMaterialLander.opacity = inRing ? 0.8 : 0.4 + Math.sin(elapsed * 2.2) * 0.1
    padBeacon.material.opacity = inRing ? 0.95 : 0.45 + Math.sin(elapsed * 2.4) * 0.16
    if (game.transition?.kind === 'takeoff') {
      const t = Math.min(1, game.transition.t / game.transition.duration)
      parked.group.position.set(0, 2.2 + t * t * 30, 0)
      parked.group.scale.setScalar(1.3 * (1 - t * 0.2))
    } else {
      parked.group.position.set(0, 2.2, 0)
      parked.group.scale.setScalar(1.3)
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

    // ground junk + beacons
    const counts: Record<JunkClass, number> = { scrap: 0, tech: 0, hazardous: 0 }
    let beaconCount = 0
    for (const item of game.junk) {
      if (item.status !== 'ground') continue
      const radius = terrainRadius(item.lat, item.lon)
      dir(item.lat, item.lon, up)
      dummy.position.copy(up).multiplyScalar(radius + 0.45)
      dummy.quaternion.setFromUnitVectors(UP, up)
      dummy.rotateY(item.yaw + elapsed * item.spin * 0.35)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      const count = counts[item.cls]
      if (count < MAX_JUNK) {
        junkMeshes[item.cls].setMatrixAt(count, dummy.matrix)
        counts[item.cls] = count + 1
      }
      dummy.position.copy(up).multiplyScalar(radius + 4.6)
      dummy.quaternion.identity()
      dummy.updateMatrix()
      beaconMesh.setMatrixAt(beaconCount, dummy.matrix)
      beaconMesh.setColorAt(beaconCount, tmpColor.setHex(JUNK_COLORS[item.cls]))
      beaconCount++
      if (beaconCount >= MAX_JUNK) break
    }
    for (const cls of ['scrap', 'tech', 'hazardous'] as JunkClass[]) {
      junkMeshes[cls].count = counts[cls]
      junkMeshes[cls].instanceMatrix.needsUpdate = true
    }
    beaconMesh.count = beaconCount
    beaconMesh.instanceMatrix.needsUpdate = true
    if (beaconMesh.instanceColor) beaconMesh.instanceColor.needsUpdate = true
    beaconMaterial.opacity = 0.13 + Math.sin(elapsed * 2.8) * 0.05

    // carried junk rides on the backpack
    let carried = 0
    for (const item of game.junk) {
      if (item.status !== 'carried') continue
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
    sunSprite.material.opacity = 0.9 + Math.sin(elapsed * 1.6) * 0.06
  }

  function updateCamera(game: Game, dt: number, inSpace: boolean) {
    if (inSpace) {
      const ship = game.ship
      const forward = vA.set(Math.sin(ship.yaw), 0, Math.cos(ship.yaw))
      const docked = game.mode === 'docked'
      const distance = docked ? 19 : 13
      const height = docked ? 8 : 4.2
      vB.set(ship.x - forward.x * distance, ship.y + height, ship.z - forward.z * distance)
      vC.set(
        ship.x + forward.x * (docked ? 0 : 6),
        ship.y + 1.2,
        ship.z + forward.z * (docked ? 0 : 6),
      )
      camera.up.set(0, 1, 0)
      if (firstFrame) {
        cameraPosition.copy(vB)
        cameraTarget.copy(vC)
      } else {
        cameraPosition.lerp(vB, 1 - Math.pow(0.0022, dt))
        cameraTarget.lerp(vC, 1 - Math.pow(0.0016, dt))
      }
    } else {
      const player = game.player
      const up = dir(player.lat, player.lon, vA)
      const north = vB.set(
        -Math.sin(player.lat) * Math.cos(player.lon),
        Math.cos(player.lat),
        -Math.sin(player.lat) * Math.sin(player.lon),
      ).normalize()
      const east = vC.crossVectors(up, north).normalize()
      const forward = vD.copy(north).multiplyScalar(Math.cos(player.facing))
        .addScaledVector(east, Math.sin(player.facing)).normalize()
      const playerPosition = surfacePoint(player.lat, player.lon, terrainRadius(player.lat, player.lon) + player.h)
      vE.copy(playerPosition).addScaledVector(up, 7.4).addScaledVector(forward, -12.6)
      const lookAt = new THREE.Vector3().copy(playerPosition).addScaledVector(up, 1.7).addScaledVector(forward, 7)
      camera.up.copy(up)
      if (firstFrame) {
        cameraPosition.copy(vE)
        cameraTarget.copy(lookAt)
      } else {
        cameraPosition.lerp(vE, 1 - Math.pow(0.0028, dt))
        cameraTarget.lerp(lookAt, 1 - Math.pow(0.0015, dt))
      }
    }
    firstFrame = false
    camera.position.copy(cameraPosition)
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
        const at = surfacePoint(event.lat, event.lon, terrainRadius(event.lat, event.lon) + event.h + 0.8)
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
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
