import { create } from 'zustand'
import type { ServiceStatus, ModelConfig, Skill, TriggerRules, ReplyLog, DailyStats, ContactSkillMapping, ModelInfo, DistillProgress, ModelType, AIReplySenderConfig, SenderHealth, SenderId } from '../types/ai-reply'
import { DEFAULT_AI_REPLY_SENDER_CONFIG, DEFAULT_TRIGGER_RULES } from '../types/ai-reply'

const api = () => (window.electronAPI?.aiReply as any)

type PrerequisiteCheck = { name: string; passed: boolean; message: string; configKey?: string }
type PrerequisiteResult = { allPassed: boolean; checks: PrerequisiteCheck[] }
type HanxiaomiChannelConfig = {
  enabled: boolean
  serviceUrl: string
  keyId: string
  signingSecret: string
  timeoutMs: number
  identitySalt?: string
  inboundConcurrency?: number
  deliveryPolicy?: {
    minDelayMs?: number
    maxDelayMs?: number
    postSendGapMsMin?: number
    postSendGapMsMax?: number
    perContactCooldownMs?: number
    staleAfterMs?: number
    splitMinGapMs?: number
    splitMaxGapMs?: number
  }
}

export interface AIReplyState {
  status: ServiceStatus
  models: ModelConfig[]
  activeModelId: string
  skills: Skill[]
  activeSkillId: string
  triggerRules: TriggerRules
  replyLogs: ReplyLog[]
  replyLogsTotal: number
  dailyStats: DailyStats
  contactSkillMappings: ContactSkillMapping[]
  testResult: { success: boolean; message: string; latencyMs?: number } | null
  testReplyResult: string | null
  testReplyLatencyMs: number | undefined
  isLoading: boolean
  error: string | null
  availableModels: ModelInfo[]
  fetchModelsLoading: boolean
  distillProgress: DistillProgress | null
  distillResult: Skill | null
  logFilter: { status: string; contactId: string; keyword: string }
  editingSkill: Skill | null
  selectedLogDetail: ReplyLog | null
  autoReplyEnabled: boolean
  sseStatus: 'disconnected' | 'connecting' | 'connected' | 'error'
  sseError: string
  prerequisiteChecks: PrerequisiteCheck[] | null
  prerequisitesAllPassed: boolean | null
  processingContacts: { contactId: string; contactName: string; stage: string; startedAt: number }[]
  messageFlow: { contactId: string; contactName: string; stage: string; detail: string; timestamp: number }[]
  senderConfig: AIReplySenderConfig
  senderHealth: SenderHealth | null
  senderHealthLoading: boolean
  hanxiaomiChannelConfig: HanxiaomiChannelConfig
  hanxiaomiTestResult: { success: boolean; message: string; latencyMs?: number } | null
  hanxiaomiDraft: { text: string; action?: string; requestId?: string; eventKey?: string } | null

  start: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  fetchStatus: () => Promise<void>
  fetchModels: () => Promise<void>
  addModel: (config: ModelConfig) => Promise<void>
  removeModel: (modelId: string) => Promise<void>
  setActiveModel: (modelId: string) => Promise<void>
  testModel: (modelId: string) => Promise<void>
  fetchSkills: () => Promise<void>
  addSkill: (skill: Skill) => Promise<void>
  removeSkill: (skillId: string) => Promise<void>
  setActiveSkill: (skillId: string) => Promise<void>
  reloadSkills: () => Promise<void>
  generateTestReply: (skillId: string, modelId: string, testMessage: string) => Promise<void>
  setTriggerRules: (rules: TriggerRules) => Promise<void>
  fetchTriggerRules: () => Promise<void>
  setContactSkillMapping: (contactId: string, skillId: string) => Promise<void>
  removeContactSkillMapping: (contactId: string) => Promise<void>
  fetchContactSkillMappings: () => Promise<void>
  fetchReplyLogs: (limit?: number, offset?: number) => Promise<void>
  fetchReplyLogsCount: () => Promise<void>
  clearReplyLogs: () => Promise<void>
  deleteReplyLogs: (ids: string[]) => Promise<void>
  fetchDailyStats: () => Promise<void>
  clearContext: (contactId: string) => Promise<void>
  setupListeners: () => () => void
  fetchAvailableModels: (type: ModelType, baseUrl: string, apiKey?: string) => Promise<void>
  importSkillFromDirectory: (dir: string) => Promise<Skill | null>
  importSkillFromZip: (path: string) => Promise<Skill | null>
  importSkillFromGit: (url: string) => Promise<Skill | null>
  startDistill: (params: any) => Promise<string | { error: string }>
  cancelDistill: (taskId: string) => Promise<void>
  getDistillProgress: (taskId: string) => Promise<DistillProgress | null>
  saveDistillSkill: (taskId: string, override?: any) => Promise<Skill | null>
  searchContacts: (keyword: string) => Promise<any[]>
  setLogFilter: (filter: Partial<{ status: string; contactId: string; keyword: string }>) => void
  setEditingSkill: (skill: Skill | null) => void
  setSelectedLogDetail: (log: ReplyLog | null) => void
  setAutoReplyEnabled: (enabled: boolean) => Promise<void>
  fetchAutoReplyEnabled: () => Promise<void>
  fetchSSEStatus: () => Promise<void>
  checkPrerequisites: () => Promise<PrerequisiteResult | null>
  fetchSenderConfig: () => Promise<void>
  setSenderConfig: (config: Partial<AIReplySenderConfig>) => Promise<void>
  fetchSenderHealth: (senderId?: SenderId) => Promise<void>
  fetchHanxiaomiChannelConfig: () => Promise<void>
  setHanxiaomiChannelConfig: (config: Partial<HanxiaomiChannelConfig>) => Promise<void>
  testHanxiaomiChannel: () => Promise<void>
  generateHanxiaomiDraft: (payload: { contactId: string; contactName?: string; scenario?: string }) => Promise<void>
  sendHanxiaomiDraft: (eventKey: string) => Promise<void>
  clearTestReply: () => void
  clearError: () => void
  setError: (error: string) => void
}

export const useAIReplyStore = create<AIReplyState>((set, get): AIReplyState => ({
  status: 'stopped',
  models: [],
  activeModelId: '',
  skills: [],
  activeSkillId: 'default-assistant',
  triggerRules: DEFAULT_TRIGGER_RULES,
  replyLogs: [],
  replyLogsTotal: 0,
  dailyStats: { receivedCount: 0, repliedCount: 0, activeContacts: 0, errorCount: 0 },
  contactSkillMappings: [],
  testResult: null,
  testReplyResult: null,
  testReplyLatencyMs: undefined,
  isLoading: false,
  error: null,
  availableModels: [],
  fetchModelsLoading: false,
  distillProgress: null,
  distillResult: null,
  logFilter: { status: '', contactId: '', keyword: '' },
  editingSkill: null,
  selectedLogDetail: null,
  autoReplyEnabled: true,
  sseStatus: 'disconnected',
  sseError: '',
  prerequisiteChecks: null,
  prerequisitesAllPassed: null,
  processingContacts: [],
  messageFlow: [],
  senderConfig: DEFAULT_AI_REPLY_SENDER_CONFIG,
  senderHealth: null,
  senderHealthLoading: false,
  hanxiaomiChannelConfig: {
    enabled: false,
    serviceUrl: '',
    keyId: '',
    signingSecret: '',
    timeoutMs: 120000,
    identitySalt: '',
    inboundConcurrency: 3,
    deliveryPolicy: {
      minDelayMs: 8000,
      maxDelayMs: 45000,
      postSendGapMsMin: 8000,
      postSendGapMsMax: 25000,
      perContactCooldownMs: 60000,
      staleAfterMs: 180000,
      splitMinGapMs: 2500,
      splitMaxGapMs: 8000
    }
  },
  hanxiaomiTestResult: null,
  hanxiaomiDraft: null,

  start: async () => {
    set({ isLoading: true, error: null })
    try {
      const result = await api()?.start()
      if (result?.checks) {
        set({
          prerequisiteChecks: result.checks,
          prerequisitesAllPassed: result.checks.every((check: PrerequisiteCheck) => check.passed)
        })
      }
      if (!result?.success) throw new Error(result?.error || '启动失败')
      set({ status: 'running', isLoading: false })
    } catch (e: any) {
      set({ error: e.message, isLoading: false })
      throw e
    }
  },

  pause: async () => {
    await api()?.pause()
    set({ status: 'paused' })
  },

  resume: async () => {
    await api()?.resume()
    set({ status: 'running' })
  },

  stop: async () => {
    await api()?.stop()
    set({ status: 'stopped' })
  },

  fetchStatus: async () => {
    const status = await api()?.getStatus()
    if (status) set({ status: status as ServiceStatus })
  },

  fetchModels: async () => {
    const models = (await api()?.getModels() || []) as ModelConfig[]
    const activeModelId = await api()?.getActiveModelId() || ''
    set({ models, activeModelId: activeModelId || get().activeModelId })
  },

  addModel: async (config) => {
    set({ isLoading: true, error: null })
    try {
      const result = await api()?.addModel(config)
      if (result && !result.success) {
        throw new Error(result.error || '添加模型失败')
      }
      await get().fetchModels()
    } catch (e: any) {
      set({ error: e.message || '添加模型失败', isLoading: false })
      throw e
    } finally {
      set({ isLoading: false })
    }
  },

  removeModel: async (modelId) => {
    await api()?.removeModel(modelId)
    await get().fetchModels()
  },

  setActiveModel: async (modelId) => {
    await api()?.setActiveModel(modelId)
    set({ activeModelId: modelId })
  },

  testModel: async (modelId) => {
    set({ testResult: null })
    const result = await api()?.testModel(modelId)
    set({ testResult: result || null })
  },

  fetchSkills: async () => {
    const skills = (await api()?.getSkills() || []) as Skill[]
    set({ skills })
  },

  addSkill: async (skill) => {
    await api()?.addSkill(skill)
    await get().fetchSkills()
  },

  removeSkill: async (skillId) => {
    await api()?.removeSkill(skillId)
    await get().fetchSkills()
  },

  setActiveSkill: async (skillId) => {
    await api()?.setActiveSkill(skillId)
    set({ activeSkillId: skillId })
  },

  reloadSkills: async () => {
    const skills = (await api()?.reloadSkills() || []) as Skill[]
    set({ skills })
  },

  generateTestReply: async (skillId, modelId, testMessage) => {
    set({ testReplyResult: null, testReplyLatencyMs: undefined, isLoading: true })
    const result = await api()?.generateTestReply(skillId, modelId, testMessage)
    set({ testReplyResult: (result as any)?.content || result as string || '', testReplyLatencyMs: (result as any)?.latencyMs, isLoading: false })
  },

  setTriggerRules: async (rules) => {
    await api()?.setTriggerRules(rules)
    set({ triggerRules: rules })
  },

  fetchTriggerRules: async () => {
    const rules = await api()?.getTriggerRules()
    if (rules && Object.keys(rules).length > 0) set({ triggerRules: rules as unknown as TriggerRules })
  },

  setContactSkillMapping: async (contactId, skillId) => {
    await api()?.setContactSkillMapping(contactId, skillId)
    await get().fetchContactSkillMappings()
  },

  removeContactSkillMapping: async (contactId) => {
    await api()?.removeContactSkillMapping(contactId)
    await get().fetchContactSkillMappings()
  },

  fetchContactSkillMappings: async () => {
    const mappings = (await api()?.getContactSkillMappings() || []) as ContactSkillMapping[]
    set({ contactSkillMappings: mappings })
  },

  fetchReplyLogs: async (limit, offset) => {
    const logs = (await api()?.getReplyLogs(limit, offset) || []) as ReplyLog[]
    set({ replyLogs: logs })
  },

  fetchReplyLogsCount: async () => {
    const total = await api()?.getReplyLogsCount() || 0
    set({ replyLogsTotal: total })
  },

  clearReplyLogs: async () => {
    await api()?.clearReplyLogs()
    set({ replyLogs: [], replyLogsTotal: 0 })
  },

  deleteReplyLogs: async (ids) => {
    await api()?.deleteReplyLogs(ids)
    const total = await api()?.getReplyLogsCount() || 0
    set({ replyLogsTotal: total })
  },

  fetchDailyStats: async () => {
    const stats = await api()?.getDailyStats()
    if (stats) set({ dailyStats: stats as DailyStats })
  },

  clearContext: async (contactId) => {
    await api()?.clearContext(contactId)
  },

  setupListeners: (): (() => void) => {
    if ((useAIReplyStore as any)._listenersSetup) {
      return (useAIReplyStore as any)._listenersCleanup || (() => {})
    }

    const listeners: (() => void)[] = []

    const unsub1 = api()?.onStatusChanged((status: any) => {
      set({ status: status as ServiceStatus })
    })
    if (unsub1) listeners.push(unsub1)

    const unsub2 = api()?.onReplySent((log: any) => {
      set((state) => ({
        replyLogs: [...state.replyLogs.slice(-99), log as ReplyLog],
        replyLogsTotal: state.replyLogsTotal + 1
      }))
    })
    if (unsub2) listeners.push(unsub2)

    const unsub3 = api()?.onReplyError(() => {
      get().fetchDailyStats()
    })
    if (unsub3) listeners.push(unsub3)

    const unsub4 = api()?.onSSEStatusChanged?.((status: any) => {
      if (typeof status === 'string') {
        set({ sseStatus: status as 'disconnected' | 'connecting' | 'connected' | 'error' })
      } else if (status && typeof status === 'object') {
        set({
          sseStatus: (status.status || status) as 'disconnected' | 'connecting' | 'connected' | 'error',
          sseError: status.error || ''
        })
      }
    })
    if (unsub4) listeners.push(unsub4)

    const unsub5 = api()?.onProcessingStarted?.((info: any) => {
      set((state) => {
        const existing = state.processingContacts.filter(p => p.contactId !== info.contactId)
        return {
          processingContacts: [...existing, {
            contactId: info.contactId,
            contactName: info.contactName,
            stage: info.stage,
            startedAt: Date.now()
          }]
        }
      })
    })
    if (unsub5) listeners.push(unsub5)

    const unsub6 = api()?.onProcessingCompleted?.((info: any) => {
      set((state) => ({
        processingContacts: state.processingContacts.filter(p => p.contactId !== info.contactId)
      }))
    })
    if (unsub6) listeners.push(unsub6)

    const unsub7 = api()?.onMessageFlowUpdate?.((info: any) => {
      set((state) => {
        const entry = {
          contactId: info.contactId,
          contactName: info.contactName,
          stage: info.stage,
          detail: info.detail || '',
          timestamp: Date.now()
        }
        const flow = [entry, ...state.messageFlow].slice(0, 50)
        return { messageFlow: flow }
      })
    })
    if (unsub7) listeners.push(unsub7)

    const staleTimer = setInterval(() => {
      set((state) => {
        const now = Date.now()
        const active = state.processingContacts.filter(p => now - p.startedAt < 120000)
        if (active.length !== state.processingContacts.length) {
          return { processingContacts: active }
        }
        return state
      })
    }, 10000)

    const cleanup = () => {
      listeners.forEach(fn => fn())
      clearInterval(staleTimer)
      ;(useAIReplyStore as any)._listenersSetup = false
      ;(useAIReplyStore as any)._listenersCleanup = null
    }

    ;(useAIReplyStore as any)._listenersSetup = true
    ;(useAIReplyStore as any)._listenersCleanup = cleanup

    return cleanup
  },

  fetchAvailableModels: async (type, baseUrl, apiKey) => {
    set({ fetchModelsLoading: true })
    try {
      const models = await api()?.fetchAvailableModels(type, baseUrl, apiKey) || []
      set({ availableModels: models as ModelInfo[], fetchModelsLoading: false })
    } catch {
      set({ availableModels: [], fetchModelsLoading: false })
    }
  },

  importSkillFromDirectory: async (dir) => {
    try {
      const skill = await api()?.importSkillFromDirectory(dir)
      if (skill) {
        await get().fetchSkills()
        return skill as Skill
      }
    } catch {}
    return null
  },

  importSkillFromZip: async (path) => {
    try {
      const skill = await api()?.importSkillFromZip(path)
      if (skill) {
        await get().fetchSkills()
        return skill as Skill
      }
    } catch {}
    return null
  },

  importSkillFromGit: async (url) => {
    try {
      const skill = await api()?.importSkillFromGit(url)
      if (skill) {
        await get().fetchSkills()
        return skill as Skill
      }
    } catch {}
    return null
  },

  startDistill: async (params) => {
    const taskId = await api()?.startDistill(params) || ''
    return taskId
  },

  cancelDistill: async (taskId) => {
    await api()?.cancelDistill(taskId)
  },

  getDistillProgress: async (taskId) => {
    try {
      const progress = await api()?.getDistillProgress(taskId)
      if (progress) {
        set({ distillProgress: progress as DistillProgress })
        return progress as DistillProgress
      }
    } catch {}
    return null
  },

  saveDistillSkill: async (taskId, override) => {
    try {
      const skill = await api()?.saveDistillSkill(taskId, override)
      if (skill) {
        await get().fetchSkills()
        set({ distillResult: skill as Skill })
        return skill as Skill
      }
    } catch {}
    return null
  },

  searchContacts: async (keyword) => {
    try {
      const contacts = await api()?.searchContacts(keyword) || []
      return contacts
    } catch {
      return []
    }
  },

  setLogFilter: (filter) => {
    set((state) => ({
      logFilter: { ...state.logFilter, ...filter }
    }))
  },

  setEditingSkill: (skill) => {
    set({ editingSkill: skill })
  },

  setSelectedLogDetail: (log) => {
    set({ selectedLogDetail: log })
  },

  setAutoReplyEnabled: async (enabled) => {
    await api()?.setAutoReply(enabled)
    set({ autoReplyEnabled: enabled })
  },

  fetchAutoReplyEnabled: async () => {
    const enabled = await api()?.getAutoReply()
    if (typeof enabled === 'boolean') set({ autoReplyEnabled: enabled })
  },

  fetchSSEStatus: async () => {
    try {
      const result = await api()?.getSSEStatus?.()
      if (result) {
        set({
          sseStatus: (result.status || 'disconnected') as 'disconnected' | 'connecting' | 'connected' | 'error',
          sseError: result.error || ''
        })
      }
    } catch {}
  },

  checkPrerequisites: async () => {
    try {
      const result = await api()?.checkPrerequisites?.()
      if (result) {
        const normalized = result as PrerequisiteResult
        set({
          prerequisiteChecks: normalized.checks,
          prerequisitesAllPassed: normalized.allPassed
        })
        return normalized
      }
    } catch {}
    return null
  },

  fetchSenderConfig: async () => {
    const config = await api()?.getSenderConfig?.()
    if (config) {
      set({ senderConfig: config as AIReplySenderConfig })
      await get().fetchSenderHealth((config as AIReplySenderConfig).activeSenderId)
    }
  },

  setSenderConfig: async (config) => {
    const current = get().senderConfig
    const next: AIReplySenderConfig = {
      ...current,
      ...config,
      uiAutomation: {
        ...current.uiAutomation,
        ...config.uiAutomation
      },
      weclawHttp: {
        ...current.weclawHttp,
        ...config.weclawHttp
      },
      wechatferry: {
        ...current.wechatferry,
        ...config.wechatferry
      }
    }
    const result = await api()?.setSenderConfig?.(next)
    const saved = (result?.config || next) as AIReplySenderConfig
    set({ senderConfig: saved })
    await get().fetchSenderHealth(saved.activeSenderId)
    await get().checkPrerequisites()
  },

  fetchSenderHealth: async (senderId) => {
    set({ senderHealthLoading: true })
    try {
      const health = await api()?.getSenderHealth?.(senderId)
      set({ senderHealth: health || null, senderHealthLoading: false })
    } catch {
      set({ senderHealth: null, senderHealthLoading: false })
    }
  },

  fetchHanxiaomiChannelConfig: async () => {
    const config = await api()?.getHanxiaomiChannelConfig?.()
    if (config) {
      set({ hanxiaomiChannelConfig: config as HanxiaomiChannelConfig })
    }
  },

  setHanxiaomiChannelConfig: async (config) => {
    const current = get().hanxiaomiChannelConfig
    const result = await api()?.setHanxiaomiChannelConfig?.({
      ...current,
      ...config
    })
    if (result?.success && result.config) {
      set({ hanxiaomiChannelConfig: result.config as HanxiaomiChannelConfig })
    }
    await get().checkPrerequisites()
  },

  testHanxiaomiChannel: async () => {
    set({ hanxiaomiTestResult: null })
    const result = await api()?.testHanxiaomiChannel?.()
    set({ hanxiaomiTestResult: result || null })
  },

  generateHanxiaomiDraft: async (payload) => {
    set({ isLoading: true, error: null, hanxiaomiDraft: null })
    try {
      const result = await api()?.generateHanxiaomiDraft?.(payload)
      if (!result?.success) throw new Error(result?.error || '生成汉小密草稿失败')
      set({
        isLoading: false,
        hanxiaomiDraft: {
          text: result.text || '',
          action: result.action,
          requestId: result.requestId,
          eventKey: result.eventKey
        }
      })
    } catch (e: any) {
      set({ isLoading: false, error: e.message || '生成汉小密草稿失败' })
      throw e
    }
  },

  sendHanxiaomiDraft: async (eventKey) => {
    const result = await api()?.sendHanxiaomiDraft?.(eventKey)
    if (!result?.success) {
      throw new Error(result?.error || '发送汉小密草稿失败')
    }
    set({ hanxiaomiDraft: null })
    await get().fetchReplyLogs()
    await get().fetchDailyStats()
  },

  clearTestReply: () => {
    set({ testReplyResult: null, testReplyLatencyMs: undefined })
  },

  clearError: () => {
    set({ error: null })
  },
  setError: (error: string) => {
    set({ error })
  }
}))
