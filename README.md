# Miro 多 Agent 同步画布 (Miro Agent Canvas)

基于 React 19 + Vite + Electron 构建的无限画布客户端。作为本地各 Agent（Antigravity、Codex、Hermes、WorkBuddy 等）的交互中枢，支持双向实时对话、跨 Agent 历史互通与统一画布排版管理。

---

## 核心设计理念

1. **去冗余化（看板模式）**：Miro 仅作为实时交互看板与调度枢纽，不重复存储 Agent 冗余大副本；对话真实发生在各 Agent 自家客户端中。
2. **多 Agent 互通**：各 Agent 均可通过标准契约读写 Miro 会话记录，实现真正的多 Agent 上下文互通。
3. **优雅的画布交互**：参考 tldraw/AFFiNE/Orca，卡片无侵入式常驻输入框，支持正下方浮动输入、Ctrl 批量框选发送、碰撞磁吸平滑对齐、富媒体胶囊预览与灯箱查看。

---

## 架构与核心代码分布

```
miro-mvp-v0.1/
├── src/
│   ├── Workspace.jsx         # 主画布视图：节点管理、浮动输入框、批量打字框、富媒体灯箱、抽屉联动
│   ├── workspace.css         # 画布样式体系、动画、极细轮廓卡片
│   ├── shared/
│   │   └── workspace.js      # 节点布局算法：侧边吸附顶对齐、上下碰撞吸附左对齐（已废弃暴力弹飞）
│   └── assets/avatars/       # 各 Agent 高清图标与最新黑白流线 m Logo
├── electron/
│   ├── main.cjs              # Electron 主进程入口、无边框窗口、IPC 事件通道
│   ├── trayManager.cjs       # 任务栏通知区常驻托盘：低调旋转轮廓、呼吸状态、Orca 级提示音与设置菜单
│   ├── nativeSessions.cjs    # 本地 Agent 真实会话连接通道与 Bridge 调度
│   └── preload.cjs           # 安全上下文隔离与 API 注入
├── scripts/                  # 打包、图标生成等辅助脚本
└── Miro/ (外层同级目录)       # Windows 免安装便携版运行目录
```

---

## 关键交互实现规范

- **卡片输入体系**：
  - 单击卡片：正下方弹出独立打字框。
  - `Ctrl + 左键` 框选/加选多张卡片：右侧弹出批量发送打字框，一键群发。
  - 卡片外观：仅保留 1px 细线轮廓，取消四角控制点；鼠标移动到右下角时显示半圆弧，拖拽可自由缩放。
- **碰撞与吸附**：
  - 侧边碰撞：自动对齐到邻近卡片顶部。
  - 上下碰撞：自动对齐到邻近卡片左侧。
- **状态指示与托盘**：
  - 思考中：橙色圆点低频呼吸闪烁。
  - 新回复：绿色圆点；用户单击卡片查看后指示点消失。
  - 未连接：头像置灰。
  - 系统托盘：Agent 回复时细线轮廓旋转，多 Agent 回复轮换；右键托盘支持调节发光强弱与提示音。
- **富媒体与剪贴板**：
  - 画布直接 `Ctrl + V` 粘贴文本、图片或视频。
  - 媒体在卡片内以紧凑胶囊小图标展示，悬停预览，点击弹出独立全屏灯箱。

---

## 本地开发与构建

### 1. 环境要求
- Node.js ^20.19.0 或 >= 22.12.0（Vite 8 的要求）
- Windows 10/11

### 2. 启动开发环境
```bash
# 安装依赖
npm install

# 启动 Vite + Electron 联调
npm run dev
# 或分别构建启动
npm run build
npm start
```

### 3. 运行测试
```bash
npm test
```

### 4. 构建发布到便携版
```bash
npm run build
# 将 dist/ 与 electron/ 复制到运行目录即可
```

---

## Agent 本机通信接入契约

本地 Agent 通过轻量脚本契约（`miro-agent.ps1`）与 Miro 连接：
- **注册**：`miro-agent.ps1 -InviteFile <邀请文件> -Name <Agent名称>`，生成连接文件 `sessionFile`。
- **接收消息**：`-Action receive -SessionFile <文件>`（支持长轮询）。
- **发送消息**：`-Action send -SessionFile <文件> -Message <内容>`。
- **安全约束**：Miro 严禁向外部上传凭据，严禁未经授权读取私有本地数据库。
