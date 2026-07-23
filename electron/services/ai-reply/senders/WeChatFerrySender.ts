import type { MessageSender, SendTextRequest, SendTextResult, SenderHealth, WeChatFerrySenderConfig } from './types'

export class WeChatFerrySender implements MessageSender {
  id = 'wechatferry' as const
  displayName = 'WeChatFerry'
  riskLevel = 'high' as const

  constructor(private config: WeChatFerrySenderConfig) {}

  updateConfig(config: WeChatFerrySenderConfig): void {
    this.config = { ...config }
  }

  async getHealth(): Promise<SenderHealth> {
    return {
      available: false,
      reason: this.config.enabled
        ? 'WeChatFerry support is reserved but not enabled in this build. Use an external bridge before enabling.'
        : 'WeChatFerry sender is disabled.',
      capabilities: {
        text: true,
        image: true,
        file: true,
        groupMention: false,
        silent: true
      }
    }
  }

  async sendText(_request: SendTextRequest): Promise<SendTextResult> {
    return {
      success: false,
      delivered: false,
      senderId: this.id,
      error: 'WeChatFerry sender is reserved but not implemented. Enable WeClaw HTTP or UI automation instead.'
    }
  }
}
