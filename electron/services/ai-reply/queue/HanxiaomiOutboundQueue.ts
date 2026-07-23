import { randomUUID } from 'crypto'
import type { SendTextResult } from '../senders/types'
import type { HanxiaomiAction } from '../hanxiaomi/types'
import {
  computeInitialDelayMs,
  computePostSendGapMs,
  mergeDeliveryPolicy,
  randomBetween,
  sleep,
  type DeliveryPolicy
} from './DeliveryPacer'
import {
  HanxiaomiQueueStore,
  type HanxiaomiOutboundSendJob
} from './HanxiaomiQueueStore'

export interface EnqueueOutboundInput {
  eventKey: string
  contactId: string
  contactName: string
  text: string
  segments?: string[]
  action: HanxiaomiAction
  generatedAt?: number
  triggerMessageTimestamp?: number
  receivedMessage?: string
}

export interface HanxiaomiOutboundQueueDeps {
  sendText(job: HanxiaomiOutboundSendJob): Promise<SendTextResult>
  shouldSkip?(job: HanxiaomiOutboundSendJob): Promise<string | undefined>
  onStatus?(job: HanxiaomiOutboundSendJob): void
}

export class HanxiaomiOutboundQueue {
  private readonly store: HanxiaomiQueueStore
  private readonly deps: HanxiaomiOutboundQueueDeps
  private policy: DeliveryPolicy
  private readonly sendTimeoutMs = 60_000
  private running = false
  private paused = false
  private lastSentAt = 0
  private lastContactSentAt = new Map<string, number>()

  constructor(baseDir: string, deps: HanxiaomiOutboundQueueDeps, policy?: Partial<DeliveryPolicy>) {
    this.store = new HanxiaomiQueueStore(baseDir)
    this.deps = deps
    this.policy = mergeDeliveryPolicy(policy)
    this.recoverInterruptedJobs()
  }

  updatePolicy(policy?: Partial<DeliveryPolicy>): void {
    this.policy = mergeDeliveryPolicy(policy)
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.pump()
  }

  enqueue(input: EnqueueOutboundInput): HanxiaomiOutboundSendJob {
    const now = Date.now()
    const existing = this.store.listOutbound().find(job => this.getParentEventKey(job) === input.eventKey && !['failed', 'cancelled', 'superseded'].includes(job.status))
    if (existing) return existing

    const generatedAt = normalizeTimestampMs(input.generatedAt, now)
    const triggerMessageTimestamp = normalizeTimestampMs(input.triggerMessageTimestamp, generatedAt)
    const parts = this.normalizeOutboundParts(input.text, input.segments)
    const firstDelayMs = computeInitialDelayMs(parts[0] || input.text, this.policy)
    let sendAfter = now + firstDelayMs
    let firstJob: HanxiaomiOutboundSendJob | undefined
    console.log(
      `[HanxiaomiOutboundQueue] enqueue event=${input.eventKey} contact=${input.contactId} parts=${parts.length} ` +
      `firstDelayMs=${firstDelayMs} generatedAt=${generatedAt} triggerMessageTimestamp=${triggerMessageTimestamp}`
    )

    parts.forEach((text, index) => {
      const partTotal = parts.length
      const partIndex = index + 1
      const isSplit = partTotal > 1
      let partGapMs: number | undefined
      if (index > 0) {
        partGapMs = randomBetween(this.policy.splitMinGapMs, this.policy.splitMaxGapMs)
        sendAfter += partGapMs
      }
      const job: HanxiaomiOutboundSendJob = {
        jobId: `hxm_send_${randomUUID().replace(/-/g, '')}`,
        eventKey: isSplit ? `${input.eventKey}:part:${partIndex}` : input.eventKey,
        contactId: input.contactId,
        contactName: input.contactName || input.contactId,
        text,
        fullText: input.text,
        action: input.action,
        status: 'queued',
        sendAfter,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        generatedAt,
        triggerMessageTimestamp,
        parentEventKey: isSplit ? input.eventKey : undefined,
        partIndex: isSplit ? partIndex : undefined,
        partTotal: isSplit ? partTotal : undefined,
        partGapMs: isSplit ? partGapMs : undefined,
        receivedMessage: input.receivedMessage
      }
      this.store.upsertOutbound(job)
      this.notifyStatus(job)
      if (!firstJob) firstJob = job
    })
    this.pump()
    return firstJob!
  }

  pump(): void {
    if (this.running || this.paused) return
    this.running = true
    void this.drain().finally(() => {
      this.running = false
      if (!this.paused && this.store.listOutbound().some(job => ['queued', 'waiting'].includes(job.status))) {
        this.pump()
      }
    })
  }

  private async drain(): Promise<void> {
    while (!this.paused) {
      const job = this.nextJob()
      if (!job) return
      const now = Date.now()
      const previousPart = this.getPreviousPart(job)
      const sameReplyPartGap = previousPart
        ? Math.max(0, previousPart.updatedAt + (job.partGapMs ?? this.policy.splitMinGapMs) - now)
        : 0
      const accountGap = previousPart ? 0 : Math.max(0, this.lastSentAt + this.policy.postSendGapMsMin - now)
      const lastContactSentAt = this.lastContactSentAt.get(job.contactId) || 0
      const hasFreshCustomerTurn = job.triggerMessageTimestamp > lastContactSentAt
      const contactGap = previousPart
        ? 0
        : hasFreshCustomerTurn
          ? 0
          : Math.max(0, lastContactSentAt + this.policy.perContactCooldownMs - now)
      const waitMs = Math.max(0, job.sendAfter - now, sameReplyPartGap, accountGap, contactGap)
      if (waitMs > 0) {
        console.log(`[HanxiaomiOutboundQueue] waiting job=${job.jobId} event=${job.eventKey} contact=${job.contactId} waitMs=${waitMs}`)
        this.mark(job, { status: 'waiting' })
        await sleep(waitMs)
      }

      const fresh = this.store.getOutbound(job.jobId)
      if (!fresh || !['queued', 'waiting'].includes(fresh.status)) continue

      const skipReason = await this.deps.shouldSkip?.(fresh)
      if (skipReason) {
        console.warn(`[HanxiaomiOutboundQueue] skip job=${fresh.jobId} event=${fresh.eventKey} contact=${fresh.contactId} reason=${skipReason}`)
        this.mark(fresh, { status: 'superseded', lastError: skipReason })
        this.cancelRemainingParts(fresh, skipReason)
        continue
      }

      if (!previousPart && Date.now() - fresh.generatedAt > this.policy.staleAfterMs) {
        console.warn(`[HanxiaomiOutboundQueue] stale job=${fresh.jobId} event=${fresh.eventKey} contact=${fresh.contactId}`)
        this.mark(fresh, { status: 'superseded', lastError: 'reply became stale before delivery' })
        this.cancelRemainingParts(fresh, 'reply became stale before delivery')
        continue
      }

      console.log(`[HanxiaomiOutboundQueue] sending job=${fresh.jobId} event=${fresh.eventKey} contact=${fresh.contactId} textLen=${fresh.text.length}`)
      this.mark(fresh, { status: 'sending', attempts: fresh.attempts + 1 })
      const sending = this.store.getOutbound(fresh.jobId) || fresh
      try {
        const result = await this.withSendTimeout(this.deps.sendText(sending))
        if (result.success && result.delivered) {
          console.log(`[HanxiaomiOutboundQueue] sent job=${sending.jobId} event=${sending.eventKey} contact=${sending.contactId}`)
          this.lastSentAt = Date.now()
          this.lastContactSentAt.set(sending.contactId, this.lastSentAt)
          this.mark(sending, { status: 'sent', lastError: undefined })
          if (!this.hasNextPart(sending)) {
            await sleep(computePostSendGapMs(this.policy))
          }
        } else {
          await this.handleFailure(sending, result.error || result.detail || 'delivery result was not confirmed')
        }
      } catch (error: any) {
        await this.handleFailure(sending, error?.message || String(error))
      }

      // 让出一拍，避免连续处理/跳过多段消息时长时间占住主线程事件循环
      await sleep(0)
    }
  }

  private nextJob(): HanxiaomiOutboundSendJob | undefined {
    return this.store.listOutbound().find(job => ['queued', 'waiting'].includes(job.status) && this.previousPartsAreSent(job))
  }

  private async handleFailure(job: HanxiaomiOutboundSendJob, error: string): Promise<void> {
    if (this.isNonRetryableDeliveryError(error)) {
      this.mark(job, { status: 'failed', lastError: error })
      this.cancelRemainingParts(job, error)
      return
    }
    if (job.attempts <= this.policy.maxRetry) {
      this.mark(job, {
        status: 'queued',
        sendAfter: Date.now() + this.policy.retryDelayMs,
        lastError: error
      })
      return
    }
    this.mark(job, { status: 'failed', lastError: error })
    this.cancelRemainingParts(job, error)
  }

  private mark(job: HanxiaomiOutboundSendJob, patch: Partial<HanxiaomiOutboundSendJob>): void {
    const next = { ...job, ...patch, updatedAt: Date.now() }
    this.store.upsertOutbound(next)
    this.notifyStatus(next)
  }

  private notifyStatus(job: HanxiaomiOutboundSendJob): void {
    if (!this.deps.onStatus) return
    try {
      this.deps.onStatus(job)
    } catch (error: any) {
      console.warn(
        `[HanxiaomiOutboundQueue] onStatus listener failed for job=${job.jobId} ` +
        `event=${job.eventKey} status=${job.status}: ${error?.message || String(error)}`
      )
    }
  }

  private withSendTimeout(promise: Promise<SendTextResult>): Promise<SendTextResult> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new Error(`timed out waiting for sender result after ${this.sendTimeoutMs}ms`))
      }, this.sendTimeoutMs)
      timer.unref?.()
      promise.then(
        result => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        },
        error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  private isNonRetryableDeliveryError(error: string): boolean {
    return String(error || '').toLowerCase().includes('timed out waiting for sender result')
  }

  private recoverInterruptedJobs(): void {
    const interrupted = this.store.listOutbound().filter(job => job.status === 'sending')
    if (interrupted.length === 0) return
    const reason = 'delivery was interrupted before confirmation'
    console.warn(`[HanxiaomiOutboundQueue] recovering ${interrupted.length} interrupted sending job(s)`)
    for (const job of interrupted) {
      this.store.upsertOutbound({ ...job, status: 'failed', lastError: reason })
      const parentEventKey = job.parentEventKey || job.eventKey
      for (const part of this.store.listOutbound()) {
        if (
          part.parentEventKey === parentEventKey &&
          (part.partIndex || 0) > (job.partIndex || 0) &&
          ['queued', 'waiting', 'sending'].includes(part.status)
        ) {
          this.store.upsertOutbound({ ...part, status: 'cancelled', lastError: reason })
        }
      }
    }
  }

  private getParentEventKey(job: HanxiaomiOutboundSendJob): string {
    return job.parentEventKey || job.eventKey
  }

  private previousPartsAreSent(job: HanxiaomiOutboundSendJob): boolean {
    if (!job.parentEventKey || !job.partIndex || job.partIndex <= 1) return true
    return this.store.listOutbound()
      .filter(item => item.parentEventKey === job.parentEventKey && (item.partIndex || 0) < job.partIndex)
      .every(item => item.status === 'sent')
  }

  private getPreviousPart(job: HanxiaomiOutboundSendJob): HanxiaomiOutboundSendJob | undefined {
    if (!job.parentEventKey || !job.partIndex || job.partIndex <= 1) return undefined
    return this.store.listOutbound().find(item =>
      item.parentEventKey === job.parentEventKey &&
      item.partIndex === job.partIndex - 1 &&
      item.status === 'sent'
    )
  }

  private hasNextPart(job: HanxiaomiOutboundSendJob): boolean {
    if (!job.parentEventKey || !job.partIndex || !job.partTotal) return false
    return job.partIndex < job.partTotal
  }

  private cancelRemainingParts(job: HanxiaomiOutboundSendJob, reason: string): void {
    if (!job.parentEventKey || !job.partIndex) return
    for (const part of this.store.listOutbound()) {
      if (
        part.parentEventKey === job.parentEventKey &&
        (part.partIndex || 0) > job.partIndex &&
        ['queued', 'waiting'].includes(part.status)
      ) {
        this.mark(part, { status: 'superseded', lastError: reason })
      }
    }
  }

  private normalizeOutboundParts(text: string, segments?: string[]): string[] {
    const clean = (value: unknown) => String(value || '')
      .replace(/[~～]+/g, '')
      .replace(/\r\n/g, '\n')
      .trim()
    const segmentParts = Array.isArray(segments)
      ? segments.map(clean).filter(Boolean)
      : []
    if (segmentParts.length > 0 && segmentParts.length <= 5) return segmentParts
    const fullText = clean(text)
    return fullText ? [fullText] : ['']
  }
}

function normalizeTimestampMs(value: unknown, fallback: number): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  if (raw < 100000000000) return Math.floor(raw * 1000)
  return Math.floor(raw)
}
