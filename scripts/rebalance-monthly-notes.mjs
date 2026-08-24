import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const docsRoot = path.join(projectRoot, 'docs', 'agent-architect-insight')

const MONTH_CONFIG = {
  '2026-06': {
    focus: 'NLP及相关基础',
    topics: [
      { name: 'NLP基础概念', keywords: ['nlp', '自然语言', '分词', '词性', '语料', '文本', '语言模型基础', '词法', '句法'] },
      { name: '语义表示与向量', keywords: ['embedding', '向量', '语义表示', '词向量', '句向量', '向量化', '相似度'] },
      { name: '模型结构与训练基础', keywords: ['transformer', 'attention', 'bert', 'rnn', 'cnn', '训练', '损失函数', '优化器', '梯度'] },
      { name: '数据处理与评估', keywords: ['清洗', '标注', '评估', '准确率', '召回率', 'f1', '数据集', '特征工程'] }
    ],
    include: ['nlp', '自然语言', '文本', '语义', '分词', '词向量', 'transformer', 'bert', '训练', '评估']
  },
  '2026-07': {
    focus: 'LLM',
    topics: [
      { name: 'LLM原理与架构', keywords: ['llm', '大模型', 'transformer', '上下文长度', 'token', '预训练', '参数规模'] },
      { name: 'Prompt与推理策略', keywords: ['prompt', '提示词', 'cot', 'chain of thought', '推理', '思维链', 'few-shot', 'zero-shot'] },
      { name: 'RAG与知识增强', keywords: ['rag', '检索增强', '向量库', 'chunk', '召回', '重排', '知识库'] },
      { name: '微调对齐与部署优化', keywords: ['微调', 'sft', 'dpo', 'rlhf', '对齐', '量化', '蒸馏', '部署', '推理加速'] }
    ],
    include: ['llm', '大模型', 'prompt', 'rag', '检索', '微调', '对齐', 'token', '推理']
  },
  '2026-08': {
    focus: 'Agent',
    topics: [
      { name: 'Agent设计基础', keywords: ['agent', '智能体', '角色', '规划', '任务拆解', '状态机'] },
      { name: '工具调用与工作流', keywords: ['tool', 'function call', '工具调用', '工作流', '编排', '路由', 'workflow'] },
      { name: '多Agent协作与记忆', keywords: ['multi-agent', '多智能体', '协作', 'memory', '记忆', '短期记忆', '长期记忆'] },
      { name: '评测治理与安全', keywords: ['评测', '监控', '可观测', '安全', '护栏', '治理', '幻觉', 'trace'] }
    ],
    include: ['agent', '智能体', '工具', '工作流', '协作', 'memory', '评测', '安全']
  }
}

const INTERVIEW_RE = /(面试|interview|笔试|八股|题库|真题|自我介绍)/i
const MAX_CHARS = 2500
const TARGET_BODY = 2200

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function listDayFiles(monthDir) {
  if (!fs.existsSync(monthDir)) return []
  return fs
    .readdirSync(monthDir)
    .filter((name) => /^Agent架构师-Day\d{2}-.+\.md$/.test(name))
    .map((name) => path.join(monthDir, name))
}

function clearDayFiles(monthDir) {
  for (const file of listDayFiles(monthDir)) {
    fs.unlinkSync(file)
  }
}

function normalizeText(markdown) {
  let text = markdown
  text = text.replace(/^---[\s\S]*?---\s*/m, '')
  text = text.replace(/^#\s+.*$/gm, '')
  text = text.replace(/^###\s+\d+\.\s+/gm, '')
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/^\s{4}/gm, '')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[[^\]]+\]\(([^)]+)\)/g, '$1')
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  text = text.replace(/[\t ]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

function extractParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 30)
    .filter((p) => !INTERVIEW_RE.test(p))
}

function escapeForMarkdown(text) {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{\{/g, '&#123;&#123;')
    .replace(/\}\}/g, '&#125;&#125;')
}

function scoreTopic(paragraph, topic) {
  const lower = paragraph.toLowerCase()
  let score = 0
  for (const kw of topic.keywords) {
    if (lower.includes(kw.toLowerCase())) score += 1
  }
  return score
}

function splitLongParagraph(paragraph, limit) {
  if (paragraph.length <= limit) return [paragraph]
  const sentences = paragraph.split(/(?<=[。！？；;.!?])\s+/)
  const out = []
  let cur = ''
  for (const s of sentences) {
    if (!s) continue
    if ((cur + s).length > limit) {
      if (cur) out.push(cur.trim())
      if (s.length > limit) {
        let idx = 0
        while (idx < s.length) {
          out.push(s.slice(idx, idx + limit).trim())
          idx += limit
        }
        cur = ''
      } else {
        cur = s
      }
    } else {
      cur = cur ? `${cur} ${s}` : s
    }
  }
  if (cur) out.push(cur.trim())
  return out
}

function chunkParagraphs(paragraphs, bodyLimit) {
  const chunks = []
  let cur = []
  let curLen = 0

  for (const para of paragraphs) {
    const pieces = splitLongParagraph(para, Math.floor(bodyLimit * 0.8))
    for (const piece of pieces) {
      const extra = (cur.length === 0 ? 0 : 2) + piece.length
      if (curLen + extra > bodyLimit && cur.length > 0) {
        chunks.push(cur.join('\n\n'))
        cur = [piece]
        curLen = piece.length
      } else {
        cur.push(piece)
        curLen += extra
      }
    }
  }

  if (cur.length > 0) chunks.push(cur.join('\n\n'))
  return chunks
}

function assignToTopics(paragraphs, topics) {
  const buckets = new Map(topics.map((t) => [t.name, []]))
  for (const p of paragraphs) {
    let bestTopic = topics[0]
    let bestScore = -1
    for (const t of topics) {
      const s = scoreTopic(p, t)
      if (s > bestScore) {
        bestScore = s
        bestTopic = t
      }
    }
    if (bestScore <= 0) continue
    buckets.get(bestTopic.name).push(p)
  }
  return buckets
}

function includeByMonthFocus(text, includeKeywords) {
  const lower = text.toLowerCase()
  return includeKeywords.some((kw) => lower.includes(kw.toLowerCase()))
}

function buildArticleContent(month, topicName, partIndex, totalParts, body) {
  const partLabel = totalParts > 1 ? `（第${partIndex}篇）` : ''
  return `# Agent架构师 ${month} ${topicName}${partLabel}\n\n${body}\n`
}

function buildFileName(day, topicName, partIndex, totalParts) {
  const safe = topicName.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-')
  const suffix = totalParts > 1 ? `-Part${String(partIndex).padStart(2, '0')}` : ''
  return `Agent架构师-Day${String(day).padStart(2, '0')}-${safe}${suffix}.md`
}

function rebalanceMonth(month) {
  const cfg = MONTH_CONFIG[month]
  const monthDir = path.join(docsRoot, month)
  ensureDir(monthDir)

  const sourceFiles = listDayFiles(monthDir)
  const allParagraphs = []

  for (const file of sourceFiles) {
    const base = path.basename(file)
    if (INTERVIEW_RE.test(base)) continue

    const raw = fs.readFileSync(file, 'utf8')
    if (INTERVIEW_RE.test(raw)) {
      // Entire interview-heavy source is ignored.
      continue
    }

    const text = normalizeText(raw)
    if (!includeByMonthFocus(text, cfg.include)) continue

    const paragraphs = extractParagraphs(text)
    const focused = paragraphs.filter((p) => includeByMonthFocus(p, cfg.include))
    allParagraphs.push(...focused)
  }

  clearDayFiles(monthDir)

  const topicBuckets = assignToTopics(allParagraphs, cfg.topics)
  let day = 1
  const written = []

  for (const topic of cfg.topics) {
    const paras = topicBuckets.get(topic.name) || []
    if (paras.length === 0) continue

    const chunks = chunkParagraphs(paras, TARGET_BODY)
    const totalParts = chunks.length

    for (let i = 0; i < chunks.length; i += 1) {
      const content = buildArticleContent(month, topic.name, i + 1, totalParts, chunks[i])
      if (content.length > MAX_CHARS + 250) {
        const retry = chunkParagraphs(splitLongParagraph(chunks[i], 700), 1600)
        for (let j = 0; j < retry.length; j += 1) {
          const c2 = buildArticleContent(month, topic.name, j + 1, retry.length, retry[j])
          const fileName2 = buildFileName(day, topic.name, j + 1, retry.length)
          fs.writeFileSync(path.join(monthDir, fileName2), escapeForMarkdown(c2), 'utf8')
          written.push(fileName2)
          day += 1
        }
        continue
      }

      const fileName = buildFileName(day, topic.name, i + 1, totalParts)
      fs.writeFileSync(path.join(monthDir, fileName), escapeForMarkdown(content), 'utf8')
      written.push(fileName)
      day += 1
    }
  }

  return {
    month,
    focus: cfg.focus,
    sourceCount: sourceFiles.length,
    paragraphCount: allParagraphs.length,
    writtenCount: written.length,
    written
  }
}

function run() {
  const months = Object.keys(MONTH_CONFIG)
  const report = []
  for (const month of months) {
    report.push(rebalanceMonth(month))
  }

  const lines = []
  lines.push('# 月度重编排报告')
  lines.push('')
  for (const r of report) {
    lines.push(`## ${r.month}（重点: ${r.focus}）`)
    lines.push(`- 输入文件: ${r.sourceCount}`)
    lines.push(`- 提取段落: ${r.paragraphCount}`)
    lines.push(`- 产出笔记: ${r.writtenCount}`)
    lines.push('')
  }

  fs.writeFileSync(path.join(docsRoot, '重编排报告.md'), `${lines.join('\n')}\n`, 'utf8')
  console.log('Rebalanced months:', report.map((r) => `${r.month}:${r.writtenCount}`).join(', '))
}

run()
