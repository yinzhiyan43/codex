# ADR：M1.c 桌面容器与 IPC

日期：2026-10-14。决定：采用 Electron 44.7.2，esbuild 0.28.2 编译 TypeScript，轻量 DOM/CSS 与 Phosphor web 2.1.2。新增依赖只在 workbench/ 固定安装，不修改上游 workspace、核心或根锁文件。

现有协议/host为 TypeScript/Node，Electron主进程可直接复用，减少首个可视阶段的语言桥接。Tauri/Rust桥接与系统WebView路线仍可后续评估；当前不声称完成性能、分发、签名或长期维护成本比较。代价是独立Chromium下载与内存体积；安装包/原生集成待验收。

这是既有仓库的桌面壳实现，保持 desktop-host/ 与 ui/ 分层，不新建 Sites 样板。主进程消费既有 WorkbenchClient 的启动、读取、停止及重连。

## 权限边界

- renderer：nodeIntegration=false、contextIsolation=true、sandbox=true、webSecurity=true，禁用webview。preload只暴露snapshot/dispatch/subscribe，不暴露event、raw IPC、launcher或凭证。
- IPC验证唯一窗口、mainFrame及精确 workbench://app/index.html；明确命令白名单、精确字段和长度/ID限制。只承认合成目录ID，最多8个本地新会话；每秒80次、最多8项并发。订阅有界、可移除。
- 自定义协议只提供固定5项构建资产，无renderer文件路径。CSP禁止网络、iframe和表单导航；会话拒绝网络、权限、创建窗口和跳转。正文只用textContent，不进入HTML。
- 主进程固定启动本包合成peer；没有UI选择真实executable/cwd/环境或turn/start入口。既有真实Codex launcher未调用。
- profile是本次创建的独立临时目录，不使用用户账户、浏览器profile或官方应用存储。正常退出释放host并清理自身profile；持久化后续单独设计。

依据 [Electron security](https://www.electronjs.org/docs/latest/tutorial/security/) 的隔离、sender、导航和权限建议及 [Electron ESM](https://www.electronjs.org/docs/latest/tutorial/esm) 约束。preload为sandbox支持的CommonJS；主入口使用ready回调，避免top-level await等待ready造成停滞。

## 启动策略

普通 npm run desktop 由用户主动打开可见窗口。测试采用accessory/offscreen，不显示、不抢焦点、不请求Dock attention；启动15秒、smoke30秒期限，完成后释放并退出，无自动重启或全局killall。

M1.c IPC只覆盖合成工作台命令。真实协议操作、审批、文件选择、Git/PTY、通知和deep link需独立白名单/授权/验收，不能借demo dispatch绕过host。

## M2.g 窗口所有权补充

主工作台仍只有一个可编辑主窗口和一个控制器/SessionStore/核心。允许最多四个只读会话副窗口，分别绑定固定ID、独立preload/IPC与分页状态；所有副窗共享最多四个读取lease（主窗预算另计）。相同ID复用已有副窗；副窗无草稿或发送权，关闭不dispose共享host。主窗关闭时销毁所有副窗，再保存草稿并停核；重启不自动恢复副窗拓扑。此决定是最小可验收范围，完整可编辑多窗口仍待设计。见[M2.g报告](session-window-milestone.md)。
