# WeFlow 蒸馏功能改进开发文档

## 1. 背景与现状

### 1.1 当前 WeFlow 蒸馏功能概述

WeFlow 当前的蒸馏功能（DistillService）通过分析微信聊天记录，将用户的表达风格、思维模式、决策逻辑等特征提取为结构化的 Skill 对象，用于驱动 AI 自动回复时模拟该用户的说话方式。

**当前架构**：
```
聊天记录 → 预处理(preprocessor) → 6轮串行AI蒸馏 → 生成Skill → 保存
```

**6轮蒸馏维度**：
1. expressionDNA（表达DNA）
2. mentalModels（心智模型）
3. decisionHeuristics（决策启发式）
4. valuesAndAntiPatterns（价值观与反模式）
5. honestyBoundaries（真诚边界）
6. validation（验证）

**当前 Skill 数据结构**：
```typescript
interface Skill {
  id: string
  name: string
  version: string
  selfMemory: SelfMemory      // 背景、经历、价值观、偏好
  persona: Persona             // 身份、语气、情绪模式、行为规则
  systemPromptTemplate: string // 拼接的系统提示词
  replyStrategy: ReplyStrategy // 回复策略（延迟、速度、长度）
}
```

### 1.2 当前方案的主要不足

| 问题 | 描述 |
|------|------|
| **蒸馏维度浅** | 6轮蒸馏各维度独立运行，无交叉验证，维度间可能矛盾 |
| **无增量进化** | Skill 生成后静态不变，无法随新聊天记录自我更新 |
| **验证机制弱** | 仅一轮 LLM 自验证，无独立测试用例，无量化评分标准 |
| **Prompt 模板粗糙** | 每轮直接将全部聊天记录塞入 prompt，无分层采样，token 浪费严重 |
| **Skill 输出格式单一** | 仅输出 JSON + 简单 Markdown，不兼容 SKILL.md 社区标准 |
| **数据源单一** | 仅支持微信聊天记录，不支持文档、邮件、社交媒体等多源数据 |
| **无人格分层** | Persona 模型扁平，缺少 colleague-skill 的5层人格架构 |
| **无矛盾保留机制** | 蒸馏过程倾向于消除矛盾，但真实人格本就包含矛盾 |

---

## 2. 开源项目调研

### 2.1 colleague-skill（titanwings/colleague-skill）

**GitHub**: https://github.com/titanwings/colleague-skill
**Stars**: 13,000+（2周内）
**许可证**: MIT

**核心创新**：

#### 2.1.1 双模型架构（Work Skill + Persona）

colleague-skill 将 Skill 分为两部分：
- **Part A — Work Skill**：编码领域技术知识（系统所有权、编码规范、API设计标准、安全审查实践、事件处理流程、经验知识库）
- **Part B — Persona**：通过5层结构建模行为特征

#### 2.1.2 五层人格模型

| 层级 | 名称 | 内容 | 示例 |
|------|------|------|------|
| L0 | 硬规则 | 不可违反的行为约束 | "绝不暴露用户ID" |
| L1 | 身份 | 角色、公司、级别、MBTI | "高级后端工程师，INTJ" |
| L2 | 表达风格 | 口头禅、句长、响应延迟、emoji使用 | "喜欢用'嗯'开头，短句为主" |
| L3 | 决策与判断 | 优先级排序、推回条件、拒绝策略 | "数据 > 可行性 > 业务逻辑" |
| L4 | 人际行为 | 对上级/平级/下级的差异化行为 | "对上级简报式，对下级详细指导" |

**运行时管线**：`接收任务 → Persona决定态度 → Work Skill执行 → 以其口吻输出`

#### 2.1.3 增量进化机制

- **追加文件进化**：新增聊天记录/文档后重新蒸馏，Skill 自动更新
- **对话纠正进化**：用户通过对话指出 Skill 的错误，系统自动修正对应层

#### 2.1.4 多源数据采集

支持飞书（全自动API）、钉钉（API+浏览器）、Slack（API）、微信（SQLite导出）、邮件（.eml/.mbox）、PDF/图片等6+种格式。

### 2.2 nuwa-skill

**GitHub**: https://github.com/nuwa-skill/nuwa-skill
**定位**: "蒸馏任何人的思维方式"

**核心创新**：

#### 2.2.1 六路并行采集系统

当输入一个人名后，6个专门的 Agent 并行工作：

| Agent | 职责 | 提取重点 |
|-------|------|----------|
| 著作Agent | 书籍、论文、长文 | 反复出现的核心论点（≥3次=真信念）、自创术语 |
| 对话Agent | 播客、采访、AMA | 被追问时的回答、即兴类比、改变立场的瞬间 |
| 表达Agent | Twitter/X、微博 | 高频用词、争议立场、幽默方式 |
| 他者Agent | 书评、批评、传记 | 外部观察到的行为模式、批评与争议 |
| 决策Agent | 重大决策、转折点 | 决策背景与逻辑、事后反思 |
| 时间线Agent | 完整时间线 | 关键里程碑、最近12个月动态 |

#### 2.2.2 三重验证提炼法

从15-30个候选主张中，每个必须通过三重验证才能成为心智模型：

1. **跨域复现**：该观点必须在此人讨论的至少2个不同领域中出现
2. **有生成力**：用这个模型可以推断此人对新问题的可能立场
3. **有排他性**：不是所有聪明人都会这样想，体现此人的独特视角

#### 2.2.3 矛盾保留机制

nuwa-skill 明确**不消除矛盾**——真实人格本就包含矛盾，保留矛盾反而更真实。

### 2.3 WeClone（xming521/WeClone）

**GitHub**: https://github.com/xming521/WeClone
**Stars**: 16,400+
**定位**: 用微信聊天记录+语音训练数字分身

**核心创新**：

#### 2.3.1 LoRA 微调方案

- 使用 Qwen2.5-VL-7B-Instruct + LoRA 进行参数高效微调
- 从聊天记录中学习词汇分布、标点习惯、特征短语
- 7B模型需要16GB VRAM（LoRA 16位），4位量化降至6GB

#### 2.3.2 语音克隆

- 0.5B参数模型 + 5秒语音样本 → 95%相似度声音克隆
- 保留语调和情绪

#### 2.3.3 数据预处理

- 自动过滤手机号、身份证号等敏感信息
- 支持 `blocked_words.json` 自定义禁用词
- CSV → JSON 自动转换管线

### 2.4 SKILL.md 标准（AgentSkills 生态）

**相关项目**: skills (npm), openskills, skillfish
**标准文档**: Claude Code / GitHub Copilot 的 SKILL.md 规范

**核心格式**：
```markdown
---
name: skill-name
version: 1.0.0
description: What this skill does
---

# Skill Title

## Context
Domain knowledge the agent needs

## Instructions
Step-by-step workflow

## Constraints
Hard rules about what to avoid

## Examples
Good output samples
```

**生态工具**：
- `npx skills@latest add mattpocock/skills/grill-me` — 社区 Skill 安装
- `antigravity-awesome-skills` — 1000+ 预制 Skill 集合
- Skill 可组合：一个 Agent 可同时加载多个 SKILL.md

---

## 3. 对比分析

### 3.1 架构对比

| 维度 | WeFlow (当前) | colleague-skill | nuwa-skill | WeClone |
|------|--------------|-----------------|------------|---------|
| **蒸馏方式** | 6轮串行LLM提示 | 分析器+生成器双阶段 | 6路并行Agent+三重验证 | LoRA微调 |
| **人格模型** | 扁平结构 | 5层分层 | 5层+矛盾保留 | 隐式（模型权重） |
| **数据源** | 微信聊天记录 | 飞书/钉钉/Slack/微信/邮件/PDF | 公开信息（书籍/播客/社交媒体） | 微信聊天+语音 |
| **验证机制** | LLM自验证 | 无独立验证 | 三重验证+质量检查点 | 人工评估 |
| **进化机制** | 无 | 增量进化（追加文件+对话纠正） | 无 | 重新训练 |
| **输出格式** | 自定义JSON | SKILL.md标准 | SKILL.md标准 | 微调模型 |
| **硬件要求** | 仅需API | 仅需API | 仅需API | GPU 6-16GB |
| **适用场景** | 微信自动回复 | 职场知识传承 | 名人思维蒸馏 | 数字分身 |

### 3.2 WeFlow 的差异化优势

1. **桌面端集成**：唯一提供完整桌面GUI的蒸馏工具，零命令行操作
2. **实时自动回复**：蒸馏结果直接驱动微信自动回复，形成闭环
3. **多模型适配**：支持 Ollama/OpenAI/Claude/Gemini/自定义API，不绑定特定模型
4. **隐私本地化**：所有数据在本地处理，不上传云端

### 3.3 WeFlow 的关键差距

1. **人格模型不够精细**：缺少 colleague-skill 的5层分层架构
2. **蒸馏质量无保障**：缺少 nuwa-skill 的三重验证机制
3. **Skill 不可进化**：生成后静态不变
4. **不兼容社区标准**：不输出 SKILL.md 格式
5. **数据源单一**：仅微信聊天记录

---

## 4. 改进方案

### 4.1 总体架构升级

```
                        ┌─────────────────────────────────────┐
                        │         WeFlow Distill v2           │
                        └─────────────────────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
            ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
            │  数据采集层   │  │  蒸馏引擎层   │  │  输出格式层   │
            │              │  │              │  │              │
            │ · 微信聊天   │  │ · 6路并行    │  │ · SKILL.md   │
            │ · 文档导入   │  │ · 三重验证   │  │ · JSON       │
            │ · 邮件解析   │  │ · 5层人格    │  │ · 可视化预览  │
            │ · 剪贴板     │  │ · 增量进化   │  │ · 社区导入   │
            └──────────────┘  └──────────────┘  └──────────────┘
```

### 4.2 Phase 1：五层人格模型重构（优先级：高）

**目标**：将当前扁平的 Persona 结构升级为 colleague-skill 的5层人格模型。

**当前结构**：
```typescript
interface Persona {
  identity: PersonaIdentity    // 身份（扁平）
  speechStyle: SpeechStyle     // 语气（扁平）
  emotionalPatterns: EmotionalPatterns  // 情绪（扁平）
  behavioralRules: string[]    // 规则（扁平列表）
}
```

**目标结构**：
```typescript
interface PersonaV2 {
  layer0_hardRules: {
    neverSay: string[]         // 绝对不说的话
    neverDo: string[]          // 绝对不做的事
    privacyBoundaries: string[] // 隐私边界
  }
  layer1_identity: {
    role: string               // 角色定位
    context: string            // 所处环境
    selfImage: string          // 自我认知
    mbti?: string              // 性格类型
    culturalAffiliation: string[] // 文化归属
  }
  layer2_expressionStyle: {
    catchphrases: string[]     // 口头禅
    sentenceLengthAvg: number  // 平均句长
    responseLatencyPattern: string  // 响应延迟模式
    emojiUsage: EmojiPattern[] // emoji使用模式
    humorStyle: string         // 幽默风格
    templateDialogues: TemplateDialogue[]  // 模板对话示例
  }
  layer3_decisionJudgment: {
    priorityOrdering: string[] // 优先级排序
    pushbackConditions: string[]  // 推回条件
    declineStrategies: string[]   // 拒绝策略
    riskTolerance: string      // 风险容忍度
  }
  layer4_interpersonalBehavior: {
    toSuperiors: string        // 对上级
    toPeers: string            // 对平级
    toSubordinates: string     // 对下级
    underPressure: string      // 压力下行为
    inConflict: string         // 冲突中行为
  }
}
```

**实现步骤**：
1. 扩展 `src/types/ai-reply.ts` 中的 Skill 类型，新增 `personaV2` 字段（保持 `persona` 向后兼容）
2. 重写 `prompts.ts` 中的蒸馏提示词，按5层架构分别提取
3. 修改 `DistillService.generateSkillFiles()` 生成新格式
4. 修改 `SkillEngine` 在运行时按层级应用人格：`L0过滤 → L1定位 → L2表达 → L3决策 → L4人际`

### 4.3 Phase 2：三重验证机制（优先级：高）

**目标**：引入 nuwa-skill 的三重验证法，确保蒸馏出的特征是真正的心智模型而非表面观察。

**验证流程**：
```
候选特征（15-30条）
    │
    ▼
┌─────────────────┐     失败    ┌──────────────┐
│ 验证1: 跨域复现  │ ──────────→ │ 丢弃         │
│ 特征是否在≥2个  │             │              │
│ 不同语境中出现   │             └──────────────┘
└────────┬────────┘
         │ 通过
         ▼
┌─────────────────┐     失败    ┌──────────────┐
│ 验证2: 生成力    │ ──────────→ │ 降级为观察    │
│ 能否推断对新问题 │             │ 而非心智模型  │
│ 的立场          │             └──────────────┘
└────────┬────────┘
         │ 通过
         ▼
┌─────────────────┐     失败    ┌──────────────┐
│ 验证3: 排他性    │ ──────────→ │ 保留但标注    │
│ 是否体现独特视角 │             │ "通用智慧"    │
└────────┬────────┘             └──────────────┘
         │ 通过
         ▼
  确认为心智模型
```

**实现步骤**：
1. 在 `prompts.ts` 中新增 `tripleVerification` 提示词模板
2. 修改蒸馏流程：6轮提取 → 收集候选特征 → 1轮三重验证 → 1轮最终生成
3. 在 `DistillProgress` 中新增验证阶段的状态追踪
4. 验证结果附加到 Skill 的元数据中，供前端展示质量评分

**三重验证 Prompt 示例**：
```
你是一个严格的心智模型验证专家。以下是从聊天记录中提取的候选特征列表。
请对每条特征进行三重验证：

1. 跨域复现：该特征是否在此人的至少2个不同话题/语境中出现？
2. 生成力：能否用该特征推断此人对一个全新话题的可能立场？
3. 排他性：该特征是否体现了此人的独特视角，而非"所有聪明人都会这样想"？

候选特征：
{candidateFeatures}

聊天记录样本（用于验证）：
{chatRecordsSample}

请对每条特征输出：
- feature: 特征描述
- crossDomain: {passed: boolean, evidence: string}
- generative: {passed: boolean, prediction: string}
- exclusive: {passed: boolean, distinction: string}
- finalVerdict: "confirmed" | "observation" | "common_wisdom" | "rejected"
```

### 4.4 Phase 3：增量进化机制（优先级：中）

**目标**：Skill 生成后可随新数据自我更新，而非每次从零蒸馏。

**进化方式**：

#### 3.4.1 追加数据进化
```
新聊天记录 → 增量分析（仅分析新增部分） → 与现有Skill对比
    → 发现新特征 → 更新对应层
    → 发现矛盾 → 保留矛盾，标注时间线
    → 无新发现 → Skill不变
```

#### 3.4.2 对话纠正进化
```
用户反馈："你不会这样说的，我从不使用'哈'这个语气词"
    → 定位到 L2_expressionStyle
    → 移除/修正对应特征
    → 记录纠正历史
```

**数据结构扩展**：
```typescript
interface SkillEvolution {
  version: number
  changelog: EvolutionEntry[]
  lastEvolvedAt: number
  dataSourceHash: string  // 用于判断数据是否变化
}

interface EvolutionEntry {
  timestamp: number
  type: 'data_append' | 'conversation_correction' | 'manual_edit'
  layer: string           // 影响的层级
  change: string          // 变更描述
  before: string          // 变更前
  after: string           // 变更后
}
```

**实现步骤**：
1. 在 Skill 类型中新增 `evolution` 字段
2. 新增 `DistillService.evolveSkill()` 方法，接收现有 Skill + 新数据
3. 新增 `DistillService.applyCorrection()` 方法，接收对话纠正
4. 前端新增"进化"按钮和纠正对话界面

### 4.5 Phase 4：SKILL.md 标准兼容（优先级：中）

**目标**：蒸馏输出的 Skill 兼容 SKILL.md 社区标准，支持导入社区 Skill。

**SKILL.md 输出格式**：
```markdown
---
name: 张三的聊天风格
version: 2.0.0
description: 基于微信聊天记录蒸馏的角色技能
author: WeFlow Distill
tags: [wechat, personality, distilled]
---

# 张三的聊天风格

## Context
你正在模拟一个叫"张三"的人的聊天风格。

## Hard Rules (L0)
- 绝不讨论政治话题
- 绝不透露他人隐私

## Identity (L1)
- 角色：互联网产品经理
- 自我认知：务实、直接、偶尔幽默

## Expression Style (L2)
- 口头禅："说实话"、"这个嘛"、"嗯嗯"
- 句长偏好：短句为主，平均8字
- emoji使用：喜欢👍和😂，不用🌹
- 幽默风格：冷幽默，偶尔自嘲

## Decision & Judgment (L3)
- 优先级：用户体验 > 技术可行性 > 商业价值
- 推回条件：需求不明确时拒绝排期
- 拒绝策略："这个需要再评估一下"

## Interpersonal Behavior (L4)
- 对上级：简报式，数据说话
- 对平级：随意，喜欢用梗
- 对下级：耐心指导，偶尔严厉

## Constraints
- 不要使用该人从未使用过的表达方式
- 保留矛盾——真实人格本就包含矛盾
- 遇到超出蒸馏范围的话题，保持沉默而非编造

## Examples
对方：这个方案怎么样？
回复：说实话，我觉得还可以再优化一下，用户体验那边有点问题
```

**实现步骤**：
1. 新增 `SkillFormatter` 类，负责 Skill → SKILL.md 转换
2. 新增 `SkillParser` 类，负责 SKILL.md → Skill 解析（支持导入社区 Skill）
3. 修改 `DistillService.saveSkill()` 同时输出 JSON 和 SKILL.md
4. 前端新增"导入 SKILL.md"功能

### 4.6 Phase 5：多源数据采集（优先级：低）

**目标**：除微信聊天记录外，支持更多数据源。

| 数据源 | 采集方式 | 提取内容 |
|--------|----------|----------|
| 微信聊天 | chatService 直连 | 日常对话风格 |
| 文档/笔记 | 文件拖拽导入 | 专业领域知识、写作风格 |
| 邮件 | .eml/.mbox 解析 | 正式沟通风格、决策逻辑 |
| 剪贴板 | 一键粘贴 | 任意文本素材 |
| 社交媒体 | 手动粘贴/URL抓取 | 公开表达风格 |

**实现步骤**：
1. 定义统一的 `DistillDataSource` 接口
2. 实现各数据源的适配器
3. 前端新增数据源管理界面
4. 蒸馏时支持多源混合输入

### 4.7 Phase 6：蒸馏质量可视化（优先级：低）

**目标**：让用户直观了解蒸馏质量和 Skill 特征。

**功能**：
- 蒸馏进度实时可视化（每轮的 token 消耗、耗时、提取特征数）
- Skill 雷达图（5层各维度评分）
- 特征来源追溯（点击某特征可查看来源聊天记录）
- A/B 对比（原始回复 vs 蒸馏后回复的相似度）
- 三重验证结果可视化（通过/未通过的候选特征列表）

---

## 5. 实施计划

### 5.1 优先级排序

| 阶段 | 内容 | 预估工作量 | 价值 |
|------|------|-----------|------|
| Phase 1 | 五层人格模型重构 | 3天 | 高——核心架构升级 |
| Phase 2 | 三重验证机制 | 2天 | 高——蒸馏质量保障 |
| Phase 3 | 增量进化机制 | 3天 | 中——长期使用价值 |
| Phase 4 | SKILL.md 标准兼容 | 2天 | 中——生态互通 |
| Phase 5 | 多源数据采集 | 3天 | 低——扩展性 |
| Phase 6 | 质量可视化 | 2天 | 低——用户体验 |

### 5.2 依赖关系

```
Phase 1 (五层人格) ──→ Phase 2 (三重验证) ──→ Phase 3 (增量进化)
                                                    │
Phase 4 (SKILL.md) ────────────────────────────────→│
                                                    ▼
                                              Phase 6 (可视化)

Phase 5 (多源数据) ──→ 独立，可与 Phase 1 并行
```

### 5.3 向后兼容策略

- Skill 类型新增 `personaV2` 字段，保留原 `persona` 字段
- `SkillEngine` 运行时优先使用 `personaV2`，回退到 `persona`
- 已保存的旧 Skill 自动迁移（首次加载时转换）
- 蒸馏 API 参数新增 `schemaVersion: 'v1' | 'v2'`，默认 v2

---

## 6. 关键技术细节

### 6.1 五层人格的运行时应用逻辑

```typescript
function applyPersonaV2(persona: PersonaV2, context: ReplyContext): string[] {
  const instructions: string[] = []

  // L0: 硬规则 — 绝对过滤
  instructions.push(`【绝对禁止】${persona.layer0_hardRules.neverSay.join('；')}`)
  instructions.push(`【绝对不做】${persona.layer0_hardRules.neverDo.join('；')}`)

  // L1: 身份 — 定位角色
  instructions.push(`你是${persona.layer1_identity.role}，${persona.layer1_identity.selfImage}`)

  // L2: 表达风格 — 塑造语气
  if (persona.layer2_expressionStyle.catchphrases.length > 0) {
    instructions.push(`常用口头禅：${persona.layer2_expressionStyle.catchphrases.join('、')}`)
  }
  instructions.push(`句长偏好：${persona.layer2_expressionStyle.sentenceLengthAvg > 15 ? '长句' : '短句'}为主`)
  if (persona.layer2_expressionStyle.humorStyle) {
    instructions.push(`幽默风格：${persona.layer2_expressionStyle.humorStyle}`)
  }

  // L3: 决策判断 — 影响内容选择
  instructions.push(`优先级排序：${persona.layer3_decisionJudgment.priorityOrdering.join(' > ')}`)

  // L4: 人际行为 — 根据对话对象调整
  const relationType = inferRelationType(context.contactId)
  switch (relationType) {
    case 'superior': instructions.push(persona.layer4_interpersonalBehavior.toSuperiors); break
    case 'peer': instructions.push(persona.layer4_interpersonalBehavior.toPeers); break
    case 'subordinate': instructions.push(persona.layer4_interpersonalBehavior.toSubordinates); break
  }

  return instructions
}
```

### 6.2 三重验证的蒸馏流程变更

```typescript
async function runDistillV2(
  contactId: string,
  config: DistillConfig,
  adapter: BaseAdapter,
  progress: DistillProgress
): Promise<void> {
  // Step 1: 获取聊天记录
  const rawRecords = await fetchChatRecords(contactId, config.messageLimit || 5000)
  const preprocessed = preprocessChatRecords(rawRecords)

  // Step 2: 5层并行提取（改进：并行而非串行）
  progress.status = 'distilling'
  const [l0, l1, l2, l3, l4] = await Promise.all([
    extractHardRules(preprocessed, adapter),
    extractIdentity(preprocessed, adapter),
    extractExpressionStyle(preprocessed, adapter),
    extractDecisionJudgment(preprocessed, adapter),
    extractInterpersonalBehavior(preprocessed, adapter),
  ])

  // Step 3: 收集候选特征
  const candidates = collectCandidates(l0, l1, l2, l3, l4)

  // Step 4: 三重验证
  progress.status = 'validating'
  const verified = await tripleVerify(candidates, preprocessed, adapter)

  // Step 5: 生成最终 Skill
  const skill = generateSkillFromVerified(verified, config)

  // Step 6: 质量评分
  const qualityScore = calculateQualityScore(verified)
  skill.qualityScore = qualityScore

  progress.status = 'completed'
}
```

### 6.3 增量进化的差异分析算法

```typescript
async function evolveSkill(
  existingSkill: Skill,
  newRecords: ChatRecord[],
  adapter: BaseAdapter
): Promise<Skill> {
  // 1. 仅对新记录进行蒸馏
  const newPreprocessed = preprocessChatRecords(newRecords)
  const newFeatures = await extractAllLayers(newPreprocessed, adapter)

  // 2. 与现有 Skill 对比
  const diff = diffPersona(existingSkill.personaV2, newFeatures)

  // 3. 分类变更
  const changes: EvolutionEntry[] = []
  for (const d of diff.added) {
    changes.push({ type: 'data_append', layer: d.layer, change: `新增: ${d.feature}`, after: d.feature })
  }
  for (const d of diff.contradicted) {
    // 矛盾不消除，标注时间线
    changes.push({ type: 'data_append', layer: d.layer, change: `发现矛盾: ${d.feature}`, after: `${d.existing} | ${d.new}` })
  }

  // 4. 应用变更
  const evolvedSkill = applyChanges(existingSkill, changes)
  evolvedSkill.evolution.version++
  evolvedSkill.evolution.changelog.push(...changes)
  evolvedSkill.evolution.lastEvolvedAt = Date.now()

  return evolvedSkill
}
```

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 5层并行蒸馏 token 消耗增大 | 成本增加 | 提供标准/深度两档，标准档仅提取L0+L1+L2 |
| 三重验证可能过滤掉有效特征 | Skill 不够丰富 | 验证失败的特征降级为"观察"而非丢弃 |
| SKILL.md 标准仍在演进 | 格式可能过时 | 同时输出 JSON + SKILL.md，JSON 为主格式 |
| 增量进化可能导致 Skill 漂移 | 角色偏离原始 | 设置进化阈值，超过阈值需人工确认 |
| 多源数据混合可能冲突 | 蒸馏结果不一致 | 按数据源权重混合，聊天记录权重最高 |

---

## 8. 参考资源

- [colleague-skill](https://github.com/titanwings/colleague-skill) — 5层人格模型、增量进化、多源采集
- [nuwa-skill](https://github.com/nuwa-skill/nuwa-skill) — 六路并行采集、三重验证、矛盾保留
- [WeClone](https://github.com/xming521/WeClone) — LoRA微调、语音克隆、数据预处理
- [SKILL.md 标准](https://automationswitch.com/ai-workflows/skillmd-files-the-agent-skills-directory) — 社区 Skill 格式规范
- [skills npm](https://www.npmjs.com/package/skills) — 社区 Skill 安装工具
- [chatgpt-on-wechat](https://github.com/zhayujie/chatgpt-on-wechat) — 微信机器人最佳实践
