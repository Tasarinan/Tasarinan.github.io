import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const workspaceRoot = path.resolve(projectRoot, '..')
const docsRoot = path.join(projectRoot, 'docs', 'agent-architect-insight')

const sourceRoots = [
  path.join(workspaceRoot, 'tmp', 'ai_guide'),
  path.join(workspaceRoot, 'tmp', 'Deep-Learning-Interview-Book')
]

const MIN_LEN = 3000
const MAX_LEN = 6000
const TARGET_LEN = 5200
const INTERVIEW_RE = /(面试|interview|笔试|八股|题库|真题|自我介绍)/i
const NOISE_RE = /(github\s*\(|stars\)|youtube|http:\/\/|https:\/\/|readme|公众号|扫码|点击|课程链接|视频链接)/i

const MONTH_CONFIG = {
  '2026-06': {
    focus: 'NLP及相关基础',
    include: ['nlp', '自然语言', '文本', '语义', '分词', '词向量', '句法', '词法', 'transformer', 'bert'],
    topics: [
      {
        name: 'NLP基础',
        keywords: ['nlp', '自然语言', '词法', '句法', '分词', '语料', '文本处理'],
        titlePool: ['文本预处理与语料组织', '词法句法基础能力构建', '语料清洗与标注规范', 'NLP基础任务拆解方法']
      },
      {
        name: '语义表示',
        keywords: ['embedding', '向量', '语义表示', '词向量', '句向量', '相似度'],
        titlePool: ['语义向量构建与检索', '向量表示与相似度建模', 'Embedding方案选型要点', '语义表示质量评估方法']
      },
      {
        name: '训练评估',
        keywords: ['训练', '优化器', '损失函数', '评估', 'f1', '精确率', '召回率'],
        titlePool: ['模型训练流程与评估闭环', '损失函数与优化策略实践', '训练稳定性与指标校准', '模型评估体系设计']
      }
    ]
  },
  '2026-07': {
    focus: 'LLM',
    include: ['llm', '大模型', 'token', '上下文', 'prompt', 'rag', '微调', '对齐', '推理'],
    topics: [
      {
        name: '模型架构',
        keywords: ['llm', '大模型', 'transformer', 'token', '上下文', '参数', '推理能力'],
        titlePool: ['参数规模与能力边界', '上下文窗口与Token预算', '模型架构与推理成本平衡', '推理质量与延迟协同优化']
      },
      {
        name: 'Prompt工程',
        keywords: ['prompt', '提示词', '思维链', 'few-shot', 'zero-shot', 'system prompt'],
        titlePool: ['提示词结构化设计', '推理提示与约束策略', '多轮提示稳定性优化', 'Prompt评测与迭代方法']
      },
      {
        name: 'RAG实践',
        keywords: ['rag', '检索增强', '向量库', 'chunk', '召回', '重排', '知识库'],
        titlePool: ['RAG检索链路设计', '分块召回与重排优化', '知识库构建与更新策略', 'RAG评测与问题定位']
      },
      {
        name: '微调部署',
        keywords: ['微调', 'sft', 'dpo', 'rlhf', '对齐', '量化', '蒸馏', '部署'],
        titlePool: ['微调数据与对齐策略', '量化蒸馏与部署优化', '模型上线与回滚机制', '成本约束下的效果提升']
      }
    ]
  },
  '2026-08': {
    focus: 'Agent',
    include: ['agent', '智能体', '工具调用', '工作流', '记忆', '多智能体', '评测', '安全', '规划'],
    topics: [
      {
        name: '任务建模',
        keywords: ['agent', '智能体', '任务拆解', '规划', '目标', '角色', '状态'],
        titlePool: ['任务拆解与目标规划', '角色分工与执行闭环', '智能体状态建模方法', '复杂任务的分层规划']
      },
      {
        name: '工具编排',
        keywords: ['工具调用', 'tool', 'function call', '工作流', '编排', '路由'],
        titlePool: ['工具调用协议设计', '工作流路由与容错机制', '函数调用参数治理', '工具链编排与故障恢复']
      },
      {
        name: '协作记忆',
        keywords: ['多智能体', '协作', 'memory', '记忆', '上下文共享', '长期记忆', '短期记忆'],
        titlePool: ['多智能体协作机制', '短期与长期记忆协同', '上下文共享与冲突消解', '协作任务的记忆治理']
      },
      {
        name: '治理安全',
        keywords: ['评测', '监控', '可观测', '安全', '护栏', '治理', '幻觉'],
        titlePool: ['评测基线与监控体系', '安全护栏与风险隔离', '可观测性与问题回溯', '治理策略与上线规范']
      }
    ]
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function walkMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        stack.push(abs)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(abs)
      }
    }
  }
  return out
}

function listGeneratedFiles(monthDir) {
  if (!fs.existsSync(monthDir)) return []
  return fs
    .readdirSync(monthDir)
    .filter((name) => /^Agent架构师-Day\d+-.+\.md$/.test(name))
    .map((name) => path.join(monthDir, name))
}

function normalizeMarkdown(md) {
  let text = md
  text = text.replace(/^---[\s\S]*?---\s*/m, '')
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[[^\]]+\]\(([^)]+)\)/g, '$1')
  text = text.replace(/<[^>]+>/g, ' ')
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  text = text.replace(/[\t ]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

function cleanParagraph(raw) {
  let p = raw
  p = p.replace(/^#{1,6}\s+/g, '')
  p = p.replace(/^[-*+]\s+/g, '')
  p = p.replace(/^\d+[.)]\s+/g, '')
  p = p.replace(/^\|.+\|$/g, '')
  p = p.replace(/\|\s*-{2,}\s*\|/g, '')
  p = p.replace(/\s+/g, ' ').trim()
  if (p.length < 45) return ''
  if (INTERVIEW_RE.test(p)) return ''
  if (NOISE_RE.test(p)) return ''
  if ((p.match(/\|/g) || []).length >= 6) return ''
  if (/^agent架构师\s+20\d{2}-\d{2}/i.test(p)) return ''
  if (/^(背景与范围|关键结论|方法拆解|风险与边界|实践清单)/.test(p)) return ''
  return p
}

function splitParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((x) => cleanParagraph(x))
    .filter(Boolean)
}

function scoreByKeywords(text, keywords) {
  const lower = text.toLowerCase()
  let score = 0
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) score += 1
  }
  return score
}

function pickMonth(paragraph) {
  let bestMonth = null
  let bestScore = 0
  for (const [month, cfg] of Object.entries(MONTH_CONFIG)) {
    const s = scoreByKeywords(paragraph, cfg.include)
    if (s > bestScore) {
      bestMonth = month
      bestScore = s
    }
  }
  if (bestScore <= 0) return null
  return bestMonth
}

function pickTopic(month, paragraph) {
  const topics = MONTH_CONFIG[month].topics
  let best = topics[0]
  let bestScore = -1
  for (const t of topics) {
    const s = scoreByKeywords(paragraph, t.keywords)
    if (s > bestScore) {
      best = t
      bestScore = s
    }
  }
  if (bestScore <= 0) return null
  return best
}

function dedupeParagraphs(paragraphs) {
  const seen = new Set()
  const out = []
  for (const p of paragraphs) {
    const key = p
      .toLowerCase()
      .replace(/[，。！？；、“”‘’()（）\[\]{}:：,.;!?\-\s]/g, '')
      .slice(0, 80)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

function chunkParagraphs(paragraphs) {
  const chunks = []
  let cur = []
  let curLen = 0
  for (const p of paragraphs) {
    const extra = p.length + (cur.length > 0 ? 2 : 0)
    if (curLen + extra > TARGET_LEN && cur.length > 0) {
      chunks.push(cur)
      cur = [p]
      curLen = p.length
    } else {
      cur.push(p)
      curLen += extra
    }
  }
  if (cur.length > 0) chunks.push(cur)

  // Merge small chunks from the same topic where possible.
  let i = 0
  while (i < chunks.length - 1) {
    const aLen = chunks[i].join('\n\n').length
    const bLen = chunks[i + 1].join('\n\n').length
    if (aLen < MIN_LEN && aLen + bLen <= MAX_LEN) {
      chunks[i] = [...chunks[i], ...chunks[i + 1]]
      chunks.splice(i + 1, 1)
      continue
    }
    i += 1
  }

  return chunks
}

function collectTopTerms(paragraphs, keywords) {
  const text = paragraphs.join(' ').toLowerCase()
  const pool = [...keywords, '流程', '评估', '部署', '稳定性', '成本', '质量', '协作', '治理']
  const hit = []
  for (const term of pool) {
    const c = text.split(term.toLowerCase()).length - 1
    if (c > 0) hit.push({ term, c })
  }
  hit.sort((a, b) => b.c - a.c)
  return hit.slice(0, 6).map((x) => x.term)
}

function buildObservationLines(paragraphs, keywords, limit = 16) {
  const scored = paragraphs
    .map((p) => ({ p, s: scoreByKeywords(p, keywords) + Math.floor(Math.min(p.length, 260) / 80) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)

  const seen = new Set()
  const lines = []
  for (const item of scored) {
    const text = item.p.replace(/\s+/g, ' ').trim()
    const key = text.toLowerCase().slice(0, 56)
    if (seen.has(key)) continue
    seen.add(key)

    let clip = text
    if (clip.length > 170) clip = `${clip.slice(0, 170)}...`
    lines.push(`- 观察：${clip}`)
    if (lines.length >= limit) break
  }
  return lines
}

function pickTitle(topic, terms, usedTitles) {
  for (const t of topic.titlePool) {
    if (!usedTitles.has(t)) {
      usedTitles.add(t)
      return t
    }
  }

  const meaningful = terms.filter((x) => !['流程', '评估', '部署', '质量', '成本'].includes(x))
  const a = meaningful[0] || topic.keywords[0] || '能力'
  const b = meaningful[1] || '实践'
  const candidate = `${a}与${b}`
  if (!usedTitles.has(candidate)) {
    usedTitles.add(candidate)
    return candidate
  }

  let idx = 2
  while (usedTitles.has(`${candidate}${idx}`)) idx += 1
  const finalTitle = `${candidate}${idx}`
  usedTitles.add(finalTitle)
  return finalTitle
}

function topKeywordBuckets(paragraphs, keywords) {
  const text = paragraphs.join(' ').toLowerCase()
  const buckets = keywords
    .map((kw) => ({ kw, count: text.split(kw.toLowerCase()).length - 1 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
  return buckets
}

function hashSeed(text) {
  let h = 0
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0
  }
  return h
}

function pickBySeed(list, seed, offset = 0) {
  if (list.length === 0) return ''
  return list[(seed + offset) % list.length]
}

function buildInsightSentences(month, focus, topicName, title, terms) {
  const seed = hashSeed(`${month}-${topicName}-${title}`)
  const t1 = terms[0] || '核心能力'
  const t2 = terms[1] || '工程流程'
  const t3 = terms[2] || '评估机制'

  const positioningTpl = [
    `在${month}阶段，本文围绕${focus}方向，聚焦${topicName}，将分散资料统一到“概念边界、实施链路、评测反馈”三个层面。`,
    `本文定位于${month}阶段的${focus}主线，围绕${topicName}梳理关键问题，并从能力、流程与治理三个维度完成重构。`,
    `结合${month}阶段的资料分布，本文以${topicName}为核心对象，对${focus}相关实践进行归并与抽象。`
  ]

  const takeawayTpl = [
    `资料共同强调：${t1}不是孤立能力，必须和${t2}联动设计，才能在真实场景保持稳定输出。`,
    `从实践反馈看，${t1}只有接入${t2}后才具备工程价值，否则容易停留在局部优化。`,
    `跨案例对比表明，${t1}与${t2}的耦合方式直接影响系统的可解释性与可维护性。`
  ]

  const methodTpl = [
    `先做任务分层：把需求拆为目标层、执行层和验证层，避免一次性把复杂问题压给单一环节。`,
    `先固定问题边界：明确输入、输出和异常条件，再推进后续实现与验证。`,
    `先定义最小闭环：从可运行链路出发逐步扩展，而不是一开始追求全功能覆盖。`
  ]

  const riskTpl = [
    `若只追求局部效果，容易在长链路场景出现性能回退，表现为延迟上升、结果波动或错误累积。`,
    `如果缺乏全链路视角，优化动作可能在局部生效但在整体系统中引发反向损耗。`,
    `当迭代节奏快于验证节奏时，系统会出现“看似可用但不可控”的隐性风险。`
  ]

  return {
    positioning: pickBySeed(positioningTpl, seed, 0),
    takeaway1: pickBySeed(takeawayTpl, seed, 1),
    takeaway2: `从落地经验看，${t2}决定交付效率，而${t3}决定质量上限，两者缺一不可。`,
    takeaway3: `多数问题并非来自单点模型能力，而是来自上下游约束不清、指标定义不一致以及迭代节奏失衡。`,
    method1: pickBySeed(methodTpl, seed, 2),
    method2: `再做链路标准化：把${t1}、${t2}对应的输入输出字段固定下来，形成可回放的流程记录。`,
    method3: `最后做持续校准：围绕${t3}设置基线、对照组和回归检查，确保优化动作可量化。`,
    risk1: pickBySeed(riskTpl, seed, 3),
    risk2: `若缺少统一的数据与提示规范，同一任务在不同环境下会出现行为不一致，增加排障成本。`,
    risk3: `若没有灰度与回滚机制，策略变更可能放大线上风险，影响系统可用性与业务信任。`,
    conclusion: `综合来看，${topicName}的关键不在“单次最优”，而在“可复用、可验证、可迭代”的工程闭环。`,
    sectionName1: pickBySeed(['主题定位', '问题定义', '范围说明'], seed, 4),
    sectionName2: pickBySeed(['核心认识', '关键判断', '主要结论'], seed, 5),
    sectionName3: pickBySeed(['实施路径', '落地方法', '执行方案'], seed, 6),
    sectionName4: pickBySeed(['风险控制', '风险与边界', '约束与应对'], seed, 7),
    sectionName5: pickBySeed(['实践清单', '执行清单', '行动检查表'], seed, 8),
    sectionName6: pickBySeed(['结论', '总结', '收束建议'], seed, 9)
  }
}

function expandPracticeChecklist(terms) {
  const a = terms[0] || '能力模块'
  const b = terms[1] || '流程环节'
  const c = terms[2] || '评估指标'
  const d = terms[3] || '稳定性要求'
  return [
    `- [ ] 明确${a}的边界与职责，写成一页可共享的接口说明。`,
    `- [ ] 将${b}拆分为可独立验证的步骤，并补齐输入输出样例。`,
    `- [ ] 为${c}建立最小评估集，固定评测口径与统计方式。`,
    `- [ ] 补充异常场景清单，覆盖超时、空结果、冲突结果等失败路径。`,
    `- [ ] 设置灰度发布与回滚开关，避免一次性全量变更。`,
    `- [ ] 记录一次完整复盘：问题现象、定位路径、修复动作、验证结论。`,
    `- [ ] 对${d}设置阈值告警，并将告警联动到值班与跟踪机制。`,
    `- [ ] 每轮迭代只优化一个主瓶颈，确保改动收益可归因。`
  ]
}

function buildArticle(month, cfg, topic, title, paragraphs) {
  const terms = collectTopTerms(paragraphs, topic.keywords)
  const buckets = topKeywordBuckets(paragraphs, topic.keywords)
  const rankedTerms = buckets.map((x) => x.kw)
  const keyTerms = rankedTerms.length > 0 ? rankedTerms : terms
  const insights = buildInsightSentences(month, cfg.focus, topic.name, title, keyTerms)
  const checklist = expandPracticeChecklist(keyTerms)
  const observations = buildObservationLines(paragraphs, topic.keywords, 18)

  let body = [
    `# Agent架构师 ${month} ${title}`,
    '',
    `## ${insights.sectionName1}`,
    insights.positioning,
    '',
    `本文在原始资料基础上进行了统一清洗、语义归并与结构化改写，重点关注：${(keyTerms.slice(0, 5).join('、') || '目标定义、执行路径、评估闭环')}。`,
    '',
    `## ${insights.sectionName2}`,
    `- ${insights.takeaway1}`,
    `- ${insights.takeaway2}`,
    `- ${insights.takeaway3}`,
    '- 在跨模块协作场景中，先统一术语与数据口径，再推进策略优化，通常比直接调参更有效。',
    '- 从长期维护角度看，体系化文档与可回放日志是持续改进的前提条件。',
    '',
    `## ${insights.sectionName3}`,
    `1. ${insights.method1}`,
    `2. ${insights.method2}`,
    `3. ${insights.method3}`,
    '4. 建立“基线版本-实验版本-回归验证”三段式迭代流程，保证每次优化可解释。',
    '5. 把关键链路做成可观测看板，至少覆盖成功率、平均延迟、异常分布三类指标。',
    '',
    '## 资料观察',
    ...(observations.length > 0 ? observations : ['- 观察：同主题资料主要集中在目标拆解、流程稳定性和评估闭环三个方面。']),
    '',
    `## ${insights.sectionName4}`,
    `- ${insights.risk1}`,
    `- ${insights.risk2}`,
    `- ${insights.risk3}`,
    '- 对高风险动作设置熔断阈值和人工兜底，降低不可逆错误带来的业务损失。',
    '',
    `## ${insights.sectionName5}`,
    ...checklist,
    '',
    `## ${insights.sectionName6}`,
    insights.conclusion,
    ''
  ].join('\n')

  // No generic extension section: rely on same-topic chunk merging for minimum length.
  if (body.length > MAX_LEN) {
    body = `${body.slice(0, MAX_LEN - 2).trimEnd()}\n`
  }

  return body
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{\{/g, '&#123;&#123;')
    .replace(/\}\}/g, '&#125;&#125;')
}

function sanitizeName(text) {
  return text
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function buildDataset() {
  const dataset = {}
  for (const month of Object.keys(MONTH_CONFIG)) {
    dataset[month] = {}
    for (const topic of MONTH_CONFIG[month].topics) {
      dataset[month][topic.name] = []
    }
  }

  const files = sourceRoots.flatMap((root) => walkMarkdownFiles(root))
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8')
    if (INTERVIEW_RE.test(raw)) continue

    const normalized = normalizeMarkdown(raw)
    const paragraphs = splitParagraphs(normalized)

    for (const p of paragraphs) {
      const month = pickMonth(p)
      if (!month) continue
      const topic = pickTopic(month, p)
      if (!topic) continue
      dataset[month][topic.name].push(p)
    }
  }

  return dataset
}

function rewriteMonth(month, dataset) {
  const cfg = MONTH_CONFIG[month]
  const monthDir = path.join(docsRoot, month)
  ensureDir(monthDir)

  for (const file of listGeneratedFiles(monthDir)) {
    fs.unlinkSync(file)
  }

  let day = 1
  const usedTitles = new Set()
  const written = []

  for (const topic of cfg.topics) {
    const rawParas = dataset[month][topic.name] || []
    const paragraphs = dedupeParagraphs(rawParas)
    if (paragraphs.length === 0) continue

    let chunks = chunkParagraphs(paragraphs)

    const draftLen = (chunk) => buildArticle(month, cfg, topic, '临时标题', chunk).length

    // Forward merge for undersized chunks.
    let i = 0
    while (i < chunks.length - 1) {
      const curLen = draftLen(chunks[i])
      if (curLen < MIN_LEN) {
        const merged = [...chunks[i], ...chunks[i + 1]]
        const mergedLen = draftLen(merged)
        if (mergedLen <= MAX_LEN) {
          chunks[i] = merged
          chunks.splice(i + 1, 1)
          continue
        }
      }
      i += 1
    }

    // Backward merge for undersized tail chunks.
    i = chunks.length - 1
    while (i > 0) {
      const curLen = draftLen(chunks[i])
      if (curLen < MIN_LEN) {
        const merged = [...chunks[i - 1], ...chunks[i]]
        const mergedLen = draftLen(merged)
        if (mergedLen <= MAX_LEN) {
          chunks[i - 1] = merged
          chunks.splice(i, 1)
        }
      }
      i -= 1
    }

    for (const chunk of chunks) {
      const terms = collectTopTerms(chunk, topic.keywords)
      const title = pickTitle(topic, terms, usedTitles)
      const content = buildArticle(month, cfg, topic, title, chunk)
      const fileName = `Agent架构师-Day${String(day).padStart(2, '0')}-${sanitizeName(title)}.md`
      fs.writeFileSync(path.join(monthDir, fileName), `${content}\n`, 'utf8')
      written.push(fileName)
      day += 1
    }
  }

  return { month, focus: cfg.focus, count: written.length }
}

function run() {
  const dataset = buildDataset()
  const report = []
  for (const month of Object.keys(MONTH_CONFIG)) {
    report.push(rewriteMonth(month, dataset))
  }

  const lines = ['# 月度主题重写报告', '']
  for (const r of report) {
    lines.push(`## ${r.month}（重点：${r.focus}）`)
    lines.push(`- 生成笔记：${r.count}`)
    lines.push('')
  }

  fs.writeFileSync(path.join(docsRoot, '重编排报告.md'), `${lines.join('\n')}\n`, 'utf8')
  console.log('Rewrite complete:', report.map((r) => `${r.month}:${r.count}`).join(', '))
}

run()
