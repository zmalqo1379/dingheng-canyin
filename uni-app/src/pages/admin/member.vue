<template>
  <view class="page">
    <!-- 余额 -->
    <view class="wallet">
      <view class="wallet-label">鼎恒币余额</view>
      <view class="wallet-num">{{ coin }}<text class="unit"> DH</text></view>
      <view class="wallet-sub">累计获得 {{ totalEarned }} DH · 进货即得，可兑券兑会员</view>
    </view>

    <!-- 两条产品线 -->
    <view class="line-card">
      <view class="line-head">
        <text class="line-name">🛒 {{ purchaseName }}</text>
        <text class="line-state" :class="{ off: !purchaseActive }">{{ purchaseExpireText }}</text>
      </view>
      <view class="line-desc">采购商城 · 返币翻倍 · 大额券 · 智能预测</view>
    </view>
    <view class="line-card">
      <view class="line-head">
        <text class="line-name">🍴 {{ posName }}</text>
        <text class="line-state" :class="{ off: !posActive }">{{ posExpireText }}</text>
      </view>
      <view class="line-desc">扫码点餐 · 满减 · 报表 · 高级装修</view>
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
.page { min-height: 100vh; background: #f5f5f5; padding-bottom: 60rpx; }

.wallet {
  background: linear-gradient(135deg, #ff6b35, #ff8a5c);
  color: #fff; padding: 44rpx 32rpx 52rpx;
}
.wallet-label { font-size: 24rpx; opacity: .9; }
.wallet-num { font-size: 60rpx; font-weight: 800; margin-top: 8rpx; }
.wallet-num .unit { font-size: 26rpx; font-weight: 400; }
.wallet-sub { font-size: 22rpx; opacity: .85; margin-top: 10rpx; }

.line-card {
  background: #fff; margin: 20rpx; border-radius: 16rpx; padding: 24rpx;
  box-shadow: 0 2rpx 12rpx rgba(0,0,0,.04);
}
.line-card:first-of-type { margin-top: -28rpx; }
.line-head { display: flex; align-items: center; justify-content: space-between; }
.line-name { font-size: 30rpx; font-weight: 700; color: #333; }
.line-state { font-size: 22rpx; color: #16a34a; }
.line-state.off { color: #ef4444; }
.line-desc { font-size: 22rpx; color: #999; margin-top: 8rpx; }

.card {
  background: #fff; margin: 20rpx; border-radius: 16rpx; padding: 8rpx 24rpx 20rpx;
  box-shadow: 0 2rpx 12rpx rgba(0,0,0,.04);
}
.card-title {
  font-size: 26rpx; color: #ff6b35; font-weight: 600;
  padding: 20rpx 0 8rpx; border-bottom: 1rpx solid #f5f5f5;
}
.ex-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16rpx; padding: 22rpx 0; border-bottom: 1rpx solid #faf7f4;
}
.ex-row:last-child { border-bottom: 0; }
.ex-main { flex: 1; display: flex; flex-direction: column; }
.ex-name { font-size: 28rpx; color: #333; font-weight: 500; }
.ex-desc { font-size: 22rpx; color: #999; margin-top: 4rpx; }
.ex-active { font-size: 22rpx; color: #16a34a; margin-top: 4rpx; }
.ex-btn {
  background: #ff6b35; color: #fff; border-radius: 30rpx;
  font-size: 24rpx; height: 60rpx; line-height: 60rpx; padding: 0 26rpx;
  min-width: 120rpx;
}
.ex-btn[disabled] { background: #e5e5e5; color: #aaa; }
.tip { font-size: 22rpx; color: #bbb; margin-top: 10rpx; }

.foot { padding: 20rpx 40rpx; }
.foot-btn { background: #fff; color: #ef4444; border-radius: 40rpx; font-size: 28rpx; height: 80rpx; line-height: 80rpx; }
button::after { border: none; }

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .line-card, .card, .foot-btn { background: #1e1e1e; box-shadow: none; }
  .card-title, .ex-row { border-color: #2a2a2a; }
  .line-name, .ex-name { color: #e6e6e6; }
}
</style>
