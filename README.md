# Tasarinan Docs

Clean VitePress documentation workspace.

## Quick Start

```bash
npm install
npm run docs:dev
```

Build static site:

```bash
npm run docs:build
```

## Content Convention

Add content under `docs` by topic and month.

```text
docs/
  agent-architect-insight/
    2026-08/
      assets/
      01-architecture-principles.md
      02-agent-boundaries.md
```

Rules:

1. First level is topic directory.
2. Second level is month directory (for example `2026-08`).
3. Put images in `assets/` of that month.
4. Keep markdown files inside the month directory.

## Auto Navigation

No manual VitePress config updates are required.

- `npm run docs:gen` scans `docs/` and generates sidebar + nav.
- `npm run docs:dev` and `npm run docs:build` run generation automatically.

## Deployment Reference

VitePress deployment guide:

- https://vitepress.dev/zh/guide/deploy

## 🔥 最新动态

- **[2026-03-18]** ✨ 新增 Claude Code 教程（11章）和 OpenClaw 指南（12章）
- **[2026-03-12]** ✅ 完成构建 Claw 第 1-10 章：核心架构解析、替代方案探索
- **[2026-03-10]** ✅ 完成构建 Claw 第 13 章：Skill 编写
- **[2026-03-10]** ✅ 新增龙虾大学：Skills 选修指南
- **[2026-03-08]** ✅ 完成领养 Claw 第 1-11 章
- **[2026-03-04]** 🦞 项目启动

---

## 🦞 应用场景

<table align="center">
  <tr>
    <td valign="top" width="33%">
      <b>🌅 个人效率</b><br>
      • 早间简报（天气+日程+待办）<br>
      • 邮件自动分类与摘要<br>
      • 智能日程管理
    </td>
    <td valign="top" width="33%">
      <b>💻 编程开发</b><br>
      • 代码生成与审查<br>
      • 自动化测试与部署<br>
      • 文档自动生成
    </td>
    <td valign="top" width="33%">
      <b>📢 内容创作</b><br>
      • 社交媒体自动运营<br>
      • 写作辅助与润色<br>
      • 多平台内容发布
    </td>
  </tr>
  <tr>
    <td valign="top" width="33%">
      <b>🏢 商务销售</b><br>
      • 客户支持与 CRM 管理<br>
      • 销售线索自动跟进<br>
      • 会议预约与纪要
    </td>
    <td valign="top" width="33%">
      <b>🤖 多智能体协作</b><br>
      • 智能体团队项目管理<br>
      • 自动化工作流编排<br>
      • 知识库共享与检索
    </td>
    <td valign="top" width="33%">
      <b>🔧 更多场景</b><br>
      • 智能家居控制<br>
      • 金融数据分析<br>
      • 教育培训辅助
    </td>
  </tr>
</table>

---



---

## 🤝 参与贡献

- **发现问题**：提 [Issue](https://github.com/datawhalechina/hello-claw/issues) 反馈
- **贡献代码**：提 [Pull Request](https://github.com/datawhalechina/hello-claw/pulls)
- **发起项目**：参考 [Datawhale 开源项目指南](https://github.com/datawhalechina/DOPMC/blob/main/GUIDE.md)

<a id="交流群"></a>

## 💬 交流群

<div align="center">
<p>欢迎加入 Hello Claw 交流群：</p>
<img src="asset/wechat.jpg" width="300" alt="交流群二维码">
</div>

---

## 📧 关注我们

<div align=center>
<p>扫描下方二维码关注公众号：Datawhale</p>
<img src="https://raw.githubusercontent.com/datawhalechina/pumpkin-book/master/res/qrcode.jpeg" width="180" height="180">
</div>

---

## 📄 LICENSE

<div align="center">

本作品采用 [CC BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/) 许可协议

</div>

---

<div align="center">
  <h3>⭐ 如果这个项目对你有帮助，请给我们一个 Star ❤️</h3>
</div>
