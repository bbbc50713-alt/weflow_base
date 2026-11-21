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
  limit = 16
  private good = 0
  private coolUntil = 0
  private lastBackoff = 0

  congested() {
    const now = Date.now()
    if (now-this.lastBackoff > 5000) {
      this.limit = Math.max(6,Math.floor(this.limit/2))
      this.lastBackoff=now
    }
    this.coolUntil=now+30000
    this.good=0
  }
  sample(pressure: Pressure) {
    this.good = pressure === 'low' && Date.now()>=this.coolUntil ? this.good + 1 : 0
    if (pressure === 'high') this.limit = Math.max(6, this.limit - 1)
    else if (this.good >= 3) { this.limit = Math.min(120, this.limit + Math.max(1,Math.ceil(this.limit/8))); this.good = 0 }
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

// Count only acknowledged, well-filled batches as evidence that a larger upload will help.
// One controller per run; concurrent receipts share cooldowns so a burst cannot multiply the target.
export class AdaptiveBatch {
  rows = 128
  bytes = 512 * 1024
  private fast = 0
  private nextGrowth = 0
  private nextReduction = 0

  backoff(now = Date.now()) {
    if (now >= this.nextReduction) {
      this.rows = Math.max(32, Math.floor(this.rows / 2))
      this.bytes = Math.max(128 * 1024, Math.floor(this.bytes / 2))
      this.nextReduction = now + 5000
    }
    this.fast = 0
    this.nextGrowth = now + 30000
  }

  allowServerGrowth = true

  acknowledged(rows: number, bytes: number, ms: number, pressure: Pressure, now = Date.now()) {
    if (ms >= 8000 || pressure === 'high') { this.backoff(now); return }
    if (!this.allowServerGrowth || ms > 2000 || now < this.nextGrowth) { this.fast = 0; return }
    if (rows < this.rows * 0.75 && bytes < this.bytes * 0.75) return
    if (++this.fast < 3) return
    this.rows = Math.min(500, this.rows + 64)
    this.bytes = Math.min(1900000, this.bytes + 256 * 1024)
    this.fast = 0
    this.nextGrowth = now + 5000
  }
}

// Server feedback controls upload admissions independently of reader concurrency.
// Respond to a building backlog; lack of work alone does not mean the server is slow.
export class ServerPacing {
  limit = 16
  receivedAt = 0
  reason = '等待中台采样'
  private previousRate = 0
  observe(s:{effective_slots?:number|null;free_slots?:number|null;queued_batches:number;oldest_seconds:number;processed_per_minute:number}, now=Date.now()) {
    if (s.effective_slots == null || s.free_slots == null || ![s.effective_slots,s.free_slots,s.queued_batches,s.oldest_seconds,s.processed_per_minute].every(n=>Number.isFinite(n)&&n>=0)) return 'unknown'
    const cap=Math.min(120,s.effective_slots), free=Math.min(cap,s.free_slots)
    const slower=this.previousRate>0 && s.processed_per_minute<this.previousRate*.75
    this.previousRate=s.processed_per_minute
    this.receivedAt=now
    if (!cap || s.oldest_seconds>=8 || (s.queued_batches>0 && (!free || slower))) {
      this.limit=Math.min(cap,Math.max(1,Math.floor(this.limit/2)))
      this.reason=cap ? '中台积压，降低发送' : '中台连接紧张，等待容量'
      return 'busy'
    }
    if (free && !s.queued_batches) {
      this.limit=Math.min(cap+1,120,Math.max(1,this.limit)+Math.min(free,4))
      this.reason='中台有空闲消费者'
      return 'room'
    }
    this.limit=Math.min(cap+1,120,Math.max(1,this.limit))
    this.reason='维持发送速度'
    return 'steady'
  }
  fresh(now=Date.now()) { return this.receivedAt>0 && now-this.receivedAt<30000 }
}
