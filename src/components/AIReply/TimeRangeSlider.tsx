import { useCallback, useRef, useState } from 'react'
import './TimeRangeSlider.scss'

interface TimeRangeSliderProps {
  value: [number, number]
  onChange: (v: [number, number]) => void
}

export default function TimeRangeSlider({ value, onChange }: TimeRangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null)

  const getPositionFromValue = useCallback((val: number) => {
    return (val / 23) * 100
  }, [])

  const getValueFromPosition = useCallback((clientX: number) => {
    if (!trackRef.current) return 0
    const rect = trackRef.current.getBoundingClientRect()
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.round(percent * 23)
  }, [])

  const handleMouseDown = (type: 'start' | 'end') => (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(type)

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newVal = getValueFromPosition(moveEvent.clientX)
      if (dragging === 'start' || type === 'start') {
        onChange([Math.min(newVal, value[1]), value[1]])
      } else {
        onChange([value[0], Math.max(newVal, value[0])])
      }
    }

    const handleMouseUp = () => {
      setDragging(null)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  const startPercent = getPositionFromValue(value[0])
  const endPercent = getPositionFromValue(value[1])

  const hours = Array.from({ length: 24 }, (_, i) => i)

  return (
    <div className="time-range-slider">
      <div className="slider-track" ref={trackRef}>
        <div
          className="slider-range"
          style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }}
        />
        <div
          className="slider-thumb slider-thumb-start"
          style={{ left: `${startPercent}%` }}
          onMouseDown={handleMouseDown('start')}
        />
        <div
          className="slider-thumb slider-thumb-end"
          style={{ left: `${endPercent}%` }}
          onMouseDown={handleMouseDown('end')}
        />
      </div>
      <div className="slider-labels">
        {hours.filter(h => h % 4 === 0).map(h => (
          <span key={h} className="slider-label">{h}</span>
        ))}
      </div>
      <div className="slider-value">
        {value[0]}:00 — {value[1]}:00
      </div>
    </div>
  )
}
