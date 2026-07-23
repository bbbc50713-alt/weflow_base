import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAIReplyStore } from '../stores/aiReplyStore'
import type { AIReplySenderConfig, ModelConfig, ModelType, SenderId, Skill, TriggerRules, OllamaConfig, OpenAICompatibleConfig, ReplyLog } from '../types/ai-reply'
import { DEFAULT_TRIGGER_RULES } from '../types/ai-reply'
import {
  Bot, Play, Pause, Square, Plus, Trash2, Settings, TestTube,
  MessageSquare, Zap, Users, Clock, Shield, ChevronRight,
  CheckCircle2, XCircle, Loader2, RefreshCw, Send, Sparkles,
  Brain, UserCircle, Activity, Search, Eye, Edit3, Download,
  FolderDown, FlaskConical, Pencil, Wifi, WifiOff, AlertTriangle, ArrowRight
} from 'lucide-react'
import ToggleSwitch from '../components/AIReply/ToggleSwitch'
import TagInput from '../components/AIReply/TagInput'
import TimeRangeSlider from '../components/AIReply/TimeRangeSlider'
import ContactPicker from '../components/AIReply/ContactPicker'
import ModelSelector from '../components/AIReply/ModelSelector'
import SkillImportDialog from '../components/AIReply/SkillImportDialog'
import DistillWizard from '../components/AIReply/DistillWizard'
import SkillDetailEditor from '../components/AIReply/SkillDetailEditor'
import LogDetailDialog from '../components/AIReply/LogDetailDialog'
import AddModelModal from '../components/AIReply/AddModelModal'
import ToastProvider, { useToast } from '../components/AIReply/Toast'
import './AIReplyPage.scss'

type TabId = 'dashboard' | 'models' | 'skills' | 'triggers' | 'logs'

const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'dashboard', label: '概览', icon: Activity },
  { id: 'models', label: '模型配置', icon: Brain },
  { id: 'skills', label: '角色管理', icon: UserCircle },
  { id: 'triggers', label: '触发规则', icon: Zap },
  { id: 'logs', label: '回复日志', icon: MessageSquare }
]

export default function AIReplyPage() {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard')
  const [showStartupMinimizePrompt, setShowStartupMinimizePrompt] = useState(false)
  const [showMascotWhenMinimized, setShowMascotWhenMinimized] = useState(false)
  const store = useAIReplyStore()
  const { toasts, add: addToast } = useToast()

  useEffect(() => {
    store.fetchStatus()
    store.fetchModels()
    store.fetchSkills()
    store.fetchTriggerRules()
    store.fetchDailyStats()
    store.fetchReplyLogs()
    store.fetchAutoReplyEnabled()
    store.fetchSenderConfig()
    store.fetchHanxiaomiChannelConfig()
    store.fetchSSEStatus()
    store.checkPrerequisites()
    const cleanup = store.setupListeners()
    return cleanup
  }, [])

  useEffect(() => {
    if (store.error) {
      const timer = setTimeout(() => store.clearError(), 5000)
      return () => clearTimeout(timer)
    }
  }, [store.error])

  const handleStartService = async () => {
    try {
      const result = await store.checkPrerequisites()
      if (result?.allPassed) {
        await store.start()
        setShowStartupMinimizePrompt(true)
      } else {
        const failed = (result?.checks || store.prerequisiteChecks || []).filter((c: any) => !c.passed).map((c: any) => c.name)
        store.setError?.(`无法启动：${failed.join('、')} 未满足，请先完成配置`)
      }
    } catch (e: any) {
      store.setError?.(e.message || '启动失败')
    }
  }

  const handleMinimizeAfterStart = async (showMascot = showMascotWhenMinimized) => {
    setShowStartupMinimizePrompt(false)
    try {
      if (showMascot) {
        await window.electronAPI?.window?.showXiaomiMascot?.()
      } else {
        await window.electronAPI?.window?.hideXiaomiMascot?.()
      }
      await window.electronAPI?.window?.minimizeToBackground?.()
    } catch (error) {
      console.error('小密回复启动后最小化失败:', error)
    }
  }

  return (
    <div className="ai-reply-page">
      <ToastProvider toasts={toasts} onRemove={(id) => { /* auto-removed by timer */ }} />
      {store.error && (
        <div className="error-notification">
          <XCircle size={18} />
          <span>{store.error}</span>
          <button className="close-btn" onClick={() => store.clearError()}>
            <XCircle size={16} />
          </button>
        </div>
      )}
      <div className="ai-reply-header">
        <div className="header-left">
          <Bot size={24} />
          <h2>小密回复</h2>
        </div>
        <div className="header-right">
          <SSEStatusIndicator status={store.sseStatus} error={store.sseError} serviceStatus={store.status} />
          <StatusBadge status={store.status} />
          <div className="service-controls">
            {store.status === 'stopped' && (
              <button className="btn btn-primary" onClick={handleStartService} disabled={store.isLoading}>
                {store.isLoading ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
                启动
              </button>
            )}
            {store.status === 'running' && (
              <>
                <button className="btn btn-warning" onClick={() => store.pause()}>
                  <Pause size={16} /> 暂停
                </button>
                <button className="btn btn-danger" onClick={() => store.stop()}>
                  <Square size={16} /> 停止
                </button>
              </>
            )}
            {store.status === 'paused' && (
              <>
                <button className="btn btn-primary" onClick={() => store.resume()}>
                  <Play size={16} /> 继续
                </button>
                <button className="btn btn-danger" onClick={() => store.stop()}>
                  <Square size={16} /> 停止
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="ai-reply-tabs">
        {tabs.map((tab: any) => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="ai-reply-content">
        {activeTab === 'dashboard' && <DashboardTab toast={addToast} onServiceStarted={() => setShowStartupMinimizePrompt(true)} />}
        {activeTab === 'models' && <ModelsTab toast={addToast} />}
        {activeTab === 'skills' && <SkillsTab toast={addToast} />}
        {activeTab === 'triggers' && <TriggersTab toast={addToast} />}
        {activeTab === 'logs' && <LogsTab toast={addToast} />}
      </div>

      {showStartupMinimizePrompt && (
        <div className="startup-minimize-overlay">
          <div className="startup-minimize-dialog">
            <div className="startup-minimize-icon">
              <Bot size={26} />
            </div>
            <div className="startup-minimize-copy">
              <h3>小密回复已启动</h3>
              <p>要把 WeFlow 最小化到后台继续运行吗？</p>
            </div>
            <label className="startup-minimize-option">
              <input
                type="checkbox"
                checked={showMascotWhenMinimized}
                onChange={(event) => setShowMascotWhenMinimized(event.target.checked)}
              />
              <span>同时在桌面右下角显示小密小人</span>
            </label>
            <div className="startup-minimize-actions">
              <button className="btn" onClick={() => handleMinimizeAfterStart(false)}>
                只最小化
              </button>
              <button className="btn btn-primary" onClick={() => handleMinimizeAfterStart(showMascotWhenMinimized)}>
                {showMascotWhenMinimized ? '显示小人并最小化' : '最小化到后台'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    stopped: { label: '已停止', className: 'badge-stopped' },
    running: { label: '运行中', className: 'badge-running' },
    paused: { label: '已暂停', className: 'badge-paused' },
    error: { label: '错误', className: 'badge-error' }
  }
  const c = config[status] || config.stopped
  return <span className={`status-badge ${c.className}`}>{c.label}</span>
}

function SSEStatusIndicator({ status, error, serviceStatus }: { status: string; error: string; serviceStatus: string }) {
  const config: Record<string, { icon: React.ElementType; label: string; className: string }> = {
    connected: { icon: Wifi, label: 'SSE 已连接', className: 'sse-connected' },
    connecting: { icon: Loader2, label: 'SSE 连接中...', className: 'sse-connecting' },
    disconnected: { icon: WifiOff, label: 'SSE 未连接', className: 'sse-disconnected' },
    error: { icon: AlertTriangle, label: 'SSE 连接错误', className: 'sse-error' }
  }
  const c = config[status] || config.disconnected
  const Icon = c.icon
  const label = serviceStatus === 'stopped' && status === 'disconnected' ? 'SSE 待启动' : c.label
  const tooltip = serviceStatus === 'stopped' && status === 'disconnected'
    ? '启动服务后将自动连接 SSE 接收新消息'
    : (error || c.label)
  return (
    <span className={`sse-status-indicator ${c.className}`} title={tooltip}>
      <Icon size={14} className={status === 'connecting' ? 'spin' : ''} />
      <span className="sse-label">{label}</span>
    </span>
  )
}

function PrerequisiteCheckSection() {
  const store = useAIReplyStore()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(true)
  const [checking, setChecking] = useState(false)

  const handleCheck = async () => {
    setChecking(true)
    await store.checkPrerequisites()
    setChecking(false)
  }

  useEffect(() => {
    store.checkPrerequisites()
  }, [])

  const checks = store.prerequisiteChecks
  const allPassed = store.prerequisitesAllPassed

  if (!checks || checks.length === 0) return null

  const failedCount = checks.filter((c: any) => !c.passed).length

  const handleNavigateToSettings = (configKey: string) => {
    const settingsTabMap: Record<string, string> = {
      httpApiEnabled: 'api',
      messagePushEnabled: 'api',
      httpApiToken: 'api'
    }
    const targetTab = settingsTabMap[configKey]
    if (targetTab) {
      navigate('/settings', {
        state: { initialTab: targetTab as any }
      })
    }
  }

  return (
    <div className={`prerequisite-section ${allPassed ? 'all-passed' : 'has-failures'}`}>
      <div className="prerequisite-header" onClick={() => setExpanded(!expanded)}>
        <div className="prerequisite-title">
          {allPassed ? (
            <CheckCircle2 size={18} className="icon-success" />
          ) : (
            <AlertTriangle size={18} className="icon-warning" />
          )}
          <span>{allPassed ? '所有前置条件已满足' : `${failedCount} 项前置条件未满足`}</span>
        </div>
        <div className="prerequisite-actions">
          <button
            className="btn btn-sm"
            onClick={(e) => { e.stopPropagation(); handleCheck() }}
            disabled={checking}
          >
            {checking ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
            重新检查
          </button>
          <ChevronRight size={16} className={`expand-icon ${expanded ? 'expanded' : ''}`} />
        </div>
      </div>

      {expanded && (
        <div className="prerequisite-checks">
          {checks.map((check: any, idx: number) => (
            <div key={idx} className={`prerequisite-item ${check.passed ? 'passed' : 'failed'}`}>
              <div className="check-icon">
                {check.passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
              </div>
              <div className="check-info">
                <span className="check-name">{check.name}</span>
                <span className="check-message">{check.message}</span>
              </div>
              {!check.passed && check.configKey && (
                <button
                  className="btn btn-sm btn-fix"
                  onClick={() => handleNavigateToSettings(check.configKey!)}
                >
                  去设置 <ArrowRight size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DashboardTab({
  toast,
  onServiceStarted
}: {
  toast: (msg: string, type?: 'success' | 'error' | 'info') => void
  onServiceStarted?: () => void
}) {
  const store = useAIReplyStore()
  const { dailyStats } = store
  const [, setTick] = useState(0)

  useEffect(() => {
    if (store.processingContacts.length === 0) return
    const timer = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [store.processingContacts.length])

  const handleStart = async () => {
    try {
      await store.start()
      toast('小密回复服务已启动', 'success')
      onServiceStarted?.()
    } catch (e: any) {
      toast(e.message || '启动失败', 'error')
    }
  }

  const handleToggleAutoReply = async (checked: boolean) => {
    try {
      await store.setAutoReplyEnabled(checked)
      await store.checkPrerequisites()
      toast(checked ? '自动回复发送已开启' : '自动回复发送已关闭', 'info')
    } catch (e: any) {
      toast(e.message || '操作失败', 'error')
    }
  }

  return (
    <div className="dashboard-tab">
      <PrerequisiteCheckSection />
      <div className="stats-grid">
        <div className="stat-card">
          <MessageSquare size={20} />
          <div className="stat-info">
            <span className="stat-value">{dailyStats.receivedCount}</span>
            <span className="stat-label">收到消息</span>
          </div>
        </div>
        <div className="stat-card">
          <Send size={20} />
          <div className="stat-info">
            <span className="stat-value">{dailyStats.repliedCount}</span>
            <span className="stat-label">已回复</span>
          </div>
        </div>
        <div className="stat-card">
          <Users size={20} />
          <div className="stat-info">
            <span className="stat-value">{dailyStats.activeContacts}</span>
            <span className="stat-label">活跃联系人</span>
          </div>
        </div>
        <div className="stat-card">
          <XCircle size={20} />
          <div className="stat-info">
            <span className="stat-value">{dailyStats.errorCount}</span>
            <span className="stat-label">错误数</span>
          </div>
        </div>
      </div>

      <div className="quick-info">
        <div className="info-section">
          <h3><Brain size={16} /> 当前模型</h3>
          <p>{store.models.find((m: any) => m.id === store.activeModelId)?.name || '未配置'}</p>
        </div>
        <div className="info-section">
          <h3><UserCircle size={16} /> 当前角色</h3>
          <p>{store.skills.find((s: any) => s.id === store.activeSkillId)?.name || '默认助手'}</p>
        </div>
        <div className="info-section">
          <h3><Zap size={16} /> 触发规则</h3>
          <p>{store.triggerRules.enabled ? `已启用 - ${store.triggerRules.listenMode}` : '未启用'}</p>
        </div>
        <div className="info-section">
          <h3><Send size={16} /> 自动回复发送</h3>
          <div className="auto-reply-toggle">
            <ToggleSwitch
            checked={store.autoReplyEnabled}
            onChange={handleToggleAutoReply}
          />
            <span className="toggle-label">{store.autoReplyEnabled ? '已开启' : '已关闭'}</span>
          </div>
          {store.autoReplyEnabled && window.electronAPI?.process?.platform !== 'win32' && (
            <p className="warning-text">自动回复发送仅支持 Windows 系统</p>
          )}
        </div>
      </div>

      <SenderSettingsSection toast={toast} />

      {store.messageFlow.length > 0 && (
        <div className="message-flow">
          <div className="message-flow-header">
            <Activity size={14} />
            <span>实时消息流</span>
            <button className="message-flow-clear" onClick={() => useAIReplyStore.setState({ messageFlow: [] })}>清空</button>
          </div>
          <div className="message-flow-list">
            {store.messageFlow.slice(0, 15).map((item: any, i: number) => {
              const stageConfig: Record<string, { icon: string; color: string; label: string }> = {
                received:   { icon: '📩', color: '#3b82f6', label: '收到消息' },
                buffering:  { icon: '⏳', color: '#f59e0b', label: '缓冲中' },
                trigger:    { icon: '🔍', color: '#8b5cf6', label: '触发检查' },
                skipped:    { icon: '⏭️', color: '#6b7280', label: '跳过' },
                generating: { icon: '🤖', color: '#3b82f6', label: '生成回复' },
                sending:    { icon: '📤', color: '#f59e0b', label: '发送中' },
                sent:       { icon: '✅', color: '#22c55e', label: '已发送' },
                generated:  { icon: '📝', color: '#22c55e', label: '已生成' },
                error:      { icon: '❌', color: '#ef4444', label: '出错' },
              }
              const cfg = stageConfig[item.stage] || { icon: '•', color: '#999', label: item.stage }
              const isFinal = ['sent', 'generated', 'skipped', 'error'].includes(item.stage)
              const timeStr = new Date(item.timestamp).toLocaleTimeString()
              return (
                <div key={`${item.contactId}-${item.timestamp}-${i}`} className={`flow-item ${isFinal ? 'flow-final' : 'flow-active'}`}>
                  <span className="flow-icon">{cfg.icon}</span>
                  <span className="flow-contact">{item.contactName || item.contactId}</span>
                  <span className="flow-label" style={{ color: cfg.color }}>{cfg.label}</span>
                  {item.detail && <span className="flow-detail">{item.detail}</span>}
                  <span className="flow-time">{timeStr}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {store.replyLogs.length > 0 && (
        <div className="recent-logs">
          <h3>最近回复</h3>
          {store.replyLogs.slice(-5).reverse().map((log: any) => {
            const initial = (log.contactName || '?').charAt(0)
            return (
            <div key={log.id} className={`log-item ${!log.success && log.errorMessage ? 'log-error' : ''}`} onClick={() => store.setSelectedLogDetail(log)}>
              <div className="log-header">
                <span className="log-avatar">{initial}</span>
                <span className="log-contact">{log.contactName}</span>
                {!log.success && log.errorMessage && <span className="log-status-badge log-error">失败</span>}
                {!log.sent && log.success !== false && <span className="log-status-badge log-warning">已生成</span>}
                {log.sent && <span className="log-status-badge" style={{background:'rgba(34,197,94,0.08)',color:'#16a34a'}}>已发送</span>}
                <span className="log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="log-body">
                <div className="log-received">{log.receivedMessage}</div>
                <div className="log-arrow"><ChevronRight size={14} className="log-arrow-icon" /></div>
                <div className="log-reply">{log.generatedReply || log.errorMessage}</div>
              </div>
            </div>
            )
          })}
        </div>
      )}

      <div className="quick-actions">
        <button className="btn btn-primary" onClick={handleStart} disabled={store.status === 'running'}>
          <Play size={14} /> 启动小密服务
        </button>
        <button className="btn" onClick={() => store.fetchDailyStats()}>
          <RefreshCw size={14} /> 刷新统计
        </button>
      </div>

      <LogDetailDialog log={store.selectedLogDetail} onClose={() => store.setSelectedLogDetail(null)} />
    </div>
  )
}

const senderOptions: Array<{ id: SenderId; label: string; description: string; risk: string; disabled?: boolean }> = [
  {
    id: 'ui-automation',
    label: 'Windows UI 自动化',
    description: '通过窗口搜索、剪贴板粘贴和发送热键投递，适合当前本机微信已登录的场景。',
    risk: '需要 Windows 桌面和微信窗口可访问'
  },
  {
    id: 'weclaw-http',
    label: 'WeClaw HTTP',
    description: '调用外部 WeClaw 服务发送，可做到更无感，但需要单独运行兼容的 HTTP 桥接服务。',
    risk: '依赖外部服务 /api/send 和 /health'
  },
  {
    id: 'manual',
    label: '手动确认',
    description: '只生成回复并写入日志，不会自动投递到微信。',
    risk: '不会自动发送'
  },
  {
    id: 'wechatferry',
    label: 'WeChatFerry（预留）',
    description: '接口占位，当前构建未包含可用的 WeChatFerry 发送实现。',
    risk: '当前不可用',
    disabled: true
  }
]

function SenderSettingsSection({ toast }: { toast: (msg: string, type?: 'success' | 'error' | 'info') => void }) {
  const store = useAIReplyStore()
  const { senderConfig, senderHealth, senderHealthLoading } = store
  const [saving, setSaving] = useState(false)
  const [localWeClaw, setLocalWeClaw] = useState<AIReplySenderConfig['weclawHttp']>(senderConfig.weclawHttp)

  useEffect(() => {
    setLocalWeClaw(senderConfig.weclawHttp)
  }, [
    senderConfig.weclawHttp.enabled,
    senderConfig.weclawHttp.baseUrl,
    senderConfig.weclawHttp.token,
    senderConfig.weclawHttp.timeoutMs
  ])

  const activeOption = senderOptions.find(option => option.id === senderConfig.activeSenderId) || senderOptions[0]
  const healthAvailable = senderHealth?.available === true
  const healthLabel = senderHealth
    ? healthAvailable ? '可用' : '不可用'
    : '未检查'

  const saveConfig = async (patch: Partial<AIReplySenderConfig>, successMessage: string) => {
    setSaving(true)
    try {
      await store.setSenderConfig(patch)
      toast(successMessage, 'success')
    } catch (e: any) {
      toast(e.message || '发送通道配置保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleSenderChange = async (senderId: SenderId) => {
    if (senderId === 'wechatferry') {
      toast('WeChatFerry 发送通道当前只是预留接口，暂不可用', 'error')
      return
    }

    const patch: Partial<AIReplySenderConfig> = { activeSenderId: senderId }
    if (senderId === 'weclaw-http') {
      patch.weclawHttp = { ...senderConfig.weclawHttp, enabled: true }
    }
    await saveConfig(patch, `发送通道已切换为 ${senderOptions.find(option => option.id === senderId)?.label || senderId}`)
  }

  const handleHealthCheck = async () => {
    await store.fetchSenderHealth(senderConfig.activeSenderId)
    toast('发送通道健康检查已刷新', 'info')
  }

  const saveWeClawConfig = () => {
    saveConfig({
      activeSenderId: 'weclaw-http',
      weclawHttp: {
        ...localWeClaw,
        enabled: true,
        baseUrl: localWeClaw.baseUrl.trim(),
        token: localWeClaw.token?.trim() || undefined,
        timeoutMs: Math.max(1000, Number(localWeClaw.timeoutMs) || 10000)
      }
    }, 'WeClaw HTTP 配置已保存')
  }

  return (
    <div className="sender-settings-section">
      <div className="section-header">
        <div>
          <h3><Shield size={16} /> 发送通道</h3>
          <p className="section-subtitle">选择小密回复生成后如何投递到微信；当前实际投递以健康检查和前置条件为准。</p>
        </div>
        <button className="btn btn-sm" onClick={handleHealthCheck} disabled={senderHealthLoading}>
          {senderHealthLoading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          检查通道
        </button>
      </div>

      <div className="sender-settings-grid">
        <label className="sender-field">
          <span>当前通道</span>
          <select
            value={senderConfig.activeSenderId}
            onChange={e => handleSenderChange(e.target.value as SenderId)}
            disabled={saving}
          >
            {senderOptions.map(option => (
              <option key={option.id} value={option.id} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className={`sender-health ${healthAvailable ? 'available' : 'unavailable'}`}>
          {healthAvailable ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <div>
            <strong>{healthLabel}</strong>
            <span>{senderHealth?.reason || activeOption.risk}</span>
          </div>
        </div>
      </div>

      <div className="sender-description">
        <Send size={14} />
        <span>{activeOption.description}</span>
      </div>

      {senderConfig.activeSenderId === 'ui-automation' && (
        <div className="sender-config-card">
          <label className="sender-field">
            <span>发送热键</span>
            <select
              value={senderConfig.uiAutomation.sendHotkey || 'enter'}
              onChange={e => saveConfig({
                uiAutomation: {
                  ...senderConfig.uiAutomation,
                  sendHotkey: e.target.value as 'enter' | 'ctrl-enter'
                }
              }, 'UI 自动化热键已更新')}
              disabled={saving}
            >
              <option value="enter">Enter</option>
              <option value="ctrl-enter">Ctrl + Enter</option>
            </select>
          </label>
          <label className="sender-checkbox">
            <input
              type="checkbox"
              checked={senderConfig.uiAutomation.restoreClipboard !== false}
              onChange={e => saveConfig({
                uiAutomation: {
                  ...senderConfig.uiAutomation,
                  restoreClipboard: e.target.checked
                }
              }, '剪贴板策略已更新')}
              disabled={saving}
            />
            <span>发送后恢复原剪贴板内容</span>
          </label>
          <p className="sender-note">发送前请保持微信已登录；若目标会话无法搜索到，发送器会返回失败并写入错误日志。</p>
        </div>
      )}

      {senderConfig.activeSenderId === 'weclaw-http' && (
        <div className="sender-config-card">
          <div className="sender-settings-grid">
            <label className="sender-field">
              <span>Base URL</span>
              <input
                value={localWeClaw.baseUrl}
                onChange={e => setLocalWeClaw({ ...localWeClaw, baseUrl: e.target.value })}
                placeholder="http://127.0.0.1:19888"
              />
            </label>
            <label className="sender-field">
              <span>超时（ms）</span>
              <input
                type="number"
                min={1000}
                value={localWeClaw.timeoutMs}
                onChange={e => setLocalWeClaw({ ...localWeClaw, timeoutMs: Number(e.target.value) || 10000 })}
              />
            </label>
          </div>
          <label className="sender-field">
            <span>Token（可选）</span>
            <input
              value={localWeClaw.token || ''}
              onChange={e => setLocalWeClaw({ ...localWeClaw, token: e.target.value })}
              placeholder="Bearer token，可留空"
            />
          </label>
          <div className="sender-actions">
            <button className="btn btn-primary" onClick={saveWeClawConfig} disabled={saving}>
              {saving ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              保存 WeClaw 配置
            </button>
          </div>
          <p className="sender-note">当前内置协议会调用 `GET /health` 和 `POST /api/send`，发送体包含 `to`、`text`、`type=text`、`isGroup`。</p>
        </div>
      )}

      {senderConfig.activeSenderId === 'manual' && (
        <div className="sender-config-card sender-warning-card">
          <AlertTriangle size={16} />
          <span>手动模式不会自动发送微信消息。如需只生成回复，请关闭上方“自动回复发送”开关；如需全自动，请切回 Windows UI 自动化或可用的 WeClaw HTTP。</span>
        </div>
      )}
    </div>
  )
}

function ModelsTab({ toast }: { toast: (msg: string, type?: 'success' | 'error' | 'info') => void }) {
  const store = useAIReplyStore()
  const [showAddModal, setShowAddModal] = useState(false)

  const handleRemoveModel = async (modelId: string) => {
    try {
      await store.removeModel(modelId)
      toast('模型已删除', 'success')
    } catch (e: any) {
      toast(e.message || '删除失败', 'error')
    }
  }
  const [editModel, setEditModel] = useState<ModelConfig | null>(null)

  return (
    <div className="models-tab">
      <HanxiaomiChannelSection toast={toast} />

      <div className="section-header">
        <h3>模型配置</h3>
        <button className="btn btn-primary" onClick={() => { setEditModel(null); setShowAddModal(true) }}>
          <Plus size={16} />
          添加模型
        </button>
      </div>

      <div className="model-list">
        {store.models.length === 0 ? (
          <div className="empty-state">
            <Brain size={48} />
            <p>暂无模型配置</p>
            <p className="hint">点击"添加模型"配置你的第一个 AI 模型</p>
          </div>
        ) : (
          store.models.map((model: any) => (
            <ModelCard
              key={model.id}
              model={model}
              isActive={model.id === store.activeModelId}
              onActivate={() => store.setActiveModel(model.id)}
              onRemove={() => handleRemoveModel(model.id)}
              onTest={() => store.testModel(model.id)}
              onEdit={() => { setEditModel(model); setShowAddModal(true) }}
              testResult={store.testResult}
            />
          ))
        )}
      </div>

      <AddModelModal open={showAddModal} onClose={() => { setShowAddModal(false); setEditModel(null) }} editModel={editModel} />
    </div>
  )
}

const HANXIAOMI_MAX_DELAY_MS = 24 * 60 * 60 * 1000

type HanxiaomiDeliveryPolicyForm = {
  minDelayMs?: number
  maxDelayMs?: number
  postSendGapMsMin?: number
  postSendGapMsMax?: number
  perContactCooldownMs?: number
  staleAfterMs?: number
  splitMinGapMs?: number
  splitMaxGapMs?: number
}

function normalizeHanxiaomiDelayMs(
  value: unknown,
  fallback: number,
  min = 0,
  max = HANXIAOMI_MAX_DELAY_MS
): number {
  const next = Math.floor(Number(value))
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, next))
}

function normalizeHanxiaomiDeliveryPolicyInput(
  policy?: HanxiaomiDeliveryPolicyForm
): Required<HanxiaomiDeliveryPolicyForm> {
  const minDelayMs = normalizeHanxiaomiDelayMs(policy?.minDelayMs, 8000)
  const maxDelayMs = Math.max(minDelayMs, normalizeHanxiaomiDelayMs(policy?.maxDelayMs, 45000))
  const postSendGapMsMin = normalizeHanxiaomiDelayMs(policy?.postSendGapMsMin, 8000)
  const postSendGapMsMax = Math.max(
    postSendGapMsMin,
    normalizeHanxiaomiDelayMs(policy?.postSendGapMsMax, 25000)
  )

  return {
    minDelayMs,
    maxDelayMs,
    postSendGapMsMin,
    postSendGapMsMax,
    perContactCooldownMs: normalizeHanxiaomiDelayMs(policy?.perContactCooldownMs, 60000),
    staleAfterMs: normalizeHanxiaomiDelayMs(policy?.staleAfterMs, 180000, 1000),
    splitMinGapMs: normalizeHanxiaomiDelayMs(policy?.splitMinGapMs, 2500),
    splitMaxGapMs: Math.max(
      normalizeHanxiaomiDelayMs(policy?.splitMinGapMs, 2500),
      normalizeHanxiaomiDelayMs(policy?.splitMaxGapMs, 8000)
    )
  }
}

function HanxiaomiChannelSection({ toast }: { toast: (msg: string, type?: 'success' | 'error' | 'info') => void }) {
  const store = useAIReplyStore()
  const [local, setLocal] = useState(store.hanxiaomiChannelConfig)
  const [draftForm, setDraftForm] = useState({
    contactId: '',
    contactName: '',
    scenario: 'maintenance'
  })

  useEffect(() => {
    setLocal(store.hanxiaomiChannelConfig)
  }, [
    store.hanxiaomiChannelConfig.enabled,
    store.hanxiaomiChannelConfig.serviceUrl,
    store.hanxiaomiChannelConfig.keyId,
    store.hanxiaomiChannelConfig.timeoutMs,
    store.hanxiaomiChannelConfig.signingSecret,
    store.hanxiaomiChannelConfig.identitySalt,
    store.hanxiaomiChannelConfig.inboundConcurrency,
    store.hanxiaomiChannelConfig.deliveryPolicy?.minDelayMs,
    store.hanxiaomiChannelConfig.deliveryPolicy?.maxDelayMs,
    store.hanxiaomiChannelConfig.deliveryPolicy?.postSendGapMsMin,
    store.hanxiaomiChannelConfig.deliveryPolicy?.postSendGapMsMax,
    store.hanxiaomiChannelConfig.deliveryPolicy?.perContactCooldownMs,
    store.hanxiaomiChannelConfig.deliveryPolicy?.staleAfterMs,
    store.hanxiaomiChannelConfig.deliveryPolicy?.splitMinGapMs,
    store.hanxiaomiChannelConfig.deliveryPolicy?.splitMaxGapMs
  ])

  const updateDeliveryPolicy = (
    key: keyof HanxiaomiDeliveryPolicyForm,
    value: number | boolean
  ) => {
    setLocal({
      ...local,
      deliveryPolicy: {
        ...(local.deliveryPolicy || {}),
        [key]: value
      }
    })
  }

  const save = async () => {
    try {
      await store.setHanxiaomiChannelConfig({
        ...local,
        serviceUrl: local.serviceUrl.trim(),
        keyId: local.keyId.trim(),
        signingSecret: local.signingSecret?.trim() || '',
        timeoutMs: Math.max(1000, Number(local.timeoutMs) || 15000),
        inboundConcurrency: Math.max(1, Math.min(20, Math.floor(Number(local.inboundConcurrency) || 3))),
        deliveryPolicy: normalizeHanxiaomiDeliveryPolicyInput(local.deliveryPolicy)
      })
      toast('汉小密渠道配置已保存', 'success')
    } catch (e: any) {
      toast(e.message || '保存汉小密渠道失败', 'error')
    }
  }

  const test = async () => {
    await store.testHanxiaomiChannel()
    const result = useAIReplyStore.getState().hanxiaomiTestResult
    toast(result?.message || '汉小密连接测试完成', result?.success ? 'success' : 'error')
  }

  const generateDraft = async () => {
    try {
      await store.generateHanxiaomiDraft(draftForm)
      toast('汉小密草稿已生成', 'success')
    } catch (e: any) {
      toast(e.message || '生成汉小密草稿失败', 'error')
    }
  }

  const sendDraft = async () => {
    const eventKey = store.hanxiaomiDraft?.eventKey
    if (!eventKey) return
    try {
      await store.sendHanxiaomiDraft(eventKey)
      toast('汉小密草稿已发送', 'success')
    } catch (e: any) {
      toast(e.message || '发送汉小密草稿失败', 'error')
    }
  }

  return (
    <div className="hanxiaomi-channel-section">
      <div className="section-header">
        <div>
          <h3><Sparkles size={16} /> 汉小密纯文本渠道</h3>
          <p className="section-subtitle">WeFlow 收集上下文，汉小密返回 send/draft/skip/handoff 文本，发送仍走 SenderManager。</p>
        </div>
        <div className="hanxiaomi-toggle">
          <span>{local.enabled ? '已启用' : '未启用'}</span>
          <ToggleSwitch
            checked={local.enabled}
            onChange={(enabled) => setLocal({ ...local, enabled })}
          />
        </div>
      </div>

      <div className="hanxiaomi-grid">
        <label className="sender-field">
          <span>服务地址</span>
          <input value={local.serviceUrl} onChange={e => setLocal({ ...local, serviceUrl: e.target.value })} placeholder="http://127.0.0.1:8000" />
        </label>
        <label className="sender-field">
          <span>Key ID</span>
          <input value={local.keyId} onChange={e => setLocal({ ...local, keyId: e.target.value })} placeholder="weflow-prod" />
        </label>
        <label className="sender-field">
          <span>签名密钥</span>
          <input type="password" value={local.signingSecret || ''} onChange={e => setLocal({ ...local, signingSecret: e.target.value })} placeholder="保存在系统安全存储" />
        </label>
        <label className="sender-field">
          <span>超时 ms</span>
          <input type="number" min={1000} value={local.timeoutMs} onChange={e => setLocal({ ...local, timeoutMs: Number(e.target.value) || 15000 })} />
        </label>
      </div>

      <div className="hanxiaomi-draft-box">
        <div className="section-header compact">
          <h4>队列与发送节奏</h4>
        </div>
        <p className="section-subtitle">控制汉小密生成并发和自动发送的随机等待、间隔、冷却与过期时间。</p>
        <div className="hanxiaomi-grid">
          <label className="sender-field">
            <span>生成并发</span>
            <input
              type="number"
              min={1}
              max={20}
              value={local.inboundConcurrency ?? 3}
              onChange={e => setLocal({ ...local, inboundConcurrency: Number(e.target.value) || 3 })}
            />
          </label>
          <label className="sender-field">
            <span>发送前最短等待 ms</span>
            <input
              type="number"
              min={0}
              value={local.deliveryPolicy?.minDelayMs ?? 8000}
              onChange={e => updateDeliveryPolicy('minDelayMs', Number(e.target.value) || 0)}
            />
          </label>
          <label className="sender-field">
            <span>发送前最长等待 ms</span>
            <input
              type="number"
              min={0}
              value={local.deliveryPolicy?.maxDelayMs ?? 45000}
              onChange={e => updateDeliveryPolicy('maxDelayMs', Number(e.target.value) || 0)}
            />
          </label>
          <label className="sender-field">
            <span>发送后最短间隔 ms</span>
            <input
              type="number"
              min={0}
              value={local.deliveryPolicy?.postSendGapMsMin ?? 8000}
              onChange={e => updateDeliveryPolicy('postSendGapMsMin', Number(e.target.value) || 0)}
            />
          </label>
          <label className="sender-field">
            <span>发送后最长间隔 ms</span>
            <input
              type="number"
              min={0}
              value={local.deliveryPolicy?.postSendGapMsMax ?? 25000}
              onChange={e => updateDeliveryPolicy('postSendGapMsMax', Number(e.target.value) || 0)}
            />
          </label>
          <label className="sender-field">
            <span>同联系人冷却 ms</span>
            <input
              type="number"
              min={0}
              value={local.deliveryPolicy?.perContactCooldownMs ?? 60000}
              onChange={e => updateDeliveryPolicy('perContactCooldownMs', Number(e.target.value) || 0)}
            />
          </label>
          <label className="sender-field">
            <span>回复过期时间 ms</span>
            <input
              type="number"
              min={1000}
              value={local.deliveryPolicy?.staleAfterMs ?? 180000}
              onChange={e => updateDeliveryPolicy('staleAfterMs', Number(e.target.value) || 180000)}
            />
          </label>
          <div className="sender-field sender-field-note">
            <span>后台智能分段</span>
            <p>回复由汉小密后端模型拆成 1-5 条自然微信消息；本地只控制分段之间的发送间隔，不再按标点或字数硬切。</p>
          </div>
          <label className="sender-field">
            <span>拆分最短间隔 ms</span>
            <input
              type="number"
              min={0}
              value={local.deliveryPolicy?.splitMinGapMs ?? 2500}
              onChange={e => updateDeliveryPolicy('splitMinGapMs', Number(e.target.value) || 0)}
            />
          </label>
          <label className="sender-field">
            <span>拆分最长间隔 ms</span>
            <input
              type="number"
              min={0}
              value={local.deliveryPolicy?.splitMaxGapMs ?? 8000}
              onChange={e => updateDeliveryPolicy('splitMaxGapMs', Number(e.target.value) || 0)}
            />
          </label>
        </div>
      </div>

      <div className="sender-actions">
        <button className="btn btn-primary" onClick={save}>
          <CheckCircle2 size={14} /> 保存渠道
        </button>
        <button className="btn btn-sm" onClick={test}>
          <TestTube size={14} /> 测试连接
        </button>
        {store.hanxiaomiTestResult && (
          <span className={`test-result-inline ${store.hanxiaomiTestResult.success ? 'success' : 'error'}`}>
            {store.hanxiaomiTestResult.message}
            {store.hanxiaomiTestResult.latencyMs ? ` (${store.hanxiaomiTestResult.latencyMs}ms)` : ''}
          </span>
        )}
      </div>

      <div className="hanxiaomi-draft-box">
        <div className="section-header compact">
          <h4>生成汉小密草稿</h4>
        </div>
        <div className="hanxiaomi-grid">
          <label className="sender-field">
            <span>联系人 ID</span>
            <input value={draftForm.contactId} onChange={e => setDraftForm({ ...draftForm, contactId: e.target.value })} placeholder="会话 username/contactId" />
          </label>
          <label className="sender-field">
            <span>显示名</span>
            <input value={draftForm.contactName} onChange={e => setDraftForm({ ...draftForm, contactName: e.target.value })} placeholder="可选" />
          </label>
          <label className="sender-field">
            <span>场景</span>
            <select value={draftForm.scenario} onChange={e => setDraftForm({ ...draftForm, scenario: e.target.value })}>
              <option value="maintenance">持续维护</option>
              <option value="reactivation">激活/焕活</option>
              <option value="repurchase">复购开单</option>
              <option value="new_customer">新客跟进</option>
            </select>
          </label>
        </div>
        <div className="sender-actions">
          <button className="btn btn-sm" onClick={generateDraft} disabled={!draftForm.contactId || store.isLoading}>
            {store.isLoading ? <Loader2 size={14} className="spin" /> : <Pencil size={14} />}
            生成草稿
          </button>
          {store.hanxiaomiDraft?.eventKey && (
            <button className="btn btn-primary btn-sm" onClick={sendDraft}>
              <Send size={14} /> 确认发送
            </button>
          )}
        </div>
        {store.hanxiaomiDraft?.text && (
          <div className="hanxiaomi-draft-preview">{store.hanxiaomiDraft.text}</div>
        )}
      </div>
    </div>
  )
}

function ModelCard({
  model, isActive, onActivate, onRemove, onTest, onEdit, testResult
}: {
  model: ModelConfig
  isActive: boolean
  onActivate: () => void
  onRemove: () => void
  onTest: () => void
  onEdit: () => void
  testResult: any
}) {
  return (
    <div className={`model-card ${isActive ? 'active' : ''}`}>
      <div className="model-info">
        <div className="model-header">
          <span className="model-name">{model.name}</span>
          <span className="model-type">{model.type}</span>
          {isActive && <span className="active-badge">使用中</span>}
        </div>
        <div className="model-details">
          {model.type === 'ollama' && (
            <span>{(model.config as OllamaConfig).model} @ {(model.config as OllamaConfig).baseUrl}</span>
          )}
          {['openai', 'claude', 'gemini'].includes(model.type) && (
            <span>{(model.config as OpenAICompatibleConfig).model} @ {(model.config as OpenAICompatibleConfig).baseUrl}</span>
          )}
          {model.type === 'custom' && (
            <span>自定义 API</span>
          )}
        </div>
      </div>
      <div className="model-actions">
        {!isActive && (
          <button className="btn btn-sm" onClick={onActivate}>
            <CheckCircle2 size={14} /> 启用
          </button>
        )}
        <button className="btn btn-sm" onClick={onEdit}>
          <Pencil size={14} /> 编辑
        </button>
        <button className="btn btn-sm" onClick={onTest}>
          <TestTube size={14} /> 测试
        </button>
        {!model.id.startsWith('default') && (
          <button className="btn btn-sm btn-danger" onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {testResult && (
        <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
          {testResult.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {testResult.message}
          {testResult.latencyMs && ` (${testResult.latencyMs}ms)`}
        </div>
      )}
    </div>
  )
}

function SkillsTab({ toast }: { toast: (msg: string, type?: 'success' | 'error' | 'info') => void }) {
  const store = useAIReplyStore()
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showDistillWizard, setShowDistillWizard] = useState(false)
  const [showDetailEditor, setShowDetailEditor] = useState(false)
  const [testMessage, setTestMessage] = useState('')
  const [testSkillId, setTestSkillId] = useState(store.activeSkillId)
  const [testModelId, setTestModelId] = useState(store.activeModelId)

  const handleRemoveSkill = async (skillId: string) => {
    try {
      await store.removeSkill(skillId)
      toast('角色已删除', 'success')
      if (selectedSkill?.id === skillId) setSelectedSkill(null)
    } catch (e: any) {
      toast(e.message || '删除失败', 'error')
    }
  }

  const handleImported = (skill: Skill) => {
    store.fetchSkills()
  }

  const handleDistillCompleted = (skill: Skill) => {
    store.fetchSkills()
  }

  const handleEditSkill = (skill: Skill) => {
    store.setEditingSkill(skill)
    setShowDetailEditor(true)
  }

  const handleSaveSkill = async (skill: Skill) => {
    try {
      await store.addSkill({ ...skill, updatedAt: Date.now() })
      store.setEditingSkill(null)
      setShowDetailEditor(false)
      store.fetchSkills()
      toast('角色已保存', 'success')
    } catch (e: any) {
      toast(e.message || '保存失败', 'error')
    }
  }

  const handleTest = async () => {
    if (!testMessage.trim()) return
    try {
      await store.generateTestReply(testSkillId, testModelId, testMessage)
      toast('测试回复已生成', 'info')
    } catch (e: any) {
      toast(e.message || '测试失败', 'error')
    }
  }

  if (showDetailEditor && store.editingSkill) {
    return (
      <SkillDetailEditor
        skill={store.editingSkill}
        onSave={handleSaveSkill}
        onCancel={() => { store.setEditingSkill(null); setShowDetailEditor(false) }}
      />
    )
  }

  return (
    <div className="skills-tab">
      <div className="section-header">
        <h3>角色管理</h3>
        <div className="skills-actions">
          <button className="btn btn-primary" onClick={() => setShowDistillWizard(true)}>
            <FlaskConical size={16} /> 蒸馏好友
          </button>
          <button className="btn" onClick={() => setShowImportDialog(true)}>
            <Download size={16} /> 导入
          </button>
          <button className="btn" onClick={() => store.reloadSkills()}>
            <RefreshCw size={16} /> 刷新
          </button>
        </div>
      </div>

      <div className="test-section">
        <h4><TestTube size={16} /> 测试回复</h4>
        <div className="test-config">
          <div className="test-select-row">
            <div className="test-select-group">
              <label>角色</label>
              <select value={testSkillId} onChange={e => setTestSkillId(e.target.value)}>
                {store.skills.map((skill: any) => (
                  <option key={skill.id} value={skill.id}>{skill.name}</option>
                ))}
              </select>
            </div>
            <div className="test-select-group">
              <label>模型</label>
              <select value={testModelId} onChange={e => setTestModelId(e.target.value)}>
                {store.models.length === 0 ? (
                  <option value="">暂无模型</option>
                ) : (
                  store.models.map((model: any) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))
                )}
              </select>
            </div>
          </div>
          <div className="test-input">
            <input
              value={testMessage}
              onChange={e => setTestMessage(e.target.value)}
              placeholder="输入测试消息..."
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTest() } }}
            />
            <button className="btn btn-primary" onClick={handleTest}
              disabled={!testMessage.trim() || store.isLoading || !testModelId}>
              {store.isLoading ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
              发送
            </button>
          </div>
        </div>
        {store.testReplyResult && (
          <div className="test-reply-result">
            <div className="test-reply-meta">
              <span className="meta-item"><UserCircle size={12} /> {store.skills.find((s: any) => s.id === testSkillId)?.name || '未知角色'}</span>
              <span className="meta-item"><Brain size={12} /> {store.models.find((m: any) => m.id === testModelId)?.name || '未知模型'}</span>
              {store.testReplyLatencyMs != null && (
                <span className="meta-item"><Activity size={12} /> {store.testReplyLatencyMs}ms</span>
              )}
            </div>
            <div className="test-reply-content">
              <Sparkles size={16} className="reply-icon" />
              <p>{store.testReplyResult}</p>
            </div>
            <button className="btn btn-sm test-clear-btn" onClick={() => store.clearTestReply()}>
              清空
            </button>
          </div>
        )}
      </div>

      <div className="skill-list">
        {store.skills.map((skill: any) => (
          <div
            key={skill.id}
            className={`skill-card ${skill.id === store.activeSkillId ? 'active' : ''}`}
            onClick={() => handleEditSkill(skill)}
          >
            <div className="skill-info">
              <div className="skill-header">
                <span className="skill-name">{skill.name}</span>
                <span className="skill-version">v{skill.version}</span>
                {skill.isBuiltin && <span className="builtin-badge">内置</span>}
                {skill.id === store.activeSkillId && <span className="active-badge">使用中</span>}
              </div>
              <p className="skill-desc">{skill.description}</p>
              <div className="skill-tags">
                {skill.persona.identity.tags.map((tag: any, i: number) => (
                  <span key={i} className="tag">{tag}</span>
                ))}
              </div>
            </div>
            <div className="skill-actions" onClick={e => e.stopPropagation()}>
              {skill.id !== store.activeSkillId && (
                <button className="btn btn-sm" onClick={() => store.setActiveSkill(skill.id)}>
                  <CheckCircle2 size={14} /> 启用
                </button>
              )}
              <button className="btn btn-sm" onClick={() => handleEditSkill(skill)}>
                <Edit3 size={14} /> 编辑
              </button>
              {!skill.isBuiltin && (
                <button className="btn btn-sm btn-danger" onClick={() => handleRemoveSkill(skill.id)}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <SkillImportDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onImported={handleImported}
      />
      <DistillWizard
        open={showDistillWizard}
        onClose={() => setShowDistillWizard(false)}
        onCompleted={handleDistillCompleted}
      />
    </div>
  )
}

function TriggersTab({ toast }: { toast: (msg: string, type?: 'success' | 'error' | 'info') => void }) {
  const store = useAIReplyStore()
  const [rules, setRules] = useState<TriggerRules>(store.triggerRules || DEFAULT_TRIGGER_RULES)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    if (store.triggerRules) {
      setRules(store.triggerRules)
      setHasChanges(false)
    }
  }, [store.triggerRules])

  const handleSave = async () => {
    try {
      await store.setTriggerRules(rules)
      setHasChanges(false)
      toast('触发规则已保存', 'success')
    } catch (e: any) {
      toast(e.message || '保存失败', 'error')
    }
  }

  const updateRule = <K extends keyof TriggerRules>(key: K, value: TriggerRules[K]) => {
    setRules(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="triggers-tab">
      <div className="section-header">
        <h3>触发规则</h3>
        <button className="btn btn-primary" onClick={handleSave}>
          <Settings size={16} /> 保存
        </button>
      </div>

      <div className="rule-group">
        <div className="rule-group-title"><Zap size={16} /> 基础开关</div>
        <div className="toggle-row">
          <span className="toggle-label-text">启用自动回复</span>
          <ToggleSwitch checked={rules.enabled} onChange={v => updateRule('enabled', v)} />
        </div>
      </div>

      <div className="rule-group">
        <div className="rule-group-title"><Users size={16} /> 回复对象</div>
        <div className="form-group">
          <label>监听模式</label>
          <select value={rules.listenMode}
            onChange={e => updateRule('listenMode', e.target.value as any)}>
            <option value="all">所有人</option>
            <option value="specific">指定联系人</option>
            <option value="whitelist">白名单</option>
            <option value="blacklist">黑名单</option>
          </select>
        </div>
        {(rules.listenMode === 'specific' || rules.listenMode === 'whitelist') && (
          <div className="form-group">
            <label>选择联系人</label>
            <ContactPicker
              selectedIds={rules.targetContacts}
              onChange={ids => updateRule('targetContacts', ids)}
            />
          </div>
        )}
        {rules.listenMode === 'blacklist' && (
          <div className="form-group">
            <label>黑名单联系人</label>
            <ContactPicker
              selectedIds={rules.blacklist}
              onChange={ids => updateRule('blacklist', ids)}
            />
          </div>
        )}
      </div>

      <div className="rule-group">
        <div className="rule-group-title"><Search size={16} /> 关键词规则</div>
        <div className="form-group">
          <label>包含关键词（匹配任一触发）</label>
          <TagInput
            tags={rules.keywords.include}
            onChange={tags => updateRule('keywords', { ...rules.keywords, include: tags })}
            placeholder="输入关键词后回车添加"
          />
        </div>
        <div className="form-group">
          <label>排除关键词（匹配任一跳过）</label>
          <TagInput
            tags={rules.keywords.exclude}
            onChange={tags => updateRule('keywords', { ...rules.keywords, exclude: tags })}
            placeholder="输入关键词后回车添加"
          />
        </div>
      </div>

      <div className="rule-group">
        <div className="rule-group-title"><MessageSquare size={16} /> 群聊规则</div>
        <div className="toggle-row">
          <span className="toggle-label-text">群聊 @触发</span>
          <ToggleSwitch checked={rules.triggerOnAt} onChange={v => updateRule('triggerOnAt', v)} />
        </div>
        <div className="toggle-row" style={{ marginTop: 12 }}>
          <span className="toggle-label-text">@所有人触发</span>
          <ToggleSwitch checked={rules.triggerOnAtAll} onChange={v => updateRule('triggerOnAtAll', v)} />
        </div>
      </div>

      <div className="rule-group">
        <div className="rule-group-title"><Clock size={16} /> 时间规则</div>
        <div className="toggle-row">
          <span className="toggle-label-text">启用时间限制</span>
          <ToggleSwitch
            checked={rules.timeRules.enabled}
            onChange={v => updateRule('timeRules', { ...rules.timeRules, enabled: v })}
          />
        </div>
        {rules.timeRules.enabled && (
          <div className="form-group" style={{ marginTop: 12 }}>
            <label>允许回复的时间范围</label>
            <TimeRangeSlider
              value={rules.timeRules.allowedHours}
              onChange={v => updateRule('timeRules', { ...rules.timeRules, allowedHours: v })}
            />
          </div>
        )}
      </div>

      <div className="rule-group">
        <div className="rule-group-title"><Shield size={16} /> 频率限制</div>
        <div className="toggle-row">
          <span className="toggle-label-text">启用频率限制</span>
          <ToggleSwitch
            checked={rules.rateLimit.enabled}
            onChange={v => updateRule('rateLimit', { ...rules.rateLimit, enabled: v })}
          />
        </div>
        {rules.rateLimit.enabled && (
          <div className="form-row" style={{ marginTop: 12 }}>
            <div className="form-group">
              <label>每分钟最大回复数</label>
              <input type="number" min="1" max="60" value={rules.rateLimit.maxRepliesPerMinute}
                onChange={e => updateRule('rateLimit', {
                  ...rules.rateLimit,
                  maxRepliesPerMinute: parseInt(e.target.value)
                })} />
            </div>
            <div className="form-group">
              <label>冷却时间 (秒)</label>
              <input type="number" min="0" max="300" value={rules.rateLimit.cooldownSeconds}
                onChange={e => updateRule('rateLimit', {
                  ...rules.rateLimit,
                  cooldownSeconds: parseInt(e.target.value)
                })} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function LogsTab({ toast }: { toast: (msg: string, type?: 'success' | 'error' | 'info') => void }) {
  const store = useAIReplyStore()
  const [selectedLog, setSelectedLog] = useState<ReplyLog | null>(store.replyLogs[0] || null)
  const [showDetail, setShowDetail] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [contactFilter, setContactFilter] = useState('')
  const [keywordFilter, setKeywordFilter] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const pageSize = 20

  const handleDeleteLogs = async (ids: string[]) => {
    try {
      await store.deleteReplyLogs(ids)
      toast(`已删除 ${ids.length} 条日志`, 'success')
      if (selectedLog && ids.includes(selectedLog.id)) {
        setSelectedLog(store.replyLogs.find((l: any) => !ids.includes(l.id)) || null)
      }
    } catch (e: any) {
      toast(e.message || '删除失败', 'error')
    }
  }

  const handleClearAll = async () => {
    try {
      await store.clearReplyLogs()
      setConfirmClear(false)
      toast('所有日志已清空', 'success')
      setSelectedLog(null)
    } catch (e: any) {
      toast(e.message || '清空失败', 'error')
    }
  }

  useEffect(() => {
    store.fetchReplyLogs(pageSize, (page - 1) * pageSize)
    store.fetchReplyLogsCount()
  }, [page])

  const filteredLogs = store.replyLogs.filter((log: any) => {
    if (statusFilter === 'success' && !log.success) return false
    if (statusFilter === 'error' && log.success) return false
    if (contactFilter && !log.contactName.includes(contactFilter)) return false
    if (keywordFilter && !log.receivedMessage.includes(keywordFilter) && !log.generatedReply.includes(keywordFilter)) return false
    return true
  })

  const totalPages = Math.ceil(store.replyLogsTotal / pageSize)

  const toggleSelect = (id: string) => {
    const newSet = new Set(selectedIds)
    if (newSet.has(id)) newSet.delete(id)
    else newSet.add(id)
    setSelectedIds(newSet)
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredLogs.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredLogs.map((l: any) => l.id)))
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return
    await handleDeleteLogs([...selectedIds])
    setSelectedIds(new Set())
    store.fetchReplyLogs(pageSize, (page - 1) * pageSize)
  }

  const handleConfirmClearAll = async () => {
    setConfirmClear(true)
  }

  return (
    <div className="logs-tab">
      <div className="section-header">
        <h3>回复日志 <span className="log-count">({store.replyLogsTotal} 条)</span></h3>
        <div className="log-actions">
          <button className="btn" onClick={() => { store.fetchReplyLogs(pageSize, (page - 1) * pageSize); store.fetchReplyLogsCount() }}>
            <RefreshCw size={16} /> 刷新
          </button>
          {selectedIds.size > 0 && (
            <button className="btn btn-danger" onClick={handleDeleteSelected}>
              <Trash2 size={16} /> 删除选中 ({selectedIds.size})
            </button>
          )}
          <button className="btn btn-danger" onClick={handleConfirmClearAll}>
            <Trash2 size={16} /> 清空全部
          </button>
        </div>
      </div>

      <div className="log-filters">
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          <option value="success">成功</option>
          <option value="error">失败</option>
        </select>
        <input
          value={contactFilter}
          onChange={e => setContactFilter(e.target.value)}
          placeholder="联系人筛选..."
        />
        <input
          value={keywordFilter}
          onChange={e => setKeywordFilter(e.target.value)}
          placeholder="关键词搜索..."
        />
      </div>

      {filteredLogs.length === 0 ? (
        <div className="empty-state">
          <MessageSquare size={48} />
          <p>暂无回复日志</p>
        </div>
      ) : (
        <>
          <div className="log-select-bar">
            <label className="select-all-label">
              <input
                type="checkbox"
                checked={selectedIds.size === filteredLogs.length && filteredLogs.length > 0}
                onChange={toggleSelectAll}
              />
              <span>全选本页</span>
            </label>
          </div>
          <div className="log-list">
            {filteredLogs.map((log: any) => {
              const statusClass = !log.success && log.errorMessage ? 'log-error' : (!log.sent ? 'log-warning' : '')
              const statusLabel = !log.success && log.errorMessage
                ? '失败'
                : (log.sent ? '已发送' : '已生成')
              return (
              <div
                key={log.id}
                className={`log-item ${statusClass} ${selectedIds.has(log.id) ? 'selected' : ''}`}
              >
                <input
                  type="checkbox"
                  className="log-checkbox"
                  checked={selectedIds.has(log.id)}
                  onChange={() => toggleSelect(log.id)}
                  onClick={e => e.stopPropagation()}
                />
                <div className="log-content" onClick={() => store.setSelectedLogDetail(log)}>
                  <div className="log-header">
                    <span className="log-avatar">{(log.contactName || '?').charAt(0)}</span>
                    <span className="log-contact">{log.contactName}</span>
                    <span className={`log-status-badge ${statusClass}`}>
                      {statusLabel}
                    </span>
                    <span className="log-meta">
                      {log.skillName} · {log.modelName} · {log.latencyMs}ms
                    </span>
                    <span className="log-time">{new Date(log.timestamp).toLocaleString()}</span>
                  </div>
                  <div className="log-body">
                    <div className="log-received">{log.receivedMessage}</div>
                    <div className="log-arrow"><ChevronRight size={14} className="log-arrow-icon" /></div>
                    <div className="log-reply">{log.generatedReply || log.errorMessage}</div>
                  </div>
                </div>
              </div>
              )
            })}
          </div>
          {totalPages > 1 && (
            <div className="log-pagination">
              <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <span className="page-info">第 {page} / {totalPages} 页</span>
              <button className="btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                下一页
              </button>
            </div>
          )}
        </>
      )}

      <LogDetailDialog log={store.selectedLogDetail} onClose={() => store.setSelectedLogDetail(null)} />
    </div>
  )
}
