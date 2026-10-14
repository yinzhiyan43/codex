# M1.c 合成工作台设计 QA

日期：2026-10-14。本次比较范围是桌面壳、导航、项目空态、合成会话和输入区，不是整个官方应用的视觉验收。

## 证据与归一化

本地证据位于仓库外；以下路径相对本文件所在的 workbench/。原图、个人信息和比较裁切未加入 Git。

- Source visual truth：../../../Documents/Codex/2026-10-14/task-2/private-ui-reference/reference-2.png（2048×1191）；reference-1.png（2048×1171）。本轮经当前 Library 支持流程物化，代理直接查看两张。
- Implementation：../../../Documents/Codex/2026-10-14/task-2/desktop-evidence/final/empty-final.png、conversation.png、disconnected.png、narrow.png。
- 大窗口 CSS viewport 1536×894，最终 offscreen PNG 同为1536×894，density 1；窄窗口900×650。参考按0.75缩放至1536×893 / 1536×878。原图逻辑尺寸与原始设备密度未知，不声称核实了 @2x。
- 全图比较：归一化 U-02 与最终 empty-final 在同一次图像输入中比较；U-01 与 conversation 同时查看。会话参考高度略短，按相同宽度比较各区域，不给出整页像素误差。
- 局部比较：../../../Documents/Codex/2026-10-14/task-2/private-design-comparison/reference-composer.png 与 implementation-composer-final.png；来自归一化页面 x580–1255、y745–890，两图一起输入。
- 状态：深色、中文、项目空页；会话打开账户菜单及右侧详情。项目、账户和正文均为虚构内容。参考的长历史和更多菜单不复制到本阶段。

## Findings 与比较历史

1. 早期截图存在状态时机问题：未等待 renderer 更新/合成读取结束便断言或截图。早期两张不是最终证据；改为等待 DOM 状态和两次 animation frame。
2. [P2，已修复] 空态标题低约8–9px；项目节奏偏松、输入卡偏高。empty top 从37%改36%，减少 heading/project-row 间距，调整输入 padding/底边距。
3. [P2，已修复] 字体光学重量偏厚。增加 antialiased，空态标题300重量；修正后重新捕获并比较，没有本阶段尚需修复的 P0/P1/P2。
4. 最终全图及输入器局部重新比较。导航、输入和断线提示可见；窄窗口无横向溢出，发送控制未被遮住。

## 五项视觉表面

| 表面 | 本阶段结论 |
| --- | --- |
| 字体与文字 | 系统 Apple/PingFang 字体栈；正文13px、标题24px，未下载字体。消息换行、长文本滚动，侧栏标题有界。准确官方字体 token 未取得，仍为完整验收缺口。 |
| 间距与布局 | 顶栏42px、一级45px、二级259px；主区独立滚动，输入器最大660px；详情278px轨道。根据归一化参考修正空态与输入器，窄窗口保留控制。 |
| 颜色与 token | 深色背景/侧栏/输入卡及蓝色用户气泡层级对应参考；统一 CSS token、可见焦点轮廓。未声明像素相似度或完整无障碍认证。 |
| 图像/图标 | Phosphor 正规图标包/本地字体，无手绘 SVG/CSS 图案或私人图片占位。macOS提供原生窗口控制，offscreen截图不含 native traffic lights。空态官方图案和头像使用演示图标，是明确身份/阶段差异，不宣称品牌资产1:1。 |
| 文案 | 保留新聊天/项目/此计算机/随心输入等结构，明确合成演示/合成模型；未复制个人正文或账户，后续能力有禁用状态。 |

## 交互与限制

真实 Electron 窗口曾运行；用户反馈 Dock 跳动后停止本任务全部实例。最终采用自有 Electron accessory/offscreen，未调用 show/focus/bounce；仅通过 webContents 操作本应用，未使用用户浏览器或官方 App。

15组 smoke 检查覆盖连接、renderer 无 require、导航、路由草稿、重复点击、确认/返回、停止、合成回应、断线缓存、重连、新建/返回、搜索空态、窄窗口、控制台。最终控制台错误0，结果在仓库外 desktop-evidence/final/smoke-results.json。

原生鼠标/键盘、IME、VoiceOver、拖拽、多窗口、真实模型、其他主题和全部92项目标不在通过范围。DOM click 不能替代原生输入实测。身份图案、账户菜单数量、历史内容与禁用的后续功能属于有界阶段差异。

## Implementation checklist

- [x] 直接查看参考，归一化全图与局部一起比较。
- [x] 修复本阶段 P2，重拍并复验。
- [x] 独立审查状态修复后复核通过。
- [x] 合成交互检查通过，最终实例退出。
- [ ] 后续核对原生输入、完整资产/token和其他界面状态。

final result: passed

## M1.d 分页与审批补验（2026-10-14）

最终证据：../../../Documents/Codex/2026-10-14/task-2/pagination-evidence/final-verified/；包括10张合成 PNG 与 smoke-results.json。代理直接检查取消后的历史按钮、已加载历史、待答/失效/断线审批和900×650窄窗口；新控件可见，输入器及发送按钮未遮挡。审批区独立滚动，已解决卡片可滚动查看；会话历史独立滚动。新增状态无对应完整官方参考，不把本次检查当作官方审批/分页界面的视觉一致性验收。

最终100项合成测试和23组后台界面检查通过，控制台错误0。重复消息保持 DOM 节点，审批焦点在状态更新后保留。检查一次 resize 后 capturePage 返回 UnknownVizError；只为这一错误增加最多3次、间隔150ms的隐藏截图重试，最终整套重跑通过。最终仍使用 accessory/offscreen，未显示或聚焦窗口；精确路径进程检查无本任务残留实例。

原生中文输入法、鼠标/键盘、VoiceOver、完整主题/资产以及真实核心仍未验证。本轮没有重新上传截图或尝试绕过父任务读取 Library 截图的403拒绝；本地合成证据保持在任务目录。
