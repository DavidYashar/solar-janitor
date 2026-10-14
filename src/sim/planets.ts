import {
  EARTH_ORBIT, EARTH_ORBIT_RATE, EARTH_RADIUS, MARS_ORBIT, MARS_ORBIT_RATE, MARS_RADIUS,
  MOON_ORBIT, MOON_ORBIT_RATE, MOON_RADIUS,
} from './config.ts'
import { flattenPad, marsFieldHeight } from './marsfield.ts'
import { valueNoise } from './noise.ts'

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
  junkCount: 24,
  landerLat: 0,
  landerLon: 0.6,
  spread: { lat: 0.62, lon: 1.05 },
  hazard: 'none',
  spaceColor: 0x2f6fd0,
  atmosphere: 0x7fc4ff,
  groundLow: 0x2f7d4f,
  groundHigh: 0x7cc46a,
  accent: 0x9fe8ff,
  rock: 0x8b929b,
  skyTop: '#0d2c66',
  skyMid: '#4a8fd6',
  skyHorizon: '#e6f4ff',
  fogColor: 0xbfe4ff,
  fogNear: 170,
  fogFar: 560,
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
  junkCount: 22,
  landerLat: -0.3,
  landerLon: 1.25,
  spread: { lat: 0.72, lon: 1.15 },
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
  fogNear: 220,
  fogFar: 700,
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
  junkCount: 22,
  landerLat: 0.26,
  landerLon: -0.85,
  // the field is a bowl forty metres across and the ring walls it in, so junk
  // has to fall inside that: the widest corner is 46 m out, on the ring's skirt
  spread: { lat: 0.5, lon: 0.7 },
  hazard: 'storm',
  spaceColor: 0xc0603a,
  atmosphere: 0xffb083,
  groundLow: 0x8f481c,
  groundHigh: 0xe0a050,
  accent: 0xf0c08a,
  rock: 0x6e3420,
  // the reference build's dome: one dust colour at the skyline going to a dark
  // rust overhead, with no blue anywhere in it. The bottom stop is under the
  // horizon, where only the far side of the ring can ever see it
  skyTop: '#4a3020',
  skyMid: '#e0a068',
  skyHorizon: '#8a5a38',
  // the same dust, thinning out over the ring: near enough that the floor is
  // clear and far enough that the far crests are two-thirds air
  fogColor: 0xc89860,
  fogNear: 16,
  fogFar: 165,
}

export const PLANETS: PlanetDef[] = [EARTH, MOON, MARS]

export function planetById(id: number): PlanetDef {
  return PLANETS[id] ?? EARTH
}

/** Where the lander sits on the surface, in sim lat/lon. */
export function landerSite(planetId: number): { lat: number; lon: number } {
  const planet = planetById(planetId)
  return { lat: planet.landerLat, lon: planet.landerLon }
}

// ------------------------------------------------------- procedural terrain
// Shared by the sim (spawn rules, walking, junk placement) and the renderer
// (props and the player ride the same surface). Pure and deterministic.

/** Rolling hills in surface units, roughly -2 .. +2 (Earth's terrain). */
function earthTerrain(lat: number, lon: number, seed: number): number {
  const x = lon * 9.5
  const y = lat * 9.5
  return (valueNoise(x, y, seed) - 0.5) * 3.4 + (valueNoise(x * 2.7, y * 2.7, seed ^ 0x9e3779b9) - 0.5) * 1.1
}

// ------------------------------------------------------------------ craters

export interface Crater {
  lat: number
  lon: number
  radius: number
  depth: number
}

const craterCache = new Map<string, Crater[]>()

/** Deterministic crater field (Moon). Also used by the renderer for rims. */
export function cratersFor(planetId: number, seed: number): Crater[] {
  const key = `${planetId}:${seed}`
  const cached = craterCache.get(key)
  if (cached) return cached
  const craters: Crater[] = []
  const planet = planetById(planetId)
  if (planet.theme === 'moon') {
    let state = (seed ^ 0x51ed270b) >>> 0
    const rnd = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 4294967296
    }
    for (let i = 0; i < 26; i++) {
      // keep the landing pad itself flat enough to put a lander down on
      const lat = (rnd() * 2 - 1) * 1.0
      const lon = rnd() * Math.PI * 2
      const distanceToPad = Math.hypot(
        (lat - planet.landerLat) * 1,
        Math.cos(lat) * (((lon - planet.landerLon + Math.PI * 3) % (Math.PI * 2)) - Math.PI),
      )
      if (distanceToPad < 0.28) continue
      craters.push({
        lat,
        lon,
        radius: 0.055 + rnd() * 0.125,
        depth: 0.5 + rnd() * 1.9,
      })
    }
  }
  if (craterCache.size > 12) craterCache.clear()
  craterCache.set(key, craters)
  return craters
}

function craterOffset(craters: Crater[], lat: number, lon: number): number {
  let offset = 0
  for (const crater of craters) {
    const dLat = lat - crater.lat
    let dLon = lon - crater.lon
    dLon = ((dLon + Math.PI * 3) % (Math.PI * 2)) - Math.PI
    const distance = Math.hypot(dLat, Math.cos(lat) * dLon)
    const t = distance / crater.radius
    if (t > 2.2) continue
    if (t < 1) {
      // bowl
      offset -= crater.depth * (1 - t * t)
    }
    // raised rim
    const rim = (t - 1) / 0.26
    offset += crater.depth * 0.42 * Math.exp(-rim * rim)
  }
  return offset
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

function moonTerrain(lat: number, lon: number, seed: number): number {
  const x = lon * 7.2
  const y = lat * 7.2
  return (valueNoise(x, y, seed) - 0.5) * 1.5 + (valueNoise(x * 3.3, y * 3.3, seed ^ 0x9e3779b9) - 0.5) * 0.6
}

/**
 * Terrain height in surface units for any planet. The renderer displaces the
 * planet sphere with this and the sim walks on top of it, so they always agree.
 */
export function terrainHeight(lat: number, lon: number, seed: number, planetId = 0): number {
  const planet = planetById(planetId)
  if (planet.theme === 'moon') {
    return moonTerrain(lat, lon, seed) + craterOffset(cratersFor(planetId, seed), lat, lon)
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
