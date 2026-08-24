import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const workspaceRoot = path.resolve(projectRoot, '..')

const aiGuideRoot = path.join(workspaceRoot, 'tmp', 'ai_guide')
const dlibRoot = path.join(workspaceRoot, 'tmp', 'Deep-Learning-Interview-Book')
const sourceRoots = [aiGuideRoot, dlibRoot]

const targetBaseDir = path.join(projectRoot, 'docs', 'agent-architect-insight')
const targetMonths = ['2026-06', '2026-07', '2026-08']

function toPosix(p) {
  return p.replace(/\\/g, '/')
}

function walkMarkdownFiles(dir) {
  const result = []
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
      if (!entry.isFile()) continue
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      result.push(abs)
    }
  }

  return result.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

function extractTitle(content, fallback) {
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) {
      return trimmed.replace(/^#\s+/, '').trim()
    }
  }
  return fallback
}

function toFencedMarkdown(content) {
  return content
}

function toIndentedCodeBlock(content) {
  return content.split(/\r?\n/).map((line) => `    ${line}`)
}

function extractImageLinks(content) {
  const matches = content.match(/!\[[^\]]*\]\([^)]+\)/g)
  return matches ? Array.from(new Set(matches)) : []
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function clearGeneratedFiles(monthDir) {
  if (!fs.existsSync(monthDir)) return
  const entries = fs.readdirSync(monthDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (/^\d{2}-\d{4}-\d{2}-\d{2}-知识编排\.md$/.test(entry.name)) {
      fs.unlinkSync(path.join(monthDir, entry.name))
    }
    if (/^T\d{3}-.+-主题笔记\.md$/.test(entry.name)) {
      fs.unlinkSync(path.join(monthDir, entry.name))
    }
    if (/^AI架构师-Day\d{2}-.+\.md$/.test(entry.name)) {
      fs.unlinkSync(path.join(monthDir, entry.name))
    }
    if (/^Agent架构师-Day\d{2}-.+\.md$/.test(entry.name)) {
      fs.unlinkSync(path.join(monthDir, entry.name))
    }
  }
}

function normalizeTheme(raw) {
  return raw
    .replace(/^\d+[_\-]*/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeFilePart(text) {
  return text
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

function isRemoteOrDataUrl(url) {
  return /^(https?:)?\/\//i.test(url) || /^data:/i.test(url) || url.startsWith('#')
}

function isImagePath(filePath) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath)
}

function uniqueAssetName(baseName, usedNames) {
  const ext = path.extname(baseName)
  const name = path.basename(baseName, ext)
  let candidate = `${name}${ext}`
  let idx = 1
  while (usedNames.has(candidate)) {
    candidate = `${name}-${idx}${ext}`
    idx += 1
  }
  usedNames.add(candidate)
  return candidate
}

function copyAsset(assetLink, sourceFile, articleAssetsDir, usedNames) {
  if (isRemoteOrDataUrl(assetLink)) {
    return assetLink
  }

  const cleaned = assetLink.split('?')[0].split('#')[0]
  if (!isImagePath(cleaned)) {
    return assetLink
  }

  const sourceDir = path.dirname(sourceFile)
  const sourceAssetPath = path.resolve(sourceDir, cleaned)
  if (!fs.existsSync(sourceAssetPath) || !fs.statSync(sourceAssetPath).isFile()) {
    return assetLink
  }

  ensureDir(articleAssetsDir)
  const targetName = uniqueAssetName(path.basename(cleaned), usedNames)
  const targetPath = path.join(articleAssetsDir, targetName)
  fs.copyFileSync(sourceAssetPath, targetPath)
  return `./assets/${path.basename(articleAssetsDir)}/${targetName}`
}

function stripFrontmatter(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return content
  }

  const lines = content.split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }

  if (end === -1) {
    return content
  }

  return lines.slice(end + 1).join('\n').trimStart()
}

function rewriteContentWithCopiedImages(content, sourceFile, articleAssetsDir, usedNames) {
  let rewritten = stripFrontmatter(content)

  rewritten = rewritten.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi, (full, src) => {
    const copied = copyAsset(src.trim(), sourceFile, articleAssetsDir, usedNames)
    return `![image](${copied})`
  })

  rewritten = rewritten.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt, link) => {
    const copied = copyAsset(link.trim(), sourceFile, articleAssetsDir, usedNames)
    return `![${alt}](${copied})`
  })

  // Convert regular markdown links to plain text links to avoid malformed-link HTML edge cases.
  rewritten = rewritten.replace(/(?<!!)\[([^\]]+)\]\(([^)\n]+)\)/g, (full, text, url) => {
    return `${text} (${url})`
  })

  // Keep markdown semantics but neutralize raw HTML blocks that may break Vue parser.
  rewritten = rewritten.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  rewritten = rewritten.replace(/\{\{/g, '&#123;&#123;').replace(/\}\}/g, '&#125;&#125;')

  return rewritten
}

function escapeInline(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function inferTheme(file) {
  if (file.startsWith(aiGuideRoot)) {
    const rel = path.relative(aiGuideRoot, file)
    const parts = rel.split(path.sep)
    const first = parts[0] || 'ai_guide-未分类'
    return normalizeTheme(first)
  }

  if (file.startsWith(dlibRoot)) {
    const rel = path.relative(dlibRoot, file)
    const parts = rel.split(path.sep)
    if (parts[0] === 'docs' && parts.length > 1) {
      return `深度学习面试书-${normalizeTheme(path.basename(parts[1], '.md'))}`
    }
    return '深度学习面试书-其它'
  }

  return '未分类'
}

function assignThemesToMonths(themeEntries) {
  const bins = targetMonths.map((month) => ({ month, total: 0, themes: [] }))

  for (const entry of themeEntries) {
    bins.sort((a, b) => a.total - b.total)
    bins[0].themes.push(entry)
    bins[0].total += entry.files.length
  }

  return bins
}

const allFiles = sourceRoots.flatMap((root) => walkMarkdownFiles(root))
const themeMap = new Map()
for (const file of allFiles) {
  const theme = inferTheme(file)
  if (!themeMap.has(theme)) {
    themeMap.set(theme, [])
  }
  themeMap.get(theme).push(file)
}

const themeEntries = Array.from(themeMap.entries())
  .map(([theme, files]) => ({ theme, files: files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')) }))
  .sort((a, b) => b.files.length - a.files.length)

for (const month of targetMonths) {
  const monthDir = path.join(targetBaseDir, month)
  ensureDir(monthDir)
  ensureDir(path.join(monthDir, 'assets'))
  clearGeneratedFiles(monthDir)
}

const bins = assignThemesToMonths(themeEntries)

for (const bin of bins) {
  const outputDir = path.join(targetBaseDir, bin.month)

  bin.themes.forEach((topic, idx) => {
    const day = String(idx + 1).padStart(2, '0')
    const filePart = safeFilePart(topic.theme)
    const outputFile = path.join(outputDir, `Agent架构师-Day${day}-${filePart}.md`)
    const articleAssetFolder = `Agent架构师-Day${day}-${filePart}`
    const articleAssetsDir = path.join(outputDir, 'assets', articleAssetFolder)
    const usedNames = new Set()

    const lines = []
    lines.push(`# Agent架构师 Day${day} ${topic.theme}`)
    lines.push('')

    topic.files.forEach((file, sourceIndex) => {
      const content = fs.readFileSync(file, 'utf8')
      const fallback = path.basename(file, '.md')
      const title = escapeInline(extractTitle(content, fallback))
      const body = rewriteContentWithCopiedImages(content, file, articleAssetsDir, usedNames)
      const images = extractImageLinks(body).filter((img) => /^!\[[^\]]*\]\(\.\/assets\//.test(img))

      lines.push(`### ${String(sourceIndex + 1).padStart(3, '0')}. ${title}`)
      if (images.length > 0) {
        lines.push('')
        images.forEach((img) => lines.push(img))
        lines.push('')
      }
      lines.push(...toIndentedCodeBlock(body))
      lines.push('')
    })

    fs.writeFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8')
  })
}

const summaryLines = []
summaryLines.push('# 2026-06 至 2026-08 主题笔记总览')
summaryLines.push('')
summaryLines.push(`- 覆盖文档总数: ${allFiles.length}`)
summaryLines.push(`- 主题总数: ${themeEntries.length}`)
summaryLines.push(`- 月份范围: ${targetMonths.join(', ')}`)
summaryLines.push('')
summaryLines.push('## 月份分布（按源文件数）')
summaryLines.push('')

for (const bin of bins) {
  summaryLines.push(`- ${bin.month}: ${bin.total} 篇（主题数 ${bin.themes.length}）`)
}

summaryLines.push('')
summaryLines.push('说明: 同主题源文件已聚合为单篇主题笔记，并分配到 2026-06 / 2026-07 / 2026-08。')

const summaryFile = path.join(targetBaseDir, '2026-06-to-2026-08-总览.md')
fs.writeFileSync(summaryFile, `${summaryLines.join('\n')}\n`, 'utf8')

console.log(`Generated ${themeEntries.length} themed notes from ${allFiles.length} markdown files.`)
