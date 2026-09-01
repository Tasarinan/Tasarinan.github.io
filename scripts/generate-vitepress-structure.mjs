import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const docsDir = path.join(rootDir, 'docs')
const generatedDir = path.join(docsDir, '.vitepress', 'generated')
const outputFile = path.join(generatedDir, 'navigation.mjs')
const homeIndexFile = path.join(docsDir, 'index.md')
const sitemapFile = path.join(docsDir, 'sitemap.md')

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

function topicDisplayName(topic) {
  const normalized = topic.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!/[a-zA-Z]/.test(normalized)) return normalized
  return normalized
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
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
  fs.writeFileSync(topicIndexFile, renderTopicIndex(topic, sections), 'utf8')
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

    if (hasPosts) {
      const topicIndexLink = `/${topic}/`
      nav.push({ text: topic, link: topicIndexLink })
      topicSidebarItems.unshift({ text: '主题总览', link: topicIndexLink })
      writeTopicIndex(topic, topicSidebarItems.slice(1))
    }

    sidebar[`/${topic}/`] = topicSidebarItems
  }

  nav.push({ text: '站点地图', link: '/sitemap' })

  return { nav, sidebar }
}

function buildHomePosts(sidebar) {
  const posts = []

  for (const key of Object.keys(sidebar)) {
    const sections = sidebar[key] || []
    for (const section of sections) {
      for (const item of section.items || []) {
        const base = stripMd(path.basename(item.link))
        posts.push({
          month: section.text,
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

function buildTopicCards(sidebar) {
  const cards = []

  for (const key of Object.keys(sidebar)) {
    const topic = key.replace(/^\//, '').replace(/\/$/, '')
    const topicName = topicDisplayName(topic)
    const sections = (sidebar[key] || []).filter((section) => Array.isArray(section.items))
    const allItems = sections.flatMap((section) => section.items || [])

    cards.push({
      topic,
      topicName,
      monthCount: sections.length,
      postCount: allItems.length,
      latestPosts: allItems.slice(0, 3),
      topicLink: `/${topic}/`,
    })
  }

  return cards
}

function writeHomeIndex(posts, sidebar) {
  const cards = buildTopicCards(sidebar)
  const monthOptions = Array.from(new Set(posts.map((post) => post.month)))

  const postItems = posts
    .map((post) => {
      return [
        `      <li class="post-item" data-title="${post.title.toLowerCase()}" data-month="${post.month}">`,
        '        <div class="post-line">',
        `          <a class="post-title" href="${post.link}">${post.title}</a>`,
        `          <span class="post-meta">${post.month.replace('-', '/')}</span>`,
        '        </div>',
        '      </li>',
      ].join('\n')
    })
    .join('\n')

  const cardItems = cards
    .map((card) => {
      const latest = card.latestPosts
        .map((item) => `<li><a href="${item.link}">${item.text}</a></li>`)
        .join('')

      return [
        '      <article class="topic-card">',
        '        <div class="topic-card-head">',
        `          <h3><a href="${card.topicLink}">${card.topicName}</a></h3>`,
        `          <span>${card.postCount} 篇</span>`,
        '        </div>',
        `        <div class="topic-card-meta">${card.monthCount} 个月份</div>`,
        `        <ul class="topic-card-list">${latest}</ul>`,
        '      </article>',
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
    '  <section class="hero">',
    '    <p class="hero-kicker">Tasarinan.github.io</p>',
    '    <h1>工程笔记</h1>',
    '    <p class="hero-subtitle">围绕 LLM、Agent 与 OpenClaw 投顾实践，持续沉淀可复用的方法、指标与设计决策。</p>',
    '    <div class="hero-tags">',
    '      <span>Architecture</span>',
    '      <span>RAG</span>',
    '      <span>Prompting</span>',
    '      <span>Safety</span>',
    '      <span>Evaluation</span>',
    '      <span>OpenClaw</span>',
    '      <span>Skills</span>',
    '      <span>Memory</span>',
    '    </div>',
    '  </section>',
    '',
    '  <section class="topics-panel">',
    '    <div class="panel-head">',
    '      <h2>主题导航</h2>',
    '      <a href="/sitemap">查看全站地图</a>',
    '    </div>',
    '    <div class="topic-grid">',
    cardItems,
    '    </div>',
    '  </section>',
    '',
    '  <section class="post-section">',
    '    <div class="post-section-head">',
    '      <h2>最新文章</h2>',
    '      <p>按发布时间倒序自动更新</p>',
    '    </div>',
    '    <div class="post-filter">',
    '      <input id="post-search-input" type="search" placeholder="输入关键词筛选文章，如 RAG / 记忆 / Prompt" />',
    '      <select id="post-month-select" aria-label="按月份筛选">',
    '        <option value="">全部月份</option>',
    ...monthOptions.map((month) => `        <option value="${month}">${month.replace('-', '/')}</option>`),
    '      </select>',
    '      <button id="post-filter-reset" type="button">清空筛选</button>',
    '      <span id="post-search-count"></span>',
    '    </div>',
    '    <ul class="post-list" id="post-list">',
    postItems,
    '    </ul>',
    '  </section>',
    '</div>',
    '',
    '<style>',
    '.blog-index {',
    '  --ink: #14253a;',
    '  --muted: #48627f;',
    '  --line: #d4e1ed;',
    '  --brand-soft: #e5f0fb;',
    '  max-width: 980px;',
    '  margin: 8px auto 44px;',
    '  color: var(--ink);',
    '  font-family: "IBM Plex Sans", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;',
    '}',
    '',
    '.hero {',
    '  position: relative;',
    '  overflow: hidden;',
    '  border-radius: 22px;',
    '  padding: 34px 30px 28px;',
    '  background: radial-gradient(circle at 0% 0%, #fdfefe 0%, #eef6ff 55%, #e4eef9 100%);',
    '  border: 1px solid var(--line);',
    '  box-shadow: 0 20px 36px -30px rgba(15, 43, 81, 0.35);',
    '}',
    '',
    '.hero::after {',
    '  content: "";',
    '  position: absolute;',
    '  right: -60px;',
    '  top: -50px;',
    '  width: 240px;',
    '  height: 240px;',
    '  border-radius: 999px;',
    '  background: linear-gradient(130deg, rgba(130, 169, 209, 0.24), rgba(15, 76, 129, 0.08));',
    '}',
    '',
    '.hero-kicker {',
    '  margin: 0;',
    '  font-size: 0.8rem;',
    '  text-transform: uppercase;',
    '  letter-spacing: 0.14em;',
    '  color: #315579;',
    '  font-weight: 700;',
    '}',
    '',
    '.hero h1 {',
    '  margin: 8px 0 0;',
    '  font-size: clamp(1.85rem, 3.8vw, 2.8rem);',
    '  line-height: 1.08;',
    '  letter-spacing: -0.02em;',
    '}',
    '',
    '.hero-subtitle {',
    '  max-width: 690px;',
    '  margin: 14px 0 0;',
    '  color: var(--muted);',
    '  font-size: 1.03rem;',
    '  line-height: 1.56;',
    '}',
    '',
    '.hero-tags {',
    '  position: relative;',
    '  z-index: 1;',
    '  display: flex;',
    '  flex-wrap: wrap;',
    '  gap: 8px;',
    '  margin-top: 16px;',
    '}',
    '',
    '.hero-tags span {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  padding: 5px 10px;',
    '  border-radius: 999px;',
    '  background: var(--brand-soft);',
    '  color: #194977;',
    '  border: 1px solid #cce0f4;',
    '  font-size: 0.8rem;',
    '  font-weight: 600;',
    '}',
    '',
    '.topics-panel, .post-section {',
    '  margin-top: 16px;',
    '  border: 1px solid var(--line);',
    '  border-radius: 18px;',
    '  background: #fff;',
    '  padding: 16px;',
    '}',
    '',
    '.panel-head, .post-section-head {',
    '  display: flex;',
    '  justify-content: space-between;',
    '  align-items: baseline;',
    '  gap: 10px;',
    '  border-bottom: 1px solid #e6eef7;',
    '  padding-bottom: 12px;',
    '}',
    '',
    '.panel-head h2, .post-section-head h2 {',
    '  margin: 0;',
    '  font-size: 1.16rem;',
    '}',
    '',
    '.panel-head a {',
    '  color: #194674;',
    '  font-size: 0.88rem;',
    '  text-decoration: none;',
    '}',
    '',
    '.panel-head a:hover {',
    '  text-decoration: underline;',
    '}',
    '',
    '.post-section-head p {',
    '  margin: 0;',
    '  color: var(--muted);',
    '  font-size: 0.9rem;',
    '}',
    '',
    '.topic-grid {',
    '  margin-top: 12px;',
    '  display: grid;',
    '  gap: 10px;',
    '  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));',
    '}',
    '',
    '.topic-card {',
    '  border: 1px solid #e6edf5;',
    '  border-radius: 12px;',
    '  padding: 12px;',
    '  background: linear-gradient(130deg, #ffffff 0%, #f7fbff 100%);',
    '}',
    '',
    '.topic-card-head {',
    '  display: flex;',
    '  justify-content: space-between;',
    '  align-items: baseline;',
    '  gap: 8px;',
    '}',
    '',
    '.topic-card-head h3 {',
    '  margin: 0;',
    '  font-size: 1rem;',
    '}',
    '',
    '.topic-card-head h3 a {',
    '  color: #143a63;',
    '  text-decoration: none;',
    '}',
    '',
    '.topic-card-head h3 a:hover {',
    '  text-decoration: underline;',
    '}',
    '',
    '.topic-card-head span {',
    '  font-size: 0.78rem;',
    '  color: #3b5d81;',
    '  background: #eaf2fb;',
    '  padding: 2px 6px;',
    '  border-radius: 999px;',
    '}',
    '',
    '.topic-card-meta {',
    '  margin-top: 6px;',
    '  color: #56718d;',
    '  font-size: 0.82rem;',
    '}',
    '',
    '.topic-card-list {',
    '  margin: 8px 0 0;',
    '  padding-left: 17px;',
    '}',
    '',
    '.topic-card-list li + li {',
    '  margin-top: 5px;',
    '}',
    '',
    '.topic-card-list a {',
    '  color: #214f7a;',
    '  text-decoration: none;',
    '  font-size: 0.88rem;',
    '}',
    '',
    '.topic-card-list a:hover {',
    '  text-decoration: underline;',
    '}',
    '',
    '.post-filter {',
    '  margin-top: 12px;',
    '  display: grid;',
    '  grid-template-columns: minmax(220px, 1fr) 130px 100px auto;',
    '  gap: 8px;',
    '  align-items: center;',
    '}',
    '',
    '.post-filter input {',
    '  width: 100%;',
    '  border: 1px solid #cfdceb;',
    '  border-radius: 10px;',
    '  padding: 9px 11px;',
    '  font-size: 0.92rem;',
    '  color: #17314e;',
    '  background: #f9fcff;',
    '}',
    '',
    '.post-filter input:focus {',
    '  outline: 2px solid #c8ddf3;',
    '  border-color: #97badf;',
    '}',

    '.post-filter select {',
    '  border: 1px solid #cfdceb;',
    '  border-radius: 10px;',
    '  padding: 9px 10px;',
    '  font-size: 0.9rem;',
    '  color: #17314e;',
    '  background: #f9fcff;',
    '}',

    '.post-filter select:focus {',
    '  outline: 2px solid #c8ddf3;',
    '  border-color: #97badf;',
    '}',

    '.post-filter button {',
    '  border: 1px solid #b4cbe5;',
    '  border-radius: 10px;',
    '  padding: 8px 10px;',
    '  background: #eef5fc;',
    '  color: #20476e;',
    '  font-size: 0.88rem;',
    '  font-weight: 600;',
    '  cursor: pointer;',
    '}',

    '.post-filter button:hover {',
    '  background: #e0eefb;',
    '}',
    '',
    '.post-filter span {',
    '  color: #4a6684;',
    '  font-size: 0.84rem;',
    '}',
    '',
    '.post-list {',
    '  list-style: none;',
    '  margin: 10px 0 0;',
    '  padding: 0;',
    '}',
    '',
    '.post-item {',
    '  margin-top: 8px;',
    '  border: 1px solid #e6edf5;',
    '  border-radius: 12px;',
    '  background: linear-gradient(130deg, #ffffff 0%, #f7fbff 100%);',
    '  padding: 11px 12px;',
    '  animation: fade-up 420ms ease both;',
    '}',
    '',
    '.post-item:nth-child(2n) {',
    '  animation-delay: 60ms;',
    '}',
    '',
    '.post-item:nth-child(3n) {',
    '  animation-delay: 120ms;',
    '}',
    '',
    '.post-line {',
    '  display: flex;',
    '  align-items: baseline;',
    '  justify-content: space-between;',
    '  gap: 10px;',
    '}',
    '',
    '.post-item.is-hidden {',
    '  display: none;',
    '}',
    '',
    '.post-title {',
    '  color: #143a63;',
    '  text-decoration: none;',
    '  font-size: 1rem;',
    '  font-weight: 600;',
    '  line-height: 1.38;',
    '}',
    '',
    '.post-title:hover {',
    '  text-decoration: underline;',
    '}',
    '',
    '.post-meta {',
    '  color: #456281;',
    '  font-size: 0.82rem;',
    '  letter-spacing: 0.03em;',
    '  white-space: nowrap;',
    '}',
    '',
    '@keyframes fade-up {',
    '  from {',
    '    opacity: 0;',
    '    transform: translateY(8px);',
    '  }',
    '  to {',
    '    opacity: 1;',
    '    transform: translateY(0);',
    '  }',
    '}',
    '',
    '@media (max-width: 640px) {',
    '  .blog-index {',
    '    margin-top: 6px;',
    '  }',
    '  .hero {',
    '    border-radius: 16px;',
    '    padding: 24px 18px 20px;',
    '  }',
    '  .hero-subtitle {',
    '    font-size: 0.95rem;',
    '  }',
    '  .topics-panel, .post-section {',
    '    border-radius: 14px;',
    '    padding: 12px;',
    '  }',
    '  .panel-head, .post-section-head {',
    '    flex-direction: column;',
    '    align-items: flex-start;',
    '    gap: 4px;',
    '  }',
    '  .post-filter {',
    '    grid-template-columns: 1fr;',
    '  }',
    '  .post-line {',
    '    flex-direction: column;',
    '    align-items: flex-start;',
    '  }',
    '}',
    '</style>',
    '',
    '<script>',
    '(() => {',
    '  if (typeof window === "undefined" || typeof document === "undefined") return',
    '  const input = document.getElementById("post-search-input")',
    '  const monthSelect = document.getElementById("post-month-select")',
    '  const resetBtn = document.getElementById("post-filter-reset")',
    '  const count = document.getElementById("post-search-count")',
    '  const list = document.getElementById("post-list")',
    '  if (!input || !monthSelect || !resetBtn || !count || !list) return',
    '',
    '  const items = Array.from(list.querySelectorAll(".post-item"))',
    '  const renderCount = () => {',
    '    const visible = items.filter((item) => !item.classList.contains("is-hidden")).length',
    '    count.textContent = `显示 ${visible} / ${items.length}`',
    '  }',
    '',
    '  const runFilter = () => {',
    '    const q = input.value.trim().toLowerCase()',
    '    const selectedMonth = monthSelect.value',
    '    for (const item of items) {',
    '      const title = item.getAttribute("data-title") || ""',
    '      const month = item.getAttribute("data-month") || ""',
    '      const matchText = !q || title.includes(q) || month.includes(q)',
    '      const matchMonth = !selectedMonth || month === selectedMonth',
    '      const hit = matchText && matchMonth',
    '      item.classList.toggle("is-hidden", !hit)',
    '    }',
    '    renderCount()',
    '  }',
    '',
    '  input.addEventListener("input", runFilter)',
    '  monthSelect.addEventListener("change", runFilter)',
    '  resetBtn.addEventListener("click", () => {',
    '    input.value = ""',
    '    monthSelect.value = ""',
    '    runFilter()',
    '  })',
    '  renderCount()',
    '})()',
    '</script>',
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
writeSitemap(sidebar)

console.log(`Generated ${path.relative(rootDir, outputFile)}`)
console.log(`Generated ${path.relative(rootDir, homeIndexFile)} (${posts.length} posts)`)
console.log(`Generated ${path.relative(rootDir, sitemapFile)}`)
console.log(`Topics: ${Object.keys(sidebar).length}`)
