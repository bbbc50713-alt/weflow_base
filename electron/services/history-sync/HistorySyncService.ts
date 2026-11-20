import { AdaptiveLimit, runPool } from './adaptivePool'
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
  connectorId: string
  datasetId: string
  encryptedToken?: string
  cursors: Record<string, number>
  scanEnd: number
  dailyChecked: number
  active: boolean
  pendingFinish?: boolean
  appliedBatches: string[]
  pass?: { run: string; end: number; finished: string[]; positions: Record<string,{time:number; keys:string[]}> }
}
interface Spool {
  batch: { schema_version: 1; batch_id: string; account_wxid: string; session: HistorySession; messages: WechatHistoryMessageV1[] }
  media: Record<string, Message>
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
      origin: 'https://zt.hmed1991.com', accountWxid: '', status: 'unbound',
      options: { sessions: [], start: 0, end: 0, media: true, continuous: true },
      completedSessions: 0, totalSessions: 0, scanned: 0, inserted: 0, existing: 0, failed: 0,
      mediaPending: 0, mediaUploaded: 0, problems: [], connectorId: randomUUID(), datasetId: randomUUID(),
      cursors: {}, scanEnd: 0, dailyChecked: 0, active: false, appliedBatches: [],
    }
    const path = join(this.directory, 'state.json')
    if (existsSync(path)) {
      try { this.state = { ...this.state, ...JSON.parse(readFileSync(path, 'utf8')) } }
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
    return { ...view, concurrencyLimit: this.concurrency.limit, activeSessions:this.activeSessions, initialScanComplete: Boolean(this.state.runId && dailyChecked), typeFilterVersion: 1, accountWxid: this.config.getMyWxidCleaned() }
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

  private async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, anonymous = false): Promise<any> {
    if (!anonymous) this.assertAccount()
    const response = await fetch(this.state.origin + '/api/v1/wechat-history' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(body instanceof Buffer ? 120_000 : 30_000),
      headers: { ...(anonymous ? {} : { Authorization: `Bearer ${this.token()}` }), 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body),
    })
    const result: any = await response.json().catch(() => ({}))
    if (!response.ok) {
      if ([401, 403].includes(response.status)) { this.state.active = false; this.state.status = 'paused' }
      const error = new Error(result.detail?.message || (typeof result.detail === 'string' ? result.detail : '') || `中台请求失败 (${response.status})`)
      Object.assign(error, { statusCode: response.status })
      throw error
    }
    return result.data
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
    await this.request(`/runs/${this.state.runId}`, 'PATCH', { action: 'resume' })
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

  private async sessionInfo(id: string): Promise<HistorySession> {
    const contact = await chatService.getContact(id)
    let members: HistorySession['members'] = []
    if (id.endsWith('@chatroom')) {
      const result = await wcdbService.getGroupMembers(id)
      members = (result.members || []).slice(0, 2000).map((m: any) => ({
        wxid: String(m.wxid || m.username || m.member_wxid || ''), nickname: String(m.nickname || m.nickName || ''),
        display_name: String(m.displayName || m.display_name || m.groupNickname || ''),
      })).filter(m => m.wxid)
    }
    return { wxid: id, display_name: contact?.remark || contact?.nickName || id, nickname: contact?.nickName || '',
      remark: contact?.remark || '', avatar_url: '', members }
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

  private async uploadSpool(spool: Spool, path: string, progress?: SessionProgress) {
    this.assertAccount()
    const result = await this.request(`/runs/${this.state.runId}/batches`, 'POST', spool.batch)
    for (const item of result.items) {
      if (progress && item.outcome === 'failed') progress.issue = item.error
      if (item.outcome === 'failed') this.problem(spool.batch.session.wxid, item.source_key, item.error)
      const message = spool.media[item.source_key]
      if (this.state.options.media && message && item.outcome !== 'failed' && item.media_status !== 'uploaded') {
        const key = createHash('sha256').update(spool.batch.session.wxid + '\0' + item.source_key).digest('hex')
        const path = join(this.directory, 'media-queue', key + '.json')
        if (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).runId !== this.state.runId) {
          this.atomic(path, { runId: this.state.runId, session: spool.batch.session.wxid, key: item.source_key, message, status: 'pending' })
        }
      }
    }
    const check = await this.request(`/runs/${this.state.runId}/reconcile`, 'POST', {
      session_wxid: spool.batch.session.wxid, source_keys: spool.batch.messages.map(m => m.source_key),
    })
    if (check.matched + result.failed < check.expected) throw new Error('中台对账存在未解释缺口，批次保留等待重试')
    if (!this.state.appliedBatches.includes(spool.batch.batch_id)) {
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
          pass.positions[peer] = {time, keys:[...keys]}
        }
        progress.inserted = (progress.inserted || 0) + result.inserted; progress.existing = (progress.existing || 0) + result.existing
        progress.processed += spool.batch.messages.length; progress.failed += result.failed
        progress.total = Math.max(progress.total, progress.processed)
      }
      this.state.inserted += result.inserted; this.state.existing += result.existing
      this.state.scanned += spool.batch.messages.length
      this.state.appliedBatches = [...this.state.appliedBatches, spool.batch.batch_id].slice(-2000)
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

  private lastDisplayedLimit = 9
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
    const session = countOnly ? undefined : await this.sessionInfo(id)
    const pos = full && !countOnly && progress ? this.state.pass?.positions[id] : undefined
    const already = new Set(pos?.keys || [])
    const start = full ? Math.max(options.start,pos?.time || 0) : Math.max(options.start, (this.state.cursors[id] || 0) - 600)
    const simple = { text:1, image:3, video:43, emoji:47, voice:34, file:49, other:0 }
    const baseTypes = options.kinds && !options.kinds.includes('other') ? options.kinds.map(k => simple[k]) : undefined
    // For formats determined entirely by the type column, let the DB worker count without sending message bodies.
    if (countOnly && (options.kinds?.includes('file') === options.kinds?.includes('other')) && wcdbService.getSessionMessageTypeStats) {
      const stats = await wcdbService.getSessionMessageTypeStats(id, start, end)
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
    const cursor = await wcdbService.openMessageCursor(id, 100, true, start, end, baseTypes)
    if (!cursor.success || !cursor.cursor) throw Object.assign(new Error(cursor.error || '无法打开本地消息游标，请检查读取组件'), { pauseSync: true })
    try {
      let hasMore = true
      while (hasMore && (!live || this.state.active)) {
        this.assertAccount()
        const result = await wcdbService.fetchMessageBatch(cursor.cursor)
        if (!result.success) throw Object.assign(new Error(result.error || '读取本地消息失败'), { sessionReadError: true })
        this.assertAccount()
        const rows = result.rows || []
        let pending = session ? this.newSpool(session) : undefined
        let batchBytes = pending ? Buffer.byteLength(JSON.stringify(pending.batch)) : 0
        let sliceStarted = Date.now()
        for (const row of rows) {
          if (Date.now() - sliceStarted >= 8) {
            await new Promise<void>(resolve => setImmediate(resolve))
            if (live && !this.state.active) break
            this.assertAccount(); sliceStarted = Date.now()
          }
          const message = chatService.mapRowsToMessagesForApi([row], id)[0]
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
          if (nextSize > 1900000 && pending.batch.messages.length) {
            await this.submit(pending, progress); pending = this.newSpool(session); batchBytes = Buffer.byteLength(JSON.stringify(pending.batch))
          }
          if (recordBytes > 1700000) { if (progress) { progress.processed++; progress.failed++ }; this.problem(id, record.source_key, '单条消息超过传输限制'); continue }
          batchBytes += recordBytes + 1
          pending.batch.messages.push(record)
          if (record.media_kind && this.state.options.media) pending.media[record.source_key] = message
          pending.maxTime = Math.max(pending.maxTime, message.createTime)
        }
        if (pending?.batch.messages.length) {
          await this.submit(pending, progress)
        }
        hasMore = Boolean(result.hasMore && rows.length)
      }
      // A fully scanned but excluded window must not force a full reread every poll.
      if (!countOnly && !hasMore && this.state.active && this.state.options.kinds?.length && this.state.options.kinds.length < selectedKinds().length) {
        this.state.cursors[id] = Math.max(this.state.cursors[id] || 0, end)
      }
    } finally { await wcdbService.closeMessageCursor(cursor.cursor) }
  }

  private newSpool(session: HistorySession): Spool {
    return { batch: { schema_version: 1, batch_id: randomUUID(), account_wxid: this.state.binding!.account_wxid, session, messages: [] }, media: {}, maxTime: 0 }
  }

  private async tick() {
    if (!this.state?.active || this.busy || Date.now() < this.retryAt) return
    this.busy = true
    try {
      this.assertAccount(); this.state.status = 'running'
      for (const file of this.pendingFiles()) {
        if (!this.state.active) break
        const spool: Spool = JSON.parse(readFileSync(file, 'utf8'))
        const progress = this.state.pass?.run === this.state.runId && this.state.pass
          ? this.state.sessionProgress?.find(r => r.id === spool.batch.session.wxid) : undefined
        await this.uploadSpool(spool, file, progress)
      }
      if (!this.state.pendingFinish) {
        const full = !!this.state.pass || !this.state.dailyChecked || !this.state.sessionProgress || Date.now() - this.state.dailyChecked >= 86400000
        const resume = full && !!this.state.sessionProgress && (this.state.pass?.run === this.state.runId ||
          (!this.state.dailyChecked && this.state.progressPhase === 'counting'))
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
        const tasks = new Map(this.state.sessionProgress?.map(p => [p.id,p]))
        const finished = new Set(this.state.pass?.finished)
        await this.pool(selected, async session => {
          const row = tasks.get(session.id)
          const progress = full ? row : undefined
          if (progress && finished.has(session.id)) return
          try {
            if (progress && (progress.phase === 'waiting' || progress.phase === 'counting' || !progress.total)) {
              progress.total = 0
              progress.phase = 'counting'; this.save()
              await this.scan(session.id, end, true, progress, this.state.options, true)
              if (!this.state.active) return
              if (!progress.total) { progress.phase = 'skipped'; this.state.pass!.finished.push(session.id); this.state.completedSessions++; this.save(); return }
            }
            if (row) { row.phase = 'syncing'; row.issue = undefined }
            this.state.currentSession = session.name; this.save()
            await this.scan(session.id, end, full, progress)
            if (this.state.active) {
              if (progress) this.state.pass!.finished.push(session.id)
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
