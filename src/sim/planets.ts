import {
  EARTH_ORBIT, EARTH_ORBIT_RATE, EARTH_RADIUS, EARTH_SURFACE_RADIUS, MARS_ORBIT, MARS_ORBIT_RATE,
  MARS_RADIUS, MOON_ORBIT, MOON_ORBIT_RATE, MOON_RADIUS, MOON_SURFACE_RADIUS, SURFACE_RADIUS,
  SURFACE_SCALE,
} from './config.ts'
import { flattenPad, marsFieldHeight } from './marsfield.ts'
import { earthFieldHeight, flattenPad as flattenEarthPad, padCentre as fieldPadCentre } from './earthfield.ts'
import { PAD_ORIGIN, padOffset, riverDistance } from './earthfield.ts'
import type { PadOffset } from './earthfield.ts'
import { flattenMoonPad, moonFieldAt, moonPadCentre } from './moonfield.ts'

export type PlanetTheme = 'earth' | 'moon' | 'mars'
export type HazardKind = 'none' | 'meteor' | 'storm'

export interface PlanetDef {
  id: number
  key: string
  name: string
  tagline: string
  theme: PlanetTheme
  /** relative gravity, 1 = Earth */
  gravity: number
  /** radius in the space map */
  spaceRadius: number
  /** orbit radius: around the Sun, or around the parent planet for moons */
  orbit: number
  orbitRate: number
  /** -1 = the Sun, otherwise the planet this body orbits */
  parent: number
  landable: boolean
  /** radius of the ball you stand on, in metres - a property of the world */
  surfaceRadius: number
  /** true where the air is breathable, so the suit's tanks are not the clock */
  breathable: boolean
  /** junk pieces including the single relic */
  junkCount: number
  landerLat: number
  landerLon: number
  /** how far junk can scatter from the lander, radians */
  spread: { lat: number; lon: number }
  hazard: HazardKind
  /** palette */
  spaceColor: number
  atmosphere: number
  groundLow: number
  groundHigh: number
  accent: number
  rock: number
  /** surface sky gradient (top / middle / horizon) and fog */
  skyTop: string
  skyMid: string
  skyHorizon: string
  fogColor: number
  fogNear: number
  fogFar: number
  /**
   * Metres between terrain vertices on this world's surface. Ten by default; a
   * world whose landscape was authored with detail finer than its grid says so
   * here.
   */
  surfaceSpacing?: number
}

export const EARTH: PlanetDef = {
  id: 0,
  key: 'earth',
  name: 'Earth',
  tagline: 'Home. Drowning in a century of junk.',
  theme: 'earth',
  gravity: 1,
  spaceRadius: EARTH_RADIUS,
  orbit: EARTH_ORBIT,
  orbitRate: EARTH_ORBIT_RATE,
  parent: -1,
  landable: true,
  surfaceRadius: EARTH_SURFACE_RADIUS,
  breathable: true,
  junkCount: 24,
  landerLat: 0,
  landerLon: 0.6,
  // a valley of half a kilometre, and a tank of air that carries you about two
  // hundred metres out and back - so the sweep is what fits in a tank and the
  // rest of the valley is somewhere you go over several trips
  spread: { lat: 0.35, lon: 0.35 },
  hazard: 'none',
  spaceColor: 0x2f6fd0,
  atmosphere: 0x7fc4ff,
  groundLow: 0x3d8426,
  groundHigh: 0x9ee850,
  accent: 0xa8c84a,
  rock: 0x6e6e6a,
  // the reference valley's own sky: deep blue overhead going to a pale, hazy
  // horizon, with the fog the same colour as the haze it is meant to be
  skyTop: '#2a5aa0',
  skyMid: '#7fa8d4',
  skyHorizon: '#b8d4ec',
  fogColor: 0xa8c0d8,
  fogNear: 260,
  fogFar: 1500,
}

export const MOON: PlanetDef = {
  id: 1,
  key: 'moon',
  name: 'Moon',
  tagline: 'Quiet since 1972. Not tidy since 1969.',
  theme: 'moon',
  gravity: 0.35,
  spaceRadius: MOON_RADIUS,
  orbit: MOON_ORBIT,
  orbitRate: MOON_ORBIT_RATE,
  parent: 0,
  landable: true,
  surfaceRadius: MOON_SURFACE_RADIUS,
  breathable: false,
  junkCount: 22,
  /**
   * The landing site is solved for, not chosen: the reference lit its landscape
   * with a sun 22 degrees up, which is what makes the craters read, and the sun
   * here is close enough that its elevation and its bearing come as a pair - you
   * cannot have both where you want them. So this is the site nearest the equator
   * that still puts the sun 22 degrees above the horizon and the whole 760 m
   * playfield inside the walkable band.
   */
  landerLat: 0.171,
  landerLon: -0.106,
  /**
   * Six metres a segment rather than ten. The reference laid this landscape out
   * on a two-metre grid, and the small crater population - five hundred and fifty
   * of the six hundred and seventy-four, none of them wider than twenty-eight
   * metres - is most of what makes the surface read as old. Ten metres throws
   * them away; six keeps the medium ones honest and leaves the smallest as
   * mottling, which is what they look like from standing height anyway.
   */
  surfaceSpacing: 6,
  /**
   * The Moon's landscape is 760 m across and the trench runs through the middle
   * of it, so the sweep is spread to the same reach Earth's is - about a hundred
   * and sixty metres for the cluster and twice that for the far pieces - which
   * on this ball is a quarter of a radian rather than a third.
   */
  spread: { lat: 0.28, lon: 0.28 },
  hazard: 'meteor',
  spaceColor: 0xb9bfc9,
  atmosphere: 0xd8dee8,
  groundLow: 0x6f7480,
  groundHigh: 0xb6bcc6,
  accent: 0xdfe6ff,
  rock: 0x8e939d,
  skyTop: '#04060f',
  skyMid: '#0a1020',
  skyHorizon: '#1b2438',
  fogColor: 0x1b2438,
  // real metres now that the world is a real size: far enough out that the
  // playfield is crisp, close enough that the rim behind it softens into sky
  fogNear: 460,
  fogFar: 1700,
}

export const MARS: PlanetDef = {
  id: 2,
  key: 'mars',
  name: 'Mars',
  tagline: 'Rust, dust and abandoned probes.',
  theme: 'mars',
  gravity: 0.45,
  spaceRadius: MARS_RADIUS,
  orbit: MARS_ORBIT,
  orbitRate: MARS_ORBIT_RATE,
  parent: -1,
  landable: true,
  surfaceRadius: SURFACE_RADIUS,
  breathable: false,
  junkCount: 22,
  landerLat: 0.26,
  landerLon: -0.85,
  // the field is a bowl forty metres across and the ring walls it in, so junk
  // has to fall inside that: the widest corner is 46 m out, on the ring's skirt
  spread: { lat: 0.5, lon: 0.7 },
  hazard: 'storm',
  spaceColor: 0xc0603a,
  atmosphere: 0xffb083,
  /**
   * The ground, measured off the owner's Mars photographs rather than picked by eye.
   *
   * Both stops are the **plain**. `mars surface 3` puts the flat dust at hue 5-7 with
   * 56-63% saturation - a brick red - and its own dark and lit clusters are the two
   * ends of that: #7e3c35 in shadow, #a44f48 in sun. That is the whole floor ramp. The
   * hills are a different family and they are not on this ramp at all; they come from
   * the strata bands in `surfaces.ts`, which is what the second reference,
   * `mars hills 3`, is for (hue 22-30, brightness 46-87%).
   *
   * The first attempt at this only moved the *stops* and left the ramp where it was,
   * which is why it changed nothing visible: the ramp saturates at design height 7
   * while the saucer alone lifts the outer floor to 14, so most of the ground you can
   * actually see was still painted with the top stop. Both ends are the plain now, and
   * the ramp spans the floor's real relief.
   *
   * `rock` is the layered material of the ring, the reference's own shaded band, and
   * it is also the first stratum.
   */
  groundLow: 0x7e3c35,
  groundHigh: 0xa44f48,
  accent: 0xf0c08a,
  rock: 0x763e1d,
  // the reference build's dome: one dust colour at the skyline going to a dark
  // rust overhead, with no blue anywhere in it. The bottom stop is under the
  // horizon, where only the far side of the ring can ever see it
  skyTop: '#4a3020',
  skyMid: '#e0a068',
  skyHorizon: '#8a5a38',
  // the same dust, thinning out over the ring: near enough that the floor is
  // clear and far enough that the far crests are two-thirds air
  fogColor: 0xc89860,
  fogNear: 16 * SURFACE_SCALE,
  fogFar: 165 * SURFACE_SCALE,
}

export const PLANETS: PlanetDef[] = [EARTH, MOON, MARS]

export function planetById(id: number): PlanetDef {
  return PLANETS[id] ?? EARTH
}

/** The radius of the ball a landing site is, in metres. */
export function surfaceRadiusOf(planetId: number): number {
  return planetById(planetId).surfaceRadius
}

/** Where the lander sits on the surface, in sim lat/lon. */
export function landerSite(planetId: number): { lat: number; lon: number } {
  const planet = planetById(planetId)
  return { lat: planet.landerLat, lon: planet.landerLon }
}

const landmarkScratch: PadOffset = { arc: 0, bearing: 0, north: 0, east: 0 }

/**
 * How far a surface point is from the world's landmark, in metres (plan §8).
 *
 * Only Earth has one today: the river, which is the one piece of ground in the game
 * that is somewhere rather than just more ground - it has its own music, and the
 * music asks for its distance every frame. The Moon and Mars return `Infinity`, so a
 * caller can test "is the janitor at the landmark" without knowing the world, and
 * the Moon's trench is the obvious second entry here if it earns a bed of its own.
 *
 * The lat/lon -> pad-local metres conversion is `earthFieldHeight`'s, so a landmark
 * query and the terrain always agree about where a point is.
 */
export function landmarkDistance(planetId: number, lat: number, lon: number): number {
  if (planetId !== 0) return Infinity
  const planet = planetById(planetId)
  const offset = padOffset(
    planet.landerLat, planet.landerLon, lat, lon, planet.surfaceRadius, landmarkScratch,
  )
  return riverDistance(offset.east + PAD_ORIGIN.x, offset.north + PAD_ORIGIN.z)
}

// ------------------------------------------------------- procedural terrain
// Shared by the sim (spawn rules, walking, junk placement) and the renderer
// (props and the player ride the same surface). Pure and deterministic.

/** Rolling hills in surface units, roughly -2 .. +2 (Earth's terrain). */
function earthTerrain(lat: number, lon: number, _seed: number): number {
  const planet = EARTH
  const radius = planet.surfaceRadius
  const height = earthFieldHeight(planet.landerLat, planet.landerLon, lat, lon, radius)
  return flattenEarthPad(
    planet.landerLat, planet.landerLon, lat, lon, radius, height, earthPadCentre(radius),
  )
}

/**
 * The height at the middle of Earth's apron, which everything within sixteen
 * metres of it is blended toward. A constant for a given world, so it is worked
 * out once - and worked out from the unfinished landscape, which is why the
 * pad's own blend cannot feed back into itself.
 */
let earthPadRadius = -1
let earthPadHeight = 0

function earthPadCentre(radius: number): number {
  if (earthPadRadius !== radius) {
    earthPadRadius = radius
    earthPadHeight = fieldPadCentre(EARTH.landerLat, EARTH.landerLon, radius)
  }
  return earthPadHeight
}

// -------------------------------------------------------------------- mars

/**
 * Mars is a designed place rather than a scatter: a crater field inside a ring
 * of peaks, laid out by `marsfield.ts` in metres and bearings from the pad. The
 * seed only moves the grain, so the landscape the janitor learns is the same one
 * every run and the junk in it is not.
 */
function marsTerrain(lat: number, lon: number, seed: number): number {
  const site = landerSite(2)
  const height = marsFieldHeight(site.lat, site.lon, lat, lon, seed)
  return flattenPad(site.lat, site.lon, lat, lon, height, padCentreHeight(seed))
}

/**
 * The height at the middle of the pad, which everything within eleven metres of
 * it is blended toward. A constant for a given seed, so it is worked out once -
 * and worked out from the unfinished landscape, which is why the pad's own blend
 * cannot feed back into itself.
 */
let padSeed = -1
let padCentre = 0

function padCentreHeight(seed: number): number {
  if (padSeed !== seed) {
    padSeed = seed
    const site = landerSite(2)
    padCentre = marsFieldHeight(site.lat, site.lon, site.lat, site.lon, seed)
  }
  return padCentre
}

function moonTerrain(lat: number, lon: number, _seed: number): number {
  const radius = MOON.surfaceRadius
  const height = moonFieldAt(MOON.landerLat, MOON.landerLon, lat, lon, radius)
  return flattenMoonPad(
    MOON.landerLat, MOON.landerLon, lat, lon, radius, height, moonPadCentre(MOON.landerLat, MOON.landerLon, radius),
  )
}

/**
 * Terrain height in surface units for any planet. The renderer displaces the
 * planet sphere with this and the sim walks on top of it, so they always agree.
 */
export function terrainHeight(lat: number, lon: number, seed: number, planetId = 0): number {
  const planet = planetById(planetId)
  if (planet.theme === 'moon') {
    return moonTerrain(lat, lon, seed)
  }
  if (planet.theme === 'mars') {
    return marsTerrain(lat, lon, seed)
  }
  return earthTerrain(lat, lon, seed)
}

/** Earth's terrain, kept for backwards compatibility with earlier callers. */
export function surfaceHeight(lat: number, lon: number, seed: number): number {
  return earthTerrain(lat, lon, seed)
}
