# M1.c：可启动桌面壳与合成工作台

日期：2026-10-14。状态：本阶段实现、合成检查及独立审查完成；完整工作台与92项目标尚未验收。固定核心/UI基线不变，未push。

## 可运行范围

Electron壳接入M1.b StdioWorkbenchHost，只连接本包合成Node peer。主导航外壳、项目/会话列表、搜索空态、消息区、项目空页、上下文/输入区、账户菜单与右侧演示详情已实现。交互包括切换/返回、分别保留草稿、确认/返回编辑、重复点击防重、合成回应/停止、断线缓存与显式重连。

项目页首次确认创建local-N会话，最多8个并加入侧栏；本地消息和fixture历史分开，返回/重连保留完成及取消记录。未实现turn/start、官方登录、账户状态或真实项目管理；后续主导航禁用，不模拟执行成功。

见 [桌面 ADR](desktop-adr.md) 与 [设计 QA](../../workbench/design-qa.md)。原图及个人数据未入Git；本轮直接查看U-01/U-02，不声称其他截图在此executor新读取成功，未观察Qoder CN。

## 启动方式

已有本机依赖与Electron运行时已准备完成：

```sh
cd ~/study/codex/workbench
npm run desktop
```

此命令打开可见窗口，由用户主动启动。本任务结束时未保持窗口运行。依赖重装：npm ci --ignore-scripts --registry=https://registry.npmjs.org，再运行官方包 node node_modules/electron/install.js 安装锁定运行时，不运行官方Codex核心。

离线检查：npm run check。后台渲染/交互：npm run desktop:smoke -- /absolute/private/output-directory，不显示、不抢焦点，成功后自动退出；结果和截图写指定仓库外目录。

## 验证

| 检查 | 最终结果 |
| --- | --- |
| 固定schema | 15份通过，核心SHA未变 |
| 类型/桌面构建 | 通过 |
| 合成测试 | 85/85；0失败、跳过、取消；新增10项IPC/controller测试 |
| Electron后台smoke | 15组通过、6张最终PNG、控制台错误0 |
| Sol xhigh独立审查 | 两项P2修复后定向复核通过，无剩余P1/P2 |
| 本阶段设计QA | passed；完整视觉一致性未验收 |

审查修复：fixture重读覆盖本地消息→分离并合并缓存；新聊天复用项目键→分配独立有界ID。新增返回/重连、取消记录、新会话、完整消息与24字标题分别断言；旧路由草稿带routeId，防止延迟写入污染新页。

运行时下载起初较慢。首次可见启动停在ready等待，已终止并改用回调；第二次产生早期截图后遇到smoke等待时机断言失败，改为等待实际状态/paint。用户反馈Dock跳动时停止并核查本任务实例；无自动重启、bounce/requestAttention。后续后台smoke成功自动退出。专属二进制和main/peer参数查询无残留，不操作其他Electron应用；未直接观察用户Dock状态。

## 截图与未验证项

最终证据在本任务私有目录 desktop-evidence/final-icon/，未入Git：empty-final.png、conversation.png、submitted.png、disconnected.png、narrow.png，另有empty.png与smoke-results.json。

未验证：真实核心二进制、官方登录/额度/模型、真实turn、分页、用户项目读写、持久化/重启恢复、审批UI、原生键盘/IME/VoiceOver、多窗口、Mac分发/签名、完整官方视觉匹配。全部92项目标保留，本阶段只提供相关行部分合成证据。

下一阶段建议先补thread/turn分页与审批UI合成契约，并核对键盘/IME/焦点；真实模型与凭证需另有授权，不自动开始。

用户选定生成图标已原样接入，来源与SHA见 [图标记录](../../workbench/assets/README.md)。保留素材现有浅灰背景，不重绘或叠加外框；主进程配置Mac Dock和窗口图标，后台核验1254×1254原生解码。未为查看图标另开前台窗口。

最终项目空页另存Library，ID [内部文件标识已省略]；其界面与最终图标配置轮次相同，Library仅保存自有合成截图，没有保存用户原图。
