import { freemem, totalmem } from 'os'
import { getHeapStatistics } from 'v8'

export type Pressure = 'high' | 'normal' | 'low'

export function memoryPressure(): Pressure {
  const total = totalmem(), free = freemem(), rss = process.memoryUsage.rss()
  const heap = getHeapStatistics()
  if (total <= 0 || free < 1024 ** 3 || free / total < 0.12 ||
      rss / total > 0.20 || heap.used_heap_size / heap.heap_size_limit > 0.75) return 'high'
  return free >= 3 * 1024 ** 3 && free / total >= 0.25 && rss / total < 0.12 &&
    heap.used_heap_size / heap.heap_size_limit < 0.55 ? 'low' : 'normal'
}

export class AdaptiveLimit {
  limit = 9
  private good = 0
  sample(pressure: Pressure) {
    this.good = pressure === 'low' ? this.good + 1 : 0
    if (pressure === 'high') this.limit = Math.max(6, this.limit - 1)
    else if (this.good >= 3) { this.limit = Math.min(16, this.limit + 1); this.good = 0 }
    return this.limit
  }
}

// Admission control only: reducing the target never cancels a batch in flight.
export function runPool<T>(items: T[], run: (item:T)=>Promise<void>, proceed:()=>boolean,
  controller: AdaptiveLimit, update: (target:number, active:number)=>void,
  pressure = memoryPressure, interval = 5000): Promise<void> {
  return new Promise((resolve,reject) => {
    let next = 0, active = 0, failed = false, error: unknown, ended = false
    const pump = () => {
      if (ended) return
      while (!failed && active < controller.limit && next < items.length && proceed()) {
        const item = items[next++]; active++
        Promise.resolve().then(() => run(item)).catch(e => { if (!failed) error = e; failed = true })
          .finally(() => { active--; pump() })
      }
      update(controller.limit,active)
      if (!active) {
        ended = true; clearInterval(timer)
        if (failed) reject(error); else resolve()
      }
    }
    const timer = setInterval(() => { controller.sample(pressure()); pump() },interval)
    pump()
  })
}
