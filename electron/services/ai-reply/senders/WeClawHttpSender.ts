import type {
  MessageSender,
  SendTextRequest,
  SendTextResult,
  SenderHealth,
  WeClawHttpSenderConfig
} from './types'

interface WeClawSendPayload {
  to: string
  text: string
  type: 'text'
  isGroup?: boolean
}

export class WeClawHttpSender implements MessageSender {
  id = 'weclaw-http' as const
  displayName = 'WeClaw HTTP'
  riskLevel = 'medium' as const

  constructor(private config: WeClawHttpSenderConfig) {}

  updateConfig(config: WeClawHttpSenderConfig): void {
    this.config = { ...config }
  }

  async getHealth(): Promise<SenderHealth> {
    if (!this.config.enabled) {
      return {
        available: false,
        reason: 'WeClaw HTTP sender is disabled.',
        capabilities: this.capabilities()
      }
    }

    if (!this.config.baseUrl) {
      return {
        available: false,
        reason: 'WeClaw base URL is empty.',
        capabilities: this.capabilities()
      }
    }

    try {
      const response = await this.request('/health', { method: 'GET' })
      return {
        available: response.ok,
        reason: response.ok ? undefined : `Health check returned HTTP ${response.status}`,
        capabilities: this.capabilities()
      }
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        capabilities: this.capabilities()
      }
    }
  }

  async sendText(request: SendTextRequest): Promise<SendTextResult> {
    if (!this.config.enabled) {
      return {
        success: false,
        delivered: false,
        senderId: this.id,
        error: 'WeClaw HTTP sender is disabled.'
      }
    }

    const target = this.resolveTarget(request)
    if (!target) {
      const mappings = this.config.contactMappings || {}
      const hasMappings = Object.keys(mappings).length > 0
      const reason = hasMappings
        ? `联系人 ${request.contactId} 未在 WeClaw 映射表中，已硬失败避免发错人`
        : 'WeClaw 联系人映射未配置，已硬失败避免发错人。请在发送器配置中添加 contactMappings，或显式设置 requireExplicitMapping=false 接受旧的有风险行为。'
      return {
        success: false,
        delivered: false,
        senderId: this.id,
        error: reason
      }
    }

    const payload: WeClawSendPayload = {
      to: target,
      text: request.text,
      type: 'text',
      isGroup: Boolean(request.isGroup)
    }

    try {
      const response = await this.request('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const bodyText = await response.text().catch(() => '')

      if (!response.ok) {
        return {
          success: false,
          delivered: false,
          senderId: this.id,
          error: `WeClaw send failed with HTTP ${response.status}`,
          detail: bodyText
        }
      }

      return {
        success: true,
        delivered: true,
        senderId: this.id,
        detail: bodyText || 'Sent through WeClaw HTTP.',
        steps: [{ name: 'weclaw-http', status: 'ok', detail: `POST /api/send -> ${response.status}` }]
      }
    } catch (error) {
      return {
        success: false,
        delivered: false,
        senderId: this.id,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private resolveTarget(request: SendTextRequest): string {
    // 修复发错人风险：优先使用显式映射。
    const mappings = this.config.contactMappings || {}
    const requireExplicit = this.config.requireExplicitMapping !== false // 默认 true

    if (Object.keys(mappings).length > 0) {
      const mapped = mappings[request.contactId]
      if (mapped) return mapped.trim()
      // 已配置映射但未命中：硬失败，避免发错人
      return ''
    }

    // 未配置任何映射
    if (requireExplicit) {
      // 默认要求显式映射，硬失败避免发错人
      return ''
    }

    // 兼容旧行为：requireExplicitMapping=false 时回退到 contactId || contactName
    // 注意：此行为有发错人风险，仅用于过渡兼容
    return (request.contactId || request.contactName || '').trim()
  }

  private capabilities(): SenderHealth['capabilities'] {
    return {
      text: true,
      image: false,
      file: false,
      groupMention: false,
      silent: true
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, '')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 10000)

    try {
      const headers = new Headers(init.headers || {})
      if (this.config.token) {
        headers.set('Authorization', `Bearer ${this.config.token}`)
      }

      return await fetch(`${baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}
