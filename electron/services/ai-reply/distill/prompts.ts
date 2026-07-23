export const DISTILL_PROMPTS_V2 = {
  layer0_hardRules: `你是一个专业的行为边界分析师。请分析以下聊天记录中"我方"的硬性规则——那些不可违反的行为约束。

请从以下维度分析：
1. 绝对不说的话：有哪些话题或表达方式是此人绝对不会使用的
2. 绝对不做的事：有哪些行为是此人绝对不会采取的
3. 隐私边界：有哪些信息是此人绝对不会透露的

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- neverSay: 绝对不说的话列表（每条用简短描述）
- neverDo: 绝对不做的事列表
- privacyBoundaries: 隐私边界列表`,

  layer1_identity: `你是一个专业的身份认知分析师。请分析以下聊天记录中"我方"的身份认知。

请从以下维度分析：
1. 角色定位：此人在社交中扮演什么角色（如：倾听者、决策者、协调者等）
2. 所处环境：此人处于什么样的社交或工作环境
3. 自我认知：此人如何看待自己
4. 性格类型：如果可以推断，此人的MBTI类型倾向
5. 文化归属：此人的文化背景、价值观来源

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- role: 角色定位描述
- context: 所处环境描述
- selfImage: 自我认知描述
- mbti: MBTI类型（如无法推断则为空字符串）
- culturalAffiliation: 文化归属列表`,

  layer2_expressionStyle: `你是一个专业的语言风格分析师。请深度分析以下聊天记录中"我方"的表达DNA。

请从以下维度分析：
1. 口头禅：反复使用的短语或词语（至少出现3次才算）
2. 平均句长：此人的消息通常多长（估算字数）
3. 响应延迟模式：通常多久回复（秒级估算）
4. emoji使用模式：哪些emoji用得多、在什么语境下使用
5. 幽默风格：此人的幽默方式（冷幽默、自嘲、讽刺等）
6. 模板对话：有哪些固定的问答模式
7. 语气特征：日常语气、情绪化表达、反讽使用等
8. 词汇偏好：高频词汇、网络用语、专业术语等
9. 句式特点：长句/短句偏好、反问句使用、省略句使用等

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- catchphrases: 口头禅列表
- sentenceLengthAvg: 平均句长（整数，字数）
- responseLatencyPattern: 响应延迟模式描述
- emojiUsage: emoji使用模式列表，每项包含emoji、频率(high/medium/low)、使用语境
- humorStyle: 幽默风格描述
- templateDialogues: 模板对话列表，每项包含触发条件和典型回复
- tone: 语气特征描述
- vocabulary: 常用词汇列表（最多20个）
- sentencePatterns: 句式特点列表`,

  layer3_decisionJudgment: `你是一个专业的决策模式分析师。请分析以下聊天记录中"我方"的决策与判断模式。

请从以下维度分析：
1. 优先级排序：面对多个考量时，此人的优先级排序是什么
2. 推回条件：在什么情况下此人会拒绝或推回请求
3. 拒绝策略：此人如何委婉或直接地拒绝
4. 风险容忍度：此人对风险的态度（保守/中性/激进）

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- priorityOrdering: 优先级排序列表（从高到低）
- pushbackConditions: 推回条件列表
- declineStrategies: 拒绝策略列表
- riskTolerance: 风险容忍度描述`,

  layer4_interpersonalBehavior: `你是一个专业的人际行为分析师。请分析以下聊天记录中"我方"的人际行为模式。

请从以下维度分析：
1. 对上级/长辈：此人与上级或长辈交流时的行为特征
2. 对平级/朋友：此人与平级或朋友交流时的行为特征
3. 对下级/晚辈：此人与下级或晚辈交流时的行为特征
4. 压力下行为：面对压力或紧急情况时的典型反应
5. 冲突中行为：面对分歧或冲突时的处理方式

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- toSuperiors: 对上级/长辈的行为描述
- toPeers: 对平级/朋友的行为描述
- toSubordinates: 对下级/晚辈的行为描述
- underPressure: 压力下行为描述
- inConflict: 冲突中行为描述`,

  tripleVerification: `你是一个严格的心智模型验证专家。以下是从聊天记录中提取的候选特征列表。
请对每条特征进行三重验证，确保提取的是真正的心智模型而非表面观察。

三重验证规则：
1. 跨域复现：该特征是否在此人的至少2个不同话题/语境中出现？如果是，说明证据。
2. 生成力：能否用该特征推断此人对一个全新话题的可能立场？如果能，给出预测。
3. 排他性：该特征是否体现了此人的独特视角，而非"所有聪明人都会这样想"？如果能区分，说明独特之处。

候选特征列表：
{candidateFeatures}

聊天记录样本（用于验证）：
{chatRecordsSample}

请对每条特征输出验证结果，以JSON数组格式：
[
  {
    "feature": "特征描述",
    "crossDomain": { "passed": true/false, "evidence": "跨域证据" },
    "generative": { "passed": true/false, "prediction": "对新话题的预测" },
    "exclusive": { "passed": true/false, "distinction": "独特之处" },
    "finalVerdict": "confirmed/observation/common_wisdom/rejected"
  }
]

verdict说明：
- confirmed: 通过全部验证，确认为心智模型
- observation: 通过部分验证，降级为观察记录
- common_wisdom: 缺乏排他性，属于通用智慧
- rejected: 未通过核心验证，应丢弃`,

  skillSynthesis: `你是一个专业的角色合成专家。请根据以下经过验证的人格特征，合成一个完整的角色系统提示词。

五层人格特征：
{personaLayers}

验证结果摘要：
{verificationSummary}

请生成一个完整的系统提示词模板，要求：
1. 按五层架构组织（硬规则→身份→表达→决策→人际）
2. 硬规则部分使用"绝对不要"的语气
3. 身份部分使用"你是"的语气
4. 表达部分使用"你倾向于"的语气
5. 决策部分使用"你优先"的语气
6. 人际部分使用"面对XX时你"的语气
7. 保留矛盾——真实人格本就包含矛盾，不要强行消除
8. 明确标注此Skill的局限性

请以纯文本格式输出系统提示词，不要使用JSON。`,

  validation: `你是一个专业的角色验证专家。请验证以下蒸馏出的角色特征是否准确、一致、可用。

角色特征摘要：
{skillSummary}

原始聊天记录样本：
{chatRecordsSample}

请从以下维度验证：
1. 一致性：各维度特征之间是否存在矛盾（0-1分）
2. 准确性：特征是否与聊天记录一致（0-1分）
3. 完整性：是否遗漏了重要特征（0-1分）
4. 可用性：特征是否足够具体，能否用于生成回复（0-1分）
5. 安全性：是否包含不当内容或偏见（0-1分）

请以JSON格式输出验证结果，包含以下字段：
- consistencyScore: 一致性评分(0-1)
- accuracyScore: 准确性评分(0-1)
- completenessScore: 完整性评分(0-1)
- usabilityScore: 可用性评分(0-1)
- safetyScore: 安全性评分(0-1)
- issues: 发现的问题列表
- suggestions: 改进建议列表`
}

export const DISTILL_PROMPTS_V1 = {
  expressionDNA: `你是一个专业的语言风格分析师。请分析以下聊天记录中"我方"的表达特征，提取出表达DNA。

请从以下维度分析：
1. 语气特征：日常语气、情绪化表达、反讽使用等
2. 词汇偏好：高频词汇、口头禅、网络用语、专业术语等
3. 句式特点：长句/短句偏好、反问句使用、省略句使用等
4. 表情/符号使用：emoji偏好、标点符号使用习惯等
5. 话题转换方式：如何开始新话题、如何结束话题等

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- tone: 语气特征描述
- vocabulary: 常用词汇列表
- sentencePatterns: 句式特点列表
- emojiUsage: 表情使用习惯描述
- topicTransition: 话题转换方式描述`,

  mentalModels: `你是一个专业的思维模式分析师。请分析以下聊天记录中"我方"的思维模式，提取出心智模型。

请从以下维度分析：
1. 推理方式：演绎/归纳偏好、类比思维使用等
2. 决策模式：快速决策/深思熟虑、风险偏好等
3. 问题解决策略：系统性/直觉性、分解/整体等
4. 信息处理偏好：细节导向/全局导向、数据驱动/经验驱动等
5. 创造性思维：发散/收敛、联想模式等

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- reasoningStyle: 推理方式描述
- decisionPattern: 决策模式描述
- problemSolving: 问题解决策略描述
- infoProcessing: 信息处理偏好描述
- creativity: 创造性思维描述`,

  decisionHeuristics: `你是一个专业的决策分析专家。请分析以下聊天记录中"我方"的决策启发式规则，提取出决策启发式。

请从以下维度分析：
1. 快速判断规则：在什么情况下倾向于快速做出判断
2. 权衡取舍模式：面对冲突时如何取舍
3. 风险评估方式：如何评估和应对风险
4. 优先级排序：如何排列不同事项的优先级
5. 回避策略：倾向于回避什么样的决策或情境

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- quickJudgment: 快速判断规则列表
- tradeoffPattern: 权衡取舍模式描述
- riskAssessment: 风险评估方式描述
- prioritization: 优先级排序规则列表
- avoidanceStrategies: 回避策略列表`,

  valuesAndAntiPatterns: `你是一个专业的价值观分析专家。请分析以下聊天记录中"我方"的价值观和反模式，提取出核心价值观和反模式。

请从以下维度分析：
1. 核心价值观：最看重的价值原则
2. 底线与禁忌：绝对不能接受的事物
3. 反模式：反复出现的不良行为模式
4. 自我矛盾：言行不一致的地方
5. 防御机制：面对压力时的典型反应

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- coreValues: 核心价值观列表
- taboos: 底线与禁忌列表
- antiPatterns: 反模式列表
- contradictions: 自我矛盾列表
- defenseMechanisms: 防御机制列表`,

  honestyBoundaries: `你是一个专业的真诚度分析专家。请分析以下聊天记录中"我方"的真诚边界，提取出诚实度边界。

请从以下维度分析：
1. 坦诚程度：在什么话题上最坦诚，在什么话题上有所保留
2. 谎言模式：是否存在善意的谎言，在什么情况下使用
3. 回避话题：倾向于回避哪些话题
4. 情绪表达真实性：情绪表达是否真实，是否有表演成分
5. 承诺可信度：做出的承诺是否可靠

聊天记录：
{chatRecords}

请以JSON格式输出分析结果，包含以下字段：
- openness: 坦诚程度描述
- whiteLies: 善意谎言使用场景列表
- avoidedTopics: 回避话题列表
- emotionalAuthenticity: 情绪表达真实性描述
- commitmentReliability: 承诺可信度描述`,

  validation: `你是一个专业的角色验证专家。请验证以下蒸馏出的角色特征是否准确、一致、可用。

角色特征摘要：
{skillSummary}

原始聊天记录样本：
{chatRecordsSample}

请从以下维度验证：
1. 一致性：各维度特征之间是否存在矛盾
2. 准确性：特征是否与聊天记录一致
3. 完整性：是否遗漏了重要特征
4. 可用性：特征是否足够具体，能否用于生成回复
5. 安全性：是否包含不当内容或偏见

请以JSON格式输出验证结果，包含以下字段：
- consistencyScore: 一致性评分(0-1)
- accuracyScore: 准确性评分(0-1)
- completenessScore: 完整性评分(0-1)
- usabilityScore: 可用性评分(0-1)
- safetyScore: 安全性评分(0-1)
- issues: 发现的问题列表
- suggestions: 改进建议列表`
}

export const DISTILL_PROMPTS = DISTILL_PROMPTS_V1
