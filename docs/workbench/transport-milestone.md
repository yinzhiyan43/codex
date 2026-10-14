# M1.b：stdio host 实现与验证

日期：2026-10-14。状态：M1.b 已实现，经应用更新重启后复验通过；完整 M1、真实核心连接和工作台仍未验收。

固定核心 `rust-v0.162.1 / 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`；固定 UI 参考 `26.1007.30912 / 20156`。应用更新没有改变这两个基线。M1.a 基础本地提交为 `93cbabb788c03716d2134846e55ff9307ad50703`。本阶段只修改 `workbench/` 和 `docs/workbench/`，未推送。

## 实现范围

- `desktop-host/launch.ts`：由可信主进程提供绝对 executable/cwd；固定参数 `app-server --listen stdio://`，`shell: false`。环境变量仅接受 HOME、CODEX_HOME、PATH、TMPDIR、LANG、LC_ALL，不自动继承宿主全部环境。配置经校验并复制；测试未调用真实 Codex 启动器。
- `desktop-host/stdio-host.ts`：拥有单个子进程、初始化、逐帧发送、写回调与 drain 背压、stdout JSONL 解码及 stderr 排空。断线不自动重放；未发请求与结果未知的请求分别处理。协议层新增观察接口和逐帧出队，不新增隐藏的 host 出站队列。
- `desktop-host/client.ts`：提供启动、显式重连、停止、释放、只读 thread/read、审批答复及快照订阅。界面侧接口不提供可执行路径、任意 RPC、原始流或凭证；真实桌面 IPC 尚未实现。
- 进程 exit 后进入 draining，禁止新操作并处理已缓冲 stdout；有界等待后释放本 host 管道。只向仍存活的本 host 子进程发送退出信号；不管理其他用户进程。close 后释放监听器、计时器与订阅。
- 诊断只保留有界代码、stderr 字节数及退出信息，不保留原始 stderr、错误消息或协议正文。订阅通知合并并隔离异常。

## 复验与审查

应用重启后确认全部源文件保存，暂存区为空，核心目录相对固定提交无差异，两次独立审查均已完成。使用已有 Node `26.0.0`，未新增依赖。命令：在 `~/study/codex/workbench` 运行 `npm run check`。

| 检查 | 结果 |
| --- | --- |
| contracts:check | 15 份 schema 与固定提交一致 |
| typecheck | 通过 |
| test | 75/75 通过；0 失败、跳过、取消 |
| host 测试 | 28 项；其余 47 项为 M1.a 回归 |
| 独立审查 | `gpt-6-sol` / `xhigh`；最终定向复核通过，无剩余阻塞项 |

测试 peer 是独立的合成 Node 进程，只使用测试协议数据，不运行上游代码、模型任务或用户命令。覆盖分片中文、初始化错误/超时、崩溃、stderr、错误/截断 JSONL、写背压、审批、显式重连、关闭升级、缓冲最终响应及退出后继承管道。

| 审查发现 | 修复与回归 |
| --- | --- |
| 等待旧进程 close 的 reconnect 在后来 stop 后仍会重启 | 生命周期意图序号；后来 stop/dispose 取消等待中的重连 |
| 首次 dispose 超时后缓存拒绝，晚到 close 无法完成释放 | 保留释放意图；晚到实际 close 完成 disposed，阻止重新启动 |
| exit 后继承 stdout/stderr 使 host 继续 ready 或无限等待 | draining 状态、关闭期限及释放本 host 管道 |
| 仅继承 stderr 的退出路径仍尝试 kill 已退出 peer | 所有退出信号路径检查 exited；回归确认 `killCalls: []` |

重启前的全局进程清单无法核实：进程查询服务不可用，恢复后的只读 `ps` 也被系统拒绝。没有杀死未知或用户进程。本次测试命令正常退出，测试创建的直接子进程资源清理断言通过；继承管道的合成后代只运行 500ms 自动结束。

## 验证限制与后续

未启动真实 Codex app-server、读取凭证、登录、调用模型、操作用户项目或修改安全设置。真实二进制兼容性、系统进程树管理、桌面 IPC/容器与打包仍待验收。stdin 错误路径使用合成 stream error；close-stdin fixture 没有可靠触发实际 OS EPIPE，不声称已实测 EPIPE。

完整分页、模型/配置/登录、turn 操作、其他审批和用户输入、实验接口、持久化及 UI 仍待实现。全部 92 项目标保留；本阶段证据只覆盖协议/host 的相应底层部分，不把任何工作台验收行自动标为通过。本次恢复到此阶段收尾，不擅自开始 UI 或升级基线。
