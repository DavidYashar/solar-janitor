/**
 * Mars, as an open crater field inside a ring of peaks.
 *
 * The reference build is a wide plain punched with craters of several kinds -
 * simple bowls, a complex one with a central peak, a breached rim, half-erased
 * ghosts - closed off by a jagged range. It was drawn on a flat 700 m plane, and
 * that cannot be picked up and put down here: this world is a ball of radius 55,
 * so the ground is over the curve fifteen metres from your boots and everything
 * past that is hidden unless it stands tall enough to clear it. The reference's
 * ring sits 200 m out and 60 m high, which would need to be 300 m high to be
 * seen at all.
 *
 * So the composition is rebuilt at the size the world actually is, keeping what
 * makes the reference read: the crater vocabulary - profile for profile, rim for
 * rim - the jagged skyline, the sand-and-rock palette. Everything is stated in
 * metres and bearings from the landing pad, because that is the only frame that
 * survives the move.
 *
 * Two shapes decide what you can see. A shallow saucer lifts the floor so it
 * stays above the sightline out to the rim: on a ball this small a flat plain is
 * a disc fifteen metres across with the sky behind it. And the ring is put where
 * it can still be seen - from the pad a point `d` metres out is hidden unless it
 * stands `(d - 15)^2 / 110` above the landing site, which at 54 m is 14 m, so the
 * crests run well clear of that and no bearing has a hole in it.
 */

import { PAD_APRON, SURFACE_RADIUS, SURFACE_SCALE } from './config.ts'
import { fbm, ridged, valueNoise } from './noise.ts'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * The design below is the one that was composed against a ball of radius 55,
 * where the numbers are what they are because of how far the ground curves away
 * and how much of it you can see. The world is a different size now, and this is
 * what carries the design up with it: everything in metres gets multiplied once,
 * so the place keeps its proportions - the craters stay in scale with the field,
 * the bowl keeps a slope you can walk, and the ring keeps its place on the skyline.
 */
const K = SURFACE_SCALE

/** how high the janitor's eye rides, which is what the skyline is designed against */
const EYE_HEIGHT = 2

/** fourteen metres on a 55 m ball: past this the ground itself is over the curve */
const HORIZON = Math.sqrt(2 * SURFACE_RADIUS * EYE_HEIGHT)

/** how far the ring's inner skirt starts to climb out of the floor */
const RING = { skirt: 42 * K, crestIn: 54 * K, crestOut: 68 * K, out: 80 * K }

/** the ring's own contribution to the height, on top of the floor and the saucer */
const RING_CREST = { low: 14 * K, high: 34 * K }

/** the saucer: a multiple of the sightline, so the whole floor stays in view */
const SAUCER = { lift: 1.15, ceiling: 14 * K }

/**
 * How high a point has to stand, in metres above the landing pad, to clear the
 * curve of the world and be visible from it. Below this it is not hidden by fog
 * or by haze - it is behind the ground.
 */
function sightline(distance: number): number {
  if (distance <= HORIZON) return 0
  const beyond = distance - HORIZON
  return (beyond * beyond) / (2 * SURFACE_RADIUS)
}

export interface PadOffset {
  /** great-circle distance from the pad, metres */
  arc: number
  /** radians clockwise from local north */
  bearing: number
  north: number
  east: number
}

/**
 * Where a point lies relative to the landing pad.
 *
 * Azimuthal equidistant, deliberately. Resolving longitude by the anchor's own
 * cosine - the cheap version, and the one the older landforms used - stretches
 * every shape in the field into an oval here, because the field spans fifty
 * degrees of latitude and the cosine nearly halves across it. This way a crater
 * drawn as a circle in north/east metres is still a circle on the ground.
 */
export function padOffset(anchorLat: number, anchorLon: number, lat: number, lon: number, into: PadOffset): PadOffset {
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const sinAnchor = Math.sin(anchorLat)
  const cosAnchor = Math.cos(anchorLat)
  const dLon = ((lon - anchorLon + Math.PI * 3) % (Math.PI * 2)) - Math.PI
  const cosArc = clamp(sinAnchor * sinLat + cosAnchor * cosLat * Math.cos(dLon), -1, 1)
  const arc = Math.acos(cosArc) * SURFACE_RADIUS
  const east = cosLat * Math.sin(dLon)
  const north = cosAnchor * sinLat - sinAnchor * cosLat * Math.cos(dLon)
  const bearing = arc > 1e-6 ? Math.atan2(east, north) : 0
  into.arc = arc
  into.bearing = bearing
  into.north = arc * Math.cos(bearing)
  into.east = arc * Math.sin(bearing)
  return into
}

// ------------------------------------------------------------------ craters

export type CraterType = 'simple' | 'complex' | 'breached' | 'eroded' | 'ghost'

export interface Crater {
  /** metres from the pad, along its bearing */
  distance: number
  /** radians clockwise from north */
  bearing: number
  /** the bearing resolved once, since this is read for every vertex on the ground */
  cosBearing: number
  sinBearing: number
  /** the furthest out the crater has any say, stretching included */
  reach: number
  radius: number
  depth: number
  rim: number
  type: CraterType
  /** elongates the bowl along its bearing; 1 is round */
  stretch: number
  /** radians clockwise from north, where a breached rim has given way */
  breach: number
  /** a second peak off centre, the way a big impact scars its own floor */
  doublePeak: boolean
}

/**
 * The craters, placed by hand for the same reason the ring is: this is a place,
 * not a scatter, and the composition has to hold every time the janitor lands.
 *
 * Sizes run down with distance so the middle of the field keeps a clear apron to
 * put down on and to work in, and the types take turns so the vocabulary is all
 * present inside a single walk: one complex bowl with a peak in it, one rim
 * breached toward the pad, an eroded and a ghost that are barely a ring of
 * shadow, simple bowls between them. Depth is a third of radius and the rim a
 * fifth, which is the proportion the reference build uses.
 */
interface CraterPlan {
  bearing: number
  distance: number
  radius: number
  type: CraterType
  stretch?: number
  breach?: number
  doublePeak?: boolean
}

const CRATER_PLAN: CraterPlan[] = [
  // the showpiece: a deep complex bowl to the north-east, with a peak on its floor
  { bearing: 32, distance: 27, radius: 9.5, type: 'complex', doublePeak: true },
  // breached toward the pad, so you walk in through the gap rather than over the wall
  { bearing: 96, distance: 26, radius: 7.5, type: 'breached', breach: 96, stretch: 1.15 },
  // the far side, where the field is quietest
  { bearing: 168, distance: 30, radius: 8.5, type: 'simple' },
  { bearing: 206, distance: 25, radius: 6, type: 'eroded' },
  { bearing: 246, distance: 31, radius: 7, type: 'ghost', stretch: 1.3 },
  { bearing: 292, distance: 25, radius: 6.5, type: 'complex' },
  { bearing: 334, distance: 33, radius: 5.5, type: 'simple', stretch: 1.2 },
  // two small ones close in, so there is something to find before you have walked far
  { bearing: 62, distance: 16, radius: 3.2, type: 'simple' },
  { bearing: 138, distance: 17, radius: 2.8, type: 'simple' },

  // the far half of the field is older ground, and says so: the same vocabulary
  // worn down. A chain of three strung along one bearing, the way a broken-up
  // impactor leaves them; a basin wide and shallow enough that you cross it
  // without ever being sure you were in it; and an eroded bowl on the other side.
  { bearing: 14, distance: 30, radius: 4.6, type: 'simple', stretch: 1.3 },
  { bearing: 16, distance: 33.5, radius: 5.4, type: 'complex', stretch: 1.3 },
  { bearing: 18, distance: 37, radius: 3.8, type: 'ghost', stretch: 1.3 },
  { bearing: 118, distance: 35, radius: 9, type: 'ghost', stretch: 1.2 },
  { bearing: 266, distance: 34, radius: 7.5, type: 'eroded', stretch: 1.15 },
]

const CRATERS: Crater[] = CRATER_PLAN.map((plan) => {
  const radius = plan.radius * K
  const bearing = (plan.bearing * Math.PI) / 180
  const stretch = plan.stretch ?? 1
  return {
    distance: plan.distance * K,
    bearing,
    cosBearing: Math.cos(bearing),
    sinBearing: Math.sin(bearing),
    reach: radius * 2.4 * stretch,
    radius,
    depth: radius * 0.4,
    rim: radius * 0.2,
    type: plan.type,
    stretch,
    breach: ((plan.breach ?? 0) * Math.PI) / 180,
    doublePeak: plan.doublePeak ?? false,
  }
})

/**
 * One crater's contribution at a point, in metres - the reference build's own
 * profile, kept because the shapes are the look. The rim is a narrow gaussian
 * sitting on the lip, which is what gives a crater an edge you can see against
 * the sky rather than a soft dip.
 */
function craterProfile(crater: Crater, north: number, east: number, seed: number): number {
  const centreNorth = crater.distance * crater.cosBearing
  const centreEast = crater.distance * crater.sinBearing
  const dNorth = north - centreNorth
  const dEast = east - centreEast
  // a box first: this runs for every vertex on the ground and most of them are
  // nowhere near most of the craters
  if (Math.abs(dNorth) > crater.reach || Math.abs(dEast) > crater.reach) return 0
  const along = dNorth * crater.cosBearing + dEast * crater.sinBearing
  const across = -dNorth * crater.sinBearing + dEast * crater.cosBearing
  const raw = Math.hypot(along / crater.stretch, across)
  if (raw > crater.radius * 2.4) return 0

  // a wavy rim, sampled around the circle so it closes on itself: no two crater
  // edges are the same circle, and none of them has a seam. The frequency is tied
  // to the crater's size rather than fixed, because a fixed one puts sixteen
  // lobes around a three-metre bowl - a lobe every 1.2 m, on a mesh with a vertex
  // every 1.5 m, which is a sawtooth and not a rim.
  const angle = Math.atan2(across, along)
  const wobbleScale = clamp(crater.radius / (5 * K), 0.55 * K, 3.2 * K)
  const wobble = 1 + (valueNoise(Math.cos(angle) * wobbleScale, Math.sin(angle) * wobbleScale, seed ^ 0x51ed270b) - 0.5) * 0.4
  const d = raw / (crater.radius * wobble)

  const type = crater.type
  let height = 0

  // the bowl
  if (d < 1) {
    const bowl = 1 - d * d
    if (type === 'eroded') {
      height -= crater.depth * bowl * bowl * 0.45
    } else if (type === 'ghost') {
      height -= crater.depth * bowl * bowl * 0.18
    } else if (type === 'complex') {
      if (d < 0.7) {
        height -= crater.depth * 0.8
        if (d < 0.3) {
          const t = 1 - d / 0.3
          height += crater.depth * 0.55 * t * t
        }
        if (crater.doublePeak && d > 0.12 && d < 0.4) {
          const t = 1 - Math.abs(d - 0.26) / 0.14
          if (t > 0) height += crater.depth * 0.35 * t * t
        }
      } else {
        const t = (d - 0.7) / 0.3
        height -= crater.depth * (0.2 + 0.6 * t * t)
      }
    } else {
      height -= crater.depth * bowl * bowl
    }
  }

  // the rim. The reference build writes this as a gaussian in the normalised
  // radius, which makes the lip a fixed *fraction* of the crater - 0.11 of the
  // radius, so seven centimetres on a small bowl. A lip that narrow falls between
  // two vertices and comes back as a spike, so the width is stated in metres with
  // a floor under it, and every crater keeps a rim the mesh can actually hold.
  const fromRim = (d - 1) * crater.radius
  const rimWidth = Math.max(crater.radius * 0.11, 1.7 * K)
  const lip = fromRim / rimWidth
  if (type === 'eroded') {
    height += crater.rim * 0.35 * Math.exp(-lip * lip)
  } else if (type === 'ghost') {
    height += crater.rim * 0.15 * Math.exp(-(lip * lip) / 1.6)
  } else if (type === 'breached') {
    const towardBreach = Math.cos(angle - crater.breach)
    const standing = clamp((towardBreach + 0.25) / 1.25, 0, 1)
    height += crater.rim * Math.exp(-(lip * lip) / 0.6) * (0.25 + 0.75 * standing)
  } else {
    height += crater.rim * Math.exp(-(lip * lip) / 0.5)
  }

  // the ejecta that fell back around it
  if (d > 1 && d < 1.8) height += crater.rim * 0.4 * Math.exp(-(d - 1.2) / 0.5)

  return height
}

// --------------------------------------------------------------------- ring

/**
 * The wall of the field: one unbroken ring of peaks.
 *
 * Discrete hills leave gaps you can see the sky through, and this is meant to be
 * the edge of the world the janitor works inside - so the ring is continuous,
 * and its height is designed rather than scattered: three sines around the
 * compass give summits and saddles that never repeat, and ridged noise on top
 * gives every peak a different shape. Ridged rather than smooth on purpose - the
 * reference skyline is rock that wind has not had time to sand down.
 */
function ringHeight(distance: number, bearing: number, north: number, east: number, seed: number): number {
  if (distance < RING.skirt || distance > RING.out) return 0
  const skyline = 0.5
    + 0.21 * Math.sin(bearing * 3 + 0.7)
    + 0.13 * Math.sin(bearing * 5 + 2.1)
    + 0.09 * Math.sin(bearing * 8 - 1.3)
  const teeth = ridged(north * 0.11 / K + 5.3, east * 0.11 / K - 2.9, 4, seed ^ 0x2f1b3c)
  const crest = RING_CREST.low
    + (RING_CREST.high - RING_CREST.low) * clamp(skyline * 0.62 + teeth * 0.72, 0, 1)
  if (distance < RING.crestIn) {
    const t = (distance - RING.skirt) / (RING.crestIn - RING.skirt)
    return crest * t * t * (3 - 2 * t)
  }
  if (distance <= RING.crestOut) return crest
  const t = (distance - RING.crestOut) / (RING.out - RING.crestOut)
  return crest * (1 - t) * (1 - t)
}

// -------------------------------------------------------------------- field

const scratchOffset: PadOffset = { arc: 0, bearing: 0, north: 0, east: 0 }

/**
 * The inverse of `padOffset`: the point `arc` metres from the pad on `bearing`, as
 * lat/lon. Exact rather than flat, because on a 96 m ball the ring is forty-five
 * degrees of arc away and a planar walk out there lands nowhere near where it says.
 *
 * The renderer needs this to scatter props in the *field* - bearing and distance
 * from the pad, the way the whole landscape is authored - rather than by drawing
 * random coordinates on the globe and hoping some land in the bowl.
 */
export function marsFromPad(
  anchorLat: number, anchorLon: number, bearing: number, arc: number, into: { lat: number; lon: number },
): { lat: number; lon: number } {
  const d = arc / SURFACE_RADIUS
  const sinAnchor = Math.sin(anchorLat)
  const cosAnchor = Math.cos(anchorLat)
  const sinD = Math.sin(d)
  const cosD = Math.cos(d)
  const lat = Math.asin(clamp(sinAnchor * cosD + cosAnchor * sinD * Math.cos(bearing), -1, 1))
  into.lat = lat
  into.lon = anchorLon + Math.atan2(
    Math.sin(bearing) * sinD * cosAnchor,
    cosD - sinAnchor * Math.sin(lat),
  )
  return into
}

/** Inside this the ground is the crater field you work; outside it the ring climbs. */
export const MARS_FIELD_RADIUS = RING.skirt

/**
 * The landscape, in surface metres, before the landing pad is levelled into it.
 * Pure and deterministic: the renderer displaces the planet sphere with this and
 * the sim walks on top of it, so a crater you can see is a crater you can climb.
 */
export function marsFieldHeight(anchorLat: number, anchorLon: number, lat: number, lon: number, seed: number): number {
  const offset = padOffset(anchorLat, anchorLon, lat, lon, scratchOffset)
  const north = offset.north
  const east = offset.east

  // the floor: a broad swell under a finer grain, both slow enough that the
  // terrain mesh can actually resolve them rather than aliasing into confetti,
  // and both small enough that the craters are the shape you read, not the noise
  let height = (fbm(north * 0.021 / K, east * 0.021 / K, 3, seed ^ 0x1d3c9a) - 0.5) * 1.6 * K
  height += (valueNoise(north * 0.085 / K, east * 0.085 / K, seed) - 0.5) * 0.85 * K
  height += (valueNoise(north * 0.26 / K, east * 0.26 / K, seed ^ 0x9e3779b9) - 0.5) * 0.34 * K

  // the saucer, so the floor you work stays in front of you instead of over the edge
  height += Math.min(sightline(offset.arc) * SAUCER.lift, SAUCER.ceiling)

  for (const crater of CRATERS) height += craterProfile(crater, north, east, seed)
  height += ringHeight(offset.arc, offset.bearing, north, east, seed)
  return height
}

/** The apron the concrete pad of `PAD_RADIUS` is laid on: level, then blended out. */
const PAD = PAD_APRON

/**
 * The pad itself stays flat: the lander, the ring and the cargo pile were all
 * built to sit on level ground, so the last few metres around it are blended
 * toward the height at its centre whatever the landscape does.
 */
export function flattenPad(
  anchorLat: number, anchorLon: number, lat: number, lon: number, height: number, centreHeight: number,
): number {
  const offset = padOffset(anchorLat, anchorLon, lat, lon, scratchOffset)
  if (offset.arc >= PAD.blend) return height
  const blend = offset.arc <= PAD.flat ? 0 : (offset.arc - PAD.flat) / (PAD.blend - PAD.flat)
  const smooth = blend * blend * (3 - 2 * blend)
  return centreHeight * (1 - smooth) + height * smooth
}
