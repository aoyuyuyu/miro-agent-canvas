# Miro 0.8

Windows 便携版：双击 Miro.exe 或“打开Miro.cmd”。无需重新构建。

## 本轮修改

- 改为浅灰背景、白色卡片和细灰连线，保留唯一红色历史开关。
- 使用本机高清原始图标：WorkBuddy 1024 像素、Antigravity 512 像素、Hermes 矢量图和 Codex 原始图标。
- 同一助手软件只显示一个头像。点击头像筛选历史，再点恢复全部。
- 每个画布任务首次发送新建独立原生聊天；后续回复继续这份新聊天，不发回开发聊天。
- Codex 使用桌面新聊天接口。其他已检测到的本机 CLI 助手使用 Orca 原有窗口和发送能力。WorkBuddy 图标对应 CodeBuddy CLI，新任务会出现在它的原生 CLI 历史中。
- 历史来自本机记录、Orca 和 Nowledge；保留原生标题和用户/助手可见文字，合并相同原生编号。
- 后台通过 Nowledge 原有导入器同步 Codex、WorkBuddy、CodeBuddy、Hermes、Antigravity、OpenCode。已接入 Miro 的助手可读取共享历史和工作记忆。

## 操作

底部输入固定。白框右上角加号选择多个助手；未选择就只存到画布。右下角大加号立即复制接入提示词。红色历史按钮始终存在。单击历史标题展开或收起；双击或拖放移到更大画布窗口，红点收回。卡片可拉大和移动，自动避让。连线中间按钮断开，端口可重新连接。右上角依次为最小化、全屏、关闭。

## 当前边界

Orca 和 Nowledge 是本机现有依赖；其他助手的新窗口需要 Orca 正常运行，记忆读取需要 Nowledge 本机服务。不会把不可用助手的消息回退到旧窗口。同步历史不等于每个模型自动读完全部记忆；接入协议提供主动读取入口。

一份 Antigravity 记录目前没有可读用户正文，导入器未导入该条。图片、附件、工具结果和隐藏思考不属于本轮全文文字镜像。Hermes 使用本机旧版时，首次创建可能需要等待其工具初始化，最长等待约两分钟。

## 代码来源

直接复用 stablyai/orca 的本机通信、进程启动、Agent 配置、CodeBuddy 解析和主题/图标。许可证和固定提交见 CODE_ORIGINS.md。未声称已达 80%。

## 从源码运行

安装项目依赖后执行 npm run build:vendor，再执行 npm start。Vite 使用相对资源路径，Electron 通过 loadFile 加载构建页面。打包脚本为 scripts/package-windows.ps1，指定新输出目录即可。
