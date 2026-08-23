import { defineConfig } from 'vitepress'
import { nav, sidebar } from './generated/navigation.mjs'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Tasarinan Docs',
  description: 'Clean docs powered by VitePress',
  lastUpdated: true,
  ignoreDeadLinks: true,
  themeConfig: {
    nav,
    sidebar,
    search: {
      provider: 'local',
    },
    socialLinks: [],
  },
})