# M2.l 键盘操作与基础无障碍

日期：2026-10-16。基于已公开开发分支 `231f3aa4ba2b337e1a6a9f46cd8493b397fb1722`。本阶段只本地提交，不再次推送；`main` 不变，原92个目标全部保留。官方核心、Logo、用户模型/推理/速度及共享配置不变。

## 实际实现

会话按钮支持 Shift+F10 / ContextMenu 打开操作菜单，打开后焦点进入首个可用项；上下方向键循环、Home/End 跳转、Escape 返回源线程，Tab 关闭菜单并保留后续原生移动。菜单使用单一 Tab 入口、显式 expanded/controls。外部点击或焦点离开关闭弹层；侧栏元数据重绘前关闭菜单，再按稳定线程/分组键恢复焦点，避免 aria-expanded 与实际显示失配。相同侧栏状态不再随每条流式通知重复重建。

主窗四个原有弹窗补齐名称/描述；设置保留原有名称，分类改为纵向 tablist/tab/tabpanel，支持上下键、Home/End 与单一 Tab 入口。原生 modal 继续提供模态隔离，并补首尾 Tab 环绕。统一捕获打开来源，在异步读取前记录，并在关闭后解析仍存在的对应控件；源控件消失时回退主内容。确认发送初始聚焦“返回编辑”，取消后再回草稿；排队的旧 close 事件不会抢走用户随后移到其他控件的焦点。连接入口按实际点击按钮恢复，账户弹层提供名称、expanded/controls、首个动作焦点与 Escape 返回。

搜索快捷键为 Command/Ctrl+Shift+F，忽略 Alt、重复键及输入法组合态；快捷键关闭后回到原输入位置，按钮打开则回按钮。搜索结果过期/禁用或消失时焦点回查询输入，结果有明确名称与摘要描述；状态采用原子礼貌播报与 aria-busy。主窗与只读副窗增加跳到内容的链接及可聚焦文字区域。跳转仅移动焦点，不改页面 URL，保持严格 IPC 来源校验。状态文字相同不重复写 DOM，避免每个流式 token 重播同一状态，正文不设逐 token live region。

统一组合输入保护跟踪 compositionstart/end、isComposing 和 legacy keyCode 229，并覆盖结束后50ms的尾随键；组合态的 Enter/Escape/搜索与菜单快捷键不触发应用动作，非组合尾随 Enter/Escape 同时阻止浏览器默认提交/关框。草稿只有不带修饰键、非重复的普通 Enter 打开发送确认，Shift+Enter 保留换行。表单保护允许当次明确鼠标点击的 submitter，所以上屏后立即点击“发送”或“搜索”仍有效。本轮未新增模型调用、可编辑多窗、分享、删除或搜索能力。

## 验证与限制

完整机器汇总见 [keyboard-accessibility-results.json](keyboard-accessibility-results.json)。

- 51稳定+2既有实验契约、TypeScript、257/257离线检查通过；新增5项覆盖组合输入生命周期/尾随键、229与isComposing降级、Enter修饰键、搜索快捷键与菜单方向策略。
- 新增24组隐藏离线Electron专项：组合态及尾随Enter/Escape、明确鼠标立即提交、确认返回与Tab边界、搜索焦点失效回退、设置分类、账户/连接/会话/分区来源恢复、旧close事件不抢新焦点、侧栏折叠和重绘、只读副窗、跳转链接、Chromium无障碍树与实际CSS焦点环。零turn/start/thread/start/thread/resume，零真实模型请求，renderer错误0。
- 既有多窗17+6、复制14+9、编辑14+10、管理18+13、设置14+8、搜索14、主题13+5+3+4、合成桌面23全部通过，共185项；连同专项共209项、17次隔离隐藏App运行。脚本只操作自己创建的窗口/合成peer，关闭账本中的副窗、在途读取和核心均清理。
- 独立只读复审指出的输入法后明确点击被拦截、连接弹窗来源、侧栏重绘菜单状态问题已修复并定向覆盖；最终无已确认剩余P1/P2。
- 首次整套离线检查有一次临时目录ENOTEMPTY清理失败；单项和后续整套257项复跑通过，未修改持久层产品代码。合成桌面首次确认框等待超时，独立复跑23项通过；失败尝试不计通过。专项开发期修正了夹具ID/禁用按钮刺激，并实测修复排队close抢焦点，最终证据来自修正后运行。

**模拟与原生证据分开记录。** Enter、Tab、菜单键和IME通过DOM事件模拟验证应用策略；原生Electron键盘事件只覆盖Escape。Chromium Accessibility树验证名称/角色，不等于系统VoiceOver。焦点环由隔离inspector强制实际focus-visible CSS并检查DOM焦点，未宣称真实系统Tab遍历通过。真实中文输入法候选确认/取消、平台快捷键、原生Tab顺序、VoiceOver、多屏及完整参考对照仍待人工验收。未启用系统VoiceOver、改变系统设置或请求新权限。

主题、搜索、会话、草稿与此前未验收边界保留；工作台整体仍未完成。

```sh
cd /path/to/codex/workbench
npm run check
npm run desktop:keyboard:smoke -- /absolute/private/output
```
