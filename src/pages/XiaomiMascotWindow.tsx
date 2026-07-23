import './XiaomiMascotWindow.scss'

export default function XiaomiMascotWindow() {
  const restoreMainWindow = () => {
    void window.electronAPI?.window?.showMainWindow?.()
  }

  return (
    <div
      className="xiaomi-mascot-window"
      title="小密回复运行中，双击回到 WeFlow"
      onDoubleClick={restoreMainWindow}
    >
      <div className="xiaomi-mascot" aria-label="小密回复运行中">
        <div className="mascot-antenna" />
        <div className="mascot-head">
          <span className="mascot-eye left" />
          <span className="mascot-eye right" />
        </div>
        <div className="mascot-body">
          <span className="mascot-badge">小</span>
        </div>
        <div className="mascot-arm left" />
        <div className="mascot-arm right" />
        <div className="mascot-foot left" />
        <div className="mascot-foot right" />
      </div>
      <div className="mascot-caption">运行中</div>
    </div>
  )
}
