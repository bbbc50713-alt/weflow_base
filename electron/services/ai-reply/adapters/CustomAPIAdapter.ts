import { BaseAdapter } from './BaseAdapter'
import type { ChatMessage, GenerateOptions, GenerateResult, TestResult, CustomAPIConfig } from '../../../../src/types/ai-reply'

export class CustomAPIAdapter extends BaseAdapter {
  private getConfig(): CustomAPIConfig {
    return this.getCustomConfig()
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult> {
    const cfg = this.getConfig()

    const body = this.buildRequestBody(cfg, messages, options)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...cfg.headers
    }

    const response = await fetch(cfg.url, {
      method: cfg.method || 'POST',
      headers,
      body: cfg.method === 'GET' ? undefined : JSON.stringify(body)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Custom API error (${response.status}): ${text || response.statusText}`)
    }

    const data = await response.json()
    const content = this.extractResponse(data, cfg.responsePath)

    return {
      content: content || '',
      model: 'custom'
    }
  }

  async testConnection(): Promise<TestResult> {
    const cfg = this.getConfig()
    const startTime = Date.now()

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...cfg.headers
      }

      const testBody = this.buildRequestBody(cfg, [{ role: 'user', content: 'Hello' }], { temperature: 0.7, maxTokens: 10 })

      const response = await fetch(cfg.url, {
        method: cfg.method || 'POST',
        headers,
        body: cfg.method === 'GET' ? undefined : JSON.stringify(testBody),
        signal: AbortSignal.timeout(10000)
      })

      const success = response.ok || (response.status >= 400 && response.status < 500)
      const message = success
        ? (response.ok ? 'API 端点可达且响应正常' : `API 端点可达 (状态码 ${response.status})`)
        : `服务器错误: HTTP ${response.status}`

      return {
        success,
        message,
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
    return !!cfg.url
  }

  async fetchAvailableModels(): Promise<{ id: string; name: string; isLocal: boolean }[]> {
    return []
  }

  private buildRequestBody(
    cfg: CustomAPIConfig,
    messages: ChatMessage[],
    options?: GenerateOptions
  ): Record<string, unknown> {
    const body = JSON.parse(JSON.stringify(cfg.bodyTemplate || {}))

    const systemPrompt = messages.find(m => m.role === 'system')?.content
    const userMessage = messages.filter(m => m.role === 'user').pop()?.content

    const replaceValues = (obj: any): any => {
      if (typeof obj === 'string') {
        switch (obj) {
          case '${MESSAGES}':
            return messages.map(m => ({ role: m.role, content: m.content }))
          case '${TEMPERATURE}':
            return options?.temperature ?? 0.7
          case '${MAX_TOKENS}':
            return options?.maxTokens ?? 2048
          case '${SYSTEM_PROMPT}':
            return systemPrompt ?? ''
          case '${USER_MESSAGE}':
            return userMessage ?? ''
          case '${MODEL}':
            return cfg.model ?? ''
          default:
            return obj
              .replace(/\${MESSAGES}/g, JSON.stringify(messages.map(m => ({ role: m.role, content: m.content }))))
              .replace(/\${TEMPERATURE}/g, String(options?.temperature ?? 0.7))
              .replace(/\${MAX_TOKENS}/g, String(options?.maxTokens ?? 2048))
              .replace(/\${SYSTEM_PROMPT}/g, systemPrompt ?? '')
              .replace(/\${USER_MESSAGE}/g, userMessage ?? '')
              .replace(/\${MODEL}/g, cfg.model ?? '')
        }
      } else if (Array.isArray(obj)) {
        return obj.map(replaceValues)
      } else if (obj !== null && typeof obj === 'object') {
        const result: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(obj)) {
          result[k] = replaceValues(v)
        }
        return result
      }
      return obj
    }

    return replaceValues(body)
  }

  private extractResponse(data: Record<string, unknown>, path: string): string {
    if (!path) {
      if (typeof data === 'string') return data
      if (data.content) return String(data.content)
      if (data.choices?.[0]?.message?.content) return String((data.choices as any[])[0].message.content)
      return JSON.stringify(data)
    }

    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
    let current: unknown = data

    for (const part of parts) {
      if (current === null || current === undefined) return ''
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[part]
      } else {
        return ''
      }
    }

    return String(current ?? '')
  }
}
