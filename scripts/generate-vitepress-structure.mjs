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

  const content = [
    '---',
    'title: 博客',
    'layout: doc',
    '---',
    '',
    '<div class="blog-index">',
    '  <h1>博客</h1>',
    '  <ul class="post-list">',
    postItems,
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
