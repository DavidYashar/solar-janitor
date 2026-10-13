/**
 * The janitor's tug (plan §8): a faceted white / blue-grey spaceplane built
 * entirely from procedural geometry - no asset files, nothing to download.
 *
 * Orientation contract, shared with the sim and `scene.ts`:
 *   nose points +Z (the sim's forward axis), the engine and its plume sit at -Z
 *   where the frame loop drives `thruster` and `thrusterGlow` from ship.thrust.
 */
import * as THREE from 'three'
import { glowTexture } from './surfaces.ts'

export interface ShipModel {
  group: THREE.Group
  thruster: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>
  thrusterGlow: THREE.Sprite
  /** short-range fill light that keeps the hull readable in space */
  heroLight: THREE.PointLight
}

type Pt = [number, number]

/** One hull cross-section: half-width, ridge height, belly depth. */
interface Section {
  z: number
  w: number
  h: number
  b: number
}

/** Panel greys the reference art mixes across its facets. */
const PANELS = [0xe9eef4, 0xdde5ed, 0xd2dbe6, 0xc6d1dd, 0xf0f4f8]

function panelTint(seed: number): THREE.Color {
  const s = Math.sin(seed * 12.9898 + 4.1414) * 43758.5453
  const pick = s - Math.floor(s)
  return new THREE.Color(PANELS[Math.floor(pick * PANELS.length) % PANELS.length])
}

/** Push a triangle wound so its normal points along `n`. */
function tri(
  a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
  n: THREE.Vector3, pos: number[], col: number[], tint: THREE.Color,
) {
  const flip = b.clone().sub(a).cross(c.clone().sub(a)).dot(n) < 0
  const verts = flip ? [a, c, b] : [a, b, c]
  for (const v of verts) {
    pos.push(v.x, v.y, v.z)
    col.push(tint.r, tint.g, tint.b)
  }
}

function finish(pos: number[], col: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** Hull polygon: ridged top, chined sides, keel belly. */
function ring(s: Section): Pt[] {
  const { w, h, b } = s
  return [
    [0, h],
    [w * 0.5, h * 0.42],
    [w * 0.88, -b * 0.26],
    [w * 0.44, -b],
    [-w * 0.44, -b],
    [-w * 0.88, -b * 0.26],
    [-w * 0.5, h * 0.42],
  ]
}

/** Loft sections nose-to-tail with flat, per-facet shading. */
function loft(sections: Section[]): THREE.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  const tint = new THREE.Color()
  const rings = sections.map(ring)
  const centres = rings.map(points => points.reduce((sum, p) => sum + p[1], 0) / points.length)
  let face = 0
  for (let i = 0; i < sections.length - 1; i++) {
    const a = rings[i]
    const b = rings[i + 1]
    const za = sections[i].z
    const zb = sections[i + 1].z
    const centreY = (centres[i] + centres[i + 1]) / 2
    for (let j = 0; j < a.length; j++) {
      const k = (j + 1) % a.length
      const p0 = new THREE.Vector3(a[j][0], a[j][1], za)
      const p1 = new THREE.Vector3(a[k][0], a[k][1], za)
      const p2 = new THREE.Vector3(b[k][0], b[k][1], zb)
      const p3 = new THREE.Vector3(b[j][0], b[j][1], zb)
      const out = p0.clone().add(p1).add(p2).add(p3).multiplyScalar(0.25)
      out.y -= centreY
      tint.copy(panelTint(face++))
      tri(p0, p1, p2, out, pos, col, tint)
      tri(p0, p2, p3, out, pos, col, tint)
    }
  }
  // end caps keep both volumes closed
  const cap = (points: Pt[], z: number, n: THREE.Vector3) => {
    for (let j = 1; j < points.length - 1; j++) {
      tint.copy(panelTint(face++))
      tri(
        new THREE.Vector3(points[0][0], points[0][1], z),
        new THREE.Vector3(points[j][0], points[j][1], z),
        new THREE.Vector3(points[j + 1][0], points[j + 1][1], z),
        n, pos, col, tint,
      )
    }
  }
  cap(rings[0], sections[0].z, new THREE.Vector3(0, 0, 1))
  cap(rings[rings.length - 1], sections[sections.length - 1].z, new THREE.Vector3(0, 0, -1))
  return finish(pos, col)
}

/**
 * A convex plate extruded to `thickness`.
 * `plane: 'xz'` is a wing (points are [x, z], extruded along Y);
 * `plane: 'yz'` is a fin (points are [z, y], extruded along X).
 */
function plate(points: Pt[], thickness: number, plane: 'xz' | 'yz'): THREE.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  const tint = new THREE.Color()
  const half = thickness / 2
  const to3 = (p: Pt, side: number): THREE.Vector3 => (
    plane === 'xz' ? new THREE.Vector3(p[0], side * half, p[1]) : new THREE.Vector3(side * half, p[1], p[0])
  )
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length
  for (const side of [1, -1]) {
    const n = plane === 'xz'
      ? new THREE.Vector3(0, side, 0)
      : new THREE.Vector3(side, 0, 0)
    for (let i = 1; i < points.length - 1; i++) {
      tint.copy(panelTint(i * 7.3 + side * 2.1))
      tri(to3(points[0], side), to3(points[i], side), to3(points[i + 1], side), n, pos, col, tint)
    }
  }
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const mx = (a[0] + b[0]) / 2 - cx
    const my = (a[1] + b[1]) / 2 - cy
    const n = plane === 'xz' ? new THREE.Vector3(mx, 0, my) : new THREE.Vector3(0, my, mx)
    n.normalize()
    tint.copy(panelTint(i * 3.1))
    tri(to3(a, 1), to3(b, 1), to3(b, -1), n, pos, col, tint)
    tri(to3(a, 1), to3(b, -1), to3(a, -1), n, pos, col, tint)
  }
  return finish(pos, col)
}

const hullMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.2 })
const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x4b5566, roughness: 0.55, metalness: 0.38 })
const glassMaterial = new THREE.MeshStandardMaterial({
  color: 0x0c1826, roughness: 0.12, metalness: 0.55, emissive: 0x0d3d55, emissiveIntensity: 0.7,
})
const accentMaterial = new THREE.MeshBasicMaterial({ color: 0x63e2ff })

export function buildShip(): ShipModel {
  const group = new THREE.Group()

  // hero fill: a short-range point light along for the ride, so the hull reads
  // in space where the sun key only lights the far side (range keeps it off planets)
  const heroLight = new THREE.PointLight(0xdfe9ff, 14, 18, 2)
  heroLight.position.set(2.4, 3.6, 3.0)
  group.add(heroLight)

  // ---------------------------------------------------------------- hull
  group.add(new THREE.Mesh(loft([
    { z: 3.5, w: 0.05, h: 0.05, b: 0.05 },
    { z: 2.55, w: 0.34, h: 0.2, b: 0.17 },
    { z: 1.6, w: 0.72, h: 0.4, b: 0.34 },
    { z: 0.6, w: 1.0, h: 0.52, b: 0.46 },
    { z: -0.5, w: 1.08, h: 0.5, b: 0.44 },
    { z: -1.6, w: 0.95, h: 0.42, b: 0.38 },
    { z: -2.85, w: 0.58, h: 0.3, b: 0.28 },
  ]), hullMaterial))

  // -------------------------------------------------------------- canopy
  const canopy = new THREE.Mesh(loft([
    { z: 1.62, w: 0.14, h: 0.14, b: -0.02 },
    { z: 1.14, w: 0.46, h: 0.62, b: 0.05 },
    { z: 0.72, w: 0.6, h: 0.74, b: 0.08 },
    { z: 0.36, w: 0.42, h: 0.58, b: 0.05 },
    { z: 0.14, w: 0.16, h: 0.18, b: 0.0 },
  ]), glassMaterial)
  canopy.position.y = 0.36
  group.add(canopy)

  // dark dorsal spine that hugs the hull ridge from the canopy to the pod
  group.add(new THREE.Mesh(loft([
    { z: 0.16, w: 0.3, h: 0.5, b: -0.2 },
    { z: -0.5, w: 0.46, h: 0.62, b: -0.24 },
    { z: -1.4, w: 0.44, h: 0.54, b: -0.22 },
    { z: -2.2, w: 0.38, h: 0.44, b: -0.18 },
    { z: -2.72, w: 0.3, h: 0.36, b: -0.14 },
  ]), darkMaterial))

  // dark anti-glare panel ahead of the glass, as on the reference nose
  const glare = new THREE.Mesh(plate([
    [0.34, 2.45], [0.42, 1.72], [-0.42, 1.72], [-0.34, 2.45],
  ], 0.1, 'xz'), darkMaterial)
  glare.position.y = 0.2
  glare.rotation.x = 0.1
  group.add(glare)

  // fitted dark collar the canopy sits in
  const collar = new THREE.Mesh(loft([
    { z: 1.66, w: 0.22, h: 0.22, b: -0.1 },
    { z: 1.3, w: 0.6, h: 0.28, b: -0.14 },
    { z: 0.72, w: 0.72, h: 0.3, b: -0.16 },
    { z: 0.3, w: 0.56, h: 0.26, b: -0.12 },
    { z: 0.08, w: 0.28, h: 0.18, b: -0.08 },
  ]), darkMaterial)
  collar.position.y = 0.3
  group.add(collar)

  // --------------------------------------------------------------- wings
  for (const side of [1, -1]) {
    const sx = (value: number) => side * value
    const wing = new THREE.Mesh(plate([
      [sx(0.8), 0.7], [sx(2.7), -1.05], [sx(2.55), -1.75], [sx(0.75), -1.5],
    ], 0.11, 'xz'), hullMaterial)
    wing.position.y = -0.05
    group.add(wing)

    // dark leading edge, as in the reference art
    const edge = new THREE.Mesh(plate([
      [sx(0.82), 0.66], [sx(2.66), -1.0], [sx(2.74), -1.34], [sx(0.86), 0.3],
    ], 0.13, 'xz'), darkMaterial)
    edge.position.y = -0.045
    group.add(edge)

    // tail stabilisers under the engine deck
    const stab = new THREE.Mesh(plate([
      [sx(0.55), -1.85], [sx(1.72), -2.3], [sx(1.64), -2.7], [sx(0.5), -2.55],
    ], 0.08, 'xz'), hullMaterial)
    stab.position.y = -0.18
    group.add(stab)
  }

  // ------------------------------------------------------------ tail fin
  // sits right behind the canopy, as on the reference, clear of the pod
  const fin = new THREE.Mesh(plate([
    [-0.5, 0.4], [-1.55, 0.48], [-1.98, 1.72], [-1.16, 2.0],
  ], 0.12, 'yz'), hullMaterial)
  fin.rotation.z = 0.07
  group.add(fin)
  const finCap = new THREE.Mesh(plate([
    [-1.2, 1.86], [-1.94, 1.6], [-2.06, 1.9], [-1.36, 2.12],
  ], 0.14, 'yz'), darkMaterial)
  finCap.rotation.z = 0.07
  group.add(finCap)

  // ------------------------------------------------------- top engine pod
  // mid-grey barrel with darker collars, tucked low behind the fin
  const podBody = new THREE.MeshStandardMaterial({ color: 0x5b6674, roughness: 0.5, metalness: 0.42 })
  const podBand = new THREE.MeshStandardMaterial({ color: 0x3c4553, roughness: 0.6, metalness: 0.4 })
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 1.0), podBand)
  pylon.position.set(0, 0.62, -2.4)
  group.add(pylon)

  const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.5, 16), podBody)
  pod.rotation.x = Math.PI / 2
  pod.position.set(0, 0.86, -2.5)
  group.add(pod)
  const podCollarA = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.18, 16), podBand)
  podCollarA.rotation.x = Math.PI / 2
  podCollarA.position.set(0, 0.86, -1.95)
  group.add(podCollarA)
  const podCollarB = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.22, 16), podBand)
  podCollarB.rotation.x = Math.PI / 2
  podCollarB.position.set(0, 0.86, -2.9)
  group.add(podCollarB)
  const podRing = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.12, 16), accentMaterial)
  podRing.rotation.x = Math.PI / 2
  podRing.position.set(0, 0.86, -3.17)
  group.add(podRing)
  const podCore = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.08, 12), accentMaterial)
  podCore.rotation.x = Math.PI / 2
  podCore.position.set(0, 0.86, -3.26)
  group.add(podCore)

  // ---------------------------------------------------- rear main nozzles
  for (const side of [1, -1]) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.7, 12), darkMaterial)
    nozzle.rotation.x = Math.PI / 2
    nozzle.position.set(side * 0.44, -0.16, -2.5)
    group.add(nozzle)
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 10), accentMaterial)
    core.rotation.x = Math.PI / 2
    core.position.set(side * 0.44, -0.16, -2.86)
    group.add(core)
  }

  // --------------------------------------------------------------- plume
  const thruster = new THREE.Mesh(
    new THREE.ConeGeometry(0.46, 2.4, 12),
    new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.62 }),
  )
  thruster.rotation.x = -Math.PI / 2
  thruster.position.set(0, -0.05, -3.0)
  group.add(thruster)
  const thrusterGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(150, 235, 255, 0.8)', 'rgba(70, 160, 255, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  thrusterGlow.position.set(0, -0.05, -3.1)
  thrusterGlow.scale.setScalar(3.4)
  group.add(thrusterGlow)

  return { group, thruster, thrusterGlow, heroLight }
}
