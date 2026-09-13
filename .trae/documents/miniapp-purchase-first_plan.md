# 小程序「采购为核心」改造 实施计划

> 范围：仅 uni-app 小程序端（`uni-app/`）。Web 后台与后端已在双产品线重构中完成，本轮只做小程序。
> 前置：后端双产品线接口已全部就绪（阶段 0/1/2/3 完成）。

## 一、Repository Research（小程序现状）

- 技术栈：uni-app（Vue 3 + Vite），请求统一封装在 [request.js](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/uni-app/src/utils/request.js)（自动带 `Authorization` + `x-shop-id`，baseURL 走 `VITE_API_BASE_URL`）
- 页面：[pages.json](file:///c:/Users/ZhuanZ（无密码）/Desktop/dingheng-canyin/uni-app/src/pages.json) 现 6 页：
  - `pages/login/index`（商家登录/注册）
  - `pages/customer/index`（顾客扫码点餐）
  - `pages/admin/index`（首页 = **店铺设置**，非采购）
  - `pages/admin/menu`、`pages/admin/order`、`pages/admin/stats`
- tabBar 现为 **点餐优先**：店铺 / 菜单 / 订单 / 数据统计 —— 没有任何采购入口
- 首页 `admin/index.vue` 是"店铺设置（通知/打印）"，与"采购为核心"定位不符

### 后端可直接复用的接口（已存在，无需改动）
| 能力 | 接口 |
|---|---|
| 补货建议（免费） | `GET /api/admin/smart-replenish/suggestions` |
| 30 天预测（plus+，free 返回 `locked`+`previewSample`） | `GET /api/admin/smart-replenish/forecast` |
| 低库存菜品（BOM+库存） | `GET /api/admin/low-stock-dishes` |
| 商城商品 | `GET /api/supply-products`（商家侧公开） |
| 采购下单 / 列表 | `POST /api/purchase-orders`、`GET /api/purchase-orders?status=` |
| 币与双线状态 | `GET /api/coin/status/:shopId` |
| 兑换月卡 / 券 / 增值包 | `POST /api/coin/exchange-membership`、`/exchange-coupon`、`/exchange-addon` |
| 省钱账单 | `GET /api/admin/procurement-monitor/savings` |

## 二、目标形态（tabBar 采购优先）

| tab | 页面 | 说明 |
|---|---|---|
| 🛒 采购 | `pages/admin/index`（改造为采购管家首页） | 智能补货建议 + 快断货提醒 + 省钱账单摘要 + 快捷入口 |
| 商城 | `pages/admin/mall`（新增） | 商品列表/搜索/分类 → 加购 → 下单 |
| 采购单 | `pages/admin/purchase`（新增） | 采购订单列表 + 状态 + 详情 |
| 我的 | `pages/admin/member`（新增） | 鼎恒币余额 + 两条产品线卡片 + 兑换（月卡/券/增值包） |

- **门店经营（点餐）不删除**：菜单/订单/统计/店铺设置 收进「我的 → 门店经营」入口，保留全部功能（生长式，不砍功能）
- 顾客扫码点餐页 `pages/customer/index` 保持不变

## 三、Files and Modules

### 新增
- `uni-app/src/pages/admin/mall.vue`：采购商城（列表 + 加购 + 提交订单）
- `uni-app/src/pages/admin/purchase.vue`：采购订单列表（状态筛选、下拉刷新）
- `uni-app/src/pages/admin/member.vue`：会员中心（币余额 + 采购线/点餐线两卡 + 兑换专区分组）
- `uni-app/src/pages/admin/more.vue`：门店经营入口（跳菜单/订单/统计/店铺设置——点餐功能收纳，不删）
- `uni-app/src/utils/coin.js`（可选）：币/会员相关接口封装，避免页面内散落请求

### 改造
- `uni-app/src/pages.json`：
  - tabBar 重排为 采购 / 商城 / 采购单 / 我的（需新增 tabbar 图标：采购、商城、我的）
  - 新增上述页面注册；保留原有页面注册（点餐页从 tabBar 移出但页面保留）
- `uni-app/src/pages/admin/index.vue`：由"店铺设置"改为"采购管家首页"
  - 智能补货建议（免费）+ 快断货菜品（低库存）+ 省钱账单摘要 + 大按钮快捷入口
  - 预测区块：免费账号按后端 `locked` 展示模糊预览 + "升级采购省钱卡"引导（不弹窗）
  - 原店铺设置内容 **迁移到 more.vue**（不丢功能）
- `uni-app/src/pages/admin/menu.vue`（可选）：顶部加低库存菜品提醒条 + 去商城入口

### 复用/不改
- `utils/request.js`、`utils/cart.js`、`utils/audio.js`、`App.vue`、`main.js`、`pages/login`、`pages/customer`

## 四、Implementation Steps（依赖序）

1. **页面骨架**：新增 mall / purchase / member / more 四个 .vue 空壳 + pages.json 注册（先保证编译通过）
2. **tabBar 重排**：调整 tabBar list 顺序与图标；补齐 3 个 tab 图标资源（采购/商城/我的，含选中态）；原 4 个 tab 页移出 tabBar（页面保留）
3. **首页改造 `admin/index.vue`**：
   - 顶部：店铺名 + 采购线档位标签（来自 `/api/coin/status`）
   - 快断货卡片：`low-stock-dishes`（无数据则隐藏）
   - 补货建议：`smart-replenish/suggestions`；预测区按 `locked` 渲染引导
   - 快捷入口：商城 / 采购单 / 会员（`uni.switchTab`）
   - 店铺设置整块迁到 `more.vue`
4. **商城 `mall.vue`**：商品列表（搜索 + 分类）→ 加购（本地购物车，复用 `utils/cart.js` 思路）→ 结算（提交 `/api/purchase-orders`），展示返币提示
5. **采购单 `purchase.vue`**：`GET /api/purchase-orders` 列表 + 状态徽标 + 下拉刷新 + 空状态引导去商城
6. **会员 `member.vue`**：
   - 顶部币余额与到期
   - 采购线卡（免费/省钱卡/Pro，含到期与状态）+ 点餐线卡
   - 兑换专区：采购券 / 采购月卡 / 点餐月卡 / 增值包（分组，含"余额不足/已生效"态）
   - 兑换走既有接口，成功后刷新
7. **more.vue**：门店经营入口（菜单/订单/统计/店铺设置）+ 退出登录
8. **构建校验**：`npm run build:mp-weixin` 通过
9. **联调**：微信开发者工具跑登录 → 首页（补货/断货）→ 商城下单 → 采购单 → 会员兑换

## 五、Dependencies and Considerations
- 图标资源：tabBar 新增 3 组图标（采购/商城/我的，PNG 81×81 含选中态）。若暂无设计稿，先用临时占位图标（纯色方块或复用现有图标）保证可编译，后续替换
- 小程序包体：新增 4 页，注意图片资源体积；商城商品图走网络 URL 不做本地打包
- 请求域名：真机/体验版需 `VITE_API_BASE_URL` 指向合法 https 域名（与上线专项一致，非本轮阻塞）
- 权限差异：免费账号在首页看到预测"模糊预览 + 引导"，与 Web 端行为一致
- 顾客扫码点餐页不动，避免影响现有扫码流程
- `x-shop-id` 与 `Authorization` 已由 request.js 统一处理，无需页面重复处理

## 六、Validation
- `npm run build:mp-weixin` 编译通过（无语法/路径错误）
- 微信开发者工具走查：
  1. 登录后落地「采购」首页，补货/断货/省钱摘要正确展示；无数据时优雅空态
  2. 免费账号：预测区显示引导而非报错；plus/pro 账号：预测正常展示
  3. 商城加购 → 下单成功 → 采购单列表出现该单
  4. 会员页：币余额、两条线卡片、兑换（月卡/券/增值包）成功并刷新
  5. 门店经营入口可进入菜单/订单/统计/店铺设置（原有功能不丢）
  6. 顾客扫码点餐页不受影响

## 七、Risks
- **tabBar 图标缺失导致编译/显示异常**：先用占位图标保证可跑，图标作为可替换项标注
- **点餐功能被"藏起来"引发不便**：保留独立入口 + 页面不删；后续可加"常用"快捷
- **一次改造面较大**：按上表分步提交（骨架 → 首页 → 商城 → 采购单 → 会员 → more），每步可编译
- **真机网络限制**：开发期用开发者工具"不校验合法域名"，上线前统一配 https 域名
