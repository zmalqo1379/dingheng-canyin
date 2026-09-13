# 鼎恒餐饮 SaaS — 项目架构梳理（ARCHITECTURE.md）

> 本文档基于对当前仓库源码的逐文件通读整理，只描述代码事实。凡代码中无法确证的内容，统一标注 **【待确认】**。
> 生成时间：2026-09-11。若与代码不一致，以代码为准。
> 相关文件：`鼎恒科技系统全量文档.md`（更细的全量清单，部分内容已过时）、`系统档案.md`（早期文档）、`.trae/documents/分拣打票与配送支持.md`（履约功能设计）。

---

## 1. 系统概述

一句话：面向**餐饮商家**的「门店经营 + 供应链采购 + 会员营销」一体化 SaaS 平台，通过一个 Express 后端 + 四套 Web 前端（商家 / 供应商 / 开发者 / 顾客与后厨）提供服务，另有独立的 uni-app 小程序工程。

核心角色共 4 类：

| 角色 | 说明 | 入口页面 |
|---|---|---|
| 商家 merchant | 餐饮门店，点餐经营 + 采购食材 | `merchant-login.html` → `admin.html` |
| 供应商 supplier | 食材/物资供货方 | `supplier-login.html` → `supplier-dashboard.html` |
| 开发者 dev | 平台运营方（审核、返点、结算、配置） | `dev-login.html` → `dev-console.html` |
| 顾客/后厨（无账号） | 扫码点餐、后厨看单、大屏展示 | `customer.html`、`kitchen.html`、`bigscreen.html` |

多租户模型：商家侧数据一律带字符串 `shopId`（`shop_<时间戳>_<随机>`）；供应商侧带 ObjectId `supplierId`；开发者/平台配置为全局。

---

## 2. 业务闭环

### 2.1 门店经营闭环（堂食点餐）
```
顾客扫码(customer.html?shopId=xxx)
  → 选桌号 + 选菜（菜单/购物车，前端实时算优惠）
  → 提交 POST /api/orders
      ├─ 后端权威计算：营销优惠(computeDiscount) → 积分抵现 → 储值抵扣
      ├─ 生成 Order(status=pending，shopId 隔离) + 桌台置 occupied
      ├─ 扣储值余额（不足则回退本单储值部分，防超扣）
      ├─ 结算积分（先扣抵现、再累计获得）
      └─ 通知引擎 notifyOrderCreated（语音/大屏/打印/webhook/短信/语音电话）
  → 后厨 kitchen.html 每 2s 轮询 pending 新单，语音播报 + 红框闪烁
  → 完成出餐 PUT /api/orders/:id/complete → status=completed，桌台置 idle
  → 大屏 bigscreen.html 每 5s 轮询展示；商家后台订单管理可查/完成
```
闭环要素：下单 → 出餐 → 完成。积分/储值/优惠均在**后端**权威计算，前端仅展示。

### 2.2 供应链采购闭环（B2B 采购）
```
商家（采购商城 mall）选择供应商与商品 → 加入采购车
  → 下单前「囤货保护」预检(utils/stockpileCheck)
      ├─ 数量超近7日总量 → 409 STOCKPILE_WARNING，商家可 force 坚持下单（订单记 anomalyFlag）
      └─ 单价低于近7日均价15% → 跌价预警（记 priceDropWarning）
  → POST /api/purchase-orders（事务：建单 + 核销抵用券） status=待确认
  → 供应商待处理订单：确认(已确认) → 【分拣过秤 POST /:id/weigh】按实称重算金额，全行称完 sorted=true
  → 打票（80mm 小票 / 一键打全票 / 分拣标签）、发货(已发货) → 配送单页导航 + 拍照送达(deliveryPhotoUrl)
  → 商家确认收货 POST /:id/confirm-receive → status=已完成（事务内结算）：
      ├─ 预估返点 preRebate（按供应商返点模式 + 当月累计额定档）
      ├─ 商家采购积分 ShopAccount.pointsBalance += totalAmount
      └─ 发放鼎恒币 rewardCoin = Σ(行实付 × 会员币汇率 × 品类倍率)，90 天有效
  → 开发者月度结算(每月1号03:00 或手动) → 生成 RebateSettlement，回写 actualRebateAmount，计入 Supplier.balance
  → 返点对账与结算单状态流转（待结算→已确认→已收款，超15天标记逾期）
```

### 2.3 会员与激励闭环（鼎恒币）
```
商家采购收货 → 得鼎恒币（90 天有效，每日 02:00 过期清零）
  → 鼎恒币兑换：会员月卡（续费/升级折算） 或 抵用券（30 天有效）
  → 抵用券用于采购下单核销（每单限一张，券不返币）
  → 会员等级(basic/advanced/premium)决定：返币汇率、功能权益、券可兑档位
  → 会员到期每日 02:00 降级为 basic 并失活
充值送活动（尊享版）→ 商家线下给顾客充值储值，按门槛赠送（见 2.5）
```

### 2.4 供应商入驻治理闭环
```
注册(status=pending) → 开发者审核
   ├─ reject(需原因) → rejected（终态）
   └─ approve → active
        → 供应商签署《合作协议》 agreementSigned=true（需 active）
        → 上传 4 张资质 → qualification.status=pending
        → 开发者资质核验 approve → orderEnabled=true
        → 店铺上线采购商城（/api/suppliers、/api/supply-products 可见），可接单
冻结/解冻：frozen 时在途订单可继续发货收货，新单拒绝，商城隐藏
```

### 2.5 顾客储值闭环
```
商家后台「顾客储值」登记线下充值 POST /api/stored-value/recharge
  → 命中「充值送」活动门槛则叠加赠送(bonus)，写 recharge/bonus 流水
  → 顾客点餐结算勾选储值抵扣 → POST /api/orders 内扣减余额并写 consume 流水
  → 顾客端储值区块开关：本店存在余额>0 账户时展示
```

---

## 3. 技术结构

### 3.1 总体架构
```
                ┌──────────────────────────────────────────────┐
                │  浏览器 Web 前端（原生 HTML/CSS/JS，无构建）    │
                │  index / merchant-login / admin / customer /   │
                │  kitchen / bigscreen / supplier-login /        │
                │  supplier-dashboard / dev-login / dev-console  │
                └───────────────┬──────────────────────────────┘
                                │ HTTP + JWT(Bearer) / x-shop-id
                ┌───────────────▼──────────────────────────────┐
                │   Node.js + Express（server.js 单进程）        │
                │   middlewares/ (JWT、shopId 隔离)              │
                │   routes/ (13 个路由模块) + server.js 内联路由  │
                │   utils/  (返点/发币/定价/通知/预检/定时)       │
                └───────────────┬──────────────────────────────┘
                                │ Mongoose ODM
                ┌───────────────▼──────────────────────────────┐
                │   MongoDB（本地默认 127.0.0.1，生产用 Atlas 云库）│
                └──────────────────────────────────────────────┘
        ┌────────────────────────────────────────────────────────┐
        │  uni-app 小程序工程（独立 package.json + Vite，平行存在） │
        └────────────────────────────────────────────────────────┘
```

### 3.2 后端（云/服务端）
- 入口：`server.js`，`npm start` / `npm run dev` 均为 `node server.js`。
- 端口：`process.env.PORT || 3000`。
- 依赖：express ^4.19.2、mongoose ^8.5.0、jsonwebtoken ^9.0.3、bcryptjs ^2.4.3、multer ^2.3.0、node-cron ^3.0.3、cors、dotenv。
- 启动流程：`dotenv` → `express` 中间件(cors/json/static) → 上传路由(multer) → `extractPublicShopId` → 各业务路由挂载 → 连接 MongoDB → 确保默认开发者账号(`admin`/`dingheng2024`) → `startDhCron()` → `priceRule.seedGlobalPresets()` → `listen`。
- 无热加载：改 `server.js`/`models/*.js` 后必须重启 node。
- 中间件（`middlewares/auth.js`）：`signToken`(7天)、`verifyToken`、`extractPublicShopId`、`requirePublicShopId`、`requireMerchant`(JWT role + shopId 一致性)、`requireSupplier`、`requireDev`。
- 权益中间件（`middlewares/featureCheck.js`）：`checkFeature(featureName)` 按 `Member.memberLevel` + 会员有效期校验。
- 路由模块（`routes/`，13 个）：
  | 文件 | 挂载前缀 | 职责 |
  |---|---|---|
  | auth.js | /api/auth | 三端注册/登录/改密/dev seed |
  | coin.js | /api | 鼎恒币兑换会员/券、币状态、流水、月进度、品类倍率 |
  | purchaseOrders.js | /api/purchase-orders | 采购订单全流程（下单/确认/发货/分拣过秤/拍照送达/收货结算/用券） |
  | supplier.js | /api/supplier | 供应商档案/资质/协议/通知设置/结算/新手任务 |
  | supplyProducts.js | /api/supply-products | 供应商品 CRUD + 公开商品目录 |
  | marketing.js | /api/marketing | 营销活动 CRUD + 公开 active 查询 |
  | customerPoints.js | /api/points | 顾客积分配置/查询/抵现结算/积分换菜 |
  | membership.js | /api/membership | 会员现金购卡订单（下单/查询/取消） |
  | storedValue.js | /api/stored-value | 顾客储值充值记账/账户查询/公开余额 |
  | reports.js | /api/admin/reports | 经营报表/顾客画像/损耗分析 |
  | procurementMonitor.js | /api/admin/procurement-monitor | 采购监控（防回扣，只读） |
  | supplierPrice.js | /api/supplier/price | 供应商智能定价（改价工作台/品类规则/保鲜期提醒） |
  | dev.js | /api/dev | 开发者控制台全部接口（requireDev） |
- `server.js` 内联路由：公共顾客侧（categories/dishes/tables/orders/settings/stats/suppliers）、商家后台 CRUD（分类/菜品/桌台/订单/统计/新手任务/装修设置）、图片上传。
- 工具层（`utils/`）：
  | 文件 | 职责 |
  |---|---|
  | dhConfig.js | **平台配置唯一事实源**：会员定价、币汇率、券定价表、返点默认阶梯、权益矩阵、过期天数 |
  | rebate.js | 返点计算唯一入口（calcRebate/estimateOrderRebate/settleMonth/getMonthOverview） |
  | coinRule.js | 品类得币倍率 + 采购返币计算（calcOrderRewardCoin） |
  | priceRule.js | 定价规则：品类加价率/保鲜期、工作台分类映射、建议售价、预置入库 |
  | marketingCalc.js | 点餐优惠 computeDiscount（先折扣后满减） |
  | stockpileCheck.js | 囤货/跌价预检（preCheckOrder） |
  | freshnessCheck.js | 保鲜期三阶段保护（提醒→冻结→自动下架） |
  | notify.js | 通知引擎（notifyOrderCreated + 各渠道下发 + 日志） |
  | dhCron.js | 定时任务（每日 02:00 清理 / 每月 1号 03:00 月结） |

### 3.3 前端 Web 页面（`public/`）
原生 HTML + CSS + JS，由 Express 静态托管；图片资源托管于 `/uploads`。页面用途详见 **第 4 章**。

### 3.4 小程序端（`uni-app/`）
独立 uni-app(Vue3) + Vite 工程，功能为 Web 端的**子集**，与 Web 端逻辑重复维护。

| 页面 | 用途 |
|---|---|
| pages/customer/index.vue | 扫码点餐（顾客端） |
| pages/admin/index.vue | 店铺首页 |
| pages/admin/menu.vue | 菜单管理 |
| pages/admin/order.vue | 订单管理（5s 轮询 + 新单语音播报） |
| pages/admin/stats.vue | 数据统计 |
| utils/request.js / cart.js / audio.js | 请求封装 / 购物车 / 提示音 |
| App.vue / main.js / pages.json / manifest.json / theme.json / uni.scss | 工程脚手架 |
| static/audio/new-order.wav、static/tabbar/*.png | 资源 |

小程序发布状态、是否上架【待确认】。

### 3.5 数据库（MongoDB，23 个集合）
均启用 `timestamps`。

**账号与会员**
| 集合 | 关键字段 |
|---|---|
| Admin | username(unique)、password(bcrypt)、name |
| ShopAccount | shopId(unique)、shopName、contactName、phone(unique,sparse)、password、pointsBalance、onboardPreview/onboardMallVisited/onboardGiftClaimed、storeInfoCompleted/storeInfoFirstPrompted |
| Supplier | name、contact、phone(unique)、loginAccount(unique)、password、webhookUrl、categories、minOrderAmount(默认300)、notificationSettings{popup,sms,voice}、deliveryNotice、rebateRate(旧)、**rebateMode**(unified/byCategory)、rebateModeLogs、balance、status(pending/active/frozen/rejected)、rejectReason/frozenReason、approvedAt、agreementSigned/agreementSignedAt/agreementEvidence、orderEnabled/orderEnabledAt、qualification{status,businessLicense,storeFront,storeInterior,goods,submittedAt,reviewedAt,rejectReason}、onboardNotifySet/onboardSettleSeen |
| Member | shopId(unique)、shopName、memberLevel(basic/advanced/premium)、memberExpire、dinghengCoin、totalEarnedCoin、customerPointsEnabled、memberIsTrial、memberSource(coin/cash)；**pre-save 新店赠送 basic 30 天体验** |
| MembershipOrder | orderNo(unique)、shopId、shopName、level、months(1-12)、amountRmb、status(pending/paid/cancelled)、buyerNote、paidAt、confirmedBy、memberExpireAfter |

**门店业务**
| 集合 | 关键字段 |
|---|---|
| Category | name、shopId（复合唯一） |
| Dish | name、price、category、image、isAvailable、description、shopId |
| Table | number、shopId（复合唯一）、status(idle/occupied) |
| Order | tableNumber、items[{dishName,price,quantity,category}]、totalPrice、originalTotal、discountAmount、discountDetail、remark、orderType(normal/pointsRedeem)、customerPhone、pointsUsed/pointsDiscount/pointsEarned、storedValueUsed/storedValuePhone、status(pending/completed)、shopId |
| Setting | 见 3.5.1 |

**鼎恒币与券**
| 集合 | 关键字段 |
|---|---|
| CoinHistory | shopId、amount、type(purchase_reward/redeem_membership/redeem_coupon/refund_deduct/expired/system_gift/new_shop_gift)、sourceOrderId、balanceAfter、expireAt、remaining、isExpired、description |
| CoinRule | category(unique)、multiplier(0-10)、enabled、remark |
| Coupon | shopId、type、name、faceValue、minOrder、status(unused/used/expired)、usedOrderId、usedAt、expireDate |
| CustomerPoint | shopId+phone(复合唯一)、points、totalEarned、history[{type(earn/deduct/redeem),amount,balance,orderId,note,time}] |
| StoredValue | shopId+phone(复合唯一)、customerName、balance、totalRecharged、totalBonus、history[{type(recharge/bonus/consume),amount,balance,orderId,note,time}] |

**供应链**
| 集合 | 关键字段 |
|---|---|
| SupplyProduct | name、category、image、unit、costPrice、marketPrice、rebateRate(旧)、supplierId、supplierName、stock、status(上架/下架)、description、markupRate、priceUpdatedAt、grade(standard/premium/null)、parentProductId、priceFrozen、priceFrozenAt、freshnessAlertedAt |
| PurchaseOrder | orderNo(unique)、shopId/shopName、supplierId、items[{productId,name,category,quantity,unitPrice,totalPrice,actualWeight,weighed,actualLineTotal}]、totalAmount、status、confirmAt/deliverAt/receiveAt、rebateAmount、preRebate/preRebateRate、actualRebateAmount、rebateMonth、rebateSettled、pointsGenerated、rewardCoin、appliedCouponId、discountAmount、actualPayAmount、anomalyFlag/anomalyItems、priceDropWarning/priceDropItems、sorted/sortedAt、deliveryPhotoUrl/deliveredAt |
| RebateRule | supplierId+category(复合唯一，category 默认"全部")、tiers[{minAmount,rate(0-1),mode(full/marginal)}]、enabled、effectiveDate、remark |
| RebateSettlement | month+supplierId(复合唯一)、supplierName、rebateMode、totalPurchaseAmount、totalRebateAmount、details[{category,purchaseAmount,rebateAmount,rate,tierMinAmount,mode,marginType}]、status(待结算/已确认/已收款/已结算)、settledAt/confirmedAt/paidAt、remark |
| PriceRule | supplierId(null=平台预置)、category、markupRate、freshDays；supplierId+category 唯一 |

**平台**
| 集合 | 关键字段 |
|---|---|
| PlatformConfig | key(固定'platform')、platformCompanyName、supplierTodoReadAt |
| NotificationLog | shopId、channel(webhook/printer/sms/voice/bigscreen/wechat)、event、target、title、content、status(success/failed/skipped)、error、payload |

#### 3.5.1 Setting 字段（一店一条）
- 基础/装修：shopName、theme(classic/minimal/dark/green/redgold)、bannerImage、logoImage、promoPoster、promoPosterSize(small/medium/large)、shopNameFont(modern/serif/round/hand)、layout(list/large/grid)
- 通知：enableVoice、enableBigscreen、enablePrinter、enableWechat、printerSN/printerKey、notifyPhone、notifyWebhookUrl、printerApiUrl、smsApiUrl/smsApiKey、voiceApiUrl/voiceApiKey
- 积分：pointEnabled、pointSpendPerPoint、pointDeductEnabled、pointDeductPoints(默认100)、pointDeductMaxPercent(默认20)、pointExchangeDishes[{dishId,dishName,points}]
- 配送：shopLongitude、shopLatitude、shopAddress、storeFrontPhoto、streetViewPhoto、receiveMethod(supplier_arranged/door_container/open_door/self_pickup)、expectedReceiveStart(默认06:00)、expectedReceiveEnd(默认09:00)

### 3.6 第三方对接
| 类别 | 说明 | 状态 |
|---|---|---|
| 云数据库 | MongoDB Atlas（生产经 `.env` 的 `MONGODB_URI` 连接） | ✅ |
| 鉴权 | jsonwebtoken（三端 JWT，7 天） | ✅ |
| 密码 | bcryptjs（10 rounds，pre-save 钩子） | ✅ |
| 图片上传 | multer（2MB、jpg/png，存 `/uploads`） | ✅ |
| 定时任务 | node-cron（每日 02:00 / 每月 1号 03:00） | ✅ |
| 云打印 | `Setting.printerApiUrl`，POST `{sn,key,...}`；未配置记 skipped | 代码就绪，需商家填地址 |
| 短信 | `Setting.smsApiUrl` + `smsApiKey` | 代码就绪，需商家填地址 |
| 语音电话 | `Setting.voiceApiUrl` + `voiceApiKey` | 代码就绪，需商家填地址 |
| 通用 Webhook | `Setting.notifyWebhookUrl`，POST 新订单 JSON | 代码就绪，需商家填地址 |
| 供应商 Webhook | `Supplier.webhookUrl`（order_created/confirmed/delivered/delivered_photo/received） | 代码就绪，需供应商填地址 |
| 高德地图导航 | 配送单页超链 `https://uri.amap.com/marker?position=经度,纬度`（URI scheme，**免 key**） | ✅ |
| 电子秤 | 前端适配器 manual(默认)/WebSerial(骨架)/WebUSB(占位)/蓝牙(占位) | 🟡 WebSerial 骨架，其余占位 |
| 大屏提示音 | 引用外链 mp3（soundjay），无本地降级 | 🟡 依赖外链，可用性【待确认】 |
| 线上支付 | 无支付网关 SDK；会员购卡走「线下收款 + 开发者确认」 | ❌ 未接入 |
| 地图选点 | 经纬度手动输入占位，未接高德/腾讯地图选点 | ❌ 占位 |

---

## 4. 各页面用途

### 4.1 `public/`（Web）
| 文件 | 用途 | 备注 |
|---|---|---|
| index.html | 品牌门户，三端入口（商家/供应商/开发者）+ 隐私政策/服务协议 | 响应式 |
| merchant-login.html | 商家登录/注册（含首访欢迎弹窗，7 天记忆） | 注册即送首月体验 |
| admin.html + js/admin.js | **商家后台**，14 栏目单页 | 见下表 |
| customer.html + js/customer.js | 顾客扫码点餐（菜单/购物车/结算/积分/储值/积分换菜/成功页） | 需 `?shopId=` |
| kitchen.html + kitchen.js | 后厨看单（2s 轮询、语音播报、状态过滤、完成出餐） | 需 `?shopId=` |
| bigscreen.html + js/bigscreen.js | 大屏展示（5s 轮询、提示音、语音播报） | 需 `?shopId=` |
| supplier-login.html | 供应商登录/注册（含欢迎弹窗） | |
| supplier-dashboard.html | **供应商后台**，9 栏目 + 状态闸门页（逻辑内联） | 见下表 |
| dev-login.html | 开发者登录 | |
| dev-console.html | **开发者控制台**，10 栏目（逻辑内联） | 见下表 |
| privacy.html / terms.html | 隐私政策 / 服务条款静态页 | |

**商家后台（admin.html）14 栏目**：菜单管理、桌台管理、订单管理、数据统计、店铺装修、店铺设置、会员中心、鼎恒币中心、采购商城、采购订单、采购监控、顾客积分、顾客储值、营销活动。
**供应商后台（supplier-dashboard.html）9 栏目**：待处理订单、今日改价、分拣过秤、商品管理、开通接单、配送单、通知设置、数据统计、合作结算；另有闸门页（审核中/拒绝/冻结/签协议）。
**开发者控制台（dev-console.html）10 栏目**：总览、商家管理、供应商管理、返点中心、得币倍率、对账中心、营销活动、会员购卡、通知日志、系统设置。

### 4.2 `uni-app/`（小程序）
见 3.4。仅覆盖商家端 4 页 + 顾客端 1 页。

---

## 5. 关键逻辑

### 5.1 订单状态

**点餐订单 Order.status**（2 态）
```
pending(待处理) ──(PUT /api/orders/:id/complete，后厨/后台)──▶ completed(已完成)
```
- 下单即 `pending` 并占用桌台；完成即置 `completed` 并释放桌台。
- `orderType=pointsRedeem` 为积分换菜生成的 0 元单（桌号"积分兑换"），同走 pending→completed。

**采购订单 PurchaseOrder.status**（5 态枚举，实际流转 4 态）
```
待确认 ──(供应商 confirm)──▶ 已确认 ──(供应商 ship/deliver)──▶ 已发货 ──(商家 confirm-receive)──▶ 已完成
```
- schema enum 含"已收货"但实际不落该状态（收货直接置"已完成"）。
- 附加状态位：`sorted`（全行 `weighed=true` 即已分拣，不改 status）、`deliveryPhotoUrl/deliveredAt`（已发货后拍照送达，仍处已发货）。
- 重复收货保护：`rewardCoin !== 0` 拒绝重复结算。

**结算单 RebateSettlement.status**
```
待结算 ──(dev confirm)──▶ 已确认 ──(dev paid)──▶ 已收款
```
- 历史"已结算"由 `normalizeSettlementStatus` 归一为"已确认"；`settledAt` 起超 15 天未收款标记逾期。

### 5.2 角色权限与多租户隔离
- 三端 JWT，payload 规范：merchant `{userId,role,shopId,shopName}`、supplier `{userId,role,supplierId}`、dev `{userId,role}`。
- `requireMerchant`：校验 role + 请求携带的 shopId 必须与 token 一致（防越权操作他人店铺）。
- `requireSupplier` / `requireDev`：校验 role。
- 公开接口用 `requirePublicShopId`：shopId 来源优先级 `x-shop-id` 头 > query > body，缺少返回 400。
- 数据隔离原则：所有查询/写入条件必须带 `shopId`（商家侧）或 `supplierId`（供应商侧）。
- 权益控制点：`checkFeature(featureName)` + `dhConfig.features` + `isMembershipActive`；前端 `goUpgrade` 统一升级引导。

### 5.3 计费与分账（核心商业规则）

**（1）会员定价（`utils/dhConfig.js`）**
| 档位 | 人民币月卡 | 鼎恒币月卡 | 采购返币汇率 |
|---|---|---|---|
| basic 基础版 | ¥59 | 2000 币 | 0.5 币/元 |
| advanced 进阶版 | ¥99 | 3000 币 | 1 币/元 |
| premium 尊享版 | ¥199 | 5000 币 | 1 币/元 |
- 新店注册赠送 basic 30 天体验（Member pre-save）。
- 升级折算：`DAILY_COIN = {basic:67, advanced:100, premium:167}`（币/天）。
- 功能权益矩阵（`dhConfig.features`）：customerPoints 基础版起；marketingDiscount 进阶版+；marketingCategoryDiscount/marketingRecharge/marketingFull 尊享版；reportBasic 进阶版+；reportAdvanced 尊享版。

**（2）鼎恒币（虚拟币，零成本）**
- 获取：采购收货发币 `rewardCoin = Σ(行实付金额 × 会员币汇率 × 品类倍率)`，向下取整；新手四步任务 500 币。
- 券抵扣部分不返币（按 `actualPayAmount/totalAmount` 分摊）。
- 品类倍率来自 `CoinRule`（未配置=1 倍；精确品类→"其他"兜底→默认 1）。
- 有效期 90 天；每日 02:00 按批次过期清零（FIFO：`deductCoinsFifo` 按 `remaining` 批次扣减）。
- 兑换：会员月卡（同级续费/升级折算/降级拒绝）、抵用券（按等级+余额）。

**（3）抵用券定价（`dhConfig.COUPONS`，商家用币兑换，用于采购抵扣）**
| 面额 | 币价 | 门槛 | 最低等级 |
|---|---|---|---|
| 10 元 | 800 | 满 300 | basic |
| 20 元 | 1500 | 满 500 | basic |
| 30 元 | 2100 | 满 800 | basic |
| 50 元 | 3200 | 满 1200 | advanced |
| 100 元 | 6000 | 满 2500 | advanced |
| 200 元 | 11000 | 满 4000 | premium |
| 300 元 | 15000 | 满 6000 | premium（locked） |
| 500 元 | 24000 | 满 10000 | premium（locked） |
- 券 30 天有效；采购下单每单限一张、券不返币；平台利润 = 返点 − 券成本（对账中心口径）。

**（4）阶梯返点（`utils/rebate.js`）**
- 供应商模式 `Supplier.rebateMode`：
  - `unified` 统一全品类：整月全部采购额合并按 `DEFAULT_TIERS_UNIFIED` 定档（0-5万 1% / 5-15万 1.5% / 15-50万 2% / 50-100万 2.5% / 100-200万 3% / 200-500万 4% / 500万+ 5%，全额累进）。
  - `byCategory` 分类毛利：按品类归入 lowMargin/midMargin/highMargin 三套阶梯分别定档后汇总（classifyMarginCategory 映射，未命中保守按低毛利）。
- 累进算法 `tier.mode`：`full` 全额累进 / `marginal` 超额分段。
- 专属 `RebateRule`（按供应商+品类，"全部"通用规则兜底）优先于平台默认阶梯。
- 订单完成时仅写**预估返点** `preRebate`；实际返点由月度结算 `settleMonth` 回写 `actualRebateAmount` 并计入 `Supplier.balance`。
- 月份归属按 `receiveAt`（无则 `createdAt`）；月结幂等（已有结算单跳过）。

**（5）顾客积分（基础版起开放）**
- 开关：`Setting.pointEnabled` + 会员有效期 + `pointSpendPerPoint>0` 同时满足（`getPointConfig`）。
- 返积分：`earn = floor(实付金额 × pointSpendPerPoint)`（默认 1 元=1 分）。
- 抵现：`pointDeductPoints`（默认 100 积分=1 元）、`pointDeductMaxPercent`（默认单笔最多抵 20%）。
- 积分换菜：商家配 `pointExchangeDishes`（默认 300 分），顾客兑换生成 0 元单；`findOneAndUpdate` 条件扣减防超扣。

**（6）储值（顾客维度）**
- 商家线下收款登记充值，命中「充值送」活动门槛叠加 bonus。
- 点餐结算可选储值抵扣：`min(balance, finalTotal)`；下单后二次读取校验，余额不足/异常则回退本单储值部分（`server.js` 补偿式防超扣，**未用事务/原子条件更新**）。

**（7）营销活动（点餐侧计价，`utils/marketingCalc.js`）**
| 类型 | 等级 | 规则 | 参与计价 |
|---|---|---|---|
| 满减 fullReduction | 进阶版+ | 满 X 减 Y，折扣后小计取减免最大者 | ✅ |
| 分类折扣 discount | 尊享版 | 必须指定分类，取最低 rate | ✅ |
| 充值送 rechargeBonus | 尊享版 | 充值送，作用于储值充值 | ✅（作用于储值，不参与点餐计价） |
- 计价顺序：先折扣 → 后满减；后端权威计算，前端同规则展示。

---

## 6. 已完功能（有代码证据）

**认证与平台**
- 三端注册/登录/改密，JWT(7天)，bcrypt 密码哈希，默认开发者账号自动创建。
- 多租户 shopId 隔离 + 店铺公开标识提取/校验。
- 图片上传（菜品/装修、供应商资质，multer 2MB）。

**门店经营**
- 分类/菜品/桌台 CRUD；桌台占用-释放联动。
- 顾客点餐：菜单（5 主题 × 3 排版 × 4 字体）、购物车、桌号、备注、手机号。
- 后端权威计价：满减、分类折扣、积分抵现、储值抵扣、原价/优惠明细。
- 后厨看单（2s 轮询、语音播报、完成出餐）、大屏展示（5s 轮询）。
- 新手开张四步曲（菜品/装修/预览/逛商城）+ 500 鼎恒币开张礼（幂等）。
- 门店资料完善引导（首次强制/黄条提醒）。

**供应链**
- 供应商入驻治理状态机（pending/active/frozen/rejected）+ 协议签署 + 4 图资质核验 + 开通接单。
- 采购商城（供应商店铺列表/商品目录/采购车/起送价/抵用券/预计得币）。
- 采购下单（事务建单+核销券）、囤货保护与跌价预检。
- 采购订单流转：确认/发货/分拣过秤（按实称重算金额）/打票（80mm 小票、一键打全票、分拣标签）/拍照送达（高德导航）。
- 收货自动结算（事务）：预估返点 + 采购积分 + 鼎恒币发币。
- 返点体系：RebateRule 增删改查、unified/byCategory 模式、月度结算、结算单状态流转、对账中心。
- 供应商智能定价：今日改价工作台、品类规则、建议售价、保鲜期三阶段保护（提醒/冻结/自动下架）。
- 合作结算页（分品类预估、档位、默认阶梯公示、历史结算、逾期标记）。

**会员与营销**
- 会员中心（三档定价、人民币购卡弹窗占位、鼎恒币兑换、权益展开）。
- 鼎恒币中心（余额/流水/兑换会员/兑换券/月进度/券包）。
- 会员现金购卡订单（pending/paid/cancelled，开发者确认开通、到期顺延、禁止降级）。
- 顾客积分（配置/查询/下单累计/抵现/积分换菜）。
- 顾客储值（线下充值记账、充值送、点餐抵扣、账户与流水查询）。
- 营销活动（满减/折扣/充值送 CRUD + 公开 active）。

**报表与监控**
- 经营报表（营收/订单/客单价/趋势/热销 Top10/分类占比）。
- 顾客画像（复购率、Top20，手机号脱敏）。
- 损耗分析（采购投入 vs 点餐营收、品类对比、成本占比）。
- 采购监控（防回扣，只读）。
- 开发者控制台全量：平台总览、商家/供应商管理、审核、返点、得币倍率、对账、会员购卡、通知日志、平台配置。

**通知**
- 通知引擎 `notifyOrderCreated`：本地渠道（voice/bigscreen 由各端监听）+ 云端渠道（printer/webhook/sms/voice）真实 HTTP POST，写 `NotificationLog`。
- 供应商 webhook 事件推送（5 类事件）。

**定时任务**
- 每日 02:00：鼎恒币过期清理、会员到期降级、券过期、保鲜期保护。
- 每月 1号 03:00：供应商返点月度结算（幂等）。

---

## 7. 未完成功能 / 技术债 / 占位

| # | 项 | 现状 | 证据 |
|---|---|---|---|
| 1 | 线上支付 | 未接入任何支付网关；会员购卡为「线下收款 + 开发者确认」，客服电话硬编码 | `routes/membership.js`、`models/MembershipOrder.js` 注释 |
| 2 | 微信通知 | `Setting.enableWechat` 仅前端开关，服务端无发送分支；`NotificationLog` 枚举含 wechat 但从未写入 | `utils/notify.js` 无 wechat 分支 |
| 3 | 大屏提示音 | 引用外链 mp3，无本地降级 | `js/bigscreen.js` |
| 4 | 电子秤 | 仅 WebSerial 骨架可运行，WebUSB/蓝牙为占位，默认手输 | `supplier-dashboard.html` `getScaleWeight` |
| 5 | 地图选点 | 经纬度手动输入占位，未接高德/腾讯地图 SDK | `models/Setting.js` 注释 |
| 6 | 储值充值/抵扣并发 | 读改写，无事务/无原子自增；抵扣为「回退式」防超扣，极窄并发窗口理论上可超扣 | `routes/storedValue.js`、`server.js:249-276` |
| 7 | 会员订单缺自动过期 | pending 订单无超时自动取消机制 | `routes/membership.js` |
| 8 | 报表口径 | 仅滚动 N 天（默认30，1-90），无自然月/环比/同比 | `routes/reports.js` |
| 9 | 供应商定价 | `yesterdayPrice` 非真实历史价（=当前 marketPrice）；无删除品类规则接口；`getRule` 未被调用；`isCustom` 恒为 false | `routes/supplierPrice.js`、`utils/priceRule.js` |
| 10 | JWT_SECRET | 默认硬编码 `dingheng_canyin_jwt_secret_2024`（`.env` 未设置时生效） | `middlewares/auth.js:4` |
| 11 | 币兑换路由鉴权 | `/api/coin/exchange-*` 未挂 JWT 中间件，shopId 由 body 传入 | `routes/coin.js`、`server.js` |
| 12 | 供应商注册接口 | `POST /api/suppliers` 无鉴权（注册即 pending，依赖人工审核） | `server.js:1003` |
| 13 | 合作关系文本 | 合作协议正文为占位文本；客服联系方式为占位（400-000-0000 / support@dingheng.com） | `supplier-dashboard.html` |
| 14 | 小程序 | 仅覆盖商家 4 页 + 顾客 1 页，与 Web 端重复维护；发布状态【待确认】 | `uni-app/src` |
| 15 | 采购单"已收货"枚举 | schema 含但实际不落该状态 | `models/PurchaseOrder.js` |
| 16 | Coupon 'expired' 状态 | 由每日定时任务写入（`expireCoupons`），但查询侧亦以 expireDate 兜底 | `utils/dhCron.js` |
| 17 | 运维脚本残留 | `check_data.js`、`cleanAdminPassword.js`、`cleanFakeData.js`、`migrate_password.js`、`migrate_rebate_mode.js`、`migrate_shopid.js`、`seedProducts.js`、`simulatePriceSystem.js`、`verify_*.js` 存于根目录 | 根目录 |
| 18 | 无热加载 | 改 models/server 必须重启；旧进程 + mongoose strict 会静默丢字段 | — |
| 19 | 文档过时 | `鼎恒科技系统全量文档.md` 部分结论已过时（如"报表无接口""通知仅 console"），以本文件/代码为准 | — |
| 20 | 部署方式 | 生产部署（PM2/容器/云主机）与备份策略代码中无体现 | 【待确认】 |

---

## 8. 待确认清单

1. 生产部署与进程管理方式（PM2？Docker？云主机规格）——代码无体现。
2. 小程序是否已发布/需绑定哪个 AppID、是否与 Web 端同步迭代。
3. 大屏外链 mp3 的可用性与授权。
4. 三方服务（云打印/短信/语音/webhook）实际是否已签约配置。
5. 是否计划接入线上支付（微信/支付宝），以及资金分账/发票方案。
6. 商业模式相关表述（PROGRESS.md 中"商业模式待补充"）。
7. `refund_deduct`（退款扣回）等枚举是否计划启用。
8. 数据备份、日志留存与合规（等保/隐私）要求。

---

## 9. 关键文件索引（便于定位）

| 主题 | 文件 |
|---|---|
| 服务入口与主流程 | [server.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/server.js) |
| 鉴权与租户隔离 | [auth.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/middlewares/auth.js) |
| 平台常量（定价/权益/阶梯） | [dhConfig.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/utils/dhConfig.js) |
| 返点计算 | [rebate.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/utils/rebate.js) |
| 发币计算 | [coinRule.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/utils/coinRule.js) |
| 点餐优惠计算 | [marketingCalc.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/utils/marketingCalc.js) |
| 通知引擎 | [notify.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/utils/notify.js) |
| 定时任务 | [dhCron.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/utils/dhCron.js) |
| 采购全流程 | [purchaseOrders.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/routes/purchaseOrders.js) |
| 智能定价 | [supplierPrice.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/routes/supplierPrice.js)、[priceRule.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/utils/priceRule.js) |
| 经营报表 | [reports.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/routes/reports.js) |
| 顾客储值 | [storedValue.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/routes/storedValue.js) |
| 会员购卡 | [membership.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/routes/membership.js) |
| 履约功能设计（分拣/打票/配送） | [分拣打票与配送支持.md](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/.trae/documents/分拣打票与配送支持.md) |
