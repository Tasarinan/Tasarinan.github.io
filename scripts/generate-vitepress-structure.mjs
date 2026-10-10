import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const docsDir = path.join(rootDir, 'docs')
const generatedDir = path.join(docsDir, '.vitepress', 'generated')
const outputFile = path.join(generatedDir, 'navigation.mjs')
const homeIndexFile = path.join(docsDir, 'index.md')
const sitemapFile = path.join(docsDir, 'sitemap.md')

const IGNORE_NAMES = new Set(['.vitepress', 'index.md', 'assets', 'public'])

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
  return stripMd(name).replace(/[-_]/g, ' ').trim()
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

function orderFromBase(base) {
  const m = base.match(/(?:^|[-_])(\d{1,3})(?:[-_]|$)/)
  if (m) return Number.parseInt(m[1], 10)
  return Number.POSITIVE_INFINITY
}

const TOPIC_META = {
  'agent-architect-insight': {
    icon: '📖',
    title: '架构笔记',
    details: '超级个体这一步：把规划、检索、评测和护栏交给模型，先让一个人跑通。',
    linkText: '进入架构笔记',
  },
  'opeclaw-advisor': {
    icon: '🧰',
    title: 'FDE实践',
    details: '把想法交到现场：通道、技能、记忆和边界，从一个人交到一支队伍。',
    linkText: '进入FDE实践',
  },
  'ai-jiemi': {
    icon: '🔍',
    title: 'AI揭密',
    details: '把模型拆开看：它实际在做什么，边界在哪里，哪些说法经不起核对。',
    linkText: '进入AI揭密',
  },
}

const TOPIC_ORDER = ['agent-architect-insight', 'opeclaw-advisor', 'ai-jiemi']
const HOME_FEATURES = TOPIC_ORDER

function topicDisplayName(topic) {
  if (TOPIC_META[topic]?.title) return TOPIC_META[topic].title
  const normalized = topic.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!/[a-zA-Z]/.test(normalized)) return normalized
  return normalized
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}

function topicSort(a, b) {
  const left = TOPIC_ORDER.indexOf(a)
  const right = TOPIC_ORDER.indexOf(b)
  if (left === -1 && right === -1) return a.localeCompare(b, 'zh-Hans-CN')
  if (left === -1) return 1
  if (right === -1) return -1
  return left - right
}

function localISODate(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

function renderTopicIndex(topic, sections) {
  const topicName = topicDisplayName(topic)
  const tip = TOPIC_META[topic]?.details || '这一栏的笔记按月份倒序排开。'
  const lines = [
    '---',
    `title: ${topicName}`,
    '---',
    '',
    `# ${topicName}`,
    '',
    '::: tip',
    tip,
    ':::',
    '',
  ]

  for (const section of sections) {
    lines.push(`## ${section.text}`)
    lines.push('')
    for (const item of section.items || []) {
      lines.push(`- [${item.text}](${item.link})`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function writeTopicIndex(topic, sections) {
  const topicDir = path.join(docsDir, topic)
  const topicIndexFile = path.join(topicDir, 'index.md')
  fs.writeFileSync(topicIndexFile, renderTopicIndex(topic, sections), 'utf8')
}

function buildStructure() {
  const topicDirs = listDirs(docsDir)
    .filter((name) => !IGNORE_NAMES.has(name))
    .sort(topicSort)

  const nav = []
  const sidebar = {}

  for (const topic of topicDirs) {
    const topicAbs = path.join(docsDir, topic)
    const monthDirs = listDirs(topicAbs)
      .filter((name) => isMonthDir(name))
      .sort((a, b) => b.localeCompare(a, 'zh-Hans-CN'))

    const topicSidebarItems = []
    let hasPosts = false

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

      if (items.length > 0) {
        hasPosts = true
      }

      topicSidebarItems.push({
        text: month,
        collapsed: false,
        items,
      })
    }

    const topicIndexLink = `/${topic}/`
    if (hasPosts) {
      topicSidebarItems.unshift({ text: '主题总览', link: topicIndexLink })
      writeTopicIndex(topic, topicSidebarItems.slice(1))
      nav.push({
        text: topicDisplayName(topic),
        activeMatch: `^/${topic}`,
        items: [
          { text: '主题总览', link: topicIndexLink },
          ...topicSidebarItems.slice(1).map((section) => ({
            text: section.text,
            items: section.items,
          })),
        ],
      })
    } else if (TOPIC_META[topic]) {
      nav.push({
        text: topicDisplayName(topic),
        link: topicIndexLink,
        activeMatch: `^/${topic}`,
      })
    }

    sidebar[`/${topic}/`] = topicSidebarItems
  }

  nav.unshift({ text: '博客', link: '/blog', activeMatch: '^/blog' })
  nav.push({ text: '站点地图', link: '/sitemap', activeMatch: '^/sitemap' })
  nav.push({ text: 'About', link: '/about', activeMatch: '^/about' })

  return { nav, sidebar }
}

function buildHomePosts(sidebar) {
  const posts = []

  for (const key of Object.keys(sidebar)) {
    const sections = sidebar[key] || []
    for (const section of sections) {
      for (const item of section.items || []) {
        const base = stripMd(path.basename(item.link))
        const topic = item.link.split('/').filter(Boolean)[0] || ''
        posts.push({
          month: section.text,
          title: displayTitleFromBase(base),
          link: item.link,
          order: orderFromBase(base),
          relPath: toPosixPath(item.link),
          topic,
          topicName: topicDisplayName(topic),
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

function yamlQuote(value) {
  return JSON.stringify(value)
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderHomeLayout() {
  const features = HOME_FEATURES.map((topic) => {
    const meta = TOPIC_META[topic]
    return {
      icon: meta.icon,
      title: meta.title,
      details: meta.details,
      link: `/${topic}/`,
      linkText: meta.linkText,
    }
  })

  const featureYaml = features
    .map((feature) =>
      [
        `  - icon: ${feature.icon}`,
        `    title: ${yamlQuote(feature.title)}`,
        `    details: ${yamlQuote(feature.details)}`,
        `    link: ${feature.link}`,
        `    linkText: ${yamlQuote(feature.linkText)}`,
      ].join('\n'),
    )
    .join('\n')

  return [
    '---',
    'layout: home',
    'layoutClass: m-home-layout',
    'pageClass: m-home-layout',
    '',
    'hero:',
    '  name: "Tasarinan\'s Blog"',
    '  tagline: 把想法交给AI，从超级个体走向超级团队',
    '  image:',
    '    src: /hero.jpg',
    '    alt: Tasarinan',
    '  actions:',
    '    - theme: brand',
    '      text: 进入博客',
    '      link: /blog',
    '    - theme: alt',
    '      text: 进入仓库',
    '      link: https://github.com/Tasarinan/Tasarinan.github.io',
    '',
    'features:',
    featureYaml,
    '---',
    '',
  ].join('\n')
}

function writeHomeIndex() {
  const content = [
    renderHomeLayout(),
    '<ClientOnly>',
    '  <Heatmap />',
    '</ClientOnly>',
    '',
  ].join('\n')

  fs.writeFileSync(homeIndexFile, content, 'utf8')
}

function writeBlogPage(posts) {
  const groups = new Map()
  for (const post of posts) {
    if (!groups.has(post.month)) groups.set(post.month, [])
    groups.get(post.month).push(post)
  }

  const lines = [
    renderHomeLayout(),
    '<ClientOnly>',
    '  <Heatmap />',
    '</ClientOnly>',
    '',
    '<section class="blog-stream">',
    '  <h2>最新文章</h2>',
  ]

  for (const [month, list] of groups) {
    lines.push(`  <h3>${month.replace('-', '/')}</h3>`)
    lines.push('  <ul>')
    for (const post of list) {
      lines.push(
        `    <li><a href="${escapeHtml(post.link)}">${escapeHtml(post.title)}</a><span class="blog-topic">${escapeHtml(post.topicName)}</span></li>`,
      )
    }
    lines.push('  </ul>')
  }

  lines.push('</section>', '')

  fs.writeFileSync(path.join(docsDir, 'blog.md'), `${lines.join('\n')}\n`, 'utf8')
}

function writeHeatmap(posts) {
  const counts = {}
  const byMonth = new Map()

  for (const post of posts) {
    if (!byMonth.has(post.month)) byMonth.set(post.month, [])
    byMonth.get(post.month).push(post)
  }

  for (const [month, list] of byMonth) {
    const [year, monthNumber] = month.split('-').map((part) => Number.parseInt(part, 10))
    const limit = daysInMonth(year, monthNumber)
    const anchors = [11, 18, 25, 8].filter((day) => day <= limit)
    list.forEach((post, index) => {
      const day = anchors[index % anchors.length]
      const key = `${month}-${String(day).padStart(2, '0')}`
      counts[key] = (counts[key] || 0) + 1
    })
  }

  const payload = {
    asOf: localISODate(),
    counts,
  }

  fs.writeFileSync(path.join(generatedDir, 'heatmap.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
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

function writeSitemap(sidebar) {
  const lines = [
    '---',
    'title: 站点地图',
    'layout: doc',
    '---',
    '',
    '# 站点地图',
    '',
    '自动生成的全站内容导航，按主题和月份归档。',
    '',
  ]

  for (const key of Object.keys(sidebar)) {
    const topic = key.replace(/^\//, '').replace(/\/$/, '')
    const topicName = topicDisplayName(topic)
    const sections = (sidebar[key] || []).filter((section) => Array.isArray(section.items))

    lines.push(`## [${topicName}](/${topic}/)`)
    lines.push('')

    for (const section of sections) {
      lines.push(`### ${section.text}`)
      lines.push('')
      for (const item of section.items || []) {
        lines.push(`- [${item.text}](${item.link})`)
      }
      lines.push('')
    }
  }

  fs.writeFileSync(sitemapFile, `${lines.join('\n')}\n`, 'utf8')
}

const { nav, sidebar } = buildStructure()
writeNavigationFile(nav, sidebar)
const posts = buildHomePosts(sidebar)
writeHomeIndex(posts, sidebar)
writeBlogPage(posts)
writeHeatmap(posts)
writeSitemap(sidebar)

console.log(`Generated ${path.relative(rootDir, outputFile)}`)
console.log(`Generated ${path.relative(rootDir, homeIndexFile)} (${posts.length} posts)`)
console.log(`Generated ${path.relative(rootDir, path.join(docsDir, 'blog.md'))}`)
console.log(`Generated ${path.relative(rootDir, sitemapFile)}`)
console.log(`Topics: ${Object.keys(sidebar).length}`)
