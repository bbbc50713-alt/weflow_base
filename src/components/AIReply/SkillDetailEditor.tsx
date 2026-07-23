import { useState, useEffect } from 'react'
import { X, Save, Eye, Shield } from 'lucide-react'
import TagInput from './TagInput'
import type { Skill, PersonaIdentity, SpeechStyle } from '../../types/ai-reply'
import './SkillDetailEditor.scss'

interface SkillDetailEditorProps {
  skill: Skill
  onSave: (skill: Skill) => void
  onCancel: () => void
}

type EditorTab = 'basic' | 'identity' | 'speech' | 'rules' | 'values' | 'memory' | 'strategy' | 'prompt' | 'personaV2'

const BASE_TABS: { id: EditorTab; label: string }[] = [
  { id: 'basic', label: '基本信息' },
  { id: 'identity', label: '身份信息' },
  { id: 'speech', label: '说话风格' },
  { id: 'rules', label: '行为规则' },
  { id: 'values', label: '核心价值观' },
  { id: 'memory', label: '重要记忆' },
  { id: 'strategy', label: '回复策略' },
  { id: 'prompt', label: '系统提示词' }
]

export default function SkillDetailEditor({ skill, onSave, onCancel }: SkillDetailEditorProps) {
  const [editData, setEditData] = useState<Skill>(JSON.parse(JSON.stringify(skill)))
  const [activeTab, setActiveTab] = useState<EditorTab>('basic')
  const [showPreview, setShowPreview] = useState(false)

  const hasPersonaV2 = Boolean(editData.personaV2)

  const editorTabs = hasPersonaV2
    ? [...BASE_TABS.slice(0, 1), { id: 'personaV2' as EditorTab, label: '五层人格' }, ...BASE_TABS.slice(1)]
    : BASE_TABS

  useEffect(() => {
    setEditData(JSON.parse(JSON.stringify(skill)))
  }, [skill])

  const updateField = <K extends keyof Skill>(key: K, value: Skill[K]) => {
    setEditData(prev => ({ ...prev, [key]: value }))
  }

  const updateIdentity = (patch: Partial<PersonaIdentity>) => {
    setEditData(prev => ({
      ...prev,
      persona: {
        ...prev.persona,
        identity: { ...prev.persona.identity, ...patch }
      }
    }))
  }

  const updateSpeechStyle = (patch: Partial<SpeechStyle>) => {
    setEditData(prev => ({
      ...prev,
      persona: {
        ...prev.persona,
        speechStyle: { ...prev.persona.speechStyle, ...patch }
      }
    }))
  }

  const updateBehavioralRule = (index: number, value: string) => {
    setEditData(prev => {
      const rules = [...prev.persona.behavioralRules]
      rules[index] = value
      return { ...prev, persona: { ...prev.persona, behavioralRules: rules } }
    })
  }

  const addBehavioralRule = () => {
    setEditData(prev => ({
      ...prev,
      persona: {
        ...prev.persona,
        behavioralRules: [...prev.persona.behavioralRules, '']
      }
    }))
  }

  const removeBehavioralRule = (index: number) => {
    setEditData(prev => ({
      ...prev,
      persona: {
        ...prev.persona,
        behavioralRules: prev.persona.behavioralRules.filter((_, i) => i !== index)
      }
    }))
  }

  const updateValue = (index: number, value: string) => {
    setEditData(prev => {
      const values = [...prev.selfMemory.values]
      values[index] = value
      return { ...prev, selfMemory: { ...prev.selfMemory, values } }
    })
  }

  const addValue = () => {
    setEditData(prev => ({
      ...prev,
      selfMemory: { ...prev.selfMemory, values: [...prev.selfMemory.values, ''] }
    }))
  }

  const removeValue = (index: number) => {
    setEditData(prev => ({
      ...prev,
      selfMemory: { ...prev.selfMemory, values: prev.selfMemory.values.filter((_, i) => i !== index) }
    }))
  }

  const updateExperience = (index: number, value: string) => {
    setEditData(prev => {
      const experiences = [...prev.selfMemory.experiences]
      experiences[index] = value
      return { ...prev, selfMemory: { ...prev.selfMemory, experiences } }
    })
  }

  const addExperience = () => {
    setEditData(prev => ({
      ...prev,
      selfMemory: { ...prev.selfMemory, experiences: [...prev.selfMemory.experiences, ''] }
    }))
  }

  const removeExperience = (index: number) => {
    setEditData(prev => ({
      ...prev,
      selfMemory: { ...prev.selfMemory, experiences: prev.selfMemory.experiences.filter((_, i) => i !== index) }
    }))
  }

  const generateSystemPrompt = () => {
    const { persona, selfMemory, replyStrategy } = editData
    let prompt = `你是${persona.identity.role}。`
    if (persona.identity.age) prompt += `年龄${persona.identity.age}岁。`
    if (persona.identity.occupation) prompt += `职业是${persona.identity.occupation}。`
    if (persona.identity.mbti) prompt += `MBTI类型为${persona.identity.mbti}。`
    prompt += `\n\n背景：${selfMemory.background}`
    if (selfMemory.values.length > 0) {
      prompt += `\n\n核心价值观：${selfMemory.values.filter(v => v).join('、')}`
    }
    if (persona.speechStyle.tone) {
      prompt += `\n\n说话风格：${persona.speechStyle.tone}`
    }
    if (persona.speechStyle.vocabulary.length > 0) {
      prompt += `\n常用词汇：${persona.speechStyle.vocabulary.join('、')}`
    }
    if (persona.speechStyle.sentencePatterns.length > 0) {
      prompt += `\n常用句式：${persona.speechStyle.sentencePatterns.join('、')}`
    }
    if (persona.speechStyle.emojiUsage) {
      prompt += `\n表情使用：${persona.speechStyle.emojiUsage}`
    }
    if (persona.behavioralRules.length > 0) {
      prompt += `\n\n行为规则：\n${persona.behavioralRules.filter(r => r).map(r => `- ${r}`).join('\n')}`
    }
    if (selfMemory.experiences.length > 0) {
      prompt += `\n\n重要经历：\n${selfMemory.experiences.filter(e => e).map(e => `- ${e}`).join('\n')}`
    }
    prompt += `\n\n回复策略：回复延迟${replyStrategy.responseDelay.min}-${replyStrategy.responseDelay.max}ms，最大长度${replyStrategy.maxReplyLength}字。`
    return prompt
  }

  return (
    <div className="skill-detail-editor">
      <div className="editor-header">
        <h3>
          编辑角色 - {editData.name}
          {hasPersonaV2 && <span className="v2-badge"><Shield size={12} /> V2</span>}
        </h3>
        <div className="editor-actions">
          <button className="btn btn-secondary" onClick={() => setShowPreview(!showPreview)}>
            <Eye size={14} /> 预览
          </button>
          <button className="btn btn-primary" onClick={() => onSave(editData)}>
            <Save size={14} /> 保存
          </button>
          <button className="btn btn-secondary" onClick={onCancel}>
            <X size={14} /> 取消
          </button>
        </div>
      </div>

      <div className="editor-tabs">
        {editorTabs.map(tab => (
          <button
            key={tab.id}
            className={`editor-tab ${activeTab === tab.id ? 'active' : ''} ${tab.id === 'personaV2' ? 'v2-tab' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="editor-content">
        {activeTab === 'basic' && (
          <div className="editor-section">
            <div className="form-group">
              <label>名称</label>
              <input value={editData.name} onChange={e => updateField('name', e.target.value)} />
            </div>
            <div className="form-group">
              <label>描述</label>
              <textarea value={editData.description} onChange={e => updateField('description', e.target.value)} rows={3} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>版本</label>
                <input value={editData.version} onChange={e => updateField('version', e.target.value)} />
              </div>
              <div className="form-group">
                <label>作者</label>
                <input value={editData.author || ''} onChange={e => updateField('author', e.target.value)} />
              </div>
            </div>
            {editData.qualityScore && (
              <div className="quality-summary">
                <label>蒸馏质量评分</label>
                <div className="quality-bars">
                  <div className="quality-bar-item">
                    <span className="quality-label">综合</span>
                    <div className="quality-bar"><div className="quality-fill" style={{ width: `${editData.qualityScore.overall * 100}%` }} /></div>
                    <span className="quality-value">{editData.qualityScore.overall}</span>
                  </div>
                  <div className="quality-bar-item">
                    <span className="quality-label">一致性</span>
                    <div className="quality-bar"><div className="quality-fill" style={{ width: `${editData.qualityScore.consistency * 100}%` }} /></div>
                    <span className="quality-value">{editData.qualityScore.consistency}</span>
                  </div>
                  <div className="quality-bar-item">
                    <span className="quality-label">准确性</span>
                    <div className="quality-bar"><div className="quality-fill" style={{ width: `${editData.qualityScore.accuracy * 100}%` }} /></div>
                    <span className="quality-value">{editData.qualityScore.accuracy}</span>
                  </div>
                  <div className="quality-bar-item">
                    <span className="quality-label">完整性</span>
                    <div className="quality-bar"><div className="quality-fill" style={{ width: `${editData.qualityScore.completeness * 100}%` }} /></div>
                    <span className="quality-value">{editData.qualityScore.completeness}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'personaV2' && editData.personaV2 && (
          <div className="editor-section persona-v2-section">
            <div className="v2-notice">
              <Shield size={14} />
              <span>五层人格数据由蒸馏自动生成，此处为只读展示。编辑下方 V1 字段不会同步到五层人格。</span>
            </div>

            <div className="v2-layer">
              <h4 className="v2-layer-title">L0 硬规则</h4>
              <div className="v2-layer-content">
                {editData.personaV2.layer0_hardRules.neverSay.length > 0 && (
                  <div className="v2-field">
                    <label>绝对不说</label>
                    <div className="v2-tags">{editData.personaV2.layer0_hardRules.neverSay.map((s, i) => <span key={i} className="v2-tag tag-danger">{s}</span>)}</div>
                  </div>
                )}
                {editData.personaV2.layer0_hardRules.neverDo.length > 0 && (
                  <div className="v2-field">
                    <label>绝对不做</label>
                    <div className="v2-tags">{editData.personaV2.layer0_hardRules.neverDo.map((s, i) => <span key={i} className="v2-tag tag-danger">{s}</span>)}</div>
                  </div>
                )}
                {editData.personaV2.layer0_hardRules.privacyBoundaries.length > 0 && (
                  <div className="v2-field">
                    <label>隐私边界</label>
                    <div className="v2-tags">{editData.personaV2.layer0_hardRules.privacyBoundaries.map((s, i) => <span key={i} className="v2-tag tag-warning">{s}</span>)}</div>
                  </div>
                )}
                {editData.personaV2.layer0_hardRules.neverSay.length === 0 && editData.personaV2.layer0_hardRules.neverDo.length === 0 && editData.personaV2.layer0_hardRules.privacyBoundaries.length === 0 && (
                  <p className="v2-empty">无数据</p>
                )}
              </div>
            </div>

            <div className="v2-layer">
              <h4 className="v2-layer-title">L1 身份</h4>
              <div className="v2-layer-content">
                <div className="v2-field"><label>角色</label><span>{editData.personaV2.layer1_identity.role || '-'}</span></div>
                <div className="v2-field"><label>自我认知</label><span>{editData.personaV2.layer1_identity.selfImage || '-'}</span></div>
                <div className="v2-field"><label>所处环境</label><span>{editData.personaV2.layer1_identity.context || '-'}</span></div>
                {editData.personaV2.layer1_identity.mbti && <div className="v2-field"><label>MBTI</label><span>{editData.personaV2.layer1_identity.mbti}</span></div>}
                {editData.personaV2.layer1_identity.culturalAffiliation.length > 0 && (
                  <div className="v2-field"><label>文化归属</label><div className="v2-tags">{editData.personaV2.layer1_identity.culturalAffiliation.map((s, i) => <span key={i} className="v2-tag">{s}</span>)}</div></div>
                )}
              </div>
            </div>

            <div className="v2-layer">
              <h4 className="v2-layer-title">L2 表达风格</h4>
              <div className="v2-layer-content">
                <div className="v2-field"><label>语气</label><span>{editData.personaV2.layer2_expressionStyle.tone || '-'}</span></div>
                <div className="v2-field"><label>幽默风格</label><span>{editData.personaV2.layer2_expressionStyle.humorStyle || '-'}</span></div>
                <div className="v2-field"><label>平均句长</label><span>{editData.personaV2.layer2_expressionStyle.sentenceLengthAvg}字</span></div>
                <div className="v2-field"><label>回复延迟模式</label><span>{editData.personaV2.layer2_expressionStyle.responseLatencyPattern || '-'}</span></div>
                {editData.personaV2.layer2_expressionStyle.catchphrases.length > 0 && (
                  <div className="v2-field"><label>口头禅</label><div className="v2-tags">{editData.personaV2.layer2_expressionStyle.catchphrases.map((s, i) => <span key={i} className="v2-tag tag-accent">{s}</span>)}</div></div>
                )}
                {editData.personaV2.layer2_expressionStyle.vocabulary.length > 0 && (
                  <div className="v2-field"><label>常用词汇</label><div className="v2-tags">{editData.personaV2.layer2_expressionStyle.vocabulary.map((s, i) => <span key={i} className="v2-tag">{s}</span>)}</div></div>
                )}
                {editData.personaV2.layer2_expressionStyle.sentencePatterns.length > 0 && (
                  <div className="v2-field"><label>句式特点</label><div className="v2-tags">{editData.personaV2.layer2_expressionStyle.sentencePatterns.map((s, i) => <span key={i} className="v2-tag">{s}</span>)}</div></div>
                )}
                {editData.personaV2.layer2_expressionStyle.emojiUsage.length > 0 && (
                  <div className="v2-field"><label>表情使用</label><div className="v2-emoji-list">{editData.personaV2.layer2_expressionStyle.emojiUsage.map((ep, i) => (
                    <span key={i} className="v2-emoji-item">{ep.emoji} <span className="v2-emoji-freq">{ep.frequency}</span>{Array.isArray(ep.contexts) && ep.contexts.length > 0 && <span className="v2-emoji-ctx">({ep.contexts.join(', ')})</span>}</span>
                  ))}</div></div>
                )}
                {editData.personaV2.layer2_expressionStyle.templateDialogues.length > 0 && (
                  <div className="v2-field v2-field-block"><label>模板对话</label><div className="v2-dialogue-list">{editData.personaV2.layer2_expressionStyle.templateDialogues.map((td, i) => (
                    <div key={i} className="v2-dialogue-item"><span className="v2-dialogue-trigger">{td.trigger}</span><span className="v2-dialogue-arrow">→</span><span className="v2-dialogue-response">{td.response}</span></div>
                  ))}</div></div>
                )}
              </div>
            </div>

            <div className="v2-layer">
              <h4 className="v2-layer-title">L3 决策判断</h4>
              <div className="v2-layer-content">
                {editData.personaV2.layer3_decisionJudgment.priorityOrdering.length > 0 && (
                  <div className="v2-field"><label>优先级</label><span>{editData.personaV2.layer3_decisionJudgment.priorityOrdering.join(' > ')}</span></div>
                )}
                <div className="v2-field"><label>风险态度</label><span>{editData.personaV2.layer3_decisionJudgment.riskTolerance || '-'}</span></div>
                {editData.personaV2.layer3_decisionJudgment.declineStrategies.length > 0 && (
                  <div className="v2-field"><label>拒绝策略</label><div className="v2-tags">{editData.personaV2.layer3_decisionJudgment.declineStrategies.map((s, i) => <span key={i} className="v2-tag tag-warning">{s}</span>)}</div></div>
                )}
                {editData.personaV2.layer3_decisionJudgment.pushbackConditions.length > 0 && (
                  <div className="v2-field"><label>推回条件</label><div className="v2-tags">{editData.personaV2.layer3_decisionJudgment.pushbackConditions.map((s, i) => <span key={i} className="v2-tag">{s}</span>)}</div></div>
                )}
              </div>
            </div>

            <div className="v2-layer">
              <h4 className="v2-layer-title">L4 人际行为</h4>
              <div className="v2-layer-content">
                <div className="v2-field"><label>对上级/长辈</label><span>{editData.personaV2.layer4_interpersonalBehavior.toSuperiors || '-'}</span></div>
                <div className="v2-field"><label>对平级/朋友</label><span>{editData.personaV2.layer4_interpersonalBehavior.toPeers || '-'}</span></div>
                <div className="v2-field"><label>对下级/晚辈</label><span>{editData.personaV2.layer4_interpersonalBehavior.toSubordinates || '-'}</span></div>
                <div className="v2-field"><label>压力下</label><span>{editData.personaV2.layer4_interpersonalBehavior.underPressure || '-'}</span></div>
                <div className="v2-field"><label>冲突中</label><span>{editData.personaV2.layer4_interpersonalBehavior.inConflict || '-'}</span></div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'identity' && (
          <div className="editor-section">
            <div className="form-group">
              <label>角色</label>
              <input value={editData.persona.identity.role} onChange={e => updateIdentity({ role: e.target.value })} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>年龄</label>
                <input type="number" value={editData.persona.identity.age || ''} onChange={e => updateIdentity({ age: e.target.value ? parseInt(e.target.value) : undefined })} />
              </div>
              <div className="form-group">
                <label>职业</label>
                <input value={editData.persona.identity.occupation || ''} onChange={e => updateIdentity({ occupation: e.target.value || undefined })} />
              </div>
            </div>
            <div className="form-group">
              <label>MBTI</label>
              <input value={editData.persona.identity.mbti || ''} onChange={e => updateIdentity({ mbti: e.target.value || undefined })} placeholder="如 INTJ" />
            </div>
            <div className="form-group">
              <label>标签</label>
              <TagInput
                tags={editData.persona.identity.tags}
                onChange={tags => updateIdentity({ tags })}
                placeholder="输入标签后回车添加"
              />
            </div>
          </div>
        )}

        {activeTab === 'speech' && (
          <div className="editor-section">
            <div className="form-group">
              <label>语气</label>
              <input value={editData.persona.speechStyle.tone} onChange={e => updateSpeechStyle({ tone: e.target.value })} />
            </div>
            <div className="form-group">
              <label>常用词汇</label>
              <TagInput
                tags={editData.persona.speechStyle.vocabulary}
                onChange={vocabulary => updateSpeechStyle({ vocabulary })}
                placeholder="输入词汇后回车添加"
              />
            </div>
            <div className="form-group">
              <label>常用句式</label>
              <TagInput
                tags={editData.persona.speechStyle.sentencePatterns}
                onChange={sentencePatterns => updateSpeechStyle({ sentencePatterns })}
                placeholder="输入句式后回车添加"
              />
            </div>
            <div className="form-group">
              <label>表情使用</label>
              <input value={editData.persona.speechStyle.emojiUsage} onChange={e => updateSpeechStyle({ emojiUsage: e.target.value })} />
            </div>
          </div>
        )}

        {activeTab === 'rules' && (
          <div className="editor-section">
            <label className="section-label">行为规则</label>
            {editData.persona.behavioralRules.map((rule, i) => (
              <div key={i} className="list-item-row">
                <input value={rule} onChange={e => updateBehavioralRule(i, e.target.value)} />
                <button className="remove-btn" onClick={() => removeBehavioralRule(i)}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <button className="add-btn" onClick={addBehavioralRule}>+ 添加规则</button>
          </div>
        )}

        {activeTab === 'values' && (
          <div className="editor-section">
            <div className="form-group">
              <label>背景</label>
              <textarea value={editData.selfMemory.background} onChange={e => setEditData(prev => ({ ...prev, selfMemory: { ...prev.selfMemory, background: e.target.value } }))} rows={3} />
            </div>
            <label className="section-label">核心价值观</label>
            {editData.selfMemory.values.map((v, i) => (
              <div key={i} className="list-item-row">
                <input value={v} onChange={e => updateValue(i, e.target.value)} />
                <button className="remove-btn" onClick={() => removeValue(i)}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <button className="add-btn" onClick={addValue}>+ 添加价值观</button>
          </div>
        )}

        {activeTab === 'memory' && (
          <div className="editor-section">
            <label className="section-label">重要经历</label>
            {editData.selfMemory.experiences.map((exp, i) => (
              <div key={i} className="list-item-row">
                <input value={exp} onChange={e => updateExperience(i, e.target.value)} />
                <button className="remove-btn" onClick={() => removeExperience(i)}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <button className="add-btn" onClick={addExperience}>+ 添加经历</button>
          </div>
        )}

        {activeTab === 'strategy' && (
          <div className="editor-section">
            <div className="form-row">
              <div className="form-group">
                <label>最小回复延迟 (ms)</label>
                <input type="number" value={editData.replyStrategy.responseDelay.min} onChange={e => setEditData(prev => ({ ...prev, replyStrategy: { ...prev.replyStrategy, responseDelay: { ...prev.replyStrategy.responseDelay, min: parseInt(e.target.value) || 0 } } }))} />
              </div>
              <div className="form-group">
                <label>最大回复延迟 (ms)</label>
                <input type="number" value={editData.replyStrategy.responseDelay.max} onChange={e => setEditData(prev => ({ ...prev, replyStrategy: { ...prev.replyStrategy, responseDelay: { ...prev.replyStrategy.responseDelay, max: parseInt(e.target.value) || 0 } } }))} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>打字速度</label>
                <input type="number" value={editData.replyStrategy.typingSpeed} onChange={e => setEditData(prev => ({ ...prev, replyStrategy: { ...prev.replyStrategy, typingSpeed: parseInt(e.target.value) || 0 } }))} />
              </div>
              <div className="form-group">
                <label>最大回复长度</label>
                <input type="number" value={editData.replyStrategy.maxReplyLength} onChange={e => setEditData(prev => ({ ...prev, replyStrategy: { ...prev.replyStrategy, maxReplyLength: parseInt(e.target.value) || 0 } }))} />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'prompt' && (
          <div className="editor-section">
            <div className="form-group">
              <label>系统提示词模板</label>
              <textarea
                value={editData.systemPromptTemplate}
                onChange={e => updateField('systemPromptTemplate', e.target.value)}
                rows={12}
                placeholder="自定义系统提示词模板，留空则自动生成"
              />
            </div>
            {showPreview && (
              <div className="prompt-preview">
                <label className="section-label">自动生成预览</label>
                <pre>{generateSystemPrompt()}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
