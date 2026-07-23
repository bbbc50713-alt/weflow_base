import { existsSync, readFileSync } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { HanxiaomiDeliveryLedgerEntry } from './types'

interface LedgerFile {
  entries: Record<string, HanxiaomiDeliveryLedgerEntry>
}

export class HanxiaomiDeliveryLedger {
  private readonly filePath: string
  private entries = new Map<string, HanxiaomiDeliveryLedgerEntry>()
  private readonly maxEntries = 5000
  private saveTimer: NodeJS.Timeout | null = null
  private saveRequested = false
  private saveInFlight = false

  constructor(baseDir: string) {
    this.filePath = join(baseDir, '..', 'hanxiaomi-delivery-ledger.json')
    this.load()
  }

  get(eventKey: string): HanxiaomiDeliveryLedgerEntry | undefined {
    return this.entries.get(eventKey)
  }

  hasSuccessfulContact(contactId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.contactId !== contactId) continue
      if (['completed', 'sent'].includes(entry.status)) {
        return true
      }
    }
    return false
  }

  upsert(entry: HanxiaomiDeliveryLedgerEntry): void {
    const next = { ...entry, updatedAt: Date.now() }
    this.entries.set(entry.eventKey, next)
    this.prune()
    this.scheduleSave()
    if (this.isTerminalStatus(next.status)) {
      void this.flushSave()
    }
  }

  mark(eventKey: string, patch: Partial<HanxiaomiDeliveryLedgerEntry>): void {
    const existing = this.entries.get(eventKey)
    if (!existing) return
    this.upsert({ ...existing, ...patch })
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const raw = readFileSync(this.filePath, 'utf-8')
      if (!raw.trim()) {
        console.warn('[HanxiaomiDeliveryLedger] ledger file is empty, starting with a clean ledger')
        return
      }
      const parsed = JSON.parse(raw) as LedgerFile
      const rawEntries = parsed?.entries || {}
      this.entries = new Map(Object.entries(rawEntries))
    } catch (error: any) {
      console.warn('[HanxiaomiDeliveryLedger] failed to load ledger file:', error?.message || String(error))
      this.entries = new Map()
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
      const payload: LedgerFile = { entries: Object.fromEntries(this.entries) }
      temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(payload, null, 0), 'utf-8')
      await rename(temporaryPath, this.filePath)
    } catch (error: any) {
      if (temporaryPath) await unlink(temporaryPath).catch(() => {})
      console.warn('[HanxiaomiDeliveryLedger] failed to save ledger file:', error?.message || String(error))
    }
    finally {
      this.saveInFlight = false
      if (this.saveRequested) this.scheduleSave()
    }
  }

  private prune(): void {
    if (this.entries.size <= this.maxEntries) return
    const sorted = Array.from(this.entries.values()).sort((a, b) => a.updatedAt - b.updatedAt)
    const removeCount = this.entries.size - this.maxEntries
    for (const entry of sorted.slice(0, removeCount)) {
      this.entries.delete(entry.eventKey)
    }
  }

  private isTerminalStatus(status: HanxiaomiDeliveryLedgerEntry['status']): boolean {
    return ['completed', 'draft', 'sent', 'send_failed', 'skipped', 'failed', 'cancelled', 'superseded'].includes(status)
  }
}
