---
title: Tasarinan
layout: doc
---

<div class="blog-index">
  <header class="blog-header">
    <h1>Tasarinan</h1>
    <p>一个技术写作索引，自动从文档目录生成。</p>
  </header>

  <section>
    <h2>2026-08</h2>
    <ul>
      <li><span>2026-08</span><a href="/agent-architect-insight/2026-08/Agent-01-任务规划与执行框架">Agent 01 任务规划与执行框架</a></li>
      <li><span>2026-08</span><a href="/agent-architect-insight/2026-08/Agent-02-协作机制与流程治理">Agent 02 协作机制与流程治理</a></li>
      <li><span>2026-08</span><a href="/agent-architect-insight/2026-08/Agent-03-工具调用与路由容错">Agent 03 工具调用与路由容错</a></li>
      <li><span>2026-08</span><a href="/agent-architect-insight/2026-08/Agent-04-记忆评测与安全护栏">Agent 04 记忆评测与安全护栏</a></li>
    </ul>
  </section>

  <section>
    <h2>2026-07</h2>
    <ul>
      <li><span>2026-07</span><a href="/agent-architect-insight/2026-07/LLM-01-上下文工程与预算起步">LLM 01 上下文工程与预算起步</a></li>
      <li><span>2026-07</span><a href="/agent-architect-insight/2026-07/LLM-02-上下文稳定性与路由控制">LLM 02 上下文稳定性与路由控制</a></li>
      <li><span>2026-07</span><a href="/agent-architect-insight/2026-07/LLM-03-Token治理与模型分层">LLM 03 Token治理与模型分层</a></li>
      <li><span>2026-07</span><a href="/agent-architect-insight/2026-07/LLM-04-参数策略与推理能力进阶">LLM 04 参数策略与推理能力进阶</a></li>
      <li><span>2026-07</span><a href="/agent-architect-insight/2026-07/LLM-05-Prompt结构化与迭代方法">LLM 05 Prompt结构化与迭代方法</a></li>
      <li><span>2026-07</span><a href="/agent-architect-insight/2026-07/LLM-06-RAG检索增强全链路">LLM 06 RAG检索增强全链路</a></li>
      <li><span>2026-07</span><a href="/agent-architect-insight/2026-07/LLM-07-微调对齐与部署优化">LLM 07 微调对齐与部署优化</a></li>
    </ul>
  </section>

  <section>
    <h2>2026-06</h2>
    <ul>
      <li><span>2026-06</span><a href="/agent-architect-insight/2026-06/NLP-01-语料基础与预处理体系">NLP 01 语料基础与预处理体系</a></li>
      <li><span>2026-06</span><a href="/agent-architect-insight/2026-06/NLP-02-语义向量与Embedding工程">NLP 02 语义向量与Embedding工程</a></li>
      <li><span>2026-06</span><a href="/agent-architect-insight/2026-06/NLP-03-训练优化与评估闭环">NLP 03 训练优化与评估闭环</a></li>
    </ul>
  </section>
</div>

<style>
.blog-index {
  max-width: 760px;
  margin: 24px auto 48px;
  padding: 0 12px;
  color: #111;
}

.blog-header {
  border-bottom: 1px solid #ddd;
  margin-bottom: 24px;
  padding-bottom: 12px;
}

.blog-header h1 {
  margin: 0;
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.blog-header p {
  margin: 8px 0 0;
  color: #444;
  font-size: 0.98rem;
}

.blog-index h2 {
  margin: 20px 0 10px;
  font-size: 1.15rem;
  font-weight: 600;
  color: #222;
}

.blog-index ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.blog-index li {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 10px;
  padding: 6px 0;
  border-top: 1px dotted #ddd;
}

.blog-index li:first-child {
  border-top: 0;
}

.blog-index span {
  color: #666;
  font-size: 0.9rem;
}

.blog-index a {
  color: #222;
  text-decoration: none;
}

.blog-index a:hover {
  text-decoration: underline;
}

@media (max-width: 640px) {
  .blog-index {
    margin-top: 12px;
  }

  .blog-index li {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
