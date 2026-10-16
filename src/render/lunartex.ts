import * as THREE from 'three'
import { mulberry32 } from '../sim/noise.ts'

/**
 * The moon's painted surfaces: rover tracks, and the Earth overhead.
 * The recipe is a straight lift from the reference moon project - every count,
 * colour and RNG draw there was settled by eye, so resist re-tuning it.
 *
 * The regolith tile used to live here too. It has been replaced by a photograph of
 * a crater field, graded by `.tools/make-moon-tile.py`, so the Moon's floor is now
 * the same kind of thing as Earth's and Mars's.
 */

interface LunarCanvas {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D | null
}

/** Canvas plus context; the context stays nullable so callers have to face it. */
function lunarCanvas(width: number, height: number): LunarCanvas {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return { canvas, ctx: canvas.getContext('2d') }
}

function finish(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 2
  return texture
}

/**
 * Rover tracks: paired bright treads on a disturbed strip (ref: moon.jpg).
 * One tile spans 0.6 m of track - u runs across a 3.2 m strip, v along it.
 */
export function roverTrackTexture(size = 128): THREE.CanvasTexture {
  const { canvas, ctx } = lunarCanvas(size, size)
  if (!ctx) return finish(canvas)
  const rand = mulberry32(424242)

  // The disturbed strip the wheels churned up, under the lugs themselves.
  ctx.fillStyle = 'rgba(104,101,95,0.18)'
  ctx.fillRect(0, 0, size, size)

  // Two tread columns, at ±0.9 m from the centre of the strip.
  const centers = [0.22 * size, 0.78 * size]
  for (const cx of centers) {
    const w = size * 0.15
    for (let y = 0; y < size; y += size / 4) {
      // Compacted lug, brighter than the soil it sits on. Jitter on opacity is
      // what keeps four identical footprints from reading as a printed pattern.
      ctx.fillStyle = `rgba(242,240,233,${(0.85 + rand() * 0.15).toFixed(2)})`
      ctx.fillRect(cx - w / 2, y + 3, w, size / 4 - 9)
      // Groove lines inside each lug, so it reads as tread rather than paint.
      ctx.fillStyle = 'rgba(130,127,120,0.45)'
      ctx.fillRect(cx - w / 2 + w * 0.3, y + 3, 1, size / 4 - 9)
      ctx.fillRect(cx + w / 2 - w * 0.3, y + 3, 1, size / 4 - 9)
    }
  }

  return finish(canvas)
}

/** Earth: blue marble with continents, clouds and polar caps. */
export function lunarEarthTexture(size = 512): THREE.CanvasTexture {
  const { canvas, ctx } = lunarCanvas(size * 2, size)
  if (!ctx) return finish(canvas)
  const rand = mulberry32(314159)
  const W = size * 2

  // Ocean deepens towards both poles, which also hides the heavy stretching of an
  // equirectangular map along its top and bottom rows.
  const g = ctx.createLinearGradient(0, 0, 0, size)
  g.addColorStop(0, '#1c4a8a')
  g.addColorStop(0.5, '#2a6ab0')
  g.addColorStop(1, '#1c4a8a')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, size)

  const drawBlob = (x: number, y: number, r: number, col: string) => {
    // Drawn three times, a full width apart each way, so a continent crossing the
    // seam is whole on both sides of it when the map wraps around the globe.
    for (const ox of [-W, 0, W]) {
      ctx.fillStyle = col
      ctx.beginPath()
      for (let a = 0; a < Math.PI * 2; a += 0.35) {
        const rr = r * (0.55 + rand() * 0.7)
        const px = x + ox + Math.cos(a) * rr
        const py = y + Math.sin(a) * rr * 0.7
        if (a === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
    }
  }
  for (let i = 0; i < 14; i++) {
    const x = rand() * W
    const y = size * 0.2 + rand() * size * 0.6
    const r = size * (0.06 + rand() * 0.14)
    const col = rand() < 0.6 ? 'rgba(58,110,62,0.95)' : 'rgba(122,104,58,0.9)'
    drawBlob(x, y, r, col)
  }

  // Ice, as flat bands rather than blobs: every column of the map converges at a
  // pole, so only a band stays a cap once it is wrapped onto the sphere.
  ctx.fillStyle = 'rgba(245,248,252,0.95)'
  ctx.fillRect(0, 0, W, size * 0.06)
  ctx.fillRect(0, size * 0.94, W, size * 0.06)

  // Clouds as wide soft ellipses - circular blobs read as stickers, stretched
  // ones read as weather.
  for (let i = 0; i < 60; i++) {
    const x = rand() * W
    const y = rand() * size
    const r = size * (0.05 + rand() * 0.16)
    const cg = ctx.createRadialGradient(x, y, 0, x, y, r)
    cg.addColorStop(0, 'rgba(255,255,255,0.75)')
    cg.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = cg
    ctx.beginPath()
    ctx.ellipse(x, y, r * 1.6, r * 0.6, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  return finish(canvas)
}
