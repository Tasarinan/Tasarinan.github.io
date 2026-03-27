import type { DefaultTheme } from 'vitepress'

export const claudeCodeSidebar: DefaultTheme.Sidebar = {
  '/claude-code/': [
    {
      text: 'Claude Code 教程',
      items: [
        { text: '第1章  完整安装指南',      link: '/claude-code/01-Claude-Code完整安装指南' },
        { text: '第2章  基础使用完整指南',  link: '/claude-code/02-基础使用完整指南' },
        { text: '第3章  Commands系统完整指南', link: '/claude-code/03-Commands系统完整指南' },
        { text: '第4章  MCP集成完整指南',   link: '/claude-code/04-MCP集成完整指南' },
        { text: '第5章  Hooks系统完整指南', link: '/claude-code/05-Hooks系统完整指南' },
        { text: '第6章  Subagent子代理完整指南', link: '/claude-code/06-Subagent子代理完整指南' },
        { text: '第7章  Skills定制完整指南',  link: '/claude-code/07-Skills定制完整指南' },
        { text: '第8章  Plugins生态完整指南', link: '/claude-code/08-Plugins生态完整指南' },
        { text: '第9章  Agent-SDK完整指南',   link: '/claude-code/09-Agent-SDK完整指南' },
        { text: '第10章 综合实战完整指南',    link: '/claude-code/10-综合实战完整指南' },
        { text: '第11章 企业实战完整指南',    link: '/claude-code/11-企业实战完整指南' },
        { text: '快速导航卡',               link: '/claude-code/快速导航卡' },
      ],
    },
  ],
}
