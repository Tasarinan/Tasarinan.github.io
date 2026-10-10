---
layout: home
layoutClass: m-home-layout
pageClass: m-home-layout

hero:
  name: "Tasarinan's Blog"
  tagline: 把想法交给AI，从超级个体走向超级团队
  image:
    src: /hero.jpg
    alt: Tasarinan
  actions:
    - theme: brand
      text: 进入博客
      link: /blog
    - theme: alt
      text: 进入仓库
      link: https://github.com/Tasarinan/Tasarinan.github.io

features:
  - icon: 📖
    title: "架构笔记"
    details: "超级个体这一步：把规划、检索、评测和护栏交给模型，先让一个人跑通。"
    link: /agent-architect-insight/
    linkText: "进入架构笔记"
  - icon: 🧰
    title: "FDE实践"
    details: "把想法交到现场：通道、技能、记忆和边界，从一个人交到一支队伍。"
    link: /opeclaw-advisor/
    linkText: "进入FDE实践"
  - icon: 🔍
    title: "AI揭密"
    details: "把模型拆开看：它实际在做什么，边界在哪里，哪些说法经不起核对。"
    link: /ai-jiemi/
    linkText: "进入AI揭密"
---

<ClientOnly>
  <Heatmap />
</ClientOnly>
