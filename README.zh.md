# Mazzy Command Center

[English](README.md) · [Русский](README.ru.md) · [Deutsch](README.de.md) · **中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

**面向 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码代理的、由父级签证的本地智能体编排器与指挥中心。**

_作者：**Mazurov N.N.** — https://github.com/mazurovn · 专有、源码可见（未经书面许可
不得修改或再分发 — 见 [LICENSE](LICENSE)）。_

Mazzy Command Center 是一个**完整的代理编排器与指挥中心**，作为项目本地的 Pi
扩展构建。它将一个 Pi 会话变成一个持久、可审计的中心，代理工作在此被规划、委派、
执行、评审并被记忆：任务追踪器 + 编排器 + 自己的子代理引擎 + 子代理创建器 +
元代理 + 分层记忆 + 规范↔代码↔待办知识图 —— 全部基于单一嵌入式 SQLite 内核。

> **状态：经过身份验证的本地试点，正积极迈向完整的指挥中心。** 试点当前提供持久内核、
> 仪表盘、图视图和签证编排。自己的子代理引擎、子代理创建器、元代理以及分层记忆 /
> DAG / RAG / 向量是产品方向，正在逐步落地。参见[路线图](#路线图)与
> [安全与限制](#安全与限制)。

---

## 它是什么

Mazzy 是一个**拥有编排权的指挥中心**：它决定*接下来运行什么、用哪个代理、在什么
预算和能力上限之下*，并保存持久的计划、证据、记忆和知识图。它围绕清晰的
**三权分立**设计，使拥有强大引擎绝不会把 Web 面变成远程执行预言机：

1. **调度**（内核）—— 一个纯规划器从持久、强类型的记录计算接下来应运行什么。
2. **分发**（Mazzy 自己的 executor）—— 一个独立的、**无网络**的、与父同生命周期的
   进程，是唯一真正启动工作的组件。
3. **执行提供者** —— executor 后面可替换的运行时（今天是 `pi-subagents`；Mazzy
   拥有提供者接口，并在培育自己的引擎）。

- **持久任务追踪器** —— 史诗 / 功能 / 任务 / 缺陷，具有带版本的生命周期（`DRAFT →
  BACKLOG → READY → CLAIMED → RUNNING → REVIEW → DONE`，以及 `BLOCKED / FAILED /
  CANCELLED`），并进行乐观并发检查。
- **带签证分发的编排器** —— Mazzy 规划并分发工作，将*观察到的*运行绑定到任务，
  并使 `DONE` 取决于独立的 PASS 证据。
- **自己的子代理引擎与创建器** *（方向）* —— 一个第一方执行引擎和声明式创建器：
  定义代理、能力上限、预算和提示契约，并通过 Mazzy 自己的 executor 启动它们。
- **元代理** *（方向）* —— 其输出为*提议*的代理，其他代理据此行动，均处于相同的
  签证、受能力上限约束的分发路径下。
- **分层记忆 + 知识** *（方向）* —— hot/warm/cold 记忆，带混合检索（RAG）和向量，
  以及计划 DAG —— 作为上下文，而非权威。
- **经过身份验证的本地仪表盘** —— 位于 `localhost` 的自包含 Web 界面，带能力令牌、
  通过 SSE 的实时更新、看板以及任务讨论抽屉。
- **SDD/ADR 知识图** —— 浏览器内的可视化，将规范条款（ADR/INV/FR）、代码组件和
  待办事项连接成一个可过滤的连通图（记忆与向量作为一等公民数据源接入）。
- **安全脚手架** —— `mazzy-init` 写入可移植的项目模板，默认干运行、带受保护的
  `--force` 和 `--rollback`。

---

## 架构一览

Mazzy 通过**三权分立**拥有编排权，使强大引擎绝不会把 Web 面变成远程执行预言机：

```
人类 / 规划器 ── Pi 命令 / 经过验证的 localhost 浏览器 ──┐
                                                       v
Mazzy Command Center 内核（编排权）── SQLite 内核
   • 计划 / 证据 / 记忆与知识（方向）  │
   • 签发一次性、经完整性校验的分发授权
                                          v
                        Mazzy executor（独立、无网络的进程）
                                          │
                                          v
                        执行提供者 —— 今天是 pi-subagents，
                        Mazzy 自己的引擎（方向）—— 可替换
```

**核心原则（不变量）：**

- **无 HTTP 引发的执行** —— 任何终止 HTTP 套接字的进程都不拥有分发权；只有独立的
  executor 启动工作，而且只针对一次性授权。
- **自由文本不驱动执行** —— 调度是强类型持久记录的纯函数；记忆、向量和缓存是
  *上下文，而非权威*。
- **仅父级写入** —— 内核变更需要交互式父级；被继承的子进程会被拒绝。
- **没有主机路径越过 API** —— 只有不透明的 id、枚举和相对引用离开 localhost。
- **评论从不作为证据** —— 权威的 PASS/FAIL 通道是评审者/验证者的证据。
- **所有 `git` 调用都经过加固** —— 仓库配置/钩子和继承的环境无法影响执行。

---

## 工具与命令

**仅父级工具**（LLM 可见的界面）：

| 工具 | 用途 |
|---|---|
| `mazzy_task` | 创建 / 列出 / 获取 / 更新持久任务（带版本；`DONE` 需要 PASS 证据）。 |
| `mazzy_route` | 委派的只读策略预检（仅规划；由 executor 分发）。 |
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

**依据 [PolyForm Noncommercial License 1.0.0](LICENSE) 开放源代码。**
版权所有 (c) 2025 Mazurov N.N.

- ✅ 可**免费**用于任何**非商业**目的的使用、研究、修改和分享 —— 个人使用、科研、教育。
- ⛔ **不得商业使用。** 公司及商业产品/服务需要单独的商业许可。另计划提供商业版 **Mazzy Command Center Enterprise** 及商业许可。
- ⛔ 必须保留所有作者/版权/许可声明；未经书面许可，不得重命名软件、移除署名，或以
  相同名称（“Mazzy Command Center” / “Mazzy”）呈现修改版本。

如需商业许可或超出上述条款的使用：https://github.com/mazurovn
