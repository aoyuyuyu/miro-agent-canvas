# Miro 0.8 代码来源

Orca：https://github.com/stablyai/orca

固定提交：ea6a6d60774ac2b74bb6692d1798e3ab13b99ae0，MIT 许可。

已导入 70 个构建依赖源文件；其中 42 个模块进入实际运行产物，均与固定上游原文件 SHA256 一致。构建入口是 vendor/orca/entry.ts，运行模块清单是 vendor/orca/runtime-modules.json。

| 实际能力 | 复用来源 | 本项目调用处 |
|---|---|---|
| 本机 Orca 通信、身份校验 | cli/runtime/metadata.ts、transport.ts | electron/orcaRuntime.cjs |
| Windows 进程启动、超时与子进程清理 | shared/child-process/run-process.ts | adapters/codexAdapter.cjs、nowledgeHistory.cjs |
| Agent 命令与检测 | shared/tui-agent-config.ts | nativeSessions.cjs |
| CodeBuddy 正文解析 | session-scanner-codebuddy-parser.ts 及依赖 | history.cjs |
| 新窗口、发送、状态、历史 | 已安装 Orca 的原有接口 | nativeSessions.cjs、orcaRuntime.cjs |
| 六类历史同步与共同记忆读取 | Nowledge 官方导入器与本机接口 | nowledgeHistory.cjs |
| 浅色变量、OpenCode 图标 | 上游 main.css、agent-icon-glyphs.tsx 原样摘录 | workspace.css、Workspace.jsx |
| 节点、连线、缩放、拉大 | React Flow | Workspace.jsx |

未达成或证明 80%。本报告统计真实运行模块，不把依赖目录、构建所需但未进入运行时的文件、图标或完整第三方服务计入源码复用比例。

Miro 定制界面、会话映射、历史适配、避让和认证桥接仍是项目代码。调用 Orca/Nowledge 服务属于功能复用，不冒充复制了整个服务的源码。

全部 MIT 原始声明见 vendor/orca/LICENSE 和 THIRD_PARTY_NOTICES.md。
