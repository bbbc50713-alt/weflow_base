import { useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import type { ModelType, ModelInfo } from '../../types/ai-reply'
import './ModelSelector.scss'

interface ModelSelectorProps {
  type: ModelType
  baseUrl: string
  apiKey?: string
  value: string
  onChange: (v: string) => void
}

export default function ModelSelector({ type, baseUrl, apiKey, value, onChange }: ModelSelectorProps) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [error, setError] = useState('')

  const fetchModels = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await window.electronAPI?.aiReply?.fetchAvailableModels(type, baseUrl, apiKey) || []
      setModels(result as ModelInfo[])
      setShowDropdown(true)
    } catch (e: any) {
      setError(e.message || '获取模型列表失败')
    }
    setLoading(false)
  }

  const handleSelect = (modelName: string) => {
    onChange(modelName)
    setShowDropdown(false)
  }

  return (
    <div className="model-selector">
      <div className="selector-input-row">
        <input
          className="model-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="输入或选择模型名称"
        />
        <button
          className="fetch-btn"
          onClick={fetchModels}
          disabled={loading || !baseUrl}
        >
          {loading ? <Loader2 size={14} className="spin" /> : '获取列表'}
        </button>
      </div>
      {error && <div className="selector-error">{error}</div>}
      {showDropdown && models.length > 0 && (
        <div className="model-dropdown">
          <div className="dropdown-header">
            <span>可用模型 ({models.length})</span>
            <button className="dropdown-close" onClick={() => setShowDropdown(false)}>
              <ChevronDown size={14} />
            </button>
          </div>
          <div className="dropdown-list">
            {models.map(m => (
              <div
                key={m.id || m.name}
                className={`dropdown-item ${value === m.name ? 'active' : ''}`}
                onClick={() => handleSelect(m.name)}
              >
                <span className="model-name">{m.name}</span>
                {m.isLocal && <span className="local-badge">本地</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
