/**
 * The International Space Station (plan §5.5, §8).
 *
 * Chunky low-poly, procedural, no assets - the same contract as `ship.ts`. Two things
 * drive the shape:
 *
 *   - The **docking port is unmistakable**, from far away and from close up. Up close
 *     it is a flared capture cone with four guide vanes, a lit rim and a ring of
 *     approach lights; its mouth lands exactly on the berth, so a docked tug's nose is
 *     visibly *inside* the cone rather than floating next to it. From a distance it is
 *     a strobe beacon, which is the part that answers "where is it" while you are
 *     still crossing the orbit - a funnel is no use at 400 u and a strobe is no use at
 *     3 u, so the port carries both.
 *   - The **body** follows the reference art: a segmented truss with greebles, four
 *     tall gold array wings on arms at the ends, grey radiator panels, a cluster of
 *     capsule modules with end caps, a mast with a hexagonal head, and a dish.
 *
 * Frame, shared with the sim: local **+X points radially away from Earth** and +Z is
 * the direction of travel around it. The port sits at `ISS_PORT_OFFSET` and the berth
 * at `ISS_DOCK_OFFSET`, both read from config, so the art cannot drift away from the
 * geometry the docking check uses.
 */
import * as THREE from 'three'
import { ISS_DOCK_OFFSET, ISS_PORT_OFFSET } from '../sim/config.ts'
import { glowTexture } from './surfaces.ts'

export interface StationModel {
  group: THREE.Group
  /**
   * The port's own feedback. Green and pulsing when the tug may dock, amber when some
   * other action is in range, cyan otherwise - the same rule the single hatch ring
   * used before, now spread across the whole assembly.
   */
  setApproach(docking: boolean, landable: boolean): void
  /** Spins the rings, strobes the approach lights. Call once a frame. */
  animate(elapsed: number, dt: number): void
}

const HULL = 0xe2e7ee
const GOLD = 0xd9772a
const DARK = 0x40495a
const RADIATOR = 0xc2cad4
const PORT = 0x7fe4ff
const PORT_READY = 0x8dff9d
const PORT_OTHER = 0xffe066

const dummy = new THREE.Object3D()

export function buildStation(): StationModel {
  const group = new THREE.Group()

  const hull = new THREE.MeshStandardMaterial({ color: HULL, roughness: 0.62, metalness: 0.28, flatShading: true })
  const dark = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.7, metalness: 0.35, flatShading: true })
  const gold = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.44, metalness: 0.4, flatShading: true })
  const radiator = new THREE.MeshStandardMaterial({ color: RADIATOR, roughness: 0.55, metalness: 0.2, flatShading: true })
  const ring = new THREE.MeshStandardMaterial({ color: 0xdfe4ec, roughness: 0.6, metalness: 0.25 })
  const portLit = new THREE.MeshBasicMaterial({ color: PORT })
  const portGlowMaterial = new THREE.MeshBasicMaterial({
    color: PORT, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
  })

  // ---------------------------------------------------------------- the truss
  // A spine with collars over it: the segmentation is what makes a long box read as
  // a built structure rather than a beam.
  const TRUSS = 13
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.85, TRUSS), hull)
  group.add(spine)

  const collars = new THREE.InstancedMesh(new THREE.BoxGeometry(1.22, 1.06, 0.3), dark, 10)
  for (let i = 0; i < 10; i++) {
    dummy.position.set(0, 0, -5.85 + i * 1.3)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    collars.setMatrixAt(i, dummy.matrix)
  }
  group.add(collars)

  // greebles: the small stuff. Boxes of a few sizes scattered along the spine, which
  // is what stops a segmented beam from looking like a segmented beam and nothing else.
  const greebleGeometry = new THREE.BoxGeometry(1, 1, 1)
  const greebles = new THREE.InstancedMesh(greebleGeometry, dark, 14)
  const GREEBLES: [number, number, number, number, number, number, number][] = [
    // x, y, z, sx, sy, sz, (unused rotation kept at zero)
    [0, 0.55, -5.1, 0.5, 0.35, 0.7, 0],
    [0, -0.55, -4.2, 0.62, 0.3, 0.5, 0],
    [0.5, 0.2, -3.1, 0.34, 0.5, 0.34, 0],
    [-0.5, 0.1, -2.2, 0.3, 0.42, 0.5, 0],
    [0, 0.6, 1.15, 0.44, 0.4, 0.6, 0],
    [0.55, -0.1, 2.3, 0.32, 0.34, 0.6, 0],
    [0, 0.58, 3.4, 0.5, 0.34, 0.44, 0],
    [-0.52, 0.15, 4.6, 0.34, 0.44, 0.34, 0],
    [0, -0.5, 5.4, 0.56, 0.28, 0.5, 0],
    [0.42, 0.36, 0.35, 0.26, 0.26, 0.26, 0],
    [-0.4, -0.36, -0.9, 0.3, 0.24, 0.4, 0],
    [0, 0.34, -0.2, 0.2, 0.3, 0.2, 0],
    [0.58, 0.42, 5.9, 0.3, 0.3, 0.3, 0],
    [-0.58, -0.42, 1.6, 0.28, 0.28, 0.44, 0],
  ]
  for (let i = 0; i < GREEBLES.length; i++) {
    const [x, y, z, sx, sy, sz] = GREEBLES[i]
    dummy.position.set(x, y, z)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(sx, sy, sz)
    dummy.updateMatrix()
    greebles.setMatrixAt(i, dummy.matrix)
  }
  group.add(greebles)

  // a dish on the forward face of the truss
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.16, 0.26, 10), hull)
  dish.rotation.z = Math.PI / 2
  dish.position.set(0.75, 0.15, -3.7)
  group.add(dish)
  const dishRod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 6), dark)
  dishRod.rotation.z = Math.PI / 2
  dishRod.position.set(0.45, 0.15, -3.7)
  group.add(dishRod)

  // ------------------------------------------------------------- solar wings
  // Four tall arrays, two per end, in the reference's arrangement: a white rail top
  // and bottom with four gold slats slung between them. They are thin in X and tall in
  // Y, so a tug coming up from Earth sees them face on.
  const SLATS_PER_WING = 4
  const SLAT_W = 0.42
  const SLAT_GAP = 0.11
  const WING_H = 8.4
  const WING_Z0 = TRUSS / 2 + 0.35
  const wingSpan = SLATS_PER_WING * SLAT_W + (SLATS_PER_WING - 1) * SLAT_GAP

  const slatGeometry = new THREE.BoxGeometry(0.07, WING_H, SLAT_W)
  const slatTotal = SLATS_PER_WING * 2 * 2
  const slats = new THREE.InstancedMesh(slatGeometry, gold, slatTotal)
  const railGeometry = new THREE.BoxGeometry(0.16, 0.34, wingSpan + 0.2)
  const rails = new THREE.InstancedMesh(railGeometry, hull, 2 * 2 * 2)

  let slatIndex = 0
  let railIndex = 0
  for (const side of [-1, 1]) {
    // the arm out to the wing, then the wing itself
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.9), hull)
    arm.position.set(0, 0, side * (TRUSS / 2 + 0.2))
    group.add(arm)

    const z0 = side * WING_Z0
    for (let i = 0; i < SLATS_PER_WING; i++) {
      const z = z0 + side * i * (SLAT_W + SLAT_GAP)
      for (const y of [-1, 1]) {
        dummy.position.set(0, y * (WING_H / 2 + 0.55), z)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(1, 1, 1)
        dummy.updateMatrix()
        slats.setMatrixAt(slatIndex++, dummy.matrix)
      }
    }
    for (const y of [-1, 1]) {
      for (const offset of [0.9, 0.2]) {
        dummy.position.set(0, y * (WING_H / 2 + offset), z0 + side * (wingSpan / 2 - SLAT_W / 2))
        dummy.scale.set(1, 1, 1)
        dummy.updateMatrix()
        rails.setMatrixAt(railIndex++, dummy.matrix)
      }
    }
  }
  group.add(slats)
  group.add(rails)

  // -------------------------------------------------------------- radiators
  // Grey, and kept inside the spinning rings' radius so nothing intersects.
  const radGeometry = new THREE.BoxGeometry(0.07, 1.5, 0.85)
  const radiators = new THREE.InstancedMesh(radGeometry, radiator, 4)
  const RADIATOR_Z = [-2.7, -2.0, 2.0, 2.7]
  for (let i = 0; i < RADIATOR_Z.length; i++) {
    dummy.position.set(0, 1.65, RADIATOR_Z[i])
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    radiators.setMatrixAt(i, dummy.matrix)
  }
  group.add(radiators)

  // ------------------------------------------------------------ the modules
  // Under the truss, where the real station keeps them, and short enough that the shop
  // window still lands on an exposed face.
  const capsule = new THREE.CapsuleGeometry(1.32, 1.5, 4, 12)
  const modules = new THREE.InstancedMesh(capsule, hull, 3)
  const MODULE_Y = -1.55
  const MODULE_R = 1.32
  const MODULE_Z = [-2.6, 0, 2.6]
  for (let i = 0; i < MODULE_Z.length; i++) {
    dummy.position.set(0, MODULE_Y, MODULE_Z[i])
    dummy.rotation.set(Math.PI / 2, 0, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    modules.setMatrixAt(i, dummy.matrix)
  }
  group.add(modules)

  // end caps and nodes: the little cylinders that make a cluster read as joined up.
  // They sit ON the hull - a node buried inside a module is detail nobody can see.
  const nodeGeometry = new THREE.CylinderGeometry(0.42, 0.42, 0.5, 10)
  const nodes = new THREE.InstancedMesh(nodeGeometry, hull, 6)
  // Four hatches around the middle module. Each is placed by angle and then rotated so
  // its own axis points along that same radial: a cylinder laid parallel to the wall
  // would just sink into it.
  const HATCHES: [number, number][] = [
    [Math.PI * 0.85, -0.7], [Math.PI * 0.15, 0.7],
    [Math.PI * 1.15, 0.7], [Math.PI * 1.85, -0.7],
  ]
  let nodeIndex = 0
  for (const [angle, z] of HATCHES) {
    dummy.position.set(Math.cos(angle) * MODULE_R, MODULE_Y + Math.sin(angle) * MODULE_R, z)
    dummy.rotation.set(0, 0, angle - Math.PI / 2)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    nodes.setMatrixAt(nodeIndex++, dummy.matrix)
  }
  // and a cap on the nose of each outer module, aiming along Z like the module itself
  for (const z of [4.6, -4.6]) {
    dummy.position.set(0, MODULE_Y, z)
    dummy.rotation.set(Math.PI / 2, 0, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    nodes.setMatrixAt(nodeIndex++, dummy.matrix)
  }
  group.add(nodes)

  // ------------------------------------------------------------------- mast
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 3, 10), hull)
  mast.position.set(0, 2.3, 0)
  group.add(mast)
  const mastHead = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.78, 0.3, 6), hull)
  mastHead.position.set(0, 3.9, 0)
  group.add(mastHead)
  for (const z of [-0.95, 0.95]) {
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 0.7), dark)
    vane.position.set(0, 3.4, z)
    group.add(vane)
  }

  // ------------------------------------------- the rings (this game's own flavour)
  const spinning: THREE.Mesh[] = []
  for (let i = 0; i < 2; i++) {
    const torus = new THREE.Mesh(new THREE.TorusGeometry(3.5 + i * 0.9, 0.11, 6, 44), ring)
    torus.rotation.x = Math.PI / 2
    torus.position.y = 2.35 + i * 1.05
    spinning.push(torus)
    group.add(torus)
  }

  // --------------------------------------------------------- the docking port
  // The capture cone. Its mouth is at ISS_DOCK_OFFSET - exactly where a docked tug's
  // own origin sits - so the tug ends up inside it with its nose on the port.
  const CONE_INNER = ISS_PORT_OFFSET
  const CONE_OUTER = ISS_DOCK_OFFSET
  const coneLength = CONE_OUTER - CONE_INNER
  const MOUTH_R = 2.55
  const THROAT_R = 1.35
  const cone = new THREE.Mesh(
    new THREE.CylinderGeometry(MOUTH_R, THROAT_R, coneLength, 14, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x9fb0c4, roughness: 0.5, metalness: 0.45, side: THREE.DoubleSide, flatShading: true,
    }),
  )
  cone.rotation.z = Math.PI / 2
  cone.position.set((CONE_INNER + CONE_OUTER) / 2, 0, 0)
  group.add(cone)

  // four guide vanes down the inside of the cone: what a pilot actually aims at
  const vaneGeometry = new THREE.BoxGeometry(coneLength * 0.94, 0.16, 0.5)
  const vanes = new THREE.InstancedMesh(vaneGeometry, dark, 4)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const radius = (MOUTH_R + THROAT_R) / 2 - 0.15
    dummy.position.set((CONE_INNER + CONE_OUTER) / 2, Math.sin(a) * radius, Math.cos(a) * radius)
    dummy.rotation.set(a, 0, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    vanes.setMatrixAt(i, dummy.matrix)
  }
  group.add(vanes)

  // the arm that carries the port off the truss
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.62, CONE_INNER - 0.4, 10), hull)
  arm.rotation.z = Math.PI / 2
  arm.position.set((CONE_INNER - 0.4) / 2 + 0.2, 0, 0)
  group.add(arm)

  // lit rim on the mouth: the single brightest thing on the station
  const rim = new THREE.Mesh(new THREE.TorusGeometry(MOUTH_R, 0.075, 8, 30), portLit)
  rim.rotation.y = Math.PI / 2
  rim.position.set(CONE_OUTER, 0, 0)
  group.add(rim)
  const rimGlow = new THREE.Mesh(new THREE.TorusGeometry(MOUTH_R, 0.17, 8, 30), portGlowMaterial)
  rimGlow.rotation.y = Math.PI / 2
  rimGlow.position.set(CONE_OUTER, 0, 0)
  group.add(rimGlow)

  // the hatch itself, on the port, and the ring of approach lights inside the cone
  const hatch = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.15, 8, 24), portLit)
  hatch.rotation.y = Math.PI / 2
  hatch.position.set(CONE_INNER, 0, 0)
  group.add(hatch)
  const approach = new THREE.Mesh(new THREE.TorusGeometry(THROAT_R + 0.35, 0.09, 6, 22), portGlowMaterial)
  approach.rotation.y = Math.PI / 2
  approach.position.set(CONE_INNER + coneLength * 0.42, 0, 0)
  group.add(approach)

  // the strobe: what you see from across the orbit, when the funnel is a couple of pixels
  const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(190, 250, 255, 0.95)', 'rgba(90, 200, 255, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  beacon.scale.setScalar(4.2)
  beacon.position.set(CONE_OUTER + 0.2, 0, 0)
  group.add(beacon)

  // ------------------------------------------------------------- shop window
  // Gameplay, not decoration: docking opens the market, and the market is a window.
  const shopWindow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 0.95),
    new THREE.MeshBasicMaterial({ color: 0xffdf9b }),
  )
  shopWindow.position.set(0.5, -0.35, 3.36)
  group.add(shopWindow)
  const shopGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255, 226, 150, 0.85)', 'rgba(255, 170, 60, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  shopGlow.scale.setScalar(5.4)
  shopGlow.position.set(0.5, -0.3, 3.5)
  group.add(shopGlow)

  // -------------------------------------------------------------- behaviour
  let docking = false
  let landable = false

  function tintPort() {
    const color = docking ? PORT_READY : landable ? PORT_OTHER : PORT
    portLit.color.setHex(color)
    portGlowMaterial.color.setHex(color)
  }
  tintPort()

  return {
    group,

    setApproach(nextDocking, nextLandable) {
      if (nextDocking === docking && nextLandable === landable) return
      docking = nextDocking
      landable = nextLandable
      tintPort()
    },

    animate(elapsed, dt) {
      for (let i = 0; i < spinning.length; i++) {
        spinning[i].rotation.z += dt * (i === 0 ? 0.7 : -0.55)
      }
      // Approach lights breathe, and breathe faster when the tug is cleared to dock:
      // a slow glow is scenery, a quick one is an invitation.
      const rate = docking ? 4.4 : 1.5
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * rate)
      portGlowMaterial.opacity = (docking ? 0.5 : 0.3) + pulse * (docking ? 0.45 : 0.22)
      rim.scale.setScalar(docking ? 1 + pulse * 0.05 : 1)
      hatch.scale.setScalar(docking ? 1.1 + pulse * 0.12 : 1)
      // the strobe: two quick flashes then a gap, so it reads as a beacon rather than
      // as a throb. A plain sine is invisible against a pulse-everything UI.
      const beat = elapsed % 2.2
      const flash = beat < 0.12 ? 1 : beat < 0.3 ? 0.25 : beat < 0.42 ? 0.8 : 0.08
      beacon.material.opacity = flash
      beacon.scale.setScalar(3.2 + flash * 2.6)
      shopGlow.material.opacity = 0.68 + Math.sin(elapsed * 2.4) * 0.2
    },
  }
}
