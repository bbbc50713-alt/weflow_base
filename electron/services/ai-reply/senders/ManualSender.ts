import type { MessageSender, SendTextRequest, SendTextResult, SenderHealth } from './types'

export class ManualSender implements MessageSender {
  id = 'manual' as const
  displayName = 'Manual review'
  riskLevel = 'low' as const

  async getHealth(): Promise<SenderHealth> {
    return {
      available: true,
      reason: 'Replies will be generated and logged, but not sent to WeChat automatically.',
      capabilities: {
        text: true,
        image: false,
        file: false,
        groupMention: false,
        silent: true
      }
    }
  }

  async sendText(request: SendTextRequest): Promise<SendTextResult> {
    const detail = `Generated reply for ${request.contactName || request.contactId}; manual sending is required.`

    return {
      success: false,
      delivered: false,
      senderId: this.id,
      error: detail,
      detail,
      steps: [
        {
          name: 'manual',
          status: 'ok',
          detail: 'Auto-send is disabled for this sender.'
        }
      ]
    }
  }
}
