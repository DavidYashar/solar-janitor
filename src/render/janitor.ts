import * as THREE from 'three'

/**
 * The janitor.
 *
 * He is built as a skeleton rather than a pile of solids, because a walk needs
 * somewhere for a leg to hinge and the old figure had none: every part sat at a
 * fixed offset in the player's own frame, so the only thing that could move was
 * all of him. Now the legs hang off hip groups with knees under them, the arms
 * off shoulders, and the torso is a group of its own, which is what lets him
 * stride, swing his arms and bob as he goes.
 *
 * The detail is real but the draw calls are not: forty small solids would be
 * forty draw calls and forty more into the shadow pass, for a figure two metres
 * tall. So each limb's pieces are baked into one buffer per colour before they
 * are ever added to the scene - geometry copied, placed and concatenated. Only
 * position and normal survive the bake, because none of these materials has a
 * map and there is nothing for a UV to do.
 *
 * What he wears depends on where he is. Earth has an atmosphere, so on Earth he
 * is a man in a jumpsuit with a cap on; the Moon and Mars have none, so there the
 * cap is a helmet and the helmet is the only thing between him and nothing.
 */

// ---------------------------------------------------------------- the palette

const SUIT = 0xf2913c
const DARK = 0x3c4456
const YELLOW = 0xf7d64c
const METAL = 0xbdc6d0
const SKIN = 0xe7b189
const HAIR = 0x4b382b
const GLASS = 0xcdefff

/** where his waist is: the torso, the arms and the head all hang off this */
const WAIST = 1.02
/** and his hips, placed so the soles of his boots land exactly on the ground */
const HIP = 1.04

export interface JanitorRig {
  group: THREE.Group
  torso: THREE.Group
  head: THREE.Group
  /** the cap: Earth only */
  cap: THREE.Group
  /** the helmet: the worlds with no air */
  helmet: THREE.Group
  hip: THREE.Group[]
  knee: THREE.Group[]
  shoulder: THREE.Group[]
  /** stride phase in radians, carried across frames */
  phase: number
  /** how far the stride has wound up, 0..1, so it eases in and out of a stop */
  gait: number
}

// ------------------------------------------------------------------- baking

interface Piece {
  geometry: THREE.BufferGeometry
  at?: [number, number, number]
  rotate?: [number, number, number]
  scale?: [number, number, number]
}

const bakeMatrix = new THREE.Matrix4()
const bakePosition = new THREE.Vector3()
const bakeQuaternion = new THREE.Quaternion()
const bakeEuler = new THREE.Euler()
const bakeScale = new THREE.Vector3()
const bakeVertex = new THREE.Vector3()
const bakeNormal = new THREE.Vector3()
const bakeNormalMatrix = new THREE.Matrix3()

function bake(pieces: Piece[]): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  for (const piece of pieces) {
    const source = piece.geometry.index ? piece.geometry.toNonIndexed() : piece.geometry.clone()
    const at = piece.at ?? [0, 0, 0]
    const rotate = piece.rotate ?? [0, 0, 0]
    const scale = piece.scale ?? [1, 1, 1]
    bakePosition.set(at[0], at[1], at[2])
    bakeEuler.set(rotate[0], rotate[1], rotate[2])
    bakeQuaternion.setFromEuler(bakeEuler)
    bakeScale.set(scale[0], scale[1], scale[2])
    bakeMatrix.compose(bakePosition, bakeQuaternion, bakeScale)
    bakeNormalMatrix.getNormalMatrix(bakeMatrix)
    const position = source.attributes.position
    const normal = source.attributes.normal
    for (let i = 0; i < position.count; i++) {
      bakeVertex.fromBufferAttribute(position, i).applyMatrix4(bakeMatrix)
      positions.push(bakeVertex.x, bakeVertex.y, bakeVertex.z)
      bakeNormal.fromBufferAttribute(normal, i).applyMatrix3(bakeNormalMatrix).normalize()
      normals.push(bakeNormal.x, bakeNormal.y, bakeNormal.z)
    }
    source.dispose()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.computeBoundingSphere()
  return geometry
}

// ---------------------------------------------------------------- the pieces

function simple(color: number, roughness = 0.7, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true })
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d)
const ball = (r: number, seg = 10) => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 2))
const tube = (r: number, h: number, seg = 10) => new THREE.CylinderGeometry(r, r, h, seg)
const limb = (r: number, h: number) => new THREE.CapsuleGeometry(r, h, 3, 8)

/**
 * One leg, hinged at the hip and again at the knee.
 *
 * The foot is the part that has to be right, because it is the part that lands:
 * a boot, a sole proud of it at both ends, a toe cap and a heel so the thing has
 * a shape from the side, and a cuff where the trouser meets it.
 */
function buildLeg(side: number, materials: Record<string, THREE.Material>): { hip: THREE.Group; knee: THREE.Group } {
  const hip = new THREE.Group()
  hip.position.set(side * 0.19, HIP, 0)

  const suit = bake([
    { geometry: limb(0.155, 0.20), at: [0, -0.22, 0] },
  ])
  const panels = bake([
    { geometry: box(0.22, 0.18, 0.20), at: [side * 0.07, -0.24, 0.09] },
  ])
  const trim = bake([
    { geometry: ball(0.16), at: [0, 0, 0] },
    { geometry: box(0.25, 0.17, 0.27), at: [0, -0.47, 0.02] },
  ])
  hip.add(new THREE.Mesh(suit, materials.suit))
  hip.add(new THREE.Mesh(panels, materials.panel))
  hip.add(new THREE.Mesh(trim, materials.dark))

  const knee = new THREE.Group()
  knee.position.set(0, -0.49, 0)
  hip.add(knee)

  const shin = bake([
    { geometry: limb(0.135, 0.16), at: [0, -0.18, 0] },
    { geometry: box(0.20, 0.24, 0.13), at: [0, -0.16, 0.10] },
  ])
  const boot = bake([
    { geometry: box(0.28, 0.15, 0.30), at: [0, -0.35, 0.02] },
    { geometry: box(0.30, 0.19, 0.42), at: [0, -0.44, 0.07] },
  ])
  const bootTrim = bake([
    { geometry: box(0.33, 0.07, 0.46), at: [0, -0.515, 0.07] },
    { geometry: box(0.28, 0.12, 0.10), at: [0, -0.45, 0.27] },
    { geometry: box(0.25, 0.15, 0.09), at: [0, -0.46, -0.13] },
  ])
  knee.add(new THREE.Mesh(shin, materials.suit))
  knee.add(new THREE.Mesh(boot, materials.yellow))
  knee.add(new THREE.Mesh(bootTrim, materials.dark))

  return { hip, knee }
}

/** One arm, hinged at the shoulder. No elbow: at this size a straight arm reads fine. */
function buildArm(side: number, materials: Record<string, THREE.Material>): THREE.Group {
  const shoulder = new THREE.Group()
  // local to the torso, whose own origin is the waist
  shoulder.position.set(side * 0.40, 1.45 - WAIST, 0)

  const sleeve = bake([
    { geometry: limb(0.135, 0.18), at: [0, -0.20, 0] },
    { geometry: limb(0.12, 0.14), at: [0, -0.46, 0] },
  ])
  const pad = bake([
    { geometry: ball(0.15, 10), at: [side * 0.045, 0.02, 0], scale: [1.0, 0.85, 1.2] },
  ])
  const joint = bake([
    { geometry: ball(0.125, 8), at: [0, -0.35, 0] },
  ])
  const glove = bake([
    { geometry: tube(0.155, 0.10), at: [0, -0.60, 0] },
    { geometry: box(0.20, 0.20, 0.24), at: [0, -0.69, 0.02] },
    { geometry: box(0.07, 0.11, 0.08), at: [side * 0.12, -0.65, 0.07] },
  ])
  shoulder.add(new THREE.Mesh(sleeve, materials.suit))
  shoulder.add(new THREE.Mesh(pad, materials.panel))
  shoulder.add(new THREE.Mesh(joint, materials.dark))
  shoulder.add(new THREE.Mesh(glove, materials.yellow))
  return shoulder
}

/**
 * The body. Chest plate, belt with pouches, shoulder straps and the salvager's
 * pack on his back, which is the one part of him with a silhouette from behind.
 * The head is added by the caller, and the cap and the helmet are separate so
 * only one of them is ever in the scene.
 */
function buildTorso(materials: Record<string, THREE.Material>, rig: JanitorRig) {
  const torso = new THREE.Group()
  torso.position.set(0, WAIST, 0)
  rig.torso = torso

  const suit = bake([
    { geometry: box(0.50, 0.26, 0.35), at: [0, 0.08, 0] },
    { geometry: limb(0.25, 0.14), at: [0, 0.30, 0] },
  ])
  const plate = bake([
    { geometry: box(0.42, 0.30, 0.11), at: [0, 0.36, 0.21] },
    { geometry: box(0.30, 0.08, 0.10), at: [0, 0.20, 0.20] },
  ])
  const webbing = bake([
    { geometry: box(0.54, 0.11, 0.38), at: [0, 0.21, 0] },
    { geometry: box(0.12, 0.17, 0.11), at: [-0.21, 0.21, 0.19] },
    { geometry: box(0.12, 0.17, 0.11), at: [0.21, 0.21, 0.19] },
    { geometry: box(0.08, 0.36, 0.07), at: [-0.14, 0.36, 0.22], rotate: [0, 0, 0.06] },
    { geometry: box(0.08, 0.36, 0.07), at: [0.14, 0.36, 0.22], rotate: [0, 0, -0.06] },
    { geometry: box(0.46, 0.54, 0.26), at: [0, 0.36, -0.31] },
    { geometry: tube(0.17, 0.10), at: [0, 0.56, 0] },
    // the pack's top plate, kept dark: made of metal it is the brightest surface
    // on him and reads as a panel floating at his shoulder
    { geometry: box(0.42, 0.07, 0.24), at: [0, 0.62, -0.31] },
  ])
  const hardware = bake([
    { geometry: box(0.15, 0.11, 0.07), at: [0, 0.21, 0.20] },
    { geometry: tube(0.09, 0.38), at: [-0.13, 0.36, -0.47] },
    { geometry: tube(0.09, 0.38), at: [0.13, 0.36, -0.47] },
    { geometry: ball(0.09, 8), at: [-0.13, 0.55, -0.47] },
    { geometry: ball(0.09, 8), at: [0.13, 0.55, -0.47] },
    { geometry: tube(0.20, 0.06), at: [0, 0.60, 0] },
  ])
  const lamps = bake([
    { geometry: box(0.11, 0.09, 0.06), at: [-0.12, 0.45, 0.26] },
    { geometry: box(0.11, 0.09, 0.06), at: [0.12, 0.45, 0.26] },
  ])
  torso.add(new THREE.Mesh(suit, materials.suit))
  torso.add(new THREE.Mesh(plate, materials.panel))
  torso.add(new THREE.Mesh(webbing, materials.dark))
  torso.add(new THREE.Mesh(hardware, materials.metal))
  torso.add(new THREE.Mesh(lamps, materials.yellow))
  return torso
}

/** The head, the cap he wears where there is air, and the helmet where there is not. */
function buildHead(materials: Record<string, THREE.Material>, rig: JanitorRig) {
  const head = new THREE.Group()
  // sitting on the shoulders, not buried in them
  head.position.set(0, 0.64, 0)
  rig.head = head

  const face = bake([
    { geometry: tube(0.10, 0.12), at: [0, -0.02, 0] },
    { geometry: ball(0.21, 12), at: [0, 0.20, 0], scale: [0.98, 1.1, 1] },
  ])
  const features = bake([
    { geometry: box(0.28, 0.08, 0.09), at: [0, 0.24, 0.15] },
    { geometry: box(0.13, 0.05, 0.08), at: [0, 0.13, 0.17] },
  ])
  head.add(new THREE.Mesh(face, materials.skin))
  head.add(new THREE.Mesh(features, materials.dark))

  const cap = new THREE.Group()
  cap.position.set(0, 0.22, 0)
  cap.add(new THREE.Mesh(bake([
    { geometry: tube(0.215, 0.12), at: [0, 0.07, 0] },
    { geometry: ball(0.215, 12), at: [0, 0.12, 0], scale: [1, 0.6, 1] },
    { geometry: box(0.30, 0.05, 0.17), at: [0, 0.03, 0.19] },
  ]), materials.hair))
  rig.cap = cap

  const helmet = new THREE.Group()
  // centred on the head, not on the neck: a shell hung off the collar leaves the
  // top of his skull outside it
  helmet.position.set(0, 0.20, 0)
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.30, 18, 14), materials.glass)
  shell.position.set(0, 0, 0.02)
  helmet.add(shell)
  helmet.add(new THREE.Mesh(bake([
    { geometry: tube(0.20, 0.10), at: [0, -0.20, 0] },
    { geometry: tube(0.028, 0.30), at: [0.15, 0.22, -0.12], rotate: [0.3, 0, -0.18] },
  ]), materials.metal))
  helmet.add(new THREE.Mesh(bake([
    { geometry: box(0.10, 0.10, 0.07), at: [-0.25, 0.02, 0.11] },
    { geometry: box(0.09, 0.09, 0.06), at: [0.25, -0.02, 0.10] },
  ]), materials.yellow))
  rig.helmet = helmet

  return { head, cap, helmet }
}

// --------------------------------------------------------------- the walk

const SHOULDER_SLEW = 0.13
const STEP_PER_METRE = 2.1
const STRIDE = 0.72
const ARM_SWING = 0.5

/**
 * The walk.
 *
 * The stride is wound off distance travelled rather than off time, so his feet
 * match the ground at any speed - including the sprint, which is fast enough that
 * a rate-in-seconds walk would have him skating. It eases in and out of a stop
 * through `gait`, because a figure that snaps from a full stride to standing
 * still is worse than one that never walked at all.
 */
export function poseJanitor(rig: JanitorRig, speed: number, airborne: boolean, dt: number, elapsed: number) {
  const moving = airborne ? 0 : Math.min(1, speed / 3.5)
  rig.gait += (moving - rig.gait) * Math.min(1, 7 * dt)
  const gait = rig.gait
  rig.phase += speed * STEP_PER_METRE * dt
  if (rig.phase > Math.PI * 200) rig.phase -= Math.PI * 200

  const swing = Math.sin(rig.phase)
  const lift = Math.cos(rig.phase)
  const tuck = airborne ? 1 : 0

  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1
    const legPhase = side > 0 ? swing : -swing
    const legLift = side > 0 ? lift : -lift
    // hip: forward on the swing, back on the push
    const hip = -legPhase * STRIDE * gait
    // knee: bends as the foot leaves the ground, straightens as it lands
    const knee = Math.max(0, legLift) * 0.85 * gait
    rig.hip[i].rotation.x = hip * (1 - tuck) + tuck * -0.55
    rig.knee[i].rotation.x = knee * (1 - tuck) + tuck * 1.0
    rig.hip[i].rotation.z = side * 0.04

    // arms counter-swing, and lift a little when he is off the ground
    const armPhase = side > 0 ? -swing : swing
    rig.shoulder[i].rotation.x = armPhase * ARM_SWING * gait * (1 - tuck) + tuck * -0.9
    rig.shoulder[i].rotation.z = side * (SHOULDER_SLEW + tuck * 0.25)
    rig.shoulder[i].rotation.y = side * armPhase * 0.12 * gait
  }

  // the body carries the weight: a bob on every step, a lean with speed, and a
  // slow breath when he is standing still
  const bob = Math.abs(swing) * 0.035 * gait + Math.sin(elapsed * 1.5) * 0.008 * (1 - gait)
  rig.torso.position.y = WAIST + bob
  rig.torso.rotation.x = 0.09 * gait * (speed / 7.4) + tuck * 0.12
  rig.torso.rotation.z = Math.sin(rig.phase) * 0.025 * gait
  rig.torso.rotation.y = -Math.sin(rig.phase) * 0.06 * gait
  // the head stays level while the body rolls under it
  rig.head.rotation.z = -rig.torso.rotation.z * 0.6
  rig.head.rotation.x = -rig.torso.rotation.x * 0.5
}

// --------------------------------------------------------------- the build

export function buildJanitor(): JanitorRig {
  const materials: Record<string, THREE.Material> = {
    suit: simple(SUIT, 0.65),
    panel: simple(0xd97a28, 0.7),
    dark: simple(DARK, 0.7),
    yellow: simple(YELLOW, 0.6),
    metal: simple(METAL, 0.4, 0.5),
    skin: simple(SKIN, 0.8),
    hair: simple(HAIR, 0.85),
    glass: new THREE.MeshStandardMaterial({
      color: GLASS, transparent: true, opacity: 0.34, roughness: 0.08, metalness: 0.1, flatShading: true,
    }),
  }

  const group = new THREE.Group()
  const rig: JanitorRig = {
    group,
    torso: group,
    head: group,
    cap: group,
    helmet: group,
    hip: [],
    knee: [],
    shoulder: [],
    phase: 0,
    gait: 0,
  }

  const torso = buildTorso(materials, rig)
  group.add(torso)

  const head = buildHead(materials, rig)
  torso.add(head.head)
  head.head.add(head.cap)
  head.head.add(head.helmet)

  for (const side of [1, -1]) {
    const leg = buildLeg(side, materials)
    group.add(leg.hip)
    rig.hip.push(leg.hip)
    rig.knee.push(leg.knee)

    const shoulder = buildArm(side, materials)
    torso.add(shoulder)
    rig.shoulder.push(shoulder)
  }

  // the mop rides on his back as one piece, so the head stays on the handle
  const mop = new THREE.Group()
  mop.position.set(0.28, 0.46, -0.48)
  mop.rotation.set(0.34, 0, -0.2)
  mop.add(new THREE.Mesh(bake([
    { geometry: tube(0.045, 1.55), at: [0, 0, 0] },
    { geometry: tube(0.058, 0.16), at: [0, 0.58, 0] },
  ]), materials.yellow))
  mop.add(new THREE.Mesh(bake([
    { geometry: box(0.42, 0.16, 0.24), at: [0, -0.80, 0] },
    { geometry: box(0.44, 0.05, 0.26), at: [0, -0.89, 0] },
  ]), materials.metal))
  torso.add(mop)

  group.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.receiveShadow = true
    mesh.castShadow = !(mesh.material as THREE.Material).transparent
  })

  return rig
}
