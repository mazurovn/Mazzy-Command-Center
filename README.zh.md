# Mazzy Command Center

[English](README.md) · [Русский](README.ru.md) · [Deutsch](README.de.md) · **中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

**面向 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码代理的、由父级签证的本地任务指挥中心。**

_作者：**Mazurov N.N.** — https://github.com/mazurovn · 专有、源码可见（未经书面许可
不得修改或再分发 — 见 [LICENSE](LICENSE)）。_

Mazzy Command Center 是一个项目本地的 Pi 扩展，它将一个 Pi 会话变成一个持久、可审计的
代理工作指挥中心：任务追踪器、编排决策界面、评审/证据账本，以及一个经过身份验证的本地
Web 仪表盘 —— 全部构建在单一的嵌入式 SQLite 控制平面之上。

> **状态：经过身份验证的本地试点。** 单机、单一可信用户、项目本地持久化，以及进程级的
> 父/子边界。它**尚不是**多用户、多租户或远程产品。参见[安全与限制](#安全与限制)。

---

## 它做什么

Mazzy 是一个**控制平面**，而不是第二个执行运行时。它记录并治理工作；实际的子进程执行
被委托给 `pi-subagents`。父级 Pi 会话是控制平面的唯一写入者；子代理从不直接改变状态，
由父级对观察到的结果进行签证。

- **持久任务追踪器** —— 史诗 / 功能 / 任务 / 缺陷，具有带版本的生命周期
  （`DRAFT → BACKLOG → READY → CLAIMED → RUNNING → REVIEW → DONE`，以及
  `BLOCKED / FAILED / CANCELLED`）。每次更新都进行乐观并发检查。
- **父级签证的编排** —— 父级在声称任务运行之前，将一个*观察到的*子运行绑定到任务；
  `DONE` 需要独立的 PASS 证据，而非评论。
- **经过身份验证的本地仪表盘** —— 位于 `localhost` 的自包含 Web 界面，带能力令牌、
  通过 SSE 的实时更新、看板以及任务讨论抽屉。
- **SDD/ADR 图** —— 浏览器内的可视化，将规范条款（ADR/INV/FR）、代码组件和待办事项
  连接成一个可过滤的连通图。
- **安全脚手架** —— `mazzy-init` 写入可移植的项目模板，默认干运行、带受保护的
  `--force` 和 `--rollback`。

---

## 架构一览

```
人类 ── Pi 命令 / 经过验证的 localhost 浏览器 ──┐
                                                v
Pi 父级 + 扩展 API ── Mazzy Command Center ── SQLite 控制平面
                     │       │        │
                     │       ├─ 讨论 / 证据 / 报告
                     │       └─ 经签证的控制桥
                     v
              pi-subagents（唯一的子运行时）
```

**核心原则（不变量）：**

- **单一执行运行时** —— 由 `pi-subagents` 运行子进程；Mazzy 从不生成、调度、重试或
  杀死子工作。它拥有*决策*权，而非*执行*权。
- **仅父级写入** —— 控制平面的变更需要交互式父级；被继承的子进程会被拒绝。
- **没有主机路径越过 API** —— 只有不透明的 id、枚举和相对引用离开 localhost。
- **评论从不作为证据** —— 权威的 PASS/FAIL 通道是评审者/验证者的证据。
- **所有 `git` 调用都经过加固** —— 仓库配置/钩子和继承的环境无法影响执行。

---

## 工具与命令

**仅父级工具**（LLM 可见的界面）：

| 工具 | 用途 |
|---|---|
| `mazzy_task` | 创建 / 列出 / 获取 / 更新持久任务（带版本；`DONE` 需要 PASS 证据）。 |
| `mazzy_route` | 委派的只读策略预检（从不生成）。 |
| `mazzy_assignment` | 父级签证的运行绑定、完成导入与评审者证据。 |
| `mazzy_discussion` | 读取/回复持久的任务讨论。 |
| `mazzy_control` | 对仪表盘 GO / PAUSE / STOP 请求的 claim/complete/fail。 |

**斜杠命令：** `/mazzy`（状态 + 仪表盘 URL）、`/mazzy-url`（带令牌的访问 URL）、
`/mazzy-server`（start/stop/status）、`/mazzy-menu`（`Ctrl+Alt+M`）、`/mazzy-init`、
`/mazzy-doctor`、`/mazzy-registry`、`/mazzy-clean`。

---

## 安装

**要求**

| 组件 | 版本 |
|---|---|
| Node.js | `>= 22.19.0` |
| `@earendil-works/pi-coding-agent` | `0.84.2` |
| `@earendil-works/pi-ai` | `0.84.2` |
| `@earendil-works/pi-tui` | `0.84.2` |

**从 npm 安装：**

```bash
pi install npm:@mazurovn/mazzy-command-center
# 然后重启 Pi 以便发现该扩展。
```

**从 GitHub 安装：**

```bash
pi install git:github.com/mazurovn/Mazzy-Command-Center
```

**验证：**

```bash
npm run typecheck
npm test
```

在 Pi 会话中，运行 `/mazzy` 查看状态和仪表盘 URL，或 `/mazzy-url` 显示带令牌的访问
URL（令牌从不写入日志）。

---

## 安全与限制

这是一个**经过身份验证的本地试点**，不应被解读为生产级安全保证。

- 单机、单一可信用户；父/子进程边界。
- **并非**多用户授权、**并非**租户隔离、**并非**远程身份、**并非**分布式写者租约。
- 仪表盘操作、已发送的控制请求或父级确认**都不是**执行或验证的证据。

请通过私密渠道报告安全问题，而非公开的 issue。

---

## 许可证

**专有、源码可见。** 版权所有 © 2026 Mazurov N.N. 保留所有权利。你可以查看、运行和
评估本软件，但未经作者事先书面许可，**不得**修改、再分发或创作衍生作品，并且每一份获
许可的副本都必须保留作者署名。完整条款见 [LICENSE](LICENSE) 文件。
