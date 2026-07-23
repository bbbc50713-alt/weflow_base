import { BaseAdapter } from './BaseAdapter'
import type { ChatMessage, GenerateOptions, GenerateResult, TestResult, OpenAICompatibleConfig } from '../../../../src/types/ai-reply'

export class ClaudeAdapter extends BaseAdapter {
  private getConfig(): OpenAICompatibleConfig {
    return this.getOpenAIConfig()
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult> {
    const cfg = this.getConfig()
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/messages`

    const systemMsg = messages.find(m => m.role === 'system')
    const rawChatMsgs = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: m.content
    }))
    const chatMsgs: { role: 'user' | 'assistant'; content: string }[] = []
    for (const msg of rawChatMsgs) {
      const last = chatMsgs[chatMsgs.length - 1]
      if (last && last.role === msg.role) {
        last.content += '\n' + msg.content
      } else {
        chatMsgs.push({ ...msg })
      }
    }
    if (chatMsgs.length === 0) {
      chatMsgs.push({ role: 'user', content: 'Hello' })
    }
    if (chatMsgs[0].role !== 'user') {
      chatMsgs.unshift({ role: 'user', content: '(继续)' })
    }

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: chatMsgs,
      max_tokens: options?.maxTokens ?? cfg.maxTokens,
      stream: false
    }
    if (systemMsg) {
      body.system = systemMsg.content
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let detail = text || response.statusText
      try {
        const errJson = JSON.parse(text)
        detail = errJson.error?.message || errJson.message || text
      } catch {}
      if (response.status === 401) {
        throw new Error(`认证失败 (401): ${detail}。请检查 API Key 是否正确。`)
      }
      throw new Error(`Claude API 请求失败 (${response.status}): ${detail}`)
    }

    const data = await response.json()
    const content = data.content?.[0]?.text || ''

    return {
      content,
      model: cfg.model,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens || 0,
        completionTokens: data.usage.output_tokens || 0,
        totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
      } : undefined
    }
  }

  async testConnection(): Promise<TestResult> {
    const cfg = this.getConfig()
    const startTime = Date.now()

    try {
      if (!cfg.apiKey) {
        return { success: false, message: 'API Key 未配置' }
      }

      const url = `${cfg.baseUrl.replace(/\/$/, '')}/messages`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }]
        }),
        signal: AbortSignal.timeout(10000)
      })

      if (response.status === 401) {
        return { success: false, message: 'API Key 无效', latencyMs: Date.now() - startTime }
      }

      if (response.status === 404) {
        return { success: false, message: `模型 "${cfg.model}" 未找到`, latencyMs: Date.now() - startTime }
      }

      if (response.ok) {
        return { success: true, message: '连接成功，Claude API 可用', latencyMs: Date.now() - startTime }
      }

      return { success: false, message: `连接失败: HTTP ${response.status}`, latencyMs: Date.now() - startTime }
    } catch (error) {
      return {
        success: false,
        message: `连接失败: ${error instanceof Error ? error.message : String(error)}`,
        latencyMs: Date.now() - startTime
      }
    }
  }

  validateConfig(): boolean {
    const cfg = this.getConfig()
    return !!cfg.apiKey && !!cfg.baseUrl && !!cfg.model
  }

  async fetchAvailableModels(): Promise<{ id: string; name: string; isLocal: boolean }[]> {
    return [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', isLocal: false },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', isLocal: false },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', isLocal: false },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', isLocal: false }
    ]
  }
}
