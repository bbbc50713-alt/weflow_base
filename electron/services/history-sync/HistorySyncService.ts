import { AdaptiveLimit, memoryPressure, runPool } from './adaptivePool'
import { promises as disk } from 'fs'
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
  maxTime: number
}
interface MediaJob { runId: string; session: string; key: string; message: Message; status: 'pending' | 'failed'; error?: string }

export class HistorySyncService {
  private directory = ''
  private loadError?: string
  private state!: State
  private config = ConfigService.getInstance()
  private concurrency = new AdaptiveLimit()
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
  private async readOn<T>(reader: typeof wcdbService, read: () => Promise<T>): Promise<T> {
    const started=Date.now(), rid=this.state.runId
    this.reading.set(reader, (this.reading.get(reader) || 0) + 1)
    this.schedulePoolDisplay()
    try {
      return await read()
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
    this.directory = join(app.getPath('userData'), 'history-sync')
    mkdirSync(join(this.directory, 'media-queue'), { recursive: true })
    this.state = {
      stateFormat: 2, origin: 'https://zt.hmed1991.com', accountWxid: '', status: 'unbound',
      options: { sessions: [], start: 0, end: 0, media: true, continuous: true },
      completedSessions: 0, totalSessions: 0, scanned: 0, inserted: 0, existing: 0, failed: 0,
      mediaPending: 0, mediaUploaded: 0, problems: [], connectorId: randomUUID(), datasetId: randomUUID(),
      cursors: {}, scanEnd: 0, dailyChecked: 0, active: false, appliedBatches: [],
    }
    const path = join(this.directory, 'state.json')
    if (existsSync(path)) {
      try {
        const saved = JSON.parse(readFileSync(path,'utf8'))
        this.state = { ...this.state, ...saved }
        if (saved.runId && saved.binding && ['paused','running','offline'].includes(saved.status)) this.state.verifyBeforeSend=saved.runId
        if (!saved.stateFormat && saved.runId && saved.binding && !['completed','partial','cancelled'].includes(saved.status)) {
          if (!saved.connectorId || !saved.datasetId || !saved.encryptedToken) throw new Error('旧任务缺少恢复身份')
          // Never replace the pre-upgrade state. This copy contains the original protected credential.
          const backup = join(this.directory,'state.pre-5.0.5.json')
          if (!existsSync(backup)) writeFileSync(backup,JSON.stringify(saved),{flag:'wx',mode:0o600})
          this.state.legacyRecovery = {runId:saved.runId, checked:0, previousScanned:saved.scanned || 0}
          this.state.active = false; this.state.status = 'paused'
          this.atomic(path,this.state)
        }
      }
      catch {
        this.loadError = '同步状态文件损坏，请保留文件并修复后继续'
        throw new Error(this.loadError)
      }
    }
  }

  startScheduler() {
    this.init()
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, 30_000)
    this.timer.unref()
    void this.tick()
  }

  private atomic(path: string, value: unknown) {
    writeFileSync(path + '.tmp', JSON.stringify(value), 'utf8')
    renameSync(path + '.tmp', path)
  }

  private save() {
    this.atomic(join(this.directory, 'state.json'), this.state)
    const status = this.status()
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('historySync:status', status)
  }

  status(): HistoryStatus {
    this.init()
    const { connectorId, datasetId, encryptedToken, cursors, scanEnd, dailyChecked, active, pendingFinish, appliedBatches, pass, ...view } = this.state
    return { ...view, readerCount:wcdbService.historyReaderCount(), activeReaders:this.reading.size, activeChecks:this.checkInFlight, activeUploads:this.uploadInFlight, concurrencyLimit: this.concurrency.limit, activeSessions:this.activeSessions, initialScanComplete: Boolean(this.state.runId && dailyChecked), typeFilterVersion: 1, accountWxid: this.config.getMyWxidCleaned() }
  }

  private assertAccount() {
    if (!this.state.binding || this.config.getMyWxidCleaned() !== this.state.binding.account_wxid) {
      this.state.active = false
      this.state.status = 'paused'
      throw new Error('当前本地微信与已绑定微信不同，任务已暂停')
    }
  }

  private token() {
    if (!this.state.encryptedToken || !safeStorage.isEncryptionAvailable()) throw new Error('同步凭据不可用，请重新绑定')
    return safeStorage.decryptString(Buffer.from(this.state.encryptedToken, 'base64'))
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

  private noMetricsOrigin?: string
  private remoteCounts?: {id:string;at:number;counts:{inserted?:number;existing?:number;failed?:number}|null}

  async metrics(): Promise<import('../../../shared/wechatHistory').TransferMetrics> {
    this.init(); this.assertAccount()
    const runId = this.state.runId
    if (!runId) throw new Error('尚无任务')
    const files = await disk.readdir(this.directory)
    // Production 5.0.1 API already exposes the authoritative task totals.
    // Cache the read-only snapshot instead of aggregating the run on every UI refresh.
    const now = Date.now()
    if (this.remoteCounts?.id !== runId || now-this.remoteCounts.at > 60000) {
      const snapshot = await this.request('/runs/'+runId,'GET',undefined,{},false,true).catch(()=>null)
      this.remoteCounts = {id:runId,at:now,counts:snapshot?.id===runId ? snapshot.counts : null}
    }
    let server = null
    if (this.noMetricsOrigin !== this.state.origin) {
      try { server = await this.request('/runs/'+runId+'/metrics') }
      catch(e) { if ((e as {statusCode?:number}).statusCode===404) this.noMetricsOrigin=this.state.origin }
    }
    const counts = this.remoteCounts.counts
    this.assertAccount()
    if (runId !== this.state.runId) throw new Error('任务已变更')
    return {runId, clientPending: files.filter(f=>/^(?:batch|batch-[0-9a-f-]{36})\.json$/.test(f)).length,
      readMs:this.medianDuration('read',runId),batchMs:this.medianDuration('batch',runId),checkMs:this.medianDuration('check',runId), counts, clientAcknowledged: this.state.scanned, bytesPerSecond:this.uploadRate(runId), checkBytesPerSecond:this.uploadRate(runId,0,true), checkRequests:this.recentUpload.filter(s=>s.check).length,server}
  }

  private async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, anonymous = false, observation = false): Promise<any> {
    if (!anonymous) this.assertAccount()
    const serialized = body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body)
    const isMetrics = observation || path.endsWith('/metrics')
    const runId = this.state.runId
    const stage = method === 'POST' && path.endsWith('/reconcile') ? 'checkInFlight' :
      method === 'POST' && (path.endsWith('/batches') || path.includes('/media?')) ? 'uploadInFlight' : undefined
    if (stage) { this[stage]++; this.schedulePoolDisplay() }
    try {
      const requestStarted=Date.now()
    const response = await fetch(this.state.origin + '/api/v1/wechat-history' + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(path.endsWith('/report') ? 180000 : isMetrics ? 7000 : body instanceof Buffer ? 120_000 : 30_000),
        headers: { ...(anonymous ? {} : { Authorization: `Bearer ${this.token()}` }), 'Content-Type': 'application/json', ...headers },
        body: serialized,
      })
      const result: any = await response.json().catch(() => ({}))
    if(response.ok && (path.endsWith('/reconcile') || path.endsWith('/batches'))) this.noteDuration(path.endsWith('/batches')?'batch':'check',requestStarted,runId)
      if (!response.ok) {
        if (!isMetrics && [401, 403].includes(response.status)) { this.state.active = false; this.state.status = 'paused' }
        const error = new Error(result.detail?.message || (typeof result.detail === 'string' ? result.detail : '') || `中台请求失败 (${response.status})`)
        Object.assign(error, { statusCode: response.status })
        throw error
      }
      if (runId && runId === this.state.runId && method==='POST' && serialized &&
          (path.endsWith('/batches') || path.includes('/media?') || path.endsWith('/reconcile'))) {
        this.uploadRate(runId,typeof serialized==='string' ? Buffer.byteLength(serialized) : serialized.byteLength, path.endsWith('/reconcile'))
      }
      return result.data
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
    const owner = this.config.getMyWxidCleaned()
    const result = await chatService.getSessions()
    if (!result.success) throw Object.assign(new Error(/timed out/i.test(result.error || '') ? '本地会话读取超时，请暂停其他读取任务后重试。' : `本地读取组件未就绪，请检查 WeFlow 数据库配置。${result.error || ''}`), { pauseSync: true })
    const list = (result.sessions || []).filter(s => !s.username.startsWith('gh_') && !s.username.endsWith('@app') &&
      !['weixin', 'filehelper', 'fmessage', 'qmessage', 'newsapp', 'mphelper', 'medianote'].includes(s.username))
      .map(s => ({ id: s.username, name: s.displayName || s.username, group: s.username.endsWith('@chatroom') }))
    if (!owner || this.config.getMyWxidCleaned() !== owner) throw new Error('本地账号发生变化，请重新读取会话')
    this.init()
    const registry = join(this.directory, 'order-' + createHash('sha256').update(owner).digest('hex') + '.json')
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
    if (this.busy || this.state.binding) throw new Error('请先解除现有绑定后再绑定其他中台')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法安全保存同步凭据')
    const owner = this.config.getMyWxidCleaned()
    if (!owner) throw new Error('请先连接本地微信数据库')
    this.state.origin = normalizeOrigin(origin)
    const result: HistoryBinding & { token: string } = await this.request('/bindings', 'POST', {
      code: code.trim(), account_wxid: owner, connector_id: this.state.connectorId,
    }, {}, true)
    const { token, ...binding } = result
    this.state.binding = binding
    this.state.accountWxid = owner
    this.state.encryptedToken = safeStorage.encryptString(token).toString('base64')
    this.state.status = 'idle'
    this.save()
    return this.status()
  }

  async unbind() {
    this.init()
    if (this.previewBusy) throw new Error('范围统计尚未结束')
    this.state.active = false
    if (this.busy || this.mediaBusy) { this.state.status = 'paused'; this.save(); throw new Error('当前批次正在结束，请稍后解除绑定') }
    if (this.state.binding) {
      try { await this.request('/bindings/current', 'DELETE') }
      catch (error) { if (![401, 403, 404].includes((error as { statusCode?: number }).statusCode || 0)) throw error }
    }
    this.state.binding = undefined; this.state.encryptedToken = undefined; this.state.runId = undefined
    this.state.status = 'unbound'; this.state.cursors = {}; this.state.datasetId = randomUUID()
    this.state.scanEnd = 0; this.state.pendingFinish = false
    // Only this connector's spool files; artifacts remain available for diagnosis.
    for (const file of this.pendingFiles()) unlinkSync(file)
    for (const file of readdirSync(join(this.directory, 'media-queue'))) if (/^[a-f0-9]{64}\.json$/.test(file)) unlinkSync(join(this.directory, 'media-queue', file))
    this.save(); return this.status()
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
    this.init(); this.assertAccount()
    if (this.previewBusy) throw new Error('范围统计尚未结束')
    if (this.busy || this.mediaBusy) throw new Error('当前批次正在结束，请稍后再开始')
    if (this.state.status === 'running') return this.status()
    await this.validateOrdinalRange(options)
    const kinds = selectedKinds(options.kinds)
    if (options.end && options.start > options.end) throw new Error('开始时间不能晚于结束时间')
    if (this.state.runId && ['paused', 'offline'].includes(this.state.status)) {
      const prev = this.state.options
      if (prev.start === options.start && prev.end === options.end && prev.media === options.media && prev.continuous === options.continuous &&
          JSON.stringify(prev.sessions) === JSON.stringify(options.sessions) && selectedKinds(prev.kinds).join() === kinds.join()) return this.resume()
      if (this.pendingFiles().length) throw new Error('有未确认的批次，请先按原范围继续，收到中台确认后再更改类型')
      await this.request('/runs/' + this.state.runId, 'PATCH', { action: 'cancel' })
      this.state.runId = undefined; this.state.status = 'idle'; this.state.active = false; this.save()
    }
    this.state.verifyBeforeSend = undefined
    this.state.legacyRecovery = undefined
    this.concurrency = new AdaptiveLimit()
    this.state.pass = undefined; this.state.sessionProgress = undefined; this.state.progressPhase = undefined
    this.state.mediaPending = this.state.mediaUploaded = 0
    this.state.options = { ...options, kinds, sessions: [...new Set(options.sessions)].filter(Boolean) }
    this.state.cursors = {}; this.state.dailyChecked = 0; this.state.scanEnd = Math.floor(Date.now() / 1000)
    this.state.pendingFinish = false; this.state.completedSessions = 0; this.state.totalSessions = 0; this.state.currentSession = undefined
    this.state.scanned = this.state.inserted = this.state.existing = this.state.failed = 0
    this.state.problems = []; this.state.error = undefined
    const check = await this.request('/bindings/current')
    this.state.problems = check.conflicts.map((x: any) => ({ session_wxid: x.session_wxid, error: '中台存在重复会话，请查重后重试' }))
    const run = await this.request('/runs', 'POST', { dataset_id: this.state.datasetId, options: this.state.options })
    this.retryAt = 0; this.failures = 0
    this.state.runId = run.id; this.state.active = true; this.state.status = 'running'; this.save()
    void this.tick(); return this.status()
  }

  async pause() {
    this.init(); this.state.active = false; this.state.status = 'paused'; this.save()
    // A locally acknowledged in-flight batch is persisted before the next start.
    if (!this.busy && !this.mediaBusy && this.state.runId) await this.request(`/runs/${this.state.runId}`, 'PATCH', { action: 'pause' })
    return this.status()
  }

  async resume(): Promise<HistoryStatus> {
    this.init(); this.assertAccount()
    if (this.previewBusy || this.busy || this.mediaBusy) throw new Error('当前批次或范围统计尚未结束，请稍后继续')
    if (!this.state.runId) return this.start(this.state.options)
    const resumed = await this.request(`/runs/${this.state.runId}`, 'PATCH', { action: 'resume' })
    if (resumed.status !== 'running') throw new Error('中台原任务当前无法继续：'+resumed.status)
    this.state.verifyBeforeSend = this.state.runId
    this.state.active = true; this.state.status = 'running'; this.state.error = undefined; this.retryAt = 0; this.save()
    void this.tick(); return this.status()
  }

  async retry() {
    this.init()
    if (this.previewBusy || this.busy || this.mediaBusy) throw new Error('请先暂停并等待当前批次结束')
    if (this.pendingFiles().length) throw new Error('请先按原范围继续并确认待传批次，再重试')
    if (this.state.runId) await this.request(`/runs/${this.state.runId}`, 'PATCH', { action: 'cancel' })
    this.state.runId = undefined; this.state.status = 'idle'
    for (const file of readdirSync(join(this.directory, 'media-queue'))) {
      if (!file.endsWith('.json')) continue
      const path = join(this.directory, 'media-queue', file)
      const job: MediaJob = JSON.parse(readFileSync(path, 'utf8')); job.status = 'pending'; this.atomic(path, job)
    }
    // Restart from source; the server ledger makes this safe and retries only unresolved items.
    return this.start(this.state.options)
  }

  async review() {
    this.init(); this.assertAccount()
    if (!this.state.runId) throw new Error('尚无同步任务')
    const report = await this.request(`/runs/${this.state.runId}/report`)
    return { id: report.id, partitions: report.partitions }
  }

  async rescan() {
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
    const report = await this.request(`/runs/${this.state.runId}/report`)
    const selection = await dialog.showSaveDialog({ title: '保存同步对账报告', defaultPath: `wechat-history-${this.state.runId}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (selection.canceled || !selection.filePath) return {}
    writeFileSync(selection.filePath, JSON.stringify({ ...report, local_problems: this.state.problems }, null, 2), 'utf8')
    return { path: selection.filePath }
  }

  private problem(session: string, key: string, error: string) {
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

  private async uploadSpool(spool: Spool, path: string, progress?: SessionProgress) {
    this.assertAccount()
    const creditId = spool.originalBatchId || spool.batch.batch_id
    if (this.state.appliedBatches.includes(creditId)) { unlinkSync(path); return }
    if (this.state.verifyBeforeSend === this.state.runId || this.state.legacyRecovery?.runId === this.state.runId) {
      await this.keepOnlyMissing(spool)
      this.assertAccount()
    }
    const submitted = spool.batch.messages.length > 0
    const result = submitted ? await this.request(`/runs/${this.state.runId}/batches`, 'POST', spool.batch) :
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
    finally { this.previewBusy = false }
  }

  private async scan(id: string, end: number, full: boolean, progress?: SessionProgress, options = this.state.options, countOnly = false, live = true) {
    this.assertAccount()
    const reader = await wcdbService.historyReader()
    this.assertAccount()
    const session = countOnly ? undefined : await this.sessionInfo(id, reader)
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
    const cursor = await reader.openMessageCursor(id, pageSize, true, start, end, baseTypes)
    if (!cursor.success || !cursor.cursor) throw Object.assign(new Error(cursor.error || '无法打开本地消息游标，请检查读取组件'), { pauseSync: true })
    const fetchPage = () => this.readOn(reader, () => reader.fetchMessageBatch(cursor.cursor!))
    let prefetched: ReturnType<typeof fetchPage> | undefined
    try {
      let hasMore = true
      let pending = session ? this.newSpool(session) : undefined
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
          if ((nextSize > 1900000 || pending.batch.messages.length >= 500) && pending.batch.messages.length) {
            await this.submit(pending, progress); pending = this.newSpool(session); batchBytes = Buffer.byteLength(JSON.stringify(pending.batch)); batchStarted = Date.now()
          }
          if (recordBytes > 1700000) { if (progress) { progress.processed++; progress.failed++ }; this.problem(id, record.source_key, '单条消息超过传输限制'); continue }
          batchBytes += recordBytes + 1
          pending.batch.messages.push(record)
          if (record.media_kind && this.state.options.media) pending.media[record.source_key] = message
          pending.maxTime = Math.max(pending.maxTime, message.createTime)
        }
        hasMore = Boolean(result.hasMore && rows.length)
        // Amortize the per-batch request for small pages, but flush within a short read window.
        if ((!hasMore || Date.now()-batchStarted >= 500) && pending?.batch.messages.length) {
          await this.submit(pending, progress)
          pending = this.newSpool(session!)
          batchBytes = Buffer.byteLength(JSON.stringify(pending.batch))
          batchStarted = Date.now()
        }
      }
      // A fully scanned but excluded window must not force a full reread every poll.
      if (!countOnly && !hasMore && this.state.active && this.state.options.kinds?.length && this.state.options.kinds.length < selectedKinds().length) {
        this.state.cursors[id] = Math.max(this.state.cursors[id] || 0, end)
      }
    } finally { await prefetched?.catch(()=>{}); await reader.closeMessageCursor(cursor.cursor) }
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
            const proofReader=await wcdbService.historyReader()
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
            recovery.examined++
            if(Date.now()-lastSave>1000){this.save();lastSave=Date.now()}
          } catch (error) { stopProofs=true; throw error }
        }
      }
      const results=await Promise.allSettled(Array.from({length:Math.min(16,candidates.length)},proveNext))
      for (const result of results) if (result.status==='rejected') throw result.reason
      if(this.state.active) pass.serverPlanReady=true
    } finally {recovery.checkingReport=false;this.save()}
  }

  private async tick() {
    if (!this.state?.active || this.busy || Date.now() < this.retryAt) return
    this.busy = true
    try {
      this.assertAccount(); this.state.status = 'running'
      for (const file of this.pendingFiles()) {
        if (!this.state.active) break
        this.state.verifyBeforeSend = this.state.runId
        const spool: Spool = JSON.parse(readFileSync(file, 'utf8'))
        const progress = this.state.pass?.run === this.state.runId && this.state.pass
          ? this.state.sessionProgress?.find(r => r.id === spool.batch.session.wxid) : undefined
        await this.uploadSpool(spool, file, progress)
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
        const remaining = selected.filter(s=>!finished.has(s.id))
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
            if ((e as {sessionReadError?: boolean})?.sessionReadError && row && full) {
              this.problem(session.id, '', row.issue || '读取失败'); this.state.pass!.finished.push(session.id); this.state.completedSessions++; this.save(); return
            }
            throw e
          }
        }, () => this.state.active)
        if (this.state.active && full) {
          this.state.pass = undefined
          this.state.progressPhase = 'done'
          for (const row of this.state.sessionProgress || []) if (row.phase === 'skipped') this.state.cursors[row.id] = end
        }
        if (this.state.active && full) this.state.dailyChecked = Date.now()
        if (this.state.active && !this.state.options.continuous) this.state.pendingFinish = true
      }
      this.failures = 0; this.state.error = undefined
      void this.drainMedia()
      await this.maybeFinish()
      this.save()
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error)
      if ((error as { pauseSync?: boolean }).pauseSync) {
        this.state.active = false
        this.state.status = 'paused'
      } else if (this.state.active) this.state.status = 'offline'
      this.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(++this.failures, 6))
      this.save()
    } finally { this.busy = false }
  }

  private async maybeFinish() {
    if (!this.state.pendingFinish || this.mediaBusy || !this.state.active) return
    const jobs = readdirSync(join(this.directory, 'media-queue')).filter(f => f.endsWith('.json') && JSON.parse(readFileSync(join(this.directory, 'media-queue', f), 'utf8')).runId === this.state.runId)
    const pending = this.state.options.media ? jobs.filter(f => JSON.parse(readFileSync(join(this.directory, 'media-queue', f), 'utf8')).status === 'pending') : []
    this.state.mediaPending = jobs.length
    if (pending.length) return
    const run = await this.request(`/runs/${this.state.runId}`, 'PATCH', { action: 'finish' })
    this.state.status = run.status === 'partial' || this.state.problems.length ? 'partial' : 'completed'
    this.state.active = false; this.state.pendingFinish = false
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
      await this.maybeFinish().catch(error => { this.state.error = String(error) })
      this.save()
    }
  }
}

export const historySyncService = new HistorySyncService()
