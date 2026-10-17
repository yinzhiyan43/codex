# M3.b 工具展示、一次性审批和补充输入交互

日期：2026-10-17。基线 `02eaee06f30e99f7b9063263174b28c190ad7d4c`。本轮完成可控编码工作流的协议/UI底座，真实编码执行仍未开放。仅本地提交，不push；保留原92目标与未完成范围。见[范围方案](tool-workflow-plan.md)、[机器证据](tool-workflow-results.json)及[使用说明](daily-use.md)。

## 行为与归属

主副窗显示有界命令、文件修改、计划、推理摘要、MCP/动态工具与代理状态；没有详细视图的固定item类型明确提示。只呈现协议已有事实，不执行内容、不显示隐藏推理、不引入终端或任意命令输入。保存历史也按正确线程显示工具卡，当前轮次实际失败原因与工具declined/failed/interrupted不混成成功。

新待处理请求优先于已结束卡及工具历史。命令审批显示完整命令、cwd、原因与类型，并匹配同thread/turn/item；文件审批从对应fileChange item取得完整changes/path/kind/diff/move_path，缺失、超限、越界、writeStdin或非null grantRoot（包括空字符串）不能同意。只允许固定accept/decline/cancel，永不回传会话授权、execpolicy或network amendments。

答复由主进程绑定真实sender、当前route、执行窗口、thread/turn、host generation及opaque请求key。句柄保留在主进程，ProtocolSession再次校验pending与单次状态。答复后等待serverRequest/resolved；实际轮次终态使未决答复失效并撤下尚未写出的响应。重复请求/重复点击/晚到resolved/旧连接不重放。旧连接的stale终态缓存不能错误关闭新连接的新请求。

同会话其他窗口只观察，异会话没有请求；原执行窗口关闭后，同会话窗口需明确接管此轮待处理请求，不取得草稿编辑权，也不换执行目标。异步根核验返回后再次核对窗口与请求；关闭中的窗口也不能答复。断线及结果不明保留未知执行锁，不把重连当作重试许可。

## 补充输入的真实语义

复用固定源[输入参数/答案类型](../../codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputParams.ts)，新增两个原样复制并校验哈希的schema，现有固定源码导出schema共53个，加2个此前固定的实验搜索schema。request_user_input类型仍标为EXPERIMENTAL，不把导出存在当作默认可触发能力。

每题单选或自由文本，备注按[官方TUI编码](../../codex-rs/tui/src/bottom_pane/request_user_input/mod.rs)回传选项标签及`user_note: ...`；答案数组不代表任意多选。每题必答是本产品限制。跳过回空answers，核心可能继续；停止走当前turn/interrupt，不发送空答。isBlocking明确区分，过期依resolved/轮次终态/连接代次，不用弃用autoResolutionMs假造结果。

秘密输入不收集，界面及底层均拒绝提交秘密值。普通答案不进入DesktopView、sessions.json、工作台日志或答案历史，提交/终态后清空表单；官方核心自身可能保存普通答案，未承诺服务端不记录。未提交表单关闭后不自动恢复或重发，消息草稿继续沿用既有独立持久保护。

## 执行边界

现有真实会话的工具禁用配置、文本指令、approvalPolicy=never与readOnly沙箱完全保持。真实模式收到意外审批时同意始终禁用；只可拒绝或取消既有请求，不因请求出现而开放工具。accept只由必定启动假服务的offline模式测试，合成命令和补丁没有实际执行。

本轮没有开启独立编码会话、官方工具feature、workspace-write或持久权限；没有command/exec、process/spawn、writeStdin桥。MCP elicitation、dynamic execution和permissions请求继续回明确unsupported。固定源的[Default/Plan输入测试](../../codex-rs/app-server/tests/suite/v2/request_user_input.rs)表明真实Default模式还需要额外feature；本轮未开启，不宣称默认真实会话已经能主动发问题。

下一步真正编码执行需独立明确模式、已核验目录、工具feature/策略回包、限定写根与环境/链接边界的单独设计和验证；不能直接复用本轮离线合成accept分支放开真实权限。此处是未实施的后续范围，不是一次已拒绝或结果未知的执行。

## 验证与复审

- 319/319离线检查通过，较基线新增18项：协议/输入边界5项、协调/审批/断线/归属12项、工具投影边界1项。固定契约与TypeScript通过。
- 新增20项隐藏Electron检查，3次App运行：交互15、重启2、断线3。检查完整命令与补丁、一次性同意/拒绝/取消、禁止stdin/会话授权、单选/备注/必答、skip与stop、秘密值拒收、观察隔离、关窗显式接管、待处理优先、答案不落盘/回显、重启及不明结果不重放。假服务没有执行命令或应用补丁，隔离仓库tracked文件及Git索引字节保持。
- 既有263项隐藏回归通过：仓库20、可编辑多窗34、键盘24、搜索14、主题25、设置22、原窗口23、复制23、编辑24、管理31、合成桌面23。总计283项、28次App运行，renderer错误0；有关闭账本的全部副窗、读取及核心均结束。
- 独立只读复审确认空字符串grantRoot例外已修复，最后微调的单快照复用、待处理排序和表单清空未削弱校验，最终没有已确认剩余P1/P2。最初关窗疑点经进一步核对确认原有二次snapshot已经拒绝已删除窗口；本轮补防御性closing门控及真实unknown-window回归，未把撤回疑点冒称漏洞。
- 开发期修正：根据上游/TUI把空答案与取消区分；避免旧代次stale终态误判新请求；客户端能力白名单仅新增typed输入答复，仍禁止任意RPC。只统计最终成功结果，失败开发尝试不计通过。

工具卡≤128个/128 KiB详情，单工具内容8K字符并标截断；请求缓存≤64，审批材料超过16K字符禁同意，文件范围≤32项。问题≤3、每题选项≤8、备注≤1000字符，秘密值不提交。一次视图复用一个host快照，避免逐卡复制大投影。真实巨大工具流性能未验收。

全部测试只使用本轮新隔离仓库、合成事件和假服务；零真实模型请求、零模型工具执行、未运行官方核心。受限文件助手与Git仅用于新合成根检查，不能混称模型工具。未改其他个人项目、日常窗口、共享配置、模型/推理/速度、账号权限、核心SHA、Logo、许可或依赖锁文件，未push或改main。原生Tab/IME/VoiceOver、多屏/全尺寸与参考视觉完整对照仍待验收。
