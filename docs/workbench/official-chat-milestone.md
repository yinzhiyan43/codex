# M2.a 官方桌面纯文本闭环

本文件保留M2.a阶段的测试与当时实现事实。历史读取实现和临时正文限制已由[M2.b报告](history-milestone.md)更新：当前刷新改为includeTurns:false，持久历史使用实际full-turns服务端分页；以下旧阶段结果不代表当前实现。

日期：2026-10-14。前置阶段commit：`98db97444704e22fd7c1023126054cd71b293c61`。固定核心源码 `rust-v0.162.1 / 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`，UI参考 `26.1007.30912 / 20156`，Logo不变。本阶段完成官方聊天的桌面→受限IPC→controller→host→固定schema→JSONL链实现与离线验证；没有新增真实模型调用。完整工作台和真实桌面聊天验收仍未完成。

## 用户如何启动和发送

```sh
cd ~/study/codex/workbench
npm run desktop:chat
```

这是官方聊天入口：使用已有官方CLI管理的当前ChatGPT账号，读取实际GPT目录，默认选择服务端默认模型。左下账号按钮查看当前原生账号状态及套餐标识；不会提供自建凭证输入或多账号存储。需要更换账号时，在终端使用官方 `codex login`，由用户完成浏览器授权，再在界面重连。没有现有ChatGPT登录时预检失败，界面不会回退API key或本地模型。

在输入区右下的下拉框选择服务端可用GPT，输入消息，点击发送或Enter，再在确认框确认一次。重复确认不会启动第二轮。运行时出现停止按钮；停止请求收到ACK后仍显示等待中断确认，只有官方turn/completed的interrupted才标为已中断。失败和结果未知分别展示；断线/重连不会自动重发。

新聊天仅清理当前界面并按下一次发送创建新的ephemeral会话。退出/重连后不恢复旧临时会话；此前已观察内容作为缓存展示，不能冒充新连接的事实。当前UI一次展示一个临时会话，进程内上限8个新会话、每个当前会话64个轮次，草稿4000字符。输入仅纯文本，附件、工具交互、插件创作、本地模型、既有聊天和持久项目未接入。真实调用使用当前ChatGPT套餐额度，未来用户实际发送属于模型请求。

其他入口保持明确区分：desktop为合成演示，desktop:core为空HOME禁网连接诊断，desktop:account为只读原生账户诊断。desktop:chat:smoke使用明确标为离线的协议peer；它不会执行Codex二进制、登录或模型。聊天入口拒绝--core-binary覆盖，真实聊天模式不能被--smoke-output启动为自动真实模型测试。

## 原生认证、配置和请求边界

官方二进制版本/包布局沿用[M1.e核验](core-connection-milestone.md)。prepareOfficialChatCore先以原生CLI验证已有ChatGPT登录，再启动仅配置元数据bootstrap。initialize后config/read校验官方路由和notify/hooks，提取MCP服务器名称，确认bootstrap关闭，重启带MCP enabled=false进程级覆盖的正式host。失败时只有确认子进程关闭才删除自建cwd；关闭未确认时保留目录并报告失败，不宣称清理成功。

发送前再核验完整聊天配置和account/read(refreshToken:false)。provider固定openai，官方URL/chatgpt_base_url明确固定；MCP、notify和hooks必须关闭。chat专用guard还核验shell/unified_exec/view_image/apps/plugins/code_mode、multi_agent及独立multi_agent_v2、agents.enabled、image_generation、browser_use系列和computer_use关闭，web_search=disabled。这样也阻止模型目录偏好重新启用V2代理。所有覆盖仅该进程生效；没有重写用户配置/默认profile、复制auth.json或读取Keychain凭证。官方核心仍管理其自己的登录缓存和刷新。

config/read返回完整有效配置进入主进程内存，通过固定schema校验；MCP处理只使用服务器名称生成覆盖，未输出/持久化命令、env/header或凭证值。renderer只接收脱敏账号、目录、聊天状态与当前消息，没有原始配置、启动参数、路径或任意RPC入口。

thread/start只允许官方GPT、固定主进程cwd、ephemeral=true、read-only和approvalPolicy=never；响应必须确认provider/model/cwd、ephemeral、readOnly且networkAccess=false。turn/start限当前线程、一个4000字符以内的纯文本输入、禁网只读策略和所选目录模型；不开放config、工具输出、附件、steer或权限字段。中断目标来自controller保存的同代turnId，不由renderer传入。RPC结果和通知通过31份固定schema；流式文字使用现有投影与稳定消息ID，不由本地计时器生成模型回应。

“纯文本”是本阶段产品范围与显式关闭的外部能力入口，并非上游通用deny-all-tools能力。固定核心仍可能提供计划/时间/apply_patch等内部工具；只读/禁网/never策略限制权限，静态指令要求文本。这里不宣称底层绝对零工具或已真实验证所有工具拒绝路径。

## 状态、取消及历史兼容

确认后立即锁住新发送，等待thread/turn回复时的停止意图会在获得turnId后只发送一次interrupt。15秒内未确认中断终态会显示结果未知并停止该host；ACK不能当作已取消。终态优先于迟到中断错误，迟到delta不重启已结束轮次。旧意图/旧代结果不会清除新草稿或覆盖新状态。

thread/turn请求结果不明或连接退出时不自动重试。重连只读取账号/目录和核验配置，下一条人工发送创建新临时会话；不会对旧turn执行重放。读取中断开能显式重连，不会永久卡在reading。

历史只针对当前已创建、同代临时线程，刷新调用thread/read(includeTurns:true)，显示失败时保留缓存。hasMore恒为false，与独立canRefresh分开；按钮明确写“刷新当前会话”，不是加载更多。没有调用items分页，也不把schema存在、离线peer成功或登录成功当作真实分页支持。当前固定核心默认存储thread/items/list=-32601的既有真实证据仍成立，未偷偷改core或启用实验接口。

后续兼容路径：先验证真实当前临时线程的thread/read完整视图及turns-list实际载荷，再评估支持的官方存储接口或显式核心升级；items能力必须有成功真实证据和版本记录后才开放分页。不会静默切版本或修改官方数据库。

## 验证与独立复审

- npm run check：31份schema快照/哈希与固定上游一致，类型检查、131/131离线测试通过，失败/跳过/取消0。新增17项覆盖完整协议链、目录选择、重复确认、流式完成、取消时回复未到、ACK/终态、迟到错误、取消终态超时、服务失败、断线未知/不重发、配置/代理/电脑入口拒绝、读取中断线以及bootstrap清理所有权。
- desktop:chat:smoke：后台accessory/offscreen完整renderer→IPC→host→schema→合成JSONL链22组通过，5张截图，控制台错误0。页面、账号和握手都明确标为离线合成；fixture目录和模型不是官方可用性证据。已直接查看就绪、流式、中断、断线与窄布局截图，不抢前台。
- 原合成桌面回归23组通过，控制台错误0。
- 原生元数据核验通过：新启动参数与聊天guard在已有官方0.162.1上生效，type=chatgpt，实际目录7个可见GPT、默认gpt-6.1-sol，modelRequests=0、threadRequests=0，最终host processActive=false，用户config.toml检查前后哈希一致。只记录分类/数量和方法，不输出原始配置或凭证。
- 独立gpt-6-sol/xhigh只读审查：21/21离线定向测试、diff检查通过，未执行原生/模型/GUI。修复取消终态竞态、读中断线无法重连、旧finally覆盖新状态、V2代理遗漏和bootstrap关闭边界；最终未见剩余可复现P1/P2。连接核验中的无效重连按钮已隐藏。

机器证据：[official-chat-results.json](official-chat-results.json)。日志/截图位于仓库外 ~/Documents/Codex/2026-10-14/task-2/official-chat-evidence/。没有上传Library、绕过403、改动上游core或push。全部92项目标保持，只有部分证据更新。

## 仍需真实验证

本阶段没有在真实桌面界面发送模型消息，没有重跑此前唯一的有界GPT冒烟。原生配置/账户/目录成功只能证明新入口的预检，不能证明实际UI中的thread/start、ephemeral响应、完整流式、中断终态或刷新真实历史已通过。首次旧冒烟的endpoint、MCP/notify附带进程及ephemeral返回值测量缺失继续保留，不能由新测试补写。

下一最小实际验收是由用户在desktop:chat中选官方目录模型，发送一条非敏感短文本并停止另一条流式响应，同时确认ephemeral/只读返回及当前线程刷新结果；这会使用模型额度，本轮未自动执行。原生鼠标/键盘、IME、VoiceOver、实际UI长输出/滚动及真实输入操作仍待验证。当前阶段无执行阻碍，真实UI操作和历史成功数据是明确保留的验证缺口。
