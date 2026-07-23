export type ServiceStatus = 'stopped' | 'running' | 'paused' | 'error'

export type ModelType = 'ollama' | 'openai' | 'claude' | 'gemini' | 'custom'

export interface OllamaConfig {
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
}

export interface OpenAICompatibleConfig {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
}

export interface CustomAPIConfig {
  url: string
  headers: Record<string, string>
  bodyTemplate: Record<string, unknown>
  responsePath: string
  method: 'POST' | 'GET'
}

export interface ModelConfig {
  id: string
  name: string
  type: ModelType
  enabled: boolean
  config: OllamaConfig | OpenAICompatibleConfig | CustomAPIConfig
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp?: number
}

export interface GenerateOptions {
  temperature?: number
  maxTokens?: number
  stream?: boolean
}

export interface GenerateResult {
  content: string
  model: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface TestResult {
  success: boolean
  message: string
  latencyMs?: number
}

export interface ModelInfo {
  id: string
  name: string
  type: ModelType
  isLocal: boolean
}

export interface Relationship {
  contactId: string
  contactName: string
  relationType: string
  notes?: string
}

export interface SelfMemory {
  background: string
  experiences: string[]
  values: string[]
  preferences: Record<string, unknown>
  relationships: Relationship[]
}

export interface PersonaIdentity {
  role: string
  age?: number
  occupation?: string
  mbti?: string
  tags: string[]
}

export interface SpeechStyle {
  tone: string
  vocabulary: string[]
  sentencePatterns: string[]
  emojiUsage: string
}

export interface EmotionalPatterns {
  triggers: Record<string, string>
  copingMechanisms: string[]
}

export interface Persona {
  identity: PersonaIdentity
  speechStyle: SpeechStyle
  emotionalPatterns: EmotionalPatterns
  behavioralRules: string[]
}

export interface Layer0HardRules {
  neverSay: string[]
  neverDo: string[]
  privacyBoundaries: string[]
}

export interface Layer1Identity {
  role: string
  context: string
  selfImage: string
  mbti?: string
  culturalAffiliation: string[]
}

export interface EmojiPattern {
  emoji: string
  frequency: 'high' | 'medium' | 'low'
  contexts: string[]
}

export interface TemplateDialogue {
  trigger: string
  response: string
}

export interface Layer2ExpressionStyle {
  catchphrases: string[]
  sentenceLengthAvg: number
  responseLatencyPattern: string
  emojiUsage: EmojiPattern[]
  humorStyle: string
  templateDialogues: TemplateDialogue[]
  tone: string
  vocabulary: string[]
  sentencePatterns: string[]
}

export interface Layer3DecisionJudgment {
  priorityOrdering: string[]
  pushbackConditions: string[]
  declineStrategies: string[]
  riskTolerance: string
}

export interface Layer4InterpersonalBehavior {
  toSuperiors: string
  toPeers: string
  toSubordinates: string
  underPressure: string
  inConflict: string
}

export interface PersonaV2 {
  layer0_hardRules: Layer0HardRules
  layer1_identity: Layer1Identity
  layer2_expressionStyle: Layer2ExpressionStyle
  layer3_decisionJudgment: Layer3DecisionJudgment
  layer4_interpersonalBehavior: Layer4InterpersonalBehavior
}

export interface VerificationResult {
  feature: string
  crossDomain: { passed: boolean; evidence: string }
  generative: { passed: boolean; prediction: string }
  exclusive: { passed: boolean; distinction: string }
  finalVerdict: 'confirmed' | 'observation' | 'common_wisdom' | 'rejected'
}

export interface SkillQualityScore {
  overall: number
  consistency: number
  accuracy: number
  completeness: number
  verifiedFeatureCount: number
  totalCandidateCount: number
}

export interface SkillEvolution {
  version: number
  changelog: EvolutionEntry[]
  lastEvolvedAt: number
  dataSourceHash: string
}

export interface EvolutionEntry {
  timestamp: number
  type: 'data_append' | 'conversation_correction' | 'manual_edit'
  layer: string
  change: string
  before?: string
  after?: string
}

export interface ReplyStrategy {
  responseDelay: { min: number; max: number }
  typingSpeed: number
  maxReplyLength: number
  breakOnPunctuation: boolean
}

export interface Skill {
  id: string
  name: string
  version: string
  author?: string
  description: string
  avatar?: string
  selfMemory: SelfMemory
  persona: Persona
  personaV2?: PersonaV2
  systemPromptTemplate: string
  replyStrategy: ReplyStrategy
  qualityScore?: SkillQualityScore
  evolution?: SkillEvolution
  isBuiltin?: boolean
  createdAt?: number
  updatedAt?: number
}

export type ListenMode = 'all' | 'specific' | 'whitelist' | 'blacklist'

export interface TriggerRules {
  enabled: boolean
  listenMode: ListenMode
  targetContacts: string[]
  whitelist: string[]
  blacklist: string[]
  keywords: {
    include: string[]
    exclude: string[]
    regex?: string
  }
  triggerOnAt: boolean
  triggerOnAtAll: boolean
  timeRules: {
    enabled: boolean
    allowedHours: [number, number]
    timezone: string
  }
  rateLimit: {
    enabled: boolean
    maxRepliesPerMinute: number
    cooldownSeconds: number
  }
}

export interface WeChatMessage {
  msgId: string
  contactId: string
  contactName: string
  groupName?: string
  content: string
  isGroup: boolean
  isSend?: boolean
  senderId?: string
  senderName?: string
  timestamp: number
  type: number
}

export interface ReplyLog {
  id: string
  timestamp: number
  contactId: string
  contactName: string
  receivedMessage: string
  generatedReply: string
  skillId: string
  skillName: string
  modelId: string
  modelName: string
  latencyMs: number
  success: boolean
  sent: boolean
  errorMessage?: string
}

export interface AIReplyConfig {
  enabled: boolean
  activeModelId: string
  activeSkillId: string
  triggerRules: TriggerRules
  models: ModelConfig[]
  skills: Skill[]
}

export interface DailyStats {
  receivedCount: number
  repliedCount: number
  activeContacts: number
  errorCount: number
}

export interface ContactSkillMapping {
  contactId: string
  skillId: string
  enabled: boolean
}

export const DEFAULT_TRIGGER_RULES: TriggerRules = {
  enabled: false,
  listenMode: 'specific',
  targetContacts: [],
  whitelist: [],
  blacklist: [],
  keywords: {
    include: [],
    exclude: []
  },
  triggerOnAt: true,
  triggerOnAtAll: false,
  timeRules: {
    enabled: false,
    allowedHours: [8, 22],
    timezone: 'Asia/Shanghai'
  },
  rateLimit: {
    enabled: true,
    maxRepliesPerMinute: 10,
    cooldownSeconds: 5
  }
}

export const DEFAULT_REPLY_STRATEGY: ReplyStrategy = {
  responseDelay: { min: 500, max: 2000 },
  typingSpeed: 50,
  maxReplyLength: 500,
  breakOnPunctuation: true
}

export interface ModelPreset {
  name: string
  type: ModelType
  baseUrl: string
  defaultModel: string
  needsApiKey: boolean
}

export interface DistillProgress {
  taskId: string
  status: 'preparing' | 'distilling' | 'validating' | 'completed' | 'cancelled' | 'error'
  currentRound: number
  totalRounds: number
  roundResults: { round: number; name: string; status: 'pending' | 'running' | 'completed' | 'error'; durationMs?: number }[]
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number }
  verificationResults?: VerificationResult[]
  error?: string
}

export interface DistillConfig {
  depth: 'standard' | 'deep'
  dimensions: ('expressionDNA' | 'mentalModels' | 'decisionHeuristics' | 'valuesAndAntiPatterns' | 'honestyBoundaries' | 'emotionalPatterns')[]
  skillName: string
  skillDescription: string
  messageLimit?: number
  enableTripleVerification?: boolean
  schemaVersion?: 'v1' | 'v2'
}

export interface ChatRecord {
  id: string
  content: string
  isSend: boolean
  timestamp: number
  type: number
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    name: 'Ollama (本地)',
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'llama3',
    needsApiKey: false
  },
  {
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    needsApiKey: true
  },
  {
    name: 'Claude',
    type: 'claude',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    needsApiKey: true
  },
  {
    name: 'Gemini',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    needsApiKey: true
  },
  {
    name: '魔搭社区',
    type: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-turbo',
    needsApiKey: true
  },
  {
    name: 'DeepSeek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    needsApiKey: true
  }
]

export const DEFAULT_SKILL: Skill = {
  id: 'default-assistant',
  name: '默认助手',
  version: '1.0.0',
  description: '通用 AI 助手，适用于大多数对话场景',
  selfMemory: {
    background: '你是一个友好的 AI 助手',
    experiences: [],
    values: ['乐于助人', '诚实', '尊重'],
    preferences: {},
    relationships: []
  },
  persona: {
    identity: {
      role: 'AI 助手',
      tags: ['友好', '专业', '简洁']
    },
    speechStyle: {
      tone: '友好、专业、简洁',
      vocabulary: [],
      sentencePatterns: [],
      emojiUsage: '适度使用'
    },
    emotionalPatterns: {
      triggers: {},
      copingMechanisms: []
    },
    behavioralRules: [
      '回复要简洁明了',
      '保持友好态度',
      '不确定时坦诚说明'
    ]
  },
  systemPromptTemplate: '',
  replyStrategy: DEFAULT_REPLY_STRATEGY,
  isBuiltin: true
}
export type SenderId = 'manual' | 'ui-automation' | 'weclaw-http' | 'wechatferry'

export interface SendStep {
  name: string
  status: 'ok' | 'warning' | 'error'
  detail?: string
}

export interface SenderHealth {
  available: boolean
  reason?: string
  version?: string
  capabilities: {
    text: boolean
    image: boolean
    file: boolean
    groupMention: boolean
    silent: boolean
  }
}

export interface AIReplySenderConfig {
  activeSenderId: SenderId
  fallbackSenderId?: SenderId
  manualConfirmBeforeSend: boolean
  uiAutomation: {
    restoreClipboard?: boolean
    sendHotkey?: 'enter' | 'ctrl-enter'
  }
  weclawHttp: {
    enabled: boolean
    baseUrl: string
    token?: string
    timeoutMs: number
  }
  wechatferry: {
    enabled: boolean
    endpoint?: string
    warningAcceptedAt?: number
  }
}

export const DEFAULT_AI_REPLY_SENDER_CONFIG: AIReplySenderConfig = {
  activeSenderId: 'ui-automation',
  fallbackSenderId: 'manual',
  manualConfirmBeforeSend: false,
  uiAutomation: {
    restoreClipboard: true,
    sendHotkey: 'enter'
  },
  weclawHttp: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:19888',
    timeoutMs: 10000
  },
  wechatferry: {
    enabled: false
  }
}
