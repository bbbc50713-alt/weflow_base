import { useState } from 'react'
import { X, FolderOpen, FileArchive, GitBranch, Loader2, CheckCircle2 } from 'lucide-react'
import type { Skill } from '../../types/ai-reply'
import './SkillImportDialog.scss'

interface SkillImportDialogProps {
  open: boolean
  onClose: () => void
  onImported: (skill: Skill) => void
}

export default function SkillImportDialog({ open, onClose, onImported }: SkillImportDialogProps) {
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [gitUrl, setGitUrl] = useState('')

  if (!open) return null

  const handleImportFromDirectory = async () => {
    setImporting(true)
    setError('')
    try {
      const result = await window.electronAPI?.dialog?.openDirectory()
      if (result && !result.canceled && result.filePaths.length > 0) {
        const skill = await window.electronAPI?.aiReply?.importSkillFromDirectory(result.filePaths[0])
        if (skill) {
          onImported(skill as Skill)
          onClose()
        }
      }
    } catch (e: any) {
      setError(e.message || '导入失败')
    }
    setImporting(false)
  }

  const handleImportFromZip = async () => {
    setImporting(true)
    setError('')
    try {
      const result = await window.electronAPI?.dialog?.openFile({
        filters: [{ name: 'ZIP 文件', extensions: ['zip'] }]
      })
      if (result && !result.canceled && result.filePaths.length > 0) {
        const skill = await window.electronAPI?.aiReply?.importSkillFromZip(result.filePaths[0])
        if (skill) {
          onImported(skill as Skill)
          onClose()
        }
      }
    } catch (e: any) {
      setError(e.message || '导入失败')
    }
    setImporting(false)
  }

  const handleImportFromGit = async () => {
    if (!gitUrl.trim()) return
    setImporting(true)
    setError('')
    try {
      const skill = await window.electronAPI?.aiReply?.importSkillFromGit(gitUrl.trim())
      if (skill) {
        onImported(skill as Skill)
        onClose()
      }
    } catch (e: any) {
      setError(e.message || '导入失败')
    }
    setImporting(false)
  }

  return (
    <div className="skill-import-overlay" onClick={onClose}>
      <div className="skill-import-dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>导入 Skill</h3>
          <button className="dialog-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="import-option" onClick={handleImportFromDirectory}>
            <div className="option-icon"><FolderOpen size={24} /></div>
            <div className="option-info">
              <div className="option-title">从文件夹导入</div>
              <div className="option-desc">选择本地文件夹中的 Skill 配置</div>
            </div>
            {importing ? <Loader2 size={18} className="spin" /> : null}
          </div>

          <div className="import-option" onClick={handleImportFromZip}>
            <div className="option-icon"><FileArchive size={24} /></div>
            <div className="option-info">
              <div className="option-title">从 ZIP 导入</div>
              <div className="option-desc">选择 ZIP 压缩包导入 Skill</div>
            </div>
            {importing ? <Loader2 size={18} className="spin" /> : null}
          </div>

          <div className="import-option git-option">
            <div className="option-icon"><GitBranch size={24} /></div>
            <div className="option-info">
              <div className="option-title">从 Git 导入</div>
              <div className="option-desc">输入 Git 仓库地址克隆导入</div>
            </div>
          </div>
          <div className="git-input-row">
            <input
              value={gitUrl}
              onChange={e => setGitUrl(e.target.value)}
              placeholder="https://github.com/user/skill-repo.git"
              onKeyDown={e => e.key === 'Enter' && handleImportFromGit()}
            />
            <button
              className="btn btn-primary"
              onClick={handleImportFromGit}
              disabled={importing || !gitUrl.trim()}
            >
              {importing ? <Loader2 size={14} className="spin" /> : '导入'}
            </button>
          </div>

          {error && <div className="import-error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
