import { defineConfig } from 'vitepress'
import { nav, sidebar } from './generated/navigation.mjs'

export default defineConfig({
  lang: 'zh-CN',
  title: "Tasarinan's Blog",
  description: '把想法交给AI，从超级个体走向超级团队。',
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,
  head: [
    ['link', { rel: 'icon', href: '/logo.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#00a98e' }],
  ],
  markdown: {
    config(md) {
      md.set({ html: true })
    },
  },
  themeConfig: {
    nav,
    sidebar,
    logo: {
      light: '/logo.svg',
      dark: '/logo-dark.svg',
    },
    outline: {
      level: [2, 3],
      label: '页面导航',
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇',
    },
    lastUpdated: {
      text: '最后更新于',
    },
    search: {
      provider: 'local',
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Tasarinan/Tasarinan.github.io' },
    ],
    footer: {
      message: '把想法交给AI，从超级个体走向超级团队',
      copyright: "Copyright © 2026 Tasarinan's Blog",
    },
  },
})
