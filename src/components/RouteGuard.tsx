import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import './RouteGuard.scss'

interface RouteGuardProps {
  children: React.ReactNode
}

const PUBLIC_ROUTES = ['/', '/home', '/settings', '/account-management', '/history-sync']

function RouteGuard({ children }: RouteGuardProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const isDbConnected = useAppStore(state => state.isDbConnected)
  const error = useAppStore(state => state.dbConnectionError)
  const [retrying, setRetrying] = useState(false)

  async function retryConnection() {
    if (retrying) return
    setRetrying(true)
    try {
      const result = await window.electronAPI.chat.connect()
      const store = useAppStore.getState()
      if (result.success) store.setDbConnected(true)
      else store.setDbConnectionError(result.error || '微信数据库连接失败')
    } catch (reason) {
      useAppStore.getState().setDbConnectionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRetrying(false)
    }
  }

  // Render the disconnected state before mounting a page: its data-loading effects
  // must not run against an unavailable native reader, or bounce back to Home.
  if (!isDbConnected && !PUBLIC_ROUTES.includes(location.pathname)) {
    return <section className="route-connection-state" role="status">
      <h2>尚未连接微信数据库</h2>
      <p>此页面需要先读取本地微信数据。连接失败时会停留在这里，不会自动退回首页。</p>
      {error && <p className="connection-error">{error}</p>}
      <p>若提示错误码 -101，请检查读取组件是否可用；重试连接不会解除组件限制。</p>
      <div className="connection-actions">
        <button className="btn btn-primary" disabled={retrying} onClick={() => void retryConnection()}>{retrying ? '正在连接…' : '重新连接'}</button>
        <button className="btn btn-secondary" onClick={() => navigate('/settings', { state: { backgroundLocation: location, initialTab: 'database' } })}>打开数据库设置</button>
      </div>
    </section>
  }

  return <>{children}</>
}

export default RouteGuard
