/**
 * The value noise every procedural surface is built from.
 *
 * It lives on its own so the terrain modules can share it without importing each
 * other: `planets.ts` owns the height field, and the landform vocabulary that
 * carves it is a separate file again.
 */

/** Seeded generator, for anything that needs a reproducible scatter. */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash2(x: number, y: number, seed: number): number {
  let h = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Deterministic value noise in [0, 1). One cell is one unit. */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  const u = smooth(xf)
  const v = smooth(yf)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/** Layered value noise in [0, 1): the rolling, weathered part of a landscape. */
export function fbm(x: number, y: number, octaves: number, seed: number): number {
  let value = 0
  let amplitude = 1
  let frequency = 1
  let total = 0
  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise(x * frequency, y * frequency, seed + i * 0x9e3779b9)
    total += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return value / total
}

/**
 * Layered value noise folded to a ridge, in [0, 1): sharp crests rather than
 * rounded ones, which is what rock that has not been sanded down by wind looks
 * like. This is the shape of the skyline.
 */
export function ridged(x: number, y: number, octaves: number, seed: number): number {
  let value = 0
  let amplitude = 1
  let frequency = 1
  let total = 0
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(2 * valueNoise(x * frequency, y * frequency, seed + i * 0x85ebca6b) - 1)
    value += amplitude * n * n
    total += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return value / total
}
