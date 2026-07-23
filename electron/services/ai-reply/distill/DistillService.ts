import { EventEmitter } from 'events'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { Skill, ChatRecord, DistillConfig, DistillProgress, PersonaV2, VerificationResult, SkillQualityScore } from '../../../../src/types/ai-reply'
import { DEFAULT_REPLY_STRATEGY } from '../../../../src/types/ai-reply'
import { DISTILL_PROMPTS_V1, DISTILL_PROMPTS_V2 } from './prompts'
import { preprocessChatRecords, type PreprocessedRecords } from './preprocessor'
import type { BaseAdapter } from '../adapters'

export type ChatRecordFetcher = (contactId: string, limit: number) => Promise<ChatRecord[]>

export class DistillService extends EventEmitter {
  private tasks: Map<string, DistillProgress> = new Map()
  private results: Map<string, Skill> = new Map()
  private activeAdapter: BaseAdapter | null = null
  private weflowBaseUrl: string = ''
  private weflowAccessToken: string = ''
  private chatRecordFetcher: ChatRecordFetcher | null = null

  setAdapter(adapter: BaseAdapter): void {
    this.activeAdapter = adapter
  }

  setWeFlowConfig(baseUrl: string, accessToken: string): void {
    this.weflowBaseUrl = baseUrl
    this.weflowAccessToken = accessToken
  }

  setChatRecordFetcher(fetcher: ChatRecordFetcher): void {
    this.chatRecordFetcher = fetcher
  }

  async distillFromChatRecords(
    contactId: string,
    config: DistillConfig,
    adapter: BaseAdapter
  ): Promise<string> {
    const taskId = this.createTask(contactId, config)
    await this.runDistill(contactId, config, adapter, this.tasks.get(taskId)!)
    return taskId
  }

  createTask(contactId: string, config: DistillConfig): string {
    const taskId = `distill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const useV2 = config.schemaVersion !== 'v1'
    const enableVerification = config.enableTripleVerification !== false && useV2

    const totalRounds = useV2
      ? (enableVerification ? 8 : 6)
      : 6

    const roundNames = useV2
      ? (enableVerification
          ? ['layer0_hardRules', 'layer1_identity', 'layer2_expressionStyle', 'layer3_decisionJudgment', 'layer4_interpersonalBehavior', 'tripleVerification', 'skillSynthesis', 'validation']
          : ['layer0_hardRules', 'layer1_identity', 'layer2_expressionStyle', 'layer3_decisionJudgment', 'layer4_interpersonalBehavior', 'validation'])
      : ['expressionDNA', 'mentalModels', 'decisionHeuristics', 'valuesAndAntiPatterns', 'honestyBoundaries', 'validation']

    const progress: DistillProgress = {
      taskId,
      status: 'preparing',
      currentRound: 0,
      totalRounds,
      roundResults: roundNames.map((name, i) => ({ round: i + 1, name, status: 'pending' as const })),
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    }
    this.tasks.set(taskId, progress)
    this.emit('progress', progress)
    return taskId
  }

  async distillFromChatRecordsAsync(
    contactId: string,
    config: DistillConfig,
    adapter: BaseAdapter,
    taskId: string
  ): Promise<string> {
    const progress = this.tasks.get(taskId)
    if (!progress) throw new Error(`Task not found: ${taskId}`)
    await this.runDistill(contactId, config, adapter, progress)
    return taskId
  }

  private async runDistill(
    contactId: string,
    config: DistillConfig,
    adapter: BaseAdapter,
    progress: DistillProgress
  ): Promise<void> {
    try {
      const rawRecords = await this.fetchChatRecords(contactId, config.messageLimit || 5000)
      if (!rawRecords || rawRecords.length === 0) {
        throw new Error('未获取到聊天记录，请确认该联系人是否有聊天记录且数据源已正确配置')
      }

      const preprocessed = this.preprocessMessages(rawRecords)
      if (preprocessed.totalCount === 0) {
        throw new Error('聊天记录预处理后无有效文本消息，无法进行蒸馏')
      }

      progress.status = 'distilling'
      this.emit('progress', progress)

      const chatText = this.formatChatForPrompt(preprocessed)
      const useV2 = config.schemaVersion !== 'v1'

      if (useV2) {
        await this.runDistillV2(chatText, preprocessed, config, adapter, progress)
      } else {
        await this.runDistillV1(chatText, config, adapter, progress)
      }

      const finalStatus: string = progress.status
      if (finalStatus !== 'cancelled') {
        progress.status = 'completed'
        this.emit('progress', progress)
      }
    } catch (error) {
      progress.status = 'error'
      progress.error = error instanceof Error ? error.message : String(error)
      this.emit('progress', progress)
    }
  }

  private async runDistillV2(
    chatText: string,
    preprocessed: PreprocessedRecords,
    config: DistillConfig,
    adapter: BaseAdapter,
    progress: DistillProgress
  ): Promise<void> {
    const enableVerification = config.enableTripleVerification !== false
    const layerKeys = ['layer0_hardRules', 'layer1_identity', 'layer2_expressionStyle', 'layer3_decisionJudgment', 'layer4_interpersonalBehavior']
    const roundResults: Record<string, any> = {}

    for (let i = 0; i < layerKeys.length; i++) {
      const currentStatus: string = progress.status
      if (currentStatus === 'cancelled') break

      const key = layerKeys[i]
      const roundIdx = i
      progress.currentRound = roundIdx + 1
      progress.roundResults[roundIdx].status = 'running'
      this.emit('progress', progress)

      const roundStart = Date.now()
      try {
        const promptTemplate = (DISTILL_PROMPTS_V2 as any)[key]
        if (!promptTemplate || typeof promptTemplate !== 'string') {
          progress.roundResults[roundIdx].status = 'error'
          progress.roundResults[roundIdx].durationMs = Date.now() - roundStart
          roundResults[key] = null
          this.emit('progress', progress)
          continue
        }
        const prompt = promptTemplate.replace('{chatRecords}', chatText)
        const result = await this.runDistillRound(adapter, prompt, progress)
        roundResults[key] = result
        progress.roundResults[roundIdx].status = 'completed'
        progress.roundResults[roundIdx].durationMs = Date.now() - roundStart
      } catch (e) {
        progress.roundResults[roundIdx].status = 'error'
        progress.roundResults[roundIdx].durationMs = Date.now() - roundStart
        roundResults[key] = null
      }
      this.emit('progress', progress)
    }

    if (enableVerification) {
      const candidates = this.collectCandidateFeatures(roundResults)
      if (candidates.length === 0) {
        progress.roundResults[5].status = 'error'
        progress.roundResults[5].durationMs = 0
        progress.roundResults[6].status = 'error'
        progress.roundResults[6].durationMs = 0
      } else {
        const chatSample = chatText.slice(0, 3000)

      const verifyIdx = 5
      progress.currentRound = verifyIdx + 1
      progress.roundResults[verifyIdx].status = 'running'
      this.emit('progress', progress)

      const verifyStart = Date.now()
      try {
        const verifyPrompt = DISTILL_PROMPTS_V2.tripleVerification
          .replace('{candidateFeatures}', JSON.stringify(candidates, null, 2))
          .replace('{chatRecordsSample}', chatSample)
        const verifyResult = await this.runDistillRound(adapter, verifyPrompt, progress)
        progress.verificationResults = Array.isArray(verifyResult) ? verifyResult : []
        progress.roundResults[verifyIdx].status = 'completed'
        progress.roundResults[verifyIdx].durationMs = Date.now() - verifyStart
      } catch (e) {
        progress.roundResults[verifyIdx].status = 'error'
        progress.roundResults[verifyIdx].durationMs = Date.now() - verifyStart
      }
      this.emit('progress', progress)

      const synthIdx = 6
      progress.currentRound = synthIdx + 1
      progress.roundResults[synthIdx].status = 'running'
      this.emit('progress', progress)

      const synthStart = Date.now()
      try {
        const personaLayers = JSON.stringify(roundResults, null, 2)
        const verificationSummary = (progress.verificationResults || [])
          .map((v: any) => {
            const feature = v?.feature || v?.name || String(v)
            const verdict = v?.finalVerdict || 'unknown'
            return `${feature}: ${verdict}`
          })
          .join('\n')
        const synthPrompt = DISTILL_PROMPTS_V2.skillSynthesis
          .replace('{personaLayers}', personaLayers)
          .replace('{verificationSummary}', verificationSummary)
        const synthResult = await this.runDistillRound(adapter, synthPrompt, progress)
        roundResults.skillSynthesis = synthResult
        progress.roundResults[synthIdx].status = 'completed'
        progress.roundResults[synthIdx].durationMs = Date.now() - synthStart
      } catch (e) {
        progress.roundResults[synthIdx].status = 'error'
        progress.roundResults[synthIdx].durationMs = Date.now() - synthStart
      }
      this.emit('progress', progress)

      const validIdx = 7
      progress.currentRound = validIdx + 1
      progress.status = 'validating'
      progress.roundResults[validIdx].status = 'running'
      this.emit('progress', progress)

      const validStart = Date.now()
      try {
        const summary = JSON.stringify(roundResults, null, 2)
        const sample = chatText.slice(0, 3000)
        const validPrompt = DISTILL_PROMPTS_V2.validation
          .replace('{skillSummary}', summary)
          .replace('{chatRecordsSample}', sample)
        const validResult = await this.runDistillRound(adapter, validPrompt, progress)
        roundResults.validation = validResult
        progress.roundResults[validIdx].status = 'completed'
        progress.roundResults[validIdx].durationMs = Date.now() - validStart
      } catch (e) {
        progress.roundResults[validIdx].status = 'error'
        progress.roundResults[validIdx].durationMs = Date.now() - validStart
      }
      this.emit('progress', progress)
      }
    } else {
      const validIdx = 5
      progress.currentRound = validIdx + 1
      progress.status = 'validating'
      progress.roundResults[validIdx].status = 'running'
      this.emit('progress', progress)

      const validStart = Date.now()
      try {
        const summary = JSON.stringify(roundResults, null, 2)
        const sample = chatText.slice(0, 3000)
        const validPrompt = DISTILL_PROMPTS_V2.validation
          .replace('{skillSummary}', summary)
          .replace('{chatRecordsSample}', sample)
        const validResult = await this.runDistillRound(adapter, validPrompt, progress)
        roundResults.validation = validResult
        progress.roundResults[validIdx].status = 'completed'
        progress.roundResults[validIdx].durationMs = Date.now() - validStart
      } catch (e) {
        progress.roundResults[validIdx].status = 'error'
        progress.roundResults[validIdx].durationMs = Date.now() - validStart
      }
      this.emit('progress', progress)
    }

    const skill = this.generateSkillFilesV2(roundResults, config)
    if (progress.verificationResults) {
      skill.qualityScore = this.calculateQualityScore(progress.verificationResults, roundResults.validation)
    }
    this.results.set(progress.taskId, skill)
  }

  private async runDistillV1(
    chatText: string,
    config: DistillConfig,
    adapter: BaseAdapter,
    progress: DistillProgress
  ): Promise<void> {
    const roundResults: Record<string, any> = {}
    const rounds: Array<{ key: string; name: string }> = [
      { key: 'expressionDNA', name: 'expressionDNA' },
      { key: 'mentalModels', name: 'mentalModels' },
      { key: 'decisionHeuristics', name: 'decisionHeuristics' },
      { key: 'valuesAndAntiPatterns', name: 'valuesAndAntiPatterns' },
      { key: 'honestyBoundaries', name: 'honestyBoundaries' },
      { key: 'validation', name: 'validation' }
    ]

    for (let i = 0; i < rounds.length; i++) {
      const currentStatus: string = progress.status
      if (currentStatus === 'cancelled') break

      const round = rounds[i]
      const roundStart = Date.now()
      progress.currentRound = i + 1
      progress.roundResults[i].status = 'running'
      this.emit('progress', progress)

      try {
        let promptTemplate = (DISTILL_PROMPTS_V1 as any)[round.key]
        if (!promptTemplate || typeof promptTemplate !== 'string') {
          progress.roundResults[i].status = 'error'
          progress.roundResults[i].durationMs = Date.now() - roundStart
          roundResults[round.key] = null
          this.emit('progress', progress)
          continue
        }
        let prompt = promptTemplate.replace('{chatRecords}', chatText)
        if (round.key === 'validation') {
          const summary = JSON.stringify(roundResults, null, 2)
          const sample = chatText.slice(0, 3000)
          prompt = (DISTILL_PROMPTS_V1 as any).validation
            .replace('{skillSummary}', summary)
            .replace('{chatRecordsSample}', sample)
        }
        const result = await this.runDistillRound(adapter, prompt, progress)
        roundResults[round.key] = result
        progress.roundResults[i].status = 'completed'
        progress.roundResults[i].durationMs = Date.now() - roundStart
      } catch (e) {
        progress.roundResults[i].status = 'error'
        progress.roundResults[i].durationMs = Date.now() - roundStart
        roundResults[round.key] = null
      }

      this.emit('progress', progress)
    }

    const skill = this.generateSkillFilesV1(roundResults, config)
    this.results.set(progress.taskId, skill)
  }

  async fetchChatRecords(contactId: string, limit: number, startDate?: string, endDate?: string): Promise<ChatRecord[]> {
    if (this.chatRecordFetcher) {
      try {
        const records = await this.chatRecordFetcher(contactId, limit)
        if (records.length > 0) return records
      } catch (e) {
        console.warn('[DistillService] chatRecordFetcher failed, falling back to HTTP API:', e)
      }
    }

    if (!this.weflowBaseUrl) {
      throw new Error('无法获取聊天记录：未配置数据源（chatService 不可用且 HTTP API 未配置）')
    }

    const params = new URLSearchParams({ talker: contactId, limit: String(limit) })
    if (startDate) params.set('start', startDate)
    if (endDate) params.set('end', endDate)

    const url = `${this.weflowBaseUrl}/api/v1/messages?${params.toString()}`
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.weflowAccessToken}` }
    })

    if (!res.ok) {
      throw new Error(`Failed to fetch chat records: HTTP ${res.status}`)
    }

    const data: any = await res.json()
    return (data.messages || data.records || data.data || []).map((r: any) => ({
      id: String(r.localId || r.serverId || r.id || r.msgId || ''),
      content: String(r.parsedContent || r.content || r.text || ''),
      isSend: Boolean(r.isSend ?? r.is_send ?? r.isMe ?? false),
      timestamp: Number(r.createTime || r.timestamp || 0),
      type: Number(r.localType ?? r.type ?? 1)
    }))
  }

  preprocessMessages(records: ChatRecord[]): PreprocessedRecords {
    return preprocessChatRecords(records)
  }

  private async runDistillRound(adapter: BaseAdapter, prompt: string, progress?: DistillProgress): Promise<any> {
    const messages = [
      { role: 'system' as const, content: '你是一个专业的聊天记录分析专家，请严格按照要求的JSON格式输出分析结果。' },
      { role: 'user' as const, content: prompt }
    ]

    const result = await adapter.generate(messages, { maxTokens: 4096 })

    if (progress && result.usage) {
      progress.tokenUsage.inputTokens += result.usage.promptTokens || 0
      progress.tokenUsage.outputTokens += result.usage.completionTokens || 0
      progress.tokenUsage.totalTokens += result.usage.totalTokens || 0
    }

    try {
      const jsonMatch = result.content.match(/\[[\s\S]*\]/) || result.content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch {}

    return { rawContent: result.content }
  }

  private formatChatForPrompt(preprocessed: PreprocessedRecords): string {
    const lines: string[] = []
    const allSorted = [...preprocessed.otherMessages, ...preprocessed.selfMessages]
      .sort((a, b) => a.timestamp - b.timestamp)

    for (const msg of allSorted) {
      const sender = msg.isSend ? '我方' : '对方'
      const time = new Date(msg.timestamp).toLocaleString('zh-CN')
      lines.push(`[${time}] ${sender}: ${msg.content}`)
    }

    let result = lines.join('\n')
    const MAX_CHARS = 80000
    if (result.length > MAX_CHARS) {
      result = result.slice(result.length - MAX_CHARS)
      const firstNewline = result.indexOf('\n')
      if (firstNewline > 0) {
        result = result.slice(firstNewline + 1)
      }
      result = '...（前部分已截断）\n' + result
    }

    return result
  }

  private collectCandidateFeatures(roundResults: Record<string, any>): string[] {
    const candidates: string[] = []

    const l0 = roundResults.layer0_hardRules
    if (l0) {
      if (Array.isArray(l0.neverSay)) l0.neverSay.forEach((s: string) => candidates.push(`[硬规则-不说] ${s}`))
      if (Array.isArray(l0.neverDo)) l0.neverDo.forEach((s: string) => candidates.push(`[硬规则-不做] ${s}`))
      if (Array.isArray(l0.privacyBoundaries)) l0.privacyBoundaries.forEach((s: string) => candidates.push(`[硬规则-隐私] ${s}`))
    }

    const l1 = roundResults.layer1_identity
    if (l1) {
      if (l1.role) candidates.push(`[身份-角色] ${l1.role}`)
      if (l1.selfImage) candidates.push(`[身份-自我认知] ${l1.selfImage}`)
      if (Array.isArray(l1.culturalAffiliation)) l1.culturalAffiliation.forEach((s: string) => candidates.push(`[身份-文化] ${s}`))
    }

    const l2 = roundResults.layer2_expressionStyle
    if (l2) {
      if (Array.isArray(l2.catchphrases)) l2.catchphrases.forEach((s: string) => candidates.push(`[表达-口头禅] ${s}`))
      if (l2.humorStyle) candidates.push(`[表达-幽默] ${l2.humorStyle}`)
      if (l2.tone) candidates.push(`[表达-语气] ${l2.tone}`)
    }

    const l3 = roundResults.layer3_decisionJudgment
    if (l3) {
      if (Array.isArray(l3.priorityOrdering)) l3.priorityOrdering.forEach((s: string) => candidates.push(`[决策-优先级] ${s}`))
      if (Array.isArray(l3.pushbackConditions)) l3.pushbackConditions.forEach((s: string) => candidates.push(`[决策-推回] ${s}`))
      if (l3.riskTolerance) candidates.push(`[决策-风险] ${l3.riskTolerance}`)
    }

    const l4 = roundResults.layer4_interpersonalBehavior
    if (l4) {
      if (l4.toSuperiors) candidates.push(`[人际-对上级] ${l4.toSuperiors}`)
      if (l4.toPeers) candidates.push(`[人际-对平级] ${l4.toPeers}`)
      if (l4.underPressure) candidates.push(`[人际-压力下] ${l4.underPressure}`)
    }

    return candidates
  }

  private calculateQualityScore(verificationResults: VerificationResult[], validationResult: any): SkillQualityScore {
    const confirmed = verificationResults.filter(v => v.finalVerdict === 'confirmed').length
    const observation = verificationResults.filter(v => v.finalVerdict === 'observation').length
    const total = verificationResults.length

    const consistency = validationResult?.consistencyScore ?? 0.7
    const accuracy = validationResult?.accuracyScore ?? 0.7
    const completeness = validationResult?.completenessScore ?? 0.7

    const verificationRate = total > 0 ? (confirmed + observation * 0.5) / total : 0.5
    const overall = (consistency + accuracy + completeness + verificationRate) / 4

    return {
      overall: Math.round(overall * 100) / 100,
      consistency: Math.round(consistency * 100) / 100,
      accuracy: Math.round(accuracy * 100) / 100,
      completeness: Math.round(completeness * 100) / 100,
      verifiedFeatureCount: confirmed,
      totalCandidateCount: total
    }
  }

  generateSkillFilesV2(roundResults: Record<string, any>, config: DistillConfig): Skill {
    const l0 = roundResults.layer0_hardRules || {}
    const l1 = roundResults.layer1_identity || {}
    const l2 = roundResults.layer2_expressionStyle || {}
    const l3 = roundResults.layer3_decisionJudgment || {}
    const l4 = roundResults.layer4_interpersonalBehavior || {}

    const hasAnyData = [l0, l1, l2, l3, l4].some(layer =>
      layer && typeof layer === 'object' && Object.keys(layer).length > 0 && !layer.rawContent
    )

    const personaV2: PersonaV2 = {
      layer0_hardRules: {
        neverSay: Array.isArray(l0.neverSay) ? l0.neverSay : [],
        neverDo: Array.isArray(l0.neverDo) ? l0.neverDo : [],
        privacyBoundaries: Array.isArray(l0.privacyBoundaries) ? l0.privacyBoundaries : []
      },
      layer1_identity: {
        role: l1.role || config.skillName || '蒸馏角色',
        context: l1.context || '',
        selfImage: l1.selfImage || '',
        mbti: l1.mbti || undefined,
        culturalAffiliation: Array.isArray(l1.culturalAffiliation) ? l1.culturalAffiliation : []
      },
      layer2_expressionStyle: {
        catchphrases: Array.isArray(l2.catchphrases) ? l2.catchphrases : [],
        sentenceLengthAvg: l2.sentenceLengthAvg || 10,
        responseLatencyPattern: l2.responseLatencyPattern || '',
        emojiUsage: Array.isArray(l2.emojiUsage)
          ? l2.emojiUsage.filter((e: any) => e && typeof e === 'object' && e.emoji)
          : [],
        humorStyle: l2.humorStyle || '',
        templateDialogues: Array.isArray(l2.templateDialogues)
          ? l2.templateDialogues.filter((t: any) => t && typeof t === 'object' && t.trigger)
          : [],
        tone: l2.tone || '',
        vocabulary: Array.isArray(l2.vocabulary) ? l2.vocabulary.slice(0, 20) : [],
        sentencePatterns: Array.isArray(l2.sentencePatterns) ? l2.sentencePatterns : []
      },
      layer3_decisionJudgment: {
        priorityOrdering: Array.isArray(l3.priorityOrdering) ? l3.priorityOrdering : [],
        pushbackConditions: Array.isArray(l3.pushbackConditions) ? l3.pushbackConditions : [],
        declineStrategies: Array.isArray(l3.declineStrategies) ? l3.declineStrategies : [],
        riskTolerance: l3.riskTolerance || ''
      },
      layer4_interpersonalBehavior: {
        toSuperiors: l4.toSuperiors || '',
        toPeers: l4.toPeers || '',
        toSubordinates: l4.toSubordinates || '',
        underPressure: l4.underPressure || '',
        inConflict: l4.inConflict || ''
      }
    }

    const systemPromptTemplate = roundResults.skillSynthesis?.rawContent
      || this.buildSystemPromptTemplateV2(personaV2)

    const skillId = `distilled_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const skill: Skill = {
      id: skillId,
      name: config.skillName || '蒸馏角色',
      version: '2.0.0',
      description: config.skillDescription || (hasAnyData ? '通过聊天记录蒸馏生成的角色（五层人格架构）' : '蒸馏数据不足，角色特征可能不完整'),
      selfMemory: {
        background: personaV2.layer1_identity.selfImage || personaV2.layer1_identity.role,
        experiences: [],
        values: personaV2.layer3_decisionJudgment.priorityOrdering,
        preferences: {
          riskTolerance: personaV2.layer3_decisionJudgment.riskTolerance,
          humorStyle: personaV2.layer2_expressionStyle.humorStyle
        },
        relationships: []
      },
      persona: {
        identity: {
          role: personaV2.layer1_identity.role,
          mbti: personaV2.layer1_identity.mbti,
          tags: personaV2.layer2_expressionStyle.catchphrases.slice(0, 10)
        },
        speechStyle: {
          tone: personaV2.layer2_expressionStyle.tone,
          vocabulary: personaV2.layer2_expressionStyle.vocabulary.slice(0, 20),
          sentencePatterns: personaV2.layer2_expressionStyle.sentencePatterns,
          emojiUsage: typeof personaV2.layer2_expressionStyle.emojiUsage === 'string'
            ? personaV2.layer2_expressionStyle.emojiUsage
            : JSON.stringify(personaV2.layer2_expressionStyle.emojiUsage)
        },
        emotionalPatterns: {
          triggers: {},
          copingMechanisms: []
        },
        behavioralRules: [
          ...personaV2.layer0_hardRules.neverSay.map((s: string) => `绝对不说: ${s}`),
          ...personaV2.layer0_hardRules.neverDo.map((s: string) => `绝对不做: ${s}`),
          ...personaV2.layer3_decisionJudgment.declineStrategies.slice(0, 5)
        ]
      },
      personaV2,
      systemPromptTemplate,
      replyStrategy: DEFAULT_REPLY_STRATEGY,
      isBuiltin: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    return skill
  }

  generateSkillFilesV1(roundResults: Record<string, any>, config: DistillConfig): Skill {
    const expression = roundResults.expressionDNA || {}
    const mental = roundResults.mentalModels || {}
    const decision = roundResults.decisionHeuristics || {}
    const values = roundResults.valuesAndAntiPatterns || {}
    const honesty = roundResults.honestyBoundaries || {}

    const skillId = `distilled_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const skill: Skill = {
      id: skillId,
      name: config.skillName || '蒸馏角色',
      version: '1.0.0',
      description: config.skillDescription || '通过聊天记录蒸馏生成的角色',
      selfMemory: {
        background: mental.reasoningStyle || '基于聊天记录蒸馏的角色',
        experiences: (values.antiPatterns || []).concat(values.contradictions || []),
        values: values.coreValues || [],
        preferences: {
          decisionPattern: decision.tradeoffPattern || '',
          riskAssessment: decision.riskAssessment || ''
        },
        relationships: []
      },
      persona: {
        identity: {
          role: config.skillName || '蒸馏角色',
          tags: (expression.vocabulary || []).slice(0, 10)
        },
        speechStyle: {
          tone: expression.tone || '',
          vocabulary: (expression.vocabulary || []).slice(0, 20),
          sentencePatterns: (expression.sentencePatterns || []).slice(0, 10),
          emojiUsage: expression.emojiUsage || ''
        },
        emotionalPatterns: {
          triggers: {},
          copingMechanisms: (values.defenseMechanisms || []).slice(0, 10)
        },
        behavioralRules: [
          ...(decision.quickJudgment || []).slice(0, 5),
          ...(decision.avoidanceStrategies || []).slice(0, 5),
          ...(values.taboos || []).slice(0, 5)
        ]
      },
      systemPromptTemplate: this.buildSystemPromptTemplateV1(expression, mental, decision, values, honesty),
      replyStrategy: DEFAULT_REPLY_STRATEGY,
      isBuiltin: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    return skill
  }

  private buildSystemPromptTemplateV2(persona: PersonaV2): string {
    const parts: string[] = []

    if (persona.layer0_hardRules.neverSay.length > 0 || persona.layer0_hardRules.neverDo.length > 0) {
      parts.push('【硬规则】')
      persona.layer0_hardRules.neverSay.forEach(s => parts.push(`绝对不要说: ${s}`))
      persona.layer0_hardRules.neverDo.forEach(s => parts.push(`绝对不要做: ${s}`))
      persona.layer0_hardRules.privacyBoundaries.forEach(s => parts.push(`隐私边界: ${s}`))
    }

    parts.push(`\n【身份】你是${persona.layer1_identity.role}。${persona.layer1_identity.selfImage}`)
    if (persona.layer1_identity.mbti) parts.push(`性格类型倾向: ${persona.layer1_identity.mbti}`)

    parts.push('\n【表达风格】')
    if (persona.layer2_expressionStyle.tone) parts.push(`语气: ${persona.layer2_expressionStyle.tone}`)
    if (persona.layer2_expressionStyle.catchphrases.length > 0) parts.push(`口头禅: ${persona.layer2_expressionStyle.catchphrases.join('、')}`)
    if (persona.layer2_expressionStyle.humorStyle) parts.push(`幽默: ${persona.layer2_expressionStyle.humorStyle}`)
    if (persona.layer2_expressionStyle.sentenceLengthAvg > 0) {
      parts.push(`句长偏好: ${persona.layer2_expressionStyle.sentenceLengthAvg > 15 ? '长句' : '短句'}为主（平均${persona.layer2_expressionStyle.sentenceLengthAvg}字）`)
    }

    parts.push('\n【决策判断】')
    if (persona.layer3_decisionJudgment.priorityOrdering.length > 0) parts.push(`优先级: ${persona.layer3_decisionJudgment.priorityOrdering.join(' > ')}`)
    if (persona.layer3_decisionJudgment.riskTolerance) parts.push(`风险态度: ${persona.layer3_decisionJudgment.riskTolerance}`)
    if (persona.layer3_decisionJudgment.declineStrategies.length > 0) parts.push(`拒绝方式: ${persona.layer3_decisionJudgment.declineStrategies.join('；')}`)

    parts.push('\n【人际行为】')
    if (persona.layer4_interpersonalBehavior.toPeers) parts.push(`对朋友: ${persona.layer4_interpersonalBehavior.toPeers}`)
    if (persona.layer4_interpersonalBehavior.underPressure) parts.push(`压力下: ${persona.layer4_interpersonalBehavior.underPressure}`)
    if (persona.layer4_interpersonalBehavior.inConflict) parts.push(`冲突中: ${persona.layer4_interpersonalBehavior.inConflict}`)

    parts.push('\n【局限性】此Skill基于有限的聊天记录蒸馏生成，可能无法完整还原真实人格。遇到超出蒸馏范围的话题，保持沉默而非编造。')

    return parts.join('\n')
  }

  private buildSystemPromptTemplateV1(
    expression: any,
    mental: any,
    decision: any,
    values: any,
    honesty: any
  ): string {
    const parts: string[] = []

    if (expression.tone) parts.push(`语气风格: ${expression.tone}`)
    if (expression.emojiUsage) parts.push(`表情使用: ${expression.emojiUsage}`)
    if (mental.reasoningStyle) parts.push(`思维方式: ${mental.reasoningStyle}`)
    if (decision.tradeoffPattern) parts.push(`决策模式: ${decision.tradeoffPattern}`)
    if (honesty.openness) parts.push(`坦诚程度: ${honesty.openness}`)
    if (values.coreValues && values.coreValues.length > 0) parts.push(`核心价值观: ${values.coreValues.join('、')}`)
    if (values.taboos && values.taboos.length > 0) parts.push(`禁忌话题: ${values.taboos.join('、')}`)

    return parts.join('\n')
  }

  getProgress(taskId: string): DistillProgress | null {
    return this.tasks.get(taskId) || null
  }

  getResult(taskId: string): Skill | null {
    return this.results.get(taskId) || null
  }

  cancelTask(taskId: string): void {
    const progress = this.tasks.get(taskId)
    if (progress) {
      const s: string = progress.status
      if (s === 'preparing' || s === 'distilling' || s === 'validating') {
        progress.status = 'cancelled'
        this.emit('progress', progress)
      }
    }
  }

  async saveSkill(taskId: string, outputDir: string, override?: Partial<Skill>): Promise<Skill> {
    const skill = this.results.get(taskId)
    if (!skill) throw new Error(`No result found for task: ${taskId}`)

    const finalSkill = override ? { ...skill, ...override } : skill

    await mkdir(outputDir, { recursive: true })

    await writeFile(join(outputDir, 'skill.json'), JSON.stringify(finalSkill, null, 2), 'utf-8')

    const skillMd = this.renderSkillMd(finalSkill)
    const selfMd = this.renderSelfMd(finalSkill)
    const personaMd = finalSkill.personaV2
      ? this.renderPersonaV2Md(finalSkill)
      : this.renderPersonaMd(finalSkill)

    await writeFile(join(outputDir, 'SKILL.md'), skillMd, 'utf-8')
    await writeFile(join(outputDir, 'self.md'), selfMd, 'utf-8')
    await writeFile(join(outputDir, 'persona.md'), personaMd, 'utf-8')

    return finalSkill
  }

  private renderSkillMd(skill: Skill): string {
    const lines: string[] = []
    lines.push('---')
    lines.push(`id: ${skill.id}`)
    lines.push(`name: ${skill.name}`)
    lines.push(`version: ${skill.version}`)
    if (skill.author) lines.push(`author: ${skill.author}`)
    lines.push(`description: ${skill.description}`)
    if (skill.qualityScore) lines.push(`quality: ${skill.qualityScore.overall}`)
    lines.push('---')
    lines.push('')
    lines.push(`# ${skill.name}`)
    lines.push('')
    lines.push(skill.description)
    if (skill.qualityScore) {
      lines.push('')
      lines.push('## 质量评分')
      lines.push(`- 综合: ${skill.qualityScore.overall}`)
      lines.push(`- 一致性: ${skill.qualityScore.consistency}`)
      lines.push(`- 准确性: ${skill.qualityScore.accuracy}`)
      lines.push(`- 完整性: ${skill.qualityScore.completeness}`)
      lines.push(`- 验证通过特征: ${skill.qualityScore.verifiedFeatureCount}/${skill.qualityScore.totalCandidateCount}`)
    }
    return lines.join('\n')
  }

  private renderSelfMd(skill: Skill): string {
    const lines: string[] = []
    lines.push('# 自我记忆')
    lines.push('')
    lines.push('## 背景')
    lines.push(skill.selfMemory.background)
    lines.push('')
    lines.push('## 经历')
    for (const exp of skill.selfMemory.experiences) {
      lines.push(`- ${exp}`)
    }
    lines.push('')
    lines.push('## 价值观')
    for (const v of skill.selfMemory.values) {
      lines.push(`- ${v}`)
    }
    return lines.join('\n')
  }

  private renderPersonaV2Md(skill: Skill): string {
    const p = skill.personaV2!
    const lines: string[] = []
    lines.push('# 角色设定（五层人格架构）')
    lines.push('')

    lines.push('## L0 硬规则')
    if (p.layer0_hardRules.neverSay.length > 0) {
      lines.push('### 绝对不说')
      p.layer0_hardRules.neverSay.forEach(s => lines.push(`- ${s}`))
    }
    if (p.layer0_hardRules.neverDo.length > 0) {
      lines.push('### 绝对不做')
      p.layer0_hardRules.neverDo.forEach(s => lines.push(`- ${s}`))
    }
    if (p.layer0_hardRules.privacyBoundaries.length > 0) {
      lines.push('### 隐私边界')
      p.layer0_hardRules.privacyBoundaries.forEach(s => lines.push(`- ${s}`))
    }
    lines.push('')

    lines.push('## L1 身份')
    lines.push(`- 角色: ${p.layer1_identity.role}`)
    lines.push(`- 环境: ${p.layer1_identity.context}`)
    lines.push(`- 自我认知: ${p.layer1_identity.selfImage}`)
    if (p.layer1_identity.mbti) lines.push(`- MBTI: ${p.layer1_identity.mbti}`)
    if (p.layer1_identity.culturalAffiliation.length > 0) {
      lines.push('- 文化归属:')
      p.layer1_identity.culturalAffiliation.forEach(s => lines.push(`  - ${s}`))
    }
    lines.push('')

    lines.push('## L2 表达风格')
    lines.push(`- 语气: ${p.layer2_expressionStyle.tone}`)
    lines.push(`- 幽默: ${p.layer2_expressionStyle.humorStyle}`)
    lines.push(`- 平均句长: ${p.layer2_expressionStyle.sentenceLengthAvg}字`)
    lines.push(`- 回复延迟模式: ${p.layer2_expressionStyle.responseLatencyPattern}`)
    if (p.layer2_expressionStyle.catchphrases.length > 0) {
      lines.push('- 口头禅:')
      p.layer2_expressionStyle.catchphrases.forEach(s => lines.push(`  - ${s}`))
    }
    if (p.layer2_expressionStyle.vocabulary.length > 0) {
      lines.push('- 常用词汇:')
      p.layer2_expressionStyle.vocabulary.forEach(s => lines.push(`  - ${s}`))
    }
    if (p.layer2_expressionStyle.sentencePatterns.length > 0) {
      lines.push('- 句式特点:')
      p.layer2_expressionStyle.sentencePatterns.forEach(s => lines.push(`  - ${s}`))
    }
    if (p.layer2_expressionStyle.emojiUsage.length > 0) {
      lines.push('- 表情使用:')
      p.layer2_expressionStyle.emojiUsage.forEach(ep => {
        const ctxs = Array.isArray(ep.contexts) ? ep.contexts.join(', ') : ''
        lines.push(`  - ${ep.emoji} (${ep.frequency})${ctxs ? ` [${ctxs}]` : ''}`)
      })
    }
    if (p.layer2_expressionStyle.templateDialogues.length > 0) {
      lines.push('- 模板对话:')
      p.layer2_expressionStyle.templateDialogues.forEach(td => {
        if (td && typeof td === 'object') {
          lines.push(`  - ${td.trigger || ''} → ${td.response || ''}`)
        }
      })
    }
    lines.push('')

    lines.push('## L3 决策判断')
    if (p.layer3_decisionJudgment.priorityOrdering.length > 0) {
      lines.push(`- 优先级: ${p.layer3_decisionJudgment.priorityOrdering.join(' > ')}`)
    }
    lines.push(`- 风险态度: ${p.layer3_decisionJudgment.riskTolerance}`)
    if (p.layer3_decisionJudgment.declineStrategies.length > 0) {
      lines.push('- 拒绝策略:')
      p.layer3_decisionJudgment.declineStrategies.forEach(s => lines.push(`  - ${s}`))
    }
    if (p.layer3_decisionJudgment.pushbackConditions.length > 0) {
      lines.push('- 推回条件:')
      p.layer3_decisionJudgment.pushbackConditions.forEach(s => lines.push(`  - ${s}`))
    }
    lines.push('')

    lines.push('## L4 人际行为')
    lines.push(`- 对上级: ${p.layer4_interpersonalBehavior.toSuperiors}`)
    lines.push(`- 对平级: ${p.layer4_interpersonalBehavior.toPeers}`)
    lines.push(`- 对下级: ${p.layer4_interpersonalBehavior.toSubordinates}`)
    lines.push(`- 压力下: ${p.layer4_interpersonalBehavior.underPressure}`)
    lines.push(`- 冲突中: ${p.layer4_interpersonalBehavior.inConflict}`)

    return lines.join('\n')
  }

  private renderPersonaMd(skill: Skill): string {
    const lines: string[] = []
    lines.push('# 角色设定')
    lines.push('')
    lines.push('## 身份')
    lines.push(skill.persona.identity.role)
    lines.push('')
    lines.push('## 性格标签')
    for (const tag of skill.persona.identity.tags) {
      lines.push(`- ${tag}`)
    }
    lines.push('')
    lines.push('## 语气')
    lines.push(skill.persona.speechStyle.tone)
    lines.push('')
    lines.push('## 常用词汇')
    for (const v of skill.persona.speechStyle.vocabulary) {
      lines.push(`- ${v}`)
    }
    lines.push('')
    lines.push('## 句式')
    for (const p of skill.persona.speechStyle.sentencePatterns) {
      lines.push(`- ${p}`)
    }
    lines.push('')
    lines.push('## 规则')
    for (const r of skill.persona.behavioralRules) {
      lines.push(`- ${r}`)
    }
    return lines.join('\n')
  }
}
