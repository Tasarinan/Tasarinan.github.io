import { h, watch } from 'vue'
import type { Theme } from 'vitepress'
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import Heatmap from './components/Heatmap.vue'
import PostNote from './components/PostNote.vue'

import './styles/index.css'

export default {
  extends: DefaultTheme,
  Layout() {
    const { page } = useData()
    const relativePath = page.value.relativePath || ''
    const isArticle = /^[^/]+\/\d{4}-\d{2}\//.test(relativePath)

    return h(DefaultTheme.Layout, null, {
      'doc-footer-before': isArticle ? () => h(PostNote) : undefined,
    })
  },
  enhanceApp({ app, router }) {
    app.component('Heatmap', Heatmap)

    if (typeof window === 'undefined') return

    const browser = navigator.userAgent.toLowerCase()
    if (browser.includes('firefox')) document.documentElement.classList.add('browser-firefox')
    else if (browser.includes('safari') && !browser.includes('chrome')) {
      document.documentElement.classList.add('browser-safari')
    }

    watch(
      () => router.route.path,
      () => updateHomePageStyle(isHomePath(router.route.path)),
      { immediate: true },
    )
  },
} satisfies Theme

function isHomePath(pathname: string) {
  return pathname === '/' || pathname === '/index.html'
}

let homePageStyle: HTMLStyleElement | undefined

function updateHomePageStyle(value: boolean) {
  if (typeof document === 'undefined') return

  if (value) {
    if (homePageStyle) return
    homePageStyle = document.createElement('style')
    homePageStyle.innerHTML = `
      :root {
        animation: rainbow 12s linear infinite;
      }
    `
    document.body.appendChild(homePageStyle)
    return
  }

  homePageStyle?.remove()
  homePageStyle = undefined
}
