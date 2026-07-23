export type SenderId = 'manual' | 'ui-automation' | 'weclaw-http' | 'wechatferry'

export interface SendTextRequest {
  contactId: string
  contactName: string
  text: string
  isGroup?: boolean
  rawMessage?: unknown
  traceId?: string
}

export interface SendStep {
  name: string
  status: 'ok' | 'warning' | 'error'
  detail?: string
}

export interface SendTextResult {
  success: boolean
  delivered: boolean
  senderId: SenderId
  error?: string
  detail?: string
  steps?: SendStep[]
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

export interface MessageSender {
  id: SenderId
  displayName: string
  riskLevel: 'low' | 'medium' | 'high'
  getHealth(): Promise<SenderHealth>
  sendText(request: SendTextRequest): Promise<SendTextResult>
}

export interface UIAutomationSenderConfig {
  restoreClipboard?: boolean
  sendHotkey?: 'enter' | 'ctrl-enter'
  reuseActiveChat?: boolean
}

export interface WeClawHttpSenderConfig {
  enabled: boolean
  baseUrl: string
  token?: string
  timeoutMs: number
  /**
   * WeFlow contactId → WeClaw target 的显式映射。
   * 防止在无映射时把 contactId 透传给 WeClaw 导致发错人。
   */
  contactMappings?: Record<string, string>
  /**
   * 是否要求显式映射才发送。默认 true：
   * - true：未命中映射则硬失败，避免发错人
   * - false：未命中时回退到 contactId || contactName（旧行为，有风险）
   */
  requireExplicitMapping?: boolean
}

export interface WeChatFerrySenderConfig {
  enabled: boolean
  endpoint?: string
  warningAcceptedAt?: number
}

export interface AIReplySenderConfig {
  activeSenderId: SenderId
  fallbackSenderId?: SenderId
  manualConfirmBeforeSend: boolean
  uiAutomation: UIAutomationSenderConfig
  weclawHttp: WeClawHttpSenderConfig
  wechatferry: WeChatFerrySenderConfig
}

export const DEFAULT_SENDER_CONFIG: AIReplySenderConfig = {
  activeSenderId: 'ui-automation',
  fallbackSenderId: 'manual',
  manualConfirmBeforeSend: false,
  uiAutomation: {
    restoreClipboard: true,
    sendHotkey: 'enter',
    reuseActiveChat: true
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
