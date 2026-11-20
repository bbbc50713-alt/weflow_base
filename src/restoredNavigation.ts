import { lazy } from 'react'
import { Archive, BarChart3, CalendarDays, Download, FolderOpen, Footprints, Inbox, Users, UsersRound } from 'lucide-react'

// Shared by the sidebar and router so a visible entry always has a destination.
export const restoredPages = [
  { path: '/analytics', label: '聊天分析', icon: BarChart3, page: lazy(() => import('./pages/ChatAnalyticsHubPage')) },
  { path: '/group-analytics', label: '群聊分析', icon: UsersRound, page: lazy(() => import('./pages/GroupAnalyticsPage')) },
  { path: '/annual-report', label: '年度报告', icon: CalendarDays, page: lazy(() => import('./pages/AnnualReportPage')) },
  { path: '/dual-report', label: '双人报告', icon: Users, page: lazy(() => import('./pages/DualReportPage')) },
  { path: '/footprint', label: '我的足迹', icon: Footprints, page: lazy(() => import('./pages/MyFootprintPage')) },
  { path: '/export', label: '聊天导出', icon: Download, page: lazy(() => import('./pages/Export/ExportPage')) },
  { path: '/resources', label: '资源管理', icon: FolderOpen, page: lazy(() => import('./pages/ResourcesPage')) },
  { path: '/backup', label: '备份', icon: Archive, page: lazy(() => import('./pages/BackupPage')) },
  { path: '/insight-inbox', label: '洞察收件箱', icon: Inbox, page: lazy(() => import('./pages/InsightInboxPage')) },
]

export const detailPages = [
  { path: '/analytics/private', page: lazy(() => import('./pages/AnalyticsWelcomePage')) },
  { path: '/analytics/private/view', page: lazy(() => import('./pages/AnalyticsPage')) },
  { path: '/analytics/group', page: restoredPages.find(p => p.path === '/group-analytics')!.page },
  { path: '/annual-report/view', page: lazy(() => import('./pages/AnnualReportWindow')) },
  { path: '/dual-report/view', page: lazy(() => import('./pages/DualReportWindow')) },
]
