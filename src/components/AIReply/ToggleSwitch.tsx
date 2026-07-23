import './ToggleSwitch.scss'

interface ToggleSwitchProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}

export default function ToggleSwitch({ checked, onChange, disabled }: ToggleSwitchProps) {
  return (
    <label className={`toggle-switch ${disabled ? 'disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="toggle-slider" />
    </label>
  )
}
