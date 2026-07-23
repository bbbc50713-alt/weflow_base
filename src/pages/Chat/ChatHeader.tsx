import React from 'react'
import {
  Aperture,
  Calendar,
  Image as ImageIcon,
  Info,
  Loader2,
  Mic,
  Newspaper,
  RefreshCw,
  Search,
  Users
} from 'lucide-react'
import { Avatar } from '../../components/Avatar'
import type { ChatSession } from '../../types/models'
import type { BatchVoiceTaskType } from '../../stores/batchTranscribeStore'

export interface ChatHeaderProps {
  session: ChatSession
  isGroupChat: boolean
  standaloneSessionWindow: boolean
  showGroupMembersPanel: boolean
  showGroupSummaryPanel: boolean
  showJumpPopover: boolean
  showInSessionSearch: boolean
  showDetailPanel: boolean
  aiGroupSummaryEnabled: boolean
  shouldHideStandaloneDetailButton: boolean
  isPrivateSnsSupported: boolean
  isBatchTranscribing: boolean
  runningBatchVoiceTaskType?: BatchVoiceTaskType
  isBatchDecrypting: boolean
  isRefreshingMessages: boolean
  isLoadingMessages: boolean
  currentSessionId?: string | null
  jumpCalendarWrapRef: React.RefObject<HTMLDivElement | null>
  onToggleGroupSummaryPanel: () => void
  onToggleGroupMembersPanel: () => void
  onOpenSnsTimeline: () => void
  onBatchTranscribe: () => void
  onBatchDecrypt: () => void
  onToggleJumpPopover: () => void
  onToggleInSessionSearch: () => void
  onRefreshMessages: () => void
  onToggleDetailPanel: () => void
}

function ChatHeader({
  session,
  isGroupChat,
  standaloneSessionWindow,
  showGroupMembersPanel,
  showGroupSummaryPanel,
  showJumpPopover,
  showInSessionSearch,
  showDetailPanel,
  aiGroupSummaryEnabled,
  shouldHideStandaloneDetailButton,
  isPrivateSnsSupported,
  isBatchTranscribing,
  runningBatchVoiceTaskType,
  isBatchDecrypting,
  isRefreshingMessages,
  isLoadingMessages,
  currentSessionId,
  jumpCalendarWrapRef,
  onToggleGroupSummaryPanel,
  onToggleGroupMembersPanel,
  onOpenSnsTimeline,
  onBatchTranscribe,
  onBatchDecrypt,
  onToggleJumpPopover,
  onToggleInSessionSearch,
  onRefreshMessages,
  onToggleDetailPanel
}: ChatHeaderProps) {
  const sessionName = session.displayName || session.username
  const batchVoiceTitle = isBatchTranscribing
    ? `${runningBatchVoiceTaskType === 'decrypt' ? '批量语音解密' : '批量转写'}中，可继续使用其他功能`
    : '批量语音处理'

  return (
    <div className="message-header">
      <Avatar
        src={session.avatarUrl}
        name={sessionName}
        size={40}
        className={isGroupChat ? 'group session-avatar' : 'session-avatar'}
      />
      <div className="header-info">
        <h3>{sessionName}</h3>
        {isGroupChat && <div className="header-subtitle">群聊</div>}
      </div>
      <div className="header-actions">
        {isGroupChat && aiGroupSummaryEnabled && (
          <button
            className={`icon-btn group-summary-btn ${showGroupSummaryPanel ? 'active' : ''}`}
            onClick={onToggleGroupSummaryPanel}
            disabled={!currentSessionId}
            title="AI 群聊总结"
            aria-label="AI 群聊总结"
          >
            <Newspaper size={18} />
          </button>
        )}
        {isGroupChat && (
          <button
            className={`icon-btn group-members-btn ${showGroupMembersPanel ? 'active' : ''}`}
            onClick={onToggleGroupMembersPanel}
            title="群成员"
          >
            <Users size={18} />
          </button>
        )}
        {!standaloneSessionWindow && isPrivateSnsSupported && (
          <button
            className="icon-btn chat-sns-timeline-btn"
            onClick={onOpenSnsTimeline}
            disabled={!currentSessionId}
            title="查看朋友圈"
          >
            <Aperture size={18} />
          </button>
        )}
        {!standaloneSessionWindow && (
          <button
            className={`icon-btn batch-transcribe-btn${isBatchTranscribing ? ' transcribing' : ''}`}
            onClick={onBatchTranscribe}
            disabled={!currentSessionId}
            title={batchVoiceTitle}
          >
            {isBatchTranscribing ? <Loader2 size={18} className="spin" /> : <Mic size={18} />}
          </button>
        )}
        {!standaloneSessionWindow && (
          <button
            className={`icon-btn batch-decrypt-btn${isBatchDecrypting ? ' transcribing' : ''}`}
            onClick={onBatchDecrypt}
            disabled={!currentSessionId}
            title={isBatchDecrypting ? '批量解密中' : '批量解密图片'}
          >
            {isBatchDecrypting ? <Loader2 size={18} className="spin" /> : <ImageIcon size={18} />}
          </button>
        )}
        <div className="jump-calendar-anchor" ref={jumpCalendarWrapRef}>
          <button
            className={`icon-btn jump-to-time-btn ${showJumpPopover ? 'active' : ''}`}
            onClick={onToggleJumpPopover}
            title="跳转到指定时间"
          >
            <Calendar size={18} />
          </button>
        </div>
        <button
          className={`icon-btn in-session-search-btn ${showInSessionSearch ? 'active' : ''}`}
          onClick={onToggleInSessionSearch}
          disabled={!currentSessionId}
          title="搜索会话消息"
        >
          <Search size={18} />
        </button>
        <button
          className="icon-btn refresh-messages-btn"
          onClick={onRefreshMessages}
          disabled={isRefreshingMessages || isLoadingMessages}
          title="刷新消息"
        >
          <RefreshCw size={18} className={isRefreshingMessages ? 'spin' : ''} />
        </button>
        {!shouldHideStandaloneDetailButton && (
          <button
            className={`icon-btn detail-btn ${showDetailPanel ? 'active' : ''}`}
            onClick={onToggleDetailPanel}
            title="会话详情"
          >
            <Info size={18} />
          </button>
        )}
      </div>
    </div>
  )
}

function areEqual(prev: ChatHeaderProps, next: ChatHeaderProps) {
  return (
    prev.session.username === next.session.username &&
    prev.session.displayName === next.session.displayName &&
    prev.session.avatarUrl === next.session.avatarUrl &&
    prev.isGroupChat === next.isGroupChat &&
    prev.standaloneSessionWindow === next.standaloneSessionWindow &&
    prev.showGroupMembersPanel === next.showGroupMembersPanel &&
    prev.showGroupSummaryPanel === next.showGroupSummaryPanel &&
    prev.showJumpPopover === next.showJumpPopover &&
    prev.showInSessionSearch === next.showInSessionSearch &&
    prev.showDetailPanel === next.showDetailPanel &&
    prev.aiGroupSummaryEnabled === next.aiGroupSummaryEnabled &&
    prev.shouldHideStandaloneDetailButton === next.shouldHideStandaloneDetailButton &&
    prev.isPrivateSnsSupported === next.isPrivateSnsSupported &&
    prev.isBatchTranscribing === next.isBatchTranscribing &&
    prev.runningBatchVoiceTaskType === next.runningBatchVoiceTaskType &&
    prev.isBatchDecrypting === next.isBatchDecrypting &&
    prev.isRefreshingMessages === next.isRefreshingMessages &&
    prev.isLoadingMessages === next.isLoadingMessages &&
    prev.currentSessionId === next.currentSessionId &&
    prev.jumpCalendarWrapRef === next.jumpCalendarWrapRef &&
    prev.onToggleGroupSummaryPanel === next.onToggleGroupSummaryPanel &&
    prev.onToggleGroupMembersPanel === next.onToggleGroupMembersPanel &&
    prev.onOpenSnsTimeline === next.onOpenSnsTimeline &&
    prev.onBatchTranscribe === next.onBatchTranscribe &&
    prev.onBatchDecrypt === next.onBatchDecrypt &&
    prev.onToggleJumpPopover === next.onToggleJumpPopover &&
    prev.onToggleInSessionSearch === next.onToggleInSessionSearch &&
    prev.onRefreshMessages === next.onRefreshMessages &&
    prev.onToggleDetailPanel === next.onToggleDetailPanel
  )
}

export default React.memo(ChatHeader, areEqual)
