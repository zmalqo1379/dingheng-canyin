<template>
  <view class="page">
    <!-- 余额 -->
    <view class="wallet">
      <view class="wallet-deco deco-1"></view>
      <view class="wallet-deco deco-2"></view>
      <view class="wallet-label">鼎恒币余额</view>
      <view class="wallet-num">{{ coin }}<text class="unit"> DH</text></view>
      <view class="wallet-sub">累计获得 {{ totalEarned }} DH · 进货即得，可兑券兑会员</view>
    </view>

    <!-- 两条产品线 -->
    <view class="line-card">
      <view class="line-ico">🛒</view>
      <view class="line-main">
        <view class="line-head">
          <text class="line-name">{{ purchaseName }}</text>
          <text class="line-state" :class="{ off: !purchaseActive }">{{ purchaseExpireText }}</text>
        </view>
        <view class="line-desc">采购商城 · 返币翻倍 · 大额券 · 智能预测</view>
      </view>
    </view>
    <view class="line-card">
      <view class="line-ico pos">🍴</view>
      <view class="line-main">
        <view class="line-head">
          <text class="line-name">{{ posName }}</text>
          <text class="line-state" :class="{ off: !posActive }">{{ posExpireText }}</text>
        </view>
        <view class="line-desc">扫码点餐 · 满减 · 报表 · 高级装修</view>
      </view>
    </view>

    <!-- 采购省钱卡兑换 -->
    <view class="card">
      <view class="card-title">🛒 采购省钱卡兑换</view>
      <view class="ex-row" v-for="p in purchasePlans" :key="p.level">
        <view class="ex-main">
          <text class="ex-name">{{ p.name }}</text>
          <text class="ex-desc">{{ p.desc }}</text>
        </view>
        <button class="ex-btn" :disabled="p.disabled" @tap="exchangeMembership(p.level, 'purchase')">
          {{ p.btnText }}
        </button>
      </view>
    </view>

    <!-- 采购抵用券兑换 -->
    <view class="card">
      <view class="card-title">🎟️ 采购抵用券兑换</view>
      <view class="ex-row" v-for="c in coupons" :key="c.type">
        <view class="ex-main">
          <text class="ex-name">¥{{ c.faceValue }} 抵用券</text>
          <text class="ex-desc">满 {{ c.minOrder }} 可用 · 需 {{ c.coinCost }} 币</text>
        </view>
        <button class="ex-btn" :disabled="c.disabled" @tap="exchangeCoupon(c)">
          {{ c.btnText }}
        </button>
      </view>
    </view>

    <!-- 点餐版兑换 -->
    <view class="card">
      <view class="card-title">🍴 点餐版兑换</view>
      <view class="ex-row" v-for="p in posPlans" :key="p.level">
        <view class="ex-main">
          <text class="ex-name">{{ p.name }}</text>
          <text class="ex-desc">{{ p.desc }}</text>
        </view>
        <button class="ex-btn" :disabled="p.disabled" @tap="exchangeMembership(p.level, 'pos')">
          {{ p.btnText }}
        </button>
      </view>
    </view>

    <!-- 人民币现金购卡（线下收款 + 平台确认） -->
    <view class="card">
      <view class="card-title">💳 人民币购卡</view>
      <view class="ex-row" v-for="p in CASH_PLANS" :key="p.key">
        <view class="ex-main">
          <text class="ex-name">{{ p.name }}</text>
          <text class="ex-desc">¥{{ p.price }}/月 · 或 {{ p.coinCost }} 鼎恒币/月</text>
        </view>
        <button class="ex-btn" @tap="openCashSheet(p)">¥{{ p.price }} 购卡</button>
      </view>
      <view class="tip">现金购卡需线下联系客服确认收款，确认后自动开通</view>
    </view>

    <!-- 币兑增值包 -->
    <view class="card" v-if="addons.length">
      <view class="card-title">💎 币兑增值包</view>
      <view class="ex-row" v-for="a in addons" :key="a.key">
        <view class="ex-main">
          <text class="ex-name">{{ a.name }}</text>
          <text class="ex-desc">{{ a.desc }} · {{ a.days }} 天 · 需 {{ a.coinPrice }} 币</text>
          <text class="ex-active" v-if="activeAddonMap[a.key]">已生效 · 至 {{ fmt(activeAddonMap[a.key]) }}</text>
        </view>
        <button class="ex-btn" :disabled="coin < a.coinPrice" @tap="exchangeAddon(a)">
          {{ coin < a.coinPrice ? '币不足' : (activeAddonMap[a.key] ? '续兑' : '兑换') }}
        </button>
      </view>
      <view class="tip">增值包到期自动失效，不影响会员等级</view>
    </view>

    <view class="foot">
      <button class="foot-btn" @tap="logout">退出登录</button>
    </view>

    <!-- 现金购卡：选月数弹窗 -->
    <view class="mask" v-if="showCashSheet" @tap="showCashSheet = false"></view>
    <view class="sheet" v-if="showCashSheet">
      <view class="sheet-title">{{ cashTarget ? cashTarget.name : '' }}</view>
      <view class="sheet-sub">¥{{ cashTarget ? cashTarget.price : 0 }}/月 · 选择购买月数（1-12 个月）</view>
      <view class="qty-row">
        <text class="qty-btn" @tap="decCashMonths">－</text>
        <input class="qty-input" type="number" v-model="cashMonths" />
        <text class="qty-btn" @tap="incCashMonths">＋</text>
      </view>
      <button class="sheet-btn" :loading="cashSubmitting" @tap="submitCashOrder">确认购卡（¥{{ cashTotal() }}）</button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { get, post, getToken, getShopId } from '@/utils/request.js';

const LEVEL_NAME = {
  basic: '点餐免费版', advanced: '点餐进阶版', premium: '点餐尊享版',
  free: '采购免费版', plus: '采购省钱卡', pro: '采购省钱卡Pro'
};
const PURCHASE_RANK = { free: 0, plus: 1, pro: 2 };
const POS_RANK = { basic: 0, advanced: 1, premium: 2 };
const COUPON_NEED = { basic: 'free', advanced: 'plus', premium: 'pro' };
// 与后端 utils/dhConfig.js COUPONS 保持一致（面额 / 币价 / 门槛 / 所需采购等级）
const COUPON_TIERS = [
  { type: 'purchase_10', faceValue: 10, coinCost: 800, minOrder: 300, need: 'free' },
  { type: 'purchase_20', faceValue: 20, coinCost: 1500, minOrder: 500, need: 'free' },
  { type: 'purchase_30', faceValue: 30, coinCost: 2100, minOrder: 800, need: 'free' },
  { type: 'purchase_50', faceValue: 50, coinCost: 3200, minOrder: 1200, need: 'plus' },
  { type: 'purchase_100', faceValue: 100, coinCost: 6000, minOrder: 2500, need: 'plus' },
  { type: 'purchase_200', faceValue: 200, coinCost: 11000, minOrder: 4000, need: 'pro' }
];
const PLAN_CFG = {
  plus: { coinCost: 3000 }, pro: { coinCost: 5000 },
  advanced: { coinCost: 1500 }, premium: { coinCost: 2400 }
};
// 人民币现金购卡定价（与后端 dhConfig POS_PRICING / PURCHASE_PRICING 保持一致）
const CASH_PLANS = [
  { key: 'plus', line: 'purchase', name: '采购省钱卡', price: 99, coinCost: 3000 },
  { key: 'pro', line: 'purchase', name: '采购省钱卡Pro', price: 199, coinCost: 5000 },
  { key: 'advanced', line: 'pos', name: '点餐进阶版', price: 39, coinCost: 1500 },
  { key: 'premium', line: 'pos', name: '点餐尊享版', price: 79, coinCost: 2400 }
];

const coin = ref(0);
const totalEarned = ref(0);
const purchaseLevel = ref('free');
const posLevel = ref('basic');
const purchaseActive = ref(true);
const posActive = ref(true);
const purchaseExpire = ref(null);
const posExpire = ref(null);
const addons = ref([]);
const activeAddons = ref([]);
const showCashSheet = ref(false);
const cashTarget = ref(null);
const cashMonths = ref(1);
const cashSubmitting = ref(false);

const purchaseName = computed(() => LEVEL_NAME[purchaseLevel.value] || '采购免费版');
const posName = computed(() => LEVEL_NAME[posLevel.value] || '点餐免费版');
const purchaseExpireText = computed(() => fmtState(purchaseActive.value, purchaseExpire.value));
const posExpireText = computed(() => fmtState(posActive.value, posExpire.value));
const activeAddonMap = computed(() => {
  const m = {};
  activeAddons.value.forEach(a => { m[a.addonKey] = a.expireAt; });
  return m;
});

function fmt(d) {
  return d ? String(d).slice(0, 10) : '';
}
function fmtState(active, expire) {
  if (!active) return '已过期';
  return expire ? ('到期 ' + fmt(expire)) : '长期有效';
}

// ---- 兑换项（含按钮态，实时随余额/等级变化）----
const purchasePlans = computed(() => buildPlans([
  { level: 'plus', desc: '返币翻倍 1元=1币 · 100元券 · 30天预测' },
  { level: 'pro', desc: '200元券 · 比价降价提醒 · 优先配送' }
], PURCHASE_RANK, purchaseLevel.value, purchaseActive.value, 'purchase'));

const posPlans = computed(() => buildPlans([
  { level: 'advanced', desc: '满减 · 报表 · 高级装修 · 储值' },
  { level: 'premium', desc: '分类折扣 · 充值送 · 顾客画像 · 损耗分析' }
], POS_RANK, posLevel.value, posActive.value, 'pos'));

function buildPlans(defs, ranks, curLevel, curActive, _line) {
  return defs.map(d => {
    const cost = PLAN_CFG[d.level].coinCost;
    const curRank = ranks[curLevel] ?? 0;
    const tgtRank = ranks[d.level] ?? 0;
    let disabled = false;
    let btnText;
    if (tgtRank < curRank) { disabled = true; btnText = '已是更高等级'; }
    else if (coin.value < cost) { disabled = true; btnText = '币不足'; }
    else {
      btnText = (d.level === curLevel && curActive) ? '续费' : (tgtRank > curRank ? '升级' : '兑换');
    }
    return { ...d, name: LEVEL_NAME[d.level], disabled, btnText };
  });
}

const coupons = computed(() => COUPON_TIERS.map(c => {
  const locked = (PURCHASE_RANK[purchaseLevel.value] ?? 0) < (PURCHASE_RANK[c.need] ?? 0);
  const notEnough = coin.value < c.coinCost;
  let btnText;
  if (locked) btnText = '等级不足';
  else if (notEnough) btnText = '币不足';
  else btnText = '兑换';
  return { ...c, disabled: locked || notEnough, btnText };
}));

// ---- 数据加载 ----
async function load() {
  const shopId = getShopId();
  const d = await get(`/coin/status/${shopId}`, {}, { showError: false });
  if (!d) return;
  coin.value = d.dinghengCoin || 0;
  totalEarned.value = d.totalEarnedCoin || 0;
  purchaseLevel.value = d.purchaseLevel || 'free';
  posLevel.value = d.memberLevel || 'basic';
  purchaseActive.value = d.purchaseActive !== false;
  posActive.value = d.membershipActive !== false;
  purchaseExpire.value = d.purchaseExpire || null;
  posExpire.value = d.memberExpire || null;
  addons.value = d.addons || [];
  activeAddons.value = d.activeAddons || [];
}

function confirmDo(title, content) {
  return new Promise((resolve) => {
    uni.showModal({ title, content, success: (r) => resolve(!!r.confirm), fail: () => resolve(false) });
  });
}

async function exchangeMembership(level, line) {
  const ok = await confirmDo('确认兑换', `确认兑换「${LEVEL_NAME[level]}」？将按后端规则扣减鼎恒币。`);
  if (!ok) return;
  try {
    const res = await post('/coin/exchange-membership', { targetLevel: level, productLine: line });
    uni.showToast({ title: (res && res.message) || '兑换成功', icon: 'none' });
    load();
  } catch (e) {}
}

async function exchangeCoupon(c) {
  const ok = await confirmDo('确认兑换', `确认用 ${c.coinCost} 鼎恒币兑换 ¥${c.faceValue} 采购抵用券？`);
  if (!ok) return;
  try {
    await post('/coin/exchange-coupon', { couponType: c.type });
    uni.showToast({ title: '兑换成功', icon: 'success' });
    load();
  } catch (e) {}
}

async function exchangeAddon(a) {
  const ok = await confirmDo('确认兑换', `确认用 ${a.coinPrice} 鼎恒币兑换「${a.name}」（${a.days} 天）？`);
  if (!ok) return;
  try {
    const res = await post('/coin/exchange-addon', { addonKey: a.key });
    uni.showToast({ title: (res && res.message) || '兑换成功', icon: 'none' });
    load();
  } catch (e) {}
}

// ---- 人民币现金购卡（线下收款 + 平台确认）----
function openCashSheet(p) {
  cashTarget.value = p;
  cashMonths.value = 1;
  showCashSheet.value = true;
}
function cashTotal() {
  const t = cashTarget.value;
  const m = Math.max(1, Math.min(12, Math.floor(Number(cashMonths.value) || 1)));
  return t ? (t.price * m).toFixed(2) : '0.00';
}
function incCashMonths() { cashMonths.value = Math.min(12, (Number(cashMonths.value) || 1) + 1); }
function decCashMonths() { cashMonths.value = Math.max(1, (Number(cashMonths.value) || 1) - 1); }
async function submitCashOrder() {
  const t = cashTarget.value;
  if (!t || cashSubmitting.value) return;
  const months = Math.max(1, Math.min(12, Math.floor(Number(cashMonths.value) || 1)));
  cashSubmitting.value = true;
  try {
    const res = await post('/membership/cash-orders', { level: t.key, productLine: t.line, months }, { raw: true });
    const phone = (res && res.servicePhone) || '';
    const msg = (res && res.reused) ? '你已有待确认的购卡订单' : '购卡订单已提交，等待平台确认';
    uni.showModal({
      title: '提交成功',
      content: `${msg}。请线下联系客服${phone ? '（' + phone + '）' : ''}确认收款，确认后会员自动开通。`,
      showCancel: false,
      confirmColor: '#FF6B35'
    });
    showCashSheet.value = false;
  } catch (e) {
    // request.js 已 toast
  } finally {
    cashSubmitting.value = false;
  }
}

function logout() {
  uni.showModal({
    title: '退出登录',
    content: '确认退出当前账号？',
    success: (r) => {
      if (!r.confirm) return;
      uni.removeStorageSync('token');
      uni.removeStorageSync('shopId');
      uni.reLaunch({ url: '/pages/login/index' });
    }
  });
}

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/index' });
  }
});
onShow(() => { load(); });
</script>

<style lang="scss" scoped>
.page { min-height: 100vh; background: $ink-50; padding-bottom: 60rpx; }

/* ===== 余额卡（VIP 质感） ===== */
.wallet {
  position: relative;
  background: $dark-grad;
  color: #fff; padding: 44rpx 32rpx 56rpx;
  overflow: hidden;
}
.wallet-deco { position: absolute; border-radius: 50%; background: rgba(255, 255, 255, .06); }
.wallet-deco.deco-1 { top: -120rpx; right: -80rpx; width: 320rpx; height: 320rpx; }
.wallet-deco.deco-2 { bottom: -100rpx; left: -40rpx; width: 240rpx; height: 240rpx; }
.wallet-label { font-size: $fs-sm; color: rgba(255, 255, 255, .75); position: relative; z-index: 1; }
.wallet-num { font-size: $fs-4xl; font-weight: $fw-black; margin-top: 10rpx; color: #FFD6A8; position: relative; z-index: 1; }
.wallet-num .unit { font-size: $fs-base; font-weight: $fw-medium; color: rgba(255, 255, 255, .6); }
.wallet-sub { font-size: $fs-sm; color: rgba(255, 255, 255, .6); margin-top: 12rpx; position: relative; z-index: 1; }

/* ===== 产品线 ===== */
.line-card {
  display: flex; align-items: center; gap: 20rpx;
  background: $surface; margin: 20rpx; border-radius: $radius-lg; padding: 24rpx;
  box-shadow: $shadow-sm;
}
.line-card:first-of-type { margin-top: -32rpx; position: relative; z-index: 2; }
.line-ico {
  width: 88rpx; height: 88rpx; border-radius: 28rpx;
  background: $brand-50; display: flex; align-items: center; justify-content: center;
  font-size: 44rpx; flex-shrink: 0;
}
.line-ico.pos { background: #F0F7FF; }
.line-main { flex: 1; display: flex; flex-direction: column; }
.line-head { display: flex; align-items: center; justify-content: space-between; }
.line-name { font-size: $fs-lg; font-weight: $fw-bold; color: $ink-900; }
.line-state { font-size: $fs-sm; color: $success; font-weight: $fw-medium; }
.line-state.off { color: $danger; }
.line-desc { font-size: $fs-sm; color: $ink-400; margin-top: 8rpx; }

/* ===== 兑换卡片 ===== */
.card {
  background: $surface; margin: 20rpx; border-radius: $radius-lg; padding: 8rpx 24rpx 20rpx;
  box-shadow: $shadow-sm;
}
.card-title {
  font-size: $fs-base; color: $brand; font-weight: $fw-semibold;
  padding: 20rpx 0 8rpx; border-bottom: 1rpx solid $ink-100;
}
.ex-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16rpx; padding: 22rpx 0; border-bottom: 1rpx solid $ink-50;
}
.ex-row:last-child { border-bottom: 0; }
.ex-main { flex: 1; display: flex; flex-direction: column; }
.ex-name { font-size: $fs-md; color: $ink-900; font-weight: $fw-medium; }
.ex-desc { font-size: $fs-sm; color: $ink-400; margin-top: 4rpx; }
.ex-active { font-size: $fs-sm; color: $success; margin-top: 4rpx; }
.ex-btn {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-sm; font-weight: $fw-semibold; height: 60rpx; line-height: 60rpx; padding: 0 26rpx;
  min-width: 120rpx; box-shadow: $shadow-brand;
}
.ex-btn[disabled] { background: $ink-100; color: $ink-300; box-shadow: none; }
.tip { font-size: $fs-sm; color: $ink-400; margin-top: 10rpx; }

.foot { padding: 20rpx 40rpx; }
.foot-btn { background: $surface; color: $danger; border-radius: $radius-full; font-size: $fs-md; height: 80rpx; line-height: 80rpx; box-shadow: $shadow-sm; }

/* ===== 现金购卡弹窗 ===== */
.mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, .45);
  z-index: 99;
}
.sheet {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 100;
  background: $surface; border-radius: $radius-lg $radius-lg 0 0;
  padding: 32rpx 32rpx calc(32rpx + env(safe-area-inset-bottom));
}
.sheet-title { font-size: $fs-xl; font-weight: $fw-bold; color: $ink-900; text-align: center; }
.sheet-sub { font-size: $fs-base; color: $ink-400; margin-top: 8rpx; text-align: center; }
.qty-row { display: flex; align-items: center; justify-content: center; gap: 30rpx; margin: 36rpx 0; }
.qty-btn {
  width: 72rpx; height: 72rpx; line-height: 72rpx; text-align: center;
  background: $ink-50; border-radius: 50%; font-size: 36rpx; color: $ink-900;
}
.qty-input {
  width: 160rpx; text-align: center; font-size: $fs-xl;
  border-bottom: 2rpx solid $ink-100; padding: 10rpx 0;
}
.sheet-btn {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-lg; font-weight: $fw-semibold; height: 82rpx; line-height: 82rpx; margin-top: 10rpx;
  box-shadow: $shadow-brand;
}
button::after { border: none; }

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .line-card, .card, .foot-btn { background: #1e1e1e; box-shadow: none; }
  .line-ico { background: #2a2a2a; }
  .line-ico.pos { background: #1f2a38; }
  .card-title, .ex-row { border-color: #2a2a2a; }
  .line-name, .ex-name { color: #e6e6e6; }
  .sheet { background: #1e1e1e; }
  .sheet-title { color: #e6e6e6; }
  .qty-btn { background: #2a2a2a; color: #ddd; }
  .qty-input { color: #e6e6e6; border-color: #2a2a2a; }
}
</style>
