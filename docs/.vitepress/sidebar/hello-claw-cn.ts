import type { DefaultTheme } from 'vitepress'
import { readdirSync, existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

function toTitle(fileName: string): string {
  return basename(fileName, '.md')
    .replace(/^\d+[-_.\s]*/, '')        // strip leading number prefix like 01-
    .replace(/^[A-Z]-/, '')             // strip appendix letter prefix like A-
    .replace(/[-_]+/g, ' ')
    .trim()
}

function buildSection(section: string): DefaultTheme.SidebarItem[] {
  const dir = resolve(__dirname, `../../hello-claw/${section}`)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN-u-kn-true'))
    .map((f) => ({
      text: toTitle(f),
      link: `/hello-claw/${section}/${basename(f, '.md')}`,
    }))
}

export const helloclawCnSidebar: DefaultTheme.Sidebar = {
  '/hello-claw/adopt/':      [{ text: '领养篇（使用指南）', items: buildSection('adopt')      }],
  '/hello-claw/build/':      [{ text: '构建篇（开发指南）', items: buildSection('build')      }],
  '/hello-claw/university/': [{ text: '龙虾大学',           items: buildSection('university') }],
  '/hello-claw/appendix/':   [{ text: '附录',               items: buildSection('appendix')   }],
}
