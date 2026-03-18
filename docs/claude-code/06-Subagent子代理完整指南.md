# Subagent 子代理完整指南：100+ 专家代理一键扩展

> **课程信息**
>
> - **作者**：老金
> - **预计学时**：1-2小时
> - **难度等级**：⭐⭐⭐ 中级
> - **更新日期**：2026年2月
> - **适用版本**：Claude Code v2.1+（验证于2026-02-26）

---

## 📚 本课学习目标

完成本课学习后，你将能够：

1. **理解子代理的概念**：知道 Subagent 是什么、怎么工作的
2. **安装 VoltAgent 代理集合**：掌握 3 种安装方式，选择最适合自己的
3. **按需调用专家代理**：了解 10 大类 100+ 专家代理的能力范围
4. **提升开发效率**：在实际项目中合理使用多代理并行协作

---

## 术语表

| 术语 | 英文全称 | 通俗解释 |
|------|----------|----------|
| **Subagent** | Sub-agent | 子代理，Claude Code 通过 Task 工具启动的专业化 AI 代理 |
| **VoltAgent** | - | 社区维护的 awesome-claude-code-subagents 开源项目 |
| **Agent Definition** | - | `.md` 格式的代理定义文件，描述代理的角色、能力和行为规范 |
| **Task 工具** | Task Tool | Claude Code 内置工具，用于启动子代理执行独立任务 |
| **并行调用** | Parallel Invocation | 同时启动多个子代理处理不同任务，提高效率 |

---

## ⚠️ 重要提醒：Token 消耗

> 使用多 Agent 并行调用的 **token 消耗量巨大**。每启动一个子代理都会消耗独立的上下文窗口。
> 建议按需调用，不要一次性启动太多代理。

---

# 第一部分：快速上手

## 🎯 老金的安装方法（最省事）

如果你配置了 GitHub MCP 服务器，直接在 Claude Code 输入窗口中输入：

```text
使用 Github MCP，帮我下载安装 https://github.com/VoltAgent/awesome-claude-code-subagents
```

Claude 会自动克隆仓库、识别代理定义文件，并安装到正确位置。

**使用方法**：安装完成后，直接用自然语言调用即可：

```text
并行调用各个专家查看/解决 XXXX 问题
```

```text
请 code-reviewer 帮我检查这段代码
```

---

# 第二部分：安装方法详解

## 方法一：交互式脚本安装（推荐）

克隆仓库后运行官方安装脚本，通过菜单选择需要的代理：

```bash
git clone https://github.com/VoltAgent/awesome-claude-code-subagents.git
cd awesome-claude-code-subagents
./install-agents.sh
```

按照屏幕提示操作：该脚本允许你浏览分类、选择特定代理并一键完成安装或卸载。

---

## 方法二：独立快捷安装（无需克隆仓库）

如果你不想克隆整个项目，只需一行命令下载安装脚本：

```bash
curl -sO https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/install-agents.sh
chmod +x install-agents.sh
./install-agents.sh
```

---

## 方法三：手动安装

如果你希望完全手动控制代理文件的存放位置：

1. **确定存放路径**：
   - **全局可用**：将代理文件放入 `~/.claude/agents/`
   - **项目专用**：将代理文件放入当前项目根目录下的 `.claude/agents/`
2. **复制文件**：从仓库的 `categories/` 文件夹中找到你需要的 `.md` 代理定义文件，复制到上述路径即可。

---

## 💡 使用小贴士

- **如何查看**：安装完成后，在 Claude Code 中输入 `/agents` 即可查看已启用的子代理
- **自动激活**：当你的描述符合某个子代理的专业领域时（例如"请 code-reviewer 帮我检查代码"），Claude 会自动调用对应的专家
- **优先级规则**：如果同一个代理同时存在于项目文件夹和全局文件夹，**项目特定代理**的优先级更高

---

# 第三部分：代理目录总览

> 以下是 VoltAgent 提供的 10 大类专家代理。每个类别对应一个插件包，你可以按需安装整个类别或单独挑选。

---

## 1. 核心开发 (Core Development)

*插件包：`voltagent-core-dev`* — 处理日常编码任务的基础专家。

| 代理 | 说明 |
|------|------|
| [api-designer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/api-designer.md) | REST 和 GraphQL API 架构师 |
| [backend-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/backend-developer.md) | 可扩展 API 的服务器端专家 |
| [electron-pro](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/electron-pro.md) | 桌面应用程序专家 |
| [frontend-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/frontend-developer.md) | React、Vue 和 Angular 的 UI/UX 专家 |
| [fullstack-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/fullstack-developer.md) | 端到端功能开发 |
| [graphql-architect](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/graphql-architect.md) | GraphQL Schema 和 Federation 专家 |
| [microservices-architect](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/microservices-architect.md) | 分布式系统设计师 |
| [mobile-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/mobile-developer.md) | 跨平台移动专家 |
| [ui-designer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/ui-designer.md) | 视觉设计和交互专家 |
| [websocket-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/websocket-engineer.md) | 实时通信专家 |
| [wordpress-master](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-dev/wordpress-master.md) | WordPress 开发和优化专家 |

---

## 2. 语言专家 (Language Specialists)

*插件包：`voltagent-lang`* — 具备特定编程语言和框架深厚知识的专家。

| 代理 | 说明 |
|------|------|
| [typescript-pro](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/typescript-pro.md) | TypeScript 专家 |
| [python-pro](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/python-pro.md) | Python 生态系统大师 |
| [rust-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/rust-engineer.md) | 系统编程专家 |
| [golang-pro](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/golang-pro.md) | Go 并发专家 |
| [java-architect](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/java-architect.md) | 企业级 Java 专家 |
| [javascript-pro](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/javascript-pro.md) | JavaScript 开发专家 |
| [react-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/react-expert.md) | React 18+ 现代模式专家 |
| [vue-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/vue-expert.md) | Vue 3 Composition API 专家 |
| [angular-architect](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/angular-architect.md) | Angular 15+ 企业模式专家 |
| [nextjs-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/nextjs-developer.md) | Next.js 14+ 全栈专家 |
| [swift-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/swift-expert.md) | iOS 和 macOS 专家 |
| [kotlin-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/kotlin-expert.md) | 现代 JVM 语言专家 |
| [cpp-pro](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/cpp-pro.md) | C++ 性能专家 |
| [csharp-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/csharp-developer.md) | .NET 生态系统专家 |
| [php-pro](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/php-pro.md) | PHP Web 开发专家 |
| [sql-pro](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/sql-pro.md) | 数据库查询专家 |
| [django-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/django-developer.md) | Django 4+ Web 开发专家 |
| [laravel-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/laravel-expert.md) | Laravel 10+ PHP 框架专家 |
| [rails-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/rails-expert.md) | Rails 8.1 快速开发专家 |
| [spring-boot-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/spring-boot-engineer.md) | Spring Boot 3+ 微服务专家 |
| [flutter-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/flutter-expert.md) | Flutter 3+ 跨平台移动开发专家 |
| [elixir-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/elixir-expert.md) | Elixir 和 OTP 容错系统专家 |
| [dotnet-core-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/dotnet-core-expert.md) | .NET 8 跨平台专家 |
| [dotnet-framework-4.8-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/dotnet-framework-4.8-expert.md) | .NET Framework 传统企业专家 |
| [powershell-5.1-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/powershell-5.1-expert.md) | Windows PowerShell 5.1 自动化专家 |
| [powershell-7-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/02-languages/powershell-7-expert.md) | 跨平台 PowerShell 7+ 自动化专家 |

---

## 3. 基础设施 (Infrastructure)

*插件包：`voltagent-infra`* — 负责 DevOps、云计算和系统部署。

| 代理 | 说明 |
|------|------|
| [cloud-architect](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/cloud-architect.md) | AWS/GCP/Azure 专家 |
| [devops-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/devops-engineer.md) | CI/CD 和自动化专家 |
| [kubernetes-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/kubernetes-expert.md) | 容器编排大师 |
| [terraform-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/terraform-engineer.md) | 基础设施即代码专家 |
| [database-admin](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/database-admin.md) | 数据库管理专家 |
| [sre](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/sre.md) | 站点可靠性工程专家 |
| [deployment-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/deployment-engineer.md) | 部署自动化专家 |
| [azure-infra-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/azure-infra-engineer.md) | Azure 基础架构专家 |
| [network-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/network-engineer.md) | 网络基础设施专家 |
| [platform-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/platform-engineer.md) | 平台架构专家 |
| [security-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/security-engineer.md) | 基础设施安全专家 |
| [incident-responder](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/incident-responder.md) | 系统事件响应专家 |
| [devops-incident-responder](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/devops-incident-responder.md) | DevOps 事件管理 |
| [windows-infra-admin](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/03-infrastructure/windows-infra-admin.md) | AD、DNS、DHCP 和 GPO 自动化专家 |

---

## 4. 质量与安全 (Quality & Security)

*插件包：`voltagent-qa-sec`* — 负责测试、安全审计和代码质量保证。

| 代理 | 说明 |
|------|------|
| [code-reviewer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/code-reviewer.md) | 代码质量守护者 |
| [security-auditor](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/security-auditor.md) | 安全漏洞专家 |
| [qa-automation-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/qa-automation-engineer.md) | 测试自动化专家 |
| [performance-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/performance-engineer.md) | 性能优化专家 |
| [debugging-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/debugging-expert.md) | 高级调试专家 |
| [error-detective](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/error-detective.md) | 错误分析和解决专家 |
| [penetration-tester](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/penetration-tester.md) | 道德黑客专家 |
| [architecture-reviewer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/architecture-reviewer.md) | 架构评审专家 |
| [accessibility-tester](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/accessibility-tester.md) | A11y 合规专家 |
| [chaos-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/chaos-engineer.md) | 系统弹性测试专家 |
| [compliance-auditor](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/compliance-auditor.md) | 监管合规专家 |
| [testing-automation-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/testing-automation-expert.md) | 测试自动化框架专家 |
| [ad-security-auditor](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/ad-security-auditor.md) | Active Directory 安全审核专家 |
| [powershell-security-hardener](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/04-qa-security/powershell-security-hardener.md) | PowerShell 安全加固专家 |

---

## 5. 数据与人工智能 (Data & AI)

*插件包：`voltagent-data-ai`* — 数据工程、机器学习和 AI 专家。

| 代理 | 说明 |
|------|------|
| [ai-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/ai-engineer.md) | 人工智能系统设计与部署专家 |
| [llm-architect](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/llm-architect.md) | 大型语言模型架构师 |
| [ml-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/ml-engineer.md) | 机器学习系统专家 |
| [machine-learning-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/machine-learning-engineer.md) | 机器学习专家 |
| [data-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/data-engineer.md) | 数据管道架构师 |
| [data-scientist](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/data-scientist.md) | 分析和洞察专家 |
| [data-analyst](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/data-analyst.md) | 数据洞察与可视化专家 |
| [database-optimizer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/database-optimizer.md) | 数据库优化专家 |
| [postgres-pro](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/postgres-pro.md) | PostgreSQL 数据库专家 |
| [mlops-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/mlops-engineer.md) | MLOps 和模型部署专家 |
| [nlp-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/nlp-engineer.md) | 自然语言处理工程师 |
| [prompt-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/05-data-ai/prompt-engineer.md) | 提示优化专家 |

---

## 6. 开发者体验 (Developer Experience)

*插件包：`voltagent-dev-exp`* — 提升开发效率、工具链和文档。

| 代理 | 说明 |
|------|------|
| [refactoring-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/refactoring-expert.md) | 代码重构专家 |
| [documentation-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/documentation-engineer.md) | 技术文档专家 |
| [git-workflow-manager](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/git-workflow-manager.md) | Git 工作流和分支专家 |
| [legacy-code-modernizer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/legacy-code-modernizer.md) | 遗留代码现代化专家 |
| [mcp-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/mcp-developer.md) | 模型上下文协议专家 |
| [build-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/build-engineer.md) | 构建系统专家 |
| [cli-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/cli-developer.md) | 命令行工具创建器 |
| [dependency-manager](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/dependency-manager.md) | 软件包和依赖项专家 |
| [dx-optimizer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/dx-optimizer.md) | 开发者体验优化专家 |
| [tooling-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/tooling-engineer.md) | 开发工具专家 |
| [slack-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/slack-expert.md) | Slack 平台和 @slack/bolt 专家 |
| [powershell-ui-architect](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/powershell-ui-architect.md) | PowerShell UI/UX 专家 |
| [powershell-module-architect](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/06-dev-experience/powershell-module-architect.md) | PowerShell 模块架构专家 |

---

## 7. 专业领域 (Specialized Domains)

*插件包：`voltagent-domains`* — 特定垂直领域技术专家。

| 代理 | 说明 |
|------|------|
| [blockchain-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/blockchain-developer.md) | Web3 和加密货币专家 |
| [game-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/game-developer.md) | 游戏开发专家 |
| [fintech-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/fintech-engineer.md) | 金融科技专家 |
| [iot-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/iot-engineer.md) | 物联网系统开发人员 |
| [embedded-systems-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/embedded-systems-engineer.md) | 嵌入式和实时系统专家 |
| [api-documenter](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/api-documenter.md) | API 文档专家 |
| [seo-specialist](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/seo-specialist.md) | 搜索引擎优化专家 |
| [mobile-app-developer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/mobile-app-developer.md) | 移动应用专家 |
| [payment-integration-specialist](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/payment-integration-specialist.md) | 支付系统专家 |
| [quantitative-analyst](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/quantitative-analyst.md) | 量化分析专家 |
| [risk-manager](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/risk-manager.md) | 风险评估和管理专家 |
| [m365-admin](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/07-specialized-domains/m365-admin.md) | Microsoft 365 管理专家 |

---

## 8. 业务与产品 (Business & Product)

*插件包：`voltagent-biz`* — 产品管理、业务分析和敏捷流程。

| 代理 | 说明 |
|------|------|
| [product-manager](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/product-manager.md) | 产品战略专家 |
| [business-analyst](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/business-analyst.md) | 需求专家 |
| [project-manager](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/project-manager.md) | 项目管理专家 |
| [scrum-master](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/scrum-master.md) | 敏捷方法论专家 |
| [technical-writer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/technical-writer.md) | 技术文档专家 |
| [ux-researcher](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/ux-researcher.md) | 用户研究专家 |
| [customer-success-manager](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/customer-success-manager.md) | 客户成功专家 |
| [sales-engineer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/sales-engineer.md) | 技术销售专家 |
| [legal-advisor](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/legal-advisor.md) | 法律和合规专家 |
| [content-marketing-specialist](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/08-business-product/content-marketing-specialist.md) | 内容营销专家 |

---

## 9. 元数据与编排 (Meta & Orchestration)

*插件包：`voltagent-meta`* — 负责代理之间的协调、任务分配和管理。

| 代理 | 说明 |
|------|------|
| [multi-agent-coordinator](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/multi-agent-coordinator.md) | 高级多智能体编排 |
| [workflow-orchestrator](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/workflow-orchestrator.md) | 复杂工作流自动化 |
| [agent-organizer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/agent-organizer.md) | 多代理协调器 |
| [agent-installer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/agent-installer.md) | 通过 GitHub 浏览并安装代理程序 |
| [context-manager](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/context-manager.md) | 上下文优化专家 |
| [task-dispatcher](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/task-dispatcher.md) | 任务分配专家 |
| [error-coordinator](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/error-coordinator.md) | 错误处理和恢复专家 |
| [performance-monitor](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/performance-monitor.md) | 代理性能优化 |
| [knowledge-synthesizer](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/knowledge-synthesizer.md) | 知识聚合专家 |
| [it-ops-orchestrator](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/it-ops-orchestrator.md) | IT 运维工作流编排专家 |
| [pied-piper](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/pied-piper.md) | SDLC 工作流 AI 子代理团队协调 |

---

## 10. 研究与分析 (Research & Analysis)

*插件包：`voltagent-research`* — 负责搜索、市场调研和数据分析。

| 代理 | 说明 |
|------|------|
| [research-analyst](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/10-research-analysis/research-analyst.md) | 综合研究专家 |
| [competitive-analyst](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/10-research-analysis/competitive-analyst.md) | 竞争情报专家 |
| [market-researcher](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/10-research-analysis/market-researcher.md) | 市场分析和消费者洞察 |
| [search-expert](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/10-research-analysis/search-expert.md) | 高级信息检索专家 |
| [trend-analyst](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/10-research-analysis/trend-analyst.md) | 新兴趋势和预测专家 |
| [data-researcher](https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/10-research-analysis/data-researcher.md) | 数据发现与分析专家 |

---

> **下一步学习**：想深入了解如何自定义代理定义文件？请参考 [07-Skills定制完整指南](./07-Skills定制完整指南.md) 中关于 Agent 配置的部分。
