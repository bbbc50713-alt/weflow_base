import { ServerPacing, AdaptiveBatch, AdaptiveLimit, memoryPressure, runPool } from './adaptivePool'
import { promises as disk } from 'fs'
import { setMaxListeners } from 'node:events'
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, join, resolve, sep } from 'path'
import { ConfigService } from '../config'
import { chatService, type Message } from '../chatService'
import { wcdbService } from '../wcdbService'
import { ExportContext } from '../export/core/ExportContext'
import { selectedKinds } from '../../../shared/historyKinds'
import { historyKind, normalizeOrigin, toHistoryMessage } from './protocol'
import type { HistoryBinding, HistoryOptions, SessionProgress, HistorySession, HistoryStatus, WechatHistoryMessageV1 } from '../../../shared/wechatHistory'

interface State extends HistoryStatus {
  storageId?: string
  detachRequested?: 'account-change' | 'manual'
  needsReattach?: boolean
  verifyBeforeSend?: string
  stateFormat?: number
  connectorId: string
  datasetId: string
  encryptedToken?: string
  cursors: Record<string, number>
  scanEnd: number
  dailyChecked: number
  active: boolean
  pendingFinish?: boolean
  repairPeers?: Record<string,boolean>
  repairDue?: number
  repairAttempt?: number
  appliedBatches: string[]
  pass?: { run: string; end: number; finished: string[]; positions: Record<string,{time:number; keys:string[]}>; verifiedDays?: Record<string,string[]>; serverPlanReady?: boolean }
}
interface Spool {
  batch: { schema_version: 1; batch_id: string; account_wxid: string; session: HistorySession; messages: WechatHistoryMessageV1[] }
  media: Record<string, Message>
  originalBatchId?: string
  confirmedMediaKeys?: string[]
  recoveredKeys?: string[]
  recoveredCount?: number
  sent?: boolean
  maxTime: number
}
interface Revocation { origin: string; encryptedToken: string }
interface BindingReply {
  data?: HistoryBinding & { token: string }
  detail?: { message?: string; code?: string }
}
interface MediaJob { runId: string; session: string; key: string; message: Message; status: 'pending' | 'failed'; error?: string }

export class HistorySyncService {
  private directory = ''
  private root = ''
  private operations = 0
  private observedOwner = ''
  private accountEpoch = 0
  private revoking = false
  private pendingRevocations = 0
  private detachNotice?: 'account-change' | 'manual'
  private transferAbort = this.newTransferController()
  private loadError?: string
  private state!: State
  private config = ConfigService.getInstance()
  private concurrency = new AdaptiveLimit()
  private batchTarget = new AdaptiveBatch()
  private activeSessions = 0
  private reading = new Map<typeof wcdbService, number>()
  private checkInFlight = 0
  private uploadInFlight = 0

  private phaseSamples: {at:number; run:string; kind:'read'|'batch'|'check'; ms:number}[] = []
  private noteDuration(kind:'read'|'batch'|'check', start:number, run:string|undefined) {
    if (!run || run!==this.state.runId) return
    const now=Date.now()
    this.phaseSamples.push({at:now,run,kind,ms:now-start})
    while (this.phaseSamples.length && (this.phaseSamples[0].at<now-60000 || this.phaseSamples.length>4096)) this.phaseSamples.shift()
  }
  private medianDuration(kind:'read'|'batch'|'check',run:string) {
    const values=this.phaseSamples.filter(v=>v.kind===kind && v.run===run && v.at>=Date.now()-60000).map(v=>v.ms).sort((a,b)=>a-b)
    return values.length ? values[Math.floor(values.length/2)] : null
  }
  private newTransferController() {
    const controller = new AbortController()
    setMaxListeners(0, controller.signal) // One shared signal for all history readers.
    return controller
  }

  private waitForRead<T>(work: Promise<T>, signal = this.transferAbort.signal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('同步已停止，本机进度已保留'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void work.then(
        value => { signal.removeEventListener('abort', abort); resolve(value) },
        error => { signal.removeEventListener('abort', abort); reject(error) },
      )
    })
  }

  private async readOn<T>(reader: typeof wcdbService, read: () => Promise<T>): Promise<T> {
    const started=Date.now(), rid=this.state.runId
    this.reading.set(reader, (this.reading.get(reader) || 0) + 1)
    this.schedulePoolDisplay()
    try {
      return await this.waitForRead(read())
    } finally {
      this.noteDuration('read',started,rid)
      const left = (this.reading.get(reader) || 1) - 1
      if (left) this.reading.set(reader, left)
      else this.reading.delete(reader)
      this.schedulePoolDisplay()
    }
  }
  private busy = false
  private mediaBusy = false
  private previewBusy = false
  private timer?: ReturnType<typeof setInterval>
  private retryAt = 0
  private failures = 0
  private mediaContext = new ExportContext()

  private init() {
    if (this.loadError) throw new Error(this.loadError)
    if (this.directory) return
    this.root = join(app.getPath('userData'), 'history-sync')
    this.directory = this.root
    for (const dir of ['media-queue', 'checkpoints', 'revocations']) {
      mkdirSync(join(this.root, dir), { recursive: true })
    }
    this.pendingRevocations = this.revocationFiles().length
    this.state = this.newState()
    const path = join(this.root, 'state.json')
    if (existsSync(path)) {
      try {
        const saved = JSON.parse(readFileSync(path, 'utf8'))
        this.state = { ...this.state, ...saved }
        this.selectStorage()
        if (saved.runId && saved.binding && ['paused', 'running', 'offline'].includes(saved.status)) {
          this.state.verifyBeforeSend = saved.runId
        }
        if (!saved.stateFormat && saved.runId && saved.binding && !['completed','partial','cancelled'].includes(saved.status)) {
          if (!saved.connectorId || !saved.datasetId || !saved.encryptedToken) throw new Error('旧任务缺少恢复身份')
          const backup = join(this.root, 'state.pre-5.0.5.json')
          if (!existsSync(backup)) writeFileSync(backup, JSON.stringify({ ...saved, encryptedToken: undefined }), { flag: 'wx', mode: 0o600 })
          this.state.legacyRecovery = { runId: saved.runId, checked: 0, previousScanned: saved.scanned || 0 }
          this.state.active = false
          this.state.status = 'paused'
          this.atomic(path, this.state)
        }
      } catch {
        this.loadError = '同步状态文件损坏，请保留文件并修复后继续'
        throw new Error(this.loadError)
      }
    }
    this.config.onHistoryAccountChange?.(() => this.accountChanged())
    this.accountChanged()
    this.finishDetach()
  }

  private newState(connectorId: string = randomUUID()): State {
    return {
      stateFormat: 2, origin: 'https://zt.hmed1991.com', accountWxid: '', status: 'unbound',
      options: { sessions: [], start: 0, end: 0, media: true, continuous: true },
      completedSessions: 0, totalSessions: 0, scanned: 0, inserted: 0, existing: 0, failed: 0,
      mediaPending: 0, mediaUploaded: 0, problems: [], connectorId, datasetId: randomUUID(),
      cursors: {}, scanEnd: 0, dailyChecked: 0, active: false, appliedBatches: [],
    }
  }

  private selectStorage() {
    const id = this.state.storageId
    if (id && !/^[0-9a-f-]{36}$/.test(id)) throw new Error('同步进度目录无效')
    this.directory = id ? join(this.root, 'profiles', id) : this.root
    mkdirSync(join(this.directory, 'media-queue'), { recursive: true })
  }

  private accountChanged() {
    const owner = this.config.getMyWxidCleaned()
    if (owner !== this.observedOwner) {
      this.observedOwner = owner
      this.accountEpoch++
    }
    if (this.state.binding && owner !== this.state.binding.account_wxid && !this.state.detachRequested) {
      this.beginDetach('account-change')
    }
  }

  private checkpointPath(origin: string, binding: HistoryBinding) {
    const scope = [origin, binding.tenant_id, binding.channel_account_id, binding.account_wxid]
    return join(this.root, 'checkpoints', createHash('sha256').update(JSON.stringify(scope)).digest('hex') + '.json')
  }

  private revocationFiles() {
    return readdirSync(join(this.root, 'revocations')).filter(file => /^[a-f0-9]{64}\.json$/.test(file))
  }

  private enqueueRevocation(origin: string, bindingId: number, encryptedToken: string) {
    const id = createHash('sha256').update(JSON.stringify([origin, bindingId])).digest('hex')
    this.atomic(join(this.root, 'revocations', id + '.json'), { origin, encryptedToken } satisfies Revocation)
    this.pendingRevocations = this.revocationFiles().length
  }

  private async revokeDetachedBindings() {
    if (this.revoking || !this.pendingRevocations) return
    this.revoking = true
    try {
      for (const name of this.revocationFiles()) {
        const path = join(this.root, 'revocations', name)
        try {
          const entry: Revocation = JSON.parse(readFileSync(path, 'utf8'))
          const token = safeStorage.decryptString(Buffer.from(entry.encryptedToken, 'base64'))
          const response = await fetch(normalizeOrigin(entry.origin) + '/api/v1/wechat-history/bindings/current/detach', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { Authorization: 'Bearer ' + token },
          })
          const result = await response.json().catch(() => null) as {
            data?: { revoked?: boolean }; detail?: { code?: string }
          } | null
          if ((response.ok && result?.data?.revoked === true) || result?.detail?.code === 'BINDING_REVOKED') {
            unlinkSync(path)
          }
        } catch {
          // Keep the old credential isolated until the server confirms revocation.
        }
      }
    } finally {
      this.revoking = false
      const remaining = this.revocationFiles().length
      if (this.pendingRevocations !== remaining) {
        this.pendingRevocations = remaining
        this.publishStatus()
      }
    }
  }

  private beginDetach(reason: 'account-change' | 'manual') {
    if (!this.state.detachRequested) {
      this.state.active = false
      this.state.detachRequested = reason
      this.detachNotice = reason
      this.transferAbort.abort()
      this.save()
    }
    this.finishDetach()
  }

  private finishDetach() {
    const old = this.state
    const binding = old.detachRequested && old.binding
    if (!binding || this.busy || this.mediaBusy || this.previewBusy || this.operations) return
    const { encryptedToken, detachRequested, ...checkpoint } = old
    this.detachNotice = detachRequested
    const status = old.status === 'completed' || old.status === 'partial' ? old.status : old.runId ? 'paused' : 'idle'
    this.atomic(this.checkpointPath(old.origin, binding), {
      ...checkpoint, binding: undefined, active: false, status, error: undefined,
      needsReattach: Boolean(old.runId),
    })
    if (encryptedToken) this.enqueueRevocation(old.origin, binding.id, encryptedToken)
    const fresh = this.newState(old.connectorId)
    this.atomic(join(this.root, 'state.json'), fresh)
    this.state = fresh
    this.selectStorage()
    this.transferAbort = this.newTransferController()
    this.nameCache.clear()
    this.cacheOwner = ''
    this.publishStatus()
    void this.revokeDetachedBindings()
  }

  private async trackOperation<T>(work: () => Promise<T>): Promise<T> {
    this.operations++
    try { return await work() }
    finally { this.operations--; this.finishDetach() }
  }

  startScheduler() {
    this.init()
    if (this.timer) return
    const feedbackTimer=setInterval(()=>{if(this.state.active) void this.sampleServer()},5000)
    feedbackTimer.unref()
    this.timer = setInterval(() => {
      this.accountChanged()
      this.finishDetach()
      void this.revokeDetachedBindings()
      void this.tick()
    }, 30_000)
    this.timer.unref()
    void this.revokeDetachedBindings()
    void this.tick()
  }

  private atomic(path: string, value: unknown) {
    writeFileSync(path + '.tmp', JSON.stringify(value), 'utf8')
    renameSync(path + '.tmp', path)
  }

  private save() {
    this.atomic(join(this.root, 'state.json'), this.state)
    this.publishStatus()
  }

  private publishStatus() {
    const status = this.status()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('historySync:status', status)
    }
  }

  status(): HistoryStatus {
    this.init()
    this.accountChanged()
    const state = this.state
    const accountWxid = this.config.getMyWxidCleaned()
    if (state.detachRequested) {
      const clean = this.newState()
      return { origin: clean.origin, options: clean.options, status: 'unbound', accountWxid, detaching: true,
        detachReason: state.detachRequested, revocationsPending: this.pendingRevocations,
        problems: [], completedSessions: 0, totalSessions: 0, scanned: 0, inserted: 0, existing: 0, failed: 0, mediaPending: 0, mediaUploaded: 0 }
    }
    const { connectorId, datasetId, storageId, detachRequested, needsReattach, encryptedToken, cursors, scanEnd, dailyChecked, active, pendingFinish, repairPeers, repairDue, repairAttempt, appliedBatches, pass, ...view } = state
    return { ...view, detachReason: this.detachNotice, revocationsPending: this.pendingRevocations, recovering: needsReattach, startedAt:this.state.startedAt || (this.state.runId && this.state.scanEnd ? this.state.scanEnd*1000 : undefined),startEstimated:!this.state.startedAt,retryAfter:Math.max(this.retryAt,this.state.repairDue || 0),feedbackLabel:this.pacing.fresh()?this.pacing.reason:'按回执和本机资源调速',sendLimit:this.pacing.fresh()?this.pacing.limit:this.pacing.receivedAt?Math.min(6,this.concurrency.limit):this.concurrency.limit,batchRows:this.batchTarget.rows,batchBytes:this.batchTarget.bytes,readerCount:wcdbService.historyReaderCount(), activeReaders:this.reading.size, activeChecks:this.checkInFlight, activeUploads:this.uploadInFlight, concurrencyLimit: this.concurrency.limit, activeSessions:this.activeSessions, initialScanComplete: Boolean(this.state.runId && dailyChecked), typeFilterVersion: 1, accountWxid: this.config.getMyWxidCleaned() }
  }

  private assertAccount() {
    this.accountChanged()
    if (this.state.detachRequested || !this.state.binding || this.config.getMyWxidCleaned() !== this.state.binding.account_wxid) {
      throw new Error('当前微信没有可用的同步绑定，请重新绑定')
    }
  }

  private token() {
    if (!this.state.encryptedToken || !safeStorage.isEncryptionAvailable()) throw new Error('同步凭据不可用，请重新绑定')
    return safeStorage.decryptString(Buffer.from(this.state.encryptedToken, 'base64'))
  }

  private pacing = new ServerPacing()
  private pumping = 0
  private telemetry?: import('../../../shared/wechatHistory').ServerTransferMetrics
  private telemetryBusy = false
  private nextTelemetry = 0

  private async sampleServer() {
    const state = this.state
    const rid=state?.runId
    if (!rid || !this.state.binding || this.state.status==='unbound' || this.telemetryBusy || Date.now()<this.nextTelemetry) return
    this.telemetryBusy=true
    this.nextTelemetry=Date.now()+10000
    try {
      const s=await this.request('/runs/'+rid+'/metrics')
      if (this.state !== state || state.detachRequested || state.runId!==rid || s?.run_id!==rid) return
      this.telemetry=s
      if (s.started_at && Number.isFinite(Date.parse(s.started_at)) && this.state.startedAt!==Date.parse(s.started_at)) { this.state.startedAt=Date.parse(s.started_at);this.save() }
      if (s.queue_enabled) {
        const signal=this.pacing.observe(s)
        this.batchTarget.allowServerGrowth=signal==='room'||signal==='unknown'
        if (signal==='busy'){this.concurrency.congested();this.batchTarget.backoff()}
      }
    } catch(error) {
      if (this.state !== state || state.detachRequested) return
      this.telemetry=undefined
      if ((error as {statusCode?:number}).statusCode===404) this.nextTelemetry=Date.now()+60000
    } finally {
      this.telemetryBusy=false
      if (!this.pacing.fresh()) this.batchTarget.allowServerGrowth=true
    }
  }

  private async pacedPost(spool: Spool) {
    while(this.pumping >= (this.pacing.fresh() ? this.pacing.limit : this.pacing.receivedAt ? Math.min(6,this.concurrency.limit) : this.concurrency.limit)) {
      if (!this.state.active) throw new Error('任务已暂停，批次已保留')
      await new Promise(r=>setTimeout(r,200))
    }
    this.assertAccount()
    if (!this.state.active) throw new Error('任务已暂停，批次已保留')
    this.pumping++
    try { return await this.request(`/runs/${this.state.runId}/batches`,'POST',spool.batch) }
    finally {this.pumping--}
  }

  private recentUpload: Array<{ time:number; bytes:number; check:boolean }> = []
  private rateRun = ''

  private uploadRate(runId:string, bytes=0, check=false) {
    const now=Date.now()
    if (this.rateRun !== runId) { this.rateRun=runId; this.recentUpload=[] }
    this.recentUpload=this.recentUpload.filter(s=>s.time>now-60000)
    if (bytes) this.recentUpload.push({time:now,bytes,check})
    return this.recentUpload.reduce((sum,s)=>sum+(s.check===check ? s.bytes : 0),0)/60
  }


  private remoteCounts?: {id:string;at:number;counts:{inserted?:number;existing?:number;failed?:number}|null}

  async metrics(): Promise<import('../../../shared/wechatHistory').TransferMetrics> {
    this.init(); this.assertAccount()
    const state = this.state
    const runId = state.runId
    if (!runId) throw new Error('尚无任务')
    const files = await disk.readdir(this.directory)
    // Production 5.0.1 API already exposes the authoritative task totals.
    // Cache the read-only snapshot instead of aggregating the run on every UI refresh.
    const now = Date.now()
    if (this.remoteCounts?.id !== runId || now-this.remoteCounts.at > 60000) {
      const snapshot = await this.request('/runs/'+runId,'GET',undefined,{},true).catch(()=>null)
      this.remoteCounts = {id:runId,at:now,counts:snapshot?.id===runId ? snapshot.counts : null}
    }
    await this.sampleServer()
    const server = this.telemetry?.run_id === runId ? this.telemetry : null
    const counts = this.remoteCounts?.id === runId ? this.remoteCounts.counts : null
    this.assertAccount()
    if (state !== this.state || runId !== state.runId) throw new Error('任务已变更')
    return {runId, clientPending: files.filter(f=>/^(?:batch|batch-[0-9a-f-]{36})\.json$/.test(f)).length,
      readMs:this.medianDuration('read',runId),batchMs:this.medianDuration('batch',runId),checkMs:this.medianDuration('check',runId), counts, clientAcknowledged: this.state.scanned, bytesPerSecond:this.uploadRate(runId), checkBytesPerSecond:this.uploadRate(runId,0,true), checkRequests:this.recentUpload.filter(s=>s.check).length,server}
  }

  private async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, observation = false): Promise<any> {
    this.assertAccount()
    const state = this.state
    const serialized = body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body)
    const isMetrics = observation || path.endsWith('/metrics')
    const runId = this.state.runId
    const stage = method === 'POST' && path.endsWith('/reconcile') ? 'checkInFlight' :
      method === 'POST' && (path.endsWith('/batches') || path.includes('/media?')) ? 'uploadInFlight' : undefined
    if (stage) { this[stage]++; this.schedulePoolDisplay() }
    try {
      const requestStarted=Date.now()
    const timeout = AbortSignal.timeout(path.endsWith('/report') ? 180000 : isMetrics ? 7000 : body instanceof Buffer ? 120_000 : 30_000)
    const interruptible = stage || method === 'GET' || path.endsWith('/media/missing')
    const response = await fetch(state.origin + '/api/v1/wechat-history' + path, {
        method, redirect: 'error', signal: interruptible ? AbortSignal.any([timeout, this.transferAbort.signal]) : timeout,
        headers: { Authorization: `Bearer ${this.token()}`, 'Content-Type': 'application/json', ...headers },
        body: serialized,
      })
      const result: any = await response.json().catch(() => ({}))
    if (stage==='uploadInFlight' && (Date.now()-requestStarted>=8000 || [429,503].includes(response.status))) this.concurrency.congested()
    if(response.ok && (path.endsWith('/reconcile') || path.endsWith('/batches'))) this.noteDuration(path.endsWith('/batches')?'batch':'check',requestStarted,runId)
      if (path.endsWith('/batches') && [429,503,504].includes(response.status)) this.batchTarget.backoff()
      if (!response.ok) {
        if (!isMetrics && state === this.state && !state.detachRequested && [401, 403].includes(response.status)) { state.active = false; state.status = 'paused' }
        const error = new Error(result.detail?.message || (typeof result.detail === 'string' ? result.detail : '') || `中台请求失败 (${response.status})`)
        Object.assign(error, { statusCode: response.status, serverCode: result.detail?.code })
        throw error
      }
      if (runId && runId === this.state.runId && method==='POST' && serialized &&
          (path.endsWith('/batches') || path.includes('/media?') || path.endsWith('/reconcile'))) {
        this.uploadRate(runId,typeof serialized==='string' ? Buffer.byteLength(serialized) : serialized.byteLength, path.endsWith('/reconcile'))
      }
      return result.data
    } catch (error) {
      if (stage && (error as Error)?.name === 'TimeoutError') {
        if (path.endsWith('/batches')) this.batchTarget.backoff()
        this.concurrency.congested()
        throw Object.assign(new Error('等待中台回执超时，已保留本地批次。恢复后先核对，再补交缺失记录。'), {receiptTimeout:true})
      }
      throw error
    } finally {
      if (stage) { this[stage]--; this.schedulePoolDisplay() }
    }
  }

  private nameCache = new Map<string,string>()
  private cacheOwner = ''
  private async scopeSessions(options: HistoryOptions) {
    if (!options.sessions.length) return this.sessions()
    const sameOwner = this.cacheOwner === this.config.getMyWxidCleaned()
    return [...new Set(options.sessions)].filter(id => id && !id.startsWith('gh_') && !id.endsWith('@app') &&
      !['weixin','filehelper','fmessage','qmessage','newsapp','mphelper','medianote'].includes(id))
      .map(id => ({id, name:(sameOwner && this.nameCache.get(id)) || id, group:id.endsWith('@chatroom')}))
  }

  async sessions() {
    this.init()
    const state = this.state
    const owner = this.config.getMyWxidCleaned()
    const result = await this.waitForRead(chatService.getSessions())
    if (!result.success) throw Object.assign(new Error(/timed out/i.test(result.error || '') ? '本地会话读取超时，请暂停其他读取任务后重试。' : `本地读取组件未就绪，请检查 WeFlow 数据库配置。${result.error || ''}`), { retryRead: true })
    const list = (result.sessions || []).filter(s => !s.username.startsWith('gh_') && !s.username.endsWith('@app') &&
      !['weixin', 'filehelper', 'fmessage', 'qmessage', 'newsapp', 'mphelper', 'medianote'].includes(s.username))
      .map(s => ({ id: s.username, name: s.displayName || s.username, group: s.username.endsWith('@chatroom') }))
    if (!owner || this.state !== state || this.config.getMyWxidCleaned() !== owner) throw new Error('本地账号发生变化，请重新读取会话')
    this.init()
    const registry = join(this.root, 'order-' + createHash('sha256').update(owner).digest('hex') + '.json')
    const exists = existsSync(registry)
    const oldOrder: string[] = exists ? JSON.parse(readFileSync(registry, 'utf8')) :
      this.state.binding?.account_wxid === owner && !this.state.options.sessions.length ?
        (this.state.sessionProgress || []).map(row => row.id) : []
    if (!Array.isArray(oldOrder) || oldOrder.some(id => typeof id !== 'string') || new Set(oldOrder).size !== oldOrder.length)
      throw new Error('本地会话序号记录无效，请保留原文件后处理')
    const order = new Map(oldOrder.map((id,index) => [id,index+1]))
    for (const {id} of list) if (!order.has(id)) order.set(id,order.size+1)
    if (!exists || order.size !== oldOrder.length) this.atomic(registry,[...order.keys()])
    this.cacheOwner = owner; this.nameCache = new Map(list.map(s => [s.id,s.name]))
    return list.map(s=>({...s,ordinal:order.get(s.id)!})).sort((a,b)=>a.ordinal-b.ordinal)
  }

  async bind(origin: string, code: string) {
    this.init()
    if (this.state.detachRequested) throw new Error('正在保存原账号同步进度，请稍后绑定')
    if (this.operations || this.busy || this.state.binding) throw new Error('请先解除现有绑定后再绑定其他中台')
    return this.trackOperation(() => this.pair(origin, code))
  }

  private async pair(origin: string, code: string) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法安全保存同步凭据')
    const owner = this.config.getMyWxidCleaned()
    if (!owner) throw new Error('请先连接本地微信数据库')
    origin = normalizeOrigin(origin)
    const connectorId = this.state.connectorId
    const epoch = this.accountEpoch
    const response = await fetch(origin + '/api/v1/wechat-history/bindings', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), account_wxid: owner, connector_id: connectorId, preserve_history: true }),
    })
    const result = await response.json().catch(() => null) as BindingReply | null
    if (!response.ok || !result?.data?.token) throw new Error(result?.detail?.message || '中台绑定失败，请检查中台版本及绑定码')
    const { token, ...binding } = result.data
    const encryptedToken = safeStorage.encryptString(token).toString('base64')
    if (this.accountEpoch !== epoch || this.config.getMyWxidCleaned() !== owner || binding.account_wxid !== owner) {
      this.enqueueRevocation(origin, binding.id, encryptedToken)
      void this.revokeDetachedBindings()
      throw new Error('绑定期间微信账号已切换，请重新绑定当前微信')
    }
    const path = this.checkpointPath(origin, binding)
    let saved: State | undefined
    try {
      if (existsSync(path)) {
        saved = JSON.parse(readFileSync(path, 'utf8'))
        if (!saved || saved.origin !== origin || saved.accountWxid !== owner ||
            !saved.connectorId || !saved.datasetId ||
            (saved.storageId && !/^[0-9a-f-]{36}$/.test(saved.storageId))) throw new Error('Invalid checkpoint')
      }
    } catch {
      this.enqueueRevocation(origin, binding.id, encryptedToken)
      void this.revokeDetachedBindings()
      throw new Error('原账号的本地进度文件有误，已保留，请检查后再绑定')
    }
    this.state = {
      ...this.newState(connectorId), ...saved, origin, accountWxid: owner, binding,
      storageId: saved ? saved.storageId : randomUUID(),
      encryptedToken, active: false, detachRequested: undefined, status: saved?.status || 'idle',
    }
    this.selectStorage()
    this.retryAt = this.failures = 0
    this.pacing = new ServerPacing()
    this.telemetry = undefined
    this.remoteCounts = undefined
    this.nextTelemetry = 0
    this.detachNotice = undefined
    this.save()
    return this.status()
  }

  async unbind() {
    this.init()
    if (this.state.binding) this.beginDetach('manual')
    return this.status()
  }

  private async reattachOriginal() {
    if (!this.state.needsReattach) return
    const runId = this.state.runId
    const result = await this.request('/runs/' + runId + '/reattach', 'POST', { dataset_id: this.state.datasetId })
    this.assertAccount()
    if (result?.id !== runId) throw new Error('未能确认原同步任务，已保留本地断点')
    this.state.needsReattach = false
    this.save()
  }

  private async validateOrdinalRange(options: HistoryOptions) {
    const range = options.ordinalRange
    if (!range) return
    if (range.owner !== this.config.getMyWxidCleaned() || !Number.isSafeInteger(range.first) ||
        !Number.isSafeInteger(range.last) || range.first < 1 || range.first > range.last)
      throw new Error('会话序号或账号无效')
    const list = await this.sessions()
    const ids = list.filter(s=>s.ordinal >= range.first && s.ordinal <= range.last).map(s=>s.id)
    if (!ids.length || range.last > (list.at(-1)?.ordinal || 0) || JSON.stringify(ids)!==JSON.stringify(options.sessions))
      throw new Error('会话范围已变化或为空，请刷新名单后重新选择')
  }

  async start(options: HistoryOptions): Promise<HistoryStatus> {
    this.init()
    return this.trackOperation(() => this.doStart(options))
  }

  private async doStart(options: HistoryOptions, reconcileExisting = false): Promise<HistoryStatus> {
    this.init(); this.assertAccount()
    if (this.previewBusy) throw new Error('范围统计尚未结束')
    if (this.busy || this.mediaBusy) throw new Error('当前批次正在结束，请稍后再开始')
    if (this.state.status === 'running') return this.status()
    await this.validateOrdinalRange(options)
    this.assertAccount()
    await this.reattachOriginal()
    this.assertAccount()
    const kinds = selectedKinds(options.kinds)
    if (options.end && options.start > options.end) throw new Error('开始时间不能晚于结束时间')
    if (this.state.runId && ['paused', 'offline'].includes(this.state.status)) {
      const prev = this.state.options
      if (prev.start === options.start && prev.end === options.end && prev.media === options.media && prev.continuous === options.continuous &&
          JSON.stringify(prev.sessions) === JSON.stringify(options.sessions) && selectedKinds(prev.kinds).join() === kinds.join()) return this.resume()
      if (this.pendingFiles().length) throw new Error('有未确认的批次，请先按原范围继续，收到中台确认后再更改类型')
      await this.request('/runs/' + this.state.runId, 'PATCH', { action: 'cancel' })
      this.assertAccount()
      this.state.runId = undefined; this.state.status = 'idle'; this.state.active = false; this.save()
    }
    this.state.verifyBeforeSend = undefined
    this.state.legacyRecovery = undefined
    this.concurrency = new AdaptiveLimit()
    this.batchTarget = new AdaptiveBatch()
    this.state.pass = undefined; this.state.sessionProgress = undefined; this.state.progressPhase = undefined
    this.state.mediaPending = this.state.mediaUploaded = 0
    this.state.options = { ...options, kinds, sessions: [...new Set(options.sessions)].filter(Boolean) }
    this.state.cursors = {}; this.state.dailyChecked = 0; this.state.scanEnd = Math.floor(Date.now() / 1000)
    this.state.pendingFinish = false; this.state.completedSessions = 0; this.state.totalSessions = 0; this.state.currentSession = undefined
    this.state.scanned = this.state.inserted = this.state.existing = this.state.failed = 0
    this.state.problems = []; this.state.error = undefined
    const check = await this.request('/bindings/current')
    this.assertAccount()
    this.state.problems = check.conflicts.map((x: any) => ({ session_wxid: x.session_wxid, error: '中台存在重复会话，请查重后重试' }))
    const run = await this.request('/runs', 'POST', { dataset_id: this.state.datasetId, options: this.state.options })
    this.retryAt = 0; this.failures = 0
    this.state.repairPeers={};this.state.repairDue=0;this.state.repairAttempt=0
    this.state.startedAt=Date.now();this.state.finishedAt=undefined;this.telemetry=undefined;this.pacing=new ServerPacing();this.nextTelemetry=0
    this.state.runId = run.id
    if (reconcileExisting) this.state.verifyBeforeSend = run.id
    this.assertAccount()
    this.state.active = true; this.state.status = 'running'; this.save()
    if (this.timer) void this.sampleServer()
    void this.tick(); return this.status()
  }

  async pause() {
    this.init()
    return this.trackOperation(() => this.doPause())
  }

  private async doPause() {
    this.assertAccount(); this.state.active = false; this.state.status = 'paused'; this.save()
    // A locally acknowledged in-flight batch is persisted before the next start.
    if (!this.busy && !this.mediaBusy && this.state.runId) await this.request(`/runs/${this.state.runId}`, 'PATCH', { action: 'pause' })
    return this.status()
  }

  async resume(): Promise<HistoryStatus> {
    this.init()
    return this.trackOperation(() => this.doResume())
  }

  private async doResume(): Promise<HistoryStatus> {
    this.init(); this.assertAccount()
    if (this.previewBusy || this.busy || this.mediaBusy) throw new Error('当前批次或范围统计尚未结束，请稍后继续')
    if (!this.state.runId) return this.start(this.state.options)
    await this.reattachOriginal()
    const resumed = await this.request(`/runs/${this.state.runId}`, 'PATCH', { action: 'resume' })
    this.assertAccount()
    if (resumed.status === 'completed' || resumed.status === 'partial') {
      this.state.status = resumed.status
      this.save()
      return this.status()
    }
    if (resumed.status !== 'running') throw new Error('中台原任务当前无法继续：'+resumed.status)
    this.state.verifyBeforeSend = this.state.runId
    this.state.active = true; this.state.status = 'running'; this.state.error = undefined; if(this.state.repairDue)this.state.repairDue=Date.now(); this.retryAt = 0; this.save()
    void this.tick(); return this.status()
  }

  async retry() {
    this.init()
    return this.trackOperation(() => this.doRetry())
  }

  private async doRetry() {
    this.assertAccount()
    if (this.previewBusy || this.busy || this.mediaBusy) throw new Error('请先暂停并等待当前批次结束')
    if (this.pendingFiles().length) throw new Error('请先按原范围继续并确认待传批次，再重试')
    await this.reattachOriginal()
    if (this.state.runId) await this.request(`/runs/${this.state.runId}`, 'PATCH', { action: 'cancel' })
    this.assertAccount()
    this.state.runId = undefined; this.state.status = 'idle'
    for (const file of readdirSync(join(this.directory, 'media-queue'))) {
      if (!file.endsWith('.json')) continue
      const path = join(this.directory, 'media-queue', file)
      const job: MediaJob = JSON.parse(readFileSync(path, 'utf8')); job.status = 'pending'; this.atomic(path, job)
    }
    // Restart from source; the server ledger makes this safe and retries only unresolved items.
    return this.doStart(this.state.options, true)
  }

  async review() {
    this.init(); this.assertAccount()
    const state = this.state
    if (!state.runId) throw new Error('尚无同步任务')
    await this.trackOperation(() => this.reattachOriginal())
    if (this.state !== state) throw new Error('同步账号已变更')
    const report = await this.request(`/runs/${state.runId}/report`)
    if (this.state !== state) throw new Error('同步账号已变更')
    this.assertAccount()
    return { id: report.id, partitions: report.partitions }
  }

  async rescan() {
    this.init()
    return this.trackOperation(() => this.doRescan())
  }

  private async doRescan() {
    this.init(); this.assertAccount()
    if (this.state.status !== 'paused' || !this.state.runId || this.busy || this.mediaBusy || this.previewBusy)
      throw new Error('请暂停同步，等当前批次结束后再重新核对')
    this.state.dailyChecked = 0
    this.state.legacyRecovery = undefined
    this.state.pass = undefined; this.state.sessionProgress = undefined
    this.state.scanEnd = Math.floor(Date.now() / 1000)
    this.state.pendingFinish = false
    for (const name of readdirSync(join(this.directory, 'media-queue'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const path = join(this.directory, 'media-queue', name)
      const job: MediaJob = JSON.parse(readFileSync(path, 'utf8'))
      if (job.runId === this.state.runId && job.status === 'failed') {
        job.status = 'pending'; delete job.error; this.atomic(path, job)
      }
    }
    this.save()
    return this.resume()
  }

  async report(): Promise<{ path?: string }> {
    this.init()
    if (!this.state.runId) throw new Error('尚无同步任务可导出')
    const state = this.state
    await this.trackOperation(() => this.reattachOriginal())
    if (this.state !== state) throw new Error('同步账号已变更')
    const report = await this.request(`/runs/${state.runId}/report`)
    if (this.state !== state) throw new Error('同步账号已变更')
    this.assertAccount()
    const selection = await dialog.showSaveDialog({ title: '保存同步对账报告', defaultPath: `wechat-history-${this.state.runId}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (selection.canceled || !selection.filePath) return {}
    writeFileSync(selection.filePath, JSON.stringify({ ...report, local_problems: state.problems }, null, 2), 'utf8')
    return { path: selection.filePath }
  }

  private problem(session: string, key: string, error: string) {
    const repairs=this.state.repairPeers ??= {}
    repairs[session]=true
    if (this.state.options.continuous && !this.state.repairDue) this.state.repairDue=Date.now()+60000
    this.state.failed++
    this.state.problems.push({ session_wxid: session, source_key: key, error })
    this.state.problems = this.state.problems.slice(-200)
  }

  private async sessionInfo(id: string, reader: typeof wcdbService): Promise<HistorySession> {
    const raw = (await reader.getContact(id)).contact
    const nickname = raw?.nick_name || raw?.nickname || raw?.nickName || ''
    const remark = raw?.remark || raw?.remark_name || ''
    let members: HistorySession['members'] = []
    if (id.endsWith('@chatroom')) {
      const result = await reader.getGroupMembers(id)
      members = (result.members || []).slice(0, 2000).map((m: any) => ({
        wxid: String(m.wxid || m.username || m.member_wxid || ''), nickname: String(m.nickname || m.nickName || ''),
        display_name: String(m.displayName || m.display_name || m.groupNickname || ''),
      })).filter(m => m.wxid)
    }
    return { wxid: id, display_name: remark || nickname || this.nameCache.get(id) || id, nickname,
      remark, avatar_url: '', members }
  }

  private pendingFiles() {
    return readdirSync(this.directory).filter(name => /^(?:batch|batch-[0-9a-f-]{36})\.json$/.test(name)).map(name => join(this.directory, name))
  }

  private async submit(spool: Spool, progress?: SessionProgress) {
    spool.sent = false
    const path = join(this.directory, 'batch-' + spool.batch.batch_id + '.json')
    await disk.writeFile(path + '.tmp', JSON.stringify(spool), 'utf8')
    await disk.rename(path + '.tmp', path)
    await this.uploadSpool(spool, path, progress)
  }

  // Called for both fresh reads during recovery and persisted batches with a lost reply.
  private async keepOnlyMissing(spool: Spool) {
    const candidates = spool.batch.messages
    if (!candidates.length) return
    const keys = candidates.map(m=>m.source_key)
    const keySet = new Set(keys)
    const check = await this.request(`/runs/${this.state.runId}/reconcile`, 'POST', {
      session_wxid:spool.batch.session.wxid,source_keys:keys,
    })
    this.assertAccount()
    if (!check || !Array.isArray(check.missing)) throw new Error('旧任务对账回执不完整，保留断点')
    const missing = new Set<string>(check.missing)
    if (missing.size !== check.missing.length ||
        check.expected !== keySet.size || check.matched !== keySet.size-missing.size ||
        [...missing].some(k=>!keySet.has(k))) throw new Error('旧任务对账回执不完整，保留断点')
    const known = new Set(keys.filter(k=>!missing.has(k)))
    const hash = (s:string) => createHash('sha256').update(s).digest('hex')
    // The receiver hashes the complete requested key set, including keys listed as missing.
    const digest = hash([...keySet].map(k=>hash(spool.batch.session.wxid+'\0'+k)).sort().join('\n'))
    if (digest !== check.source_digest) throw new Error('旧任务来源摘要不一致，保留断点')
    if (!known.size) return
    spool.originalBatchId ??= spool.batch.batch_id
    spool.recoveredCount = (spool.recoveredCount || 0) + known.size
    const boundary = candidates.filter(m=>known.has(m.source_key) && Date.parse(m.occurred_at)===spool.maxTime*1000)
    spool.recoveredKeys = [...new Set([...(spool.recoveredKeys || []),...boundary.map(m=>m.source_key)])]
    if (this.state.options.media) spool.confirmedMediaKeys = [...new Set([...(spool.confirmedMediaKeys || []),
      ...candidates.filter(m=>known.has(m.source_key) && m.media_kind && spool.media[m.source_key]).map(m=>m.source_key)])]
    spool.batch.messages = candidates.filter(m=>!known.has(m.source_key))
    // A server receipt binds a batch ID to exact contents. Derive a repeatable ID for each remainder.
    spool.batch.batch_id = hash(JSON.stringify([spool.originalBatchId,spool.batch.messages.map(m=>m.source_key)]))
  }

  private async postBatchUntilReceipt(spool: Spool) {
    const run=this.state.runId
    try {
      return await this.pacedPost(spool)
    } catch (error) {
      const failure=error as {receiptTimeout?:boolean; serverCode?:string}
      if (!failure.receiptTimeout && failure.serverCode!=='INBOX_PENDING') throw error
      // An accepted batch can commit after its HTTP request ends. Poll its immutable receipt.
      for (const delay of [1000,2000,4000,8000,8000]) {
        if (!this.state.active || run!==this.state.runId) break
        await new Promise(resolve=>setTimeout(resolve,delay))
        if (!this.state.active || run!==this.state.runId) break
        this.assertAccount()
        const status=await this.request(`/runs/${run}/batches/${encodeURIComponent(spool.batch.batch_id)}/receipt`).catch(()=>null)
        if (status?.state==='committed') return status.receipt
        if (status?.state!=='pending') break
      }
      throw error
    }
  }

  private async uploadSpool(spool: Spool, path: string, progress?: SessionProgress) {
    this.assertAccount()
    const creditId = spool.originalBatchId || spool.batch.batch_id
    if (this.state.appliedBatches.includes(creditId)) { unlinkSync(path); return }
    let receipt
    if (spool.sent !== false) {
      const recovery = await this.request(`/runs/${this.state.runId}/batches/${encodeURIComponent(spool.batch.batch_id)}/receipt`)
      this.assertAccount()
      if (recovery?.state === 'committed') receipt = recovery.receipt
      if (recovery?.state === 'pending') {
        throw Object.assign(new Error('中台已接收该批次，等待入库回执'), { serverCode: 'INBOX_PENDING' })
      }
      if (recovery?.state === 'failed') {
        throw Object.assign(new Error(recovery.error || '中台批次处理失败'), { serverCode: 'BATCH_FAILED', statusCode: 422 })
      }
    }
    if (!receipt && (this.state.verifyBeforeSend === this.state.runId || this.state.legacyRecovery?.runId === this.state.runId)) {
      await this.keepOnlyMissing(spool)
      this.assertAccount()
    }
    const submitted = spool.batch.messages.length > 0
    const uploadStart = Date.now()
    if (submitted && !receipt) {
      spool.sent = true
      this.atomic(path, spool)
    }
    const result = submitted ? (receipt ?? await this.postBatchUntilReceipt(spool)) :
      {inserted:0, existing:0, failed:0, items:[]}
    if (submitted) {
      // The server returns these rows after committing the messages and receipt together.
      // Require an exact one-to-one receipt before advancing any local checkpoint.
      const expected = new Set(spool.batch.messages.map(m => m.source_key))
      const received = { inserted:0, existing:0, failed:0 }
      const valid = result?.batch_id === spool.batch.batch_id && Array.isArray(result.items) &&
        result.items.length === spool.batch.messages.length && result.items.every((item:any) => {
          if (!item || !expected.delete(item.source_key)) return false
          if (item.outcome === 'failed' && typeof item.error === 'string' && item.error) { received.failed++; return true }
          if (!Number.isSafeInteger(item.message_id) || item.message_id < 1) return false
          if (item.outcome === 'inserted') { received.inserted++; return true }
          if (item.outcome === 'existing') { received.existing++; return true }
          return false
        })
      if (!valid || expected.size || received.inserted !== result.inserted || received.existing !== result.existing ||
          received.failed !== result.failed) throw new Error('中台批次回执不完整，保留断点并在恢复时核对')
    }
    if (submitted) this.batchTarget.acknowledged(spool.batch.messages.length,
      Buffer.byteLength(JSON.stringify(spool.batch)), Date.now()-uploadStart, memoryPressure())
    const attachmentOnly = (spool.confirmedMediaKeys || []).map(source_key=>({source_key,outcome:'existing',media_status:'unknown'}))
    for (const item of [...result.items,...attachmentOnly]) {
      if (progress && item.outcome === 'failed') progress.issue = item.error
      if (item.outcome === 'failed') this.problem(spool.batch.session.wxid, item.source_key, item.error)
      const message = spool.media[item.source_key]
      if (this.state.options.media && message && item.outcome !== 'failed' && item.media_status !== 'uploaded') {
        const key = createHash('sha256').update(spool.batch.session.wxid + '\0' + item.source_key).digest('hex')
        const path = join(this.directory, 'media-queue', key + '.json')
        if (existsSync(this.mediaConfirmationPath(key))) continue
        if (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).runId !== this.state.runId) {
          this.atomic(path, { runId: this.state.runId, session: spool.batch.session.wxid, key: item.source_key, message, status: 'pending' })
        }
      }
    }
    if (!this.state.appliedBatches.includes(creditId)) {
      if (progress) {
        const pass = this.state.pass
        if (pass && pass.run === this.state.runId) {
          const peer = spool.batch.session.wxid
          const prev = pass.positions[peer]
          const time = Math.max(prev?.time || 0, spool.maxTime)
          // Inclusive boundary + source keys: another shard may contain more rows in this second.
          const keys = new Set(prev?.time === time ? prev.keys : [])
          for (const m of spool.batch.messages)
            if (Date.parse(m.occurred_at) === time * 1000) keys.add(m.source_key)
          if (spool.maxTime===time) for (const k of spool.recoveredKeys || []) keys.add(k)
          pass.positions[peer] = {time, keys:[...keys]}
        }
        progress.inserted = (progress.inserted || 0) + result.inserted; progress.existing = (progress.existing || 0) + result.existing
        progress.processed += spool.batch.messages.length + (spool.recoveredCount || 0); progress.failed += result.failed
        progress.total = Math.max(progress.total, progress.processed)
      }
      if (this.state.legacyRecovery) this.state.legacyRecovery.checked += spool.recoveredCount || 0
      this.state.inserted += result.inserted; this.state.existing += result.existing
      this.state.scanned += spool.batch.messages.length
      this.state.appliedBatches = [...this.state.appliedBatches, creditId].slice(-2000)
    }
    this.state.cursors[spool.batch.session.wxid] = Math.max(this.state.cursors[spool.batch.session.wxid] || 0, spool.maxTime)
    this.state.lastSuccess = new Date().toISOString()
    this.save()
    unlinkSync(path)
    void this.drainMedia()
  }

  // Workers stop claiming sessions on failure. Drain in-flight batches before allowing resume.
  private async pool<T>(items: T[], fn: (item: T) => Promise<void>, proceed: () => boolean) {
    return runPool(items,fn,proceed,this.concurrency,(limit,active) => {
      const changed = this.activeSessions !== active || this.lastDisplayedLimit !== limit
      this.activeSessions = active; this.lastDisplayedLimit = limit
      if (changed && this.timer) this.schedulePoolDisplay()
    })

  }

  private lastDisplayedLimit = 16
  private displayTimer?: ReturnType<typeof setTimeout>
  private schedulePoolDisplay() {
    if (this.displayTimer) return
    this.displayTimer = setTimeout(() => {
      this.displayTimer = undefined
      const view = this.status()
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('historySync:status',view)
    }, 250)
  }

  async preview(options: HistoryOptions, onRow?: (row: SessionProgress, total: number) => void) {
    this.init(); this.assertAccount()
    if (this.previewBusy || this.state.active || this.busy || this.mediaBusy) throw new Error('请先暂停同步并等待当前批次结束，再统计范围')
    selectedKinds(options.kinds)
    if (options.end && options.start > options.end) throw new Error('开始时间不能晚于结束时间')
    this.previewBusy = true
    try {
      await this.validateOrdinalRange(options)
      const end = Math.min(options.end || Infinity, Math.floor(Date.now()/1000))
      const rows: SessionProgress[] = (await this.scopeSessions(options)).map(s => ({...s,total:0,processed:0,failed:0,phase:'waiting'}))
      await this.pool(rows, async row => {
        this.assertAccount()
        try { await this.scan(row.id,end,true,row,options,true,false); row.phase = 'done' }
        catch (e) { this.assertAccount(); row.phase = 'failed'; row.issue = e instanceof Error ? e.message : String(e) }
        this.assertAccount(); onRow?.(row,rows.length)
      }, () => true)
      return rows
    }
    finally { this.previewBusy = false; this.finishDetach() }
  }

  private async scan(id: string, end: number, full: boolean, progress?: SessionProgress, options = this.state.options, countOnly = false, live = true) {
    this.assertAccount()
    const signal = this.transferAbort.signal
    const reader = await this.waitForRead(wcdbService.historyReader(this.concurrency.limit), signal)
    this.assertAccount()
    const session = countOnly ? undefined : await this.waitForRead(this.sessionInfo(id, reader), signal)
    this.assertAccount()
    const pos = full && !countOnly && progress ? this.state.pass?.positions[id] : undefined
    const already = new Set(pos?.keys || [])
    const verifiedDays = new Set(full && !countOnly && progress ? this.state.pass?.verifiedDays?.[id] : [])
    const start = full ? Math.max(options.start,pos?.time || 0) : Math.max(options.start, (this.state.cursors[id] || 0) - 600)
    const simple = { text:1, image:3, video:43, emoji:47, voice:34, file:49, other:0 }
    const baseTypes = options.kinds && !options.kinds.includes('other') ? options.kinds.map(k => simple[k]) : undefined
    // For formats determined entirely by the type column, let the DB worker count without sending message bodies.
    if (countOnly && (options.kinds?.includes('file') === options.kinds?.includes('other')) && reader.getSessionMessageTypeStats) {
      const stats = await this.readOn(reader, () => reader.getSessionMessageTypeStats(id, start, end))
      const counts = stats.data?.type_counts
      if (stats.success && counts && typeof counts === 'object' && !Array.isArray(counts) &&
          Object.keys(counts).every(key => /^\d+$/.test(key)) &&
          Object.values(counts).every(n => Number.isSafeInteger(n) && Number(n) >= 0) &&
          Object.values(counts).reduce<number>((n,v) => n + Number(v),0) === stats.data.total_messages) {
        const known: Record<number,string> = {1:'text',3:'image',43:'video',47:'emoji',34:'voice'}
        progress!.total = Object.entries(counts).reduce((n,[t,v]) => !options.kinds || options.kinds.some(k=>k === (known[Number(t)%4294967296] || 'other')) ? n + Number(v) : n,0)
        return
      }
    }
    const pageSize = options.media ? 100 : 300
    const generation = reader.historyReadGeneration?.()
    const open = reader.openMessageCursor(id, pageSize, true, start, end, baseTypes)
    const close = async (cursor: number) => {
      if (reader.historyReadGeneration?.() === generation) await reader.closeMessageCursor(cursor)
    }
    let cursor: Awaited<typeof open>
    try {
      cursor = await this.waitForRead(open, signal)
    } catch (error) {
      if (signal.aborted) {
        void open.then(async value => {
          if (value.cursor) await close(value.cursor)
        }).catch(() => {})
      }
      throw error
    }
    if (!cursor.success || !cursor.cursor) throw Object.assign(new Error(cursor.error || '无法打开本地消息游标，请检查读取组件'), { retryRead: true })
    const fetchPage = () => this.readOn(reader, () => reader.fetchMessageBatch(cursor.cursor!))
    let prefetched: ReturnType<typeof fetchPage> | undefined
    let pending = session ? this.newSpool(session) : undefined
    const submitPending = async () => {
      const filled = pending!
      pending = undefined
      await this.submit(filled, progress)
    }
    try {
      let hasMore = true
      let batchBytes = pending ? Buffer.byteLength(JSON.stringify(pending.batch)) : 0
      let batchStarted = Date.now()
      while (hasMore && (!live || this.state.active)) {
        this.assertAccount()
        const page = prefetched || fetchPage()
        prefetched = undefined
        const result = await page
        if (!result.success) throw Object.assign(new Error(result.error || '读取本地消息失败'), { sessionReadError: true })
        this.assertAccount()
        const rows = result.rows || []
        if (result.hasMore && rows.length && !countOnly && !options.media && memoryPressure()==='low') {
          prefetched = fetchPage()
          void prefetched.catch(()=>{}) // Drain the read before closing its cursor, including on pause.
        }
        let sliceStarted = Date.now()
        for (const row of rows) {
          if (Date.now() - sliceStarted >= 8) {
            await new Promise<void>(resolve => setImmediate(resolve))
            if (live && !this.state.active) break
            this.assertAccount(); sliceStarted = Date.now()
          }
          if (verifiedDays.size && Number.isFinite(Number(row.create_time)) &&
              verifiedDays.has(new Date(Number(row.create_time)*1000).toISOString().slice(0,10))) continue
          const message = chatService.mapRowsToMessagesForApi([row], id, this.state.binding!.account_wxid)[0]
          if (!message || message.createTime < start || message.createTime > end) continue
          if (options.kinds && !options.kinds.includes(historyKind(message))) continue
          if (countOnly) { progress!.total++; continue }
          if (!pending || !session) throw new Error('缺少同步会话')
          let record: WechatHistoryMessageV1
          try { record = toHistoryMessage(message, row, this.state.binding!.account_wxid) }
          catch (error) { if (progress) { progress.processed++; progress.failed++ }; this.problem(id, String(row.local_id || ''), String(error)); continue }
          if (pos && message.createTime === pos.time && already.has(record.source_key)) continue
          const recordBytes = Buffer.byteLength(JSON.stringify(record))
          const nextSize = batchBytes + recordBytes + 1
          if ((nextSize > this.batchTarget.bytes || pending.batch.messages.length >= this.batchTarget.rows) && pending.batch.messages.length) {
            await submitPending(); pending = this.newSpool(session); batchBytes = Buffer.byteLength(JSON.stringify(pending.batch)); batchStarted = Date.now()
          }
          if (recordBytes > 1700000 || batchBytes + recordBytes + 1 > 1900000) { if (progress) { progress.processed++; progress.failed++ }; this.problem(id, record.source_key, '单条消息超过传输限制'); continue }
          batchBytes += recordBytes + 1
          pending.batch.messages.push(record)
          if (record.media_kind && this.state.options.media) pending.media[record.source_key] = message
          pending.maxTime = Math.max(pending.maxTime, message.createTime)
        }
        hasMore = Boolean(result.hasMore && rows.length)
        // Amortize the per-batch request for small pages, but flush within a short read window.
        if ((!hasMore || Date.now()-batchStarted >= 500) && pending?.batch.messages.length) {
          await submitPending()
          pending = this.newSpool(session!)
          batchBytes = Buffer.byteLength(JSON.stringify(pending.batch))
          batchStarted = Date.now()
        }
      }
      // A fully scanned but excluded window must not force a full reread every poll.
      if (!countOnly && !hasMore && this.state.active && this.state.options.kinds?.length && this.state.options.kinds.length < selectedKinds().length) {
        this.state.cursors[id] = Math.max(this.state.cursors[id] || 0, end)
      }
    } finally {
      if (signal.aborted) {
        // Cursor cleanup can queue behind a long native read. Its handle belongs
        // to the old connection and must not delay or close the next account.
        void close(cursor.cursor).catch(() => {})
        if (pending?.batch.messages.length) {
          this.atomic(join(this.directory, 'batch-' + pending.batch.batch_id + '.json'), { ...pending, sent: false })
        }
      } else {
        await prefetched?.catch(() => {})
        const closing = close(cursor.cursor)
        await this.waitForRead(closing, signal)
      }
    }
  }

  private newSpool(session: HistorySession): Spool {
    return { batch: { schema_version: 1, batch_id: randomUUID(), account_wxid: this.state.binding!.account_wxid, session, messages: [] }, media: {}, maxTime: 0 }
  }

  private reportPeers?: { run:string; peers:Set<string> }
  private async restoreReportedProgress(end:number) {
    const recovery=this.state.legacyRecovery, pass=this.state.pass, rows=this.state.sessionProgress
    if (!pass || !rows || !recovery || recovery.runId!==pass.run || pass.serverPlanReady) return
    recovery.checkingReport=true; this.save()
    try {
      const report=await this.request('/runs/'+pass.run+'/report')
      if (report.id!==pass.run || !Array.isArray(report.partitions)) throw new Error('原任务对账报告无效，已保留断点')
      type Part={date:string;source_records:number;matched:number;unresolved:number;source_digest:string;media:Record<string,number>}
      const byPeer=new Map<string,Map<string,Part>>()
      let confirmed=0,unresolved=0
      for(const part of report.partitions) {
        let days=byPeer.get(part.session_wxid)
        if(!days){days=new Map();byPeer.set(part.session_wxid,days)}
        days.set(part.date,part); confirmed+=part.matched; unresolved+=part.unresolved
      }
      this.reportPeers={run:pass.run,peers:new Set(byPeer.keys())}
      recovery.reportConfirmed=confirmed; recovery.reportPending=unresolved; recovery.reportPeers=byPeer.size
      const finished=new Set(pass.finished)
      const candidates=rows.filter(r=>byPeer.has(r.id) && !finished.has(r.id) && !(pass.verifiedDays?.[r.id]?.length))
      recovery.planned=candidates.length; recovery.examined=0
      let lastSave=0
      let nextCandidate=0, stopProofs=false
      const proveNext = async () => {
        while(!stopProofs && nextCandidate<candidates.length && this.state.active) {
          const r=candidates[nextCandidate++]
          try {
            if (!this.state.active) return
            this.assertAccount()
            const remote=byPeer.get(r.id)!
            const proofReader=await this.waitForRead(wcdbService.historyReader(this.concurrency.limit))
            this.assertAccount()
            const proof=await this.readOn(proofReader, () => proofReader.historyDayProof(r.id,this.state.options.start,end,selectedKinds(this.state.options.kinds)))
            this.assertAccount()
            if (proof.success && proof.days?.length) {
              const proven=proof.days.filter(d=>{
                const p=remote.get(d.date)
                return p && !p.unresolved && p.matched===d.count && p.source_digest===d.digest &&
                  (!this.state.options.media || Object.keys(p.media).every(k=>k==='uploaded'||k==='none'))
              })
              const n=proven.reduce((sum,d)=>sum+d.count,0)
              const complete=proven.length===proof.days.length && [...remote.values()].every(p=>!p.unresolved)
              if (complete) {
                r.phase='done';r.total=n;r.processed=n;r.failed=0;r.issue=undefined
                pass.finished.push(r.id);this.state.completedSessions=pass.finished.length
                recovery.restoredPeers=(recovery.restoredPeers||0)+1
                recovery.restoredMessages=(recovery.restoredMessages||0)+n
              } else if (proven.length && !pass.positions[r.id] && !r.processed) {
                (pass.verifiedDays??={})[r.id]=proven.map(d=>d.date)
                r.processed=n;r.phase='waiting'
                recovery.restoredMessages=(recovery.restoredMessages||0)+n
              }
            }
            recovery.examined = (recovery.examined || 0) + 1
            if(Date.now()-lastSave>1000){this.save();lastSave=Date.now()}
          } catch (error) { stopProofs=true; throw error }
        }
      }
      const results=await Promise.allSettled(Array.from({length:Math.min(this.concurrency.limit,candidates.length)},proveNext))
      for (const result of results) if (result.status==='rejected') throw result.reason
      if(this.state.active) pass.serverPlanReady=true
    } finally {recovery.checkingReport=false;this.save()}
  }

  private async tick() {
    if (!this.state?.active || this.busy || Date.now() < this.retryAt) return
    this.busy = true
    try {
      this.assertAccount()
      if(this.state.pendingFinish && this.state.repairDue && Date.now()<this.state.repairDue) return
      this.state.status = 'running'
      const deferred = new Map<string, Error>()
      for (const file of this.pendingFiles()) {
        if (!this.state.active) break
        this.state.verifyBeforeSend = this.state.runId
        const spool: Spool = JSON.parse(readFileSync(file, 'utf8'))
        const progress = this.state.pass?.run === this.state.runId && this.state.pass
          ? this.state.sessionProgress?.find(r => r.id === spool.batch.session.wxid) : undefined
        if (deferred.has(spool.batch.session.wxid)) continue
        try { await this.uploadSpool(spool,file,progress) }
        catch(e) {
          if (!this.state.active) throw e
          deferred.set(spool.batch.session.wxid,e instanceof Error ? e : new Error(String(e)))
          if (progress) { progress.phase='failed';progress.issue=String(e) }
        }
      }
      if (this.state.repairDue && Date.now()>=this.state.repairDue) {
        const peers=Object.keys(this.state.repairPeers || {})
        this.state.verifyBeforeSend=this.state.runId
        await this.pool(peers,async peer=>{
          if (deferred.has(peer)) return
          delete this.state.repairPeers![peer]
          try { await this.scan(peer,Math.min(this.state.options.end || Infinity,this.state.scanEnd),true) }
          catch(e){ this.state.repairPeers![peer]=true;throw e }
          if (!this.state.active) this.state.repairPeers![peer]=true
        },()=>this.state.active)
        if (!this.state.active) return
        for (const name of readdirSync(join(this.directory,'media-queue'))) {
          if (!name.endsWith('.json')) continue
          const path=join(this.directory,'media-queue',name), job:MediaJob=JSON.parse(readFileSync(path,'utf8'))
          if (job.runId===this.state.runId && job.status==='failed') {job.status='pending';delete job.error;this.atomic(path,job)}
        }
        this.state.repairDue=0
        if (this.state.options.continuous && Object.keys(this.state.repairPeers || {}).length) {
          this.state.repairAttempt=(this.state.repairAttempt || 0)+1
          this.state.repairDue=Date.now()+Math.min(900000,30000*2**Math.min(5,this.state.repairAttempt))
        }
        this.save()
      }
      if (!this.state.pendingFinish) {
        const full = !!this.state.pass || !this.state.dailyChecked || !this.state.sessionProgress || Date.now() - this.state.dailyChecked >= 86400000
        const resume = full && !!this.state.sessionProgress && (this.state.pass?.run === this.state.runId ||
          (!this.state.dailyChecked && (this.state.progressPhase === 'counting' ||
            (this.state.legacyRecovery?.runId === this.state.runId && this.state.progressPhase === 'processing'))))
        const end = this.state.pass?.end ?? Math.min(this.state.options.end || Infinity, this.state.dailyChecked ? Math.floor(Date.now() / 1000) : this.state.scanEnd)
        const selected = resume ? this.state.sessionProgress! : await this.scopeSessions(this.state.options)
        if (!this.state.active) return
        this.state.totalSessions = selected.length; this.state.completedSessions = 0
        if (full) {
          if (!resume) this.state.sessionProgress = selected.map(s => ({ ...s, total:0, processed:0, failed:0, phase:'waiting' }))
          if (!this.state.pass) {
            this.state.pass = {run:this.state.runId!,end,finished:[],positions:{}}
            // Older clients have no confirmed same-second keys. Recheck unfinished sessions only.
            if (resume) for (const r of selected as SessionProgress[]) {
              if (r.phase === 'done' || r.phase === 'skipped') this.state.pass.finished.push(r.id)
              else {
                Object.assign(r,{phase:'waiting',total:0,processed:0,failed:0,inserted:0,existing:0,issue:undefined})
              }
            }
          }
          this.state.completedSessions = this.state.pass.finished.length
          this.state.progressPhase = 'counting'; this.save()
        }
        if (full && this.state.legacyRecovery && this.state.active) {
          await this.restoreReportedProgress(end)
          if (!this.state.active) return
        }
        const tasks = new Map(this.state.sessionProgress?.map(p => [p.id,p]))
        const finished = new Set(this.state.pass?.finished)
        const remaining = selected.filter(s=>!finished.has(s.id) && !deferred.has(s.id))
        const ranking = this.reportPeers
        if (full && ranking?.run===this.state.runId && ranking) remaining.sort((a,b)=>
          Number(ranking.peers.has(a.id))-Number(ranking.peers.has(b.id)))
        await this.pool(remaining, async session => {
          const row = tasks.get(session.id)
          const progress = full ? row : undefined
          if (progress && finished.has(session.id)) return
          try {
            if (row) { row.phase = 'syncing'; row.issue = undefined; row.singlePass = !!full }
            this.state.currentSession = session.name; this.save()
            await this.scan(session.id, end, full, progress)
            if (this.state.active) {
              if (progress) { this.state.pass!.finished.push(session.id); progress.singlePass = false; progress.total=Math.max(progress.total,progress.processed) }
              if (row) row.phase = row.failed ? 'failed' : !row.total && full ? 'skipped' : 'done'
              this.state.completedSessions++; this.save()
            }
          } catch (e) {
            if (row) { row.phase = 'failed'; row.issue = e instanceof Error ? e.message : String(e); this.save() }
            if (!this.state.active) throw e
            deferred.set(session.id,e instanceof Error ? e : new Error(String(e)))
          }
        }, () => this.state.active && deferred.size<16)
        if (deferred.size) throw deferred.values().next().value
        if (this.state.active && full) {
          this.state.pass = undefined
          this.state.progressPhase = 'done'
          for (const row of this.state.sessionProgress || []) if (row.phase === 'skipped') this.state.cursors[row.id] = end
        }
        if (this.state.active && full) this.state.dailyChecked = Date.now()
        if (this.state.active && !this.state.options.continuous) this.state.pendingFinish = true
      }
      if (deferred.size) throw deferred.values().next().value
      this.failures = 0; this.state.error = undefined
      void this.drainMedia()
      await this.maybeFinish()
      this.save()
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error)
      if (!this.state.active || (error as { pauseSync?: boolean }).pauseSync) {
        this.state.active = false
        this.state.status = 'paused'
      } else if (this.state.active) this.state.status = 'offline'
      this.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(++this.failures, 6))
      this.save()
    } finally { this.busy = false; this.finishDetach() }
  }

  private async maybeFinish() {
    if (!this.state.pendingFinish || this.mediaBusy || !this.state.active) return
    const jobs = readdirSync(join(this.directory, 'media-queue')).filter(f => f.endsWith('.json') && JSON.parse(readFileSync(join(this.directory, 'media-queue', f), 'utf8')).runId === this.state.runId)
    const pending = this.state.options.media ? jobs.filter(f => JSON.parse(readFileSync(join(this.directory, 'media-queue', f), 'utf8')).status === 'pending') : []
    this.state.mediaPending = jobs.length
    if (pending.length) return
    // Old servers also expose a per-source completion report. Never close a run while any
    // accepted source is unresolved, even if its last error was recorded by an older client.
    const report=await this.request(`/runs/${this.state.runId}/report`)
    if (report.id!==this.state.runId || !Array.isArray(report.partitions)) throw new Error('对账报告暂不可用，将自动重试')
    const peers=this.state.repairPeers ??= {}
    for (const part of report.partitions) if (part.unresolved>0 ||
      (this.state.options.media && (part.media?.pending || part.media?.missing || part.media?.failed))) peers[part.session_wxid]=true
    if (Object.keys(peers).length || jobs.length) {
      this.state.repairAttempt=(this.state.repairAttempt || 0)+1
      this.state.repairDue=Date.now()+Math.min(900000,30000*2**Math.min(5,this.state.repairAttempt-1))
      this.state.error='仍有未确认消息或附件，将按缺口会话自动复查；归档冲突需在中台选择目标后才能完成。'
      this.state.status='offline'
      return
    }
    if (!this.state.active) return
    const run = await this.request(`/runs/${this.state.runId}`, 'PATCH', { action: 'finish' })
    this.state.status = run.status === 'partial' ? 'partial' : 'completed'
    this.state.finishedAt=Date.now();this.state.active = false; this.state.pendingFinish = false
  }

  private mediaConfirmationPath(key: string) {
    const dir = join(this.directory,'media-confirmed',createHash('sha256').update(this.state.datasetId).digest('hex'))
    mkdirSync(dir,{recursive:true})
    return join(dir,key+'.ok')
  }

  private async drainMedia() {
    if (this.mediaBusy || !this.state.active || !this.state.options.media || Date.now() < this.retryAt) return
    this.mediaBusy = true
    try {
      const directory = join(this.directory, 'media-queue')
      const files = readdirSync(directory).filter(f => f.endsWith('.json') && JSON.parse(readFileSync(join(directory, f), 'utf8')).runId === this.state.runId)
      this.state.mediaPending = files.length
      for (const file of files) {
        if (!this.state.active) break
        const path = join(directory, file)
        const job: MediaJob = JSON.parse(readFileSync(path, 'utf8'))
        if (job.status === 'failed') continue
        try {
          this.assertAccount()
          const mediaRoot = join(this.directory, 'media-cache')
          mkdirSync(mediaRoot, { recursive: true })
          const media = await this.mediaContext.exportMediaForMessage(job.message, job.session, mediaRoot, '', {
            exportImages: true, exportVoices: true, exportVideos: true, exportFiles: true, exportEmojis: true, maxFileSizeMb: 100,
          })
          this.assertAccount()
          if (!media) throw new Error('本地附件缺失、不可解密或超过大小限制')
          const localPath = resolve(mediaRoot, media.relativePath)
          if (!localPath.startsWith(resolve(mediaRoot) + sep)) throw new Error('附件路径超出同步缓存')
          const data = await disk.readFile(localPath)
          const sha = createHash('sha256').update(data).digest('hex')
          const suffix = localPath.split('.').pop()?.toLowerCase() || ''
          const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', wav: 'audio/wav', mp3: 'audio/mpeg', mp4: 'video/mp4' } as Record<string, string>)[suffix] || 'application/octet-stream'
          const params = new URLSearchParams({ session_wxid: job.session, source_key: job.key, filename: basename(localPath), sha256: sha })
          await this.request(`/runs/${this.state.runId}/media?${params}`, 'POST', data, { 'Content-Type': mime })
          const key = createHash('sha256').update(job.session+'\0'+job.key).digest('hex')
          writeFileSync(this.mediaConfirmationPath(key),'','utf8')
          unlinkSync(path); this.state.mediaUploaded++; this.state.mediaPending--
        } catch (error) {
          if (!this.state.active) throw error
          const status = (error as { statusCode?: number }).statusCode
          if (status === 429 || (status && status >= 500) || (error instanceof Error && ['TypeError', 'TimeoutError', 'AbortError'].includes(error.name))) {
            this.retryAt = Date.now() + 30_000
            this.state.error = '附件网络传输暂不可用，将自动重试'
            break
          }
          job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error)
          this.atomic(path, job)
          this.problem(job.session, job.key, job.error)
          await this.request(`/runs/${this.state.runId}/media`, 'PATCH', {
            session_wxid: job.session, source_key: job.key, status: 'missing', error: job.error,
          }).catch(() => undefined)
        }
        this.save()
      }
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error)
      this.save()
    } finally {
      this.mediaBusy = false
      // The coordinator performs the final report check once all attachment writes settle.
      this.save()
      this.finishDetach()
    }
  }
}

export const historySyncService = new HistorySyncService()
