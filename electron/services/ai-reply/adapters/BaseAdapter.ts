import type {
  ModelConfig,
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  TestResult,
  ModelInfo,
  OllamaConfig,
  OpenAICompatibleConfig,
  CustomAPIConfig
} from '../../../../src/types/ai-reply'

export abstract class BaseAdapter {
  protected config: ModelConfig

  constructor(config: ModelConfig) {
    this.config = config
  }

  abstract generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult>
  abstract testConnection(): Promise<TestResult>
  abstract fetchAvailableModels(): Promise<{ id: string; name: string; isLocal: boolean }[]>

  validateConfig(): boolean {
    return !!this.config.id && !!this.config.name && !!this.config.type
  }

  getModelInfo(): ModelInfo {
    const isLocal = this.config.type === 'ollama'
    return {
      id: this.config.id,
      name: this.config.name,
      type: this.config.type,
      isLocal
    }
  }

  get id(): string {
    return this.config.id
  }

  get type(): string {
    return this.config.type
  }

  updateConfig(config: ModelConfig): void {
    this.config = config
  }

  protected getOllamaConfig(): OllamaConfig {
    return this.config.config as OllamaConfig
  }

  protected getOpenAIConfig(): OpenAICompatibleConfig {
    return this.config.config as OpenAICompatibleConfig
  }

  protected getCustomConfig(): CustomAPIConfig {
    return this.config.config as CustomAPIConfig
  }
}
