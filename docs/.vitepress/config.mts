import { defineConfig } from 'vitepress'
import tailwindcss from '@tailwindcss/vite'
import {
  helloclawCnSidebar,
  claudeCodeSidebar,
  openclawGuideSidebar,
} from './sidebar'

export default defineConfig({
  base: '/',
  vite: {
    plugins: [tailwindcss()],
  },
  vue: {
    template: {
      compilerOptions: {
        delimiters: ['${{', '}}$'],
      },
    },
  },
  ignoreDeadLinks: [/^http:\/\/localhost/],
  markdown: { math: true },
  lastUpdated: true,

  locales: {
    // ─────────────────────── 简体中文 ───────────────────────
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Hello Claw',
      description: '从零到一学习 OpenClaw：领养你的 AI 龙虾助理，或从零构建属于你的智能体',
      themeConfig: {
        logo: '🦞',
        outline: { level: [2, 3], label: '目录' },
        lastUpdated: { text: '最后更新于' },
        nav: [
          { text: '领养龙虾',      link: '/hello-claw/adopt/00-intro',      activeMatch: '^/hello-claw/adopt/' },
          { text: '龙虾大学',      link: '/hello-claw/university/00-intro',  activeMatch: '^/hello-claw/university/' },
          { text: '构建龙虾',      link: '/hello-claw/build/00-intro',       activeMatch: '^/hello-claw/build/' },
          { text: 'Claude Code',   link: '/claude-code/01-Claude-Code完整安装指南', activeMatch: '^/claude-code/' },
          { text: 'OpenClaw 指南', link: '/openclaw-guide/00-阅读指南',      activeMatch: '^/openclaw-guide/' },
          { text: 'GitHub',        link: 'https://github.com/datawhalechina/hello-claw' },
        ],
        search: {
          provider: 'local',
          options: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '无法找到相关结果',
                resetButtonTitle: '清除查询条件',
                footer: { selectText: '选择', navigateText: '切换' },
              },
            },
          },
        },
        sidebar: {
          ...helloclawCnSidebar,
          ...claudeCodeSidebar,
          ...openclawGuideSidebar,
        },
        socialLinks: [
          { icon: 'github', link: 'https://github.com/datawhalechina/hello-claw' },
        ],
        editLink: {
          pattern: 'https://github.com/datawhalechina/hello-claw/blob/main/docs/:path',
          text: '在 GitHub 上编辑此页',
        },
        footer: {
          message: '<a href="https://beian.miit.gov.cn/" target="_blank">京ICP备2026002630号-1</a> | <a href="https://beian.mps.gov.cn/#/query/webSearch?code=11010602202215" rel="noreferrer" target="_blank">京公网安备11010602202215号</a>',
          copyright: '本作品采用 <a href="http://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank">CC BY-NC-SA 4.0</a> 许可',
        },
      },
    },

  },
})