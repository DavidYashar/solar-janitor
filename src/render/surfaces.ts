import * as THREE from 'three'
import {
  LANDER_RING_RADIUS, LOD_COST_SURFACE, LOD_PROP_SLICE, LOD_TERRAIN_SLICE, SURFACE_SCALE, TAU,
} from '../sim/config.ts'
import { landerSite, planetById, terrainHeight } from '../sim/planets.ts'
import {
  moonBoulderValley, moonCraterFieldAt, moonDesignPoint, moonFieldHeight, moonFieldNoise,
  moonSpherePoint, moonTrenchDistance,
} from '../sim/moonfield.ts'
import { mulberry32 } from '../sim/noise.ts'
import { lunarEarthTexture, regolithTexture, roverTrackTexture } from './lunartex.ts'
export { lunarEarthTexture }
import { fromPad, PAD_ORIGIN, riverDistance, riverHalfWidth, riverSamples } from '../sim/earthfield.ts'
import { valueNoise } from '../sim/noise.ts'
import type { PlanetDef } from '../sim/planets.ts'

const UP = new THREE.Vector3(0, 1, 0)
const scratchDir = new THREE.Vector3()

/**
 * One landable world, built from the shared PlanetDef + terrainHeight pair.
 * Every prop rides `terrainRadius`, so the renderer and the sim agree.
 */
export interface SurfaceBuild {
  planetId: number
  group: THREE.Group
  lander: THREE.Group
  landingRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
  ringMaterial: THREE.MeshBasicMaterial
  padBeacon: THREE.Sprite
  terrainRadius(lat: number, lon: number): number
}

/**
 * A surface that streams in across frames (plan §9). `standIn` holds the
 * horizon while `detail` is still on the build queue; `build` only appears once
 * the last slice reports done, so callers can tell "warm" from "not yet".
 */
export interface SurfaceJob {
  planetId: number
  /** tier 0: a smooth crust that sits just under the terrain's deepest valley */
  standIn: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  /** tier 2: terrain, props and the lander pad all live here */
  detail: THREE.Group
  build: SurfaceBuild | null
  /** estimated ms for the whole surface */
  readonly costMs: number
  /** run one bounded slice of work; true when the surface is ready */
  slice(): boolean
}

// --------------------------------------------------------------- utilities

/** Tiny deterministic RNG so props land in the same spot on every reload. */
export function makeRnd(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

export function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** A half-drawn canvas, so a heavy texture can be painted across several frames. */
export interface CanvasBuild {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D | null
  rnd: () => number
}

export function canvasBuild(width: number, height: number, seed = 991): CanvasBuild {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return { canvas, ctx: canvas.getContext('2d'), rnd: makeRnd(seed) }
}

export function finishTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 2
  return texture
}

export function canvasTexture(
  width: number, height: number, draw: (ctx: CanvasRenderingContext2D, rnd: () => number) => void,
): THREE.CanvasTexture {
  const build = canvasBuild(width, height)
  if (build.ctx) draw(build.ctx, build.rnd)
  return finishTexture(build.canvas)
}

/**
 * The sun, as a disc rather than a smudge: solid all the way to a hard edge, with
 * only enough taper that the rim does not crawl as the camera moves. The glare
 * around it is a separate sprite - a soft blob alone reads as a light source, but
 * it takes a hard edge to read as the sun.
 */
export function discTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, ctx => {
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
    gradient.addColorStop(0.88, 'rgba(255, 255, 255, 1)')
    gradient.addColorStop(0.96, 'rgba(255, 249, 234, 0.55)')
    gradient.addColorStop(1, 'rgba(255, 240, 214, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 128, 128)
  })
}

/**
 * The sun's crown: a fan of wedges around the core, every fourth one long, because
 * an even fan reads as a pinwheel and an uneven one reads as light.
 *
 * Drawn rather than photographed. The reference frames for this are stock pictures
 * with watermarks across them, and a sun does not need one anyway - it is a shape
 * this simple, and drawing it means it arrives without somebody else's sky behind
 * it.
 */
export function raysTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (ctx, rnd) => {
    ctx.translate(256, 256)
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < 112; i++) {
      const long = i % 4 === 0
      const angle = (i / 112) * TAU + (rnd() - 0.5) * 0.06
      const reach = long ? 190 + rnd() * 60 : 55 + rnd() * 145
      const half = (long ? 0.005 : 0.012) + rnd() * 0.015
      const gradient = ctx.createRadialGradient(0, 0, reach * 0.05, 0, 0, reach)
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0)')
      gradient.addColorStop(0.14, `rgba(255, 255, 255, ${(long ? 0.26 : 0.15).toFixed(3)})`)
      gradient.addColorStop(0.36, `rgba(255, 254, 250, ${(long ? 0.09 : 0.055).toFixed(3)})`)
      gradient.addColorStop(1, 'rgba(255, 252, 244, 0)')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(angle - half) * reach, Math.sin(angle - half) * reach)
      ctx.lineTo(Math.cos(angle + half) * reach, Math.sin(angle + half) * reach)
      ctx.closePath()
      ctx.fill()
    }
  })
}

/**
 * One ghost of a lens flare: a defocused disc with a brighter rim, which is what
 * a real one looks like - a flat blob reads as a decal, and the ring is what makes
 * it read as glass.
 */
export function flareTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, ctx => {
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.5)')
    gradient.addColorStop(0.6, 'rgba(255, 255, 255, 0.34)')
    gradient.addColorStop(0.84, 'rgba(255, 255, 255, 0.68)')
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 128, 128)
  })
}

/**
 * The light around the sun: bright against the core and falling away slowly, which
 * is the difference between a sun and a headlight. The glare in a photograph of a
 * real sun runs a long way out from the disc and gives up gradually, so the stops
 * are dense near the middle and thin towards the rim.
 */
export function sunGlowTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, ctx => {
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
    gradient.addColorStop(0, 'rgba(255, 254, 250, 1)')
    gradient.addColorStop(0.1, 'rgba(255, 252, 242, 1)')
    gradient.addColorStop(0.2, 'rgba(255, 250, 234, 0.95)')
    gradient.addColorStop(0.32, 'rgba(255, 248, 226, 0.78)')
    gradient.addColorStop(0.48, 'rgba(255, 246, 218, 0.5)')
    gradient.addColorStop(0.68, 'rgba(255, 244, 212, 0.24)')
    gradient.addColorStop(0.86, 'rgba(255, 242, 208, 0.07)')
    gradient.addColorStop(1, 'rgba(255, 240, 204, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 256, 256)
  })
}

export function glowTexture(inner: string, outer: string): THREE.CanvasTexture {
  return canvasTexture(256, 256, ctx => {
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
    gradient.addColorStop(0, inner)
    gradient.addColorStop(0.3, inner)
    gradient.addColorStop(1, outer)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 256, 256)
  })
}

/** A one-pixel texture of one colour: a placeholder that keeps a shader's shape. */
function flatTexture(r: number, g: number, b: number): THREE.CanvasTexture {
  const build = canvasBuild(1, 1)
  if (build.ctx) {
    build.ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
    build.ctx.fillRect(0, 0, 1, 1)
  }
  return finishTexture(build.canvas)
}

// --------------------------------------------------------------------- soil

/**
 * The ground underfoot: the reference build's own soil - grit and stones set in
 * it - painted on a canvas and tiled.
 *
 * A small tile on purpose. The eye is two metres off the ground and magnifies
 * whatever is under it by tens of times, so the only thing worth putting in a
 * texture is what is smaller than a boot; anything larger repeats often enough
 * to read as a pattern, and belongs in the vertex colours instead. At six metres
 * the tile holds gravel at 170 texels to the metre and repeats far too often at
 * ground level for the eye to catch it doing so.
 *
 * It also has to tile, and the reference build's did not: their stones were
 * drawn once at random positions and simply clipped wherever they met the canvas
 * edge, so repeating that texture printed a line of half-stones across the
 * ground at every tile. Every element here is stamped again on the far side
 * wherever it crosses an edge, so the copies meet.
 *
 * The same pass draws the stones a second time as flat domes, which is what
 * becomes the normal map. Relief has to come from somewhere, and all a painted
 * shadow can do two metres off the ground is look painted.
 */
const SOIL_TEXELS = 1024
/** metres of ground one tile covers at the landing site; sets the repeat below */
const SOIL_SPAN = 6
/**
 * Earth's floor is a photograph of mown grass rather than a brush stroke, and
 * its tile is five metres instead of six: the source was shot close enough that
 * a blade of grass is a few pixels wide, and at five metres a blade still lands
 * about the size it should be under a boot.
 */
const EARTH_GRASS_SPAN = 5
/** the tile, and the relief that lets it catch a low sun */
const EARTH_GRASS_COLOUR = '/textures/earth_grass.webp'
const EARTH_GRASS_RELIEF = '/textures/earth_grass_normal.webp'
/**
 * The slopes wear a second photograph - canopy - and it is a much wider tile than
 * the grass, because one tree crown is tens of metres across and a crown per five
 * metres would read as a pattern rather than a wood.
 */
const EARTH_CANOPY_SPAN = 16
const EARTH_CANOPY_COLOUR = '/textures/earth_canopy.webp'
const EARTH_CANOPY_RELIEF = '/textures/earth_canopy_normal.webp'
/**
 * How many times the tile wraps its world - measured at the landing site, so a
 * tile of the sphere's own UVs comes out square on the ground you actually walk
 * on. It is a property of the world, because Earth's site is a valley five and
 * a half times the size of a crater field.
 */
function soilRepeat(radius: number, lat: number, span = SOIL_SPAN): { x: number; y: number } {
  return {
    x: Math.max(1, Math.round((TAU * radius * Math.cos(lat)) / span)),
    y: Math.max(1, Math.round((Math.PI * radius) / span)),
  }
}

export interface SoilMaps {
  colour: THREE.Texture
  normal: THREE.Texture
  /** Earth only: the canopy that covers the slopes, which the shader mixes over the floor */
  canopy?: { colour: THREE.Texture; normal: THREE.Texture }
}

/**
 * Draw an element, and again on the far side wherever it would cross an edge:
 * nine draws at worst, one in the middle of the tile. Callers must not consume
 * random numbers inside `draw`, or the tile stops being reproducible.
 */
function stampWrapped(
  size: number, x: number, y: number, reach: number, draw: (x: number, y: number) => void,
): void {
  const xs = [x]
  const ys = [y]
  if (x - reach < 0) xs.push(x + size)
  if (x + reach > size) xs.push(x - size)
  if (y - reach < 0) ys.push(y + size)
  if (y + reach > size) ys.push(y - size)
  for (const px of xs) {
    for (const py of ys) draw(px, py)
  }
}

/** One stone in the soil, in colour and in relief. */
function paintStone(
  ctx: CanvasRenderingContext2D, depth: CanvasRenderingContext2D, size: number, rnd: () => number,
): void {
  const x = rnd() * size
  const y = rnd() * size
  const r = 2.9 + Math.pow(rnd(), 2.2) * 26
  const spin = rnd() * Math.PI
  // every stone a different shape: all of them the same ellipse is what makes a
  // scatter of grit read as a printed pattern
  const wide = 0.62 + rnd() * 0.5
  const flat = 0.45 + rnd() * 0.5
  // deliberately a light stone on a lighter ground: at fifty texels to the metre
  // a three-centimetre pebble is barely two texels across, and a dark one at that
  // size is a speck of noise rather than a stone. The relief is in the dome below
  // and the normal map that comes out of it - the colour only has to say "not
  // sand here".
  const grey = 98 + rnd() * 52
  const shadow = 0.13
  const lift = 0.09 + rnd() * 0.13
  const dome = 138 + Math.round(rnd() * 72)
  const reach = r * 1.5

  // the hollow it sits in, so it reads as set into the ground rather than on it
  ctx.fillStyle = `rgba(48, 24, 12, ${shadow})`
  stampWrapped(size, x, y, reach, (px, py) => {
    ctx.beginPath()
    ctx.ellipse(px + r * 0.34, py + r * 0.4, r * wide, r * flat, spin, 0, TAU)
    ctx.fill()
  })
  // the stone itself, cooler than the sand around it
  ctx.fillStyle = `rgb(${(grey + 26) | 0}, ${(grey * 0.95 + 16) | 0}, ${(grey * 0.92 + 12) | 0})`
  stampWrapped(size, x, y, reach, (px, py) => {
    ctx.beginPath()
    ctx.ellipse(px, py, r * wide, r * flat, spin, 0, TAU)
    ctx.fill()
  })
  // the facet that catches a low sun
  ctx.fillStyle = `rgba(255, 236, 206, ${lift})`
  stampWrapped(size, x, y, reach, (px, py) => {
    ctx.beginPath()
    ctx.ellipse(px - r * 0.2, py - r * 0.24, r * wide * 0.5, r * flat * 0.45, spin, 0, TAU)
    ctx.fill()
  })
  depth.fillStyle = `rgb(${dome}, ${dome}, ${dome})`
  stampWrapped(size, x, y, reach, (px, py) => {
    depth.beginPath()
    depth.ellipse(px, py, r * wide * 0.95, r * flat * 0.95, spin, 0, TAU)
    depth.fill()
  })
}

/**
 * The relief canvas as a normal map. Sobel over the domes, sampled with wrap so
 * the tile's own edges do not raise a ridge down the middle of the ground.
 */
function* soilNormal(
  source: HTMLCanvasElement, size: number, repeat: { x: number; y: number },
): Generator<void, THREE.CanvasTexture, void> {
  const src = source.getContext('2d')
  const out = document.createElement('canvas')
  out.width = size
  out.height = size
  const dst = out.getContext('2d')
  if (!src || !dst) return flatTexture(128, 128, 255)
  const input = src.getImageData(0, 0, size, size).data
  const image = dst.createImageData(size, size)
  const at = (x: number, y: number) => input[((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4] / 255
  const strength = 3.2
  for (let yStart = 0; yStart < size; yStart += 64) {
    const yEnd = Math.min(size, yStart + 64)
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength
        // the image's y runs against v, and the texture is flipped to match
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength
        const length = Math.hypot(dx, dy, 1)
        const i = (y * size + x) * 4
        image.data[i] = 128 + (-dx / length) * 127
        image.data[i + 1] = 128 + (dy / length) * 127
        image.data[i + 2] = 128 + (1 / length) * 127
        image.data[i + 3] = 255
      }
    }
    yield
  }
  dst.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(out)
  // a normal map carries directions, not colour, so it must not be sRGB-decoded
  texture.colorSpace = THREE.NoColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(repeat.x, repeat.y)
  texture.anisotropy = 8
  return texture
}

/**
 * Painted across frames like everything else on a surface: a quarter of a
 * million canvas operations is not a thing to do inside one frame.
 */
function* paintSoil(planet: PlanetDef): Generator<void, SoilMaps, void> {
  const planetId = planet.id
  const repeat = soilRepeat(planet.surfaceRadius, planet.landerLat)
  const size = SOIL_TEXELS
  const rnd = makeRnd(8123 + planetId)
  const colour = document.createElement('canvas')
  colour.width = size
  colour.height = size
  const ctx = colour.getContext('2d')
  const relief = document.createElement('canvas')
  relief.width = size
  relief.height = size
  const depth = relief.getContext('2d')
  if (!ctx || !depth) return { colour: finishTexture(colour), normal: flatTexture(128, 128, 255) }

  // bare soil, and the same grey on the relief canvas as its resting level. The
  // map is a detail layer rather than the colour: the planet's own palette is
  // multiplied over it, so the soil has to sit near white or the ground ends up
  // the product of two dark colours
  ctx.fillStyle = '#c9b49c'
  ctx.fillRect(0, 0, size, size)
  depth.fillStyle = '#808080'
  depth.fillRect(0, 0, size, size)
  yield

  // grit: the same trick at a tenth of the size, which is what stops the soil
  // reading as flat paint when it fills the whole screen
  for (let i = 0; i < 560; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const r = 1.6 + rnd() * 16.3
    const lighter = rnd() > 0.5
    const alpha = 0.026 + rnd() * 0.09
    ctx.fillStyle = lighter ? `rgba(236, 214, 182, ${alpha})` : `rgba(96, 62, 38, ${alpha})`
    stampWrapped(size, x, y, r, (px, py) => {
      ctx.beginPath()
      ctx.arc(px, py, r, 0, TAU)
      ctx.fill()
    })
    if (i % 80 === 0) yield
  }

  // and the stones sitting in it
  for (let i = 0; i < 100; i++) {
    paintStone(ctx, depth, size, rnd)
    if (i % 20 === 0) yield
  }
  yield

  const normal = yield* soilNormal(relief, size, repeat)
  const soil = finishTexture(colour)
  soil.wrapS = THREE.RepeatWrapping
  soil.wrapT = THREE.RepeatWrapping
  soil.repeat.set(repeat.x, repeat.y)
  soil.anisotropy = 8
  return { colour: soil, normal }
}

const soilMaps = new Map<number, SoilMaps>()

/**
 * Earth's floor is a photograph of mown grass rather than a brush stroke, and its
 * slopes are a second photograph of canopy. `load()` returns at once and fills the
 * textures in when the files arrive, so the terrain builds without waiting on the
 * network.
 *
 * Both tiles are graded before they ship, and the corrections come from the same
 * fact: each one repeats hundreds of times across a valley fifteen hundred metres
 * wide. Low frequencies are flattened, because a patch of shade would otherwise
 * print itself at a perfectly regular interval. And the tone is trimmed to sit
 * under the vertex colours rather than fight them, because this ground is green on
 * the palette's authority and all the tiles carry is the detail.
 *
 * The canopy is loaded without a repeat of its own - the shader derives its
 * coordinates from the grass tile's, because a mesh has one set of UVs and the two
 * tiles are different widths.
 */
function earthGrass(planet: PlanetDef): SoilMaps {
  const repeat = soilRepeat(planet.surfaceRadius, planet.landerLat, EARTH_GRASS_SPAN)
  const loader = new THREE.TextureLoader()
  const load = (url: string, srgb: boolean): THREE.Texture => {
    const texture = loader.load(url)
    // a normal map carries directions, not colour, so it must not be sRGB-decoded
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = 8
    return texture
  }
  const colour = load(EARTH_GRASS_COLOUR, true)
  const normal = load(EARTH_GRASS_RELIEF, false)
  for (const texture of [colour, normal]) texture.repeat.set(repeat.x, repeat.y)
  return {
    colour,
    normal,
    canopy: { colour: load(EARTH_CANOPY_COLOUR, true), normal: load(EARTH_CANOPY_RELIEF, false) },
  }
}

/**
 * Two ground textures on one mesh. The terrain is a single sphere under a single
 * material, so a second surface can only arrive through the shader: `forest` is a
 * per-vertex mask baked in the same pass that painted the colours, and the
 * fragment stage mixes the canopy over the grass by it.
 *
 * `vMapUv` is already the grass tile's transformed coordinate, so multiplying it by
 * the ratio of the two spans converts one tile's coordinates into the other's.
 * That ratio is constant across the world because both spans are measured at the
 * same latitude.
 */
/** how much ground one regolith tile covers, matching the reference's 1400/40 */
const REGOLITH_SPAN = 35

/**
 * The regolith tile repeats, and a repeated tile is a pattern - so the variation
 * that stops it reading as one is done in the shader, in world space, where it
 * cannot repeat at all: three octaves of fbm bending the brightness, plus the
 * sparkle of glassy beads welded into the soil, which is a real thing you find
 * in lunar regolith and catches the sun as small hard points.
 *
 * World space rather than UV, because UV repeats with the tile and the whole
 * point is to have something that does not.
 */
function sprinkleRegolith(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundPos = (modelMatrix * vec4(position, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGroundPos;
float grain(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float grainNoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(grain(i), grain(i + vec2(1.0, 0.0)), u.x),
	           mix(grain(i + vec2(0.0, 1.0)), grain(i + vec2(1.0, 1.0)), u.x), u.y);
}
float grainFbm(vec2 p) {
	float v = 0.0;
	float amp = 0.5;
	for (int i = 0; i < 4; i++) { v += amp * grainNoise(p); p *= 2.0; amp *= 0.5; }
	return v;
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
	float broad = grainFbm(vGroundPos.xz * 0.02);
	float middle = grainFbm(vGroundPos.xz * 0.09 + 17.3);
	float fine = grainFbm(vGroundPos.xz * 0.45 + 53.1);
	diffuseColor.rgb *= 0.88 + (broad * 0.5 + middle * 0.35 + fine * 0.15) * 0.26;
	float bead = step(0.9987, grain(floor(vGroundPos.xz * 3.7)));
	diffuseColor.rgb += vec3(bead) * 0.12;`)
  }
  material.customProgramCacheKey = () => 'lunar-regolith'
}

function blendCanopy(material: THREE.MeshStandardMaterial, canopy: SoilMaps, uvScale: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.canopyMap = { value: canopy.colour }
    shader.uniforms.canopyNormalMap = { value: canopy.normal }
    shader.uniforms.canopyUvScale = { value: uvScale }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float forest;\nvarying float vForest;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvForest = forest;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D canopyMap;
uniform sampler2D canopyNormalMap;
uniform float canopyUvScale;
varying float vForest;`)
      .replace('#include <map_fragment>', `#ifdef USE_MAP
	diffuseColor *= mix(
		texture2D( map, vMapUv ),
		texture2D( canopyMap, vMapUv * canopyUvScale ),
		vForest
	);
#endif`)
      .replace('#include <normal_fragment_maps>', `#ifdef USE_NORMALMAP_TANGENTSPACE
	vec3 mapN = normalize( mix(
		texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0,
		texture2D( canopyNormalMap, vNormalMapUv * canopyUvScale ).xyz * 2.0 - 1.0,
		vForest
	) );
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
#endif`)
  }
  // the shader is built from strings, so the program cache needs telling that this
  // material is not the plain one
  material.customProgramCacheKey = () => 'earth-ground-canopy'
}

/** Loaded or painted once per session: a surface is rebuilt on every landing. */
function* soilTextures(planet: PlanetDef): Generator<void, SoilMaps, void> {
  const cached = soilMaps.get(planet.id)
  if (cached) return cached
  // only Earth's floor has a source photograph; the other two are still painted
  if (planet.theme === 'earth') {
    const maps = earthGrass(planet)
    soilMaps.set(planet.id, maps)
    return maps
  }
  const maps = yield* paintSoil(planet)
  soilMaps.set(planet.id, maps)
  return maps
}

export function dir(lat: number, lon: number, target = new THREE.Vector3()): THREE.Vector3 {
  const cosLat = Math.cos(lat)
  return target.set(cosLat * Math.cos(lon), Math.sin(lat), cosLat * Math.sin(lon))
}

export function surfacePoint(lat: number, lon: number, radius: number, target = new THREE.Vector3()): THREE.Vector3 {
  return dir(lat, lon, target).multiplyScalar(radius)
}

/** Angular distance from the landing pad, used to keep props out of the way. */
function padDistance(lat: number, lon: number, site: { lat: number; lon: number }): number {
  let dLon = lon - site.lon
  dLon = ((dLon + Math.PI * 3) % TAU) - Math.PI
  return Math.hypot(lat - site.lat, Math.cos(lat) * dLon)
}

function placeProp(
  dummy: THREE.Object3D, radiusOf: (lat: number, lon: number) => number, lat: number, lon: number,
  lift: number, scale: number, rnd: () => number,
) {
  dir(lat, lon, scratchDir)
  dummy.position.copy(scratchDir).multiplyScalar(radiusOf(lat, lon) + lift)
  dummy.quaternion.setFromUnitVectors(UP, scratchDir)
  dummy.rotateY(rnd() * TAU)
  dummy.rotateX((rnd() - 0.5) * 0.5)
  dummy.scale.set(scale, scale * (0.6 + rnd() * 0.5), scale)
  dummy.updateMatrix()
}

function placeGroup(
  group: THREE.Object3D, radiusOf: (lat: number, lon: number) => number, lat: number, lon: number,
  lift: number, yaw: number,
) {
  dir(lat, lon, scratchDir)
  group.position.copy(scratchDir).multiplyScalar(radiusOf(lat, lon) + lift)
  group.quaternion.setFromUnitVectors(UP, scratchDir)
  group.rotateY(yaw)
}

// ----------------------------------------------------------------- terrain

/**
 * The displaced, vertex-coloured planet sphere: the terrain mesh is generated
 * `LOD_TERRAIN_SLICE` vertices at a time. The geometry is rewritten in place, so
 * the original directions are copied out first.
 *
 * The grid is the world's own, because the world's size is its own. Six metres a
 * segment on a 550 m ball is what it takes for a forty-metre river to read as a
 * channel rather than a notch; the small worlds carry crater lips, which need
 * 2.7. Either way the whole ball stays one mesh and one draw call.
 */
function terrainGrid(radius: number, spacing: number): { x: number; y: number } {
  if (radius <= 200) return { x: 224, y: 144 }
  return {
    x: Math.round((TAU * radius) / spacing),
    y: Math.round((Math.PI * radius) / spacing),
  }
}

/**
 * The ground as the mesh draws it, rather than as the function computes it.
 *
 * The terrain is a ball of vertices ten metres apart, so what you stand on is
 * the flat triangle between three of them, not the curve they were sampled from.
 * On the valley floor the two agree to within a hand's breadth. But the
 * landscape carries detail finer than the grid - the high ground especially, and
 * the river's cut bank - and there the triangle sits as much as two and a half
 * metres away from the curve it approximates. Anything planted on the curve
 * therefore hangs in the air above the surface actually drawn.
 *
 * This walks the same lattice in the same order with the same split across each
 * quad, which is the only way to ask the question the renderer answers.
 */
function meshGround(planet: PlanetDef, seed: number) {
  const grid = terrainGrid(planet.surfaceRadius, planet.surfaceSpacing ?? 10)
  const across = grid.x + 1
  const heights = new Map<number, number>()
  const corner = (ix: number, iy: number): number => {
    const key = iy * across + ix
    const held = heights.get(key)
    if (held !== undefined) return held
    const theta = (iy / grid.y) * Math.PI
    // the same vertex the sphere, and so the mesh, actually places: its longitude
    // runs the other way round from atan2(z, x), which is how the terrain stage
    // reads it back out
    const ring = Math.sin(theta)
    const phi = ((((ix % grid.x) + grid.x) % grid.x) / grid.x) * TAU
    const height = terrainHeight(
      Math.asin(clampValue(Math.cos(theta), -1, 1)),
      Math.atan2(ring * Math.sin(phi), -ring * Math.cos(phi)),
      seed, planet.id,
    )
    heights.set(key, height)
    return height
  }
  return (lat: number, lon: number): number => {
    const row = clampValue(((Math.PI / 2 - lat) / Math.PI) * grid.y, 0, grid.y)
    let phi = Math.atan2(Math.sin(lon), -Math.cos(lon))
    if (phi < 0) phi += TAU
    const column = (phi / TAU) * grid.x
    const ix = Math.min(grid.x - 1, Math.floor(column))
    const iy = Math.min(grid.y - 1, Math.floor(row))
    const fx = column - ix
    const fy = row - iy
    const a = corner(ix, iy)
    const b = corner(ix, iy + 1)
    const c = corner(ix + 1, iy + 1)
    const d = corner(ix + 1, iy)
    // three splits each quad from its north-west corner to its south-east one
    const height = fx + fy <= 1
      ? a + (d - a) * fx + (b - a) * fy
      : c + (b - c) * (1 - fx) + (d - c) * (1 - fy)
    return planet.surfaceRadius + height
  }
}

function* terrainStage(planet: PlanetDef, seed: number, group: THREE.Group): Generator<void, void, void> {
  const surfaceRadius = planet.surfaceRadius
  const grid = terrainGrid(surfaceRadius, planet.surfaceSpacing ?? 10)
  /** one segment of the grid in metres: how far along the ground a slope is read */
  const step = (TAU * surfaceRadius) / grid.x
  const geometry = new THREE.SphereGeometry(surfaceRadius, grid.x, grid.y)
  const position = geometry.attributes.position
  const source = Float32Array.from(position.array as ArrayLike<number>)
  const colors = new Float32Array(position.count * 3)
  const forests = new Float32Array(position.count)
  const low = new THREE.Color(planet.groundLow)
  const high = new THREE.Color(planet.groundHigh)
  const rock = new THREE.Color(planet.rock)
  const forest = new THREE.Color(0x2a5a20)
  const vertex = new THREE.Vector3()
  const color = new THREE.Color()
  const design = { x: 0, z: 0 }

  for (let start = 0; start < position.count; start += LOD_TERRAIN_SLICE) {
    const end = Math.min(position.count, start + LOD_TERRAIN_SLICE)
    for (let i = start; i < end; i++) {
      vertex.set(source[i * 3], source[i * 3 + 1], source[i * 3 + 2]).normalize()
      const lat = Math.asin(clampValue(vertex.y, -1, 1))
      const lon = Math.atan2(vertex.z, vertex.x)
      const height = terrainHeight(lat, lon, seed, planet.id)
      const r = surfaceRadius + height
      position.setXYZ(i, vertex.x * r, vertex.y * r, vertex.z * r)
      // read in the landscape's own units, so the bands below are the ones the
      // design was tuned at rather than sizes that follow the world about. Earth
      // and the Moon are both authored in real metres and read them directly;
      // Mars was composed against a ball of radius 55 and still arrives divided
      // by the scale that carried it up
      const earth = planet.theme === 'earth'
      const real = planet.theme !== 'mars'
      const h = real ? height : height / SURFACE_SCALE
      const ahead = terrainHeight(lat, lon + step / (surfaceRadius * Math.cos(lat)), seed, planet.id)
      const run = real ? step : 1.4 * SURFACE_SCALE
      const slope = clampValue(Math.abs(ahead - height) / run, 0, 1)

      if (planet.theme === 'moon') {
        /**
         * The reference shades its ground from the crater field rather than from
         * height: fresh ejecta around every rim comes up bright, the floors of
         * the older bowls go slightly darker, and the patchwork underneath is
         * noise at two scales. Height would paint the whole plain one colour and
         * the craters would vanish into it.
         */
        moonDesignPoint(planet.landerLat, planet.landerLon, lat, lon, surfaceRadius, design)
        const craters = moonCraterFieldAt(design.x, design.z)
        let brightness = 0.82
          + moonFieldNoise(design.x * 0.006 + 4.1, design.z * 0.006 + 8.3) * 0.22
          + moonFieldNoise(design.x * 0.025 + 17.7, design.z * 0.025 + 2.9) * 0.08
        if (craters > 0.3) brightness *= 1.04 + Math.min(craters, 2.5) * 0.025
        if (craters < -0.4) brightness *= 0.95
        brightness *= 1 - slope * 0.055
        color.setRGB(brightness, brightness * 0.998, brightness * 0.992)
      } else if (earth) {
        // grass on the floor, forest on the shoulders, bare rock on the steep
        // faces - and the rock is read from steepness rather than height, which
        // is the only way a cliff and the paddy beneath it are different colour
        color.copy(low).lerp(high, clampValue((h + 6) / 24, 0, 1))
        if (h > 12) color.lerp(forest, clampValue((h - 12) / 60, 0, 1) * 0.4)
        color.lerp(rock, slope * 0.55)
        const patch = (valueNoise(lon * 9, lat * 9, seed ^ 0x51ed270b) - 0.5) * 0.16
          + (valueNoise(lon * 31, lat * 31, seed ^ 0x2f1b3c) - 0.5) * 0.08
        color.offsetHSL(0, 0, patch)
        // where the canopy takes over. Uncapped, this is the same curve that just
        // tinted the colour toward forest; the wobble keeps the treeline a ragged
        // edge rather than a height contour, and it keeps the floor clear.
        forests[i] = clampValue(
          (h - 8) / 34 + (valueNoise(lon * 26, lat * 26, seed ^ 0x7f3a91) - 0.5) * 0.5, 0, 1,
        )
      } else {
        const t = clampValue((h + 2.5) / 10, 0, 1)
        color.copy(low).lerp(high, t)
        // Mars: sand in the floor of the field, rock up on the ring and on
        // anything steep. Height alone would paint the ring the same bright
        // dust as the dunes, and a sunward crest of bright dust blows out to
        // white and stops reading as a mountain at all.
        color.lerp(rock, slope * 0.5)
        if (h > 7) color.lerp(rock, clampValue((h - 7) / 16, 0, 0.6))
        // the mottling, which lives here rather than in the soil tile: the
        // ground's tone changes over metres, and a tile small enough to be
        // sharp under a boot is far too small to hold a patch of ground this
        // size without printing its pattern across the field
        const patch = (valueNoise(lon * 7, lat * 7, seed ^ 0x51ed270b) - 0.5) * 0.2
          + (valueNoise(lon * 23, lat * 23, seed ^ 0x2f1b3c) - 0.5) * 0.1
        color.offsetHSL(0, 0, patch)
      }
      colors.set([color.r, color.g, color.b], i * 3)
    }
    yield
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  if (planet.theme === 'earth') geometry.setAttribute('forest', new THREE.BufferAttribute(forests, 1))
  geometry.computeVertexNormals()
  let painted: THREE.MeshStandardMaterial
  if (planet.theme === 'moon') {
    /**
     * The reference's regolith tile, over the whole ball. One tile is
     * thirty-five metres of ground - the same coverage the reference gives it -
     * and the fine variation is left to the shader rather than baked into the
     * tile, because a tile sharp enough to read under a boot is far too small to
     * cover this much ground without printing itself across it.
     */
    const regolith = regolithTexture(1024)
    regolith.wrapS = THREE.RepeatWrapping
    regolith.wrapT = THREE.RepeatWrapping
    // a tile every thirty-five metres is minified hard under any camera that can
    // see more than a few paces of it, and at a grazing angle the trilinear
    // filter alone bands into diagonal stripes across the whole plain. Anisotropy
    // is what buys the ground back
    regolith.anisotropy = 8
    const repeats = (TAU * surfaceRadius) / REGOLITH_SPAN
    regolith.repeat.set(repeats, repeats * 0.5)
    painted = new THREE.MeshStandardMaterial({
      map: regolith, vertexColors: true, roughness: 0.96, metalness: 0,
    })
    sprinkleRegolith(painted)
  } else {
    // the detail map: dust and grit on Mars, blades and clumps on Earth, and a
    // normal map out of the same pass. Smooth-shaded on purpose - flat shading
    // takes its normals from the geometry's derivatives and leaves a normal map
    // nowhere to sit, and the normal map is where the close-up detail lives.
    const soil = yield* soilTextures(planet)
    painted = new THREE.MeshStandardMaterial({
      map: soil.colour, normalMap: soil.normal, vertexColors: true, roughness: 1, metalness: 0,
    })
    if (soil.canopy) blendCanopy(painted, soil.canopy, EARTH_GRASS_SPAN / EARTH_CANOPY_SPAN)
  }
  const ground = new THREE.Mesh(geometry, painted)
  ground.name = TERRAIN_NAME
  group.add(ground)
  yield
}

/**
 * Stars for the airless sky.
 *
 * The radius has to clear the world it hangs over, and that is not a constant:
 * the Moon is a ball of eight hundred metres now, and a star field at six
 * hundred is inside the ground. So it is measured off the world instead. With no
 * air to scatter them, they are also the only thing up there that is not the sun
 * or the Earth, which is why there are enough of them to be worth looking up at.
 */
function buildStarField(surfaceRadius: number): THREE.Points {
  const count = 1600
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const rnd = makeRnd(8642)
  const inner = surfaceRadius * 2.6
  const spread = surfaceRadius * 0.9

  for (let i = 0; i < count; i++) {
    const star = scratchDir.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1)
    if (star.lengthSq() < 1e-6) star.set(0, 1, 0)
    star.normalize().multiplyScalar(inner + rnd() * spread)
    positions.set([star.x, star.y, star.z], i * 3)

    // most are faint and a few are not, which is what a real sky looks like; the
    // scatter of colour is the difference between a hot blue-white star and a
    // cooler one, and without it a star field reads as noise
    const brightness = 0.35 + Math.pow(rnd(), 2.4) * 0.65
    const warmth = (rnd() - 0.5) * 0.16
    colors.set([brightness * (1 + warmth), brightness, brightness * (1 - warmth)], i * 3)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 2.6, sizeAttenuation: false, vertexColors: true,
    fog: false, transparent: true, opacity: 0.95, depthWrite: false,
  }))
}

/**
 * The ground's name is how the shadow pass tells it apart from everything standing
 * on it (see markShadows).
 */
const TERRAIN_NAME = 'terrain'

/**
 * Shadows, applied once to a finished surface rather than at each of the thirty
 * meshes that make one up: everything standing on the ground receives, and
 * everything solid casts.
 *
 * Two things opt out. The ground itself, because it is four hundred thousand
 * triangles and the shadow box is a hundred and forty metres across, so feeding
 * the whole ball into the shadow map every frame would buy a silhouette that the
 * box cannot even reach. And anything transparent, because a landing ring is
 * light rather than an object and has no business casting one.
 */
function markShadows(root: THREE.Object3D, planet: PlanetDef) {
  /**
   * The Moon's ground casts; Earth's does not.
   *
   * Both are the same order of size - four hundred thousand triangles - and both
   * are one mesh whose bounds are the whole ball, so neither can ever be culled
   * out of the shadow pass and both cost the same. What differs is what it buys.
   * On Earth the shadow camera covers a hundred and forty metres of a valley that
   * rolls a few metres, so the ground has no silhouette worth having. On the Moon
   * every crater wall is a silhouette and the sun is twenty-two degrees up, so
   * crater floors that never see the sun are most of what the surface is.
   */
  const terrainCasts = planet.theme === 'moon'
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const material = mesh.material as THREE.Material | THREE.Material[]
    const entries = Array.isArray(material) ? material : [material]
    /**
     * Three kinds of thing stand on a surface and they want three answers. Solid
     * geometry casts and catches. A cut-out casts but does not catch - a crossed
     * card is two flat quads with their normals turned to face the sky, and the
     * normal offset that normally stops a surface shadowing itself needs a normal
     * with some lean on the sun; pointing straight up under a sun seventeen
     * degrees over the horizon it buys nothing, and without it the cards shade
     * themselves into a screen door of shadow-map texels. The only bias that
     * clears that is one big enough to detach every shadow from the thing casting
     * it, which is worse. And anything see-through catches but never casts: water
     * is light passing through, and a landing ring is light, and light has no
     * shadow.
     */
    const cutOut = entries.some(entry => entry.alphaTest > 0)
    const seeThrough = entries.some(entry => entry.transparent)
    mesh.castShadow = (object.name !== TERRAIN_NAME || terrainCasts) && !seeThrough
    mesh.receiveShadow = !cutOut
  })
}

// ------------------------------------------------------------------- props

/**
 * Moving water needs something to move, and the river is drawn as a ribbon with
 * no texture at all. This is a small tiling ripple with a normal map's channels:
 * the same whole-cycle trick as the soil tile, so it repeats without a seam, and
 * the caller scrolls it along the channel each frame.
 */
let riverRipple: THREE.CanvasTexture | null = null

export function riverFlow(): THREE.CanvasTexture {
  if (riverRipple) return riverRipple
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const data = ctx.createImageData(size, size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size
        const v = y / size
        const wave = Math.sin((u * 4 + v * 2) * TAU) * 0.5 + Math.sin((u * 7 - v * 5) * TAU) * 0.5
        const slope = clampValue(128 + wave * 46, 0, 255) | 0
        const i = (y * size + x) * 4
        data.data[i] = 128
        data.data[i + 1] = slope
        data.data[i + 2] = 255
        data.data[i + 3] = 255
      }
    }
    ctx.putImageData(data, 0, 0)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = 8
  riverRipple = texture
  return texture
}

/**
 * The river, as a ribbon laid along the meander.
 *
 * The channel is carved into the terrain, but the grid is ten metres a segment
 * and the river is forty across, so the carve on its own reads as a fold in the
 * ground. This is the water: a strip of quads following the spline, each pair
 * sitting at the height the meander carries there, so the river steps down the
 * valley the way water does instead of standing at one level like a canal.
 */
function buildRiver(planet: PlanetDef): THREE.Mesh {
  const radius = planet.surfaceRadius
  const samples = riverSamples()
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const vertex = new THREE.Vector3()
  let along = 0

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const prev = samples[Math.max(0, i - 1)]
    const next = samples[Math.min(samples.length - 1, i + 1)]
    // the meander's own direction, so the ribbon stays square to it
    const dx = next.x - prev.x
    const dz = next.z - prev.z
    const length = Math.hypot(dx, dz) || 1
    const half = s.width * 0.85
    if (i > 0) along += Math.hypot(s.x - prev.x, s.z - prev.z)
    // v runs downstream in metres, so the ripple scrolls at the same rate the
    // river falls however wide it gets
    const v = along / 9
    for (const side of [-1, 1]) {
      const at = fromPad(
        planet.landerLat, planet.landerLon,
        (s.z - PAD_ORIGIN.z) + (dx / length) * half * side,
        (s.x - PAD_ORIGIN.x) - (dz / length) * half * side,
        radius,
      )
      dir(at.lat, at.lon, vertex).multiplyScalar(radius + s.water)
      positions.push(vertex.x, vertex.y, vertex.z)
      uvs.push(side < 0 ? 0 : 1, v)
    }
    if (i > 0) {
      const a = (i - 1) * 2
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0x4a7aaa, roughness: 0.16, metalness: 0.05,
    normalMap: riverFlow(), normalScale: new THREE.Vector2(0.5, 0.5),
    transparent: true, opacity: 0.86, side: THREE.DoubleSide,
  }))
}

/**
 * A cut-out card, for a tree or a bush. Cut, not blended: thousands of these
 * facing every which way would need a sort order that cannot exist, and cutting
 * gives the depth buffer something to write. With MSAA on, alpha-to-coverage
 * softens the cut so leaves do not come out as a jagged stencil.
 */
/** one upload per file per session, however many times a surface is rebuilt */
const billboardTextures = new Map<string, THREE.Texture>()

function billboardMaterial(file: string): THREE.MeshStandardMaterial {
  let map = billboardTextures.get(file)
  if (!map) {
    map = new THREE.TextureLoader().load(`/textures/${file}.webp`)
    map.colorSpace = THREE.SRGBColorSpace
    map.anisotropy = 8
    billboardTextures.set(file, map)
  }
  return new THREE.MeshStandardMaterial({
    map, side: THREE.FrontSide, roughness: 1, metalness: 0, alphaTest: 0.35, alphaToCoverage: true,
  })
}

/**
 * Two quads crossed at right angles, sharing a bottom-centre origin.
 *
 * Each quad is indexed twice, once each way round, so the card is solid from both
 * sides without `DoubleSide` - which would flip the normal on the back face and
 * leave half of every tree facing the ground and unlit.
 *
 * Normals point straight up, all of them. A tree cut from a picture already has
 * its shading painted in, so lighting it as a surface fights the image; lit as
 * ground it takes the sun's colour and no more, which is what a billboard wants.
 */
function crossTreeGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5,
  ], 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1,
  ], 2))
  const normals = new Float32Array(24)
  for (let i = 0; i < 8; i++) normals[i * 3 + 1] = 1
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setIndex([
    0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7,
    2, 1, 0, 3, 2, 0, 6, 5, 4, 7, 6, 4,
  ])
  return geometry
}

/** the crossed card that every tree and every plant stands on */
const billboardCard = crossTreeGeometry()

/**
 * The undergrowth: bushes and flowers, shared by the wild beds out in the meadow
 * and the gardens beside the cottages, because those are the same plants put down
 * by different hands. `fill` is how much of the tile the plant occupies, so a card
 * has to stand taller than the plant by that much for its base to meet the ground.
 */
const PLANTS = [
  { file: 'plant_1', fill: 0.75, height: [1.1, 2.0] as const },
  { file: 'plant_2', fill: 0.62, height: [0.45, 0.75] as const },
  { file: 'plant_3', fill: 0.61, height: [0.8, 1.4] as const },
  { file: 'plant_4', fill: 0.87, height: [0.7, 1.2] as const },
  { file: 'plant_5', fill: 0.62, height: [0.35, 0.6] as const },
  { file: 'plant_6', fill: 0.64, height: [0.35, 0.6] as const },
  { file: 'plant_7', fill: 0.67, height: [0.9, 1.6] as const },
]

function* earthPropStage(
  planet: PlanetDef, seed: number, radiusOf: (lat: number, lon: number) => number, group: THREE.Group,
): Generator<void, void, void> {
  const rnd = makeRnd(seed ^ 0x51a7c3)
  const radius = planet.surfaceRadius
  const dummy = new THREE.Object3D()
  const at = { lat: 0, lon: 0 }

  /**
   * Trees grow where trees grow, which is not "everywhere at random": the peaks
   * are forested to their shoulders and bare above, the floor is meadow with a
   * few isolated trees standing in it, and the riverbanks carry their own line.
   * Placement is decided in the design's own metres and converted, because that
   * is the only frame in which "on the shoulder of a peak" means anything.
   */
  /**
   * Five species rather than one shape a thousand times. A hillside of identical
   * cards reads as a pattern, not a forest, and the variety costs nothing - a
   * species is one instanced draw call, where the geometry it replaces needed two.
   */
  const SPECIES = [
    // `fill` is how much of the tile's height the tree occupies, so the quad has
    // to stand taller than the tree by that much for the trunk to meet the ground
    { file: 'tree_1', fill: 0.96, height: [12, 20] as const },
    { file: 'tree_2', fill: 0.96, height: [10, 17] as const },
    { file: 'tree_3', fill: 0.88, height: [14, 24] as const },
    // several trunks in one picture rather than a single tree, so it reads as a
    // thicket - which is what the top of a treeline actually looks like
    { file: 'tree_4', fill: 0.80, height: [9, 15] as const },
    { file: 'tree_5', fill: 0.96, height: [11, 18] as const },
  ]
  const capacity = 900
  const kinds = SPECIES.map((species) => ({
    species,
    mesh: new THREE.InstancedMesh(billboardCard, billboardMaterial(species.file), capacity),
    count: 0,
  }))
  const tint = new THREE.Color()

  let trees = 0
  let attempts = 0
  while (trees < 2400 && attempts < 26000) {
    attempts++
    const north = (rnd() * 2 - 1) * 760
    const east = (rnd() * 2 - 1) * 760
    const point = fromPad(planet.landerLat, planet.landerLon, north, east, radius)
    at.lat = point.lat
    at.lon = point.lon
    if (padDistance(at.lat, at.lon, landerSite(planet.id)) < 0.02) continue
    // nothing grows in the water: the trees were planted by looking at the
    // ground and never at the river, so some of them stood in the channel
    if (riverDistance(north, east) < 26) continue
    const height = radiusOf(at.lat, at.lon) - radius
    // the treeline: forest thins out as it climbs and stops at the rock, so the
    // peaks read as wooded shoulders under bare stone rather than as pines to
    // the summit
    if (height > 150) continue
    const treeline = clampValue((150 - height) / 55, 0, 1)
    if (height > 8 && rnd() > treeline) continue
    if (height < 8 && rnd() > 0.05) continue

    // what grows where: which species a height band favours, and how often. The
    // meadow gets the broadleaves, the treeline thins into thickets, and the
    // slopes between them take everything.
    const bands = height < 8 ? [0, 0, 1, 4] : height > 105 ? [3, 3, 2, 0] : [1, 4, 2, 0, 3]
    const kind = kinds[bands[Math.floor(rnd() * bands.length)]]
    if (kind.count >= capacity) continue

    const species = kind.species
    const treeHeight = species.height[0] + rnd() * (species.height[1] - species.height[0])
    dir(at.lat, at.lon, scratchDir)
    // the card's origin is its bottom edge, so the tree stands on the ground
    // rather than through it. Its up runs along the radial, which is what keeps a
    // tree on a slope growing at the sky instead of out of the hillside.
    dummy.position.copy(scratchDir).multiplyScalar(radiusOf(at.lat, at.lon))
    dummy.quaternion.setFromUnitVectors(UP, scratchDir)
    dummy.rotateY(rnd() * TAU)
    dummy.scale.setScalar(treeHeight / species.fill)
    dummy.updateMatrix()
    kind.mesh.setMatrixAt(kind.count, dummy.matrix)
    // and every tree its own shade, so the wood is not one flat green
    tint.setScalar(0.86 + rnd() * 0.28)
    kind.mesh.setColorAt(kind.count, tint)
    kind.count++
    trees++
    if (trees % LOD_PROP_SLICE === 0) yield
  }
  for (const kind of kinds) {
    kind.mesh.count = kind.count
    kind.mesh.instanceMatrix.needsUpdate = true
    if (kind.mesh.instanceColor) kind.mesh.instanceColor.needsUpdate = true
    group.add(kind.mesh)
  }
  yield

  /**
   * Rocks in three shapes rather than one, and bushes among them: what the
   * ground needs at this size is a scatter that does not read as a scatter. The
   * reference valley has boulders along the water, outcrops on the slopes and
   * scrub in between, and each of those is a different silhouette.
   */
  const STONES = [
    { geometry: new THREE.IcosahedronGeometry(0.9, 0), flat: 1.0 },
    { geometry: new THREE.DodecahedronGeometry(0.85, 0), flat: 0.8 },
    { geometry: new THREE.BoxGeometry(1.5, 0.8, 1.1), flat: 0.6 },
  ]
  const stones = STONES.map((stone) => ({
    mesh: new THREE.InstancedMesh(
      stone.geometry,
      new THREE.MeshStandardMaterial({ color: planet.rock, flatShading: true }),
      220,
    ),
    flat: stone.flat,
    count: 0,
  }))
  let rocks = 0
  let attempts2 = 0
  while (rocks < 480 && attempts2 < 9000) {
    attempts2++
    const north = (rnd() * 2 - 1) * 700
    const east = (rnd() * 2 - 1) * 700
    const point = fromPad(planet.landerLat, planet.landerLon, north, east, radius)
    const height = radiusOf(point.lat, point.lon) - radius
    const nearRiver = riverDistance(north, east)
    // boulders belong on the slopes and along the water, but not in it
    if (nearRiver < riverHalfWidth(north, east) + 4) continue
    if (height < 6 && nearRiver > 30) continue
    const stone = stones[Math.floor(rnd() * stones.length)]
    if (stone.count >= 220) continue
    placeProp(dummy, radiusOf, point.lat, point.lon, 0.2, (0.8 + rnd() * 3.4) * stone.flat, rnd)
    stone.mesh.setMatrixAt(stone.count, dummy.matrix)
    stone.count++
    rocks++
    if (rocks % LOD_PROP_SLICE === 0) yield
  }
  for (const stone of stones) {
    stone.mesh.count = stone.count
    stone.mesh.instanceMatrix.needsUpdate = true
    group.add(stone.mesh)
  }
  yield

  /**
   * The wild beds: bushes and flowers out in the meadow, on the same crossed cards
   * as the trees.
   *
   * Each bed is ONE species. That is the difference between a field and a weed
   * patch - a slope of a single flower reads as planted, massed and deliberate,
   * the way a flower farm looks, where a bed of everything at once only reads as
   * overgrown. The beds themselves are scattered rather than laid out, so the
   * planting still wanders wherever the ground suits it.
   */
  const plantCapacity = 6000
  const plantKinds = PLANTS.map((species) => ({
    species,
    mesh: new THREE.InstancedMesh(billboardCard, billboardMaterial(species.file), plantCapacity),
    count: 0,
  }))

  let planted = 0
  for (let beds = 0; beds < 1700 && planted < 33000; beds++) {
    const bedNorth = (rnd() * 2 - 1) * 730
    const bedEast = (rnd() * 2 - 1) * 730
    const centre = fromPad(planet.landerLat, planet.landerLon, bedNorth, bedEast, radius)
    if (padDistance(centre.lat, centre.lon, landerSite(planet.id)) < 0.04) continue
    // undergrowth belongs to the meadow. It thins as the ground climbs, and the
    // slopes above are wooded anyway, so a bed up there would be lost in the wood
    const climb = radiusOf(centre.lat, centre.lon) - radius
    if (rnd() > clampValue((55 - climb) / 45, 0, 1)) continue

    const kind = plantKinds[Math.floor(rnd() * plantKinds.length)]
    const spread = 6 + rnd() * 12
    const howMany = 12 + Math.floor(rnd() * 20)
    if (kind.count + howMany > plantCapacity) continue
    for (let i = 0; i < howMany && planted < 33000; i++) {
      const north = bedNorth + (rnd() * 2 - 1) * spread
      const east = bedEast + (rnd() * 2 - 1) * spread
      // clear of the water, not merely clear of the line it runs along: the
      // ribbon reaches 0.85 of the local half-width either side, which at a bend
      // is most of twenty metres
      if (riverDistance(north, east) < riverHalfWidth(north, east) + 3) continue
      const point = fromPad(planet.landerLat, planet.landerLon, north, east, radius)
      if (padDistance(point.lat, point.lon, landerSite(planet.id)) < 0.02) continue
      const species = kind.species
      const size = species.height[0] + rnd() * (species.height[1] - species.height[0])
      dir(point.lat, point.lon, scratchDir)
      dummy.position.copy(scratchDir).multiplyScalar(radiusOf(point.lat, point.lon))
      dummy.quaternion.setFromUnitVectors(UP, scratchDir)
      dummy.rotateY(rnd() * TAU)
      dummy.scale.setScalar(size / species.fill)
      dummy.updateMatrix()
      kind.mesh.setMatrixAt(kind.count, dummy.matrix)
      tint.setScalar(0.88 + rnd() * 0.24)
      kind.mesh.setColorAt(kind.count, tint)
      kind.count++
      planted++
    }
    if (beds % 40 === 0) yield
  }
  for (const kind of plantKinds) {
    kind.mesh.count = kind.count
    kind.mesh.instanceMatrix.needsUpdate = true
    if (kind.mesh.instanceColor) kind.mesh.instanceColor.needsUpdate = true
    group.add(kind.mesh)
  }
  yield
}

/** A dead rover: flat hull, four wheels, a tilted deck and a bent mast. */
function buildRoverWreck(): THREE.Group {
  const group = new THREE.Group()
  const hull = new THREE.MeshStandardMaterial({ color: 0xcdd3dc, roughness: 0.7, metalness: 0.25, flatShading: true })
  const panel = new THREE.MeshStandardMaterial({ color: 0x2f4f8f, roughness: 0.5, metalness: 0.4, flatShading: true })
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, 1.8), hull)
  body.position.y = 0.62
  group.add(body)
  for (const side of [-1, 1]) {
    for (const z of [-0.7, 0.7]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 8), hull)
      wheel.rotation.z = Math.PI / 2
      wheel.position.set(side * 1.32, 0.44, z)
      group.add(wheel)
    }
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 1.1), panel)
  deck.position.set(0, 1.16, 0.1)
  deck.rotation.set(-0.22, 0.1, 0.06)
  group.add(deck)
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.3, 6), hull)
  mast.position.set(-0.8, 1.85, -0.5)
  mast.rotation.set(0.28, 0, 0.34)
  group.add(mast)
  return group
}

// ------------------------------------------------------------------- moon

/** the rover's route: out of the western plain, east past the lip of the cut */
const MOON_TRACK = [
  [-470, -260], [-330, -240], [-180, -200], [-30, -160],
  [120, -130], [260, -120], [420, -160],
]
/** and the trodden way up through the boulder valley */
const MOON_PATH = [
  [-160, 120], [-130, 185], [-100, 245], [-70, 295], [-30, 345], [15, 390],
]

/** the palette the reference used, which is brighter than the engine's rock */
const MOON_ROCK = 0xa8a49c

function catmullPoint(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (
    (2 * p1)
    + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  )
}

/** sample a control polyline as a smooth curve through it */
function curveThrough(control: number[][], count: number): { x: number; z: number }[] {
  const segments = control.length - 1
  const points: { x: number; z: number }[] = []
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * segments
    const seg = Math.min(Math.floor(t), segments - 1)
    const local = t - seg
    const a = control[Math.max(seg - 1, 0)]
    const b = control[seg]
    const c = control[Math.min(seg + 1, segments)]
    const d = control[Math.min(seg + 2, segments)]
    points.push({
      x: catmullPoint(a[0], b[0], c[0], d[0], local),
      z: catmullPoint(a[1], b[1], c[1], d[1], local),
    })
  }
  return points
}

/** how far a design point is from a polyline, for keeping props off it */
function designDistance(x: number, z: number, line: { x: number; z: number }[]): number {
  let best = Infinity
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const abx = b.x - a.x
    const abz = b.z - a.z
    const len2 = abx * abx + abz * abz
    let t = len2 > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / len2 : 0
    t = clampValue(t, 0, 1)
    const dx = x - (a.x + abx * t)
    const dz = z - (a.z + abz * t)
    best = Math.min(best, Math.hypot(dx, dz))
  }
  return best
}

/**
 * Lay a strip of ground detail along a curve, in the design's own frame.
 *
 * The width is walked off in design metres on either side of the centreline and
 * each edge is then dropped onto the sphere, so the strip measures its width
 * along the ground rather than across the projection - which matters because a
 * six-metre-wide track laid any other way would come out a different width
 * depending on which way it happened to be heading.
 */
function moonRibbon(
  control: number[][], count: number, halfWidth: number, lift: number, uvPerTile: number,
  material: THREE.Material, radiusOf: (lat: number, lon: number) => number, planet: PlanetDef,
): THREE.Mesh | null {
  const line = curveThrough(control, count)
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const point = new THREE.Vector3()
  const latLon = { lat: 0, lon: 0 }
  let along = 0

  for (let i = 0; i < line.length; i++) {
    const here = line[i]
    const prev = line[Math.max(0, i - 1)]
    const next = line[Math.min(line.length - 1, i + 1)]
    const dx = next.x - prev.x
    const dz = next.z - prev.z
    const length = Math.hypot(dx, dz) || 1
    if (i > 0) along += Math.hypot(here.x - prev.x, here.z - prev.z)
    for (const side of [-1, 1]) {
      const x = here.x + (-dz / length) * halfWidth * side
      const z = here.z + (dx / length) * halfWidth * side
      moonSpherePoint(planet.landerLat, planet.landerLon, x, z, planet.surfaceRadius, latLon)
      dir(latLon.lat, latLon.lon, point).multiplyScalar(radiusOf(latLon.lat, latLon.lon) + lift)
      positions.push(point.x, point.y, point.z)
      uvs.push(side < 0 ? 0 : 1, uvPerTile > 0 ? along / uvPerTile : along / 24)
    }
    if (i > 0) {
      const a = (i - 1) * 2
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, material)
  mesh.receiveShadow = true
  return mesh
}

/**
 * The things the last crew left: a cluster of crates, and a mast with a lamp on
 * top of it. Nothing here is big, but on a plain this empty anything man-made is
 * a landmark, and the mast is what you steer by.
 */
function moonSurveyGear(): THREE.Group {
  const group = new THREE.Group()
  const items = [
    { dx: 0, dz: 0, w: 1.0, h: 0.62, d: 0.72, c: 0xb9b9b4, rot: 0.4, metal: 0 },
    { dx: 1.4, dz: -1.4, w: 0.72, h: 0.5, d: 0.55, c: 0xc8a646, rot: -0.3, metal: 0.55 },
    { dx: -2.0, dz: 1.4, w: 0.55, h: 0.42, d: 0.5, c: 0xa8a8a2, rot: 1.1, metal: 0 },
  ]
  for (const item of items) {
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(item.w, item.h, item.d),
      new THREE.MeshStandardMaterial({ color: item.c, roughness: 0.55, metalness: item.metal }),
    )
    crate.position.set(item.dx, item.h / 2, item.dz)
    crate.rotation.y = item.rot
    group.add(crate)
  }
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.035, 3.8, 6),
    new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.5, metalness: 0.3 }),
  )
  mast.position.set(0.5, 1.9, -4.5)
  group.add(mast)
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xe8c860, roughness: 0.4, metalness: 0.4 }),
  )
  lamp.position.set(0.5, 3.85, -4.5)
  group.add(lamp)
  return group
}

function* moonPropStage(
  planet: PlanetDef, seed: number, radiusOf: (lat: number, lon: number) => number, group: THREE.Group,
): Generator<void, void, void> {
  const rnd = mulberry32(seed ^ 0x555777)
  const radius = planet.surfaceRadius
  const latLon = { lat: 0, lon: 0 }
  const valley = moonBoulderValley()
  const track = curveThrough(MOON_TRACK, 90)
  const path = curveThrough(MOON_PATH, 70)

  /**
   * Rubble: abundant and small everywhere, boulders gathering in the valley
   * between the two mounds, because that is where scree ends up. It keeps off
   * the cut, off the rover's route and off the trodden path, and it does not go
   * up the hills - boulders on a slope read as a rockfall, and there is no
   * rockfall on a world with no weather.
   */
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: MOON_ROCK, roughness: 0.92, metalness: 0, flatShading: true,
  })
  const rounded = new THREE.IcosahedronGeometry(0.5, 1)
  const angular = new THREE.IcosahedronGeometry(0.5, 0)
  for (const geometry of [rounded, angular]) {
    const position = geometry.attributes.position
    for (let i = 0; i < position.count; i++) {
      const scale = geometry === rounded ? 0.75 + rnd() * 0.5 : 0.6 + rnd() * 0.8
      position.setXYZ(i, position.getX(i) * scale, position.getY(i) * scale, position.getZ(i) * scale)
    }
    geometry.computeVertexNormals()
  }

  const scatter = (
    count: number, sizeMin: number, sizeMax: number, valleyBias: number,
  ): { x: number; z: number; size: number; height: number; rot: number; tiltX: number; tiltZ: number }[] => {
    const spots: { x: number; z: number; size: number; height: number; rot: number; tiltX: number; tiltZ: number }[] = []
    let guard = 0
    while (spots.length < count && guard < count * 30) {
      guard++
      let x: number
      let z: number
      if (valleyBias > 0 && rnd() < valleyBias) {
        const a = rnd() * TAU
        const r = Math.sqrt(rnd()) * valley.r * 1.3
        x = valley.x + Math.cos(a) * r
        z = valley.z + Math.sin(a) * r
      } else {
        const a = rnd() * TAU
        const r = Math.sqrt(rnd()) * 500
        x = Math.cos(a) * r
        z = Math.sin(a) * r
      }
      if (moonTrenchDistance(x, z) < 12) continue
      if (designDistance(x, z, track) < 3.5) continue
      if (designDistance(x, z, path) < 3.0) continue
      const height = moonFieldHeight(x, z)
      if (height > 48) continue
      const size = sizeMin + rnd() * (sizeMax - sizeMin)
      spots.push({
        x, z, size, height,
        rot: rnd() * TAU,
        tiltX: (rnd() - 0.5) * 0.5,
        tiltZ: (rnd() - 0.5) * 0.5,
      })
    }
    return spots
  }

  const place = (geometry: THREE.BufferGeometry, spots: ReturnType<typeof scatter>) => {
    if (!spots.length) return
    const mesh = new THREE.InstancedMesh(geometry, rockMaterial, spots.length)
    const dummy = new THREE.Object3D()
    const point = new THREE.Vector3()
    for (let i = 0; i < spots.length; i++) {
      const spot = spots[i]
      moonSpherePoint(planet.landerLat, planet.landerLon, spot.x, spot.z, radius, latLon)
      // sunk a fifth of its own size, so a boulder sits in the ground rather
      // than on it - the difference between rubble and litter
      dir(latLon.lat, latLon.lon, point).multiplyScalar(radiusOf(latLon.lat, latLon.lon) - spot.size * 0.22)
      dummy.position.copy(point)
      dummy.quaternion.setFromUnitVectors(UP, point.clone().normalize())
      dummy.rotateY(spot.rot)
      dummy.rotateX(spot.tiltX)
      dummy.rotateZ(spot.tiltZ)
      dummy.scale.setScalar(spot.size)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    group.add(mesh)
  }

  place(rounded, scatter(850, 0.22, 0.8, 0))
  yield
  place(rounded, scatter(380, 0.9, 2.2, 0.35))
  yield
  place(angular, scatter(120, 2.4, 5.2, 0.55))
  yield

  const trackTexture = roverTrackTexture(128)
  trackTexture.wrapS = THREE.ClampToEdgeWrapping
  trackTexture.wrapT = THREE.RepeatWrapping
  const trackMesh = moonRibbon(MOON_TRACK, 90, 1.6, 0.07, 0.6, new THREE.MeshStandardMaterial({
    map: trackTexture, transparent: true, roughness: 0.95, metalness: 0, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
  }), radiusOf, planet)
  if (trackMesh) group.add(trackMesh)
  yield

  const pathMesh = moonRibbon(MOON_PATH, 70, 1.3, 0.1, 0, new THREE.MeshStandardMaterial({
    color: 0xd9d6cd, roughness: 1, metalness: 0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }), radiusOf, planet)
  if (pathMesh) group.add(pathMesh)
  yield

  const gear = moonSurveyGear()
  moonSpherePoint(planet.landerLat, planet.landerLon, -224, -2, radius, latLon)
  placeGroup(gear, radiusOf, latLon.lat, latLon.lon, 0, 0.62)
  group.add(gear)
  yield

  // the janitor's own kind of rubbish: two rovers that stopped where they were
  // and a scatter of panels off something that came apart in the air
  for (let i = 0; i < 2; i++) {
    const wreck = buildRoverWreck()
    const designX = i === 0 ? -300 : 60
    const designZ = i === 0 ? 70 : -190
    moonSpherePoint(planet.landerLat, planet.landerLon, designX, designZ, radius, latLon)
    placeGroup(wreck, radiusOf, latLon.lat, latLon.lon, 0.1, rnd() * TAU)
    group.add(wreck)
    yield
  }

  const fragmentMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.6, 0.06, 0.95),
    new THREE.MeshStandardMaterial({ color: 0x33507f, roughness: 0.5, metalness: 0.4, flatShading: true }),
    16,
  )
  const dummy = new THREE.Object3D()
  const point = new THREE.Vector3()
  const centre = { x: -120, z: -120 }
  for (let i = 0; i < 16; i++) {
    const x = centre.x + (rnd() * 2 - 1) * 240
    const z = centre.z + (rnd() * 2 - 1) * 240
    moonSpherePoint(planet.landerLat, planet.landerLon, x, z, radius, latLon)
    dir(latLon.lat, latLon.lon, point).multiplyScalar(radiusOf(latLon.lat, latLon.lon) + 0.12)
    dummy.position.copy(point)
    dummy.quaternion.setFromUnitVectors(UP, point.clone().normalize())
    dummy.rotateY(rnd() * TAU)
    dummy.rotateX((rnd() - 0.5) * 0.5)
    dummy.scale.set(0.5 + rnd() * 0.8, 1, 0.5 + rnd() * 0.8)
    dummy.updateMatrix()
    fragmentMesh.setMatrixAt(i, dummy.matrix)
  }
  fragmentMesh.instanceMatrix.needsUpdate = true
  group.add(fragmentMesh)
  yield
}

// -------------------------------------------------------------- settlement

/** the wind park, on a shoulder of the eastern peak */
const WIND_SITE = { x: 470, z: -250 }
/** where the village sits: east of the meander, which never reaches past x = 76 */
const VILLAGE = { x: 168, z: -52 }

/** A cottage: a box, a pitched roof, a chimney and a doorway. */
function buildCottage(rnd: () => number): THREE.Group {
  const group = new THREE.Group()
  const wall = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.09, 0.16 + rnd() * 0.1, 0.52 + rnd() * 0.16),
    flatShading: true, roughness: 0.95,
  })
  const roof = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.03, 0.3 + rnd() * 0.2, 0.2 + rnd() * 0.1),
    flatShading: true, roughness: 0.9,
  })
  const w = 6 + rnd() * 4
  const d = 5 + rnd() * 3
  const h = 3.2 + rnd() * 1.4
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall)
  body.position.y = h / 2
  group.add(body)
  const pitch = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) * 0.62, 2.4 + rnd(), 4), roof)
  pitch.position.y = h + 1.1
  pitch.rotation.y = Math.PI / 4
  group.add(pitch)
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.8, 0.7), roof)
  chimney.position.set(w * 0.28, h + 1.6, -d * 0.24)
  group.add(chimney)
  return group
}

/** A wind turbine: a tapered tower, a nacelle and three blades on a hub. */
function buildTurbine(height: number): THREE.Group {
  const tower = new THREE.MeshStandardMaterial({ color: 0xe8eef2, roughness: 0.5, metalness: 0.2 })
  const group = new THREE.Group()
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.5, height, 8), tower)
  mast.position.y = height / 2
  group.add(mast)
  const rotor = new THREE.Group()
  rotor.position.set(0, height, 1.2)
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.4, 8), tower)
  hub.rotation.x = Math.PI / 2
  rotor.add(hub)
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Group()
    arm.rotation.z = (i / 3) * TAU
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, height * 0.36, 0.16), tower)
    blade.position.y = height * 0.19
    arm.add(blade)
    rotor.add(arm)
  }
  group.add(rotor)
  group.userData.rotor = rotor
  return group
}

function* earthSettlementStage(
  planet: PlanetDef, seed: number, radiusOf: (lat: number, lon: number) => number, group: THREE.Group,
): Generator<void, void, void> {
  const rnd = makeRnd(seed ^ 0x2b9f41)
  const radius = planet.surfaceRadius

  /**
   * The path, and the fence beside it. Laid out in the design's own metres and
   * converted, because a path is a line between two places and neither of those
   * places is a latitude.
   */
  const from = { x: PAD_ORIGIN.x, z: PAD_ORIGIN.z }
  const to = VILLAGE
  const steps = 90
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const posts: THREE.Matrix4[] = []
  const vertex = new THREE.Vector3()
  const dummy = new THREE.Object3D()

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    // a walk does not go straight: it wanders, most of all halfway
    const sway = Math.sin(t * Math.PI * 1.6) * 17 * Math.sin(t * Math.PI)
    const dx = to.x - from.x
    const dz = to.z - from.z
    const len = Math.hypot(dx, dz) || 1
    const north = from.z + dz * t + (dx / len) * sway
    const east = from.x + dx * t - (dz / len) * sway
    if (i > 0) {
      for (const side of [-1, 1]) {
        const nx = north + (dx / len) * 1.3 * side
        const nz = east - (dz / len) * 1.3 * side
        const edge = fromPad(planet.landerLat, planet.landerLon, nx, nz, radius)
        dir(edge.lat, edge.lon, vertex).multiplyScalar(radiusOf(edge.lat, edge.lon) + 0.08)
        positions.push(vertex.x, vertex.y, vertex.z)
        uvs.push(side < 0 ? 0 : 1, i * 0.5)
      }
      const a = (i - 1) * 2
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
    // fence posts on the downhill side, every few metres
    if (i % 5 === 0 && i > 2) {
      const nx = north + (dx / len) * 2.4
      const nz = east - (dz / len) * 2.4
      const post = fromPad(planet.landerLat, planet.landerLon, nx, nz, radius)
      dir(post.lat, post.lon, scratchDir)
      dummy.position.copy(scratchDir).multiplyScalar(radiusOf(post.lat, post.lon) + 0.7)
      dummy.quaternion.setFromUnitVectors(UP, scratchDir)
      dummy.rotateY(rnd() * 0.3)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      posts.push(dummy.matrix.clone())
    }
    if (i % 30 === 0) yield
  }

  const pathGeometry = new THREE.BufferGeometry()
  pathGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  pathGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  pathGeometry.setIndex(indices)
  pathGeometry.computeVertexNormals()
  group.add(new THREE.Mesh(pathGeometry, new THREE.MeshStandardMaterial({
    color: 0xc9bda2, roughness: 1, side: THREE.DoubleSide,
  })))
  yield

  if (posts.length) {
    const fence = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.11, 0.14, 1.4, 5),
      new THREE.MeshStandardMaterial({ color: 0x6b5238, flatShading: true }),
      posts.length,
    )
    for (let i = 0; i < posts.length; i++) fence.setMatrixAt(i, posts[i])
    fence.instanceMatrix.needsUpdate = true
    group.add(fence)
  }
  yield

  /**
   * The gardens. A bed beside each cottage, and the one place in the valley where
   * the planting is *laid out* rather than scattered: the same species as the
   * meadow, but mixed and set in rows at even spacing, because that is the whole
   * difference between a garden and a meadow. Jittered by a hand's breadth so it
   * reads as grown rather than printed.
   */
  const gardenCapacity = 120
  const gardenKinds = PLANTS.map((species) => ({
    species,
    mesh: new THREE.InstancedMesh(billboardCard, billboardMaterial(species.file), gardenCapacity),
    count: 0,
  }))
  const gardenTint = new THREE.Color()

  // the village: a loose cluster either side of where the path arrives
  for (let i = 0; i < 7; i++) {
    const spread = 46
    const north = VILLAGE.z + (rnd() * 2 - 1) * spread
    const east = VILLAGE.x + (rnd() * 2 - 1) * spread
    if (riverDistance(north, east) < 70) continue
    const point = fromPad(planet.landerLat, planet.landerLon, north, east, radius)
    const cottage = buildCottage(rnd)
    placeGroup(cottage, radiusOf, point.lat, point.lon, -0.15, rnd() * TAU)
    group.add(cottage)

    const side = rnd() * TAU
    const rows = 2 + Math.floor(rnd() * 2)
    const perRow = 5 + Math.floor(rnd() * 4)
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < perRow; col++) {
        const along = (col - (perRow - 1) / 2) * 0.95
        const out = 5.6 + row * 1.05
        const bedNorth = north + Math.cos(side) * out - Math.sin(side) * along + (rnd() - 0.5) * 0.22
        const bedEast = east + Math.sin(side) * out + Math.cos(side) * along + (rnd() - 0.5) * 0.22
        if (riverDistance(bedNorth, bedEast) < riverHalfWidth(bedNorth, bedEast) + 3) continue
        const kind = gardenKinds[Math.floor(rnd() * gardenKinds.length)]
        if (kind.count >= gardenCapacity) continue
        const species = kind.species
        const bed = fromPad(planet.landerLat, planet.landerLon, bedNorth, bedEast, radius)
        const size = species.height[0] + rnd() * (species.height[1] - species.height[0])
        dir(bed.lat, bed.lon, scratchDir)
        dummy.position.copy(scratchDir).multiplyScalar(radiusOf(bed.lat, bed.lon))
        dummy.quaternion.setFromUnitVectors(UP, scratchDir)
        dummy.rotateY(rnd() * TAU)
        dummy.scale.setScalar(size / species.fill)
        dummy.updateMatrix()
        kind.mesh.setMatrixAt(kind.count, dummy.matrix)
        gardenTint.setScalar(0.9 + rnd() * 0.2)
        kind.mesh.setColorAt(kind.count, gardenTint)
        kind.count++
      }
    }
    yield
  }
  for (const kind of gardenKinds) {
    kind.mesh.count = kind.count
    kind.mesh.instanceMatrix.needsUpdate = true
    if (kind.mesh.instanceColor) kind.mesh.instanceColor.needsUpdate = true
    group.add(kind.mesh)
  }
  yield

  // the wind park, on the shoulder of the peak where the wind actually is
  for (let i = 0; i < 5; i++) {
    const north = WIND_SITE.z + i * 62
    const east = WIND_SITE.x - i * 26
    if (riverDistance(north, east) < 40) continue
    const point = fromPad(planet.landerLat, planet.landerLon, north, east, radius)
    const height = radiusOf(point.lat, point.lon) - radius
    if (height < 45) continue
    const turbine = buildTurbine(46 + rnd() * 10)
    placeGroup(turbine, radiusOf, point.lat, point.lon, -0.4, rnd() * TAU)
    group.add(turbine)
    windRotors.push(turbine.userData.rotor as THREE.Group)
    yield
  }
}

/** rotors the caller spins, so a wind park is not a line of statues */
export const windRotors: THREE.Group[] = []

// -------------------------------------------------------------- settlement end

/** A lander probe half swallowed by the dunes. */
function buildProbeWreck(): THREE.Group {
  const group = new THREE.Group()
  const hull = new THREE.MeshStandardMaterial({ color: 0xb9b0a2, roughness: 0.8, metalness: 0.3, flatShading: true })
  const panel = new THREE.MeshStandardMaterial({ color: 0x35507f, roughness: 0.5, metalness: 0.4, flatShading: true })
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.3, 2.0), hull)
  body.position.y = -0.2
  body.rotation.z = 0.22
  group.add(body)
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.08, 1.2), panel)
    wing.position.set(side * 2.1, -0.42, 0.3)
    wing.rotation.set(0.12, side * -0.18, side * 0.36)
    group.add(wing)
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.0, 6), hull)
  mast.position.set(-0.7, 0.85, -0.6)
  mast.rotation.z = 0.62
  group.add(mast)
  return group
}

function* marsPropStage(
  planet: PlanetDef, seed: number, radiusOf: (lat: number, lon: number) => number, group: THREE.Group,
): Generator<void, void, void> {
  const rnd = makeRnd(seed ^ 0x7c3d55)
  const site = landerSite(planet.id)
  const dummy = new THREE.Object3D()

  const rockMesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.9, 0),
    new THREE.MeshStandardMaterial({ color: planet.rock, flatShading: true, roughness: 1 }),
    130,
  )
  for (let i = 0; i < 130; i++) {
    const lat = (rnd() * 2 - 1) * 1.0
    const lon = rnd() * TAU
    placeProp(dummy, radiusOf, lat, lon, 0.2, 0.5 + rnd() * 1.9, rnd)
    rockMesh.setMatrixAt(i, dummy.matrix)
    if ((i + 1) % LOD_PROP_SLICE === 0) yield
  }
  rockMesh.instanceMatrix.needsUpdate = true
  group.add(rockMesh)
  yield

  for (let i = 0; i < 2; i++) {
    const wreck = buildProbeWreck()
    const lat = site.lat + (i === 0 ? -0.22 : 0.3)
    const lon = site.lon + (i === 0 ? 0.34 : -0.28)
    placeGroup(wreck, radiusOf, lat, lon, -0.35, rnd() * TAU)
    group.add(wreck)
    yield
  }
}

// ------------------------------------------------------------------ lander

interface LanderParts {
  lander: THREE.Group
  landingRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
  ringMaterial: THREE.MeshBasicMaterial
  padBeacon: THREE.Sprite
}

function buildLander(
  planet: PlanetDef, radiusOf: (lat: number, lon: number) => number, group: THREE.Group,
): LanderParts {
  const site = landerSite(planet.id)
  const lander = new THREE.Group()
  placeGroup(lander, radiusOf, site.lat, site.lon, 0, 0)
  const legMaterial = new THREE.MeshStandardMaterial({ color: 0xd8a24a, flatShading: true, roughness: 0.6 })
  for (const angle of [0, 1, 2, 3]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 2.6, 0.28), legMaterial)
    const a = (angle / 4) * TAU + Math.PI / 4
    leg.position.set(Math.cos(a) * 2.2, 0.75, Math.sin(a) * 2.2)
    leg.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45)
    lander.add(leg)
  }

  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x7fffb0, transparent: true, opacity: 0.5 })
  const landingRing = new THREE.Mesh(new THREE.TorusGeometry(LANDER_RING_RADIUS, 0.2, 8, 64), ringMaterial)
  landingRing.rotation.x = -Math.PI / 2
  landingRing.position.y = 0.14
  lander.add(landingRing)

  const padBeacon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(140, 255, 190, 0.9)', 'rgba(60, 220, 140, 0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  padBeacon.position.set(0, 6.6, 0)
  padBeacon.scale.setScalar(7.5)
  lander.add(padBeacon)

  group.add(lander)
  return { lander, landingRing, ringMaterial, padBeacon }
}

// ------------------------------------------------------------------- build

/**
 * How far below its world the stand-in crust sits. It only has to clear the
 * deepest ground any of the three reaches - Earth's river channel, at about ten
 * metres down - so that a half-built surface never shows a grey dome through it.
 */
const STAND_IN_DEPTH = 13

/**
 * A surface that streams in across frames: a stand-in crust appears straight
 * away and the terrain, props and lander pad are generated under the frame
 * budget. The stand-in sits below the terrain's deepest valley, so the finished
 * world never leaves a grey dome poking out of a crater.
 */
export function createSurfaceJob(planetId: number, seed: number): SurfaceJob {  const planet = planetById(planetId)
  const detail = new THREE.Group()
  const standIn = new THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>(
    new THREE.SphereGeometry(planet.surfaceRadius - STAND_IN_DEPTH, 40, 26),
    new THREE.MeshStandardMaterial({
      color: planet.groundLow, flatShading: true, roughness: 1, transparent: true, opacity: 1,
    }),
  )
  // everything that stands on this world is placed on the surface the mesh
  // draws, not the one the height function describes (see meshGround)
  const terrainRadius = meshGround(planet, seed)
  let lander: LanderParts | null = null

  const stages: (() => Generator<void, void, void>)[] = [
    () => terrainStage(planet, seed, detail),
  ]
  if (planet.theme === 'moon') {
    stages.push(function* moonSky() {
      detail.add(buildStarField(planet.surfaceRadius))
    })
  }
  if (planet.theme === 'earth') {
    stages.push(function* earthWater() {
      detail.add(buildRiver(planet))
      yield
    })
    stages.push(() => earthPropStage(planet, seed, terrainRadius, detail))
    stages.push(() => earthSettlementStage(planet, seed, terrainRadius, detail))
  } else if (planet.theme === 'moon') {
    stages.push(() => moonPropStage(planet, seed, terrainRadius, detail))
  } else {
    stages.push(() => marsPropStage(planet, seed, terrainRadius, detail))
  }
  stages.push(function* padStage() {
    lander = buildLander(planet, terrainRadius, detail)
  })

  let index = 0
  let current: Generator<void, void, void> | null = null
  const job: SurfaceJob = {
    planetId,
    standIn,
    detail,
    build: null,
    costMs: LOD_COST_SURFACE,
    slice() {
      while (index < stages.length) {
        current = current ?? stages[index]()
        const step = current.next()
        if (!step.done) return false
        current = null
        index++
      }
      if (!job.build && lander) {
        markShadows(detail, planet)
        job.build = {
          planetId,
          group: detail,
          lander: lander.lander,
          landingRing: lander.landingRing,
          ringMaterial: lander.ringMaterial,
          padBeacon: lander.padBeacon,
          terrainRadius,
        }
      }
      return true
    },
  }
  return job
}
