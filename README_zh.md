# BDRclaw

> **永不休息的 AI SDR 团队 — 在你专注成交的同时预约合格会议。**

轻量级 AI 原生 BDR 团队，运行在容器中。连接你的 CRM、邮件、LinkedIn、Slack 和短信，让你专注于成交，不再消耗认知负荷。

基于 [Anthropic Agents SDK](https://docs.anthropic.com/en/docs/agents) 构建。灵感来源于 [NanoClaw](https://github.com/qwibitai/nanoclaw)。

<p align="center">
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>
</p>

---

## 为什么选择 BDRclaw

大多数销售自动化工具是仪表盘。你仍然需要思考、决策和执行。BDRclaw 不同 — 它是一个智能体团队。它自动进行潜客开发、序列执行、跟进、信息丰富和 CRM 同步，覆盖你的买家所在的每一个渠道。

无需招聘 SDR。无需消耗认知负荷。只有合格的销售管道。

| BDRclaw 做的事 | 你做的事 |
|---|---|
| 在 LinkedIn 上开发潜客 | 进行发现电话 |
| 发送冷邮件序列 | 处理异议 |
| 通过短信和 Slack 跟进 | 谈判和成交 |
| 丰富并更新 CRM 记录 | 签合同 |
| 标记热门线索和购买信号 | 收款 |

---

## 架构

```
渠道 (邮件 / LinkedIn / Slack / SMS / WhatsApp)
        ↓
    SQLite 队列
        ↓
  轮询循环 + 路由
        ↓
  容器 (Claude Agent SDK)  ←→  prospects/*/CLAUDE.md
        ↓
   CRM 同步 + 外发操作
```

- **单一 Node.js 进程。** 无微服务。
- **容器隔离的智能体。** 每个智能体运行在自己的 Linux 容器中。
- **潜客记忆。** 每个潜客有一个 `prospects/*/CLAUDE.md` — 接触点历史、阶段、回复历史、信息丰富数据。
- **技能优于功能。** 能力以 Claude Code 技能的形式添加。

---

## 它自动化什么

### 外发渠道
- **邮件** — 多步冷邮件序列、跟进、回复检测
- **LinkedIn** — 连接请求、私信序列、资料丰富
- **短信** — Twilio 驱动的短信外联
- **Slack** — 通过 Slack Connect 的 SDR 序列
- **WhatsApp** — 面向国际潜客的温暖外联

### CRM 和信息丰富
- **HubSpot / Attio / Salesforce** — 自动创建联系人、记录接触、更新阶段
- **Apollo / Hunter / Clay** — 邮件查找和联系人信息丰富

### 智能层
- 每日 BDR 大脑：审查管道、队列跟进、标记热门线索
- 购买信号检测（职位变动、融资轮次、网站访问）
- 回复分类（感兴趣 / 不感兴趣 / 推荐 / 取消订阅）
- 会议预约 → CRM 阶段自动更新 → 通知成交人员

---

## 快速开始

```bash
gh repo fork Josefusan/BDRclaw --clone
cd BDRclaw
claude
```

然后运行 `/setup`。Claude Code 处理一切：依赖安装、身份验证、容器设置和服务配置。

---

## 技能

| 技能 | 描述 |
|---|---|
| `/add-gmail` | 冷邮件序列 + 回复检测 |
| `/add-linkedin` | LinkedIn 潜客开发 + 私信序列 |
| `/add-hubspot` | CRM 同步、阶段更新、联系人创建 |
| `/add-attio` | Attio CRM 集成 |
| `/add-apollo` | 联系人信息丰富 + 邮件查找 |
| `/add-twilio` | 短信外联 |
| `/add-slack-outreach` | Slack Connect SDR 序列 |
| `/add-whatsapp` | WhatsApp 外联渠道 |
| `/add-calendly` | 会议链接注入 + 预约检测 |
| `/add-clay` | Clay 信息丰富工作流 |

### 开源核心模型

基础 BDRclaw 框架为 MIT 许可。高级技能另行维护。

> 基础框架是 MIT 的。高级技能是护城河。

---

## 系统要求

- macOS 或 Linux
- Node.js 20+
- Claude Code
- Apple Container (macOS) 或 Docker (macOS/Linux)
- Anthropic API 密钥

---

## 贡献

不要添加功能。添加技能。

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 许可证

MIT — 见 [LICENSE](./LICENSE)

---

*基于 [NanoClaw](https://github.com/qwibitai/nanoclaw) (MIT) 构建。*
