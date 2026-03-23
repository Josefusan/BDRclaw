# BDRClaw

> **基于 Anthropic Agent SDK 构建的轻量级、容器隔离的 AI 销售开发平台。**
> 自动化潜在客户开发、外联、跟进和 CRM 管理 — 覆盖 LinkedIn、邮件、短信、Slack、WhatsApp、Telegram 和 Discord — 让您的团队专注于成交而非填写表格。

<p align="center">
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>
</p>

---

## 愿景

BDRClaw 是当你给一位世界级 BDR 配上 AI 大脑、记忆系统和销售工具栈中的每一个工具时所发生的事情 — 安全地运行在自己的容器中，不会失控、不会泄露数据，并且可以逐行审计。

基于 **NanoClaw 的开源核心 fork** 构建，BDRClaw 保持相同的设计哲学：

- **小巧易懂。** 单一进程，少量源文件，无微服务。
- **隔离保障安全。** 智能体运行在 Linux 容器（Docker / Apple Container）中。Bash 是安全的，因为它在容器内运行，而非在你的主机上。
- **AI 原生。** 无安装向导。无监控仪表盘。无调试工具。问 Claude。
- **技能优于功能。** 新集成以可安装的技能（`/add-hubspot`、`/add-linkedin`、`/add-apollo`）交付，而非核心代码膨胀。

基础框架为 MIT 许可。高级技能是护城河。

---

## BDRClaw 自动化的内容

BDR 做的一切事情，除了参加电话会议：

| 活动 | 渠道 | 技能 |
|---|---|---|
| 冷外联序列 | Gmail / SMTP | `/add-gmail` |
| LinkedIn 私信 + 连接请求 | LinkedIn | `/add-linkedin` |
| 短信跟进 | Twilio | `/add-sms` |
| Slack 潜客开发 | Slack | `/add-slack-outreach` |
| WhatsApp 序列 | WhatsApp | `/add-whatsapp` |
| Telegram 外联 | Telegram | `/add-telegram` |
| 联系人信息丰富 | Apollo / Hunter / Clearbit | `/add-apollo` |
| CRM 维护 + 交易阶段更新 | HubSpot / Attio / Salesforce | `/add-hubspot` |
| 管道审查 + 跟进队列 | 内部调度器 | 内置 |
| 潜客评分 + 优先级排序 | Claude 推理层 | 内置 |
| 会议预约 | Cal.com / Calendly | `/add-cal` |

---

## 架构

```
渠道 (Gmail, LinkedIn, SMS, Slack...)
        |
        v
    SQLite 数据库
        |
        v
    轮询循环
        |
        v
  BDR 大脑智能体  <----  prospects/*/CLAUDE.md (每个潜客的记忆)
        |
        v
  容器 (Claude Agent SDK)
        |
        v
   外发路由  -->  渠道注册表  -->  响应
```

### 核心组件

| 文件 | 作用 |
|---|---|
| `src/index.ts` | 编排器：状态、消息循环、智能体调用 |
| `src/channels/registry.ts` | 渠道启动时自注册 |
| `src/ipc.ts` | IPC 监听和任务处理 |
| `src/router.ts` | 消息格式化和外发路由 |
| `src/group-queue.ts` | 每个潜客的队列，带全局并发限制 |
| `src/container-runner.ts` | 生成流式智能体容器 |
| `src/task-scheduler.ts` | 运行定时 BDR 任务（每日管道审查、跟进触发） |
| `src/db.ts` | SQLite 操作（潜客、接触点、序列、CRM 状态） |
| `prospects/*/CLAUDE.md` | 每个潜客的记忆：最后接触点、阶段、笔记、回复历史 |

---

## 快速开始

```bash
gh repo fork josephclark/bdrclaw --clone
cd bdrclaw
claude
```

然后运行 `/setup`。Claude Code 处理一切：依赖安装、身份验证、容器设置和服务配置。

### 系统要求

- macOS 或 Linux
- Node.js 22+
- Claude Code
- Docker (macOS/Linux) 或 Apple Container (macOS)
- Anthropic API 密钥

### 环境变量

```env
ANTHROPIC_API_KEY=
DATABASE_URL=./data/bdrclaw.db
TRIGGER_WORD=@BDR
MAIN_CHANNEL=telegram
AUTO_SEND=false
DAILY_BRAIN_RUN=07:00
```

---

## 使用方法

从您的主渠道（Telegram / WhatsApp / Slack 自聊）：

```
@BDR 添加潜客: 陈莎莎, Acme Corp 工程副总裁, sarah@acme.com, linkedin.com/in/sarahchen
@BDR 将陈莎莎加入冷外联 v1 序列
@BDR 本周管道情况如何
@BDR 目前最热门的潜客是谁
@BDR 暂停所有对 Acme Corp 的外联
@BDR 生成管道报告并发送到团队 Slack
@BDR 标记陈莎莎为已合格，她回复了并想在周四通话
```

---

## 开源核心模型

### 免费（MIT）

- 核心编排器 + 容器运行器
- SQLite 消息/潜客/序列存储
- 轮询循环 + 任务调度器
- BDR 大脑智能体逻辑
- 潜客记忆系统（`prospects/*/CLAUDE.md`）
- 基础技能：`/add-gmail`、`/add-telegram`、`/add-whatsapp`、`/add-slack`

### 付费（BDRClaw Pro 技能）

- `/add-linkedin` — LinkedIn 私信 + 连接自动化
- `/add-apollo` — 联系人信息丰富 + 潜客导入
- `/add-hubspot` — 完整 CRM 同步
- `/add-salesforce` — Salesforce 集成
- `/add-sms` — Twilio 短信序列
- `/add-cal` — Cal.com / Calendly 预约自动化

---

## 贡献

与 NanoClaw 相同的理念：**不要添加功能，添加技能。**

如果您想添加 Salesforce 支持，不要开一个将 Salesforce 添加到核心的 PR。Fork BDRClaw，在分支上构建技能，然后开 PR。我们会创建一个 `skills/add-salesforce` 分支供其他人安装。

---

## 许可证

核心：MIT
Pro 技能：商业许可（见 `LICENSE_PRO`）

---

*BDRClaw 由 [Clark Tech Ventures LLC](https://clarktechventures.com) 构建。*
