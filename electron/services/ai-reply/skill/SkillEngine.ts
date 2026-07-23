import { readFile, readdir, mkdir, cp, rm, writeFile, rmdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import type { Skill, SelfMemory, Persona, PersonaIdentity, SpeechStyle, EmotionalPatterns, ReplyStrategy, PersonaV2 } from '../../../../src/types/ai-reply'
import { DEFAULT_REPLY_STRATEGY } from '../../../../src/types/ai-reply'

export class SkillEngine {
  private skills: Map<string, Skill> = new Map()
  private skillsDir: string

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir
  }

  async loadAllSkills(): Promise<Skill[]> {
    this.skills.clear()

    this.addBuiltinSkills()

    if (existsSync(this.skillsDir)) {
      const entries = await readdir(this.skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            const skill = await this.loadSkillFromDirectory(join(this.skillsDir, entry.name))
            if (skill && !this.skills.has(skill.id)) {
              this.skills.set(skill.id, skill)
            }
          } catch (e) {
            console.warn(`[SkillEngine] Failed to load skill from ${entry.name}:`, e)
          }
        }
      }
    }

    return Array.from(this.skills.values())
  }

  getSkill(id: string): Skill | undefined {
    return this.skills.get(id)
  }

  /**
   * 暴露 skills 目录路径，避免上层通过反射访问私有字段。
   */
  getSkillsDir(): string {
    return this.skillsDir
  }

  getAllSkills(): Skill[] {
    return Array.from(this.skills.values())
  }

  addSkill(skill: Skill): void {
    this.skills.set(skill.id, skill)
    this.persistSkillToDisk(skill).catch(() => {})
  }

  removeSkill(id: string): boolean {
    if (this.skills.has(id) && !this.skills.get(id)?.isBuiltin) {
      this.skills.delete(id)
      this.removeSkillFromDisk(id).catch(() => {})
      return true
    }
    return false
  }

  generateSystemPrompt(skill: Skill, extraContext?: {
    recentMessages?: Array<{ role: string; content: string }>
    relevantMemories?: string[]
    relationship?: { relationType: string; notes?: string } | undefined
    contextSummary?: string | undefined
  }): string {
    if (skill.personaV2) {
      return this.generateSystemPromptV2(skill, extraContext)
    }
    return this.generateSystemPromptV1(skill, extraContext)
  }

  private generateSystemPromptV2(skill: Skill, extraContext?: {
    recentMessages?: Array<{ role: string; content: string }>
    relevantMemories?: string[]
    relationship?: { relationType: string; notes?: string } | undefined
    contextSummary?: string | undefined
  }): string {
    const p = skill.personaV2!
    const parts: string[] = []

    parts.push(`# 角色设定`)

    if (p.layer0_hardRules.neverSay.length > 0 || p.layer0_hardRules.neverDo.length > 0 || p.layer0_hardRules.privacyBoundaries.length > 0) {
      parts.push('')
      parts.push(`## 绝对规则（不可违反）`)
      p.layer0_hardRules.neverSay.forEach(s => parts.push(`- 绝对不要说: ${s}`))
      p.layer0_hardRules.neverDo.forEach(s => parts.push(`- 绝对不要做: ${s}`))
      p.layer0_hardRules.privacyBoundaries.forEach(s => parts.push(`- 隐私边界: ${s}`))
    }

    parts.push('')
    parts.push(`## 身份`)
    parts.push(`你是「${p.layer1_identity.role}」。${p.layer1_identity.selfImage}`)
    if (p.layer1_identity.context) parts.push(`所处环境: ${p.layer1_identity.context}`)
    if (p.layer1_identity.mbti) parts.push(`MBTI: ${p.layer1_identity.mbti}`)
    if (p.layer1_identity.culturalAffiliation.length > 0) {
      parts.push(`文化归属: ${p.layer1_identity.culturalAffiliation.join('、')}`)
    }

    parts.push('')
    parts.push(`## 表达风格`)
    if (p.layer2_expressionStyle.tone) parts.push(`- 语气: ${p.layer2_expressionStyle.tone}`)
    if (p.layer2_expressionStyle.catchphrases.length > 0) {
      parts.push(`- 口头禅: ${p.layer2_expressionStyle.catchphrases.join('、')}`)
    }
    if (p.layer2_expressionStyle.humorStyle) parts.push(`- 幽默风格: ${p.layer2_expressionStyle.humorStyle}`)
    if (p.layer2_expressionStyle.sentenceLengthAvg > 0) {
      parts.push(`- 句长偏好: ${p.layer2_expressionStyle.sentenceLengthAvg > 15 ? '长句' : '短句'}为主（平均${p.layer2_expressionStyle.sentenceLengthAvg}字）`)
    }
    if (p.layer2_expressionStyle.responseLatencyPattern) {
      parts.push(`- 回复节奏: ${p.layer2_expressionStyle.responseLatencyPattern}`)
    }
    if (p.layer2_expressionStyle.vocabulary.length > 0) {
      parts.push(`- 常用词汇: ${p.layer2_expressionStyle.vocabulary.join('、')}`)
    }
    if (p.layer2_expressionStyle.sentencePatterns.length > 0) {
      parts.push(`- 句式特点: ${p.layer2_expressionStyle.sentencePatterns.join('、')}`)
    }
    if (p.layer2_expressionStyle.templateDialogues.length > 0) {
      parts.push(`- 典型对话:`)
      p.layer2_expressionStyle.templateDialogues.forEach(t => {
        if (t && typeof t === 'object') {
          parts.push(`  - 问:"${t.trigger || ''}" → 答:"${t.response || ''}"`)
        }
      })
    }

    parts.push('')
    parts.push(`## 决策判断`)
    if (p.layer3_decisionJudgment.priorityOrdering.length > 0) {
      parts.push(`- 优先级: ${p.layer3_decisionJudgment.priorityOrdering.join(' > ')}`)
    }
    if (p.layer3_decisionJudgment.pushbackConditions.length > 0) {
      parts.push(`- 推回条件: ${p.layer3_decisionJudgment.pushbackConditions.join('；')}`)
    }
    if (p.layer3_decisionJudgment.declineStrategies.length > 0) {
      parts.push(`- 拒绝方式: ${p.layer3_decisionJudgment.declineStrategies.join('；')}`)
    }
    if (p.layer3_decisionJudgment.riskTolerance) {
      parts.push(`- 风险态度: ${p.layer3_decisionJudgment.riskTolerance}`)
    }

    parts.push('')
    parts.push(`## 人际行为`)
    if (p.layer4_interpersonalBehavior.toSuperiors) parts.push(`- 对上级/长辈: ${p.layer4_interpersonalBehavior.toSuperiors}`)
    if (p.layer4_interpersonalBehavior.toPeers) parts.push(`- 对平级/朋友: ${p.layer4_interpersonalBehavior.toPeers}`)
    if (p.layer4_interpersonalBehavior.toSubordinates) parts.push(`- 对下级/晚辈: ${p.layer4_interpersonalBehavior.toSubordinates}`)
    if (p.layer4_interpersonalBehavior.underPressure) parts.push(`- 压力下: ${p.layer4_interpersonalBehavior.underPressure}`)
    if (p.layer4_interpersonalBehavior.inConflict) parts.push(`- 冲突中: ${p.layer4_interpersonalBehavior.inConflict}`)

    if (skill.selfMemory.values.length > 0) {
      parts.push('')
      parts.push(`## 核心价值观`)
      skill.selfMemory.values.forEach(v => parts.push(`- ${v}`))
    }

    if (extraContext?.relationship) {
      parts.push('')
      parts.push(`## 与对方的关系`)
      parts.push(`关系类型: ${extraContext.relationship.relationType}`)
      if (extraContext.relationship.notes) {
        parts.push(`备注: ${extraContext.relationship.notes}`)
      }
    }

    if (extraContext?.relevantMemories && extraContext.relevantMemories.length > 0) {
      parts.push('')
      parts.push(`## 相关记忆`)
      extraContext.relevantMemories.forEach(m => parts.push(`- ${m}`))
    }

    if (extraContext?.contextSummary) {
      parts.push('')
      parts.push(`## 对话历史摘要`)
      parts.push(extraContext.contextSummary)
    }

    if (skill.systemPromptTemplate) {
      parts.push('')
      parts.push(skill.systemPromptTemplate)
    }

    parts.push('')
    parts.push('---')
    parts.push('注意：回复必须符合上述角色设定，用第一人称"我"来回应。保留矛盾——真实人格本就包含矛盾。遇到超出蒸馏范围的话题，保持沉默而非编造。')

    return parts.join('\n')
  }

  private generateSystemPromptV1(skill: Skill, extraContext?: {
    recentMessages?: Array<{ role: string; content: string }>
    relevantMemories?: string[]
    relationship?: { relationType: string; notes?: string } | undefined
    contextSummary?: string | undefined
  }): string {
    const { persona, selfMemory } = skill
    const parts: string[] = []

    parts.push(`# 角色设定`)
    parts.push(`你是「${persona.identity.role}」，${selfMemory.background}`)
    parts.push('')

    parts.push(`## 身份信息`)
    if (persona.identity.age) parts.push(`- 年龄: ${persona.identity.age}`)
    if (persona.identity.occupation) parts.push(`- 职业: ${persona.identity.occupation}`)
    if (persona.identity.mbti) parts.push(`- MBTI: ${persona.identity.mbti}`)
    parts.push(`- 性格标签: ${persona.identity.tags.join(', ')}`)
    parts.push('')

    if (persona.speechStyle.tone || persona.speechStyle.vocabulary.length > 0) {
      parts.push(`## 说话风格`)
      if (persona.speechStyle.tone) parts.push(`语气: ${persona.speechStyle.tone}`)
      if (persona.speechStyle.vocabulary.length > 0) {
        parts.push(`常用词汇: ${persona.speechStyle.vocabulary.join(', ')}`)
      }
      if (persona.speechStyle.sentencePatterns.length > 0) {
        parts.push(`句式特点: ${persona.speechStyle.sentencePatterns.join(', ')}`)
      }
      if (persona.speechStyle.emojiUsage) {
        parts.push(`表情使用: ${persona.speechStyle.emojiUsage}`)
      }
      parts.push('')
    }

    if (selfMemory.values.length > 0) {
      parts.push(`## 核心价值观`)
      selfMemory.values.forEach(v => parts.push(`- ${v}`))
      parts.push('')
    }

    if (persona.behavioralRules.length > 0) {
      parts.push(`## 行为规则`)
      persona.behavioralRules.forEach(r => parts.push(`- ${r}`))
      parts.push('')
    }

    if (selfMemory.experiences.length > 0) {
      parts.push(`## 重要记忆`)
      selfMemory.experiences.forEach(e => parts.push(`- ${e}`))
      parts.push('')
    }

    if (extraContext?.relationship) {
      parts.push(`## 与对方的关系`)
      parts.push(`关系类型: ${extraContext.relationship.relationType}`)
      if (extraContext.relationship.notes) {
        parts.push(`备注: ${extraContext.relationship.notes}`)
      }
      parts.push('')
    }

    if (extraContext?.relevantMemories && extraContext.relevantMemories.length > 0) {
      parts.push(`## 相关记忆`)
      extraContext.relevantMemories.forEach(m => parts.push(`- ${m}`))
      parts.push('')
    }

    if (extraContext?.contextSummary) {
      parts.push(`## 对话历史摘要`)
      parts.push(extraContext.contextSummary)
      parts.push('')
    }

    if (skill.systemPromptTemplate) {
      parts.push(skill.systemPromptTemplate)
      parts.push('')
    }

    parts.push('---')
    parts.push('注意：回复必须符合上述角色设定，用第一人称"我"来回应。')

    return parts.join('\n')
  }

  private addBuiltinSkills(): void {
    const defaultSkill: Skill = {
      id: 'default-assistant',
      name: '默认助手',
      version: '1.0.0',
      description: '通用 AI 助手，适用于大多数对话场景',
      selfMemory: {
        background: '你是一个友好的 AI 助手',
        experiences: [],
        values: ['乐于助人', '诚实', '尊重'],
        preferences: {},
        relationships: []
      },
      persona: {
        identity: {
          role: 'AI 助手',
          tags: ['友好', '专业', '简洁']
        },
        speechStyle: {
          tone: '友好、专业、简洁',
          vocabulary: [],
          sentencePatterns: [],
          emojiUsage: '适度使用'
        },
        emotionalPatterns: {
          triggers: {},
          copingMechanisms: []
        },
        behavioralRules: [
          '回复要简洁明了',
          '保持友好态度',
          '不确定时坦诚说明'
        ]
      },
      systemPromptTemplate: '',
      replyStrategy: DEFAULT_REPLY_STRATEGY,
      isBuiltin: true
    }

    this.skills.set(defaultSkill.id, defaultSkill)
  }

  private async loadSkillFromDirectory(dirPath: string): Promise<Skill | null> {
    const skillJsonPath = join(dirPath, 'skill.json')
    if (existsSync(skillJsonPath)) {
      try {
        const raw = await readFile(skillJsonPath, 'utf-8')
        const skill = JSON.parse(raw) as Skill
        if (skill.id) return skill
      } catch (e) {
        console.warn(`[SkillEngine] Failed to parse skill.json from ${dirPath}:`, e)
      }
    }

    const skillMdPath = join(dirPath, 'SKILL.md')
    const selfMdPath = join(dirPath, 'self.md')
    const personaMdPath = join(dirPath, 'persona.md')

    if (!existsSync(skillMdPath)) return null

    const [skillMdContent, selfMdContent, personaMdContent] = await Promise.all([
      readFile(skillMdPath, 'utf-8').catch(() => ''),
      readFile(selfMdPath, 'utf-8').catch(() => ''),
      readFile(personaMdPath, 'utf-8').catch(() => '')
    ])

    const metaData = this.parseSkillMd(skillMdContent)
    const selfData = this.parseSelfMd(selfMdContent)
    const personaData = this.parsePersonaMd(personaMdContent)

    return {
      id: metaData.id || dirPath.split('/').pop() || 'unknown',
      name: metaData.name || '未命名角色',
      version: metaData.version || '1.0.0',
      author: metaData.author,
      description: metaData.description || '',
      selfMemory: selfData,
      persona: personaData,
      systemPromptTemplate: metaData.systemPrompt || '',
      replyStrategy: DEFAULT_REPLY_STRATEGY,
      isBuiltin: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }

  private parseSkillMd(content: string): {
    id?: string
    name?: string
    version?: string
    author?: string
    description?: string
    systemPrompt?: string
  } {
    const result: Record<string, string> = {}

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1]
      for (const line of frontmatter.split('\n')) {
        const match = line.match(/^(\w+):\s*(.+)/)
        if (match) {
          result[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
        }
      }
    }

    const nameMatch = content.match(/^#\s+(.+)$/m)
    if (nameMatch && !result.name) {
      result.name = nameMatch[1].trim()
    }

    return result
  }

  private parseSelfMd(content: string): SelfMemory {
    if (!content) {
      return { background: '', experiences: [], values: [], preferences: {}, relationships: [] }
    }

    const sections = this.splitSections(content)

    return {
      background: sections['背景'] || sections['background'] || '',
      experiences: this.parseListSection(sections['经历'] || sections['experiences'] || ''),
      values: this.parseListSection(sections['价值观'] || sections['values'] || ''),
      preferences: {},
      relationships: []
    }
  }

  private parsePersonaMd(content: string): Persona {
    if (!content) {
      return {
        identity: { role: '', tags: [] },
        speechStyle: { tone: '', vocabulary: [], sentencePatterns: [], emojiUsage: '' },
        emotionalPatterns: { triggers: {}, copingMechanisms: [] },
        behavioralRules: []
      }
    }

    const sections = this.splitSections(content)

    const identity: PersonaIdentity = {
      role: sections['身份'] || sections['identity'] || '',
      tags: this.parseListSection(sections['性格标签'] || sections['tags'] || '')
    }

    const speechStyle: SpeechStyle = {
      tone: sections['语气'] || sections['tone'] || '',
      vocabulary: this.parseListSection(sections['常用词汇'] || sections['vocabulary'] || ''),
      sentencePatterns: this.parseListSection(sections['句式'] || sections['patterns'] || ''),
      emojiUsage: sections['表情'] || sections['emoji'] || ''
    }

    const emotionalPatterns: EmotionalPatterns = {
      triggers: {},
      copingMechanisms: this.parseListSection(sections['应对'] || sections['coping'] || '')
    }

    const behavioralRules = this.parseListSection(sections['规则'] || sections['rules'] || '')

    return {
      identity,
      speechStyle,
      emotionalPatterns,
      behavioralRules
    }
  }

  private splitSections(content: string): Record<string, string> {
    const sections: Record<string, string> = {}
    let currentHeader = ''
    let currentContent: string[] = []

    for (const line of content.split('\n')) {
      const headerMatch = line.match(/^##?\s+(.+)$/)
      if (headerMatch) {
        if (currentHeader) {
          sections[currentHeader] = currentContent.join('\n').trim()
        }
        currentHeader = headerMatch[1].trim()
        currentContent = []
      } else {
        currentContent.push(line)
      }
    }

    if (currentHeader) {
      sections[currentHeader] = currentContent.join('\n').trim()
    }

    return sections
  }

  private parseListSection(content: string): string[] {
    return content
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/, '').trim())
      .filter(line => line.length > 0)
  }

  async importSkillFromDirectory(sourceDir: string): Promise<Skill> {
    const skill = await this.loadSkillFromDirectory(sourceDir)
    if (!skill) {
      throw new Error(`No valid skill found in ${sourceDir}`)
    }

    const destDir = join(this.skillsDir, skill.id)
    await mkdir(destDir, { recursive: true })
    await cp(sourceDir, destDir, { recursive: true })

    skill.updatedAt = Date.now()
    this.skills.set(skill.id, skill)
    return skill
  }

  async importSkillFromZip(zipPath: string): Promise<Skill> {
    const tmpDir = join(this.skillsDir, `.tmp_import_${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      // 修复命令注入：使用 execFile + 参数数组，避免 shell 解析特殊字符。
      // 路径中若包含 `"$(...)"` 等 shell 元字符，旧实现可任意执行命令。
      await new Promise<void>((resolve, reject) => {
        execFile('unzip', ['-o', zipPath, '-d', tmpDir], (error) => {
          if (error) reject(error)
          else resolve()
        })
      })

      const entries = await readdir(tmpDir, { withFileTypes: true })
      const skillDir = entries.find(e => e.isDirectory())?.name

      if (!skillDir) {
        throw new Error('No directory found in zip file')
      }

      const sourceDir = join(tmpDir, skillDir)
      const skill = await this.importSkillFromDirectory(sourceDir)
      return skill
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  async importSkillFromGit(repoUrl: string): Promise<Skill> {
    const tmpDir = join(this.skillsDir, `.tmp_git_${Date.now()}`)

    try {
      // 修复命令注入：使用 execFile + 参数数组，避免 shell 解析 repoUrl。
      await new Promise<void>((resolve, reject) => {
        execFile('git', ['clone', '--depth', '1', repoUrl, tmpDir], (error) => {
          if (error) reject(error)
          else resolve()
        })
      })

      const skill = await this.importSkillFromDirectory(tmpDir)
      return skill
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  private async persistSkillToDisk(skill: Skill): Promise<void> {
    if (skill.isBuiltin) return
    try {
      const dir = join(this.skillsDir, skill.id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'skill.json'), JSON.stringify(skill, null, 2), 'utf-8')
      await writeFile(join(dir, 'SKILL.md'), this.renderSkillMd(skill), 'utf-8')
      await writeFile(join(dir, 'self.md'), this.renderSelfMd(skill), 'utf-8')
      const personaMd = skill.personaV2
        ? this.renderPersonaV2Md(skill)
        : this.renderPersonaMd(skill)
      await writeFile(join(dir, 'persona.md'), personaMd, 'utf-8')
    } catch {}
  }

  private async removeSkillFromDisk(id: string): Promise<void> {
    try {
      const dir = join(this.skillsDir, id)
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true })
      }
    } catch {}
  }

  private renderSkillMd(skill: Skill): string {
    const lines: string[] = []
    lines.push('---')
    lines.push(`id: ${skill.id}`)
    lines.push(`name: ${skill.name}`)
    lines.push(`version: ${skill.version}`)
    if (skill.author) lines.push(`author: ${skill.author}`)
    lines.push(`description: ${skill.description}`)
    if (skill.qualityScore) lines.push(`quality: ${skill.qualityScore.overall}`)
    lines.push('---')
    lines.push('')
    lines.push(`# ${skill.name}`)
    lines.push('')
    lines.push(skill.description)
    if (skill.qualityScore) {
      lines.push('')
      lines.push('## 质量评分')
      lines.push(`- 综合: ${skill.qualityScore.overall}`)
      lines.push(`- 一致性: ${skill.qualityScore.consistency}`)
      lines.push(`- 准确性: ${skill.qualityScore.accuracy}`)
      lines.push(`- 完整性: ${skill.qualityScore.completeness}`)
      lines.push(`- 验证通过特征: ${skill.qualityScore.verifiedFeatureCount}/${skill.qualityScore.totalCandidateCount}`)
    }
    return lines.join('\n')
  }

  private renderSelfMd(skill: Skill): string {
    const lines: string[] = []
    lines.push('# 自我记忆')
    lines.push('')
    lines.push('## 背景')
    lines.push(skill.selfMemory.background)
    lines.push('')
    lines.push('## 经历')
    for (const exp of skill.selfMemory.experiences) {
      lines.push(`- ${exp}`)
    }
    lines.push('')
    lines.push('## 价值观')
    for (const v of skill.selfMemory.values) {
      lines.push(`- ${v}`)
    }
    return lines.join('\n')
  }

  private renderPersonaMd(skill: Skill): string {
    const lines: string[] = []
    lines.push('# 角色设定')
    lines.push('')
    lines.push('## 身份')
    lines.push(skill.persona.identity.role)
    lines.push('')
    lines.push('## 性格标签')
    for (const tag of skill.persona.identity.tags) {
      lines.push(`- ${tag}`)
    }
    lines.push('')
    lines.push('## 语气')
    lines.push(skill.persona.speechStyle.tone)
    lines.push('')
    lines.push('## 常用词汇')
    for (const v of skill.persona.speechStyle.vocabulary) {
      lines.push(`- ${v}`)
    }
    lines.push('')
    lines.push('## 句式')
    for (const p of skill.persona.speechStyle.sentencePatterns) {
      lines.push(`- ${p}`)
    }
    lines.push('')
    lines.push('## 规则')
    for (const r of skill.persona.behavioralRules) {
      lines.push(`- ${r}`)
    }
    return lines.join('\n')
  }

  private renderPersonaV2Md(skill: Skill): string {
    const p = skill.personaV2!
    const lines: string[] = []
    lines.push('# 角色设定（五层人格架构）')
    lines.push('')

    lines.push('## L0 硬规则')
    if (p.layer0_hardRules.neverSay.length > 0) {
      lines.push('### 绝对不说')
      p.layer0_hardRules.neverSay.forEach(s => lines.push(`- ${s}`))
    }
    if (p.layer0_hardRules.neverDo.length > 0) {
      lines.push('### 绝对不做')
      p.layer0_hardRules.neverDo.forEach(s => lines.push(`- ${s}`))
    }
    if (p.layer0_hardRules.privacyBoundaries.length > 0) {
      lines.push('### 隐私边界')
      p.layer0_hardRules.privacyBoundaries.forEach(s => lines.push(`- ${s}`))
    }
    lines.push('')

    lines.push('## L1 身份')
    lines.push(`- 角色: ${p.layer1_identity.role}`)
    lines.push(`- 环境: ${p.layer1_identity.context}`)
    lines.push(`- 自我认知: ${p.layer1_identity.selfImage}`)
    if (p.layer1_identity.mbti) lines.push(`- MBTI: ${p.layer1_identity.mbti}`)
    if (p.layer1_identity.culturalAffiliation.length > 0) {
      lines.push('- 文化归属:')
      p.layer1_identity.culturalAffiliation.forEach(s => lines.push(`  - ${s}`))
    }
    lines.push('')

    lines.push('## L2 表达风格')
    lines.push(`- 语气: ${p.layer2_expressionStyle.tone}`)
    lines.push(`- 幽默: ${p.layer2_expressionStyle.humorStyle}`)
    lines.push(`- 平均句长: ${p.layer2_expressionStyle.sentenceLengthAvg}字`)
    lines.push(`- 回复延迟模式: ${p.layer2_expressionStyle.responseLatencyPattern}`)
    if (p.layer2_expressionStyle.catchphrases.length > 0) {
      lines.push('- 口头禅:')
      p.layer2_expressionStyle.catchphrases.forEach(s => lines.push(`  - ${s}`))
    }
    if (p.layer2_expressionStyle.vocabulary.length > 0) {
      lines.push('- 常用词汇:')
      p.layer2_expressionStyle.vocabulary.forEach(s => lines.push(`  - ${s}`))
    }
    if (p.layer2_expressionStyle.sentencePatterns.length > 0) {
      lines.push('- 句式特点:')
      p.layer2_expressionStyle.sentencePatterns.forEach(s => lines.push(`  - ${s}`))
    }
    if (p.layer2_expressionStyle.emojiUsage.length > 0) {
      lines.push('- 表情使用:')
      p.layer2_expressionStyle.emojiUsage.forEach(ep => {
        const ctxs = Array.isArray(ep.contexts) ? ep.contexts.join(', ') : ''
        lines.push(`  - ${ep.emoji} (${ep.frequency})${ctxs ? ` [${ctxs}]` : ''}`)
      })
    }
    if (p.layer2_expressionStyle.templateDialogues.length > 0) {
      lines.push('- 模板对话:')
      p.layer2_expressionStyle.templateDialogues.forEach(td => {
        if (td && typeof td === 'object') {
          lines.push(`  - ${td.trigger || ''} → ${td.response || ''}`)
        }
      })
    }
    lines.push('')

    lines.push('## L3 决策判断')
    if (p.layer3_decisionJudgment.priorityOrdering.length > 0) {
      lines.push(`- 优先级: ${p.layer3_decisionJudgment.priorityOrdering.join(' > ')}`)
    }
    lines.push(`- 风险态度: ${p.layer3_decisionJudgment.riskTolerance}`)
    if (p.layer3_decisionJudgment.declineStrategies.length > 0) {
      lines.push('- 拒绝策略:')
      p.layer3_decisionJudgment.declineStrategies.forEach(s => lines.push(`  - ${s}`))
    }
    if (p.layer3_decisionJudgment.pushbackConditions.length > 0) {
      lines.push('- 推回条件:')
      p.layer3_decisionJudgment.pushbackConditions.forEach(s => lines.push(`  - ${s}`))
    }
    lines.push('')

    lines.push('## L4 人际行为')
    lines.push(`- 对上级: ${p.layer4_interpersonalBehavior.toSuperiors}`)
    lines.push(`- 对平级: ${p.layer4_interpersonalBehavior.toPeers}`)
    lines.push(`- 对下级: ${p.layer4_interpersonalBehavior.toSubordinates}`)
    lines.push(`- 压力下: ${p.layer4_interpersonalBehavior.underPressure}`)
    lines.push(`- 冲突中: ${p.layer4_interpersonalBehavior.inConflict}`)

    return lines.join('\n')
  }
}
