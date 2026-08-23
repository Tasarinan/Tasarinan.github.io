---
layout: home

hero:
  name: Tasarinan Notes
  text: 面向 Agent 架构与工程实践的文档站
  tagline: 按主题组织，按月沉淀，自动生成导航
  actions:
    - theme: brand
      text: 开始阅读
      link: /agent-architect-insight/2026-08/01-架构洞察
    - theme: alt
      text: VitePress 部署
      link: https://vitepress.dev/zh/guide/deploy

features:
  - title: 目录即配置
    details: 新增主题目录和月份目录后，导航自动生成，无需手工维护 VitePress sidebar。
  - title: 两层导航
    details: 左侧始终保持两层结构，先按月份，再按该月文章主题。
  - title: 图片资产规范
    details: 每个月目录内固定使用 assets 保存图片，Markdown 相对路径即可引用。
---

<section class="home-stream">
	<h2>最新更新</h2>
	<ul>
		<li>
			<a href="/agent-architect-insight/2026-08/01-架构洞察">2026-08 · 架构洞察 01</a>
			<span>建立 Agent 系统设计观察框架</span>
		</li>
		<li>
			<a href="/agent-architect-insight/2026-08/02-边界与职责">2026-08 · 边界与职责 02</a>
			<span>定义模块职责、调用边界与协作契约</span>
		</li>
	</ul>
</section>

<section class="home-guide">
	<h2>写作约定</h2>
	<pre><code>docs/
	agent-architect-insight/
		2026-08/
			assets/
			01-架构洞察.md
			02-边界与职责.md</code></pre>
	<p>运行 <strong>npm run docs:dev</strong> 或 <strong>npm run docs:build</strong> 时会自动执行导航生成。</p>
</section>

<style>
:root {
	--vp-home-hero-name-color: #1f2937;
	--vp-home-hero-name-background: linear-gradient(120deg, #111827 20%, #374151 100%);
	--vp-home-hero-image-background-image: radial-gradient(circle at 30% 30%, #f3f4f6 0, transparent 58%);
	--vp-home-hero-image-filter: blur(46px);
	--vp-button-brand-bg: #111827;
	--vp-button-brand-hover-bg: #374151;
	--vp-c-brand-1: #111827;
	--vp-c-brand-2: #374151;
	--vp-c-brand-3: #4b5563;
}

.VPHome {
	background:
		radial-gradient(circle at 80% 8%, rgba(148, 163, 184, 0.2), transparent 35%),
		radial-gradient(circle at 8% 24%, rgba(226, 232, 240, 0.8), transparent 38%),
		#f8fafc;
}

.VPHomeHero .text,
.VPHomeHero .tagline {
	color: #4b5563;
}

.home-stream,
.home-guide {
	max-width: 920px;
	margin: 28px auto;
	background: rgba(255, 255, 255, 0.8);
	border: 1px solid #e5e7eb;
	border-radius: 14px;
	padding: 22px 24px;
	backdrop-filter: blur(4px);
}

.home-stream h2,
.home-guide h2 {
	margin: 0 0 14px;
	font-size: 1.15rem;
	color: #111827;
}

.home-stream ul {
	list-style: none;
	margin: 0;
	padding: 0;
}

.home-stream li {
	display: grid;
	gap: 3px;
	padding: 12px 0;
	border-top: 1px solid #f1f5f9;
}

.home-stream li:first-child {
	border-top: none;
	padding-top: 0;
}

.home-stream a {
	font-weight: 600;
	color: #0f172a;
	text-decoration: none;
}

.home-stream a:hover {
	text-decoration: underline;
}

.home-stream span {
	color: #64748b;
	font-size: 0.94rem;
}

.home-guide pre {
	margin: 0;
	background: #0f172a;
	border-radius: 10px;
}

.home-guide p {
	margin: 12px 0 0;
	color: #475569;
}

@media (max-width: 640px) {
	.home-stream,
	.home-guide {
		margin: 18px 12px;
		padding: 16px;
		border-radius: 12px;
	}
}
</style>
