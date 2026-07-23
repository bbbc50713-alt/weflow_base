import { EventEmitter } from 'events'
import { readFileSync, existsSync } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import * as http from 'http'
import * as https from 'https'
import type { WeChatMessage, Skill, ReplyLog, DailyStats, ContactSkillMapping, ModelType, ModelInfo, DistillConfig, DistillProgress, ChatRecord } from '../../../src/types/ai-reply'
import { DEFAULT_TRIGGER_RULES } from '../../../src/types/ai-reply'
import { createAdapter, type BaseAdapter } from './adapters'
import { markdownToPlainText } from './utils/markdownToPlainText'
import { SkillEngine } from './skill/SkillEngine'
import { ContextManager } from './core/ContextManager'
import { TriggerEngine } from './core/TriggerEngine'
import { MessageDeduper } from './core/MessageDeduper'
import { DistillService, type ChatRecordFetcher } from './distill/DistillService'
import { SenderManager } from './senders/SenderManager'
import { HanxiaomiReplyClient } from './hanxiaomi/HanxiaomiReplyClient'
import { HanxiaomiDeliveryLedger } from './hanxiaomi/HanxiaomiDeliveryLedger'
import { HanxiaomiInboundQueue } from './queue/HanxiaomiInboundQueue'
import { HanxiaomiOutboundQueue } from './queue/HanxiaomiOutboundQueue'
import { DEFAULT_DELIVERY_POLICY } from './queue/DeliveryPacer'
import type { HanxiaomiOutboundSendJob } from './queue/HanxiaomiQueueStore'
import {
  buildHanxiaomiEventKey,
  buildHanxiaomiReplyRequest,
  hashHanxiaomiRequest
} from './hanxiaomi/HanxiaomiContextBuilder'
import {
  extractHanxiaomiMessageText,
  isRecentHanxiaomiAutoReplyText,
  shouldIgnoreOperatorOutboundForHanxiaomiSplitContinuation
} from './hanxiaomi/HanxiaomiStalenessGuard'
import type {
  HanxiaomiChannelConfig,
  HanxiaomiContextProvider,
  HanxiaomiDeliveryPolicyConfig,
  HanxiaomiMode,
  HanxiaomiScenario
} from './hanxiaomi/types'

export interface AIReplyServiceEvents {
  statusChanged: (status: string) => void
  sseStatusChanged: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void
  messageReceived: (message: WeChatMessage) => void
  replySent: (log: ReplyLog) => void
  replyError: (error: { contactId: string; error: string }) => void
  processingStarted: (info: { contactId: string; contactName: string; stage: string }) => void
  processingCompleted: (info: { contactId: string; contactName: string; success: boolean }) => void
  messageFlowUpdate: (info: { contactId: string; contactName: string; stage: string; detail?: string }) => void
}

const DEFAULT_HANXIAOMI_INBOUND_CONCURRENCY = 3
const DEFAULT_HANXIAOMI_DELIVERY_POLICY: HanxiaomiDeliveryPolicyConfig = {
  minDelayMs: DEFAULT_DELIVERY_POLICY.minDelayMs,
  maxDelayMs: DEFAULT_DELIVERY_POLICY.maxDelayMs,
  postSendGapMsMin: DEFAULT_DELIVERY_POLICY.postSendGapMsMin,
  postSendGapMsMax: DEFAULT_DELIVERY_POLICY.postSendGapMsMax,
  perContactCooldownMs: DEFAULT_DELIVERY_POLICY.perContactCooldownMs,
  staleAfterMs: DEFAULT_DELIVERY_POLICY.staleAfterMs,
  splitMinGapMs: DEFAULT_DELIVERY_POLICY.splitMinGapMs,
  splitMaxGapMs: DEFAULT_DELIVERY_POLICY.splitMaxGapMs
}

function normalizePositiveInt(value: unknown, fallback: number, min = 1, max = 100): number {
  const next = Math.floor(Number(value))
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, next))
}

function normalizeDelayMs(value: unknown, fallback: number, min = 0, max = 24 * 60 * 60 * 1000): number {
  const next = Math.floor(Number(value))
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, next))
}

function normalizeTimestampMs(value: unknown, fallback = Date.now()): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  if (raw < 100000000000) return Math.floor(raw * 1000)
  return Math.floor(raw)
}

function normalizeHanxiaomiDeliveryPolicy(
  value?: Partial<HanxiaomiDeliveryPolicyConfig>,
  fallback: HanxiaomiDeliveryPolicyConfig = DEFAULT_HANXIAOMI_DELIVERY_POLICY
): HanxiaomiDeliveryPolicyConfig {
  const merged = { ...fallback, ...(value || {}) }
  const minDelayMs = normalizeDelayMs(merged.minDelayMs, fallback.minDelayMs)
  const maxDelayMs = Math.max(minDelayMs, normalizeDelayMs(merged.maxDelayMs, fallback.maxDelayMs))
  const postSendGapMsMin = normalizeDelayMs(merged.postSendGapMsMin, fallback.postSendGapMsMin)
  const postSendGapMsMax = Math.max(postSendGapMsMin, normalizeDelayMs(merged.postSendGapMsMax, fallback.postSendGapMsMax))
  const splitMinGapMs = normalizeDelayMs(merged.splitMinGapMs, fallback.splitMinGapMs)
  return {
    minDelayMs,
    maxDelayMs,
    postSendGapMsMin,
    postSendGapMsMax,
    perContactCooldownMs: normalizeDelayMs(merged.perContactCooldownMs, fallback.perContactCooldownMs),
    staleAfterMs: normalizeDelayMs(merged.staleAfterMs, fallback.staleAfterMs, 1000),
    splitMinGapMs,
    splitMaxGapMs: Math.max(splitMinGapMs, normalizeDelayMs(merged.splitMaxGapMs, fallback.splitMaxGapMs))
  }
}

export class AIReplyService extends EventEmitter {
  private status: 'stopped' | 'running' | 'paused' | 'error' = 'stopped'
  private modelAdapters: Map<string, BaseAdapter> = new Map()
  private activeModelId: string = ''
  private activeSkillId: string = 'default-assistant'
  private contactSkillMappings: Map<string, string> = new Map()
  private skillEngine: SkillEngine
  private contextManager: ContextManager
  private triggerEngine: TriggerEngine
  private messageDeduper: MessageDeduper
  private replyLogs: ReplyLog[] = []
  private maxReplyLogs: number = 5000
  private logsSaveTimer: NodeJS.Timeout | null = null
  private logsSaveRequested = false
  private logsSaveInFlight = false
  private dailyStats: DailyStats = { receivedCount: 0, repliedCount: 0, activeContacts: 0, errorCount: 0 }
  private activeContactsToday: Set<string> = new Set()
  private sseConnection: EventSource | null = null
  private sseAbortController: AbortController | null = null
  private sseUrl: string = ''
  private accessToken: string = ''
  private selfWxid: string = ''
  private recentSentMessages: Map<string, number> = new Map()
  private sseStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  private sseError: string = ''
  private distillService: DistillService
  private senderManager: SenderManager
  private autoReplyEnabled: boolean = true
  private logsFilePath: string
  private skillsDir: string
  private processingContacts: Set<string> = new Set()
  private hanxiaomiConfig: HanxiaomiChannelConfig = {
    enabled: false,
    serviceUrl: '',
    keyId: '',
    signingSecret: '',
    timeoutMs: 120000,
    inboundConcurrency: DEFAULT_HANXIAOMI_INBOUND_CONCURRENCY,
    deliveryPolicy: DEFAULT_HANXIAOMI_DELIVERY_POLICY
  }
  private hanxiaomiClient: HanxiaomiReplyClient
  private hanxiaomiLedger: HanxiaomiDeliveryLedger
  private hanxiaomiContextProvider: HanxiaomiContextProvider | null = null
  private hanxiaomiInboundQueue: HanxiaomiInboundQueue<{
    contactId: string
    entry: { messages: WeChatMessage[]; contactName: string; isGroup: boolean }
    mergedContent: string
  }>
  private hanxiaomiOutboundQueue: HanxiaomiOutboundQueue

  private messageBuffer: Map<string, { messages: WeChatMessage[], timer: NodeJS.Timeout, contactName: string, isGroup: boolean, retryCount: number }> = new Map()
  private messageBufferDelay: number = 2000
  // P0-3 修复：缓冲重试上限需覆盖 UI 自动化发送的最坏情况（45s 超时 × 2 重试 + 1.5s 间隔 ≈ 91.5s）。
  // 50 次 × 2s = 100s，足以覆盖单次发送全流程。
  private maxBufferRetries: number = 50

  // P0-1 修复：SSE 断连补拉机制
  private lastProcessedTimestamp: number = Date.now()
  private sseDisconnectAt: number | null = null
  private backfillFetcher: ((sinceTs: number) => Promise<WeChatMessage[]>) | null = null
  private isBackfilling: boolean = false

  // P1-2 修复：每日统计午夜重置
  private dailyResetTimer: NodeJS.Timeout | null = null
  private lastStatsDate: string = ''

  constructor(skillsDir: string) {
    super()
    this.skillsDir = skillsDir
    this.skillEngine = new SkillEngine(skillsDir)
    this.contextManager = new ContextManager()
    this.triggerEngine = new TriggerEngine(DEFAULT_TRIGGER_RULES)
    this.messageDeduper = new MessageDeduper()
    this.distillService = new DistillService()
    this.senderManager = new SenderManager()
    this.hanxiaomiClient = new HanxiaomiReplyClient(this.hanxiaomiConfig)
    this.hanxiaomiLedger = new HanxiaomiDeliveryLedger(skillsDir)
    this.hanxiaomiInboundQueue = new HanxiaomiInboundQueue({
      concurrency: this.hanxiaomiConfig.inboundConcurrency,
      handler: async job => {
        await this.processBufferedMessagesWithHanxiaomi(
          job.payload.contactId,
          job.payload.entry,
          job.payload.mergedContent
        )
      },
      onStatus: job => {
        this.emit('messageFlowUpdate', {
          contactId: job.contactId,
          contactName: job.contactName,
          stage: job.status,
          detail: job.lastError || `汉小密生成队列：${job.status}`
        })
      }
    })
    this.hanxiaomiOutboundQueue = new HanxiaomiOutboundQueue(skillsDir, {
      sendText: async job => this.senderManager.sendText({
        contactId: job.contactId,
        contactName: job.contactName,
        text: job.text,
        isGroup: false
      }),
      shouldSkip: async job => this.shouldSkipHanxiaomiOutboundJob(job),
      onStatus: job => this.handleHanxiaomiOutboundStatus(job)
    }, this.hanxiaomiConfig.deliveryPolicy)
    this.logsFilePath = join(skillsDir, '..', 'reply-logs.json')
    this.loadLogsFromDisk()

    this.distillService.on('progress', (progress: any) => {
      this.emit('distillProgress', progress)
    })
  }

  setDistillChatRecordFetcher(fetcher: ChatRecordFetcher): void {
    this.distillService.setChatRecordFetcher(fetcher)
  }

  /**
   * P0-1 修复：注入 SSE 断连补拉回调。
   * fetcher 接收 sinceTs（断连开始时间戳），返回断连期间漏掉的消息列表。
   * 由 main.ts 实现：遍历活跃联系人，用 chatService.getMessages(startTime) 查询。
   */
  setBackfillFetcher(fetcher: (sinceTs: number) => Promise<WeChatMessage[]>): void {
    this.backfillFetcher = fetcher
  }

  setHanxiaomiContextProvider(provider: HanxiaomiContextProvider): void {
    this.hanxiaomiContextProvider = provider
  }

  setHanxiaomiChannelConfig(config: Partial<HanxiaomiChannelConfig>): HanxiaomiChannelConfig {
    const deliveryPolicy = normalizeHanxiaomiDeliveryPolicy(
      config.deliveryPolicy,
      normalizeHanxiaomiDeliveryPolicy(this.hanxiaomiConfig.deliveryPolicy)
    )
    const inboundConcurrency = normalizePositiveInt(
      config.inboundConcurrency ?? this.hanxiaomiConfig.inboundConcurrency,
      DEFAULT_HANXIAOMI_INBOUND_CONCURRENCY,
      1,
      20
    )
    this.hanxiaomiConfig = {
      ...this.hanxiaomiConfig,
      ...config,
      timeoutMs: Math.max(120000, Number(config.timeoutMs ?? this.hanxiaomiConfig.timeoutMs) || 120000),
      inboundConcurrency,
      deliveryPolicy
    }
    this.hanxiaomiClient.updateConfig(this.hanxiaomiConfig)
    this.hanxiaomiInboundQueue.updateConcurrency(inboundConcurrency)
    this.hanxiaomiOutboundQueue.updatePolicy(deliveryPolicy)
    return this.getHanxiaomiChannelConfig()
  }

  getHanxiaomiChannelConfig(maskSecret = true): HanxiaomiChannelConfig {
    return {
      ...this.hanxiaomiConfig,
      signingSecret: maskSecret && this.hanxiaomiConfig.signingSecret ? '******' : this.hanxiaomiConfig.signingSecret,
      identitySalt: maskSecret && this.hanxiaomiConfig.identitySalt ? '******' : this.hanxiaomiConfig.identitySalt
    }
  }

  isHanxiaomiChannelEnabled(): boolean {
    return this.hanxiaomiClient.isEnabled()
  }

  async testHanxiaomiChannel(): Promise<{ success: boolean; message: string; latencyMs?: number }> {
    return this.hanxiaomiClient.testConnection()
  }

  private loadLogsFromDisk(): void {
    try {
      if (existsSync(this.logsFilePath)) {
        const raw = readFileSync(this.logsFilePath, 'utf-8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          this.replyLogs = data
        }
      }
    } catch {
      this.replyLogs = []
    }
  }

  private saveLogsToDisk(): void {
    this.logsSaveRequested = true
    if (this.logsSaveTimer) return
    this.logsSaveTimer = setTimeout(() => {
      this.logsSaveTimer = null
      void this.flushLogsToDisk()
    }, 120)
    this.logsSaveTimer.unref?.()
  }

  private async flushLogsToDisk(): Promise<void> {
    if (this.logsSaveInFlight) return
    if (!this.logsSaveRequested) return
    this.logsSaveInFlight = true
    this.logsSaveRequested = false
    let temporaryPath = ''
    try {
      if (this.replyLogs.length > this.maxReplyLogs) {
        this.replyLogs = this.replyLogs.slice(-this.maxReplyLogs)
      }
      const dir = join(this.logsFilePath, '..')
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
      temporaryPath = `${this.logsFilePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(this.replyLogs, null, 0), 'utf-8')
      await rename(temporaryPath, this.logsFilePath)
    } catch {
      if (temporaryPath) await unlink(temporaryPath).catch(() => {})
    }
    finally {
      this.logsSaveInFlight = false
      if (this.logsSaveRequested) this.saveLogsToDisk()
    }
  }

  async start(): Promise<void> {
    if (this.status === 'running') return

    if (!this.isHanxiaomiChannelEnabled() && this.modelAdapters.size === 0) {
      throw new Error('请先配置至少一个模型')
    }
    if (!this.isHanxiaomiChannelEnabled() && !this.activeModelId) {
      throw new Error('请选择一个激活模型')
    }

    try {
      await this.skillEngine.loadAllSkills()
      this.lastProcessedTimestamp = Date.now()
      this.scheduleDailyReset()
      this.connectSSE()
      this.status = 'running'
      this.emit('statusChanged', this.status)
    } catch (error) {
      this.status = 'error'
      this.emit('statusChanged', this.status)
      throw error
    }
  }

  pause(): void {
    if (this.status !== 'running') return
    this.status = 'paused'
    this.disconnectSSE()
    this.emit('statusChanged', this.status)
  }

  resume(): void {
    if (this.status !== 'paused') return
    this.connectSSE()
    this.status = 'running'
    this.emit('statusChanged', this.status)
  }

  stop(): void {
    this.disconnectSSE()
    if (this.dailyResetTimer) {
      clearTimeout(this.dailyResetTimer)
      this.dailyResetTimer = null
    }
    this.status = 'stopped'
    this.emit('statusChanged', this.status)
  }

  /**
   * P1-2 修复：每天午夜 0 点重置每日统计（receivedCount/repliedCount/errorCount/activeContactsToday）。
   * 确保跨天运行时统计准确。
   */
  private scheduleDailyReset(): void {
    if (this.dailyResetTimer) {
      clearTimeout(this.dailyResetTimer)
    }
    const now = new Date()
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
    const delay = tomorrow.getTime() - now.getTime()
    this.lastStatsDate = now.toDateString()
    this.dailyResetTimer = setTimeout(() => {
      console.log('[AIReplyService] 午夜重置每日统计')
      this.dailyStats = { receivedCount: 0, repliedCount: 0, activeContacts: 0, errorCount: 0 }
      this.activeContactsToday.clear()
      this.scheduleDailyReset()
    }, delay)
  }

  getStatus(): string {
    return this.status
  }

  setModelAdapter(modelConfig: any): void {
    try {
      const adapter = createAdapter(modelConfig)
      this.modelAdapters.set(modelConfig.id, adapter)
      if (!this.activeModelId) {
        this.activeModelId = modelConfig.id
      }
    } catch (error) {
      console.error('[AIReplyService] Failed to create adapter:', error)
      this.modelAdapters.delete(modelConfig.id)
    }
  }

  removeModelAdapter(modelId: string): void {
    this.modelAdapters.delete(modelId)
    if (this.activeModelId === modelId) {
      const remaining = Array.from(this.modelAdapters.keys())
      this.activeModelId = remaining.length > 0 ? remaining[0] : ''
    }
  }

  setActiveModel(modelId: string): void {
    if (this.modelAdapters.has(modelId)) {
      this.activeModelId = modelId
    }
  }

  getActiveModelId(): string {
    return this.activeModelId
  }

  setActiveSkill(skillId: string): void {
    if (this.skillEngine.getSkill(skillId)) {
      this.activeSkillId = skillId
    }
  }

  getActiveSkillId(): string {
    return this.activeSkillId
  }

  setContactSkillMapping(contactId: string, skillId: string): void {
    this.contactSkillMappings.set(contactId, skillId)
  }

  removeContactSkillMapping(contactId: string): void {
    this.contactSkillMappings.delete(contactId)
  }

  getContactSkillMappings(): ContactSkillMapping[] {
    return Array.from(this.contactSkillMappings.entries()).map(([contactId, skillId]) => ({
      contactId,
      skillId,
      enabled: true
    }))
  }

  setTriggerRules(rules: any): void {
    this.triggerEngine.updateRules(rules)
  }

  getTriggerRules(): any {
    return this.triggerEngine.getRules()
  }

  setAutoReplyEnabled(enabled: boolean): void {
    this.autoReplyEnabled = enabled
    this.senderManager.setAutoSendEnabled(enabled)
  }

  isAutoReplyEnabled(): boolean {
    return this.autoReplyEnabled
  }

  getSenderConfig(): any {
    return this.senderManager.getConfig()
  }

  setSenderConfig(config: any): any {
    return this.senderManager.updateConfig(config)
  }

  async getSenderHealth(senderId?: any): Promise<any> {
    return this.senderManager.getHealth(senderId)
  }

  setSSEConfig(url: string, accessToken: string): void {
    this.sseUrl = url
    this.accessToken = accessToken
  }

  setSelfNickname(name: string): void {
    this.triggerEngine.setSelfNickname(name)
  }

  setSelfWxid(wxid: string): void {
    this.selfWxid = wxid
  }

  getSSEStatus(): { status: string; error?: string } {
    return {
      status: this.sseStatus,
      error: this.sseError || undefined
    }
  }

  getSkillEngine(): SkillEngine {
    return this.skillEngine
  }

  getContextManager(): ContextManager {
    return this.contextManager
  }

  getReplyLogs(limit = 100, offset = 0): ReplyLog[] {
    const sorted = [...this.replyLogs].sort((a, b) => b.timestamp - a.timestamp)
    return sorted.slice(offset, offset + limit)
  }

  getReplyLogsCount(): number {
    return this.replyLogs.length
  }

  clearReplyLogs(): void {
    this.replyLogs = []
    this.saveLogsToDisk()
  }

  deleteReplyLogs(ids: string[]): void {
    const idSet = new Set(ids)
    this.replyLogs = this.replyLogs.filter(log => !idSet.has(log.id))
    this.saveLogsToDisk()
  }

  getDailyStats(): DailyStats {
    return {
      ...this.dailyStats,
      activeContacts: this.activeContactsToday.size
    }
  }

  setDailyStats(stats: DailyStats): void {
    this.dailyStats = {
      receivedCount: stats.receivedCount || 0,
      repliedCount: stats.repliedCount || 0,
      activeContacts: 0,
      errorCount: stats.errorCount || 0
    }
  }

  async testModelConnection(modelId: string): Promise<any> {
    const adapter = this.modelAdapters.get(modelId)
    if (!adapter) {
      return { success: false, message: '模型未找到' }
    }
    return adapter.testConnection()
  }

  async testModelWithConfig(modelConfig: any): Promise<any> {
    try {
      const adapter = createAdapter(modelConfig)
      if (!adapter) {
        return { success: false, message: `不支持的模型类型: ${modelConfig.type}` }
      }
      return await adapter.testConnection()
    } catch (error) {
      return { success: false, message: `测试失败: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async generateTestReply(skillId: string, modelId: string, testMessage: string): Promise<{ content: string; latencyMs?: number }> {
    const skill = this.skillEngine.getSkill(skillId) || this.skillEngine.getSkill('default-assistant')
    if (!skill) return { content: '未找到角色' }

    const targetModelId = modelId || this.activeModelId
    const adapter = this.modelAdapters.get(targetModelId)
    if (!adapter) return { content: '未配置模型' }

    const systemPrompt = this.skillEngine.generateSystemPrompt(skill)
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: testMessage }
    ]

    try {
      const start = Date.now()
      const result = await adapter.generate(messages, {
        maxTokens: skill.replyStrategy.maxReplyLength
      })
      const latencyMs = Date.now() - start
      // 转换 Markdown 为纯文本格式
      const plainContent = markdownToPlainText(result.content)
      return { content: plainContent, latencyMs }
    } catch (error) {
      return { content: `生成失败: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * P0-2 修复：AI 生成失败重试。
   * 最多重试 3 次（首次 + 2 次重试），间隔递增（1s, 2s）。
   * 仅对可重试错误重试：超时、429 限流、502/503 网关错误、网络异常。
   * 不重试的错误（401 认证、400 参数错误等）直接抛出。
   */
  private async generateWithRetry(
    adapter: BaseAdapter,
    messages: { role: string; content: string }[],
    options: { maxTokens?: number }
  ): Promise<{ content: string; model?: string; usage?: any }> {
    const maxAttempts = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await adapter.generate(messages as any, options)
        if (attempt > 1) {
          console.log(`[AIReplyService] AI 生成重试 ${attempt}/${maxAttempts} 成功`)
        }
        return result
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        const errMsg = lastError.message

        // 判断是否可重试
        const isRetryable = this.isRetryableError(errMsg)
        if (!isRetryable || attempt === maxAttempts) {
          console.warn(`[AIReplyService] AI 生成失败 (attempt ${attempt}/${maxAttempts}): ${errMsg}`)
          throw lastError
        }

        const delayMs = attempt * 1000 // 1s, 2s
        console.warn(`[AIReplyService] AI 生成失败 (attempt ${attempt}/${maxAttempts}), ${delayMs}ms 后重试: ${errMsg}`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }

    throw lastError || new Error('AI 生成失败')
  }

  /**
   * 判断错误是否可重试。
   * 可重试：超时、429、502、503、504、网络异常、连接重置、ECONNREFUSED
   * 不可重试：401、403、400 参数错误
   */
  private isRetryableError(errMsg: string): boolean {
    const lower = errMsg.toLowerCase()
    // 不可重试的错误（认证/参数/权限）
    if (lower.includes('401') || lower.includes('认证失败') || lower.includes('api key')) return false
    if (lower.includes('403') || lower.includes('forbidden')) return false
    if (lower.includes('400') && lower.includes('parameter')) return false
    // 可重试的错误
    if (lower.includes('timeout') || lower.includes('超时')) return true
    if (lower.includes('429') || lower.includes('rate limit') || lower.includes('限流')) return true
    if (lower.includes('502') || lower.includes('503') || lower.includes('504')) return true
    if (lower.includes('network') || lower.includes('网络')) return true
    if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('fetch failed')) return true
    if (lower.includes('aborted')) return true
    // 默认重试（未知错误宁可重试一次，避免临时抖动丢消息）
    return true
  }

  private async handleIncomingMessage(message: WeChatMessage): Promise<void> {
    console.log(`[AIReplyService] >>> 收到新消息 <<< msgId=${message.msgId}, from=${message.contactName}(${message.contactId}), isGroup=${message.isGroup}`)
    console.log(`[AIReplyService] 当前服务状态: ${this.status}`)

    if (this.status !== 'running') {
      console.log(`[AIReplyService] 服务未运行，跳过处理`)
      return
    }

    if (this.messageDeduper.isDuplicate(message.msgId)) {
      console.log(`[AIReplyService] 消息去重，跳过: msgId=${message.msgId}`)
      return
    }
    // 内容级相似度去重：同一联系人在 TTL 内发高度相似内容则跳过，避免重复回复
    if (this.messageDeduper.isSimilar(message.content, message.contactId)) {
      console.log(`[AIReplyService] 内容与近期消息高度相似，跳过: msgId=${message.msgId}`)
      return
    }
    this.messageDeduper.markProcessed(message.msgId, message.content, message.contactId)

    if (message.isSend) {
      console.log(`[AIReplyService] 是自己发送的消息，跳过`)
      return
    }
    if (message.type === 10000) {
      console.log(`[AIReplyService] 是系统消息(type=10000)，跳过`)
      return
    }

    console.log(`[AIReplyService] 消息内容: ${message.content.substring(0, 80)}${message.content.length > 80 ? '...' : ''}`)

    // P0-1 修复：记录最后处理时间戳，用于 SSE 断连补拉
    if (message.timestamp && message.timestamp > this.lastProcessedTimestamp) {
      this.lastProcessedTimestamp = message.timestamp
    }

    this.dailyStats.receivedCount++
    this.activeContactsToday.add(message.contactId)
    this.emit('messageReceived', message)
    this.emit('messageFlowUpdate', {
      contactId: message.contactId,
      contactName: message.contactName,
      stage: 'received',
      detail: message.content.slice(0, 50)
    })

    const existingEntry = this.messageBuffer.get(message.contactId)
    if (existingEntry) {
      // P0 修复：clearTimeout 后必须重新设置 timer，否则连续消息到达时
      // 原 timer 被清除且无新 timer，整批消息会永远卡在 buffer 中不被处理。
      clearTimeout(existingEntry.timer)
      existingEntry.messages.push(message)
      // 重新设置延迟定时器：以最后一条消息为起点，延迟 messageBufferDelay 后处理
      existingEntry.timer = setTimeout(() => {
        console.log(`[AIReplyService] >>> 缓冲超时，开始处理消息 <<< contactId=${message.contactId}`)
        this.processBufferedMessages(message.contactId)
      }, this.messageBufferDelay)
      console.log(`[AIReplyService] 消息缓冲: ${message.contactId} 有 ${existingEntry.messages.length} 条消息等待合并，${this.messageBufferDelay}ms 后处理`)
      this.emit('messageFlowUpdate', {
        contactId: message.contactId,
        contactName: message.contactName,
        stage: 'buffering',
        detail: `已缓冲 ${existingEntry.messages.length} 条消息`
      })
    } else {
      console.log(`[AIReplyService] 开始缓冲消息: ${message.contactId}, ${this.messageBufferDelay}ms 后处理`)
      this.emit('messageFlowUpdate', {
        contactId: message.contactId,
        contactName: message.contactName,
        stage: 'buffering',
        detail: '等待合并更多消息...'
      })
      const timer = setTimeout(() => {
        console.log(`[AIReplyService] >>> 缓冲超时，开始处理消息 <<< contactId=${message.contactId}`)
        this.processBufferedMessages(message.contactId)
      }, this.messageBufferDelay)
      this.messageBuffer.set(message.contactId, {
        messages: [message],
        timer,
        contactName: message.contactName,
        isGroup: message.isGroup,
        retryCount: 0
      })
    }
  }

  private async processBufferedMessages(contactId: string): Promise<void> {
    console.log(`[AIReplyService] >>> processBufferedMessages 开始 <<< contactId=${contactId}`)
    const entry = this.messageBuffer.get(contactId)
    if (!entry) {
      console.log(`[AIReplyService] 缓冲条目不存在，可能已处理或超时清除`)
      return
    }

    // 修复消息缓冲期丢失：若该联系人正在处理中，不要直接 delete 并 skip，
    // 而是重新排队等待当前处理完成，避免漏回重要消息。
    if (this.processingContacts.has(contactId)) {
      if (entry.retryCount >= this.maxBufferRetries) {
        // 超过重试上限（约 messageBufferDelay * maxBufferRetries），放弃当前缓冲
        this.messageBuffer.delete(contactId)
        console.warn(`[AIReplyService] 该联系人处理超时，放弃缓冲消息: ${entry.contactName} (${entry.messages.length} 条, 重试 ${entry.retryCount} 次)`)
        this.emit('messageFlowUpdate', { contactId, contactName: entry.contactName, stage: 'skipped', detail: `处理超时，放弃 ${entry.messages.length} 条缓冲消息（重试 ${entry.retryCount} 次）` })
        return
      }
      entry.retryCount++
      console.log(`[AIReplyService] 该联系人正在处理中，重新排队 (retry ${entry.retryCount}/${this.maxBufferRetries}): ${entry.contactName}, 等待 ${entry.messages.length} 条消息`)
      this.emit('messageFlowUpdate', { contactId, contactName: entry.contactName, stage: 'buffering', detail: `正在处理中，重新排队 ${entry.retryCount}/${this.maxBufferRetries}（${entry.messages.length} 条消息）` })
      // 重新设置延迟定时器，等待当前处理完成后再尝试
      const timer = setTimeout(() => {
        this.processBufferedMessages(contactId)
      }, this.messageBufferDelay)
      entry.timer = timer
      return
    }

    this.messageBuffer.delete(contactId)
    this.processingContacts.add(contactId)
    console.log(`[AIReplyService] 开始处理消息: ${entry.contactName}, 消息数: ${entry.messages.length}`)

    try {
      this.emit('processingStarted', { contactId, contactName: entry.contactName, stage: 'trigger' })
      this.emit('messageFlowUpdate', { contactId, contactName: entry.contactName, stage: 'trigger', detail: '检查触发规则...' })

      const mergedContent = entry.messages.map(m => m.content).join('\n')
      const triggerMessage: WeChatMessage = {
        ...entry.messages[0],
        content: mergedContent
      }
      const triggerResult = this.triggerEngine.shouldReply(triggerMessage)
      console.log(`[AIReplyService] 触发规则检查: shouldReply=${triggerResult.shouldReply}, reason=${triggerResult.reason || 'none'}`)
      if (!triggerResult.shouldReply) {
        this.processingContacts.delete(contactId)
        console.log(`[AIReplyService] 不满足触发条件，跳过`)
        this.emit('messageFlowUpdate', { contactId, contactName: entry.contactName, stage: 'skipped', detail: triggerResult.reason || '不满足触发条件' })
        this.emit('processingCompleted', { contactId, contactName: entry.contactName, success: false })
        return
      }

      this.emit('processingStarted', { contactId, contactName: entry.contactName, stage: 'generating' })
      this.emit('messageFlowUpdate', { contactId, contactName: entry.contactName, stage: 'generating', detail: '正在生成回复...' })

      if (this.isHanxiaomiChannelEnabled()) {
        this.hanxiaomiInboundQueue.enqueue(contactId, entry.contactName, {
          contactId,
          entry,
          mergedContent
        })
        return
      }

      const skillId = this.contactSkillMappings.get(contactId) || this.activeSkillId
      const skill = this.skillEngine.getSkill(skillId)
      console.log(`[AIReplyService] 使用角色: ${skill?.name || '未找到'} (${skillId})`)
      if (!skill) {
        this.processingContacts.delete(contactId)
        console.log(`[AIReplyService] 未找到角色配置，停止`)
        this.emit('messageFlowUpdate', { contactId, contactName: entry.contactName, stage: 'error', detail: '未找到角色配置' })
        this.emit('processingCompleted', { contactId, contactName: entry.contactName, success: false })
        return
      }

      const adapter = this.modelAdapters.get(this.activeModelId)
      console.log(`[AIReplyService] 使用模型: ${adapter?.getModelInfo().name || '未配置'} (${this.activeModelId})`)
      if (!adapter) {
        console.log(`[AIReplyService] 未配置模型，停止`)
        this.emit('replyError', { contactId, error: '未配置模型' })
        this.processingContacts.delete(contactId)
        this.emit('messageFlowUpdate', { contactId, contactName: entry.contactName, stage: 'error', detail: '未配置模型' })
        this.emit('processingCompleted', { contactId, contactName: entry.contactName, success: false })
        return
      }

      const startTime = Date.now()
      const contactName = entry.contactName
      const isGroup = entry.isGroup
      console.log(`[AIReplyService] 合并后消息内容: ${mergedContent.substring(0, 100)}${mergedContent.length > 100 ? '...' : ''}`)

      try {
        const { messages: context, summary } = this.contextManager.getContextWithSummary(contactId)
        console.log(`[AIReplyService] 上下文消息数: ${context.length}, 摘要: ${summary || 'none'}`)

        const relationship = skill.selfMemory.relationships.find(
          r => r.contactId === contactId
        )
        if (relationship) {
          console.log(`[AIReplyService] 找到关系信息: ${relationship.relationship}`)
        }

        const systemPrompt = this.skillEngine.generateSystemPrompt(skill, {
          // 修复：不再传 recentMessages。SkillEngine 的 V1/V2 prompt 生成均未消费此字段，
          // 且 context 已作为对话历史完整传入 messages 数组，重复注入末 5 条会浪费 token
          // 并可能让模型困惑。
          relationship,
          contextSummary: summary
        })

        const messages = [
          { role: 'system' as const, content: systemPrompt },
          ...context,
          { role: 'user' as const, content: mergedContent }
        ]
        console.log(`[AIReplyService] 开始调用 AI 模型生成回复...`)

        // P0-2 修复：AI 生成失败重试，最多 3 次，间隔递增（1s, 2s）。
        // 仅对可重试错误（超时、429、502/503、网络异常）重试，不对 401/参数错误重试。
        const result = await this.generateWithRetry(adapter, messages, {
          maxTokens: skill.replyStrategy.maxReplyLength
        })

        const plainContent = markdownToPlainText(result.content)
        console.log(`[AIReplyService] 小密回复已生成: ${plainContent.substring(0, 80)}${plainContent.length > 80 ? '...' : ''}`)

        this.contextManager.addMessage(contactId, {
          role: 'user',
          content: mergedContent,
          timestamp: entry.messages[0].timestamp
        })
        this.contextManager.addMessage(contactId, {
          role: 'assistant',
          content: plainContent,
          timestamp: Date.now()
        })

        const latencyMs = Date.now() - startTime

        if (skill.replyStrategy.responseDelay.min > 0) {
          const delay = Math.random() *
            (skill.replyStrategy.responseDelay.max - skill.replyStrategy.responseDelay.min) +
            skill.replyStrategy.responseDelay.min
          await new Promise(resolve => setTimeout(resolve, delay))
        }

        let sent = false
        let sendError: string | undefined

        console.log(`[AIReplyService] >>> 开始发送流程 <<<`)
        console.log(`[AIReplyService] 联系人: ${contactName} (${contactId}), 是否群聊: ${isGroup}`)
        console.log(`[AIReplyService] autoReplyEnabled: ${this.autoReplyEnabled}, autoSendEnabled: ${this.senderManager.isAutoSendEnabled()}`)

        if (this.autoReplyEnabled && this.senderManager.isAutoSendEnabled()) {
          console.log(`[AIReplyService] 开始调用 WeChatSender.sendTextMessage...`)
          console.log(`[AIReplyService] 消息内容: ${plainContent.substring(0, 100)}${plainContent.length > 100 ? '...' : ''}`)

          this.emit('processingStarted', { contactId, contactName, stage: 'sending' })
          this.emit('messageFlowUpdate', { contactId, contactName, stage: 'sending', detail: '正在发送到微信...' })
          try {
            const sendStartTime = Date.now()
            const sendResult = await this.senderManager.sendText({
              contactId,
              contactName,
              text: plainContent,
              isGroup
            })
            const sendDuration = Date.now() - sendStartTime

            console.log(`[AIReplyService] WeChatSender 返回: success=${sendResult.success}, error=${sendResult.error || 'none'}`)
            console.log(`[AIReplyService] 发送耗时: ${sendDuration}ms`)

            if (sendResult.success && sendResult.delivered) {
              sent = true
              const sentKey = `${contactId}:${plainContent}`
              this.recentSentMessages.set(sentKey, Date.now())
              console.log(`[AIReplyService] >>> 发送成功 <<<`)
            } else {
              sendError = `发送失败: ${sendResult.error || sendResult.detail || '投递结果未确认'}`
              this.dailyStats.errorCount++
              console.warn(`[AIReplyService] >>> 发送失败 <<<: ${sendResult.error}`)
              this.emit('replyError', { contactId: contactId, error: sendError })
              this.emit('statsUpdated', this.getDailyStats())
            }
          } catch (sendErr: any) {
            sendError = `发送异常: ${sendErr.message}`
            this.dailyStats.errorCount++
            console.error(`[AIReplyService] >>> 发送抛出异常 <<<: ${sendErr.message}`, sendErr)
            this.emit('replyError', { contactId: contactId, error: sendError })
            this.emit('statsUpdated', this.getDailyStats())
          }
        } else {
          console.log(`[AIReplyService] 跳过发送: autoReplyEnabled=${this.autoReplyEnabled}, autoSendEnabled=${this.senderManager.isAutoSendEnabled()}`)
        }

        const log: ReplyLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          contactId: contactId,
          contactName: contactName,
          receivedMessage: mergedContent,
          generatedReply: plainContent,
          skillId: skill.id,
          skillName: skill.name,
          modelId: this.activeModelId,
          modelName: adapter.getModelInfo().name,
          latencyMs,
          success: !sendError,
          sent,
          errorMessage: sendError
        }

        this.replyLogs.push(log)
        this.saveLogsToDisk()
        if (sent) {
          this.dailyStats.repliedCount++
        }
        // P1-1 修复：通知上层持久化统计，避免重启丢失
        this.emit('replySent', log)
        this.emit('statsUpdated', this.getDailyStats())
        this.emit('processingCompleted', { contactId, contactName, success: !sendError })
        this.emit('messageFlowUpdate', {
          contactId,
          contactName,
          stage: sent ? 'sent' : 'generated',
          detail: sent ? '已发送到微信' : (sendError || '回复已生成（未发送）')
        })

      } catch (error) {
        const latencyMs = Date.now() - startTime
        const log: ReplyLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          contactId: contactId,
          contactName: contactName,
          receivedMessage: mergedContent,
          generatedReply: '',
          skillId: skill.id,
          skillName: skill.name,
          modelId: this.activeModelId,
          modelName: '',
          latencyMs,
          success: false,
          sent: false,
          errorMessage: error instanceof Error ? error.message : String(error)
        }

        this.replyLogs.push(log)
        this.saveLogsToDisk()
        this.dailyStats.errorCount++
        this.emit('replyError', { contactId: contactId, error: log.errorMessage || 'Unknown error' })
        this.emit('statsUpdated', this.getDailyStats())
        this.emit('messageFlowUpdate', {
          contactId,
          contactName,
          stage: 'error',
          detail: log.errorMessage || '处理出错'
        })
        this.emit('processingCompleted', { contactId, contactName, success: false })
      }
    } finally {
      this.processingContacts.delete(contactId)
    }
  }

  private async processBufferedMessagesWithHanxiaomi(
    contactId: string,
    entry: { messages: WeChatMessage[]; contactName: string; isGroup: boolean },
    mergedContent: string
  ): Promise<void> {
    if (!this.hanxiaomiContextProvider) {
      throw new Error('汉小密上下文 provider 未配置')
    }
    if (entry.isGroup || contactId.includes('@chatroom')) {
      this.emit('messageFlowUpdate', { contactId, contactName: entry.contactName, stage: 'skipped', detail: '汉小密渠道 V1 仅支持私聊' })
      this.emit('processingCompleted', { contactId, contactName: entry.contactName, success: false })
      return
    }

    const startTime = Date.now()
    const accountId = this.hanxiaomiContextProvider.getAccountId()
    const identitySalt = String(this.hanxiaomiConfig.identitySalt || '').trim()
    if (!accountId || !identitySalt) {
      throw new Error('汉小密渠道缺少账号标识或匿名盐')
    }

    const request = await buildHanxiaomiReplyRequest({
      accountId,
      contactId,
      contactName: entry.contactName,
      isFirstSuccessfulCall: !this.hanxiaomiLedger.hasSuccessfulContact(contactId),
      currentContent: mergedContent,
      bufferedMessages: entry.messages.map(message => ({
        msgId: message.msgId,
        messageKey: (message as any).messageKey,
        localId: (message as any).localId,
        serverId: (message as any).serverId,
        serverIdRaw: (message as any).serverIdRaw,
        content: message.content,
        timestamp: message.timestamp,
        type: message.type,
        senderId: message.senderId
      })),
      mode: 'auto',
      scenario: 'reply',
      identitySalt,
      provider: this.hanxiaomiContextProvider
    })
    const eventKey = buildHanxiaomiEventKey(contactId, request.current_message.message_key)
    const requestHash = hashHanxiaomiRequest(request)
    const existing = this.hanxiaomiLedger.get(eventKey)
    let replyText = existing?.text || ''
    let replySegments = this.normalizeHanxiaomiReplySegments(existing?.segments)
    let action = existing?.action
    let requestId = existing?.requestId

    if (existing && existing.requestHash === requestHash && ['completed', 'draft', 'sent', 'send_failed', 'skipped'].includes(existing.status)) {
      console.log(`[AIReplyService] 汉小密事件已存在，复用结果: ${eventKey}`)
    } else {
      this.hanxiaomiLedger.upsert({
        eventKey,
        contactId,
        contactName: entry.contactName,
        messageKey: request.current_message.message_key,
        requestHash,
        status: 'requested',
        scenario: 'reply',
        mode: 'auto',
        updatedAt: Date.now()
      })
      const response = await this.hanxiaomiClient.createReply(request)
      requestId = response.request_id
      action = response.action
      replyText = markdownToPlainText(response.text || '').trim()
      replySegments = this.normalizeHanxiaomiReplySegments(response.segments)
      this.hanxiaomiLedger.mark(eventKey, {
        requestId,
        action,
        text: replyText,
        segments: replySegments,
        status: action === 'skip' ? 'skipped' : 'completed'
      })
    }

    if (!action || action === 'skip' || !replyText) {
      this.emit('messageFlowUpdate', { contactId, contactName: entry.contactName, stage: 'skipped', detail: '汉小密返回 skip 或空文本' })
      this.emit('processingCompleted', { contactId, contactName: entry.contactName, success: false })
      return
    }

    const plainContent = replyText.slice(0, 1200)
    let sent = false
    let sendError: string | undefined
    let queued = false

    if (this.autoReplyEnabled && this.senderManager.isAutoSendEnabled() && action === 'send') {
      const triggerMessageTimestamp = Math.max(
        ...entry.messages.map(message => normalizeTimestampMs(message.timestamp, 0))
      ) || Date.now()
      this.hanxiaomiOutboundQueue.enqueue({
        eventKey,
        contactId,
        contactName: entry.contactName,
        text: plainContent,
        segments: replySegments.length > 0 ? replySegments : undefined,
        action,
        generatedAt: Date.now(),
        triggerMessageTimestamp,
        receivedMessage: mergedContent
      })
      queued = true
      this.hanxiaomiLedger.mark(eventKey, { status: 'queued' })
    } else {
      const status = action === 'handoff' || action === 'draft' ? 'draft' : 'completed'
      this.hanxiaomiLedger.mark(eventKey, { status })
    }

    if (sent) {
      this.contextManager.addMessage(contactId, {
        role: 'user',
        content: mergedContent,
        timestamp: normalizeTimestampMs(entry.messages[0]?.timestamp, Date.now())
      })
      this.contextManager.addMessage(contactId, {
        role: 'assistant',
        content: plainContent,
        timestamp: Date.now()
      })
      this.dailyStats.repliedCount++
    }

    const log: ReplyLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      contactId,
      contactName: entry.contactName,
      receivedMessage: mergedContent,
      generatedReply: plainContent,
      skillId: 'hanxiaomi-weflow-channel',
      skillName: '汉小密纯文本渠道',
      modelId: 'hanxiaomi',
      modelName: 'HanXiaoMi',
      latencyMs: Date.now() - startTime,
      success: !sendError,
      sent,
      errorMessage: sendError
    }

    this.replyLogs.push(log)
    this.saveLogsToDisk()
    this.emit('replySent', log)
    this.emit('statsUpdated', this.getDailyStats())
    this.emit('processingCompleted', { contactId, contactName: entry.contactName, success: !sendError })
    this.emit('messageFlowUpdate', {
      contactId,
      contactName: entry.contactName,
      stage: sent ? 'sent' : (queued ? 'queued' : 'generated'),
      detail: sent ? '汉小密回复已发送' : (queued ? '汉小密回复已入发送队列，等待按节奏投递' : (sendError || `汉小密返回 ${action}，已生成草稿/转人工文本`))
    })
  }

  private async shouldSkipHanxiaomiOutboundJob(job: HanxiaomiOutboundSendJob): Promise<string | undefined> {
    if (!this.autoReplyEnabled || !this.senderManager.isAutoSendEnabled()) {
      return 'auto reply or auto send is disabled before delivery'
    }
    if (!this.hanxiaomiContextProvider) return undefined
    try {
      const latest = await this.hanxiaomiContextProvider.getLatestMessages(job.contactId, 1)
      const latestMessage = latest.success && latest.messages && latest.messages.length > 0
        ? latest.messages[0] as any
        : null
      if (!latestMessage) return undefined
      const rawTime = Number(latestMessage.timestamp ?? latestMessage.createTime ?? 0)
      const latestTs = normalizeTimestampMs(rawTime, 0)
      const isSend = Number(latestMessage.isSend ?? latestMessage.is_send ?? 0)
      // 客户在发送前等待窗口里继续补充消息时，不再直接取消已生成回复。
      // 新消息会进入入站缓冲并生成下一轮回复；这里继续投递当前队列，避免“第一条回复后后续消息没反应/被误跳过”。
      if (latestTs > job.generatedAt && isSend === 1) {
        const latestText = extractHanxiaomiMessageText(latestMessage)
        if (isRecentHanxiaomiAutoReplyText(job.contactId, latestText, this.recentSentMessages.entries())) {
          return undefined
        }
        if (shouldIgnoreOperatorOutboundForHanxiaomiSplitContinuation(job)) {
          return undefined
        }
        return 'operator already replied before delivery'
      }
    } catch (error: any) {
      console.warn('[AIReplyService] failed to check Hanxiaomi outbound staleness:', error?.message || String(error))
    }
    return undefined
  }

  private handleHanxiaomiOutboundStatus(job: HanxiaomiOutboundSendJob): void {
    const parentEventKey = job.parentEventKey || job.eventKey
    const isSplitPart = Boolean(job.parentEventKey && job.partTotal && job.partTotal > 1)
    const isFinalPart = !isSplitPart || job.partIndex === job.partTotal

    if (job.status === 'queued' || job.status === 'waiting') {
      this.hanxiaomiLedger.mark(parentEventKey, { status: 'queued' })
      this.emit('messageFlowUpdate', {
        contactId: job.contactId,
        contactName: job.contactName,
        stage: job.status,
        detail: isSplitPart
          ? `汉小密回复第 ${job.partIndex}/${job.partTotal} 条正在等待投递`
          : '汉小密回复正在发送队列中等待投递'
      })
      return
    }

    if (job.status === 'sending') {
      this.hanxiaomiLedger.mark(parentEventKey, { status: 'sending' })
      this.emit('processingStarted', { contactId: job.contactId, contactName: job.contactName, stage: 'sending' })
      this.emit('messageFlowUpdate', {
        contactId: job.contactId,
        contactName: job.contactName,
        stage: 'sending',
        detail: isSplitPart
          ? `正在按队列节奏发送汉小密回复第 ${job.partIndex}/${job.partTotal} 条...`
          : '正在按队列节奏发送汉小密回复...'
      })
      return
    }

    if (job.status === 'sent') {
      const sentKey = `${job.contactId}:${job.text}`
      this.recentSentMessages.set(sentKey, Date.now())
      if (!isFinalPart) {
        this.hanxiaomiLedger.mark(parentEventKey, { status: 'sending' })
        this.emit('messageFlowUpdate', {
          contactId: job.contactId,
          contactName: job.contactName,
          stage: 'sending',
          detail: `汉小密回复第 ${job.partIndex}/${job.partTotal} 条已发送，等待下一条`
        })
        return
      }

      this.hanxiaomiLedger.mark(parentEventKey, { status: 'sent' })
      if (job.receivedMessage) {
        this.contextManager.addMessage(job.contactId, {
          role: 'user',
          content: job.receivedMessage,
          timestamp: job.triggerMessageTimestamp || Date.now()
        })
      }
      this.contextManager.addMessage(job.contactId, {
        role: 'assistant',
        content: job.fullText || job.text,
        timestamp: Date.now()
      })
      this.dailyStats.repliedCount++
      const log = this.createHanxiaomiDeliveryLog(job, true)
      this.replyLogs.push(log)
      this.saveLogsToDisk()
      this.emit('replySent', log)
      this.emit('statsUpdated', this.getDailyStats())
      this.emit('processingCompleted', { contactId: job.contactId, contactName: job.contactName, success: true })
      this.emit('messageFlowUpdate', {
        contactId: job.contactId,
        contactName: job.contactName,
        stage: 'sent',
        detail: isSplitPart ? `汉小密回复已分 ${job.partTotal} 条按队列发送` : '汉小密回复已按队列发送'
      })
      return
    }

    if (job.status === 'failed') {
      const error = job.lastError || '发送失败'
      this.hanxiaomiLedger.mark(parentEventKey, { status: 'send_failed', error })
      this.dailyStats.errorCount++
      this.emit('replyError', { contactId: job.contactId, error })
      this.emit('statsUpdated', this.getDailyStats())
      this.emit('processingCompleted', { contactId: job.contactId, contactName: job.contactName, success: false })
      this.emit('messageFlowUpdate', {
        contactId: job.contactId,
        contactName: job.contactName,
        stage: 'error',
        detail: error
      })
      return
    }

    if (job.status === 'superseded' || job.status === 'cancelled') {
      const reason = job.lastError || job.status
      this.hanxiaomiLedger.mark(parentEventKey, { status: job.status, error: reason })
      this.emit('messageFlowUpdate', {
        contactId: job.contactId,
        contactName: job.contactName,
        stage: 'skipped',
        detail: `汉小密旧回复未发送：${reason}`
      })
    }
  }

  private createHanxiaomiDeliveryLog(job: HanxiaomiOutboundSendJob, sent: boolean): ReplyLog {
    return {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      contactId: job.contactId,
      contactName: job.contactName,
      receivedMessage: job.receivedMessage || '[汉小密队列投递]',
      generatedReply: job.fullText || job.text,
      skillId: 'hanxiaomi-weflow-channel',
      skillName: '汉小密纯文本渠道',
      modelId: 'hanxiaomi',
      modelName: 'HanXiaoMi',
      latencyMs: Math.max(0, Date.now() - job.generatedAt),
      success: sent,
      sent,
      errorMessage: sent ? undefined : job.lastError
    }
  }

  private normalizeHanxiaomiReplySegments(segments?: string[]): string[] {
    if (!Array.isArray(segments)) return []
    const cleaned = segments
      .map(segment => markdownToPlainText(String(segment || '')).replace(/[~～]+/g, '').trim())
      .filter(Boolean)
    return cleaned.length > 0 && cleaned.length <= 5 ? cleaned : []
  }

  async generateHanxiaomiDraft(
    contactId: string,
    contactName: string,
    scenario: HanxiaomiScenario = 'maintenance'
  ): Promise<{ success: boolean; text?: string; action?: string; requestId?: string; eventKey?: string; error?: string }> {
    try {
      if (!this.isHanxiaomiChannelEnabled()) {
        return { success: false, error: '汉小密渠道未启用或配置不完整' }
      }
      if (!this.hanxiaomiContextProvider) {
        return { success: false, error: '汉小密上下文 provider 未配置' }
      }
      if (!contactId || contactId.includes('@chatroom')) {
        return { success: false, error: '汉小密渠道 V1 仅支持私聊联系人' }
      }
      const accountId = this.hanxiaomiContextProvider.getAccountId()
      const identitySalt = String(this.hanxiaomiConfig.identitySalt || '').trim()
      const request = await buildHanxiaomiReplyRequest({
        accountId,
        contactId,
        contactName: contactName || contactId,
        isFirstSuccessfulCall: !this.hanxiaomiLedger.hasSuccessfulContact(contactId),
        currentContent: `[人工触发草稿] 场景：${scenario}`,
        bufferedMessages: [{
          msgId: `manual:${contactId}:${Date.now()}`,
          content: `[人工触发草稿] 场景：${scenario}`,
          timestamp: Date.now(),
          type: 1
        }],
        mode: 'manual',
        scenario,
        identitySalt,
        provider: this.hanxiaomiContextProvider
      })
      const eventKey = buildHanxiaomiEventKey(contactId, request.current_message.message_key)
      const requestHash = hashHanxiaomiRequest(request)
      this.hanxiaomiLedger.upsert({
        eventKey,
        contactId,
        contactName: contactName || contactId,
        messageKey: request.current_message.message_key,
        requestHash,
        status: 'requested',
        scenario,
        mode: 'manual',
        updatedAt: Date.now()
      })
      const response = await this.hanxiaomiClient.createReply(request)
      const text = markdownToPlainText(response.text || '').trim()
      const segments = this.normalizeHanxiaomiReplySegments(response.segments)
      const action = response.action === 'send' ? 'draft' : response.action
      this.hanxiaomiLedger.mark(eventKey, {
        requestId: response.request_id,
        action: action as any,
        text,
        segments,
        status: action === 'skip' ? 'skipped' : 'draft'
      })
      return { success: true, text, action, requestId: response.request_id, eventKey }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  }

  async sendHanxiaomiDraft(
    eventKey: string
  ): Promise<{ success: boolean; sent?: boolean; error?: string }> {
    const entry = this.hanxiaomiLedger.get(eventKey)
    if (!entry) {
      return { success: false, error: '草稿不存在' }
    }
    if (!entry.text || entry.status !== 'draft') {
      return { success: false, error: '草稿状态不可发送' }
    }
    try {
      this.hanxiaomiOutboundQueue.enqueue({
        eventKey,
        contactId: entry.contactId,
        contactName: entry.contactName || entry.contactId,
        text: entry.text,
        segments: entry.segments && entry.segments.length > 0 ? entry.segments : undefined,
        action: 'send',
        generatedAt: Date.now(),
        triggerMessageTimestamp: Date.now(),
        receivedMessage: '[人工确认汉小密草稿]'
      })
      this.hanxiaomiLedger.mark(eventKey, { status: 'queued' })
      return { success: true, sent: false }
    } catch (error: any) {
      const message = error?.message || String(error)
      this.hanxiaomiLedger.mark(eventKey, { status: 'send_failed', error: message })
      return { success: false, sent: false, error: message }
    }
  }

  private connectSSE(): void {
    this.disconnectSSE()

    if (!this.sseUrl) {
      console.warn('[AIReplyService] SSE URL not configured, skipping connection')
      this.sseStatus = 'error'
      this.sseError = 'SSE URL 未配置'
      this.emit('sseStatusChanged', this.sseStatus)
      return
    }

    this.sseStatus = 'connecting'
    this.sseError = ''
    this.emit('sseStatusChanged', this.sseStatus)

    try {
      const url = new URL(this.sseUrl)
      if (this.accessToken) {
        url.searchParams.set('access_token', this.accessToken)
      }

      this.sseAbortController = new AbortController()
      const { signal } = this.sseAbortController

      const isHttps = url.protocol === 'https:'
      const requestModule = isHttps ? https : http

      const options: (http.RequestOptions | https.RequestOptions) = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        },
        signal
      }

      const req = requestModule.request(options, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`[AIReplyService] SSE connection returned status ${res.statusCode}`)
          this.sseStatus = 'error'
          this.sseError = `HTTP ${res.statusCode}`
          this.emit('sseStatusChanged', this.sseStatus)
          return
        }

        console.log(`[AIReplyService] SSE connected to ${url.toString()}`)
        this.sseStatus = 'connected'
        this.sseError = ''
        this.emit('sseStatusChanged', this.sseStatus)

        // P0-1 修复：SSE 重连成功后补拉断连期间漏掉的消息
        this.backfillMissedMessages()

        let buffer = ''
        let currentEvent = ''

        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => {
          if (signal.aborted) return
          buffer += chunk
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.replace(/\r$/, '')

            if (trimmed === '') {
              currentEvent = ''
              continue
            }

            if (trimmed.startsWith(':')) {
              continue
            }

            if (trimmed.startsWith('event:')) {
              currentEvent = trimmed.slice(6).trim()
              continue
            }

            if (trimmed.startsWith('data:')) {
              const dataStr = trimmed.slice(5).trim()
              if (currentEvent === 'message.new' || currentEvent === '' || currentEvent === 'message') {
                this.handleSSEData(dataStr)
              }
              currentEvent = ''
              continue
            }

            if (!currentEvent && trimmed.startsWith('{')) {
              this.handleSSEData(trimmed)
            }
          }
        })

        res.on('end', () => {
          if (!signal.aborted && this.status === 'running') {
            console.warn('[AIReplyService] SSE connection ended, reconnecting in 3s...')
            // P0-1 修复：记录断连时间，用于重连后补拉漏掉的消息
            if (this.sseDisconnectAt === null) {
              this.sseDisconnectAt = Date.now()
            }
            this.sseStatus = 'connecting'
            this.emit('sseStatusChanged', this.sseStatus)
            setTimeout(() => {
              if (this.status === 'running') this.connectSSE()
            }, 3000)
          } else {
            this.sseStatus = 'disconnected'
            this.emit('sseStatusChanged', this.sseStatus)
          }
        })

        res.on('error', (err: Error) => {
          console.warn('[AIReplyService] SSE stream error:', err.message)
          this.sseStatus = 'error'
          this.sseError = err.message
          this.emit('sseStatusChanged', this.sseStatus)
        })
      })

      req.on('error', (err: Error) => {
        if (!signal.aborted) {
          console.warn(`[AIReplyService] SSE request error: ${err.message}, reconnecting in 5s...`)
          // P0-1 修复：记录断连时间
          if (this.sseDisconnectAt === null) {
            this.sseDisconnectAt = Date.now()
          }
          this.sseStatus = 'error'
          this.sseError = err.message
          this.emit('sseStatusChanged', this.sseStatus)
          setTimeout(() => {
            if (this.status === 'running') this.connectSSE()
          }, 5000)
        }
      })

      req.end()
    } catch (error) {
      console.error('[AIReplyService] Failed to connect SSE:', error)
      this.sseStatus = 'error'
      this.sseError = error instanceof Error ? error.message : String(error)
      this.emit('sseStatusChanged', this.sseStatus)
      setTimeout(() => {
        if (this.status === 'running') this.connectSSE()
      }, 5000)
    }
  }

  private handleSSEData(dataStr: string): void {
    try {
      const data = JSON.parse(dataStr)
      const isGroup = data.sessionType === 'group' || String(data.sessionId || '').includes('@chatroom')
      const sessionId = data.sessionId || data.username || data.contactId || data.talker || ''
      const content = data.content || data.text || ''
      const groupName = String(data.groupName || data.groupDisplayName || '').trim()
      const contactName = isGroup
        ? (groupName || data.contactName || data.talkerName || data.nickname || sessionId)
        : (data.sourceName || data.nickname || data.contactName || data.talkerName || sessionId)

      // 自回复循环防护：检查是否是发给自己的消息
      if (!isGroup && this.selfWxid && sessionId === this.selfWxid) {
        console.log('[AIReplyService] Skipping self-message (私聊发给自己的消息)')
        return
      }

      // 自回复循环防护：检查是否是最近自己发送的消息
      const sentKey = `${sessionId}:${content}`
      const sentTime = this.recentSentMessages.get(sentKey)
      if (sentTime && Date.now() - sentTime < 10000) {
        console.log('[AIReplyService] Skipping self-sent message (最近发送的消息)')
        return
      }

      // 清理过期的发送记录（保留 30 秒内的记录）
      const now = Date.now()
      for (const [key, timestamp] of this.recentSentMessages.entries()) {
        if (now - timestamp > 30000) {
          this.recentSentMessages.delete(key)
        }
      }

      const message: WeChatMessage = {
        msgId: data.rawid || data.msgId || data.id || `msg_${Date.now()}`,
        contactId: sessionId,
        contactName,
        groupName: isGroup ? groupName || contactName : undefined,
        content,
        isGroup,
        isSend: Boolean(data.isSend ?? data.is_send ?? data.isMe ?? false),
        senderId: data.senderUsername || data.senderId || data.actualSender || '',
        senderName: data.sourceName || data.senderName || data.actualSenderName || '',
        timestamp: data.timestamp || data.createTime || Date.now(),
        type: data.type || 1
      }

      if (message.contactId && message.content) {
        this.handleIncomingMessage(message)
      }
    } catch (e) {
      console.warn('[AIReplyService] Failed to parse SSE message:', e)
    }
  }

  /**
   * P0-1 修复：SSE 重连后补拉断连期间漏掉的消息。
   * 若断连时间超过 3s 且配置了 backfillFetcher，则调用它获取漏掉的消息并逐条处理。
   * 通过 isBackfilling 标志防止并发补拉。
   */
  private async backfillMissedMessages(): Promise<void> {
    if (this.sseDisconnectAt === null) return
    if (this.isBackfilling) {
      console.log('[AIReplyService] 补拉正在进行中，跳过')
      return
    }
    if (!this.backfillFetcher) {
      // 未配置补拉回调，无法补拉，仅记录警告
      const gap = Date.now() - this.sseDisconnectAt
      if (gap > 5000) {
        console.warn(`[AIReplyService] SSE 断连 ${gap}ms，未配置 backfillFetcher，断连期间消息可能丢失`)
      }
      this.sseDisconnectAt = null
      return
    }

    const sinceTs = this.sseDisconnectAt
    this.sseDisconnectAt = null
    this.isBackfilling = true

    try {
      const gap = Date.now() - sinceTs
      console.log(`[AIReplyService] 开始补拉断连期间消息 (since ${new Date(sinceTs).toLocaleString()}, gap ${gap}ms)`)
      const missedMessages = await this.backfillFetcher(sinceTs)
      console.log(`[AIReplyService] 补拉到 ${missedMessages.length} 条漏掉的消息`)

      // 按时间排序，逐条处理（去重机制会自动过滤已处理的消息）
      missedMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      for (const msg of missedMessages) {
        this.handleIncomingMessage(msg)
      }

      if (missedMessages.length > 0) {
        this.emit('messageFlowUpdate', {
          contactId: '_system',
          contactName: '系统',
          stage: 'backfilled',
          detail: `补拉 ${missedMessages.length} 条断连期间消息`
        })
      }
    } catch (e) {
      console.error('[AIReplyService] 补拉失败:', e)
    } finally {
      this.isBackfilling = false
    }
  }

  private disconnectSSE(): void {
    if (this.sseAbortController) {
      this.sseAbortController.abort()
      this.sseAbortController = null
    }
    this.sseConnection = null
    if (this.sseStatus !== 'disconnected') {
      this.sseStatus = 'disconnected'
      this.emit('sseStatusChanged', this.sseStatus)
    }
  }

  async fetchAvailableModels(modelType: ModelType, baseUrl: string, apiKey?: string): Promise<ModelInfo[]> {
    const config: any = {
      id: `_fetch_${modelType}`,
      name: `_fetch_${modelType}`,
      type: modelType,
      enabled: true,
      config: modelType === 'ollama'
        ? { baseUrl: baseUrl.replace(/\/$/, ''), model: '', temperature: 0.7, maxTokens: 2048 }
        : modelType === 'custom'
          ? { url: baseUrl, method: 'POST', headers: {}, bodyTemplate: {}, responsePath: '' }
          : { apiKey: apiKey || '', baseUrl: baseUrl.replace(/\/$/, ''), model: '', temperature: 0.7, maxTokens: 2048 }
    }

    try {
      const adapter = createAdapter(config)
      const models = await adapter.fetchAvailableModels()
      return models.map(m => ({
        id: m.id,
        name: m.name,
        type: modelType,
        isLocal: m.isLocal
      }))
    } catch (e) {
      throw new Error(`获取模型列表失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async importSkillFromDirectory(sourceDir: string): Promise<Skill> {
    return this.skillEngine.importSkillFromDirectory(sourceDir)
  }

  async importSkillFromZip(zipPath: string): Promise<Skill> {
    return this.skillEngine.importSkillFromZip(zipPath)
  }

  async importSkillFromGit(repoUrl: string): Promise<Skill> {
    return this.skillEngine.importSkillFromGit(repoUrl)
  }

  async startDistill(params: {
    contactId: string
    config: DistillConfig
    modelId?: string
  }): Promise<string> {
    const targetModelId = params.modelId || this.activeModelId
    const adapter = this.modelAdapters.get(targetModelId)
    if (!adapter) {
      throw new Error('未配置模型，请先添加模型')
    }

    if (this.sseUrl) {
      this.distillService.setWeFlowConfig(this.sseUrl.replace('/api/v1/push/messages', ''), this.accessToken)
    }

    return this.distillService.distillFromChatRecords(
      params.contactId,
      params.config,
      adapter
    )
  }

  startDistillAsync(params: {
    contactId: string
    config: DistillConfig
    modelId?: string
  }): string {
    const targetModelId = params.modelId || this.activeModelId
    const adapter = this.modelAdapters.get(targetModelId)
    if (!adapter) {
      throw new Error('未配置模型，请先添加模型')
    }

    if (this.sseUrl) {
      this.distillService.setWeFlowConfig(this.sseUrl.replace('/api/v1/push/messages', ''), this.accessToken)
    }

    const taskId = this.distillService.createTask(params.contactId, params.config)

    this.distillService.distillFromChatRecordsAsync(
      params.contactId,
      params.config,
      adapter,
      taskId
    ).catch((err) => {
      console.error('[AIReplyService] Distill async error:', err)
    })

    return taskId
  }

  cancelDistill(taskId: string): void {
    this.distillService.cancelTask(taskId)
  }

  getDistillProgress(taskId: string): DistillProgress | null {
    return this.distillService.getProgress(taskId)
  }

  getDistillResult(taskId: string): Skill | null {
    return this.distillService.getResult(taskId)
  }

  async saveDistillSkill(taskId: string, override?: Partial<Skill>): Promise<Skill> {
    const skill = this.distillService.getResult(taskId)
    if (!skill) throw new Error(`No result found for task: ${taskId}`)

    const finalSkill = override ? { ...skill, ...override } : skill
    // 修复：使用 getter 访问 skillsDir，避免反射穿透私有字段
    const outputDir = `${this.skillEngine.getSkillsDir()}/${finalSkill.id}`
    const saved = await this.distillService.saveSkill(taskId, outputDir, override)
    this.skillEngine.addSkill(saved)
    return saved
  }

  async fetchChatRecords(contactId: string, limit: number, startDate?: string, endDate?: string): Promise<ChatRecord[]> {
    return this.distillService.fetchChatRecords(contactId, limit, startDate, endDate)
  }

  getWeFlowAPIConfig(): { baseUrl: string; accessToken: string } {
    return {
      baseUrl: this.sseUrl.replace('/api/v1/push/messages', ''),
      accessToken: this.accessToken
    }
  }

  async searchContacts(keyword: string, limit: number = 20): Promise<any[]> {
    const { baseUrl, accessToken } = this.getWeFlowAPIConfig()
    const params = new URLSearchParams({ keyword, limit: String(limit) })
    const url = `${baseUrl}/api/v1/contacts?${params.toString()}`

    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      })
      if (!res.ok) return []
      const data: any = await res.json()
      return data.contacts || data.data || []
    } catch {
      return []
    }
  }
}
