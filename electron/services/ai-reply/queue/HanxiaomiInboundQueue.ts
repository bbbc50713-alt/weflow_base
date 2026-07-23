export interface HanxiaomiInboundJob<TPayload> {
  jobId: string
  contactId: string
  contactName: string
  payload: TPayload
  status: 'pending' | 'generating' | 'generated' | 'failed' | 'cancelled'
  createdAt: number
  updatedAt: number
  lastError?: string
}

export interface HanxiaomiInboundQueueOptions<TPayload> {
  concurrency?: number
  handler(job: HanxiaomiInboundJob<TPayload>): Promise<void>
  onStatus?(job: HanxiaomiInboundJob<TPayload>): void
}

export class HanxiaomiInboundQueue<TPayload> {
  private readonly queue: HanxiaomiInboundJob<TPayload>[] = []
  private readonly activeContacts = new Set<string>()
  private running = 0

  constructor(private readonly options: HanxiaomiInboundQueueOptions<TPayload>) {}

  updateConcurrency(concurrency: number): void {
    const next = Math.max(1, Math.floor(Number(concurrency) || 1))
    this.options.concurrency = next
    this.pump()
  }

  enqueue(contactId: string, contactName: string, payload: TPayload): HanxiaomiInboundJob<TPayload> {
    const now = Date.now()
    const job: HanxiaomiInboundJob<TPayload> = {
      jobId: `hxm_gen_${now}_${Math.random().toString(36).slice(2, 8)}`,
      contactId,
      contactName,
      payload,
      status: 'pending',
      createdAt: now,
      updatedAt: now
    }
    this.queue.push(job)
    this.options.onStatus?.(job)
    this.pump()
    return job
  }

  private pump(): void {
    const concurrency = Math.max(1, this.options.concurrency || 3)
    while (this.running < concurrency) {
      const index = this.queue.findIndex(job => job.status === 'pending' && !this.activeContacts.has(job.contactId))
      if (index < 0) return
      const job = this.queue.splice(index, 1)[0]
      this.running++
      this.activeContacts.add(job.contactId)
      this.run(job).finally(() => {
        this.running--
        this.activeContacts.delete(job.contactId)
        this.pump()
      })
    }
  }

  private async run(job: HanxiaomiInboundJob<TPayload>): Promise<void> {
    this.mark(job, { status: 'generating' })
    try {
      await this.options.handler(job)
      this.mark(job, { status: 'generated' })
    } catch (error: any) {
      this.mark(job, { status: 'failed', lastError: error?.message || String(error) })
    }
  }

  private mark(job: HanxiaomiInboundJob<TPayload>, patch: Partial<HanxiaomiInboundJob<TPayload>>): void {
    Object.assign(job, patch, { updatedAt: Date.now() })
    this.options.onStatus?.(job)
  }
}
