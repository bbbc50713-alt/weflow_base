import { existsSync, readFileSync } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { HanxiaomiAction } from '../hanxiaomi/types'

export type HanxiaomiOutboundStatus =
  | 'queued'
  | 'waiting'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'superseded'

export interface HanxiaomiOutboundSendJob {
  jobId: string
  eventKey: string
  contactId: string
  contactName: string
  text: string
  fullText?: string
  action: HanxiaomiAction
  status: HanxiaomiOutboundStatus
  sendAfter: number
  attempts: number
  createdAt: number
  updatedAt: number
  generatedAt: number
  triggerMessageTimestamp: number
  parentEventKey?: string
  partIndex?: number
  partTotal?: number
  partGapMs?: number
  receivedMessage?: string
  lastError?: string
}

interface QueueFile {
  outbound: Record<string, HanxiaomiOutboundSendJob>
}

export class HanxiaomiQueueStore {
  private readonly filePath: string
  private outbound = new Map<string, HanxiaomiOutboundSendJob>()
  private readonly maxEntries = 3000
  private saveTimer: NodeJS.Timeout | null = null
  private saveRequested = false
  private saveInFlight = false

  constructor(baseDir: string) {
    this.filePath = join(baseDir, '..', 'hanxiaomi-queue.json')
    this.load()
  }

  listOutbound(): HanxiaomiOutboundSendJob[] {
    return Array.from(this.outbound.values()).sort((a, b) => a.sendAfter - b.sendAfter || a.createdAt - b.createdAt)
  }

  getOutbound(jobId: string): HanxiaomiOutboundSendJob | undefined {
    return this.outbound.get(jobId)
  }

  upsertOutbound(job: HanxiaomiOutboundSendJob): void {
    const next = { ...job, updatedAt: Date.now() }
    this.outbound.set(job.jobId, next)
    this.prune()
    this.scheduleSave()
    if (this.isTerminalStatus(next.status)) {
      void this.flushSave()
    }
  }

  removeOutbound(jobId: string): void {
    this.outbound.delete(jobId)
    this.scheduleSave()
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as QueueFile
      this.outbound = new Map(Object.entries(parsed?.outbound || {}))
    } catch {
      this.outbound = new Map()
    }
  }

  private scheduleSave(): void {
    this.saveRequested = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flushSave()
    }, 120)
    this.saveTimer.unref?.()
  }

  private async flushSave(): Promise<void> {
    if (this.saveInFlight) return
    if (!this.saveRequested) return
    this.saveInFlight = true
    this.saveRequested = false
    let temporaryPath = ''
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      const payload: QueueFile = { outbound: Object.fromEntries(this.outbound) }
      temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(payload, null, 0), 'utf-8')
      await rename(temporaryPath, this.filePath)
    } catch {
      if (temporaryPath) await unlink(temporaryPath).catch(() => {})
    }
    finally {
      this.saveInFlight = false
      if (this.saveRequested) this.scheduleSave()
    }
  }

  private prune(): void {
    if (this.outbound.size <= this.maxEntries) return
    const terminal = Array.from(this.outbound.values())
      .filter(job => ['sent', 'failed', 'cancelled', 'superseded'].includes(job.status))
      .sort((a, b) => a.updatedAt - b.updatedAt)
    const removeCount = this.outbound.size - this.maxEntries
    for (const job of terminal.slice(0, removeCount)) {
      this.outbound.delete(job.jobId)
    }
  }

  private isTerminalStatus(status: HanxiaomiOutboundStatus): boolean {
    return ['sent', 'failed', 'cancelled', 'superseded'].includes(status)
  }
}
