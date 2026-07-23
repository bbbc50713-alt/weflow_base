import { useState, useEffect, useRef } from 'react'
import { Search, X, Users, User } from 'lucide-react'
import './ContactPicker.scss'

interface ContactItem {
  id: string
  name: string
  avatar?: string
  isGroup: boolean
}

interface ContactPickerProps {
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

export default function ContactPicker({ selectedIds, onChange }: ContactPickerProps) {
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<ContactItem[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [selectedContacts, setSelectedContacts] = useState<Map<string, ContactItem>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (selectedIds.length === 0) {
      setSelectedContacts(new Map())
      return
    }
    const missingIds = selectedIds.filter(id => !selectedContacts.has(id))
    if (missingIds.length > 0) {
      loadContactDetails(missingIds)
    }
  }, [selectedIds])

  const loadContactDetails = async (ids: string[]) => {
    try {
      const allContacts: ContactItem[] = []
      for (const id of ids) {
        if (selectedContacts.has(id)) continue
        try {
          const contact = await window.electronAPI?.chat?.getContact(id)
          if (contact) {
            allContacts.push({
              id: contact.username || id,
              name: contact.remark || contact.nickName || contact.alias || contact.username || id,
              avatar: contact.smallHeadUrl || contact.bigHeadUrl || '',
              isGroup: contact.localType === 2 || contact.localType === 3
            })
          }
        } catch {}
      }
      if (allContacts.length > 0) {
        setSelectedContacts(prev => {
          const next = new Map(prev)
          allContacts.forEach(c => next.set(c.id, c))
          return next
        })
      }
    } catch {}
  }

  const handleSearch = async (value: string) => {
    setKeyword(value)
    if (!value.trim()) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const contacts = await window.electronAPI?.aiReply?.searchContacts(value.trim()) || []
      const mapped = contacts.map((c: any) => ({
        id: c.id || c.contactId || c.username,
        name: c.name || c.displayName || c.nickname || c.contactName,
        avatar: c.avatar || c.avatarUrl,
        isGroup: c.isGroup || c.type === 'group' || false
      }))
      setResults(mapped)
      mapped.forEach((c: ContactItem) => {
        if (selectedIds.includes(c.id)) {
          setSelectedContacts(prev => {
            if (prev.has(c.id)) return prev
            const next = new Map(prev)
            next.set(c.id, c)
            return next
          })
        }
      })
    } catch {
      setResults([])
    }
    setSearching(false)
  }

  const toggleContact = (contact: ContactItem) => {
    setSelectedContacts(prev => {
      const next = new Map(prev)
      next.set(contact.id, contact)
      return next
    })
    if (selectedIds.includes(contact.id)) {
      onChange(selectedIds.filter(i => i !== contact.id))
    } else {
      onChange([...selectedIds, contact.id])
    }
  }

  const removeSelected = (id: string) => {
    onChange(selectedIds.filter(i => i !== id))
  }

  const privateContacts = results.filter(c => !c.isGroup)
  const groupContacts = results.filter(c => c.isGroup)

  return (
    <div className="contact-picker" ref={containerRef}>
      {selectedIds.length > 0 && (
        <div className="selected-tags">
          {selectedIds.map(id => {
            const contact = selectedContacts.get(id)
            return (
              <span key={id} className="selected-tag">
                <span className="tag-avatar">
                  {contact?.avatar
                    ? <img src={contact.avatar} alt="" />
                    : <span className="tag-avatar-letter">{(contact?.name || id)[0]}</span>
                  }
                </span>
                <span className="tag-name">{contact?.name || id}</span>
                {contact?.isGroup && <Users size={10} className="tag-group-icon" />}
                <button className="tag-remove" onClick={() => removeSelected(id)}>
                  <X size={12} />
                </button>
              </span>
            )
          })}
        </div>
      )}
      <div className="search-box">
        <Search size={16} className="search-icon" />
        <input
          value={keyword}
          onChange={e => handleSearch(e.target.value)}
          onFocus={() => setIsOpen(true)}
          placeholder="搜索联系人..."
        />
      </div>
      {isOpen && keyword.trim() && (
        <div className="search-results">
          {searching && <div className="search-loading">搜索中...</div>}
          {!searching && results.length === 0 && (
            <div className="search-empty">未找到联系人</div>
          )}
          {!searching && privateContacts.length > 0 && (
            <div className="contact-group">
              <div className="group-label"><User size={14} /> 私聊</div>
              {privateContacts.map(c => (
                <div
                  key={c.id}
                  className={`contact-item ${selectedIds.includes(c.id) ? 'selected' : ''}`}
                  onClick={() => toggleContact(c)}
                >
                  <div className="contact-avatar">
                    {c.avatar ? <img src={c.avatar} alt="" /> : <span>{c.name[0]}</span>}
                  </div>
                  <span className="contact-name">{c.name}</span>
                  {selectedIds.includes(c.id) && <span className="check-mark">✓</span>}
                </div>
              ))}
            </div>
          )}
          {!searching && groupContacts.length > 0 && (
            <div className="contact-group">
              <div className="group-label"><Users size={14} /> 群聊</div>
              {groupContacts.map(c => (
                <div
                  key={c.id}
                  className={`contact-item ${selectedIds.includes(c.id) ? 'selected' : ''}`}
                  onClick={() => toggleContact(c)}
                >
                  <div className="contact-avatar">
                    {c.avatar ? <img src={c.avatar} alt="" /> : <span>{c.name[0]}</span>}
                  </div>
                  <span className="contact-name">{c.name}</span>
                  {selectedIds.includes(c.id) && <span className="check-mark">✓</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
