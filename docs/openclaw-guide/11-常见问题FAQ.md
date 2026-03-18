# 11. 常见问题 (FAQ)

> 🟢 **难度：入门** | 📋 前置知识：无
>
> **遇到问题？** 这里收集了社区最常见的问题和解决方案。用 `Ctrl+F`（或 `Cmd+F`）搜索关键词，快速定位你的问题
>
> **最常见的 5 个问题：** [Q1: 命令找不到](#q1-openclaw-命令找不到command-not-found) | [Q2: Node.js 版本不兼容](#q2-nodejs-版本不兼容) | [Q3: API Key 无效](#q3-api-key-配置后仍然报错) | [Q5: Gateway 启动失败](#q5-gateway-启动失败) | [Q8: WhatsApp 连接问题](#q8-whatsapp-连接失败)

这篇 FAQ 收集了 OpenClaw 社区中最常见的问题和解决方案。按类别组织，方便你快速定位问题。

如果这里没有你遇到的问题，可以到 [GitHub Issues](https://github.com/openclaw/openclaw/issues) 提问，或加入 Discord 社区寻求帮助。

---

## 一、安装和配置问题

> 📌 **本节包含 15 个问题：**
> [Q1: 命令找不到](#q1-openclaw-命令找不到command-not-found) | [Q2: Node.js 版本不兼容](#q2-nodejs-版本不兼容) | [Q3: npm 权限错误](#q3-npm-install-报权限错误eacces) | [Q4: 中国网络安装慢](#q4-中国网络环境安装慢或失败) | [Q5: node-gyp 编译错误](#q5-安装时报-node-gyp-编译错误) | [Q6: onboard 报错](#q6-openclaw-onboard-引导向导报错) | [Q7: 配置文件位置](#q7-配置文件在哪里怎么手动编辑) | [Q8: 多 API Key 配置](#q8-多个-api-key-怎么配置) | [Q9: 配置优先级](#q9-环境变量和配置文件哪个优先) | [Q10: 升级后配置丢失](#q10-升级-openclaw-后配置丢失了) | [Q11: 版本回滚](#q11-升级后功能异常怎么回滚) | [Q12: Windows Gateway 失败](#q12-windows-上安装后-gateway-启动失败) | [Q13: macOS 安全提示](#q13-macos-上安装提示无法验证开发者) | [Q14: 端口被占用](#q14-安装完成但-openclaw-gateway-start-提示端口被占用) | [Q15: 完全卸载](#q15-怎么完全卸载-openclaw)

### Q1: `openclaw` 命令找不到（command not found）

**现象：** 安装完成后执行 `openclaw` 提示 `command not found` 或 `不是内部或外部命令`。

**原因：** npm 全局安装的 bin 目录没有加入系统 PATH 环境变量。

**解决方案：**

```bash
# 第一步：确认是否真的安装了
npm list -g openclaw

# 第二步：找到 npm 全局 bin 目录
npm config get prefix
# 输出类似 /usr/local 或 /home/user/.npm-global

# 第三步：把 bin 目录加入 PATH
# Linux / macOS
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Windows PowerShell
# 把 npm prefix 路径加到系统环境变量 Path 中
# 或者直接用 npx openclaw 代替
npx openclaw --version
```

如果你用的是 `pnpm`，全局 bin 路径不同：

```bash
pnpm config get global-bin-dir
# 把输出的路径加入 PATH
```

### Q2: Node.js 版本不兼容

**现象：** 安装时报错 `engine "node" is incompatible` 或运行时出现语法错误。

**原因：** OpenClaw 要求 Node.js >= 22.12.0。低版本缺少必要的 API 支持。

**解决方案：**

```bash
# 检查当前版本
node --version

# 如果低于 v22，用 nvm 升级
# 安装 nvm（如果还没装）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash

# 重新打开终端，然后：
nvm install 22
nvm use 22
nvm alias default 22  # 设为默认版本

# 验证
node --version  # 应该显示 v22.x.x
```

Windows 用户推荐用 [nvm-windows](https://github.com/coreybutler/nvm-windows)：

```powershell
nvm install 22
nvm use 22
```

### Q3: npm install 报权限错误（EACCES）

**现象：** `npm install -g openclaw` 时报 `EACCES: permission denied`。

**原因：** npm 全局目录的权限不对，当前用户没有写入权限。

**解决方案：**

```bash
# 方案一：修改 npm 全局目录（推荐）
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH="~/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
npm install -g openclaw

# 方案二：用 sudo（不推荐，但能快速解决）
sudo npm install -g openclaw

# 方案三：用 nvm 管理 Node.js（最佳实践）
# nvm 安装的 Node.js 不需要 sudo
```

### Q4: 中国网络环境安装慢或失败

**现象：** `npm install` 卡住不动，或者下载速度极慢，最终超时失败。

**原因：** npm 默认从 `registry.npmjs.org` 下载，国内访问速度不稳定。

**解决方案：**

```bash
# 方案一：临时使用镜像（推荐）
npm install -g openclaw --registry=https://registry.npmmirror.com

# 方案二：永久切换镜像
npm config set registry https://registry.npmmirror.com
npm install -g openclaw

# 方案三：使用 cnpm
npm install -g cnpm --registry=https://registry.npmmirror.com
cnpm install -g openclaw

# 验证镜像是否生效
npm config get registry
```

如果连 npm 镜像都访问不了，可以考虑 Docker 安装方式，提前拉取镜像：

```bash
# 使用 Docker Hub 镜像加速
docker pull openclaw/openclaw:latest
```

### Q5: 安装时报 `node-gyp` 编译错误

**现象：** 安装过程中出现 `gyp ERR!` 或 `node-gyp rebuild` 失败。

**原因：** 某些依赖包含原生 C++ 模块，需要编译工具链。

**解决方案：**

```bash
# Linux (Ubuntu/Debian)
sudo apt-get install -y build-essential python3

# macOS
xcode-select --install

# Windows
# 以管理员身份运行 PowerShell
npm install -g windows-build-tools
# 或者安装 Visual Studio Build Tools
```

### Q6: `openclaw onboard` 引导向导报错

**现象：** 运行 `openclaw onboard` 后，终端卡在某一步不动了（光标闪烁但没有输出），或者直接报错退出并显示 `Error: network timeout` 或 `TypeError: Cannot read properties of undefined`。

**原因：** 可能是终端不支持交互式输入，或者网络问题导致无法验证 API Key。

**解决方案：**

```bash
# 方案一：确保用的是交互式终端（不是 IDE 内置终端）
# 打开系统自带的终端应用

# 方案二：跳过引导，手动配置
openclaw config set providers.openai.apiKey "sk-proj-xxxxx"
openclaw config set providers.openai.model "gpt-5.2"
openclaw gateway start

# 方案三：检查配置文件是否损坏
cat ~/.openclaw/openclaw.json
# 如果内容异常，删除后重新引导
rm ~/.openclaw/openclaw.json
openclaw onboard
```

### Q7: 配置文件在哪里？怎么手动编辑？

**现象：** 想直接编辑配置文件，但不知道在哪。

**说明：** OpenClaw 的所有配置都在 `~/.openclaw/` 目录下。

```bash
# 查看配置目录结构
ls -la ~/.openclaw/

# 主要文件：
# ~/.openclaw/openclaw.json    — 主配置文件（JSON5 格式）
# ~/.openclaw/workspace/      — 工作空间（记忆、技能等）
# ~/.openclaw/gateway/        — Gateway 运行时数据

# 用命令查看当前配置
openclaw config get

# 用命令修改配置（推荐，会自动验证格式）
openclaw config set <key> <value>

# 也可以直接编辑 JSON5 文件
nano ~/.openclaw/openclaw.json
```

### Q8: 多个 API Key 怎么配置？

**现象：** 想同时配置 OpenAI 和 Anthropic 的 Key，不知道怎么操作。

**解决方案：**

```bash
# 分别配置不同提供商的 Key
openclaw config set providers.openai.apiKey "sk-proj-xxxxx"
openclaw config set providers.anthropic.apiKey "sk-ant-xxxxx"
openclaw config set providers.google.apiKey "AIzaSy-xxxxx"

# 设置默认模型
openclaw config set defaultModel "openai:gpt-5.2"

# 也可以通过环境变量配置（优先级高于配置文件）
export OPENAI_API_KEY="sk-proj-xxxxx"
export ANTHROPIC_API_KEY="sk-ant-xxxxx"
```

### Q9: 环境变量和配置文件哪个优先？

**说明：** 优先级从高到低：

```
命令行参数 > 环境变量 > ~/.openclaw/openclaw.json > 默认值
```

也就是说，如果你同时在环境变量和配置文件里设了 API Key，环境变量的值会生效。

### Q10: 升级 OpenClaw 后配置丢失了

**现象：** 更新到新版本后，之前的配置好像不见了。

**原因：** 正常情况下升级不会覆盖配置。但如果你用 Docker 部署且没有挂载数据卷，容器重建后数据会丢失。

**解决方案：**

```bash
# 升级前先备份
cp -r ~/.openclaw ~/.openclaw.backup

# npm 升级（配置不会丢）
npm update -g openclaw

# Docker 升级（确保挂载了数据卷）
# docker-compose.yml 中必须有：
# volumes:
#   - ./data:/root/.openclaw

# 如果配置真的丢了，从备份恢复
cp -r ~/.openclaw.backup ~/.openclaw
```

### Q11: 升级后功能异常怎么回滚？

**现象：** 执行 `npm update -g openclaw` 升级到新版本后，之前正常的功能出现报错、崩溃或行为异常，需要退回旧版本。

**解决方案：**

```bash
# 查看当前版本
openclaw --version

# 查看所有可用版本
npm view openclaw versions --json

# 回滚到指定版本
npm install -g openclaw@2026.1.0

# Docker 回滚
docker pull openclaw/openclaw:2026.1.0
# 修改 docker-compose.yml 中的 image tag 后重启
```

### Q12: Windows 上安装后 Gateway 启动失败

**现象：** Windows 上执行 `openclaw gateway start` 后，终端窗口闪一下就关闭了（闪退），或者报错 `EADDRINUSE`、`EACCES` 等错误信息，Gateway 无法正常启动。

**原因：** Windows 的端口占用、防火墙或 WSL 兼容性问题。

**解决方案：**

```powershell
# 检查端口是否被占用
netstat -an | findstr 18789

# 如果被占用，换一个端口
openclaw config set gateway.port 18790

# 检查防火墙是否放行
# Windows Defender 防火墙 → 高级设置 → 入站规则 → 新建规则 → 端口 18789

# 推荐：在 WSL2 中运行 OpenClaw
wsl --install
# 在 WSL 中按 Linux 方式安装
```

### Q13: macOS 上安装提示"无法验证开发者"

**现象：** macOS 上首次运行 `openclaw` 命令时，系统弹出对话框提示「无法验证开发者」或「无法打开，因为 Apple 无法检查其是否包含恶意软件」，命令被阻止执行。

**解决方案：**

```bash
# 方案一：在系统偏好设置中允许
# 系统偏好设置 → 隐私与安全性 → 仍然允许

# 方案二：通过命令行移除隔离属性
xattr -d com.apple.quarantine $(which openclaw)
```

### Q14: 安装完成但 `openclaw gateway start` 提示端口被占用

**现象：** 报错 `EADDRINUSE: address already in use :::18789`。

**原因：** 端口 18789 已经被其他进程占用，或者上一次 Gateway 没有正常关闭。

**解决方案：**

```bash
# 找到占用端口的进程
# Linux / macOS
lsof -i :18789
# 记下 PID，然后 kill
kill -9 <PID>

# Windows
netstat -ano | findstr 18789
taskkill /PID <PID> /F

# 或者换一个端口
openclaw config set gateway.port 18790
openclaw gateway start
```

### Q15: 怎么完全卸载 OpenClaw？

**现象：** 不再使用 OpenClaw，想彻底从系统中移除所有相关文件（包括程序、配置和数据）。

**解决方案：**

```bash
# 停止 Gateway
openclaw gateway stop

# 卸载 npm 包
npm uninstall -g openclaw

# 删除配置和数据（谨慎操作，不可恢复）
rm -rf ~/.openclaw

# Docker 方式
docker compose down -v
docker rmi openclaw/openclaw:latest
```

---

## 二、消息平台问题

> 📌 **本节包含 10 个问题：**
> [Q16: WhatsApp 频繁断开](#q16-whatsapp-扫码后频繁断开) | [Q17: Telegram Bot 不响应](#q17-telegram-bot-不响应消息) | [Q18: Telegram 群组不回复](#q18-telegram-bot-在群组中不回复) | [Q19: Discord Bot 无法加入](#q19-discord-bot-无法加入服务器) | [Q20: 消息延迟严重](#q20-消息延迟严重发了好久才回复) | [Q21: rate limited](#q21-消息发送失败提示-rate-limited) | [Q22: 飞书收不到消息](#q22-飞书feishulark接入后收不到消息) | [Q23: 控制面板打不开](#q23-控制面板dashboard打不开) | [Q24: 多账号接入](#q24-同一个平台能接入多个账号吗) | [Q25: 图片文件处理](#q25-消息中的图片文件-ai-能处理吗)

### Q16: WhatsApp 扫码后频繁断开

**现象：** 扫码配对成功，但过一会儿就断开，需要反复扫码。

**原因：** WhatsApp Web 协议要求手机端保持在线。如果手机网络不稳定或 WhatsApp 应用被系统杀后台，连接就会断。

**解决方案：**

```bash
# 第一步：把 Gateway 安装为系统服务，保持持续运行
openclaw daemon

# 第二步：检查连接状态
openclaw channels status whatsapp

# 第三步：如果断开了，重新连接
openclaw channels logout whatsapp
openclaw channels login whatsapp

# 第四步：查看断开原因
openclaw logs --filter whatsapp --tail 50
```

其他注意事项：
- 确保手机上的 WhatsApp 没有被省电模式限制后台运行
- 一个 WhatsApp 账号只能同时连接一个 Web 客户端，如果你在浏览器里也开了 WhatsApp Web，会冲突
- 建议用一个专门的手机号来跑 OpenClaw

### Q17: Telegram Bot 不响应消息

**现象：** 给 Telegram Bot 发消息，没有任何回复。

**原因：** 可能是 Bot Token 配置错误、Bot 没有接收消息的权限、或者 Gateway 没有正常运行。

**解决方案：**

```bash
# 第一步：确认 Gateway 在运行
openclaw status

# 第二步：确认 Bot Token 正确
openclaw config get channels.telegram.botToken
# 去 @BotFather 核对 Token 是否一致

# 第三步：确认 Bot 的隐私模式
# 在 @BotFather 中：
# /mybots → 选择你的 Bot → Bot Settings → Group Privacy → Turn off
# 关闭隐私模式后，Bot 才能接收群组中的所有消息

# 第四步：检查日志
openclaw logs --filter telegram --tail 50

# 第五步：重新连接
openclaw channels logout telegram
openclaw channels login telegram
```

### Q18: Telegram Bot 在群组中不回复

**现象：** Bot 在私聊中正常回复，但在群组中不响应。

**原因：** Telegram Bot 默认开启隐私模式，在群组中只能收到 @提及 和 /命令。

**解决方案：**

1. 在 @BotFather 中关闭隐私模式（见 Q17）
2. 或者在群组中 @提及 Bot 来触发回复
3. 配置群组触发规则：

```json5
{
  "channels": {
    "telegram": {
      "groupBehavior": {
        "triggerOnMention": true,
        "triggerOnReply": true,
        "triggerOnKeyword": ["AI", "助手"]
      }
    }
  }
}
```

### Q19: Discord Bot 无法加入服务器

**现象：** 用邀请链接添加 Bot 时报错 `Missing Permissions`。

**原因：** Bot 的 OAuth2 权限配置不完整。

**解决方案：**

1. 去 [Discord Developer Portal](https://discord.com/developers/applications)
2. 选择你的应用 → OAuth2 → URL Generator
3. 勾选以下权限：
   - `bot`
   - `applications.commands`
   - `Send Messages`
   - `Read Message History`
   - `Embed Links`
   - `Attach Files`
4. 用生成的新链接重新邀请 Bot

```bash
# 配置 Discord Bot Token
openclaw config set channels.discord.botToken "your-discord-bot-token"
openclaw channels logout discord
openclaw channels login discord
```

### Q20: 消息延迟严重（发了好久才回复）

**现象：** 发消息后要等 10 秒甚至更久才收到回复。

**原因：** 延迟可能来自多个环节 — 网络、模型 API 响应时间、消息队列积压。

**解决方案：**

```bash
# 第一步：排查是哪个环节慢
openclaw logs --tail 20
# 看日志中的时间戳，判断延迟发生在哪里

# 第二步：测试模型 API 延迟
openclaw health
# 如果 API 延迟高，考虑换模型或换提供商

# 第三步：检查是否有消息积压
openclaw sessions list

# 第四步：优化措施
# 使用更快的模型
openclaw config set defaultModel "openai:gpt-5.2-mini"
# 启用流式响应
openclaw config set streaming.enabled true
# 减少系统提示词长度（Token 越少，响应越快）
```

### Q21: 消息发送失败，提示 "rate limited"

**现象：** 发消息时报错 `429 Too Many Requests` 或 `rate limited`。

**原因：** 消息平台有发送频率限制。WhatsApp 尤其严格，短时间内发太多消息会被限流。

**解决方案：**

```bash
# 配置消息发送速率限制
openclaw config set rateLimit.messagesPerMinute 20
openclaw config set rateLimit.messagesPerHour 200

# 启用消息队列（自动排队，避免触发限流）
openclaw config set queue.enabled true
openclaw config set queue.delayMs 1000  # 每条消息间隔 1 秒
```

### Q22: 飞书（Feishu/Lark）接入后收不到消息

**现象：** 飞书 Bot 配置完成，但收不到用户消息。

**原因：** 飞书的事件订阅配置不完整，或者回调地址不可达。

**解决方案：**

```bash
# 第一步：确认 Gateway 的公网地址可达
curl https://your-domain.com:18789/health

# 第二步：在飞书开放平台配置事件订阅
# 事件订阅 URL：https://your-domain.com:18789/webhook/feishu
# 需要订阅的事件：im.message.receive_v1

# 第三步：检查日志
openclaw logs --filter feishu --tail 50

# 第四步：确认 Bot 权限
# 飞书开放平台 → 应用权限 → 确保开启了：
# - 获取与发送单聊、群组消息
# - 读取用户信息
```

### Q23: 控制面板（Dashboard）打不开

**现象：** 浏览器访问 `http://localhost:18789` 显示无法连接。

**原因：** Gateway 没有运行，或者端口被防火墙拦截。

**解决方案：**

```bash
# 第一步：确认 Gateway 在运行
openclaw status

# 如果没运行，启动它
openclaw gateway start

# 第二步：检查端口
# Linux / macOS
lsof -i :18789
# Windows
netstat -an | findstr 18789

# 第三步：如果是远程服务器，检查防火墙
# Ubuntu
sudo ufw allow 18789
# CentOS
sudo firewall-cmd --add-port=18789/tcp --permanent
sudo firewall-cmd --reload

# 第四步：重启 Gateway
openclaw gateway restart
```

### Q24: 同一个平台能接入多个账号吗？

**说明：** 可以。OpenClaw 支持同一平台的多个 Channel 实例。

```bash
# 添加第二个 WhatsApp 账号
openclaw channels add whatsapp --name "work-whatsapp"
openclaw channels add whatsapp --name "personal-whatsapp"

# 查看所有 Channel
openclaw channels list
```

每个 Channel 独立运行，有自己的配对状态和消息队列。

### Q25: 消息中的图片/文件 AI 能处理吗？

**说明：** 取决于你使用的模型。支持多模态的模型（如 GPT-5.2、Claude Sonnet 4.6）可以处理图片。

```bash
# 启用多模态支持
openclaw config set multimodal.enabled true

# 配置文件处理
openclaw config set multimodal.maxFileSize "10MB"
openclaw config set multimodal.supportedTypes '["image/png","image/jpeg","application/pdf"]'
```

不支持多模态的模型收到图片时，会提示用户发送文字。

---

## 三、模型和 AI 问题

> 📌 **本节包含 10 个问题：**
> [Q26: API 401 报错](#q26-api-调用报错-401-unauthorized) | [Q27: API 429 限流](#q27-报错-429-too-many-requestsapi-限流) | [Q28: 模型回复慢](#q28-模型回复很慢) | [Q29: Token 超限](#q29-token-超限报错context-length-exceeded) | [Q30: Ollama 连不上](#q30-ollama-本地模型连不上) | [Q31: 本地模型质量差](#q31-本地模型回复质量差) | [Q32: 国产模型配置](#q32-怎么使用国产模型通义千问kimi智谱等) | [Q33: 模型故障转移](#q33-怎么配置模型故障转移fallback) | [Q34: 控制 API 费用](#q34-api-费用太高怎么控制成本) | [Q35: 不同对话用不同模型](#q35-怎么让不同的对话用不同的模型)

### Q26: API 调用报错 401 Unauthorized

**现象：** 发消息后 AI 不回复，日志中出现 `401 Unauthorized` 或 `Invalid API Key`。

**原因：** API Key 无效、过期、或者余额不足。

**解决方案：**

```bash
# 第一步：检查 Key 是否配置正确
openclaw config get providers.openai.apiKey
# 确认 Key 没有多余的空格或换行

# 第二步：测试 Key 是否有效
openclaw health
# 如果报错，说明 Key 有问题

# 第三步：去提供商后台检查
# OpenAI: https://platform.openai.com/account/api-keys
# Anthropic: https://console.anthropic.com/settings/keys
# 确认 Key 没有被撤销，账户余额充足

# 第四步：重新设置 Key
openclaw config set providers.openai.apiKey "sk-proj-new-key-here"
openclaw gateway restart
```

### Q27: 报错 429 Too Many Requests（API 限流）

**现象：** 高频使用时出现 `429` 错误，AI 间歇性不回复。

**原因：** 超过了模型提供商的 API 调用频率限制（RPM/TPM）。

**解决方案：**

```bash
# 方案一：启用模型故障转移（推荐）
# 主模型被限流时自动切换到备用模型
openclaw config set fallback.enabled true
openclaw config set fallback.models '["openai:gpt-5.2","anthropic:claude-sonnet-4-20250514","openai:gpt-5.2-mini"]'

# 方案二：配置请求重试
openclaw config set retry.maxRetries 3
openclaw config set retry.retryDelay 2000  # 毫秒

# 方案三：使用 OpenRouter（聚合多个提供商，限流更宽松）
openclaw config set providers.openrouter.apiKey "sk-or-xxxxx"
openclaw config set defaultModel "openrouter:openai/gpt-5.2"
```

### Q28: 模型回复很慢

**现象：** 发送消息后，AI 要等 10-30 秒甚至更久才开始回复。在终端日志中可以看到请求已发出，但响应迟迟不返回。

**原因：** 大模型本身推理就需要时间，加上网络延迟，响应时间会更长。

**解决方案：**

```bash
# 方案一：换用更快的小模型
openclaw config set defaultModel "openai:gpt-5.2-mini"
# gpt-5.2-mini 速度是 gpt-5.2 的 3-5 倍，日常对话足够用

# 方案二：启用流式响应（边生成边发送）
openclaw config set streaming.enabled true

# 方案三：减少系统提示词长度
# 检查当前提示词 Token 数
openclaw agents list
# 精简不必要的指令

# 方案四：使用本地模型（延迟最低）
ollama pull llama3.1:8b
openclaw config set providers.ollama.baseUrl "http://127.0.0.1:11434"
openclaw config set defaultModel "ollama:llama3.1:8b"

# 方案五：检查网络延迟
ping api.openai.com
# 如果延迟高，考虑使用代理或换区域更近的提供商
```

### Q29: Token 超限报错（context length exceeded）

**现象：** 对话到一定长度后报错 `maximum context length exceeded` 或 `token limit`。

**原因：** 每个模型都有上下文窗口限制。对话历史 + 系统提示 + 记忆文件的总 Token 数超过了模型限制。

**解决方案：**

```bash
# 查看当前会话的 Token 使用情况
openclaw sessions list

# 方案一：配置自动截断（保留最近的对话）
openclaw config set context.maxTokens 8000
openclaw config set context.strategy "sliding-window"

# 方案二：使用上下文窗口更大的模型
# GPT-5.2: 1M tokens
# Claude Sonnet 4.6: 200K tokens
# Gemini 1.5 Pro: 1M tokens
openclaw config set defaultModel "anthropic:claude-sonnet-4-20250514"

# 方案三：手动清理会话
openclaw sessions cleanup
# 或让 AI 总结后开新会话
```

### Q30: Ollama 本地模型连不上

**现象：** 配置了 Ollama 但 OpenClaw 报错 `ECONNREFUSED` 或 `connection refused`。

**原因：** Ollama 服务没有启动，或者监听地址配置不对。

**解决方案：**

```bash
# 第一步：确认 Ollama 在运行
ollama serve
# 或者检查是否已经在后台运行
curl http://127.0.0.1:11434/api/tags

# 第二步：确认有可用的模型
ollama list
# 如果没有模型，先拉一个
ollama pull llama3.1:8b

# 第三步：配置 OpenClaw 连接 Ollama
openclaw config set providers.ollama.baseUrl "http://127.0.0.1:11434"
openclaw config set defaultModel "ollama:llama3.1:8b"

# 第四步：如果 Ollama 和 OpenClaw 不在同一台机器
# 需要让 Ollama 监听所有网卡
OLLAMA_HOST=0.0.0.0 ollama serve
# 然后配置远程地址
openclaw config set providers.ollama.baseUrl "http://192.168.1.100:11434"
```

### Q31: 本地模型回复质量差

**现象：** 用 Ollama 跑本地模型，回复经常答非所问或质量很低。

**原因：** 小参数模型的能力有限，尤其是中文能力。

**解决方案：**

```bash
# 方案一：换用更大的模型（需要更多内存/显存）
ollama pull llama3.1:70b    # 需要 64GB+ 内存
ollama pull qwen2.5:14b     # 中文能力更好

# 方案二：调整模型参数
openclaw config set modelParams.temperature 0.7  # 降低随机性
openclaw config set modelParams.topP 0.9

# 方案三：优化系统提示词
# 本地小模型对提示词更敏感，要写得简洁明确
# 避免复杂的多步骤指令

# 方案四：混合策略 — 简单任务用本地模型，复杂任务用云端
openclaw config set routing.rules '[
  {"condition": "message.length < 100", "model": "ollama:llama3.1:8b"},
  {"condition": "default", "model": "openai:gpt-5.2"}
]'
```

### Q32: 怎么使用国产模型（通义千问、Kimi、智谱等）？

**解决方案：**

```bash
# 通义千问（阿里云）
openclaw config set providers.dashscope.apiKey "sk-xxxxx"
openclaw config set defaultModel "dashscope:qwen-max"

# Moonshot / Kimi
openclaw config set providers.moonshot.apiKey "sk-xxxxx"
openclaw config set defaultModel "moonshot:moonshot-v1-8k"

# 智谱 GLM
openclaw config set providers.zhipu.apiKey "xxxxx.xxxxx"
openclaw config set defaultModel "zhipu:glm-4"

# DeepSeek
openclaw config set providers.deepseek.apiKey "sk-xxxxx"
openclaw config set defaultModel "deepseek:deepseek-chat"
```

国产模型的优势：不需要代理、中文能力强、价格便宜。推荐中国用户优先考虑。

### Q33: 怎么配置模型故障转移（Fallback）？

**说明：** 当主模型不可用时，自动切换到备用模型，保证服务不中断。

```bash
# 配置 Fallback 链
openclaw config set fallback.enabled true
openclaw config set fallback.models '[
  "openai:gpt-5.2",
  "anthropic:claude-sonnet-4-20250514",
  "openai:gpt-5.2-mini"
]'

# 配置超时时间（超过这个时间就切换到下一个模型）
openclaw config set fallback.timeoutMs 10000

# 查看 Fallback 状态
openclaw models status
```

### Q34: API 费用太高怎么控制成本？

**解决方案：**

```bash
# 方案一：设置每日/每月预算上限
openclaw config set budget.dailyLimit 5.00   # 美元
openclaw config set budget.monthlyLimit 100.00

# 方案二：使用更便宜的模型
# gpt-5.2-mini 价格是 gpt-5.2 的 1/10
openclaw config set defaultModel "openai:gpt-5.2-mini"

# 方案三：限制上下文长度（减少 Token 消耗）
openclaw config set context.maxTokens 4000

# 方案四：查看系统状态
openclaw status

# 方案五：本地模型零成本
ollama pull llama3.1:8b
openclaw config set defaultModel "ollama:llama3.1:8b"
```

### Q35: 怎么让不同的对话用不同的模型？

**说明：** 可以为不同的 Agent 或 Channel 配置不同的模型。

```bash
# 为特定 Agent 配置模型
openclaw agents set-identity coding-assistant --model "anthropic:claude-sonnet-4-20250514"
openclaw agents set-identity casual-chat --model "openai:gpt-5.2-mini"

# 为特定 Channel 配置模型
openclaw config set channels.telegram.defaultModel "openai:gpt-5.2"
openclaw config set channels.whatsapp.defaultModel "openai:gpt-5.2-mini"
```

---

## 四、技能和工具问题

> 📌 **本节包含 10 个问题：**
> [Q36: 技能不生效](#q36-技能skill不生效ai-不执行) | [Q37: 自定义技能报错](#q37-自定义技能报错) | [Q38: 工具执行失败](#q38-工具tool执行失败) | [Q39: 禁用工具](#q39-怎么禁用某个工具) | [Q40: 添加新工具](#q40-怎么给-ai-添加新工具) | [Q41: 技能中途中断](#q41-技能执行到一半中断了) | [Q42: 查看工具调用](#q42-怎么查看-ai-调用了哪些工具) | [Q43: 内置技能列表](#q43-内置技能列表在哪里看) | [Q44: 技能冲突](#q44-技能之间会冲突吗) | [Q45: 分享技能](#q45-怎么分享自定义技能给别人)

### Q36: 技能（Skill）不生效，AI 不执行

**现象：** 你发消息让 AI 执行某个技能（比如「帮我搜索 xxx」），但 AI 只是用文字回复了一段话，并没有真正调用工具去执行操作。日志中也看不到工具调用记录。

**原因：** 技能没有正确加载，或者触发条件不匹配。

**解决方案：**

```bash
# 第一步：检查技能是否已加载
openclaw skills list
# 确认目标技能在列表中且状态为 enabled

# 第二步：检查技能的触发关键词
openclaw skills info <skill-name>
# 看 triggers 字段，确认你的消息包含触发词

# 第三步：手动触发技能测试
openclaw skills check <skill-name> --input "测试消息"

# 第四步：重新加载技能
openclaw skills list
```

### Q37: 自定义技能报错

**现象：** 在 `~/.openclaw/workspace/skills/` 目录下创建了自定义技能的 `.md` 文件，但执行 `openclaw skills list` 时该技能未出现，或者出现 `skill parse error`、`invalid skill format` 等报错信息。

**原因：** 技能文件格式不对，或者引用了不存在的工具。

**解决方案：**

```bash
# 第一步：检查技能文件格式
openclaw skills check ~/.openclaw/workspace/skills/my-skill.md

# 第二步：确认引用的工具都存在
openclaw skills list
# 对照技能文件中引用的工具名称

# 技能文件的基本格式：
cat ~/.openclaw/workspace/skills/my-skill.md
```

正确的技能文件结构：

```markdown
---
name: my-custom-skill
description: 我的自定义技能
triggers:
  - "帮我做xxx"
  - "执行xxx"
tools:
  - file_read
  - file_write
  - web_search
---

## 指令

当用户要求做 xxx 时，按以下步骤执行：

1. 先搜索相关信息
2. 读取必要的文件
3. 生成结果并写入文件
```

### Q38: 工具（Tool）执行失败

**现象：** AI 回复中显示「正在调用 xxx 工具」，但随后报错 `tool execution failed`、`permission denied` 或 `tool not found`，操作没有完成。

**原因：** 工具缺少必要的权限或依赖。

**解决方案：**

```bash
# 第一步：检查工具状态
openclaw doctor
# 诊断安全和配置问题

# 第二步：测试单个工具
openclaw skills check <skill-name>

# 第三步：检查工具依赖
openclaw skills info <skill-name>
# 看 dependencies 字段，确认依赖都已安装

# 第四步：常见工具问题
# web_search 需要网络连接
# file_write 需要目标目录有写权限
# shell_exec 需要在配置中启用（默认禁用，出于安全考虑）
```

### Q39: 怎么禁用某个工具？

**说明：** 出于安全考虑，你可能想禁用某些危险工具。

```bash
# 禁用单个工具
openclaw config set tools.disabled '["shell_exec", "file_delete"]'

# 或者用白名单模式（只允许指定的工具）
openclaw config set tools.allowlist '["web_search", "file_read", "memory_search"]'

# 查看当前工具权限配置
openclaw config get tools
```

### Q40: 怎么给 AI 添加新工具？

**说明：** OpenClaw 支持通过 MCP（Model Context Protocol）协议接入外部工具。

```bash
# 方案一：使用内置的 MCP 服务器
openclaw plugins

# 方案二：接入第三方 MCP 服务器
# 在 ~/.openclaw/openclaw.json 中配置 MCP 服务器连接

# 方案三：自己写工具（TypeScript）
# 在 ~/.openclaw/workspace/tools/ 下创建工具文件
# 参考文档：https://docs.openclaw.ai/tools/custom
```

### Q41: 技能执行到一半中断了

**现象：** AI 在执行一个多步骤技能时（比如「搜索 → 读取文件 → 生成报告」），执行到中间某一步后突然停下来，不再继续后续步骤，也没有给出完成提示。

**原因：** 可能是 Token 限制导致输出被截断，或者某个中间步骤失败了。

**解决方案：**

```bash
# 第一步：查看会话日志，找到中断点
openclaw logs --tail 30

# 第二步：增加模型输出 Token 限制
openclaw config set modelParams.maxTokens 4096

# 第三步：让 AI 继续
# 直接发消息 "继续" 或 "请继续执行"

# 第四步：如果是工具执行失败导致的中断
openclaw skills check <failed-tool-name>
# 修复工具问题后重试
```

### Q42: 怎么查看 AI 调用了哪些工具？

**解决方案：**

```bash
# 查看最近会话的工具调用记录
openclaw sessions list

# 实时查看工具调用（调试模式）
openclaw logs --follow
# 日志中会显示每次工具调用的详细信息

# 查看系统状态
openclaw status
```

### Q43: 内置技能列表在哪里看？

**解决方案：**

```bash
# 列出所有技能（包括内置技能）
openclaw skills list

# 查看某个技能的详细说明
openclaw skills info <skill-name>
```

### Q44: 技能之间会冲突吗？

**说明：** 如果多个技能的触发条件重叠，可能会出现冲突。OpenClaw 会按优先级选择。

```bash
# 查看技能列表
openclaw skills list

# 查看特定技能的详细信息
openclaw skills info <skill-name>
```

### Q45: 怎么分享自定义技能给别人？

**解决方案：**

```bash
# 查看技能文件
openclaw skills list

# 技能文件位于 ~/.openclaw/workspace/skills/ 目录
# 可以直接复制 .md 文件来分享技能

# 查看社区技能库
# https://github.com/openclaw/openclaw-skills
```

---

## 五、部署和运维问题

> 📌 **本节包含 10 个问题：**
> [Q46: Docker 容器立即退出](#q46-docker-容器启动后立即退出) | [Q47: 容器内存过高](#q47-docker-容器内存占用过高) | [Q48: 数据卷备份](#q48-docker-数据卷怎么备份) | [Q49: 自动重启](#q49-gateway-进程崩溃后怎么自动重启) | [Q50: 查看日志](#q50-日志在哪里看怎么排查问题) | [Q51: 监控运行状态](#q51-怎么监控-openclaw-的运行状态) | [Q52: 磁盘空间清理](#q52-磁盘空间不足怎么清理) | [Q53: 多服务器部署](#q53-怎么在多台服务器上部署) | [Q54: 设置 HTTPS](#q54-怎么设置-https) | [Q55: 自动更新](#q55-怎么配置自动更新)

### Q46: Docker 容器启动后立即退出

**现象：** 执行 `docker compose up -d` 后，运行 `docker ps` 看不到 OpenClaw 容器，用 `docker ps -a` 查看发现容器状态为 `Exited (1)` 或其他非零退出码。

**原因：** 配置文件缺失、端口冲突、或者环境变量没设置。

**解决方案：**

```bash
# 第一步：查看容器退出日志
docker compose logs openclaw

# 第二步：常见原因排查
# 原因 1：配置文件不存在
ls ./data/openclaw.json  # 确认挂载的配置文件存在

# 原因 2：端口被占用
lsof -i :18789
# 如果被占用，修改 docker-compose.yml 中的端口映射

# 原因 3：环境变量缺失
# 确认 .env 文件存在且包含必要变量
cat .env

# 第三步：用前台模式启动，方便看日志
docker compose up  # 不加 -d
```

### Q47: Docker 容器内存占用过高

**现象：** 运行 `docker stats` 发现 OpenClaw 容器的内存使用量持续增长，从几百 MB 涨到好几 GB，甚至导致宿主机变卡或 OOM（Out of Memory）被系统杀掉。

**原因：** 连接了太多平台、会话数据积累、或者存在内存泄漏。

**解决方案：**

```bash
# 查看容器资源使用
docker stats openclaw

# 方案一：限制容器内存
# 在 docker-compose.yml 中添加：
# deploy:
#   resources:
#     limits:
#       memory: 1G

# 方案二：清理会话数据
docker exec openclaw openclaw sessions cleanup

# 方案三：减少同时连接的平台数量

# 方案四：定期重启容器（临时方案）
# 配置 crontab
# 0 4 * * * docker compose restart openclaw
```

### Q48: Docker 数据卷怎么备份？

**解决方案：**

```bash
# 方案一：直接备份挂载目录
tar -czf openclaw-backup-$(date +%Y%m%d).tar.gz ./data/

# 方案二：备份 Docker volume
docker run --rm \
  -v openclaw_data:/source \
  -v $(pwd):/backup \
  alpine tar -czf /backup/openclaw-data.tar.gz -C /source .

# 方案三：自动化备份脚本
# 建议配合 crontab 每天自动备份
# 0 3 * * * /path/to/backup-script.sh
```

### Q49: Gateway 进程崩溃后怎么自动重启？

**解决方案：**

```bash
# 方案一：安装为 systemd 服务（Linux 推荐）
openclaw daemon
# 这会创建 systemd service，崩溃后自动重启

# 查看服务状态
systemctl status openclaw-gateway

# 方案二：Docker 自动重启
# 在 docker-compose.yml 中设置：
# restart: unless-stopped

# 方案三：用 PM2 管理（Node.js 生态）
npm install -g pm2
pm2 start "openclaw gateway start" --name openclaw
pm2 save
pm2 startup  # 开机自启
```

### Q50: 日志在哪里看？怎么排查问题？

**解决方案：**

```bash
# 实时查看 Gateway 日志
openclaw logs --follow

# 查看最近 100 行日志
openclaw logs --tail 100

# 按关键词过滤
openclaw logs --filter "error" --tail 50
openclaw logs --filter "whatsapp" --tail 50

# Docker 环境
docker compose logs -f openclaw
docker compose logs --tail 100 openclaw

# 日志文件位置
ls ~/.openclaw/logs/

# 调整日志级别（排查问题时用 debug）
openclaw config set logging.level "debug"
# 排查完记得改回来
openclaw config set logging.level "info"
```

### Q51: 怎么监控 OpenClaw 的运行状态？

**解决方案：**

```bash
# 内置健康检查
curl http://localhost:18789/health

# 查看详细状态
openclaw status

# 输出示例：
# Gateway: running (uptime: 3d 12h)
# Channels: 3 connected, 0 error
# Sessions: 42 active
# Memory: 256 MB
# CPU: 2%

# 配置外部监控（推荐 UptimeRobot 或类似服务）
# 监控 URL: http://your-server:18789/health
# 检查间隔: 5 分钟
```

### Q52: 磁盘空间不足怎么清理？

**解决方案：**

```bash
# 查看 OpenClaw 占用的磁盘空间
du -sh ~/.openclaw/
du -sh ~/.openclaw/*/  # 分目录查看

# 清理会话日志（最占空间的部分）
openclaw sessions cleanup

# 清理旧的记忆日志
find ~/.openclaw/workspace/memory/ -name "*.md" -mtime +60 -delete

# Docker 环境清理
docker system prune -f          # 清理无用镜像和容器
docker volume prune -f          # 清理无用数据卷（谨慎）

# 查看清理后的空间
du -sh ~/.openclaw/
```

### Q53: 怎么在多台服务器上部署？

**说明：** OpenClaw 目前是单实例架构，不支持原生集群部署。但你可以通过以下方式实现多节点：

```bash
# 方案一：每台服务器独立部署，连接不同的平台
# 服务器 A：负责 WhatsApp
# 服务器 B：负责 Telegram + Discord

# 方案二：用反向代理做负载均衡（实验性）
# Nginx 配置示例：
# upstream openclaw {
#     server 192.168.1.10:18789;
#     server 192.168.1.11:18789 backup;
# }

# 方案三：共享配置和记忆（通过 NFS 或对象存储）
# 把 ~/.openclaw/ 挂载到共享存储
```

### Q54: 怎么设置 HTTPS？

**解决方案：**

```bash
# 方案一：用反向代理（推荐）
# Nginx + Let's Encrypt
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d openclaw.yourdomain.com

# Nginx 配置
# server {
#     listen 443 ssl;
#     server_name openclaw.yourdomain.com;
#     location / {
#         proxy_pass http://127.0.0.1:18789;
#         proxy_http_version 1.1;
#         proxy_set_header Upgrade $http_upgrade;
#         proxy_set_header Connection "upgrade";
#     }
# }

# 方案二：OpenClaw 内置 TLS
openclaw config set gateway.tls.enabled true
openclaw config set gateway.tls.certFile "/path/to/cert.pem"
openclaw config set gateway.tls.keyFile "/path/to/key.pem"
openclaw gateway restart
```

### Q55: 怎么配置自动更新？

**解决方案：**

```bash
# npm 方式：用 crontab 定期检查更新
# 0 2 * * 0 npm update -g openclaw && openclaw gateway restart

# Docker 方式：用 Watchtower 自动更新
docker run -d \
  --name watchtower \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower \
  --interval 86400 \
  openclaw

# 手动检查是否有新版本
openclaw --version
npm view openclaw version
```

---

## 六、记忆系统问题

> 📌 **本节包含 3 个问题：**
> [Q56: AI 不记得之前说的话](#q56-ai-不记得之前说的话) | [Q57: 记忆文件太大](#q57-记忆文件太大导致-token-超限) | [Q58: 多 Agent 共享记忆](#q58-怎么在多个-agent-之间共享记忆)

### Q56: AI 不记得之前说的话

**现象：** 你之前告诉 AI「我叫小明」或「我喜欢用 Python」，但下次对话时 AI 完全不记得这些信息，像是第一次跟你聊天一样。

**原因：** OpenClaw 的记忆是基于 Markdown 文件的。如果信息没有被写入记忆文件，下次会话就不会加载。

**解决方案：**

```bash
# 第一步：检查记忆文件是否存在
ls ~/.openclaw/workspace/memory/
cat ~/.openclaw/workspace/MEMORY.md

# 第二步：主动让 AI 记住
# 发消息："记住：我喜欢用 Python，不喜欢 Java"
# AI 会把这条信息写入 MEMORY.md

# 第三步：确认记忆刷新机制
openclaw config get agents.defaults.memory
# 确保 memoryFlush 是启用的

# 第四步：手动编辑记忆文件
nano ~/.openclaw/workspace/MEMORY.md
# 把重要信息直接写进去
```

### Q57: 记忆文件太大导致 Token 超限

**现象：** 使用一段时间后，每次新对话刚开始就报错 `token limit exceeded`，或者发现 API 费用突然增加。检查发现 `~/.openclaw/workspace/MEMORY.md` 文件已经有几百甚至上千行。

**解决方案：**

```bash
# 查看记忆文件大小
wc -l ~/.openclaw/workspace/MEMORY.md
du -sh ~/.openclaw/workspace/memory/

# 方案一：精简 MEMORY.md
# 删除过时的、不再需要的信息
nano ~/.openclaw/workspace/MEMORY.md

# 方案二：配置自动清理
openclaw config set agents.defaults.memory.retentionDays 30
# 超过 30 天的每日日志会自动删除

# 方案三：限制记忆加载的 Token 数
openclaw config set agents.defaults.memory.maxTokens 2000
```

### Q58: 怎么在多个 Agent 之间共享记忆？

**说明：** 默认情况下，所有 Agent 共享同一个记忆目录。如果你想隔离：

```bash
# 为特定 Agent 设置独立的记忆目录
openclaw agents set-identity my-agent --memoryDir "~/.openclaw/workspace/memory-my-agent"

# 或者让多个 Agent 共享（默认行为）
# 所有 Agent 都读写 ~/.openclaw/workspace/MEMORY.md
```

---

## 七、安全和隐私问题

> 📌 **本节包含 6 个问题：**
> [Q59: API Key 泄露风险](#q59-api-key-会不会泄露) | [Q60: 聊天记录存储](#q60-聊天记录存在哪里会被发送到第三方吗) | [Q61: Gateway Token](#q61-gateway-token-是什么必须设置吗) | [Q62: 限制对话权限](#q62-怎么限制谁能跟-ai-对话) | [Q63: 防止危险操作](#q63-怎么防止-ai-执行危险操作) | [Q64: 安全漏洞](#q64-openclaw-有已知的安全漏洞吗)

### Q59: API Key 会不会泄露？

**说明：** OpenClaw 把 API Key 存储在本地配置文件中（`~/.openclaw/openclaw.json`），不会上传到任何服务器。

**安全建议：**

```bash
# 检查配置文件权限
ls -la ~/.openclaw/openclaw.json
# 应该是 600（只有当前用户可读写）

# 修复权限
chmod 600 ~/.openclaw/openclaw.json

# 更安全的方式：用环境变量代替配置文件
export OPENAI_API_KEY="sk-proj-xxxxx"
# 把环境变量写入 ~/.bashrc 或 ~/.zshrc
# 不要把 Key 写入任何会被 git 追踪的文件
```

### Q60: 聊天记录存在哪里？会被发送到第三方吗？

**说明：** 聊天记录存储在本地 `~/.openclaw/` 目录中。消息内容只会发送到你配置的 AI 模型提供商（如 OpenAI、Anthropic）。

OpenClaw 本身不收集任何用户数据。但要注意：
- 你发给 AI 的消息会被模型提供商处理（参考各提供商的隐私政策）
- 如果你用 OpenRouter 等聚合服务，消息会经过中间层
- 本地模型（Ollama）的数据完全不出本机

### Q61: Gateway Token 是什么？必须设置吗？

**说明：** Gateway Token 是访问 OpenClaw Gateway 的认证凭证。如果不设置，任何知道你 Gateway 地址的人都能连接并发送消息。

```bash
# 必须设置！
openclaw config set gateway.token "$(openssl rand -hex 32)"

# 或者手动设置一个强密码
openclaw config set gateway.token "your-strong-random-token-here"

# 通过环境变量设置
export OPENCLAW_GATEWAY_TOKEN="your-strong-random-token-here"
```

### Q62: 怎么限制谁能跟 AI 对话？

**解决方案：**

```bash
# 方案一：配对系统（默认开启）
# 陌生人发消息需要你手动批准
openclaw pairing list          # 查看待批准的联系人
openclaw pairing approve user1 # 批准
openclaw pairing reject user2  # 拒绝

# 方案二：白名单模式
openclaw config set security.whitelist.enabled true
openclaw config set security.whitelist.contacts '["user1@whatsapp", "user2@telegram"]'

# 方案三：禁用自动配对
openclaw config set channels.pairing.autoApprove false
```

### Q63: 怎么防止 AI 执行危险操作？

**解决方案：**

```bash
# 第一步：禁用危险工具
openclaw config set tools.disabled '["shell_exec", "file_delete", "file_write"]'

# 第二步：启用工具确认模式（每次调用工具前需要你确认）
openclaw config set tools.confirmBeforeExec true

# 第三步：限制文件系统访问范围
openclaw config set security.sandbox.enabled true
openclaw config set security.sandbox.allowedPaths '["/home/user/documents"]'

# 第四步：启用审计日志
openclaw config set security.auditLog.enabled true
# 所有工具调用都会被记录到 ~/.openclaw/logs/audit.log
```

### Q64: OpenClaw 有已知的安全漏洞吗？

**说明：** OpenClaw 在 2026 年初曾披露过 CVE 安全漏洞，社区已经修复。建议：

```bash
# 始终保持最新版本
npm update -g openclaw

# 查看安全公告
# https://github.com/openclaw/openclaw/security/advisories

# 检查当前版本是否有已知漏洞
openclaw --version
# 对照 GitHub Releases 页面的安全说明
```

---

## 八、中国用户特别提示

> 📌 **本节包含 3 个问题：**
> [Q65: API 访问不了](#q65-api-访问不了怎么办) | [Q66: WhatsApp 能否使用](#q66-whatsapp-在中国能用吗) | [Q67: npm 镜像问题](#q67-npm-镜像配置后还是装不上)

### Q65: API 访问不了怎么办？

**说明：** OpenAI、Anthropic、Google 的 API 在中国大陆无法直接访问。

**解决方案：**

```bash
# 方案一：使用代理
export HTTP_PROXY="http://127.0.0.1:7890"
export HTTPS_PROXY="http://127.0.0.1:7890"
openclaw gateway start

# 方案二：使用 OpenRouter（一个 Key 用所有模型）
openclaw config set providers.openrouter.apiKey "sk-or-xxxxx"
openclaw config set defaultModel "openrouter:openai/gpt-5.2"

# 方案三：使用国产模型（不需要代理）
openclaw config set providers.deepseek.apiKey "sk-xxxxx"
openclaw config set defaultModel "deepseek:deepseek-chat"

# 方案四：本地模型（完全不需要网络）
ollama pull qwen2.5:7b
openclaw config set defaultModel "ollama:qwen2.5:7b"
```

### Q66: WhatsApp 在中国能用吗？

**说明：** WhatsApp 在中国大陆需要代理才能使用。

**替代方案：**
- Telegram（需要代理，但 Bot API 可以通过代理访问）
- 飞书 / Lark（国内原生支持，OpenClaw 通过扩展支持飞书 Channel）
- 注意：钉钉、微信公众号、个人微信均不受官方支持

```bash
# 配置飞书（推荐中国用户）
openclaw channels add feishu
# 按提示配置飞书开放平台的 App ID 和 App Secret
```

### Q67: npm 镜像配置后还是装不上

**解决方案：**

```bash
# 清除 npm 缓存
npm cache clean --force

# 确认镜像生效
npm config get registry
# 应该显示 https://registry.npmmirror.com

# 如果还是不行，试试直接下载
# 去 GitHub Releases 页面下载预编译包
# https://github.com/openclaw/openclaw/releases

# 或者用 Docker（镜像可以从国内源拉取）
docker pull openclaw/openclaw:latest
```

---

## 九、社区和贡献问题

> 📌 **本节包含 5 个问题：**
> [Q68: 报告 Bug](#q68-怎么报告-bug) | [Q69: 贡献代码](#q69-怎么贡献代码) | [Q70: 分享自定义技能](#q70-怎么创建和分享自定义技能) | [Q71: 中文社区](#q71-有中文社区吗) | [Q72: 文档反馈](#q72-文档有错误怎么反馈)

### Q68: 怎么报告 Bug？

**解决方案：**

1. 去 [GitHub Issues](https://github.com/openclaw/openclaw/issues) 页面
2. 点击 "New Issue"
3. 选择 "Bug Report" 模板
4. 填写以下信息：

```markdown
## 环境信息
- OpenClaw 版本：（openclaw --version）
- Node.js 版本：（node --version）
- 操作系统：
- 安装方式：npm / Docker

## 问题描述
简要描述遇到的问题

## 复现步骤
1. ...
2. ...
3. ...

## 期望行为
你期望发生什么

## 实际行为
实际发生了什么

## 日志
（openclaw logs --tail 50）
```

### Q69: 怎么贡献代码？

**流程：**

```bash
# 1. Fork 仓库
# 在 GitHub 上点击 Fork

# 2. 克隆到本地
git clone https://github.com/your-username/openclaw.git
cd openclaw

# 3. 创建功能分支
git checkout -b feat/my-new-feature

# 4. 安装依赖
npm install

# 5. 开发和测试
npm run dev
npm test

# 6. 提交代码
git add .
git commit -m "feat: add my new feature"

# 7. 推送并创建 PR
git push origin feat/my-new-feature
# 在 GitHub 上创建 Pull Request
```

### Q70: 怎么创建和分享自定义技能？

**解决方案：**

```bash
# 1. 创建技能文件
mkdir -p ~/.openclaw/workspace/skills
nano ~/.openclaw/workspace/skills/my-awesome-skill.md

# 2. 测试技能
openclaw skills list
openclaw skills check my-awesome-skill --input "测试"

# 3. 分享到社区
# 在 GitHub 上创建一个仓库，或者提交到 OpenClaw 的技能市场
# https://github.com/openclaw/openclaw-skills
```

### Q71: 有中文社区吗？

**说明：** 有的。

- GitHub Discussions（中英文都可以）：[github.com/openclaw/openclaw/discussions](https://github.com/openclaw/openclaw/discussions)
- Discord 社区（有中文频道）
- 微信群：关注 OpenClaw 公众号获取入群二维码

### Q72: 文档有错误怎么反馈？

**解决方案：**

- 直接在 GitHub 上提 Issue，标注 `docs` 标签
- 或者直接提 PR 修改文档
- 文档源码在仓库的 `docs/` 目录下

---

## 十、其他常见问题

> 📌 **本节包含 7 个问题：**
> [Q73: 和 ChatGPT 的区别](#q73-openclaw-和-chatgpt-有什么区别) | [Q74: 支持哪些语言](#q74-openclaw-支持哪些语言) | [Q75: 多实例运行](#q75-一台机器能跑多个-openclaw-实例吗) | [Q76: 是否收费](#q76-openclaw-会收费吗) | [Q77: 查看所有配置](#q77-怎么查看当前的所有配置) | [Q78: Gateway 和 Agent 关系](#q78-gateway-和-agent-是什么关系) | [Q79: 获取帮助](#q79-遇到问题怎么获取帮助)

### Q73: OpenClaw 和 ChatGPT 有什么区别？

**说明：** 它们是完全不同的东西：

| 维度 | ChatGPT | OpenClaw |
|------|---------|----------|
| 本质 | AI 聊天产品 | AI Agent 框架 |
| 模型 | 只能用 OpenAI 的模型 | 支持 29+ 提供商 |
| 平台 | 网页/App | WhatsApp/Telegram/Discord 等 |
| 工具 | 有限的插件 | 可扩展的工具和技能系统 |
| 记忆 | 平台管理 | 你自己控制（本地 Markdown） |
| 数据 | 存在 OpenAI 服务器 | 存在你自己的机器上 |
| 价格 | 订阅制 | 开源免费（API 费用另算） |

简单说：ChatGPT 是一个产品，OpenClaw 是一个让你构建自己 AI 助手的工具。

### Q74: OpenClaw 支持哪些语言？

**说明：** OpenClaw 本身是英文项目，但 AI 的回复语言取决于你使用的模型和系统提示词。

```bash
# 在系统提示词中指定语言
openclaw agents set-identity default --systemPrompt "你是一个中文 AI 助手，请始终用中文回复。"
```

大多数主流模型（GPT-5.2、Claude、Gemini）都支持中文。本地模型推荐用 Qwen（通义千问）系列，中文能力最好。

### Q75: 一台机器能跑多个 OpenClaw 实例吗？

**解决方案：**

```bash
# 可以，但需要用不同的端口和数据目录

# 实例 1
OPENCLAW_HOME=~/.openclaw-1 openclaw config set gateway.port 18789
OPENCLAW_HOME=~/.openclaw-1 openclaw gateway start

# 实例 2
OPENCLAW_HOME=~/.openclaw-2 openclaw config set gateway.port 18790
OPENCLAW_HOME=~/.openclaw-2 openclaw gateway start

# Docker 方式更简单：跑多个容器，映射不同端口
```

### Q76: OpenClaw 会收费吗？

**说明：** OpenClaw 是开源项目（MIT 协议），永久免费。你需要付费的只有 AI 模型的 API 调用费用（如果你用云端模型的话）。用本地模型（Ollama）则完全零成本。

### Q77: 怎么查看当前的所有配置？

**解决方案：**

```bash
# 查看所有配置
openclaw config get

# 查看特定配置项
openclaw config get providers
openclaw config get channels
openclaw config get defaultModel

# 导出完整配置（备份用）
# 直接备份配置文件
cp ~/.openclaw/openclaw.json my-config-backup.json

# 从备份恢复
cp my-config-backup.json ~/.openclaw/openclaw.json
```

### Q78: Gateway 和 Agent 是什么关系？

**说明：**

- **Gateway** 是消息网关，负责连接各个消息平台（WhatsApp、Telegram 等），接收和发送消息
- **Agent** 是 AI 智能体，负责理解消息、调用工具、生成回复

消息流程：`用户 → 消息平台 → Gateway → Agent → 模型 API → Agent → Gateway → 消息平台 → 用户`

Gateway 是基础设施层，Agent 是业务逻辑层。一个 Gateway 可以服务多个 Agent。

### Q79: 遇到问题怎么获取帮助？

**获取帮助的渠道（按推荐顺序）：**

1. 查看本 FAQ 文档
2. 查看[官方文档](https://docs.openclaw.ai)
3. 搜索 [GitHub Issues](https://github.com/openclaw/openclaw/issues)（可能别人遇到过同样的问题）
4. 在 [GitHub Discussions](https://github.com/openclaw/openclaw/discussions) 提问
5. 加入 Discord 社区实时交流

提问时请附上：
- OpenClaw 版本（`openclaw --version`）
- Node.js 版本（`node --version`）
- 操作系统信息
- 相关日志（`openclaw logs --tail 50`）

---

> 教程到这里就结束了！如果这份教程帮到了你，给个 Star 支持一下！
