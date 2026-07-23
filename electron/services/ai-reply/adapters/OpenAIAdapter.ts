import { BaseAdapter } from './BaseAdapter'
import type { ChatMessage, GenerateOptions, GenerateResult, TestResult, OpenAICompatibleConfig } from '../../../../src/types/ai-reply'

export class OpenAIAdapter extends BaseAdapter {
  private getConfig(): OpenAICompatibleConfig {
    return this.getOpenAIConfig()
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult> {
    const cfg = this.getConfig()
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`

    const body = {
      model: cfg.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? cfg.temperature,
      max_tokens: options?.maxTokens ?? cfg.maxTokens,
      stream: false
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let detail = text || response.statusText
      try {
        const errJson = JSON.parse(text)
        detail = errJson.error?.message || errJson.message || errJson.msg || text
      } catch {}
      if (response.status === 401) {
        throw new Error(`认证失败 (401): ${detail}。请检查 API Key 是否正确，以及是否与 API 地址匹配。`)
      }
      throw new Error(`API 请求失败 (${response.status}): ${detail}`)
    }

    // 检查 Content-Type，避免将 HTML 当作 JSON 解析
    const contentType = response.headers.get('content-type')
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text().catch(() => '')
      const preview = text.substring(0, 200).replace(/\n/g, ' ')

      throw new Error(
        `API 返回了非 JSON 响应\n\n` +
        `Content-Type: ${contentType || 'unknown'}\n` +
        `响应预览: ${preview}...\n\n` +
        `可能原因：\n` +
        `1. API 端点配置错误（请检查 baseUrl）\n` +
        `2. 该 API 不兼容 OpenAI 格式\n` +
        `3. 需要额外的请求头或参数\n\n` +
        `请求 URL: ${url}\n` +
        `模型: ${cfg.model}`
      )
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''

    return {
      content,
      model: cfg.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0
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

      const baseUrl = cfg.baseUrl.replace(/\/$/, '')

      const testUrl = `${baseUrl}/chat/completions`
      const testBody = {
        model: cfg.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      }

      const response = await fetch(testUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(testBody),
        signal: AbortSignal.timeout(15000)
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let detail = text || response.statusText
        try {
          const errJson = JSON.parse(text)
          detail = errJson.error?.message || errJson.message || errJson.msg || text
        } catch {}
        if (response.status === 401) {
          return {
            success: false,
            message: `认证失败 (401): ${detail}\n\n可能原因：\n1. API Key 不正确或已过期\n2. API 地址与 Key 不匹配（如 ModelScope 的 Key 不能用于 OpenAI 地址）\n3. ModelScope 用户请确认：baseUrl 应为 https://api-inference.modelscope.cn/v1/ ，Key 为 ModelScope Access Token`,
            latencyMs: Date.now() - startTime
          }
        }
        return {
          success: false,
          message: `连接失败 (${response.status}): ${detail}`,
          latencyMs: Date.now() - startTime
        }
      }

      // 验证响应是否是 JSON
      const contentType = response.headers.get('content-type')
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text().catch(() => '')
        const preview = text.substring(0, 200).replace(/\n/g, ' ')

        return {
          success: false,
          message:
            `API 返回了非 JSON 响应（${contentType || 'unknown'}）\n\n` +
            `响应预览: ${preview}...\n\n` +
            `这个 API 可能不兼容 OpenAI 格式。\n` +
            `请检查 baseUrl 配置是否正确。\n\n` +
            `请求 URL: ${testUrl}`,
          latencyMs: Date.now() - startTime
        }
      }

      // 尝试解析 JSON
      let data: any
      try {
        data = await response.json()
      } catch (error) {
        const text = await response.text().catch(() => '')
        return {
          success: false,
          message:
            `无法解析 API 响应为 JSON\n\n` +
            `错误: ${error instanceof Error ? error.message : String(error)}\n` +
            `响应: ${text.substring(0, 200)}...`,
          latencyMs: Date.now() - startTime
        }
      }

      // 验证响应格式
      if (!data.choices || !Array.isArray(data.choices)) {
        return {
          success: false,
          message:
            `API 响应格式不正确\n\n` +
            `期望包含 'choices' 数组，但实际响应:\n` +
            JSON.stringify(data, null, 2).substring(0, 500),
          latencyMs: Date.now() - startTime
        }
      }

      return {
        success: true,
        message: `连接成功，模型 "${cfg.model}" 可用`,
        latencyMs: Date.now() - startTime
      }
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
    const cfg = this.getConfig()
    try {
      const baseUrl = cfg.baseUrl.replace(/\/$/, '')
      const res = await fetch(`${baseUrl}/models`, {
        headers: cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
      }
      const data = await res.json()
      const models = data.data || data.models || []
      return models.map((m: any) => ({
        id: (m.id || m.name || m.model) as string,
        name: (m.id || m.name || m.model) as string,
        isLocal: false
      }))
    } catch (e) {
      console.warn('[OpenAIAdapter] fetchAvailableModels failed:', e instanceof Error ? e.message : e)
      throw e
    }
  }
}
