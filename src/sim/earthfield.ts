/**
 * Earth: the karst valley, as a landing site.
 *
 * The design is the reference build's own - a flat paddy floor with a meandering
 * river, ten large faceted peaks, and a layered range closing the far end - and
 * it arrives at its own size rather than ours. It was drawn on a 1300 m plane in
 * real metres, with trees nine to twenty-four metres and turbines a hundred and
 * fifty, and it only works at that size: `SURFACE_RADIUS` for this world is set
 * by the distance at which those peaks clear the curve of the ball (see config).
 *
 * Three things had to change on the way in.
 *
 * It is played on a ball, not a plane. Every point is placed by its great-circle
 * arc and bearing from the landing pad - the same frame the Janitor walks in -
 * and the pair is then read as the design's own (east, north). That keeps the
 * valley's axes straight near the pad, which is the only part anyone stands on,
 * and it is well behaved at the poles, where a naive longitude difference is not.
 *
 * The river query had to be indexed. Finding the nearest point on the channel is
 * a walk over 240 segments, and the terrain mesh asks thirty-two thousand times;
 * but the meander is a function of z - its control points are evenly spaced, so
 * the spline is linear in z - which makes the search a lookup and a short walk
 * either side.
 *
 * And the channel floor follows the valley instead of sitting at a constant
 * height. In the reference the river bed is a fixed -5 m while the floor around
 * it rolls ±4, so the river is shoulder-high in one place and a gorge in the
 * next. Here the bed is the ground's own height at that point on the meander,
 * less a depth you can wade - so the river always sits in its banks.
 */

import { PAD_APRON } from './config.ts'
import { fbm, ridged, valueNoise } from './noise.ts'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** how high the janitor's eye rides - the skyline and the river both read from it */
const EYE_HEIGHT = 2

/** the valley's own seed: the mountains and the meander are the same every run */
const SEED = 0x1f2e3d

// ------------------------------------------------------------ frame

export interface PadOffset {
  /** great-circle distance from the pad, metres */
  arc: number
  /** radians clockwise from local north */
  bearing: number
  north: number
  east: number
}

/**
 * Where a point lies relative to the landing pad, in metres.
 *
 * Azimuthal equidistant, computed on the sphere rather than by differencing
 * latitude and longitude: near the poles a longitude difference collapses to
 * nothing while an arc does not, and the poles are inside this valley - it
 * spans sixty degrees of it either way.
 */
export function padOffset(
  anchorLat: number, anchorLon: number, lat: number, lon: number, radius: number, into: PadOffset,
): PadOffset {
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const sinAnchor = Math.sin(anchorLat)
  const cosAnchor = Math.cos(anchorLat)
  const dLon = ((lon - anchorLon + Math.PI * 3) % (Math.PI * 2)) - Math.PI
  const cosArc = clamp(sinAnchor * sinLat + cosAnchor * cosLat * Math.cos(dLon), -1, 1)
  const arc = Math.acos(cosArc) * radius
  const east = cosLat * Math.sin(dLon)
  const north = cosAnchor * sinLat - sinAnchor * cosLat * Math.cos(dLon)
  const bearing = arc > 1e-6 ? Math.atan2(east, north) : 0
  into.arc = arc
  into.bearing = bearing
  into.north = arc * Math.cos(bearing)
  into.east = arc * Math.sin(bearing)
  return into
}

/** The point `north`/`east` metres from the landing pad, on a ball of `radius`. */
export function fromPad(
  anchorLat: number, anchorLon: number, north: number, east: number, radius: number,
): { lat: number; lon: number } {
  const arc = Math.hypot(north, east)
  if (arc < 1e-6) return { lat: anchorLat, lon: anchorLon }
  const bearing = Math.atan2(east, north)
  const delta = arc / radius
  const sinLat = Math.sin(anchorLat) * Math.cos(delta) + Math.cos(anchorLat) * Math.sin(delta) * Math.cos(bearing)
  const lat = Math.asin(clamp(sinLat, -1, 1))
  const lon = anchorLon + Math.atan2(
    Math.sin(bearing) * Math.sin(delta) * Math.cos(anchorLat),
    Math.cos(delta) - Math.sin(anchorLat) * sinLat,
  )
  return { lat, lon }
}

/** How high a point must stand to clear the curve of the ball and be visible. */
export function sightline(distance: number, radius: number): number {
  const horizon = Math.sqrt(2 * radius * EYE_HEIGHT)
  if (distance <= horizon) return 0
  const beyond = distance - horizon
  return (beyond * beyond) / (2 * radius)
}

// ------------------------------------------------------------ the meander

const RIVER_HALF_WIDTH = 11
/**
 * How deep the channel is cut below the valley floor, and how much water stands
 * in it.
 *
 * The first pass had a two-and-a-half metre trench spread over fifty metres of
 * ground, which is a one-in-twenty slope - invisible from two metres up, so the
 * water simply looked laid on the grass. A river that has cut into its flood
 * plain is a valley: five metres down, with the water chest deep in the bottom.
 */
const RIVER_DEPTH = 5
/** how deep the water stands above the bed - chest deep on the janitor */
const RIVER_WATER = 1.2
/**
 * The channel's cross-section: a flat bed out to `RIVER_BED` widths, then the
 * bank climbing back to the valley floor over `RIVER_BANK` more. A bank sharper
 * than the distance between two terrain vertices lands between them and comes
 * back as a sawtooth, so the run is metres, not centimetres.
 */
const RIVER_BED = 0.45
const RIVER_BANK = 1.5
const RIVER_REACH = 2.1

export interface RiverSample {  x: number
  z: number
  width: number
  /** >0 turning left, <0 turning right; decides gravel bar from cut bank */
  curvature: number
  /** the ground's own height here, less the depth - the channel floor */
  bed: number
  /** where the water surface sits: the bed plus a depth you can wade */
  water: number
}

/** Their meander: three incommensurate waves plus noise, so it never repeats. */
function riverControl(): { x: number; z: number }[] {
  const points: { x: number; z: number }[] = []
  for (let z = -645; z <= 645; z += 26) {
    const s = z + 645
    const x = 46 * Math.sin(s * 0.0081)
      + 22 * Math.sin(s * 0.0187 + 2.3)
      + 10 * Math.sin(s * 0.0431 + 5.1)
      + (fbm(0.5, s * 0.011 + 7.0, 3, SEED ^ 0x5bf03635) - 0.5) * 46
    points.push({ x, z })
  }
  return points
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * ((2 * p1) + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

const RIVER_COUNT = 240
const RIVER_SAMPLES = sampleMeander()

/** z runs linearly with the sample index, which is what makes the lookup possible. */
const RIVER_Z_FROM = -645
const RIVER_Z_PER_SAMPLE = (function () {
  const last = RIVER_COUNT - 1
  const segments = riverControl().length - 1
  return (26 * segments) / last
})()

function sampleMeander(): RiverSample[] {
  const control = riverControl()
  const segments = control.length - 1
  const samples: RiverSample[] = []
  for (let i = 0; i < RIVER_COUNT; i++) {
    const t = (i / (RIVER_COUNT - 1)) * segments
    const seg = Math.min(Math.floor(t), segments - 1)
    const local = t - seg
    const p0 = control[Math.max(seg - 1, 0)]
    const p1 = control[seg]
    const p2 = control[Math.min(seg + 1, segments)]
    const p3 = control[Math.min(seg + 2, segments)]
    samples.push({
      x: catmull(p0.x, p1.x, p2.x, p3.x, local),
      z: catmull(p0.z, p1.z, p2.z, p3.z, local),
      width: RIVER_HALF_WIDTH * (0.55 + valueNoise(0, i * 0.42, SEED ^ 0x9e3779b9) * 0.95),
      curvature: 0,
      bed: 0,
      water: 0,
    })
  }
  for (let i = 1; i < samples.length - 1; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const c = samples[i + 1]
    samples[i].curvature = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x)
  }
  return samples
}

/** The river's water level where it crosses the pad's own radius, for the shader. */
export const RIVER = {
  halfWidth: RIVER_HALF_WIDTH,
  depth: RIVER_DEPTH,
  water: RIVER_WATER,
  reach: RIVER_REACH,
}

export function riverSamples(): RiverSample[] {
  return RIVER_SAMPLES
}

// ------------------------------------------------------------ the ground

/** The ten peaks, exactly as the reference places them. */
interface Peak { x: number; z: number; height: number; radius: number; ridges: number; seed: number }

const PEAKS: Peak[] = [
  { x: -480, z: -380, height: 330, radius: 340, ridges: 5, seed: 11 },
  { x: -560, z: 60, height: 290, radius: 310, ridges: 4, seed: 27 },
  { x: -460, z: 480, height: 310, radius: 320, ridges: 5, seed: 43 },
  { x: 500, z: -340, height: 320, radius: 330, ridges: 4, seed: 61 },
  { x: 560, z: 120, height: 280, radius: 300, ridges: 5, seed: 77 },
  { x: 470, z: 520, height: 260, radius: 290, ridges: 4, seed: 91 },
  { x: -300, z: -720, height: 300, radius: 300, ridges: 5, seed: 103 },
  { x: 320, z: -740, height: 280, radius: 290, ridges: 4, seed: 117 },
  { x: 60, z: 740, height: 290, radius: 290, ridges: 5, seed: 131 },
  { x: -280, z: 720, height: 260, radius: 280, ridges: 4, seed: 145 },
]

/** Where the layered range across the far end begins. */
const RANGE_START = 430

/**
 * The ground before the river is cut into it: rolling paddy floor, the ten
 * peaks, and the range beyond. Everything here is the reference's own maths.
 */
export function valleyFloor(x: number, z: number): number {
  let h = (fbm(x * 0.008, z * 0.008, 4, SEED) - 0.5) * 8
  h += (valueNoise(x * 0.1, z * 0.1, SEED ^ 0x2f1b3c) - 0.5) * 0.7

  for (const peak of PEAKS) {
    const dx = x - peak.x
    const dz = z - peak.z
    const d = Math.sqrt(dx * dx + dz * dz)
    const t = 1 - d / peak.radius
    if (t <= 0) continue
    let mass = peak.height * Math.pow(t, 1.35)
    const angle = Math.atan2(dz, dx)
    mass *= 1 + Math.cos(angle * peak.ridges + peak.seed) * 0.1
    mass *= 0.88 + ridged(x * 0.012 + peak.seed, z * 0.012 + peak.seed * 2.3, 4, SEED ^ 0x51ed270b) * 0.24
    h += mass
  }

  const beyond = -z - RANGE_START
  if (beyond > 0) {
    const falloff = Math.min(beyond / 260, 1)
    h += falloff * 130
    h += ridged(x * 0.006 + 3.3, z * 0.006 + 7.7, 5, SEED ^ 0x1d3c9a) * 55 * falloff
    h += (fbm(x * 0.003 + 15, z * 0.003 + 8, 3, SEED ^ 0x85ebca6b) - 0.5) * 50 * falloff
  }

  return h
}

/**
 * The rock step the river crosses on its way down the valley.
 *
 * A river does not descend evenly. Where it meets a band of harder rock it
 * holds level, then drops - and a drop you can walk up to is the loudest
 * landmark on a map this size. The step is spread over `FALL_RUN` so the water
 * ribbon has something to fall down rather than a cliff it teleports off.
 */
const FALL_Z = -180
const FALL_DROP = 6.5
const FALL_RUN = 30

/** how far the water has dropped by the time it reaches this far down the valley */
function fallDrop(z: number): number {
  const t = clamp((FALL_Z - z) / FALL_RUN, 0, 1)
  return FALL_DROP * t * t * (3 - 2 * t)
}

// the bed of the channel, filled in once the ground function exists
for (let i = 0; i < RIVER_SAMPLES.length; i++) {
  const s = RIVER_SAMPLES[i]
  // A pool on the outside of a bend and a riffle on the inside: the current is
  // thrown outward, scours the far bank and drops its gravel where it slackens.
  // Their build has one width and one depth for 1300 metres of river, which is
  // why it reads as a canal.
  const scour = clamp(Math.abs(s.curvature) / 25, 0, 1)
  s.width *= 1 + scour * 0.7
  const level = valleyFloor(s.x, s.z) - RIVER_DEPTH
  // The surface is what is fixed and the bed hangs off it, not the other way
  // round. Scouring the bed alone is what made a pool three metres deep while a
  // riffle was one - the water was drawn at a level that ignored the pool, so
  // standing anywhere in a bend put you over your head.
  s.water = level + RIVER_WATER - fallDrop(s.z)
  s.bed = s.water - (RIVER_WATER + scour * 0.35)
}

interface RiverHit {
  distance: number
  width: number
  bed: number
  index: number
  side: number
}

const hit: RiverHit = { distance: Infinity, width: RIVER_HALF_WIDTH, bed: 0, index: 0, side: 1 }

/**
 * The nearest point on the meander, found by indexing straight to the right
 * stretch of it rather than walking all 240 segments. `RIVER_WINDOW` has to
 * cover the channel's own reach, or a point near the edge of the carve would
 * miss the bank it belongs to.
 */
const RIVER_WINDOW = 16

function riverInfo(x: number, z: number): RiverHit {
  hit.distance = Infinity
  hit.width = RIVER_HALF_WIDTH
  hit.bed = 0
  hit.index = 0
  hit.side = 1

  const guess = Math.round((z - RIVER_Z_FROM) / RIVER_Z_PER_SAMPLE)
  const from = Math.max(0, guess - RIVER_WINDOW)
  const to = Math.min(RIVER_SAMPLES.length - 2, guess + RIVER_WINDOW)

  for (let i = from; i <= to; i++) {
    const a = RIVER_SAMPLES[i]
    const b = RIVER_SAMPLES[i + 1]
    const abx = b.x - a.x
    const abz = b.z - a.z
    const len2 = abx * abx + abz * abz
    let t = ((x - a.x) * abx + (z - a.z) * abz) / len2
    t = clamp(t, 0, 1)
    const cx = a.x + abx * t
    const cz = a.z + abz * t
    const dx = x - cx
    const dz = z - cz
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < hit.distance) {
      hit.distance = d
      hit.width = a.width + (b.width - a.width) * t
      hit.bed = a.bed + (b.bed - a.bed) * t
      hit.index = i
      hit.side = (abx * dz - abz * dx) >= 0 ? 1 : -1
    }
  }
  return hit
}

/** Distance from a design point to the meander, for keeping props off the water. */
export function riverDistance(x: number, z: number): number {
  return riverInfo(x, z).distance
}

/**
 * How far the water reaches either side of the meander at a design point: the
 * ribbon is drawn to 0.85 of the local half-width, and the local half-width
 * changes along the river, so a fixed keep-out distance is either too small at
 * the bends or needlessly wide everywhere else.
 */
export function riverHalfWidth(x: number, z: number): number {
  return riverInfo(x, z).width * 0.85
}

/**
 * The landed height at a design point: the valley floor with the river cut into
 * it. Inner bends get a gravel bar that rises slowly; outer bends get a cut bank
 * that rises fast, which is what a real meander does and what stops the channel
 * reading as a trench.
 */
function riverCut(x: number, z: number, floor: number): number {
  const info = riverInfo(x, z)
  const w = info.width * (1 + (valueNoise(x * 0.06 + 3.3, z * 0.06 + 8.7, SEED ^ 0x5bf03635) - 0.5) * 0.5)
  if (info.distance >= w * RIVER_REACH) return floor

  const t = info.distance / w
  let target: number
  if (t < RIVER_BED) {
    target = info.bed
  } else {
    const sample = RIVER_SAMPLES[info.index]
    const inner = info.side * sample.curvature > 0
    const u = Math.min((t - RIVER_BED) / RIVER_BANK, 1)
    target = info.bed + (floor - info.bed) * Math.pow(u, inner ? 1.7 : 1.05)
  }

  // the channel fades out only where it has climbed a mountain
  const carve = clamp((90 - floor) / 40, 0, 1)
  return floor + (target - floor) * carve
}

// ------------------------------------------------------------ the terraces

/** one paddy bench: a tread this deep, then a riser up to the next one */
const TERRACE_STEP = 1.45

/**
 * Paddy terraces on the flanks of the valley.
 *
 * The valley is a paddy floor, and terraces are what that landscape actually
 * looks like: flat benches cut into a slope with a low earth bund along each
 * edge, field after field stepping up toward the peaks. They are also the one
 * thing on this map that is *laid out* rather than scattered, which is what
 * stops a kilometre of ground being the same ground everywhere - the eye reads
 * a made thing and navigates by it.
 *
 * Two masks decide where they are, and both matter. They only make sense on a
 * slope, so they fade in above the paddy floor and out again before the rock
 * starts; and a noise mask breaks that band into patches, because a valley
 * where every slope is terraced is as repetitive as one where none is.
 *
 * The tread is a little longer than the riser on purpose. A terrace riser is
 * nearly vertical in life, and a riser sharper than the distance between two
 * terrain vertices lands between them and comes back as a sawtooth - which is a
 * lesson Mars already taught us twice.
 */
function terrace(x: number, z: number, floor: number, seed: number): number {
  if (floor < 0.5 || floor > 70) return floor
  const patch = clamp((valueNoise(x * 0.0019, z * 0.0019, seed ^ 0x77aa11) - 0.36) / 0.16, 0, 1)
  if (patch <= 0) return floor
  // on the floor, not the flanks. Measured: a peak's shoulder climbs 30 degrees,
  // where a 1.45 m step occupies two and a half metres of ground - far inside a
  // ten metre mesh, so terraces there are aliased into nothing. On the paddy
  // floor the same step spans twenty to two hundred metres and reads.
  const strength = patch
    * clamp((floor - 0.5) / 3, 0, 1)
    * clamp((70 - floor) / 25, 0, 1)

  const scaled = floor / TERRACE_STEP
  const level = Math.floor(scaled)
  const frac = scaled - level
  const riser = clamp((frac - 0.55) / 0.45, 0, 1)
  const eased = riser * riser * (3 - 2 * riser)
  let bench = level * TERRACE_STEP + eased * TERRACE_STEP
  // the bund: a low earth lip along the top edge of every field
  bench += Math.exp(-Math.pow((frac - 0.5) / 0.07, 2)) * 0.32
  return floor + (bench - floor) * strength
}

// ------------------------------------------------------------ the pad

/**
 * The design's own origin: the point that becomes the landing pad.
 *
 * Not the valley's origin, which is where the reference puts it - and that spot
 * is ten metres from the meander, four metres down in its bed, so the tug was
 * landing in the river. This one is picked for the job instead: ninety-eight
 * metres clear of the water, on ground that falls a third of a percent, and
 * still near enough to the middle of the valley to see both sides of it.
 */
export const PAD_ORIGIN = { x: 80, z: -40 }

const scratch: PadOffset = { arc: 0, bearing: 0, north: 0, east: 0 }

/**
 * Mars keeps its pad flat, and so does every world now: a launch apron is level
 * ground by definition, and this is the one place in the landscape where that is
 * true rather than a compromise. The old blend was short enough to cut into
 * craters; this one flattens them instead.
 */
const PAD = PAD_APRON

/**
 * The landscape at a surface point, in metres of radial offset, before the pad
 * is levelled into it. Pure and deterministic: the renderer displaces the planet
 * sphere with this and the sim walks on top of it.
 */
export function earthFieldHeight(
  anchorLat: number, anchorLon: number, lat: number, lon: number, radius: number,
): number {
  const offset = padOffset(anchorLat, anchorLon, lat, lon, radius, scratch)
  const x = offset.east + PAD_ORIGIN.x
  const z = offset.north + PAD_ORIGIN.z
  // terraces first, then the river: water is older than fields, and it cuts
  // through them rather than going round
  return riverCut(x, z, terrace(x, z, valleyFloor(x, z), SEED))
}

/** The height at the middle of the pad, which the apron is blended toward. */
export function padCentre(anchorLat: number, anchorLon: number, radius: number): number {
  return earthFieldHeight(anchorLat, anchorLon, anchorLat, anchorLon, radius)
}

export function flattenPad(
  anchorLat: number, anchorLon: number, lat: number, lon: number, radius: number,
  height: number, centreHeight: number,
): number {
  const offset = padOffset(anchorLat, anchorLon, lat, lon, radius, scratch)
  if (offset.arc >= PAD.blend) return height
  const blend = offset.arc <= PAD.flat ? 0 : (offset.arc - PAD.flat) / (PAD.blend - PAD.flat)
  const smooth = blend * blend * (3 - 2 * blend)
  return centreHeight * (1 - smooth) + height * smooth
}
