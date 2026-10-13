/**
 * A tiny always-on performance sampler (plan §9).
 *
 * A browser never tells you how much it can take, so the only honest answer is
 * to measure what actually happened: record one float per frame, keep a rolling
 * window, and report the shape of the distribution rather than a single average.
 * Tail percentiles are what matter — a p99 of 40 ms is the stutter a player
 * feels, and it is invisible in a mean.
 *
 * Everything here is browser-optional: `performance.memory` only exists in
 * Chromium, `longtask` is unsupported in Firefox/Safari, and both simply report
 * zero there. The frame-time side always works.
 */
export interface PerfReport {
  /** frames currently in the window */
  sampled: number
  fps: number
  medianMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  /** frames over 1.5x and 2x the budget — the ones a player notices */
  janky: number
  stutters: number
  /** main-thread tasks over 50 ms (Chromium only) */
  longTasks: number
  longTaskMs: number
  heapMb: number | null
  heapLimitMb: number | null
}

interface MemoryInfo {
  usedJSHeapSize: number
  jsHeapSizeLimit: number
}

const WINDOW = 900 // ~15 s at 60 fps

export interface Perf {
  sample(dtSeconds: number): void
  reset(): void
  report(budgetMs?: number): PerfReport
}

export function createPerf(): Perf {
  const frames = new Float32Array(WINDOW)
  const scratch = new Float32Array(WINDOW)
  let seen = 0
  let cursor = 0
  let longTasks = 0
  let longTaskMs = 0

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          longTasks++
          longTaskMs += entry.duration
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      // Firefox and Safari don't know 'longtask'; the frame window still tells
      // the same story from the outside
    }
  }

  const percentile = (sorted: Float32Array, count: number, fraction: number) => {
    if (count === 0) return 0
    const index = Math.min(count - 1, Math.max(0, Math.ceil(fraction * count) - 1))
    return sorted[index]
  }

  return {
    sample(dtSeconds) {
      const ms = dtSeconds * 1000
      // a tab that was hidden, a devtools pause or a breakpoint is not a frame
      if (!(ms > 0) || ms > 2000) return
      frames[cursor] = ms
      cursor = (cursor + 1) % WINDOW
      if (seen < WINDOW) seen++
    },

    reset() {
      seen = 0
      cursor = 0
      longTasks = 0
      longTaskMs = 0
    },

    report(budgetMs = 1000 / 60) {
      const count = seen
      if (count > 0) scratch.set(frames)
      const sorted = count > 0 ? scratch.subarray(0, count) : scratch.subarray(0, 0)
      sorted.sort()
      const median = percentile(sorted, count, 0.5)
      let janky = 0
      let stutters = 0
      for (let i = 0; i < count; i++) {
        if (sorted[i] > budgetMs * 1.5) janky++
        if (sorted[i] > budgetMs * 2) stutters++
      }
      const memory = (performance as Performance & { memory?: MemoryInfo }).memory
      return {
        sampled: count,
        fps: median > 0 ? 1000 / median : 0,
        medianMs: median,
        p95Ms: percentile(sorted, count, 0.95),
        p99Ms: percentile(sorted, count, 0.99),
        maxMs: count > 0 ? sorted[count - 1] : 0,
        janky,
        stutters,
        longTasks,
        longTaskMs,
        heapMb: memory ? memory.usedJSHeapSize / 1048576 : null,
        heapLimitMb: memory ? memory.jsHeapSizeLimit / 1048576 : null,
      }
    },
  }
}

/** One line per number, for the debug overlay. */
export function formatPerf(report: PerfReport, extra: string[] = []): string {
  const lines = [
    `${report.fps.toFixed(0).padStart(3)} fps   median ${report.medianMs.toFixed(1)} ms   p95 ${report.p95Ms.toFixed(1)}   p99 ${report.p99Ms.toFixed(1)}   max ${report.maxMs.toFixed(0)}`,
    `jank ${report.janky}/${report.sampled}   stutter ${report.stutters}   long tasks ${report.longTasks} (${report.longTaskMs.toFixed(0)} ms)`,
  ]
  if (report.heapMb !== null && report.heapLimitMb !== null) {
    lines.push(`heap ${report.heapMb.toFixed(0)} / ${report.heapLimitMb.toFixed(0)} MB`)
  }
  return lines.concat(extra).join('\n')
}
