import { useState, KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import './TagInput.scss'

interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
}

export default function TagInput({ tags, onChange, placeholder }: TagInputProps) {
  const [input, setInput] = useState('')

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && input.trim()) {
      e.preventDefault()
      const value = input.trim()
      if (!tags.includes(value)) {
        onChange([...tags, value])
      }
      setInput('')
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  const removeTag = (index: number) => {
    onChange(tags.filter((_, i) => i !== index))
  }

  return (
    <div className="tag-input">
      <div className="tag-input-tags">
        {tags.map((tag, i) => (
          <span key={i} className="tag-item">
            {tag}
            <button className="tag-remove" onClick={() => removeTag(i)}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          className="tag-input-field"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tags.length === 0 ? placeholder : ''}
        />
      </div>
    </div>
  )
}
