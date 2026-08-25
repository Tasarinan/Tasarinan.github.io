---
title: 博客
layout: doc
---

<div class="blog-index">
  <section class="hero">
    <p class="hero-kicker">Tasarinan.github.io</p>
    <h1>Agent Architect Insight</h1>
    <p class="hero-subtitle">围绕 LLM 与 Agent 工程实践，持续沉淀可复用的方法、指标与设计决策。</p>
    <div class="hero-tags">
      <span>Architecture</span>
      <span>RAG</span>
      <span>Prompting</span>
      <span>Safety</span>
      <span>Evaluation</span>
    </div>
  </section>

  <section class="post-section">
    <div class="post-section-head">
      <h2>最新文章</h2>
      <p>按发布时间倒序自动更新</p>
    </div>

    <ul class="post-list">
  <!-- HOME_POST_LIST_START -->
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-08/Agent-04-记忆评测与安全护栏">Agent 04 记忆评测与安全护栏</a>
      <div class="post-meta">2026/08</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-08/Agent-03-工具调用与路由容错">Agent 03 工具调用与路由容错</a>
      <div class="post-meta">2026/08</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-08/Agent-02-协作机制与流程治理">Agent 02 协作机制与流程治理</a>
      <div class="post-meta">2026/08</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-08/Agent-01-任务规划与执行框架">Agent 01 任务规划与执行框架</a>
      <div class="post-meta">2026/08</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-07/LLM-07-微调对齐与部署优化">LLM 07 微调对齐与部署优化</a>
      <div class="post-meta">2026/07</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-07/LLM-06-RAG检索增强全链路">LLM 06 RAG检索增强全链路</a>
      <div class="post-meta">2026/07</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-07/LLM-05-Prompt结构化与迭代方法">LLM 05 Prompt结构化与迭代方法</a>
      <div class="post-meta">2026/07</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-07/LLM-04-参数策略与推理能力进阶">LLM 04 参数策略与推理能力进阶</a>
      <div class="post-meta">2026/07</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-07/LLM-03-Token治理与模型分层">LLM 03 Token治理与模型分层</a>
      <div class="post-meta">2026/07</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-07/LLM-02-上下文稳定性与路由控制">LLM 02 上下文稳定性与路由控制</a>
      <div class="post-meta">2026/07</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-07/LLM-01-上下文工程与预算起步">LLM 01 上下文工程与预算起步</a>
      <div class="post-meta">2026/07</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-06/NLP-03-训练优化与评估闭环">NLP 03 训练优化与评估闭环</a>
      <div class="post-meta">2026/06</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-06/NLP-02-语义向量与Embedding工程">NLP 02 语义向量与Embedding工程</a>
      <div class="post-meta">2026/06</div>
    </li>
    <li>
      <a class="post-title" href="/agent-architect-insight/2026-06/NLP-01-语料基础与预处理体系">NLP 01 语料基础与预处理体系</a>
      <div class="post-meta">2026/06</div>
    </li>
<!-- HOME_POST_LIST_END -->
    </ul>
  </section>
</div>

<style>
.blog-index {
  --bg-soft: #f4f8fb;
  --ink: #14253a;
  --muted: #48627f;
  --line: #d4e1ed;
  --brand: #0f4c81;
  --brand-soft: #e5f0fb;
  max-width: 980px;
  margin: 8px auto 44px;
  color: var(--ink);
  font-family: "IBM Plex Sans", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.hero {
  position: relative;
  overflow: hidden;
  border-radius: 22px;
  padding: 34px 30px 28px;
  background: radial-gradient(circle at 0% 0%, #fdfefe 0%, #eef6ff 55%, #e4eef9 100%);
  border: 1px solid var(--line);
  box-shadow: 0 20px 36px -30px rgba(15, 43, 81, 0.35);
}

.hero::after {
  content: "";
  position: absolute;
  right: -60px;
  top: -50px;
  width: 240px;
  height: 240px;
  border-radius: 999px;
  background: linear-gradient(130deg, rgba(130, 169, 209, 0.24), rgba(15, 76, 129, 0.08));
}

.hero-kicker {
  margin: 0;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: #315579;
  font-weight: 700;
}

.hero h1 {
  margin: 8px 0 0;
  font-size: clamp(1.85rem, 3.8vw, 2.8rem);
  line-height: 1.08;
  letter-spacing: -0.02em;
}

.hero-subtitle {
  max-width: 690px;
  margin: 14px 0 0;
  color: var(--muted);
  font-size: 1.03rem;
  line-height: 1.56;
}

.hero-tags {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.hero-tags span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--brand-soft);
  color: #194977;
  border: 1px solid #cce0f4;
  font-size: 0.8rem;
  font-weight: 600;
}

.post-section {
  margin-top: 16px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: #fff;
  padding: 16px;
}

.post-section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  border-bottom: 1px solid #e6eef7;
  padding-bottom: 12px;
}

.post-section-head h2 {
  margin: 0;
  font-size: 1.26rem;
}

.post-section-head p {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

.post-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.post-list li {
  margin-top: 10px;
  padding: 12px 14px;
  border: 1px solid #e6edf5;
  border-radius: 12px;
  background: linear-gradient(130deg, #ffffff 0%, #f7fbff 100%);
  animation: fade-up 420ms ease both;
}

.post-list li:nth-child(2n) {
  animation-delay: 60ms;
}

.post-list li:nth-child(3n) {
  animation-delay: 120ms;
}

.post-title {
  display: inline-block;
  color: #143a63;
  text-decoration: none;
  font-size: 1.02rem;
  font-weight: 600;
  line-height: 1.38;
}

.post-title:hover {
  text-decoration: underline;
}

.post-meta {
  margin-top: 5px;
  color: #456281;
  font-size: 0.82rem;
  letter-spacing: 0.03em;
}

@keyframes fade-up {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 640px) {
  .blog-index {
    margin-top: 6px;
  }
  .hero {
    border-radius: 16px;
    padding: 24px 18px 20px;
  }
  .hero-subtitle {
    font-size: 0.95rem;
  }
  .post-section {
    border-radius: 14px;
    padding: 12px;
  }
  .post-section-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .post-list li {
    margin-top: 8px;
    padding: 11px 12px;
  }
}
</style>
