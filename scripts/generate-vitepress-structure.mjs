import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const docsDir = path.join(rootDir, 'docs')
const generatedDir = path.join(docsDir, '.vitepress', 'generated')
const outputFile = path.join(generatedDir, 'navigation.mjs')
const homeIndexFile = path.join(docsDir, 'index.md')
const HOME_POST_LIST_START = '<!-- HOME_POST_LIST_START -->'
const HOME_POST_LIST_END = '<!-- HOME_POST_LIST_END -->'

const IGNORE_NAMES = new Set(['.vitepress', 'index.md', 'assets'])

function isMarkdownFile(fileName) {
  return fileName.toLowerCase().endsWith('.md')
}

function toPosixPath(p) {
  return p.replace(/\\/g, '/')
}

function stripMd(fileName) {
  return fileName.replace(/\.md$/i, '')
}

function titleFromName(name) {
  const base = stripMd(name)
  return base.replace(/[-_]/g, ' ').trim()
}

function displayTitleFromBase(baseName) {
  return baseName
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isMonthDir(name) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(name)
}

function listDirs(absDir) {
  if (!fs.existsSync(absDir)) return []
  return fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'))
}

function listMarkdownFiles(absDir) {
  if (!fs.existsSync(absDir)) return []
  return fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isMarkdownFile(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

function monthFromRelPath(relPath) {
  const parts = toPosixPath(relPath).split('/')
  if (parts.length >= 2 && isMonthDir(parts[1])) return parts[1]
  return ''
}

function orderFromBase(base) {
  const m = base.match(/(?:^|[-_])(\d{1,3})(?:[-_]|$)/)
  if (m) return Number.parseInt(m[1], 10)
  return Number.POSITIVE_INFINITY
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function topicDisplayName(topic) {
  const normalized = topic.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!/[a-zA-Z]/.test(normalized)) return normalized
  return normalized
    .split(' ')
    .map((word) => {
      if (!word) return word
      return word[0].toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function renderTopicIndex(topic, sections) {
  const topicName = topicDisplayName(topic)
  const totalPosts = sections.reduce((sum, section) => sum + (section.items?.length || 0), 0)

  const monthBlocks = sections
    .map((section) => {
      const items = (section.items || [])
        .map((item) => `        <li><a href="${item.link}">${item.text}</a></li>`)
        .join('\n')

      return [
        '      <section class="topic-month">',
        `        <h2>${section.text} <span>${section.items?.length || 0} 篇</span></h2>`,
        '        <ul>',
        items,
        '        </ul>',
        '      </section>',
      ].join('\n')
    })
    .join('\n')

  return [
    '---',
    `title: ${topicName}`,
    'layout: doc',
    '---',
    '',
    '<div class="topic-index">',
    '  <header class="topic-header">',
    `    <h1>${topicName}</h1>`,
    '    <p>自动聚合该主题下所有文章，按月份倒序展示。</p>',
    `    <div class="topic-meta">${sections.length} 个月份 · ${totalPosts} 篇文章</div>`,
    '  </header>',
    '',
    '  <div class="topic-months">',
    monthBlocks,
    '  </div>',
    '</div>',
    '',
    '<style>',
    '.topic-index {',
    '  --ink: #11223a;',
    '  --muted: #4b637f;',
    '  --line: #d8e4f3;',
    '  --card: #ffffff;',
    '  max-width: 920px;',
    '  margin: 10px auto 44px;',
    '  color: var(--ink);',
    '}',
    '',
    '.topic-header {',
    '  padding: 24px;',
    '  border-radius: 18px;',
    '  background: linear-gradient(130deg, #f5fbff 0%, #edf5ff 100%);',
    '  border: 1px solid var(--line);',
    '}',
    '',
    '.topic-header h1 {',
    '  margin: 0;',
    '  font-size: clamp(1.75rem, 2.8vw, 2.3rem);',
    '}',
    '',
    '.topic-header p {',
    '  margin: 10px 0 8px;',
    '  color: var(--muted);',
    '}',
    '',
    '.topic-meta {',
    '  font-size: 0.92rem;',
    '  color: #2c4f75;',
    '  font-weight: 600;',
    '}',
    '',
    '.topic-months {',
    '  margin-top: 18px;',
    '  display: grid;',
    '  gap: 14px;',
    '}',
    '',
    '.topic-month {',
    '  border: 1px solid var(--line);',
    '  border-radius: 14px;',
    '  background: var(--card);',
    '  padding: 16px 18px;',
    '}',
    '',
    '.topic-month h2 {',
    '  margin: 0 0 10px;',
    '  font-size: 1.12rem;',
    '  display: flex;',
    '  align-items: baseline;',
    '  gap: 8px;',
    '}',
    '',
    '.topic-month h2 span {',
    '  color: var(--muted);',
    '  font-size: 0.85rem;',
    '  font-weight: 500;',
    '}',
    '',
    '.topic-month ul {',
    '  margin: 0;',
    '  padding-left: 18px;',
    '}',
    '',
    '.topic-month li + li {',
    '  margin-top: 8px;',
    '}',
    '',
    '.topic-month a {',
    '  color: #194674;',
    '  text-decoration: none;',
    '}',
    '',
    '.topic-month a:hover {',
    '  text-decoration: underline;',
    '}',
    '',
    '@media (max-width: 640px) {',
    '  .topic-header {',
    '    padding: 18px;',
    '  }',
    '  .topic-month {',
    '    padding: 14px;',
    '  }',
    '}',
    '</style>',
    '',
  ].join('\n')
}

function writeTopicIndex(topic, sections) {
  const topicDir = path.join(docsDir, topic)
  const topicIndexFile = path.join(topicDir, 'index.md')
  const content = renderTopicIndex(topic, sections)
  fs.writeFileSync(topicIndexFile, content, 'utf8')
}

function buildStructure() {
  const topicDirs = listDirs(docsDir)
    .filter((name) => !IGNORE_NAMES.has(name))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  const nav = []
  const sidebar = {}

  for (const topic of topicDirs) {
    const topicAbs = path.join(docsDir, topic)
    const monthDirs = listDirs(topicAbs)
      .filter((name) => isMonthDir(name))
      .sort((a, b) => b.localeCompare(a, 'zh-Hans-CN'))

    const topicSidebarItems = []
    let firstLink = ''

    for (const month of monthDirs) {
      const monthAbs = path.join(topicAbs, month)
      const files = listMarkdownFiles(monthAbs)
      const items = files.map((file) => {
        const relPath = toPosixPath(path.join(topic, month, stripMd(file)))
        return {
          text: titleFromName(file),
          link: `/${relPath}`,
        }
      })

      if (!firstLink && items.length > 0) {
        firstLink = items[0].link
      }

      topicSidebarItems.push({
        text: month,
        collapsed: false,
        items,
      })
    }

    if (firstLink) {
      const topicIndexLink = `/${topic}/`
      nav.push({
        text: topic,
        link: topicIndexLink,
      })

      topicSidebarItems.unshift({
        text: '主题总览',
        link: topicIndexLink,
      })
    }

    sidebar[`/${topic}/`] = topicSidebarItems
    writeTopicIndex(topic, topicSidebarItems.slice(1))
  }

  return { nav, sidebar }
}

function buildHomePosts(sidebar) {
  const topicKeys = Object.keys(sidebar)
  const posts = []

  for (const key of topicKeys) {
    const sections = sidebar[key] || []
    for (const section of sections) {
      const month = section.text
      for (const item of section.items || []) {
        const base = stripMd(path.basename(item.link))
        posts.push({
          month,
          title: displayTitleFromBase(base),
          link: item.link,
          order: orderFromBase(base),
          relPath: toPosixPath(item.link),
        })
      }
    }
  }

  posts.sort((a, b) => {
    if (a.month !== b.month) return b.month.localeCompare(a.month, 'zh-Hans-CN')
    if (a.order !== b.order) return b.order - a.order
    return a.relPath.localeCompare(b.relPath, 'zh-Hans-CN')
  })

  return posts
}

function writeHomeIndex(posts) {
  const postItems = posts
    .map((post) => {
      return [
        '    <li>',
        `      <a class="post-title" href="${post.link}">${post.title}</a>`,
        `      <div class="post-meta">${post.month.replace('-', '/')}</div>`,
        '    </li>',
      ].join('\n')
    })
    .join('\n')

  const postListBlock = [HOME_POST_LIST_START, postItems, HOME_POST_LIST_END].join('\n')

  if (fs.existsSync(homeIndexFile)) {
    const existing = fs.readFileSync(homeIndexFile, 'utf8')
    const replacePattern = new RegExp(
      `${escapeRegExp(HOME_POST_LIST_START)}[\\s\\S]*?${escapeRegExp(HOME_POST_LIST_END)}`,
      'm'
    )

    if (replacePattern.test(existing)) {
      const updated = existing.replace(replacePattern, postListBlock)
      fs.writeFileSync(homeIndexFile, updated, 'utf8')
      return
    }
  }

  const content = [
    '---',
    'title: 博客',
    'layout: doc',
    '---',
    '',
    '<div class="blog-index">',
    '  <h1>博客</h1>',
    '  <ul class="post-list">',
    `  ${HOME_POST_LIST_START}`,
    postItems,
    `  ${HOME_POST_LIST_END}`,
    '  </ul>',
    '</div>',
    '',
    '<style>',
    '.blog-index {',
    '  max-width: 760px;',
    '  margin: 12px auto 44px;',
    '  padding: 0 8px;',
    '  color: #111;',
    '}',
    '',
    '.blog-index h1 {',
    '  margin: 0;',
    '  font-size: 1.8rem;',
    '  font-weight: 700;',
    '  line-height: 1.2;',
    '  padding-bottom: 8px;',
    '  border-bottom: 1px solid #ddd;',
    '}',
    '',
    '.post-list {',
    '  list-style: none;',
    '  margin: 10px 0 0;',
    '  padding: 0;',
    '}',
    '',
    '.post-list li {',
    '  padding: 10px 0;',
    '  border-bottom: 1px dotted #ddd;',
    '}',
    '',
    '.post-title {',
    '  display: inline-block;',
    '  color: #222;',
    '  text-decoration: none;',
    '  font-size: 1rem;',
    '  line-height: 1.38;',
    '}',
    '',
    '.post-title:hover {',
    '  text-decoration: underline;',
    '}',
    '',
    '.post-meta {',
    '  margin-top: 2px;',
    '  color: #666;',
    '  font-size: 0.84rem;',
    '  letter-spacing: 0.1px;',
    '}',
    '',
    '@media (max-width: 640px) {',
    '  .blog-index {',
    '    margin-top: 8px;',
    '  }',
    '  .post-list li {',
    '    padding: 9px 0;',
    '  }',
    '  .blog-index h1 {',
    '    font-size: 1.65rem;',
    '  }',
    '}',
    '</style>',
    '',
  ].join('\n')

  fs.writeFileSync(homeIndexFile, content, 'utf8')
}

function writeNavigationFile(nav, sidebar) {
  if (!fs.existsSync(generatedDir)) {
    fs.mkdirSync(generatedDir, { recursive: true })
  }

  const content = [
    '// This file is auto-generated by scripts/generate-vitepress-structure.mjs',
    '// Do not edit manually.',
    '',
    `export const nav = ${JSON.stringify(nav, null, 2)}`,
    '',
    `export const sidebar = ${JSON.stringify(sidebar, null, 2)}`,
    '',
  ].join('\n')

  fs.writeFileSync(outputFile, content, 'utf8')
}

const { nav, sidebar } = buildStructure()
writeNavigationFile(nav, sidebar)
const posts = buildHomePosts(sidebar)
writeHomeIndex(posts)

console.log(`Generated ${path.relative(rootDir, outputFile)}`)
console.log(`Generated ${path.relative(rootDir, homeIndexFile)} (${posts.length} posts)`)
console.log(`Topics: ${Object.keys(sidebar).length}`)
