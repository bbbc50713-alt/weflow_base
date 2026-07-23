import { WeChatSender } from '../core/WeChatSender'
import type { MessageSender, SendTextRequest, SendTextResult, SenderHealth, UIAutomationSenderConfig } from './types'

export class UIAutomationSender implements MessageSender {
  id = 'ui-automation' as const
  displayName = 'Windows UI automation'
  riskLevel = 'medium' as const

  constructor(private readonly wechatSender: WeChatSender, private config: UIAutomationSenderConfig = {}) {
    this.wechatSender.setOptions(this.config)
  }

  updateConfig(config: UIAutomationSenderConfig): void {
    this.config = { ...config }
    this.wechatSender.setOptions(this.config)
  }

  setEnabled(enabled: boolean): void {
    this.wechatSender.setEnabled(enabled)
  }

  isEnabled(): boolean {
    return this.wechatSender.isEnabled()
  }

  async getHealth(): Promise<SenderHealth> {
    const availability = await this.wechatSender.checkAvailability()

    return {
      available: availability.success,
      reason: availability.success ? undefined : availability.error,
      capabilities: {
        text: true,
        image: false,
        file: false,
        groupMention: false,
        silent: false
      }
    }
  }

  async sendText(request: SendTextRequest): Promise<SendTextResult> {
    const result = await this.wechatSender.sendTextMessage(
      request.contactId,
      request.contactName,
      request.text,
      Boolean(request.isGroup)
    )

    return {
      success: result.success,
      delivered: result.success,
      senderId: this.id,
      error: result.error,
      detail: result.success ? 'Sent through Windows UI automation.' : result.error
    }
  }
}
