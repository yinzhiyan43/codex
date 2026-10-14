# M1.e 官方核心连接、原生认证与有界模型验证

日期：2026-10-14；前置 M1.d `1458b58133def64b98c3aa8b6987445c211d5a35`。本阶段实际运行官方 0.162.1 app-server，验证握手、只读错误、退出/重连和界面状态。随后用户明确授权官方 CLI 登录复用与一次有界 GPT 测试，并要求只用官方模型。已有 ChatGPT 登录有效，无需新的 OAuth 授权；唯一真实冒烟包含正常输出及取消两个 turn。本次收尾没有重跑模型。完整工作台仍未完成。

## 二进制与源码基线

核心源码固定 `rust-v0.162.1` / `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`；UI参考仍为 `26.1007.30912 / 20156`，最新已选 Logo 保持原文件。现有 Mac Apple Silicon 安装为官方 npm `@openai/codex` 0.162.1，平台包 `0.162.1-darwin-arm64`，vendor manifest 的 target 为 aarch64-apple-darwin。原生 `--version` 返回 `codex-cli 0.162.1`；本次二进制 SHA256 为 `74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0`。

使用已安装平台包内原生 bin/codex，避免 shell 或全局 JS wrapper。匹配版本、平台、包仓库元数据和布局均校验；此 SHA 是本机字节身份记录，不是独立发行签名或二进制→源码提交的密码学证明。没有下载/安装/构建上游，也未改变任何系统安全设置。若需要源码构建，仓库 [安装说明](../install.md) 使用 cargo build；固定源码要求 Rust 1.95.0，CLI package为codex-cli、bin为codex，可在隔离构建目录执行 cargo build --locked -p codex-cli --bin codex。本阶段未执行此备用路径。

## 隔离与授权边界

`--official-core` 每次隔离测试/桌面启动在 workbench/tests/real-core/.runs/ 建立全新 HOME、CODEX_HOME、cwd及tmp；目录0700，配置0600，无继承用户环境变量。只提供这些路径、固定 PATH 与语言；不会继承 API key、代理、用户配置或原有 CODEX_HOME。CLI和MCP凭证存储设为file，关闭更新检查/analytics/otel/secret auth storage。此隔离入口没有读取/复制真实 auth.json、Keychain凭证或既有聊天；没有登录、授权保存、thread/start或turn/start。后续账户与模型入口的范围另见下文。

子进程通过 sandbox-exec 加测试策略：网络全部拒绝，写入限新建run；用户存储根（当前 HOME、/Users、/Volumes、/tmp与/private/tmp、/private/var/folders）内容读取拒绝，只有该run例外。metadata/xattr读取限明确系统运行库、该run及必要父目录元数据；Keychain的securityd/secd mach lookup规则配置为拒绝。原生哨兵验证当前HOME外的合成文件，以及/tmp合成文件、目录列举、元数据均被拒绝，并验证网络监听返回EPERM/EACCES。没有尝试读取真实凭证来验证Keychain规则。

此策略是**当前无登录/模型调用的测试专用约束，不是全盘文件内容白名单**；其他非用户存储根的系统数据内容未全局封锁。尝试全局 file-read-data 白名单使macOS加载器在--version前SIGABRT；分别诊断策略项后采用上述明确范围。辅助Node哨兵需要Homebrew opt/Cellar库的元数据访问，已按实际错误补齐系统软件路径。没有绕过系统拒绝、修改安全配置或为真实凭证新增允许项。

正常测试与窗口关闭后清理各自新建的隔离目录；预检失败清理自建run。开发期发现测试产物仍保留在忽略的.runs时，只清理本阶段自建产物，不触及用户目录。真实二进制/launcher参数只由主进程配置，不经过renderer IPC。

## 实际协议结果与 UI

初始化响应通过固定schema，返回codexHome确为该次新建目录，platform为macos/unix，userAgent含0.162.1。随后发送initialized；未知remoteControl状态通知保持诊断隔离，不向界面转发机器标识或原始payload。

只对固定不存在UUID线程 `00000000-0000-4000-8000-000000000000` 做读取，实际结果：

| 方法 | 实际错误 | 结论 |
| --- | --- | --- |
| thread/read | -32600：thread not loaded | 空环境不存在该检查线程，连接继续ready |
| thread/turns/list | -32600：thread not loaded | 空环境不存在该检查线程，未取得成功分页数据 |
| thread/items/list | -32601：not supported yet | 当前默认存储实现不支持；不能由schema存在推断真实可用 |

源码 thread_processor 的 ThreadStoreError::Unsupported 分支与第三个结果相符。登录不会自动证明或修复此存储接口限制；后续需要单独核实已支持的官方存储/协议路径，不改核心来伪造支持。本阶段未启用新的实验能力或切换版本。

新 `CoreController` 只允许连接、断开、显式重连、固定只读检查和清错误。renderer只能触发probeCore，不提供线程ID/路径/任意RPC；草稿、发送、新聊天、账户及合成导航在此模式禁用。顶部、窗口/应用名称及状态卡明确“官方核心隔离连接”，没有合成项目、消息或审批。握手确认与仅目标版本区分；错误、停止和重连在同一真实host状态下展示。原 `npm run desktop` 合成演示保留为独立入口。

## 官方原生认证与唯一 GPT 冒烟

账户入口 `--official-account` 使用官方 CLI 已管理的现有 HOME/CODEX_HOME，官方核心原生读取和管理自己的登录态；代理/UI不打开或复制 auth.json、Keychain 或浏览器凭证。native login status 返回已使用 ChatGPT 登录，account/read（refreshToken:false）返回 type=chatgpt；实际账户套餐字段在公开报告中省略。此标识原样展示，未推断为其他套餐名称，未读取或承诺剩余额度。实际 model/list 返回7个可见GPT，默认 gpt-6.1-sol；不硬编码可用目录或回退 API key/local provider。

账户入口可联网，不能套用前述禁网空HOME隔离声明。它保留用户原始配置/默认profile文件，使用进程级 `-c` 覆盖官方 provider/URL、notify=[]、features.hooks=false、关闭analytics等；日志/状态和cwd放入自建临时目录。host先 config/read 校验有效官方路由与通知/hooks，才读账户/模型目录；返回给controller的是void，原始配置不会进入renderer。账户页仍只读，不能发起真实模型turn或读取旧聊天。

唯一真实模型冒烟在本次收尾之前完成，新线程发送 ephemeral:true，使用服务目录默认 gpt-6.1-sol，低推理档，纯文本固定请求，无项目材料。正常 turn 4个分片，12字符，最终 WORKBENCH_OK，completed；第二个turn首片后发 turn/interrupt，6个分片、6字符，ack=true，终态interrupted。两次 turn/start 属于同一次有界冒烟，非两轮重复测试；退出码0、无signal，观察到的tool item数0。原始JSON完整保留，未修改旧测量。

**首次测试的证据边界：** 初次脚本未记录有效endpoint，未监测继承的MCP/notify附带进程或连接，也未保存/断言服务返回的ephemeral值。toolItems=0不能证明没有附带进程。后续当前配置只读快照确认provider=openai、endpoint为official-default，同时发现1个启用MCP及既有notify命令；该快照不能倒填首次请求时的测量，也不能证明首次没有外部副作用。没有观察到错误路由的证据，但不声称已核验首次网络目的地或无历史持久化。

后续脚本明确固定官方端点，initialize后**先config/read校验有效provider/URL/notify/hooks**，再仅根据已配置MCP名称生成进程级整表enabled=false覆盖；关闭元数据bootstrap子进程后重启，二次config/read确认所有MCP禁用，才读账户/模型目录及允许未来建线程。未来真实路径还会断言返回ephemeral=true。config/read实际把完整有效配置送入本地脚本内存并通过schema校验；脚本在MCP配置中只使用/记录服务器名称，不把命令/env/header/凭证值写入覆盖参数或证据文件，不持久化原始配置。原生核心保留自身必要的凭证管理行为。

最终新增验证仅使用 --verify-model-configuration：两次config/read均先于account/read和model/list，routeGuardConfirmed/configurationGuardConfirmed=true，模型请求0、无thread/start，进程干净退出0。原用户config.toml在此次最终元数据/UI检查前后哈希一致；实现不写用户配置文件。此验证证明新增守卫路径，不追认旧冒烟缺失测量。禁止为补证再次花费模型额度。

## 验证与独立审查

- 最终 npm run check：25份固定schema、TypeScript、114/114离线合成回归通过，失败/跳过/取消0；包含路由拒绝时阻止账户/目录读取、受限config/read、账户失效状态和旧结果隔离。
- 本阶段既有 npm run core:check：显式opt-in原生测试6/6通过；真实握手/错误、异常退出、新epoch重连、正常EOF退出码0及dispose均验证。该历史原生证据本次未重复执行。
- 本阶段既有隔离UI12组、启动失败5组、合成UI23组通过；修复后账户UI15组通过，均控制台错误0。全部accessory/offscreen，不show/focus或Dock attention。账户页正常/窄窗口截图已直接检查，未显示邮箱或凭证。
- 独立 gpt-6-sol / xhigh 只读审查：修复旧connect结果覆盖、账户退出busy状态、官方URL显式覆盖、notify/hooks与MCP守卫以及模型目录读取早于有效配置guard的问题。最终离线定向85/85、typecheck、diff检查通过，未见新增可复现P1/P2；审查未运行原生、模型或GUI。

机器结果：[core-connection-results.json](core-connection-results.json)。日志/截图保留仓库外 `~/Documents/Codex/2026-10-14/task-2/real-core-evidence/`，包括native-check.log、synthetic-check.log、ui-final/、ui-start-failure-final/及synthetic-ui-final/。代理直接检查真实错误、窄窗口和启动失败截图；新状态没有完整官方视觉参考，不声称1:1。未上传Library或处理父任务截图403限制。

## 启动及下一步

```sh
cd ~/study/codex/workbench
npm run desktop:core     # 空HOME、禁网的官方连接检查
npm run desktop:account  # 复用现有官方CLI登录，只读账户和目录
npm run official:status  # 官方路由前置校验后的账户/目录状态，无模型turn
```

后台证据入口 desktop:core:smoke / desktop:account:smoke 只在明确选择时运行。official:model:smoke 是未来显式有界模型测试入口，本次收尾未执行。默认desktop仍为合成模式；当前二进制预检限macOS arm64已有官方npm包，失败不回退其他来源或合成成功。

下一最小步骤是把已有协议流式投影与取消状态接到桌面真实thread/turn闭环，先离线验证请求去重、线程隔离、取消与迟到事件，再单独决定后续真实验证；当前账户页发送保持禁用。真实成功历史分页仍未通过，thread/items/list的默认存储-32601限制独立存在；原生IME/VoiceOver、完整视觉及其他里程碑尚未验收。全部92项目标保留，仅追加部分证据，不将真实文本冒烟当作完整聊天产品通过。

本阶段已完成，无当前执行阻碍。首次附带进程/endpoint/ephemeral历史测量缺失是保留的证据限制，不能补造结果。未改上游核心、用户配置或Logo，未push、上传Library或绕过403。
