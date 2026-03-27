import type { DefaultTheme } from 'vitepress'

const adoptSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Adopt Claw (User Guide)',
    items: [
      { text: 'Chapter 0: Introduction',            link: '/hello-claw/en/adopt/chapter0/' },
      { text: 'Chapter 1: Quick Start',             link: '/hello-claw/en/adopt/chapter1' },
      { text: 'Chapter 2: Understanding OpenClaw',  link: '/hello-claw/en/adopt/chapter2' },
      { text: 'Chapter 3: Mobile Access',           link: '/hello-claw/en/adopt/chapter3' },
      { text: 'Chapter 4: Automation Basics',       link: '/hello-claw/en/adopt/chapter4' },
      { text: 'Chapter 5: Skills System',           link: '/hello-claw/en/adopt/chapter5' },
      { text: 'Chapter 6: External Services',       link: '/hello-claw/en/adopt/chapter6' },
      { text: 'Chapter 7: Production Deployment',   link: '/hello-claw/en/adopt/chapter7' },
      { text: 'Chapter 8: Multi-Model & Cost',      link: '/hello-claw/en/adopt/chapter8' },
      { text: 'Chapter 9: Personal Assistant',      link: '/hello-claw/en/adopt/chapter9' },
      { text: 'Chapter 10: Content Creation',       link: '/hello-claw/en/adopt/chapter10' },
      { text: 'Chapter 11: Developer Productivity', link: '/hello-claw/en/adopt/chapter11' },
      { text: 'Chapter 12: Troubleshooting',        link: '/hello-claw/en/adopt/chapter12' },
    ],
  },
]

const buildSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Build Claw (Developer Guide)',
    items: [
      { text: 'Introduction',                        link: '/hello-claw/en/build/' },
      { text: 'Chapter 1: Architecture Philosophy',  link: '/hello-claw/en/build/chapter1' },
      { text: 'Chapter 2: ReAct Loop',               link: '/hello-claw/en/build/chapter2' },
      { text: 'Chapter 3: Prompt System',            link: '/hello-claw/en/build/chapter3' },
      { text: 'Chapter 4: Tool System',              link: '/hello-claw/en/build/chapter4' },
      { text: 'Chapter 5: Message Loop & Events',    link: '/hello-claw/en/build/chapter5' },
      { text: 'Chapter 6: Unified Gateway',          link: '/hello-claw/en/build/chapter6' },
      { text: 'Chapter 7: Security Sandbox',         link: '/hello-claw/en/build/chapter7' },
      { text: 'Chapter 8: Lightweight Solutions',    link: '/hello-claw/en/build/chapter8' },
      { text: 'Chapter 9: Security Hardening',       link: '/hello-claw/en/build/chapter9' },
      { text: 'Chapter 10: Hardware Solutions',      link: '/hello-claw/en/build/chapter10' },
    ],
  },
]

export const helloclawEnSidebar: DefaultTheme.Sidebar = {
  '/hello-claw/en/adopt/': adoptSidebar,
  '/hello-claw/en/build/': buildSidebar,
}
