# M1.a：首个纯协议适配单元

日期：2026-10-14。状态：本地代码已实现，合成契约测试通过；独立 Sol xhigh 审查及修复后定向复核已完成。不是 M1 全部完成，不是工作台 App 可用。

## 本阶段改动

新增 [独立 workbench 模块](../../workbench/README.md)，未加入官方 Rust workspace，未改变根包及锁文件：

- `contracts/spec.json` / `manifest.json`：分别固定核心、UI 参考和自有客户端身份；记录实际支持白名单，全部实验接口关闭。
- `contracts/schemas/`：复制 15 份固定提交已生成的公开 schema，保留来源及 SHA-256。自有同步/检查脚本核对 HEAD、上游文件和副本，无需运行核心。
- `protocol-adapter/jsonl.ts`：UTF-8/JSONL 分片、多帧及帧大小限制。
- `protocol-adapter/session.ts`：初始化、请求/响应/通知/服务端请求分发、只读 thread/read、审批生命周期、epoch 与断线状态。
- `protocol-adapter/projection.ts`：thread/turn/item 显示投影、终态保护、最终文本替换、延迟快照保护及 stale 标记。
- `tests/`：合成会话记录及纯单元测试；路径、命令、内容均为测试数据，不执行其字符串内容。

使用已有 Node `26.0.0`，仅从官方 npm 注册源安装独立包的固定 Ajv `8.20.0`、TypeScript `7.0.2`、`@types/node` `26.6.5`，禁用安装脚本。依赖锁文件只位于 `workbench/package-lock.json`。没有读取凭证、调用模型、启动 app-server、操作用户项目文件、修改安全设置或推送。

## 验证证据

命令：在仓库 `workbench/` 下运行 `npm run check`。

| 检查 | 最终完整通过结果 |
| --- | --- |
| `npm run contracts:check` | 15 份 schema 与固定 SHA 一致 |
| `npm run typecheck` | 通过 |
| `npm test` | 47 项通过，0 失败、0 跳过、0 取消 |

测试覆盖：逐字节中文/emoji 分片、乱序响应、RPC 错误、未知事件、终态/延迟增量、跨 thread 隔离、只读快照竞争、数值/字符串 ID、审批重复/过期/错误线程、未实现工具/认证请求拒绝、断线及手动恢复、帧/投影/队列等边界。

这为 WB-001、005、006、028–036、037–038、041、044、087–090 提供**部分底层合成证据**，不能将这些工作台验收行标为全部通过；例如 WB-028 的真实 start/resume/fork 仍未实现。全部 92 项目标保留。

## 审查与剩余缺口

独立审查模型：`gpt-6-sol`，reasoning effort `xhigh`，只读审查。初次38项测试通过后，审查发现以下问题，均已修复并加入定向回归：

| 发现 | 修复与证据 |
| --- | --- |
| 多次断线覆盖未恢复记录 | 跨 epoch 累积保留；显式只读快照或本地提示确认才清除对应记录 |
| 审批已解决仍交付排队答复 | 按请求方向与类型撤回出站响应，不误删同 ID 客户端请求 |
| 超时结果未知却不进入恢复计划 | 已取走帧计入 unknown；未取走帧撤回并报告 not-sent |
| turn 终态后晚到 item 完成文本丢失 | 保持 turn 终态，允许最终 item 数据补齐，仍拒绝晚到 starts/deltas |
| 服务端请求及恢复数据缺少总字节预算 | 总字节与条目预算、哈希签名、resolved 后清参数；有界 tombstone 防重开 |
| 合法大批次依赖宿主分块 | 按64KiB内部增量解码，只对每帧实施帧限制 |
| 主动断线将尚未发出的请求误报未知 | 与超时路径一致：未取走为 not-sent，不添加不必要恢复记录 |

修复后45项测试通过；定向复核新增两项边界问题，修复后47项通过。最后 Sol xhigh 定向复核确认合法大批次、已发/未发断线路径通过，未发现相关修改的直接回归。审查没有覆盖真实 transport、生产 host 或完整工作台。

后续进展：M1.b stdio host 已实现，见 [host 阶段报告](transport-milestone.md)。本报告的 47 项结果为 M1.a 历史验证。待实现：完整协议分页、模型/配置/登录、turn/start 等会话操作、其他审批/用户输入、实验功能、持久化及 UI。桌面容器 ADR 尚未决定；M1.a 只决定采用与本地现有工具匹配的 TypeScript/Node 纯协议模块。

应用观察拒绝继续有效，没有再次尝试或使用替代手段。用户随后主动提供的截图按 [参考记录](reference-observations.md) 登记可见状态；其他视觉与跨 Chat/Work/Codex 范围仍待证据。
