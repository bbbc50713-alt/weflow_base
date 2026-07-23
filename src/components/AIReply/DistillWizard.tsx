import { useState, useEffect, useCallback } from 'react'
import { X, ChevronRight, ChevronLeft, Loader2, CheckCircle2, Search } from 'lucide-react'
import { useAIReplyStore } from '../../stores/aiReplyStore'
import ContactPicker from './ContactPicker'
import TimeRangeSlider from './TimeRangeSlider'
import ModelSelector from './ModelSelector'
import type { Skill, DistillProgress, ModelType, ModelConfig } from '../../types/ai-reply'
import './DistillWizard.scss'

interface DistillWizardProps {
  open: boolean
  onClose: () => void
  onCompleted: (skill: Skill) => void
}

type WizardStep = 1 | 2 | 3 | 4

const STEPS = [
  { num: 1, label: '选择好友' },
  { num: 2, label: '聊天记录范围' },
  { num: 3, label: '蒸馏配置' },
  { num: 4, label: '蒸馏进行中' }
]

export default function DistillWizard({ open, onClose, onCompleted }: DistillWizardProps) {
  const store = useAIReplyStore()
  const [step, setStep] = useState<WizardStep>(1)
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([])
  const [messageLimit, setMessageLimit] = useState(500)
  const [useTimeRange, setUseTimeRange] = useState(false)
  const [timeRange, setTimeRange] = useState<[number, number]>([0, 23])
  const [useExistingModel, setUseExistingModel] = useState(true)
  const [selectedModelId, setSelectedModelId] = useState('')
  const [modelType, setModelType] = useState<ModelType>('openai')
  const [modelBaseUrl, setModelBaseUrl] = useState('https://api.openai.com/v1')
  const [modelApiKey, setModelApiKey] = useState('')
  const [modelName, setModelName] = useState('gpt-4o')
  const [distillDepth, setDistillDepth] = useState(3)
  const [distillDimensions, setDistillDimensions] = useState(5)
  const [skillName, setSkillName] = useState('')
  const [schemaVersion, setSchemaVersion] = useState<'v1' | 'v2'>('v2')
  const [enableTripleVerification, setEnableTripleVerification] = useState(true)
  const [progress, setProgress] = useState<DistillProgress | null>(null)
  const [taskId, setTaskId] = useState('')
  const [error, setError] = useState('')
  const [completedSkill, setCompletedSkill] = useState<Skill | null>(null)

  useEffect(() => {
    if (store.models.length > 0 && !selectedModelId) {
      const active = store.models.find((m: any) => m.id === store.activeModelId)
      setSelectedModelId(active ? active.id : store.models[0].id)
    }
  }, [store.models, store.activeModelId, selectedModelId])

  useEffect(() => {
    if (open) {
      setStep(1)
      setSelectedContactIds([])
      setMessageLimit(500)
      setUseTimeRange(false)
      setTimeRange([0, 23])
      setUseExistingModel(true)
      setDistillDepth(3)
      setDistillDimensions(5)
      setSkillName('')
      setProgress(null)
      setTaskId('')
      setError('')
      setCompletedSkill(null)
    }
  }, [open])

  const pollProgress = useCallback(async () => {
    if (!taskId) return
    try {
      const p = await window.electronAPI?.aiReply?.getDistillProgress(taskId)
      if (p) {
        setProgress(p as DistillProgress)
        if ((p as DistillProgress).status === 'completed') {
          const result = await window.electronAPI?.aiReply?.getDistillResult(taskId)
          if (result) {
            setCompletedSkill(result as Skill)
          } else {
            setError('蒸馏完成但获取结果失败')
          }
        } else if ((p as DistillProgress).status === 'error') {
          setError((p as DistillProgress).error || '蒸馏过程中发生错误')
        }
      }
    } catch (e: any) {
      console.error('[DistillWizard] pollProgress error:', e)
    }
  }, [taskId])

  useEffect(() => {
    if (step !== 4 || !taskId) return
    pollProgress()
    const unsubscribe = window.electronAPI?.aiReply?.onDistillProgress?.((progress: any) => {
      if (progress.taskId === taskId) {
        setProgress(progress as DistillProgress)
        if (progress.status === 'completed') {
          window.electronAPI?.aiReply?.getDistillResult(taskId).then((result: any) => {
            if (result) {
              setCompletedSkill(result as Skill)
            } else {
              setError('蒸馏完成但获取结果失败')
            }
          })
        } else if (progress.status === 'error') {
          setError(progress.error || '蒸馏过程中发生错误')
        }
      }
    })
    const interval = setInterval(pollProgress, 5000)
    return () => {
      clearInterval(interval)
      if (unsubscribe) unsubscribe()
    }
  }, [step, taskId, pollProgress])

  if (!open) return null

  const canNext = () => {
    if (step === 1) return selectedContactIds.length > 0
    if (step === 2) return messageLimit > 0
    if (step === 3) {
      if (!skillName) return false
      if (useExistingModel) return !!selectedModelId
      return !!modelName
    }
    return false
  }

  const handleStartDistill = async () => {
    setError('')
    try {
      let distillModelId = ''

      if (useExistingModel) {
        distillModelId = selectedModelId
      } else {
        const newModel: ModelConfig = {
          id: `${modelType}-${Date.now()}`,
          name: `${skillName} - 蒸馏模型`,
          type: modelType,
          enabled: true,
          config: modelType === 'ollama'
            ? { baseUrl: modelBaseUrl, model: modelName, temperature: 0.7, maxTokens: 4096 }
            : { apiKey: modelApiKey, baseUrl: modelBaseUrl, model: modelName, temperature: 0.7, maxTokens: 4096 }
        }
        await store.addModel(newModel)
        await store.setActiveModel(newModel.id)
        distillModelId = newModel.id
      }

      const id = await window.electronAPI?.aiReply?.startDistill({
        contactIds: selectedContactIds,
        messageLimit,
        useTimeRange,
        timeRange: useTimeRange ? timeRange : undefined,
        modelId: distillModelId,
        depth: distillDepth,
        dimensions: distillDimensions,
        skillName,
        schemaVersion,
        enableTripleVerification: schemaVersion === 'v2' ? enableTripleVerification : false
      })
      if (id && !(id as any).error) {
        setTaskId(id as string)
        setStep(4)
      } else if (id && (id as any).error) {
        setError((id as any).error || '启动蒸馏失败')
      } else if (!id) {
        setError('启动蒸馏失败：未获取到任务ID')
      }
    } catch (e: any) {
      setError(e.message || '启动蒸馏失败')
    }
  }

  const handleSave = async () => {
    if (!completedSkill) return
    try {
      const saved = await window.electronAPI?.aiReply?.saveDistillSkill(taskId)
      if (saved && !(saved as any).error) {
        onCompleted(saved as Skill)
        onClose()
      } else if (saved && (saved as any).error) {
        setError((saved as any).error)
      }
    } catch (e: any) {
      setError(e.message || '保存失败')
    }
  }

  const handleCancelDistill = async () => {
    if (taskId) {
      try {
        await window.electronAPI?.aiReply?.cancelDistill(taskId)
      } catch {}
    }
    onClose()
  }

  return (
    <div className="distill-overlay" onClick={onClose}>
      <div className="distill-wizard" onClick={e => e.stopPropagation()}>
        <div className="wizard-header">
          <h3>蒸馏好友角色</h3>
          <button className="dialog-close" onClick={step === 4 ? handleCancelDistill : onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="wizard-steps">
          {STEPS.map((s: any) => (
            <div key={s.num} className={`wizard-step ${step >= s.num ? 'active' : ''} ${step > s.num ? 'done' : ''}`}>
              <span className="step-num">{step > s.num ? <CheckCircle2 size={16} /> : s.num}</span>
              <span className="step-label">{s.label}</span>
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {step === 1 && (
            <div className="step-content">
              <div className="step-title">选择要蒸馏的好友</div>
              <div className="step-desc">选择一个或多个好友，将根据与他们的聊天记录蒸馏出角色特征</div>
              <ContactPicker
                selectedIds={selectedContactIds}
                onChange={setSelectedContactIds}
              />
            </div>
          )}

          {step === 2 && (
            <div className="step-content">
              <div className="step-title">选择聊天记录范围</div>
              <div className="form-group">
                <label>消息数量限制</label>
                <input
                  type="number"
                  min={50}
                  max={10000}
                  value={messageLimit}
                  onChange={e => setMessageLimit(parseInt(e.target.value) || 500)}
                />
              </div>
              <div className="form-group">
                <label className="toggle-label-row">
                  <span>使用时间范围</span>
                  <input type="checkbox" checked={useTimeRange} onChange={e => setUseTimeRange(e.target.checked)} />
                </label>
              </div>
              {useTimeRange && (
                <div className="form-group">
                  <label>时间范围</label>
                  <TimeRangeSlider value={timeRange} onChange={setTimeRange} />
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="step-content">
              <div className="step-title">蒸馏配置</div>

              {store.models.length > 0 && (
                <div className="form-group">
                  <label className="toggle-label-row">
                    <span>使用已配置模型</span>
                    <input type="checkbox" checked={useExistingModel} onChange={e => setUseExistingModel(e.target.checked)} />
                  </label>
                </div>
              )}

              {useExistingModel && store.models.length > 0 ? (
                <div className="form-group">
                  <label>选择模型</label>
                  <select value={selectedModelId} onChange={e => setSelectedModelId(e.target.value)}>
                    {store.models.map((m: any) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.type})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label>模型类型</label>
                    <select value={modelType} onChange={e => setModelType(e.target.value as ModelType)}>
                      <option value="ollama">Ollama</option>
                      <option value="openai">OpenAI 兼容</option>
                      <option value="claude">Claude</option>
                      <option value="gemini">Gemini</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>API 地址</label>
                    <input value={modelBaseUrl} onChange={e => setModelBaseUrl(e.target.value)} />
                  </div>
                  {modelType !== 'ollama' && (
                    <div className="form-group">
                      <label>API Key</label>
                      <input type="password" value={modelApiKey} onChange={e => setModelApiKey(e.target.value)} />
                    </div>
                  )}
                  <div className="form-group">
                    <label>模型名称</label>
                    <ModelSelector
                      type={modelType}
                      baseUrl={modelBaseUrl}
                      apiKey={modelApiKey}
                      value={modelName}
                      onChange={setModelName}
                    />
                  </div>
                </>
              )}

              <div className="form-row">
                <div className="form-group">
                  <label>蒸馏深度</label>
                  <input type="number" min={1} max={10} value={distillDepth} onChange={e => setDistillDepth(parseInt(e.target.value) || 3)} />
                </div>
                <div className="form-group">
                  <label>蒸馏维度</label>
                  <input type="number" min={1} max={20} value={distillDimensions} onChange={e => setDistillDimensions(parseInt(e.target.value) || 5)} />
                </div>
              </div>
              <div className="form-group">
                <label>蒸馏架构</label>
                <select value={schemaVersion} onChange={e => setSchemaVersion(e.target.value as 'v1' | 'v2')}>
                  <option value="v2">V2 五层人格架构（推荐）</option>
                  <option value="v1">V1 传统架构</option>
                </select>
                <small className="form-hint">
                  {schemaVersion === 'v2'
                    ? '五层架构：硬规则→身份→表达→决策→人际，更精准地还原人格特征'
                    : '传统六轮串行蒸馏架构'}
                </small>
              </div>
              {schemaVersion === 'v2' && (
                <div className="form-group">
                  <label className="toggle-label-row">
                    <span>启用三重验证</span>
                    <input type="checkbox" checked={enableTripleVerification} onChange={e => setEnableTripleVerification(e.target.checked)} />
                  </label>
                  <small className="form-hint">
                    对提取的特征进行跨域复现、生成力、排他性三重验证，确保蒸馏质量（增加2轮AI调用）
                  </small>
                </div>
              )}
              <div className="form-group">
                <label>角色名称</label>
                <input value={skillName} onChange={e => setSkillName(e.target.value)} placeholder="为蒸馏出的角色命名" />
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="step-content">
              <div className="step-title">
                {completedSkill ? '蒸馏完成' : '蒸馏进行中...'}
              </div>
              {progress && !completedSkill && (
                <div className="distill-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${progress.totalRounds > 0 ? Math.round((progress.currentRound / progress.totalRounds) * 100) : 0}%` }} />
                  </div>
                  <div className="progress-info">
                    <span>{progress.status === 'preparing' ? '准备中...' : progress.status === 'distilling' ? '蒸馏中...' : progress.status === 'validating' ? '验证中...' : progress.status === 'error' ? '出错了' : progress.status}</span>
                    <span>{progress.totalRounds > 0 ? Math.round((progress.currentRound / progress.totalRounds) * 100) : 0}%</span>
                  </div>
                  <div className="progress-steps">
                    轮次 {progress.currentRound}/{progress.totalRounds}
                    {progress.roundResults.filter((r: any) => r.status === 'running').length > 0 && (
                      <span>{(() => {
                        const name = progress.roundResults.find((r: any) => r.status === 'running')?.name || ''
                        const nameMap: Record<string, string> = {
                          expressionDNA: '表达DNA提取',
                          mentalModels: '思维模式分析',
                          decisionHeuristics: '决策启发提取',
                          valuesAndAntiPatterns: '价值观与反模式',
                          honestyBoundaries: '坦诚边界分析',
                          layer0_hardRules: '硬规则提取',
                          layer1_identity: '身份认知分析',
                          layer2_expressionStyle: '表达风格分析',
                          layer3_decisionJudgment: '决策判断分析',
                          layer4_interpersonalBehavior: '人际行为分析',
                          tripleVerification: '三重验证',
                          skillSynthesis: '角色合成',
                          validation: '验证与整合'
                        }
                        return nameMap[name] || name
                      })()}</span>
                    )}
                  </div>
                  {progress.tokenUsage.totalTokens > 0 && (
                    <div className="progress-tokens">
                      Token 消耗: {progress.tokenUsage.totalTokens.toLocaleString()}
                    </div>
                  )}
                  <div className="round-details">
                    {progress.roundResults.map((r, i) => (
                      <div key={i} className={`round-item ${r.status}`}>
                        <span className="round-num">{i + 1}</span>
                        <span className="round-name">{(() => {
                          const nameMap: Record<string, string> = {
                            expressionDNA: '表达DNA',
                            mentalModels: '思维模式',
                            decisionHeuristics: '决策启发',
                            valuesAndAntiPatterns: '价值观',
                            honestyBoundaries: '坦诚边界',
                            layer0_hardRules: '硬规则',
                            layer1_identity: '身份',
                            layer2_expressionStyle: '表达风格',
                            layer3_decisionJudgment: '决策判断',
                            layer4_interpersonalBehavior: '人际行为',
                            tripleVerification: '三重验证',
                            skillSynthesis: '角色合成',
                            validation: '验证'
                          }
                          return nameMap[r.name] || r.name
                        })()}</span>
                        <span className="round-status">
                          {r.status === 'pending' ? '⏳' : r.status === 'running' ? '🔄' : r.status === 'completed' ? '✅' : '❌'}
                        </span>
                        {r.durationMs != null && r.status === 'completed' && (
                          <span className="round-duration">{(r.durationMs / 1000).toFixed(1)}s</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {progress.roundResults.some((r: any) => r.status === 'error') && (
                    <div className="progress-warning">
                      部分轮次失败（{progress.roundResults.filter((r: any) => r.status === 'error').length}/{progress.totalRounds}），将继续尝试后续步骤
                    </div>
                  )}
                </div>
              )}
              {completedSkill && (
                <div className="distill-result">
                  <CheckCircle2 size={48} className="result-icon" />
                  <h4>{completedSkill.name}</h4>
                  <p>{completedSkill.description}</p>
                  {completedSkill.qualityScore && (
                    <div className="quality-score">
                      <div className="quality-overall">
                        质量评分: <strong>{Math.round(completedSkill.qualityScore.overall * 100)}</strong>/100
                      </div>
                      <div className="quality-details">
                        <span>一致性 {Math.round(completedSkill.qualityScore.consistency * 100)}</span>
                        <span>准确性 {Math.round(completedSkill.qualityScore.accuracy * 100)}</span>
                        <span>完整性 {Math.round(completedSkill.qualityScore.completeness * 100)}</span>
                        <span>验证 {completedSkill.qualityScore.verifiedFeatureCount}/{completedSkill.qualityScore.totalCandidateCount}</span>
                      </div>
                    </div>
                  )}
                  <div className="result-tags">
                    {(completedSkill.persona?.identity?.tags || []).map((tag, i) => (
                      <span key={i} className="result-tag">{tag}</span>
                    ))}
                    {completedSkill.personaV2 && (
                      <>
                        {completedSkill.personaV2.layer2_expressionStyle?.catchphrases?.slice(0, 5).map((tag, i) => (
                          <span key={`cp-${i}`} className="result-tag accent">{tag}</span>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              )}
              {error && <div className="distill-error">{error}</div>}
            </div>
          )}
        </div>

        <div className="wizard-footer">
          {step > 1 && step < 4 && (
            <button className="btn btn-secondary" onClick={() => setStep((step - 1) as WizardStep)}>
              <ChevronLeft size={16} /> 上一步
            </button>
          )}
          <div className="footer-spacer" />
          {step < 3 && (
            <button className="btn btn-primary" disabled={!canNext()} onClick={() => setStep((step + 1) as WizardStep)}>
              下一步 <ChevronRight size={16} />
            </button>
          )}
          {step === 3 && (
            <button className="btn btn-primary" disabled={!canNext()} onClick={handleStartDistill}>
              开始蒸馏
            </button>
          )}
          {step === 4 && completedSkill && (
            <button className="btn btn-primary" onClick={handleSave}>
              保存角色
            </button>
          )}
          {step === 4 && !completedSkill && (
            <button className="btn btn-secondary" onClick={handleCancelDistill}>
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
