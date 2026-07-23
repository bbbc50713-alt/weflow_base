import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle, XCircle, AlertCircle, X } from 'lucide-react'
import './Toast.scss'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  type: ToastType
  message: string
}

let toastId = 0

interface ToastContainerProps {
  toasts: ToastItem[]
  onRemove: (id: number) => void
}

function ToastIcon({ type }: { type: ToastType }) {
  switch (type) {
    case 'success': return <CheckCircle size={16} />
    case 'error': return <XCircle size={16} />
    case 'info': return <AlertCircle size={16} />
  }
}

function ToastContainer({ toasts, onRemove }: ToastContainerProps) {
  return createPortal(
    <div className="toast-container">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast-item toast-${toast.type}`}>
          <div className="toast-icon">
            <ToastIcon type={toast.type} />
          </div>
          <span className="toast-message">{toast.message}</span>
          <button className="toast-close" onClick={() => onRemove(toast.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}

const TOAST_DURATION = 2500
const MAX_TOASTS = 5

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const remove = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const add = useCallback((message: string, type: ToastType = 'success') => {
    const id = ++toastId
    setToasts(prev => [...prev.slice(-(MAX_TOASTS - 1)), { id, type, message }])
    setTimeout(() => remove(id), TOAST_DURATION)
  }, [remove])

  return { toasts, add, remove }
}

export default function ToastProvider({ toasts, onRemove }: { toasts: ToastItem[]; onRemove: (id: number) => void }) {
  if (toasts.length === 0) return null
  return <ToastContainer toasts={toasts} onRemove={onRemove} />
}
