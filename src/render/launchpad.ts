import * as THREE from 'three'
import { PAD_RADIUS, TAU } from '../sim/config.ts'
import { fromPad } from '../sim/earthfield.ts'
import { type PlanetDef } from '../sim/planets.ts'
import { mulberry32 } from '../sim/noise.ts'

/**
 * The launch apron, drawn the same way on all three worlds.
 *
 * It is a helipad, because that is what a landing pad looks like from above: a
 * touchdown deck at the middle, a ring of hazard chevrons warning you off its
 * edge, and then the markings running out through concrete and bitumen to a
 * yellow safety ring and a last band of concrete outside that. The bands sit at
 * the fractions of the radius they occupy in the reference photograph, so the
 * proportions are the reference's rather than invented here.
 *
 * Two things about it are the game's own. It is flush with the ground: the
 * janitor's height comes from the terrain function, so a raised deck would be
 * something he walked through rather than onto, and the apron the terrain fields
 * level (`PAD_APRON`) is what buys a genuinely flat place to lay it. And the
 * touchdown deck is wider than the reference's, because the thing that lands on
 * it is a ship with its legs four and a half metres apart rather than a
 * helicopter on a pad built for a fleet.
 */

/** the markings, outward from the middle, as a fraction of the radius */
const BAND = { deck: 0.27, chevron: 0.33, slab: 0.42, bitumen: 0.77, yellow: 0.85 }

const CONCRETE = '#a8a39e'
const SLAB = '#8d8983'
const BITUMEN = '#35373a'
const SAFETY = '#e9b83f'
const HAZARD = '#1f2124'
const GRATE = '#5f6160'
const GRATE_LINE = '#2a2c2c'

/** how far the disc floats above the ground it is laid on */
const LIFT = 0.05

const UP = new THREE.Vector3(0, 1, 0)

/**
 * The apron's markings, as one texture over the whole disc.
 *
 * A texture and not geometry, because every one of these bands is paint on a
 * flat surface: drawing them as rings would cost a mesh and a draw call each and
 * would still z-fight with the ground between them. The disc's own UVs run 0..1
 * across its bounding square, so the texture's inscribed circle is the disc.
 */
function padTexture(): THREE.CanvasTexture {
  const SIZE = 1024
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  if (!ctx) return texture

  const mid = SIZE / 2
  const edge = mid - 1
  const rnd = mulberry32(0x5a17c0)
  const at = (fraction: number) => fraction * edge

  const discOf = (fraction: number, fill: string) => {
    ctx.beginPath()
    ctx.arc(mid, mid, at(fraction), 0, TAU)
    ctx.fillStyle = fill
    ctx.fill()
  }

  // painted from the rim inward, so each band sits on the one outside it
  discOf(1, CONCRETE)
  discOf(BAND.yellow, SAFETY)
  discOf(BAND.bitumen, BITUMEN)
  discOf(BAND.slab, SLAB)
  discOf(BAND.deck, GRATE)

  // the joints that divide the outer apron into slabs, struck from the middle
  ctx.strokeStyle = 'rgba(52, 50, 47, 0.55)'
  ctx.lineWidth = 2.6
  for (let i = 0; i < 48; i++) {
    const angle = (i / 48) * TAU
    ctx.beginPath()
    ctx.moveTo(mid + Math.cos(angle) * at(BAND.yellow), mid + Math.sin(angle) * at(BAND.yellow))
    ctx.lineTo(mid + Math.cos(angle) * edge, mid + Math.sin(angle) * edge)
    ctx.stroke()
  }

  // hazard chevrons round the deck: a stripe field on the diagonal, clipped to
  // the ring, so the spacing stays even the whole way round
  ctx.save()
  ctx.beginPath()
  ctx.arc(mid, mid, at(BAND.chevron), 0, TAU)
  ctx.arc(mid, mid, at(BAND.deck), 0, TAU, true)
  ctx.closePath()
  ctx.clip()
  const stripe = at(BAND.chevron) * 0.15
  for (let k = -SIZE; k < SIZE * 2; k += stripe) {
    ctx.fillStyle = Math.round(k / stripe) % 2 === 0 ? SAFETY : HAZARD
    ctx.save()
    ctx.translate(k, 0)
    ctx.rotate(-Math.PI / 4)
    ctx.fillRect(-stripe / 2, -SIZE, stripe, SIZE * 3)
    ctx.restore()
  }
  ctx.restore()

  // the grating the ship comes down on
  ctx.save()
  ctx.beginPath()
  ctx.arc(mid, mid, at(BAND.deck), 0, TAU)
  ctx.clip()
  ctx.fillStyle = GRATE
  ctx.fillRect(0, 0, SIZE, SIZE)
  ctx.strokeStyle = GRATE_LINE
  ctx.lineWidth = 2.2
  const reach = at(BAND.deck) + 2
  const cell = at(BAND.deck) / 11
  for (let i = -11; i <= 11; i++) {
    ctx.beginPath()
    ctx.moveTo(mid + i * cell, mid - reach)
    ctx.lineTo(mid + i * cell, mid + reach)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(mid - reach, mid + i * cell)
    ctx.lineTo(mid + reach, mid + i * cell)
    ctx.stroke()
  }
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  ctx.arc(mid, mid, edge, 0, TAU)
  ctx.clip()

  // hatches and patches of fresh bitumen, laid across the bands
  for (let i = 0; i < 16; i++) {
    const angle = rnd() * TAU
    const out = at(0.46 + rnd() * 0.36)
    const w = 34 + rnd() * 78
    const h = 24 + rnd() * 50
    ctx.save()
    ctx.translate(mid + Math.cos(angle) * out, mid + Math.sin(angle) * out)
    ctx.rotate(angle + Math.PI / 2 + (rnd() - 0.5) * 0.5)
    ctx.fillStyle = `rgba(22, 22, 24, ${(0.16 + rnd() * 0.2).toFixed(3)})`
    ctx.fillRect(-w / 2, -h / 2, w, h)
    ctx.restore()
  }

  // weather: soft blooms of dirt and of sun-bleached concrete
  for (let i = 0; i < 110; i++) {
    const angle = rnd() * TAU
    const out = Math.sqrt(rnd()) * edge
    const x = mid + Math.cos(angle) * out
    const y = mid + Math.sin(angle) * out
    const size = 24 + rnd() * 96
    const bloom = ctx.createRadialGradient(x, y, 0, x, y, size)
    bloom.addColorStop(0, rnd() < 0.5 ? 'rgba(44, 42, 39, 0.17)' : 'rgba(234, 232, 226, 0.14)')
    bloom.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = bloom
    ctx.fillRect(x - size, y - size, size * 2, size * 2)
  }

  // grain, as a small tile repeated rather than a pass over a million pixels
  const grain = document.createElement('canvas')
  grain.width = 128
  grain.height = 128
  const grainCtx = grain.getContext('2d')
  if (grainCtx) {
    const image = grainCtx.createImageData(128, 128)
    for (let i = 0; i < image.data.length; i += 4) {
      const value = 128 + (rnd() - 0.5) * 96
      image.data[i] = value
      image.data[i + 1] = value
      image.data[i + 2] = value
      image.data[i + 3] = 255
    }
    grainCtx.putImageData(image, 0, 0)
    const pattern = ctx.createPattern(grain, 'repeat')
    if (pattern) {
      ctx.globalCompositeOperation = 'overlay'
      ctx.globalAlpha = 0.2
      ctx.fillStyle = pattern
      ctx.fillRect(0, 0, SIZE, SIZE)
    }
  }
  ctx.restore()

  texture.needsUpdate = true
  return texture
}

let cachedTexture: THREE.CanvasTexture | null = null

/** the markings never change, and all three worlds wear the same pad */
function sharedTexture(): THREE.CanvasTexture {
  cachedTexture = cachedTexture ?? padTexture()
  return cachedTexture
}

/**
 * The disc, built onto the ground the mesh actually draws rather than onto a
 * plane.
 *
 * A flat disc cannot work: the apron is a cap on a ball, so its edge would sink
 * `r²/2R` below the ground it is laid on, and on Mars, where the ball is ninety
 * six metres, that is three quarters of a metre of concrete buried at the rim.
 * Every vertex is therefore placed by asking the terrain where the ground is,
 * which is also what keeps the pad level with the mesh the janitor walks on.
 */
function padDisc(
  planet: PlanetDef, radiusOf: (lat: number, lon: number) => number,
  site: { lat: number; lon: number },
): THREE.BufferGeometry {
  const segments = 96
  const rings = [0.09, 0.18, 0.27, 0.33, 0.42, 0.55, 0.68, 0.77, 0.85, 0.93, 1]
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []

  const push = (angle: number, fraction: number) => {
    const north = Math.sin(angle) * fraction * PAD_RADIUS
    const east = Math.cos(angle) * fraction * PAD_RADIUS
    const p = fromPad(site.lat, site.lon, north, east, planet.surfaceRadius)
    const cosLat = Math.cos(p.lat)
    const nx = cosLat * Math.cos(p.lon)
    const ny = Math.sin(p.lat)
    const nz = cosLat * Math.sin(p.lon)
    const radius = radiusOf(p.lat, p.lon) + LIFT
    positions.push(nx * radius, ny * radius, nz * radius)
    normals.push(nx, ny, nz)
    uvs.push(0.5 + 0.5 * fraction * Math.cos(angle), 0.5 + 0.5 * fraction * Math.sin(angle))
  }

  push(0, 0)
  for (const fraction of rings) {
    for (let s = 0; s < segments; s++) push((s / segments) * TAU, fraction)
  }

  // north x east is up on this sphere, so a triangle wound centre -> angle ->
  // radius faces outward; the fan and the bands are wound to match
  const indices: number[] = []
  for (let s = 0; s < segments; s++) indices.push(0, 1 + ((s + 1) % segments), 1 + s)
  for (let r = 0; r < rings.length - 1; r++) {
    const inner = 1 + r * segments
    const outer = 1 + (r + 1) * segments
    for (let s = 0; s < segments; s++) {
      const next = (s + 1) % segments
      indices.push(inner + s, inner + next, outer + s)
      indices.push(inner + next, outer + next, outer + s)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

/** a point on the apron by bearing and distance from its middle */
function onPad(
  planet: PlanetDef, radiusOf: (lat: number, lon: number) => number,
  site: { lat: number; lon: number }, bearing: number, out: number, target: THREE.Vector3,
): THREE.Vector3 {
  const p = fromPad(site.lat, site.lon, Math.cos(bearing) * out, Math.sin(bearing) * out, planet.surfaceRadius)
  const cosLat = Math.cos(p.lat)
  target.set(cosLat * Math.cos(p.lon), Math.sin(p.lat), cosLat * Math.sin(p.lon))
  return target.multiplyScalar(radiusOf(p.lat, p.lon) + LIFT)
}

/**
 * A frame standing on the apron: where it is, which way is up, and which way is
 * outward from the middle.
 *
 * The outward axis is the reason this is a frame and not a pair of vectors.
 * `setFromUnitVectors` leaves the other two axes wherever the shortest rotation
 * happened to put them, which is fine for a post and useless for anything with a
 * front: the cabinets have to face the pad and the lamp banks have to lie across
 * their masts, and neither happens by accident.
 */
function padFrame(
  planet: PlanetDef, radiusOf: (lat: number, lon: number) => number,
  site: { lat: number; lon: number }, bearing: number, out: number, centre: THREE.Vector3,
  position: THREE.Vector3, up: THREE.Vector3, outward: THREE.Vector3,
) {
  onPad(planet, radiusOf, site, bearing, out, position)
  up.copy(position).normalize()
  outward.subVectors(position, centre)
  outward.addScaledVector(up, -outward.dot(up))
  outward.normalize()
}

const scratchRight = new THREE.Vector3()

/** local +X across, +Y up, +Z outward from the middle of the pad */
function aim(dummy: THREE.Object3D, up: THREE.Vector3, outward: THREE.Vector3) {
  scratchRight.crossVectors(up, outward).normalize()
  dummy.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(scratchRight, up, outward),
  )
}

export function buildLaunchPad(
  planet: PlanetDef, radiusOf: (lat: number, lon: number) => number,
  site: { lat: number; lon: number },
): THREE.Group {
  const group = new THREE.Group()
  const dummy = new THREE.Object3D()
  const here = new THREE.Vector3()
  const there = new THREE.Vector3()
  const up = new THREE.Vector3()
  const outward = new THREE.Vector3()
  const centre = new THREE.Vector3()

  const disc = new THREE.Mesh(
    padDisc(planet, radiusOf, site),
    new THREE.MeshStandardMaterial({ map: sharedTexture(), roughness: 0.88, metalness: 0.02 }),
  )
  disc.receiveShadow = true
  group.add(disc)

  onPad(planet, radiusOf, site, 0, 0, centre)

  /** stand something on the apron at `bearing`, `out` metres from the middle */
  const stand = (bearing: number, out: number, height: number) => {
    padFrame(planet, radiusOf, site, bearing, out, centre, here, up, outward)
    dummy.position.copy(here).addScaledVector(up, height / 2)
    aim(dummy, up, outward)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    return dummy.matrix.clone()
  }

  const postCount = 40
  const railRadius = PAD_RADIUS - 0.65
  const railMaterial = new THREE.MeshStandardMaterial({ color: 0xc6cacd, roughness: 0.45, metalness: 0.55 })

  /**
   * The way in. A rail right round the rim would be walked through every time
   * the janitor leaves - there is no collision in this game, and a fence he can
   * cross is worse than a fence with a gate in it. The gate sits on the one
   * bearing with nothing parked on it, so the walkway out is clear.
   */
  const GAP = { bearing: 4.2, half: 0.32 }
  const inGap = (angle: number) =>
    Math.abs(Math.atan2(Math.sin(angle - GAP.bearing), Math.cos(angle - GAP.bearing))) <= GAP.half

  const postMatrices: THREE.Matrix4[] = []
  for (let i = 0; i < postCount; i++) {
    const angle = (i / postCount) * TAU
    if (!inGap(angle)) postMatrices.push(stand(angle, railRadius, 0.95))
  }
  const posts = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.07, 0.95, 0.07), railMaterial, postMatrices.length,
  )
  postMatrices.forEach((matrix, index) => posts.setMatrixAt(index, matrix))
  group.add(posts)

  // the rails run between the posts rather than round a circle, because on a ball
  // this size a circle is a chord at best: sixty-eight centimetres of daylight
  // under the far side of it on Mars
  const railMatrices: THREE.Matrix4[] = []
  for (const height of [0.58, 0.95]) {
    for (let i = 0; i < postCount; i++) {
      if (inGap(((i + 0.5) / postCount) * TAU)) continue
      padFrame(planet, radiusOf, site, (i / postCount) * TAU, railRadius, centre, here, up, outward)
      here.addScaledVector(up, height)
      padFrame(planet, radiusOf, site, ((i + 1) / postCount) * TAU, railRadius, centre, there, up, outward)
      there.addScaledVector(up, height)
      dummy.position.addVectors(here, there).multiplyScalar(0.5)
      up.subVectors(there, here)
      const span = up.length()
      dummy.quaternion.setFromUnitVectors(UP, up.divideScalar(span))
      dummy.scale.set(1, span, 1)
      dummy.updateMatrix()
      railMatrices.push(dummy.matrix.clone())
    }
  }
  const rails = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.035, 0.035, 1, 6), railMaterial, railMatrices.length,
  )
  railMatrices.forEach((matrix, index) => rails.setMatrixAt(index, matrix))
  group.add(rails)

  // floodlight masts: a pole, and a bank of six lamps aimed back at the middle
  const mastBearings = [0.7, 2.8, 4.9]
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0xb7bcc1, roughness: 0.5, metalness: 0.5 })
  const lampMaterial = new THREE.MeshStandardMaterial({ color: 0xf4f1e2, roughness: 0.35, metalness: 0.1 })
  const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.14, 5.2, 6), poleMaterial, mastBearings.length)
  const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.2, 0.62), poleMaterial, mastBearings.length)
  const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.26, 0.46), lampMaterial, mastBearings.length * 6)
  let lamp = 0
  mastBearings.forEach((bearing, index) => {
    poles.setMatrixAt(index, stand(bearing, 10.5, 5.2))
    padFrame(planet, radiusOf, site, bearing, 10.5, centre, here, up, outward)
    scratchRight.crossVectors(up, outward).normalize()
    dummy.position.copy(here).addScaledVector(up, 5.28)
    aim(dummy, up, outward)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    heads.setMatrixAt(index, dummy.matrix)
    for (let i = 0; i < 6; i++) {
      dummy.position.copy(here)
        .addScaledVector(scratchRight, ((i % 3) - 1) * 0.44)
        .addScaledVector(up, 5.28 + (i < 3 ? -0.13 : 0.13))
        .addScaledVector(outward, -0.4)
      dummy.updateMatrix()
      lamps.setMatrixAt(lamp++, dummy.matrix)
    }
  })
  group.add(poles)
  group.add(heads)
  group.add(lamps)

  // the ground equipment: cabinets facing the pad, and a tank
  const cabinetBearings = [0.25, 1.85, 3.4, 5.2]
  const cabinetMaterial = new THREE.MeshStandardMaterial({ color: 0xd2d4cf, roughness: 0.6, metalness: 0.15 })
  const lidMaterial = new THREE.MeshStandardMaterial({ color: 0x9a9d99, roughness: 0.7, metalness: 0.1 })
  const cabinets = new THREE.InstancedMesh(new THREE.BoxGeometry(1.25, 1.4, 0.78), cabinetMaterial, cabinetBearings.length)
  const lids = new THREE.InstancedMesh(new THREE.BoxGeometry(1.32, 0.12, 0.85), lidMaterial, cabinetBearings.length)
  cabinetBearings.forEach((bearing, index) => {
    cabinets.setMatrixAt(index, stand(bearing, 8.5, 1.4))
    lids.setMatrixAt(index, stand(bearing, 8.5, 1.52))
  })
  group.add(cabinets)
  group.add(lids)

  const tankMaterial = new THREE.MeshStandardMaterial({ color: 0xeceae2, roughness: 0.55, metalness: 0.1 })
  padFrame(planet, radiusOf, site, 2.35, 7.4, centre, here, up, outward)
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.5, 14), tankMaterial)
  tank.position.copy(here).addScaledVector(up, 0.75)
  aim(tank, up, outward)
  group.add(tank)
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.28, 10), lidMaterial)
  cap.position.copy(here).addScaledVector(up, 1.62)
  aim(cap, up, outward)
  group.add(cap)

  group.traverse(object => {
    const instanced = object as THREE.InstancedMesh
    if (instanced.isInstancedMesh) instanced.instanceMatrix.needsUpdate = true
  })
  return group
}
