import { defineConfig } from 'vitepress'
import { nav, sidebar } from './generated/navigation.mjs'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Tasarinan Docs',
  description: 'Clean docs powered by VitePress',
  lastUpdated: true,
  ignoreDeadLinks: true,
  markdown: {
    config(md) {
      md.set({ html: false })
    },
  },
  themeConfig: {
    nav,
    sidebar,
    search: {
      provider: 'local',
    },
    socialLinks: [],
  },
})