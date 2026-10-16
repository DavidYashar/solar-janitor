/**
 * The Moon's landscape, in the design's own metres.
 *
 * Ported from the reference build, which laid it out as real ground a metre to
 * the unit: a rolling regolith plain carrying a saturated field of craters in
 * three size classes, a winding excavated trench with a berm along each lip, two
 * mounds flanking a boulder corridor, hills that close the horizon and a rim
 * that stands behind them. None of that survives being squeezed onto a small
 * ball - a trench is only a hazard while it is still five metres deep - so the
 * Moon is a big world now, like Earth, and this field is laid on it at 1:1.
 *
 * The noise here is the field's own, deliberately: it is what the craters were
 * placed against and what the horizon was shaped with, and swapping in the
 * engine's noise would quietly re-roll a landscape somebody already approved.
 */
import { PAD_APRON } from './config.ts'
import { fromPad, padOffset, type PadOffset } from './earthfield.ts'
import { mulberry32 } from './noise.ts'

// ------------------------------------------------------------------- noise

function hash2(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) >>> 0
  n = ((n ^ (n >> 13)) * 1274126177) >>> 0
  return ((n ^ (n >> 16)) >>> 0) / 4294967295
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function fbm(x: number, y: number, octaves: number): number {
  let value = 0
  let amplitude = 1
  let frequency = 1
  let total = 0
  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise(x * frequency, y * frequency)
    total += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return value / total
}

// ----------------------------------------------------------------- craters

/** the ground the design was laid out over: beyond this it is horizon */
export const MOON_PLAYFIELD_RADIUS = 380

interface Crater {
  x: number
  z: number
  r: number
  depth: number
  rim: number
  /**
   * Whether this one is a fresh scar. Nothing reads it yet, but the roll is kept
   * because it draws from the same generator as the craters after it: dropping it
   * re-rolls every crater in the field.
   */
  fresh: boolean
  /** how far its influence reaches, allowing for the wobble below */
  reach: number
  /** the axis it is longer along, and how much longer */
  aspect: number
  cos: number
  sin: number
  /** three harmonics of rim wobble, so no two craters are the same shape */
  lobeA: number
  phaseA: number
  lobeB: number
  phaseB: number
  lobeC: number
  phaseC: number
}

/**
 * A stable scatter of numbers from one integer.
 *
 * The crater shapes come from here rather than from the generator that placed
 * the craters, and that is deliberate: drawing them from the same stream would
 * shift every crater that came after, and the point of this field is that it is
 * the one the reference laid out.
 */
function shapeHash(index: number, salt: number): number {
  let h = Math.imul(index ^ salt, 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 15), 3266489917) >>> 0
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}

const TAU = Math.PI * 2

/**
 * Craters upon craters - a few large fresh basins, a population of medium ones
 * that just touch, and a saturated field of small ones that overlap freely,
 * because that is what an old surface actually looks like. Overlap is rejected
 * for the two larger classes so the basins stay readable, and allowed for the
 * small ones so they can mottle.
 */
const CRATERS: Crater[] = []
{
  const rand = mulberry32(19723508)
  const R = MOON_PLAYFIELD_RADIUS + 300
  const spawn = (count: number, rMin: number, rMax: number, dRatio: number, rejectOverlap: boolean) => {
    for (let i = 0; i < count; i++) {
      let x = 0
      let z = 0
      let r = 0
      let ok = false
      for (let tries = 0; tries < 24 && !ok; tries++) {
        const a = rand() * Math.PI * 2
        const rr = Math.sqrt(rand()) * R
        x = Math.cos(a) * rr
        z = Math.sin(a) * rr
        r = rMin + rand() * (rMax - rMin)
        ok = !rejectOverlap || !CRATERS.some(c => Math.hypot(c.x - x, c.z - z) < (c.r + r) * 0.62)
      }
      if (!ok) continue
      CRATERS.push({
        x, z, r,
        depth: r * dRatio * (0.85 + rand() * 0.3),
        rim: r * 0.055 * (0.7 + rand() * 0.6),
        fresh: rand() < 0.3,
        reach: 0, aspect: 1, cos: 1, sin: 0,
        lobeA: 0, phaseA: 0, lobeB: 0, phaseB: 0, lobeC: 0, phaseC: 0,
      })
    }
  }
  // the reference's own field, in its own order, so these land exactly where they
  // were laid out
  spawn(14, 40, 85, 0.24, true)
  spawn(110, 14, 40, 0.23, true)
  spawn(550, 3, 14, 0.2, false)
  // and then more of the same, drawn after it: a second wave between the basins,
  // a filling of small ones, and a dusting of shallow pits. Everything above is
  // untouched by these, because the generator has already dealt with it.
  spawn(90, 22, 46, 0.22, true)
  spawn(430, 6, 16, 0.2, false)
  spawn(1500, 1.1, 3.6, 0.32, false)
}

/**
 * Give every crater its own shape. A field of concentric circles reads as a
 * pattern however random the positions are - what makes a crater field look real
 * is that a crater is an ellipse at some angle, with a rim that wanders, and no
 * two are deformed the same way.
 *
 * Small craters are the most irregular: a forty-metre basin slumps into round
 * under its own weight, where a two-metre pit is just a hole something made.
 */
for (let i = 0; i < CRATERS.length; i++) {
  const c = CRATERS[i]
  const turn = shapeHash(i, 0x9e3779b9) * TAU
  c.aspect = 0.74 + shapeHash(i, 0x51ed270b) * 0.52
  c.cos = Math.cos(turn)
  c.sin = Math.sin(turn)
  const rough = Math.max(0.12, Math.min(1, 1.35 - c.r / 34))
  c.lobeA = (0.02 + shapeHash(i, 0x27d4eb2f) * 0.05) * rough
  c.phaseA = shapeHash(i, 0x165667b1) * TAU
  c.lobeB = (0.015 + shapeHash(i, 0x85ebca6b) * 0.04) * rough
  c.phaseB = shapeHash(i, 0xc2b2ae35) * TAU
  c.lobeC = (0.01 + shapeHash(i, 0x7feb352d) * 0.03) * rough
  c.phaseC = shapeHash(i, 0x846ca68b) * TAU
  c.reach = c.r * 1.9
}

/**
 * A spatial index, because a height query has to cost one cell and not six
 * hundred craters: the terrain asks this question a third of a million times
 * while it builds.
 */
const CRATER_CELL = 120
const CRATER_BIAS = 512
const CRATER_GRID = new Map<number, number[]>()
for (let ci = 0; ci < CRATERS.length; ci++) {
  const c = CRATERS[ci]
  const reach = c.r * 1.35
  const i0 = Math.floor((c.x - reach) / CRATER_CELL)
  const i1 = Math.floor((c.x + reach) / CRATER_CELL)
  const j0 = Math.floor((c.z - reach) / CRATER_CELL)
  const j1 = Math.floor((c.z + reach) / CRATER_CELL)
  for (let ix = i0; ix <= i1; ix++) {
    for (let iz = j0; iz <= j1; iz++) {
      const key = (ix + CRATER_BIAS) * 2048 + (iz + CRATER_BIAS)
      let arr = CRATER_GRID.get(key)
      if (!arr) { arr = []; CRATER_GRID.set(key, arr) }
      arr.push(ci)
    }
  }
}

function craterCell(x: number, z: number): number[] | undefined {
  return CRATER_GRID.get(
    (Math.floor(x / CRATER_CELL) + CRATER_BIAS) * 2048
    + (Math.floor(z / CRATER_CELL) + CRATER_BIAS),
  )
}

function craterDelta(x: number, z: number, c: Crater): number {
  const dx = x - c.x
  const dz = z - c.z
  if (dx * dx + dz * dz > c.reach * c.reach) return 0

  // into the crater's own frame: one axis longer than the other, at an angle,
  // and a rim radius that wanders with the bearing
  const along = dx * c.cos + dz * c.sin
  const across = -dx * c.sin + dz * c.cos
  const bearing = Math.atan2(across, along)
  const wobble = 1
    + c.lobeA * Math.sin(bearing * 2 + c.phaseA)
    + c.lobeB * Math.sin(bearing * 3 + c.phaseB)
    + c.lobeC * Math.sin(bearing * 5 + c.phaseC)
  const t = Math.hypot(along / c.aspect, across) / (c.r * wobble)

  // a raised lip just outside the bowl edge
  const rimT = (t - 1.02) / 0.3
  let h = c.rim * Math.exp(-rimT * rimT)
  // the bowl
  if (t < 1) h -= c.depth * (1 - t * t)
  // and a rebound peak in the middle of the big ones
  if (c.r > 45 && t < 0.38) h += c.depth * 0.5 * (1 - t / 0.38)
  return h
}

/** net crater displacement at a point, which is also how the ground is coloured */
export function moonCraterFieldAt(x: number, z: number): number {
  const arr = craterCell(x, z)
  if (!arr) return 0
  let h = 0
  for (let i = 0; i < arr.length; i++) h += craterDelta(x, z, CRATERS[arr[i]])
  return h
}

/**
 * The field's own noise, for the things that are coloured rather than shaped:
 * the ground's mottling has to come off the same generator the landscape was
 * drawn against, or the patchwork stops lining up with the ground it patches.
 */
export function moonFieldNoise(x: number, y: number): number {
  return valueNoise(x, y)
}

// ------------------------------------------------------------------ trench

const TRENCH_CONTROL = [
  [-480, -120], [-330, -80], [-190, -30], [-60, 20],
  [80, 60], [220, 120], [360, 210], [480, 330],
]

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (
    (2 * p1)
    + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  )
}

const TRENCH_SAMPLES = (() => {
  const pts = TRENCH_CONTROL.map(p => ({ x: p[0], z: p[1] }))
  const n = 150
  const segCount = pts.length - 1
  const samples: { x: number; z: number }[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * segCount
    const seg = Math.min(Math.floor(t), segCount - 1)
    const local = t - seg
    const p0 = pts[Math.max(seg - 1, 0)]
    const p1 = pts[seg]
    const p2 = pts[Math.min(seg + 1, segCount)]
    const p3 = pts[Math.min(seg + 2, segCount)]
    samples.push({
      x: catmull(p0.x, p1.x, p2.x, p3.x, local),
      z: catmull(p0.z, p1.z, p2.z, p3.z, local),
    })
  }
  return samples
})()

/** half-width of the cut */
export const MOON_TRENCH_WIDTH = 9
export const MOON_TRENCH_DEPTH = 5.5

/** distance to the trench centreline: the cut is a hazard, so props ask this */
export function moonTrenchDistance(x: number, z: number): number {
  let minDist = Infinity
  for (let i = 0; i < TRENCH_SAMPLES.length - 1; i++) {
    const a = TRENCH_SAMPLES[i]
    const b = TRENCH_SAMPLES[i + 1]
    const abx = b.x - a.x
    const abz = b.z - a.z
    const len2 = abx * abx + abz * abz
    let t = ((x - a.x) * abx + (z - a.z) * abz) / len2
    t = Math.max(0, Math.min(1, t))
    const dx = x - (a.x + abx * t)
    const dz = z - (a.z + abz * t)
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < minDist) minDist = d
  }
  return minDist
}

function trenchDelta(x: number, z: number): number {
  const t = moonTrenchDistance(x, z) / MOON_TRENCH_WIDTH
  if (t > 2.8) return 0
  let d = 0
  if (t < 1) {
    // a flat-ish floor, churned
    d -= MOON_TRENCH_DEPTH * (1 - 0.22 * t * t)
    d += (fbm(x * 0.4 + 1.7, z * 0.4 + 4.9, 2) - 0.5) * 1.1
  } else if (t < 1.45) {
    // the wall, which is steep and not smooth
    const wall = 1 - (t - 1) / 0.45
    d -= MOON_TRENCH_DEPTH * wall * wall
    d += (fbm(x * 0.3, z * 0.3, 2) - 0.5) * 0.8 * wall
  }
  // spoil heaps along each lip, where the digging went
  const bermT = (t - 1.8) / 0.5
  d += 1.7 * Math.exp(-bermT * bermT) * (0.55 + 0.9 * valueNoise(x * 0.09 + 3.3, z * 0.09 + 6.6))
  // and it fades out past the playfield so it melts into the hills
  const dc = Math.hypot(x, z)
  const fade = Math.max(0, Math.min(1, (560 - dc) / 120))
  return d * fade
}

// --------------------------------------------------------------- landmarks

/** two mounds flanking a corridor, which is where the boulders collect */
const MOUND_A = { x: -175, z: 255, r: 95, h: 20 }
const MOUND_B = { x: 30, z: 335, r: 80, h: 15 }
const BOULDER_VALLEY = { x: -72, z: 295, r: 165 }

export function moonBoulderValley(): { x: number; z: number; r: number } {
  return BOULDER_VALLEY
}

function mound(x: number, z: number, cx: number, cz: number, r: number, h: number): number {
  const dx = x - cx
  const dz = z - cz
  const t = (dx * dx + dz * dz) / (r * r)
  if (t > 4) return 0
  return h * Math.exp(-t * 2.2)
}

// ------------------------------------------------------------ height field

/** the excavated trench, for the renderer's ribbon of churned ground */
export function moonTrench(): { samples: { x: number; z: number }[]; width: number; depth: number } {
  return { samples: TRENCH_SAMPLES, width: MOON_TRENCH_WIDTH, depth: MOON_TRENCH_DEPTH }
}

export function moonFieldHeight(x: number, z: number): number {
  // rolling regolith, low and gentle so the craters are what you read
  let h = (fbm(x * 0.0042 + 11.3, z * 0.0042 + 7.7, 4) - 0.5) * 5.5
  h += (fbm(x * 0.022 + 3.1, z * 0.022 + 5.9, 3) - 0.5) * 1.1

  h += mound(x, z, MOUND_A.x, MOUND_A.z, MOUND_A.r, MOUND_A.h)
  h += mound(x, z, MOUND_B.x, MOUND_B.z, MOUND_B.r, MOUND_B.h)

  // the horizon closes in beyond the playfield. On a plane this hid the map
  // edge; on a ball it is simply the hills that ring the site, which is a
  // better reason to have them
  const dc = Math.hypot(x, z)
  if (dc > 430) {
    const t = Math.min((dc - 430) / 190, 1)
    const hills = fbm(x * 0.0026 + 2.2, z * 0.0026 + 8.8, 4)
    h += hills * hills * 34 * t * t
    h += (fbm(x * 0.008 + 9.1, z * 0.008 + 1.3, 3) - 0.5) * 16 * t * t
  }
  if (dc > 580) {
    const t = Math.min((dc - 580) / 120, 1)
    const rv = fbm(x * 0.004 + 1.4, z * 0.004 + 9.2, 3)
    h += t * t * (50 + rv * 100)
  }

  const arr = craterCell(x, z)
  if (arr) {
    for (let i = 0; i < arr.length; i++) h += craterDelta(x, z, CRATERS[arr[i]])
  }

  // the cut is carved last, through everything
  if (x > -540 && x < 540 && z > -180 && z < 400) h += trenchDelta(x, z)

  return h
}

// -------------------------------------------------------------------- pad

/**
 * Where the tug comes down. Chosen by measuring the ground rather than by eye:
 * the apron rolls 2.4 m over thirty metres, which is gentle enough to level,
 * there is no crater bowl under it, it stands fifty metres off the trench lip -
 * close enough that the cut is the first thing you see and far enough that the
 * apron does not spill into it - and the survey gear the last crew left behind
 * is a hundred metres away, which makes it a landmark rather than an obstacle.
 */
export const MOON_PAD_ORIGIN = { x: -134, z: -62 }

/**
 * A wide apron, because this ground is cratered and the pad has to be flat
 * enough to set a lander on without one leg in a bowl. The blend reaches far
 * enough to flatten most of a small crater rather than trying to sit inside one.
 */
const MOON_PAD = PAD_APRON

const scratch: PadOffset = { arc: 0, bearing: 0, north: 0, east: 0 }

/** the field at a point on the sphere, in the design's own frame */
export function moonFieldAt(
  anchorLat: number, anchorLon: number, lat: number, lon: number, radius: number,
): number {
  const offset = padOffset(anchorLat, anchorLon, lat, lon, radius, scratch)
  return moonFieldHeight(offset.east + MOON_PAD_ORIGIN.x, offset.north + MOON_PAD_ORIGIN.z)
}

/** where a point on the sphere lands in the design's own frame */
export function moonDesignPoint(
  anchorLat: number, anchorLon: number, lat: number, lon: number, radius: number, into: { x: number; z: number },
): { x: number; z: number } {
  const offset = padOffset(anchorLat, anchorLon, lat, lon, radius, scratch)
  into.x = offset.east + MOON_PAD_ORIGIN.x
  into.z = offset.north + MOON_PAD_ORIGIN.z
  return into
}

/** and the other way: a design point back onto the sphere */
export function moonSpherePoint(
  anchorLat: number, anchorLon: number, x: number, z: number, radius: number,
  into: { lat: number; lon: number },
): { lat: number; lon: number } {
  const point = fromPad(anchorLat, anchorLon, z - MOON_PAD_ORIGIN.z, x - MOON_PAD_ORIGIN.x, radius)
  into.lat = point.lat
  into.lon = point.lon
  return into
}

/** the height at the middle of the apron, which the apron is blended toward */
export function moonPadCentre(anchorLat: number, anchorLon: number, radius: number): number {
  return moonFieldAt(anchorLat, anchorLon, anchorLat, anchorLon, radius)
}

export function flattenMoonPad(
  anchorLat: number, anchorLon: number, lat: number, lon: number, radius: number,
  height: number, centreHeight: number,
): number {
  const offset = padOffset(anchorLat, anchorLon, lat, lon, radius, scratch)
  if (offset.arc >= MOON_PAD.blend) return height
  const blend = offset.arc <= MOON_PAD.flat
    ? 0
    : (offset.arc - MOON_PAD.flat) / (MOON_PAD.blend - MOON_PAD.flat)
  const smooth = blend * blend * (3 - 2 * blend)
  return centreHeight * (1 - smooth) + height * smooth
}
