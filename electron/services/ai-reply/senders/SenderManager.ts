import { WeChatSender } from '../core/WeChatSender'
import { ManualSender } from './ManualSender'
import { UIAutomationSender } from './UIAutomationSender'
import { WeChatFerrySender } from './WeChatFerrySender'
import { WeClawHttpSender } from './WeClawHttpSender'
import {
  DEFAULT_SENDER_CONFIG,
  type AIReplySenderConfig,
  type MessageSender,
  type SendTextRequest,
  type SendTextResult,
  type SenderHealth,
  type SenderId
} from './types'

export class SenderManager {
  private config: AIReplySenderConfig
  private autoSendEnabled = true
  private readonly manualSender = new ManualSender()
  private readonly uiAutomationSender: UIAutomationSender
  private readonly weclawHttpSender: WeClawHttpSender
  private readonly wechatFerrySender: WeChatFerrySender
  private readonly senders: Map<SenderId, MessageSender>

  constructor(wechatSender = new WeChatSender(), config?: Partial<AIReplySenderConfig>) {
    this.config = this.mergeConfig(config)
    this.uiAutomationSender = new UIAutomationSender(wechatSender, this.config.uiAutomation)
    this.weclawHttpSender = new WeClawHttpSender(this.config.weclawHttp)
    this.wechatFerrySender = new WeChatFerrySender(this.config.wechatferry)
    this.uiAutomationSender.setEnabled(this.autoSendEnabled)
    this.senders = new Map<SenderId, MessageSender>([
      ['manual', this.manualSender],
      ['ui-automation', this.uiAutomationSender],
      ['weclaw-http', this.weclawHttpSender],
      ['wechatferry', this.wechatFerrySender]
    ])
  }

  setAutoSendEnabled(enabled: boolean): void {
    this.autoSendEnabled = enabled
    this.uiAutomationSender.setEnabled(enabled)
  }

  isAutoSendEnabled(): boolean {
    return this.autoSendEnabled
  }

  getConfig(): AIReplySenderConfig {
    return JSON.parse(JSON.stringify(this.config))
  }

  updateConfig(config: Partial<AIReplySenderConfig>): AIReplySenderConfig {
    this.config = this.mergeConfig(config)
    this.uiAutomationSender.updateConfig(this.config.uiAutomation)
    this.weclawHttpSender.updateConfig(this.config.weclawHttp)
    this.wechatFerrySender.updateConfig(this.config.wechatferry)
    return this.getConfig()
  }

  getActiveSender(): MessageSender {
    return this.senders.get(this.config.activeSenderId) || this.manualSender
  }

  async getHealth(senderId = this.config.activeSenderId): Promise<SenderHealth> {
    const sender = this.senders.get(senderId)
    if (!sender) {
      return {
        available: false,
        reason: `Unknown sender: ${senderId}`,
        capabilities: {
          text: false,
          image: false,
          file: false,
          groupMention: false,
          silent: false
        }
      }
    }

    return sender.getHealth()
  }

  async sendText(request: SendTextRequest): Promise<SendTextResult> {
    if (!this.autoSendEnabled) {
      return {
        success: false,
        delivered: false,
        senderId: this.config.activeSenderId,
        error: 'Auto-send is disabled.'
      }
    }

    const activeSender = this.getActiveSender()
    const result = await activeSender.sendText(request)
    if (result.success || !this.config.fallbackSenderId || this.config.fallbackSenderId === activeSender.id) {
      return result
    }

    const fallbackSender = this.senders.get(this.config.fallbackSenderId)
    if (!fallbackSender) return result

    const fallbackResult = await fallbackSender.sendText(request)
    const activeFailure = result.error || result.detail || 'failed'
    const fallbackFailure = fallbackResult.error || fallbackResult.detail
    const fallbackContext = `Fallback from ${activeSender.id}: ${activeFailure}`
    const detail = fallbackFailure
      ? `${fallbackContext}; fallback ${fallbackSender.id}: ${fallbackFailure}`
      : fallbackContext

    return {
      ...fallbackResult,
      error: fallbackResult.success ? fallbackResult.error : detail,
      detail
    }
  }

  private mergeConfig(config?: Partial<AIReplySenderConfig>): AIReplySenderConfig {
    const envSender = process.env.WEFLOW_AI_REPLY_SENDER as SenderId | undefined
    const envWeClawBaseUrl = process.env.WEFLOW_WECLAW_BASE_URL
    const envWeClawToken = process.env.WEFLOW_WECLAW_TOKEN

    const merged: AIReplySenderConfig = {
      ...DEFAULT_SENDER_CONFIG,
      ...config,
      uiAutomation: {
        ...DEFAULT_SENDER_CONFIG.uiAutomation,
        ...config?.uiAutomation
      },
      weclawHttp: {
        ...DEFAULT_SENDER_CONFIG.weclawHttp,
        ...config?.weclawHttp
      },
      wechatferry: {
        ...DEFAULT_SENDER_CONFIG.wechatferry,
        ...config?.wechatferry
      }
    }

    if (envSender && ['manual', 'ui-automation', 'weclaw-http', 'wechatferry'].includes(envSender)) {
      merged.activeSenderId = envSender
    }

    if (envWeClawBaseUrl) {
      merged.weclawHttp.enabled = true
      merged.weclawHttp.baseUrl = envWeClawBaseUrl
      if (merged.activeSenderId === 'ui-automation') {
        merged.activeSenderId = 'weclaw-http'
      }
    }

    if (envWeClawToken) {
      merged.weclawHttp.token = envWeClawToken
    }

    return merged
  }
}
