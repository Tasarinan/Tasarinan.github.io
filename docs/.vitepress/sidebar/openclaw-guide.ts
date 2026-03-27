import type { DefaultTheme } from 'vitepress'
import { readdirSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

const openclawGuideDir = resolve(__dirname, '../../openclaw-guide')

function toSidebarTitle(fileName: string): string {
  const name = basename(fileName, extname(fileName))
  return name
    .replace(/^\d+[\-_.\s]*/, '')
    .replace(/[\-_]+/g, ' ')
    .trim()
}

function buildOpenclawGuideItems(): DefaultTheme.SidebarItem[] {
  return readdirSync(openclawGuideDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN-u-kn-true'))
    .map((fileName) => {
      const slug = basename(fileName, '.md')
      return {
        text: toSidebarTitle(fileName),
        link: `/openclaw-guide/${slug}`,
      }
    })
}

export const openclawGuideSidebar: DefaultTheme.Sidebar = {
  '/openclaw-guide/': [
    {
      text: 'OpenClaw 指南',
      items: buildOpenclawGuideItems(),
    },
  ],
}
