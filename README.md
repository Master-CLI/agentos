# AgentOS

> 项目级智能协调系统 — 持续观察、全局理解、主动建议

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/status-early%20prototype-orange.svg)](#项目状态)

AgentOS 不是又一个"常驻的 AI 聊天助手"，而是一个**项目级智能控制平面**：在项目目录中一行命令启动后，它作为守护进程长期观察文件、Git、模块状态，维护可追溯的事件流与项目快照，并在合适的时机以"观察者/建议者"的身份给出高置信度的建议 —— 由人决定是否采纳。

核心理念来自三种互补视角的共识：**控制平面 > 聊天机器人、Event Sourcing 持久化状态、分层记忆、信任渐进建立、先做 2–3 个高价值闭环做深做透。** 完整设计见 [`Docs/AgentOS-落地方案.md`](./Docs/AgentOS-落地方案.md)。

---

## 特性

- **观察层**：文件监听（chokidar）+ Git 观察（simple-git）+ 初始扫描器，统一为事件流
- **状态层**：Event Store（SQLite / sql.js）+ 模块探测 + 快照引擎，支持回放
- **推理层**：本地 LLM 与 CLI Agent 的路由器（Router），按任务选择合适的模型
- **管道**：变更分类 → 审阅管道 → 任务管理 → 建议引擎
- **信任机制**：置信度校准（confidence calibrator）、阻尼（damping）、反馈追踪
- **遥测**：审计日志 + 指标收集，系统自观测与项目观测同等重要
- **Web 控制台**：React + Vite 前端，状态概览 / 变化流 / 建议收件箱 / 任务详情 / 对话与终端
- **对话通道**：WebSocket 实时双向通信

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    Web Console (React)                 │
│  StatusOverview · ChangeStream · SuggestionInbox · ...  │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP + WebSocket
┌────────────────────────┴────────────────────────────────┐
│                    Daemon (Node.js)                    │
│  ┌───────────┐  ┌───────────┐  ┌───────────────────┐   │
│  │ Observers │→ │  Pipeline │→ │ Suggestion Engine │   │
│  └───────────┘  └───────────┘  └───────────────────┘   │
│        ↓              ↓                 ↓              │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Event Store · Snapshot · Reasoning · Trust     │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                         ↑
                  CLI (agentos init/start/stop/status)
```

monorepo 目录：

```
packages/
├── cli/       # 命令行入口（init / start / stop / status / list / open）
├── daemon/    # 核心引擎：观察 · 事件 · 管道 · 推理 · 信任 · 遥测
└── web/       # React + Vite 控制台
Docs/
└── AgentOS-落地方案.md   # 完整设计文档
```

## 环境要求

- **Node.js** ≥ 20
- **npm**（项目使用 npm workspaces）
- 可选：本地 LLM 或支持的 CLI Agent（用于推理层）

## 安装与构建

```bash
git clone https://github.com/Master-CLI/agentos.git
cd agentos
npm install
npm run build
```

## 使用

```bash
# 在任意项目目录中初始化
npx agentos init

# 启动守护进程（后台运行）
npx agentos start

# 查看状态
npx agentos status

# 打开 Web 控制台
npx agentos open

# 停止
npx agentos stop
```

## 测试

```bash
npm test
```

测试覆盖 phase0–phase5 与端到端（`packages/daemon/test/`）。

## 项目状态

**早期原型（v0.1.0）** — 核心骨架已搭建：观察层、事件存储、管道、信任机制、Web 控制台均已落地到可运行的程度。推理层当前以 CLI Agent 为主，本地 LLM 接入正在完善。设计文档（`Docs/AgentOS-落地方案.md`）描述的完整闭环尚在分阶段实现中，欢迎围观或参与。

不适合生产使用。接口与数据格式可能在 1.0 前发生破坏性变更。

## 贡献

欢迎 Issue 与 PR。在提交较大改动前，请先开 Issue 讨论方向，避免与正在进行的分阶段实现冲突。

## License

[MIT](./LICENSE)
