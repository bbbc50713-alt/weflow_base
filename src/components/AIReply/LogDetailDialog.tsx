import { X, CheckCircle2, XCircle, Clock, Zap, Brain, UserCircle, AlertTriangle } from 'lucide-react'
import type { ReplyLog } from '../../types/ai-reply'
import './LogDetailDialog.scss'

interface LogDetailDialogProps {
  log: ReplyLog | null
  onClose: () => void
}

export default function LogDetailDialog({ log, onClose }: LogDetailDialogProps) {
  if (!log) return null

  return (
    <div className="log-detail-overlay" onClick={onClose}>
      <div className="log-detail-dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>回复详情</h3>
          <button className="dialog-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="detail-status">
            {!log.success ? (
              <div className="status-row error">
                <XCircle size={18} />
                <span>回复失败</span>
              </div>
            ) : log.sent ? (
              <div className="status-row success">
                <CheckCircle2 size={18} />
                <span>回复成功</span>
              </div>
            ) : (
              <div className="status-row warning">
                <AlertTriangle size={18} />
                <span>已生成但未发送（自动回复发送未开启）</span>
              </div>
            )}
          </div>

          <div className="detail-meta">
            <div className="meta-item">
              <UserCircle size={14} />
              <span className="meta-label">联系人</span>
              <span className="meta-value">{log.contactName}</span>
            </div>
            <div className="meta-item">
              <Brain size={14} />
              <span className="meta-label">模型</span>
              <span className="meta-value">{log.modelName}</span>
            </div>
            <div className="meta-item">
              <Zap size={14} />
              <span className="meta-label">角色</span>
              <span className="meta-value">{log.skillName}</span>
            </div>
            <div className="meta-item">
              <Clock size={14} />
              <span className="meta-label">时间</span>
              <span className="meta-value">{new Date(log.timestamp).toLocaleString()}</span>
            </div>
            <div className="meta-item">
              <Zap size={14} />
              <span className="meta-label">延迟</span>
              <span className="meta-value">{log.latencyMs}ms</span>
            </div>
          </div>

          <div className="detail-messages">
            <div className="message-block">
              <div className="message-label">收到的消息</div>
              <div className="message-content received">{log.receivedMessage}</div>
            </div>
            {log.generatedReply ? (
              <div className="message-block">
                <div className="message-label">生成的回复{!log.sent ? '（未发送）' : ''}</div>
                <div className={`message-content reply ${!log.sent ? 'warning' : ''}`}>{log.generatedReply}</div>
                {!log.sent && log.errorMessage && (
                  <div className="send-reason">{log.errorMessage}</div>
                )}
              </div>
            ) : (
              <div className="message-block">
                <div className="message-label">错误信息</div>
                <div className="message-content error">{log.errorMessage}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
