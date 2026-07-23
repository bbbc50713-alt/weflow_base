import type { ModelPreset } from '../../types/ai-reply'
import { MODEL_PRESETS } from '../../types/ai-reply'
import './ModelPresetCards.scss'

interface ModelPresetCardsProps {
  onSelect: (preset: ModelPreset) => void
}

export default function ModelPresetCards({ onSelect }: ModelPresetCardsProps) {
  return (
    <div className="model-preset-cards">
      {MODEL_PRESETS.map((preset, index) => (
        <div
          key={index}
          className="preset-card"
          onClick={() => onSelect(preset)}
        >
          <span className="preset-name">{preset.name}</span>
          <span className="preset-type">{preset.type}</span>
        </div>
      ))}
    </div>
  )
}
