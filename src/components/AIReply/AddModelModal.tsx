import { useState, useEffect } from 'react'
import { X, XCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { useAIReplyStore } from '../../stores/aiReplyStore'
import type { ModelConfig, ModelType } from '../../types/ai-reply'
import ModelSelector from './ModelSelector'
import './AddModelModal.scss'

interface AddModelModalProps {
  open: boolean
  onClose: () => void
  editModel?: ModelConfig | null
}

const PRESETS: Record<string, { label: string; baseUrl: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  modelscope: { label: 'ModelScope (魔搭)', baseUrl: 'https://api-inference.modelscope.cn/v1' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  siliconflow: { label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1' },
  zhipu: { label: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  moonshot: { label: 'Moonshot (月之暗面)', baseUrl: 'https://api.moonshot.cn/v1' },
}

export default function AddModelModal({ open, onClose, editModel }: AddModelModalProps) {
  const store = useAIReplyStore()
  const isEdit = !!editModel
  const [type, setType] = useState<ModelType>('ollama')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('deepseek-r1:7b')
  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(2048)
  const [customUrl, setCustomUrl] = useState('')
  const [customMethod, setCustomMethod] = useState<'POST' | 'GET'>('POST')
  const [customHeaders, setCustomHeaders] = useState('{}')
  const [customBodyTemplate, setCustomBodyTemplate] = useState('{"messages":"${MESSAGES}","temperature":"${TEMPERATURE}","max_tokens":"${MAX_TOKENS}"}')
  const [customResponsePath, setCustomResponsePath] = useState('choices.0.message.content')
  const [preset, setPreset] = useState<string>('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [addError, setAddError] = useState('')

  useEffect(() => {
    if (open && editModel) {
      setType(editModel.type)
      setName(editModel.name)
      const cfg = editModel.config as any
      setBaseUrl(cfg.baseUrl || '')
      setApiKey(cfg.apiKey || '')
      setModel(cfg.model || '')
      setTemperature(cfg.temperature ?? 0.7)
      setMaxTokens(cfg.maxTokens ?? 2048)
      if (editModel.type === 'custom') {
        setCustomUrl(cfg.url || '')
        setCustomMethod(cfg.method || 'POST')
        setCustomHeaders(cfg.headers ? JSON.stringify(cfg.headers) : '{}')
        setCustomBodyTemplate(cfg.bodyTemplate ? JSON.stringify(cfg.bodyTemplate) : '{"messages":"${MESSAGES}","temperature":"${TEMPERATURE}","max_tokens":"${MAX_TOKENS}"}')
        setCustomResponsePath(cfg.responsePath || 'choices.0.message.content')
      }
    } else if (open) {
      setType('ollama')
      setName('')
      setBaseUrl('http://localhost:11434')
      setApiKey('')
      setModel('deepseek-r1:7b')
      setTemperature(0.7)
      setMaxTokens(2048)
      setCustomUrl('')
      setCustomMethod('POST')
      setCustomHeaders('{}')
      setCustomBodyTemplate('{"messages":"${MESSAGES}","temperature":"${TEMPERATURE}","max_tokens":"${MAX_TOKENS}"}')
      setCustomResponsePath('choices.0.message.content')
      setPreset('')
    }
    setAddError('')
    setTestResult(null)
  }, [open, editModel])

  if (!open) return null

  const handleSubmit = async () => {
    if (!name.trim() || !model.trim()) return
    setSubmitting(true)
    setAddError('')
    try {
      let config: any
      if (type === 'ollama') {
        config = { baseUrl, model, temperature, maxTokens }
      } else if (type === 'custom') {
        let parsedHeaders = {}
        let parsedBodyTemplate = {}
        try {
          parsedHeaders = JSON.parse(customHeaders)
        } catch {
          setAddError('请求头 JSON 格式错误')
          setSubmitting(false)
          return
        }
        try {
          parsedBodyTemplate = JSON.parse(customBodyTemplate)
        } catch {
          setAddError('请求体模板 JSON 格式错误')
          setSubmitting(false)
          return
        }
        if (!customUrl.trim()) {
          setAddError('自定义 API 地址不能为空')
          setSubmitting(false)
          return
        }
        config = {
          url: customUrl.trim(),
          method: customMethod,
          headers: parsedHeaders,
          bodyTemplate: parsedBodyTemplate,
          responsePath: customResponsePath.trim()
        }
      } else {
        config = { apiKey, baseUrl, model, temperature, maxTokens }
      }

      const modelConfig: ModelConfig = {
        id: isEdit ? editModel!.id : `${type}-${Date.now()}`,
        name: name.trim(),
        type,
        enabled: true,
        config
      }

      await store.addModel(modelConfig)

      if (!store.activeModelId) {
        await store.setActiveModel(modelConfig.id)
      }

      onClose()
    } catch (e: any) {
      setAddError(e.message || (isEdit ? '编辑模型失败' : '添加模型失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleTypeChange = (t: ModelType) => {
    setType(t)
    setPreset('')
    setTestResult(null)
    if (t === 'ollama') setBaseUrl('http://localhost:11434')
    else if (t === 'openai') setBaseUrl('https://api.openai.com/v1')
    else if (t === 'claude') setBaseUrl('https://api.anthropic.com/v1')
    else if (t === 'gemini') setBaseUrl('https://generativelanguage.googleapis.com/v1beta')
    else setBaseUrl('')
  }

  const handlePresetChange = (p: string) => {
    setPreset(p)
    setTestResult(null)
    if (PRESETS[p]) {
      setBaseUrl(PRESETS[p].baseUrl)
    }
  }

  const handleTestConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const tempConfig: any = {
        id: `_test_${type}`,
        name: `_test_${type}`,
        type,
        enabled: true,
        config: type === 'ollama'
          ? { baseUrl, model: model || 'test', temperature: 0.7, maxTokens: 1 }
          : type === 'custom'
            ? { url: customUrl, method: customMethod, headers: JSON.parse(customHeaders || '{}'), bodyTemplate: JSON.parse(customBodyTemplate || '{}'), responsePath: customResponsePath }
            : { apiKey, baseUrl, model: model || 'test', temperature: 0.7, maxTokens: 1 }
      }
      const result = await window.electronAPI?.aiReply?.testModelWithConfig(tempConfig)
      if (result) {
        setTestResult(result)
      } else {
        setTestResult({ success: false, message: '测试接口不可用' })
      }
    } catch (e: any) {
      setTestResult({ success: false, message: e.message || '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  const canSubmit = name.trim() && !submitting &&
    (type === 'custom' ? customUrl.trim() : model.trim())

  return (
    <div className="add-model-overlay" onClick={handleOverlayClick}>
      <div className="add-model-modal">
        <div className="modal-header">
          <h3>{isEdit ? '编辑模型' : '添加模型'}</h3>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label>模型类型</label>
            <select value={type} onChange={e => handleTypeChange(e.target.value as ModelType)} disabled={isEdit}>
              <option value="ollama">Ollama (本地)</option>
              <option value="openai">OpenAI 兼容</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="custom">自定义 API</option>
            </select>
          </div>
          <div className="form-group">
            <label>名称</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="例如: DeepSeek R1" />
          </div>
          {type === 'openai' && (
            <div className="form-group">
              <label>预设服务</label>
              <select value={preset} onChange={e => handlePresetChange(e.target.value)}>
                <option value="">自定义地址</option>
                {Object.entries(PRESETS).map(([key, val]) => (
                  <option key={key} value={key}>{val.label}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group">
            <label>API 地址</label>
            <input value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setPreset(''); setTestResult(null) }}
              placeholder={type === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'} />
          </div>
          {type === 'custom' && (
            <>
              <div className="form-group">
                <label>自定义 API URL</label>
                <input value={customUrl} onChange={e => setCustomUrl(e.target.value)}
                  placeholder="https://your-api.com/v1/chat/completions" />
              </div>
              <div className="form-group">
                <label>请求方法</label>
                <select value={customMethod} onChange={e => setCustomMethod(e.target.value as 'POST' | 'GET')}>
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                </select>
              </div>
              <div className="form-group">
                <label>请求头 (JSON)</label>
                <input value={customHeaders} onChange={e => setCustomHeaders(e.target.value)}
                  placeholder='{"Authorization": "Bearer xxx", "Content-Type": "application/json"}' />
              </div>
              <div className="form-group">
                <label>请求体模板 (JSON)</label>
                <textarea value={customBodyTemplate} onChange={e => setCustomBodyTemplate(e.target.value)}
                  rows={4} placeholder='{"messages": "${MESSAGES}", "temperature": "${TEMPERATURE}", "max_tokens": "${MAX_TOKENS}"}' />
              </div>
              <div className="form-group">
                <label>响应路径</label>
                <input value={customResponsePath} onChange={e => setCustomResponsePath(e.target.value)}
                  placeholder="choices.0.message.content" />
              </div>
            </>
          )}
          {type !== 'ollama' && type !== 'custom' && (
            <div className="form-group">
              <label>API Key</label>
              <input type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setTestResult(null) }}
                placeholder={preset === 'modelscope' ? 'ms-xxxx (ModelScope Access Token)' : 'sk-...'} />
            </div>
          )}
          {type !== 'custom' && (
            <div className="form-group">
              <label>模型名称</label>
              <ModelSelector
                type={type}
                baseUrl={baseUrl}
                apiKey={apiKey}
                value={model}
                onChange={setModel}
              />
            </div>
          )}
          <div className="form-row">
            <div className="form-group">
              <label>Temperature</label>
              <input type="number" min="0" max="2" step="0.1" value={temperature}
                onChange={e => setTemperature(parseFloat(e.target.value))} />
            </div>
            <div className="form-group">
              <label>Max Tokens</label>
              <input type="number" min="1" max="32768" value={maxTokens}
                onChange={e => setMaxTokens(parseInt(e.target.value))} />
            </div>
          </div>
        </div>

        {testResult && (
          <div className={`test-result-inline ${testResult.success ? 'success' : 'error'}`}>
            {testResult.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            <span>{testResult.message}</span>
          </div>
        )}
        {addError && (
          <div className="add-model-error">
            <XCircle size={14} />
            <span>{addError}</span>
          </div>
        )}

        <div className="modal-footer">
          <button className="btn" onClick={handleTestConnection}
            disabled={testing || !baseUrl.trim() || (type !== 'ollama' && type !== 'custom' && !apiKey.trim())}>
            {testing ? <><Loader2 size={14} className="spin" /> 测试中...</> : '测试连接'}
          </button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? (isEdit ? '保存中...' : '添加中...') : (isEdit ? '保存' : '添加')}
          </button>
        </div>
      </div>
    </div>
  )
}
