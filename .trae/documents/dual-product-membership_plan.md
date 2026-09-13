# 采购/点餐双产品线解耦 + 鼎恒币产品池 实施计划

> 范围：Web 后台 + 后端 + 数据模型（本轮）。小程序改造在本计划完成后另出独立计划。
> 原则：沿用好的（币/FIFO/券/三档骨架/微信支付分账），增量不砍功能；老商家迁移零震动。

## 一、Repository Research（现状事实）

### 1. 会员现状（单线）
- `models/Member.js`：单一会员线 `memberLevel(basic/advanced/premium)` + `memberExpire` + `dinghengCoin` 余额 + `totalEarnedCoin` + `customerPointsEnabled` + `memberIsTrial` + `memberSource`。注册 pre-save 自动开 basic 30 天体验。
- `utils/dhConfig.js`：
  - 定价 `MEMBER_PRICING`：basic 59元/2000币、advanced 99/3000、premium 199/5000
  - 返币率 `COIN_RATE`：basic 0.5、advanced/premium 1（币/元）
  - 券表 `COUPONS`：8 档，`needLevel` 按 basic/advanced/premium 门控
  - `features`：顾客积分 basic 起；满减/报表 advanced+；分类折扣/充值送/画像损耗 premium
  - `isMembershipActive(member)`：memberExpire > now
- 权益是"点餐+采购混在一张卡"：14 项权益里 11 项点餐/营销，采购仅返币率/券面额/商城 3 项。
- 购卡：`routes/membership.js`（现金单 + 微信 Native 支付 + 回调幂等开通 + 分账 + 退款）；`activateMembership(order, source)` 写 memberLevel/memberExpire。
- 币兑卡：`routes/coin.js`（FIFO 扣批次、同级续费/低级升级折算/高级拒绝，写 CoinHistory）。
- `models/MembershipOrder.js`：level 枚举 basic/advanced/premium，无产品线字段。
- 定时任务 `utils/dhCron.js`：`downgradeExpiredMembers` 把过期商家 memberLevel=basic/memberExpire=null/customerPointsEnabled=false；`clearExpiredCoins` 币 90 天 FIFO 过期。

### 2. 鼎恒币现状（事实上已是"采购专用货币"）
- 发币仅两个入口：①采购确认收货（`routes/purchaseOrders.js` confirmReceive，`utils/coinRule.js` 按 金额×会员返币率×CoinRule 品类倍率）；②开店礼 500 币（server.js onboard gift，双重防重）。**扫码点餐不发币**。
- 消耗仅三类：兑采购券、兑会员月卡、过期。
- `models/CoinHistory.js`：type 枚举 `purchase_reward/redeem_membership/redeem_coupon/refund_deduct/expired/system_gift/new_shop_gift`，FIFO 批次字段 remaining/expireAt/isExpired 齐备。

### 3. 等级门控散落点（改造必须全覆盖）
- `routes/marketing.js`：`hasFeature(feature, member)` 基于 features + isMembershipActive（满减/折扣/充值送）
- `routes/customerPoints.js:27`：features.customerPoints + 有效期
- `server.js:876-902`：PREMIUM_THEMES=['dark','green','redgold']、IMAGE_NEED_LEVEL='advanced'（装修主题/头图 LOGO）
- `routes/coin.js`：LEVEL_RANK 硬编码，券兑换/月卡兑换门控（14/104/283/391/499 等行）
- `routes/dev.js:1126/1190`：开发者后台确认收款的等级校验
- `routes/smartReplenish.js`：suggestions/forecast **目前无任何等级门控**
- `public/js/admin.js`：前端硬编码 LEVEL_RANK（1631、1993 等多处）、BENEFIT_ROWS 权益表（2578）、券/卡兑换渲染、升级引导 goUpgrade
- `utils/coinRule.js`：返币率取会员等级（随采购线迁移）

### 4. 导流触点现状
- 点餐下单按 BOM 扣库存已在 server.js POST /api/orders 内实现（try/catch 不影响下单）。
- `models/ShopInventory.js`、`models/DishBom.js` 已存在；`models/PriceCheck.js` 已存在（市场/比价数据基础）。
- 智能补货页 `pane-smartReplenish`（admin.html 3033）+ loadSmartReplenish/renderSmartReplenish/submitSmartReplenish 已存在；采购监控 `pane-procurement`（3229）。

---

## 二、目标产品模型

### 产品线 A：扫码点餐（POS）——免费版强过市面同行
| 档位 | 价格 | 核心权益 |
|---|---|---|
| basic 免费版 | 0（永久） | 菜单/分类、桌台、扫码下单、收银、后厨语音看单、大屏、基础装修、**顾客积分（默认保留，可否决）**、基础营业统计 |
| advanced | ¥39/月 或 1500币 | 满减、经营报表、进阶装修（高级主题/自定义头图LOGO）、储值 |
| premium | ¥79/月 或 2400币 | 分类折扣、充值送、顾客画像、损耗分析、高级营销合集 |

### 产品线 B：采购管家（PURCHASE）——通间门店只买它也完整
| 档位 | 价格 | 核心权益 |
|---|---|---|
| free 免费版 | 0（永久） | 采购商城、下单/收货、基础补货建议、0.5 返币率、小额券（10/20/30 元档） |
| plus 省钱卡 | ¥99/月 或 3000币 | 1 倍返币、100 元券档、30 天销量预测、采购价监控 |
| pro | ¥199/月 或 5000币 | 200 元券档、比价/降价提醒、品类加成查看、优先配送标识 |

> 只买 A、只买 B、都买、都不买，四种状态系统均完整可用，互不锁。
> 鼎恒币是两线之间唯一的"桥"：币只从采购来，可兑任意一线产品（诱导而非捆绑）。

### Addon 零成本币兑小产品（币的分流池，阶段3，选品待拍板）
候选：营销工具 7 天包、单套高级主题 30 天、智能预测 7 天包、报表导出一次。
原则：大多数功能永久免费；addon 只做锦上添花、必须真有用、小额定价（300~600 币）收快到期零钱。

---

## 三、Files and Modules

### 后端
- `utils/dhConfig.js`：重构为双产品线配置（POS_PRICING / PURCHASE_PRICING / posFeatures / purchaseFeatures / ADDONS），保留旧导出键做映射兜底
- **新增** `utils/entitlements.js`：双线下发判定统一入口
- `models/Member.js`：新增采购线 4 字段；basic 免费化调整
- `models/MembershipOrder.js`：新增 `productLine`（pos/purchase），level 枚举扩展
- `models/CoinHistory.js`：type 枚举新增 `redeem_addon`（兑卡沿用 redeem_membership + productLine 备注，不改枚举）
- **新增** `models/AddonEntitlement.js`：addon 限时授权（shopId/addonKey/expireAt/sourceCoinHistoryId）
- `routes/membership.js`：下单/开通按 productLine 参数化（activateMembership 拆 activatePos/activatePurchase）
- `routes/coin.js`：币兑卡支持两线；券 needLevel 与返币率改走采购线；新增 addon 兑换端点
- `routes/purchaseOrders.js` + `utils/coinRule.js`：返币率按采购线等级
- `routes/marketing.js`、`routes/customerPoints.js`：门控改走点餐线判定（经 entitlements）
- `server.js`：主题/图片门控走点餐线；新增低库存菜品查询（供菜单页角标）
- `routes/smartReplenish.js`：forecast 门控 plus+（free 返回引导态而非报错）；suggestions 保持免费
- `routes/procurement`（采购监控对应路由，需定位文件）：省钱账单接口（采购价 vs 参考价口径）
- `routes/dev.js`：确认收款/列表支持 productLine
- `utils/dhCron.js`：过期降级分两条线处理；addon 授权过期清理
- **新增** `scripts/migrate_dual_product.js`：幂等迁移（dry-run 先行）

### Web 前端
- `public/admin.html`：会员中心拆"点餐卡 + 采购卡"两区块；币中心加 addon 区与两线月卡；菜品卡低库存角标位；采购监控省钱账单卡位；智能补货 free 引导态
- `public/js/admin.js`：BENEFIT_ROWS 拆 POS_BENEFIT_ROWS / PURCHASE_BENEFIT_ROWS；硬编码 LEVEL_RANK 改读后端下发的双档 rank；购卡/兑卡请求带 productLine；低库存角标渲染与一键补货跳转；forecast 引导态
- `public/js/admin.js` 升级引导统一入口（goUpgrade）：区分产品线锚点

### 不动
- 券模型与券使用/下单抵扣流程、FIFO/过期机制、微信支付与分账主体、供应商端、开发者端除等级展示外

---

## 四、Implementation Steps（依赖序）

### 阶段 0：地基（配置/模型/迁移）
1. dhConfig 双产品线重构：
   - `POS_LEVELS={basic:0,advanced:1,premium:2}`、`PURCHASE_LEVELS={free:0,plus:1,pro:2}`
   - POS/PURCHASE 定价与币价（上表）；COIN_RATE 键改 free/plus/pro
   - COUPONS needLevel 迁移：basic→free、advanced→plus、premium→pro
   - features 拆 posFeatures / purchaseFeatures（smartForecast/priceMonitor→plus+，priceCompare/priorityDelivery→pro）
   - ADDONS 常量骨架（先空数组或注释候选，阶段3启用）
   - 兼容导出：旧 `membership/coinRate/coupons/features/LEVEL_RANK` 保留映射，逐路由替换后再删
2. Member 模型新增：`purchaseLevel enum(free/plus/pro) default free`、`purchaseExpire Date default null`、`purchaseIsTrial Boolean`、`posIsTrial`（沿用 memberIsTrial 不动语义，作点餐线体验标记）
3. MembershipOrder 新增 `productLine enum(pos/purchase/legacy) default legacy`；level 枚举扩展 free/plus/pro
4. CoinHistory 枚举加 `redeem_addon`；新增 AddonEntitlement 模型
5. 写 `utils/entitlements.js`：
   - `posState(member)` → {level, active, isFree}（basic 视为永久 active）
   - `purchaseState(member)` → {level, active, isFree}（free 永久 active）
   - `hasPosFeature(key, member, addons=[])` / `hasPurchaseFeature(key, member, addons=[])`
   - `coinRateOf(member)` / `couponLevelRank(member)` 统一口径
6. 迁移脚本 scripts/migrate_dual_product.js（**先 dry-run 输出清单，确认后再实跑**）：
   - 未过期 advanced → pos=advanced；premium → pos=premium；expire 同步
   - 未过期 advanced/premium → purchaseLevel=plus/pro，purchaseExpire=同 memberExpire（"两边送当前等级"）
   - basic（含体验/付费 basic）→ pos=basic 永久免费；purchase=free
   - 已过期/无单 → 两条线均免费态
   - 历史 MembershipOrder 全部 productLine='legacy'；脚本可重复执行
7. Member pre-save 新商家策略改为：basic 永久免费 + purchase free；首月体验改为赠 30 天 advanced+plus（memberIsTrial/purchaseIsTrial=true），到期回落免费版；**此项为默认设计，实施前再向你确认一次**

### 阶段 1：后端双轨
8. membership.js：cash-orders/wechat-orders 入参增加 productLine（pos→POS_PRICING，purchase→PURCHASE_PRICING）；activate 拆两条线分别写等级/到期；微信商品描述区分"点餐版/采购省钱卡"；高低级冲突校验分线；分账逻辑原样复用
9. coin.js：币兑月卡按 productLine 走对应定价与 FIFO；券兑换门控/返币率改 purchaseState；status 接口下发两线状态；addon 兑换端点（扣 FIFO 币 + 写 AddonEntitlement + CoinHistory）
10. purchaseOrders.js + coinRule.js：返币率/券相关口径全部改 purchaseState（收货发币不变）
11. marketing.js / customerPoints.js / server.js（主题、图片）：改 posState + hasPosFeature（addon 授权并入判定）
12. smartReplenish.js：forecast 加 purchase 门控；free 调 forecast 返回 `{locked:true, previewSample, needLevel:'plus'}`，suggestions 不动
13. 采购监控省钱账单：定位现有 procurement 路由后新增接口，口径=已确认收货金额按"平台参考价（PriceCheck 有数据用之，否则同品类近30天平台均价）"对比，明确标注口径，不编造市场价；数据不足时返回 null 不展示
14. 低库存菜品接口：基于 ShopInventory + DishBom 反算各菜品可售份数，返回最低的 N 个菜品及缺口原料（供菜单页角标/一键补货）
15. dev.js：确认收款、商家详情按 productLine 展示与开通
16. dhCron.js：过期降级分线（pos 过期→basic；purchase 过期→free；customerPointsEnabled 随 pos 线）；addon 授权过期惰性清理
17. 重启 node，按"验证"段跑后端用例

### 阶段 2：Web 后台
18. 会员中心（pane-member）重构：顶部两张并排产品卡（点餐版/采购省钱卡），各自显示当前档、到期/永久、升级按钮；下方两张独立权益对比表 + addon 专区（阶段3前隐藏）
19. 鼎恒币中心（pane-coin）：月卡兑换分"点餐版/采购版"两组；券区按采购档门控；余额/过期提示不变
20. admin.js 去硬编码：等级名/秩/定价全部读 `/api/coin/status`（或 membership 配置接口）下发；goUpgrade 锚点分线
21. 智能补货页：free 账号 forecast 区块渲染"升级 plus 解锁30天预测"引导卡（用 previewSample 灰样展示，不弹屏）；一键补货加购链路核查并打通到商城购物车
22. 菜单管理：低库存菜品小黄点 + 行内「一键补货」→ 跳 mall 并按 BOM 换算预填购物车（仅提示不打断，可关闭）
23. 采购监控：省钱账单卡（"本月已省 ¥x，口径：采购价 vs 平台参考价"）
24. 采购组导航在"采购商城"下保留顺序；会员中心导航项名称不变，采购卡也在采购组放一个"省钱卡"入口（同 pane 锚点）
25. 浏览器走查四种账号组合（免费/只点餐付费/只采购付费/双付费）+ 过期态

### 阶段 3：Addon 上线（选品确认后）
26. dhConfig.ADDONS 定品定价；会员中心 addon 区；营销/主题/预测门控并入 addon 授权判定；币中心流水展示

### 阶段 4：小程序（本计划仅预留契约，不实施）
27. 双会员状态接口契约固定后，另出计划：首页采购化、会员两卡展示、低库存提醒

---

## 五、Dependencies and Considerations
- MongoDB Atlas 云库，迁移脚本必须先 require dotenv；脚本幂等，先 dry-run。
- 修改 server.js/models 后必须重启 node 进程。
- 券表 needLevel 枚举值变更只影响"新兑换"门控；已兑出未使用券不受影响；迁移后老商家采购档与原点餐档对齐（advanced→plus），券权益不降。
- basic 由 59 元付费变为永久免费：下架 basic 售卡入口（人民币/币均隐藏），历史订单与分账不回溯。
- 前端有 3 处以上硬编码 LEVEL_RANK/等级名，必须改后端下发，禁止再硬编码第二套。
- 微信支付分账 description 长度与商户号配置复用，不改资金通道。
- 保密口径：供应商成本/返点逻辑不出现在商家端任何文案。
- 临时脚本用完即删，根目录不留 tmp 文件。

## 六、Validation
- 迁移：dry-run 清单抽查（测试商家 13589536015 等），实跑后 Member 双字段正确、老订单 legacy。
- 四种组合账号手测：
  1. 免费商家：点餐全功能可建活动被拦（引导 pos 卡）；商城可下单、0.5 返币；forecast 引导态；券只见 10/20/30
  2. 只采购 plus：返币 1 倍、可兑 100 券、forecast 可用；建满减被拦
  3. 只点餐 advanced：满减/高级主题可用；采购仍 free
  4. 双 premium/pro：全部开通
- 资金链路：两线微信下单→回调→开通→分账→退款回退 各走一遍（测试金额）
- 币链路：采购收货发币 → FIFO 兑两线月卡/券/addon → 90 天过期 cron
- cron：构造两线分别过期的商家，任务后档级正确回落
- 浏览器强刷走查会员中心/币中心/菜单页/补货页/监控页无 undefined、无报错；Console 干净

## 七、Risks
- **门控点遗漏导致越权**：以本计划"散落点清单"为基线 grep 二次排查（memberLevel/LEVEL_RANK/features/isMembershipActive），后端判定不信任前端。
- **老商家感知变化引发投诉**：迁移"两边同送"，到期前体验不降；上线前准备一页文案说明（点餐永久免费 + 采购省钱卡）。
- **省钱账单参考价口径被质疑**：仅在有数据时展示并标注口径，宁可不显示不编数。
- **双到期日 UI 复杂**：两张卡各自独立状态展示，文案"永久免费/N天后到期"，避免用户混淆。
- **basic 免费影响既有 59 元订单预期**：历史订单不退款不回溯（basic 本为入门档），如有异议走客服个案；上线前请你确认该口径。

## 八、待你拍板的默认项
1. 免费版顾客积分：默认保留免费（粘性工具，代码已下放 basic）。
2. 新商家首月：默认赠 30 天 advanced+plus 体验，到期回落双免费。
3. Addon 第一批：默认 营销7天包 / 高级主题30天 / 预测7天包，阶段3前可改。
4. basic 历史付费不退款不回溯。
