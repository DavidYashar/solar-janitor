export function nextRandom(state: { rngState: number }): number {
  state.rngState = (Math.imul(state.rngState, 1664525) + 1013904223) >>> 0
  return state.rngState / 4294967296
}

export function randomBetween(state: { rngState: number }, min: number, max: number): number {
  return min + nextRandom(state) * (max - min)
}

export function hashSeed(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function dailySeed(date = new Date()): number {
  return hashSeed(`solar-janitor-${date.toISOString().slice(0, 10)}`)
}
