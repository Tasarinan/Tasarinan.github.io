import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const docsDir = path.join(rootDir, 'docs')
const generatedDir = path.join(docsDir, '.vitepress', 'generated')
const outputFile = path.join(generatedDir, 'navigation.mjs')
const homeIndexFile = path.join(docsDir, 'index.md')

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
      nav.push({
        text: topic,
        link: firstLink,
      })
    }

    sidebar[`/${topic}/`] = topicSidebarItems
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
    if (a.order !== b.order) return a.order - b.order
    return a.relPath.localeCompare(b.relPath, 'zh-Hans-CN')
  })

  return posts
}

function writeHomeIndex(posts) {
  const grouped = new Map()
  for (const post of posts) {
    if (!grouped.has(post.month)) grouped.set(post.month, [])
    grouped.get(post.month).push(post)
  }

  const monthSections = [...grouped.entries()]
    .map(([month, monthPosts]) => {
      const list = monthPosts
        .map((post) => `      <li><span>${month}</span><a href="${post.link}">${post.title}</a></li>`)
        .join('\n')

      return [
        '  <section>',
        `    <h2>${month}</h2>`,
        '    <ul>',
        list,
        '    </ul>',
        '  </section>',
      ].join('\n')
    })
    .join('\n\n')

  const content = [
    '---',
    'title: Tasarinan',
    'layout: doc',
    '---',
    '',
    '<div class="blog-index">',
    '  <header class="blog-header">',
    '    <h1>Tasarinan</h1>',
    '    <p>一个技术写作索引，自动从文档目录生成。</p>',
    '  </header>',
    '',
    monthSections,
    '</div>',
    '',
    '<style>',
    '.blog-index {',
    '  max-width: 760px;',
    '  margin: 24px auto 48px;',
    '  padding: 0 12px;',
    '  color: #111;',
    '}',
    '',
    '.blog-header {',
    '  border-bottom: 1px solid #ddd;',
    '  margin-bottom: 24px;',
    '  padding-bottom: 12px;',
    '}',
    '',
    '.blog-header h1 {',
    '  margin: 0;',
    '  font-size: 2rem;',
    '  font-weight: 700;',
    '  letter-spacing: 0.5px;',
    '}',
    '',
    '.blog-header p {',
    '  margin: 8px 0 0;',
    '  color: #444;',
    '  font-size: 0.98rem;',
    '}',
    '',
    '.blog-index h2 {',
    '  margin: 20px 0 10px;',
    '  font-size: 1.15rem;',
    '  font-weight: 600;',
    '  color: #222;',
    '}',
    '',
    '.blog-index ul {',
    '  list-style: none;',
    '  margin: 0;',
    '  padding: 0;',
    '}',
    '',
    '.blog-index li {',
    '  display: grid;',
    '  grid-template-columns: 90px 1fr;',
    '  gap: 10px;',
    '  padding: 6px 0;',
    '  border-top: 1px dotted #ddd;',
    '}',
    '',
    '.blog-index li:first-child {',
    '  border-top: 0;',
    '}',
    '',
    '.blog-index span {',
    '  color: #666;',
    '  font-size: 0.9rem;',
    '}',
    '',
    '.blog-index a {',
    '  color: #222;',
    '  text-decoration: none;',
    '}',
    '',
    '.blog-index a:hover {',
    '  text-decoration: underline;',
    '}',
    '',
    '@media (max-width: 640px) {',
    '  .blog-index {',
    '    margin-top: 12px;',
    '  }',
    '',
    '  .blog-index li {',
    '    grid-template-columns: 1fr;',
    '    gap: 2px;',
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
