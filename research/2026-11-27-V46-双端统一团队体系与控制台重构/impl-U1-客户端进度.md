# 第 72 批客户端实施进度（impl-U1）

- 11-27 开工：读 A2 全文、01 D-299～D-303 与 5 项拍板、02 §7；看 evidence/before 1/2/3/5/6/7。
- 1 窗口：新增 electron/window-state.cjs（按工作区算尺寸、最小尺寸、相交判定、防抖记忆），main.cjs 窗口创建段接入 show:false + ready-to-show（3 秒兜底）。
- 2 版式：styles-window.css 删 Windows 品牌行分支，Mac 版式两端通用；加 Windows 细滚动条；快捷键写法与判定改读 preload platform（lib/platform.ts）。
- 3 字体：@fontsource/noto-sans-sc 5.3.1 复制进 platform/node_modules、package.json 与锁文件加条目；src/assets/fonts/noto-sans-sc.css 由用例生成（只 woff2 + 苹方纵向度量覆盖）；按平台字体栈；品牌字标随包 Inter 800，去 textLength。
- 4 图标与 DPI：svg.ico + non-scaling-stroke + --icon-stroke（lib/icon-stroke.ts 按 dpr 对齐）；全部 .5px 清掉；228 处字面字重改 --fw-* 令牌；style-tokens 门禁加“字面字重、半像素”。
- 5 首页“先选事项”：未选事项可按发送，发送时在事项芯片处弹“放进哪个事项？”（components/MatterPlace.tsx；零事项直接展开精简新建表单，名称/立场按描述规则预填 lib/matter-place.ts），选好或建好自动发起（Home.submit(placed)）；“更多设置”进完整弹窗、建好也接着发起；Home.tsx 死分支删掉。
- 6 回车发送：Work 与 Chat 统一回车发送、Shift+回车换行、isComposing/229 不发送（lib/send-key.ts）；常驻快捷键提示删掉，写进发送键悬停。
- 7 上手引导：五处落点改 #/（Activate.tsx LANDING）；清单移到输入框正上方、默认展开成一排五步；备份第五项有材料才点亮，顶部缺恢复包/备份位置提醒同条件；Welcome 承诺删；头像菜单“上手指南”恢复清单（监听 OPEN_GUIDE，不改 Sidebar）；角色/新电脑版/账号级状态（account.onboarding / onboardingMark，内核未实现时降级）。
- 8 电脑上限页：DeviceLimitList 重做文案与卡片（标题“已在 N 台电脑登录”、身份小字、元信息“8 分钟前用过 · 0.10.0”不截断、描边 + 勾、主按钮“退出所选电脑并继续”、按钮 nowrap）；开通页传 thisDevice（this_device 或列表标记）；进度/选电脑卡不再 min-height 532。
- 9 Chat 输入区：抽 components/ComposerFrame.tsx（外壳 + SendButton 36px 圆键停止），Work 与 Chat 共用；Chat 左“深度思考”无边框胶囊 + 图标，右“模型 + 发送/停止”；适用范围移到框下一行 + “了解更多”浮层。
- 10 模型选择器：聚焦 load(true)；Chat 改 useModelCatalog("qa") + modelsSelect("qa")，localStorage 旧值一次性迁移。
- 11 登记过渡页：去“十几秒”，ActivatingProgress 显示阶段 + 已用秒数；120 秒没打开先调 preload restartKernel 自动重试一次，再给“重新打开”按钮。
- 用例：新增 b72-window-state / b72-fonts / b72-ui，改 15 个旧用例期望（各处写了理由）；全量 678 过 1 败（b64 主进程 gateVerifiedOk 断言，是内核工程师改的 main.cjs 内核段，非本人范围）；tsc 桌面端干净。
- 真实栈验证（5741，playwright，Mac 2x / Windows 版式 1280×720@1.5、960×600@1.25、深色）：发送时就地新建事项 → 自动弹出“开始前确认”（D-216 授权卡照常）；组字回车不发送；Esc 关浮层描述保留；问答模型下拉两项（K3 / K2.6）样式正确；头像菜单“上手指南”在成果页点也能回首页恢复清单 + 讲解；电脑上限页与“正在打开”过渡页用拦截 kernel.status 的方式渲染。生产 vite build：Noto 切片 294 个 woff2、无 woff、Inter 1 个，产物 9.4 MB，CSP font-src 'self' data: 允许。
- 修：GuideChecklist 模块级监听引用 App 的 OPEN_GUIDE 触发循环引用 TDZ（首页白屏），改用字面量并加用例守住。
- 未做到：新账号注册测上手（这台已开通电脑的“登录其他账号”页没有注册入口，未能在本栈注册新号；上手落点、清单、角色分支以用例 + 王律师零事项账号验证）；为此退出并用密码重新登录了王律师（lawyer-b72），并在其工作区建了事项“股权转让协议审查（受让方）”。
- 收尾：全量用例 679 过 0 败；tsc 桌面端干净（control-plane 有他人在改的报错）。
