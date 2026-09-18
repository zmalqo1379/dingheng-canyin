<template>
  <view class="page">
    <view class="hero">
      <view class="hero-name">商家认证</view>
      <view class="hero-sub">补齐门店资料后即可不限额下单，首单也能继续直通</view>
    </view>

    <!-- 状态摘要卡 -->
    <view class="card" v-if="status">
      <view class="status-row">
        <view class="status-label">当前状态</view>
        <view class="status-value" :class="status.certified ? 'ok' : 'warn'">
          {{ status.certified ? '已认证 · 可不限额下单' : '未认证' }}
        </view>
      </view>
      <view v-if="!status.certified" class="status-row" v-for="(b, i) in status.missingBlocking" :key="'b' + i">
        <view class="status-label">履约必需</view>
        <view class="status-value warn">{{ b }}</view>
      </view>
      <view v-if="!status.certified && status.missingSkippable && status.missingSkippable.length" class="status-row">
        <view class="status-label">首单可暂缓</view>
        <view class="status-value muted">{{ status.missingSkippable.join('、') }}</view>
      </view>
      <view v-if="!status.certified && status.missingOptional && status.missingOptional.length" class="status-row">
        <view class="status-label">选填待补全</view>
        <view class="status-value muted">{{ status.missingOptional.join('、') }}</view>
      </view>
    </view>

    <!-- 履约必需项：详细地址（经纬度已改为选填 + 后端自动识别） -->
    <view class="card">
      <view class="card-title"><text class="tag tag-block">履约必需</text> 详细地址</view>
      <view class="row">
        <text class="label">详细地址</text>
        <input class="input" v-model="form.shopAddress" placeholder="精确到门牌号，如：xx路xx号" maxlength="200" />
      </view>
      <view class="hint">填写详细地址后，位置会自动识别，无需手动填写经纬度</view>
    </view>

    <!-- 门店定位：选填（后端可按详细地址自动换算，失败也不影响认证与下单） -->
    <view class="card">
      <view class="card-title"><text class="tag tag-opt">选填</text> 门店定位</view>
      <view class="row">
        <text class="label">经度</text>
        <input class="input" type="digit" v-model="form.shopLongitude" placeholder="选填 · 自动识别或选点回填" />
      </view>
      <view class="row">
        <text class="label">纬度</text>
        <input class="input" type="digit" v-model="form.shopLatitude" placeholder="选填 · 自动识别或选点回填" />
      </view>
      <view class="geo-state ok" v-if="geoState === 'ok'">
        <text class="geo-ico">✓</text>
        <text>位置已自动识别</text>
      </view>
      <view class="geo-state warn" v-else-if="geoState === 'failed'">
        <text>位置暂未识别，不影响认证与下单，可稍后补全</text>
      </view>
      <view class="locate-row">
        <view class="locate-btn" @tap="chooseLocation">
          <text class="locate-ico">📍</text>
          <text class="locate-text">{{ form.shopLongitude && form.shopLatitude ? '重新在地图上标注位置（选填）' : '在地图上标注位置（选填）' }}</text>
        </view>
        <view class="locate-pos" v-if="form.shopLongitude && form.shopLatitude">
          <text class="locate-pos-label">已选位置</text>
          <text class="locate-pos-value">{{ Number(form.shopLongitude).toFixed(6) }}, {{ Number(form.shopLatitude).toFixed(6) }}</text>
        </view>
      </view>
      <view class="hint">填写详细地址后，位置会自动识别；也可点上方按钮在地图上标注（选填，标注与否都能提交，坐标系 GCJ-02）</view>
    </view>

    <!-- 合规项 -->
    <view class="card">
      <view class="card-title"><text class="tag tag-skip">合规可暂缓</text> 门头照</view>
      <view class="upload-row">
        <view v-if="form.storeFrontPhoto" class="upload-preview">
          <image :src="form.storeFrontPhoto" mode="aspectFill" class="upload-img" @tap="chooseImage('storeFrontPhoto')" />
          <text class="upload-tip">点击更换</text>
        </view>
        <view v-else class="upload-empty" @tap="chooseImage('storeFrontPhoto')">
          <text class="upload-ico">📷</text>
          <text class="upload-text">点击上传门头照</text>
        </view>
      </view>
      <view class="hint">供供应商配送单页缩略图显示</view>
    </view>

    <view class="card">
      <view class="card-title"><text class="tag tag-skip">合规可暂缓</text> 营业执照</view>
      <view class="upload-row">
        <view v-if="form.businessLicense" class="upload-preview">
          <image :src="form.businessLicense" mode="aspectFill" class="upload-img" @tap="chooseImage('businessLicense')" />
          <text class="upload-tip">点击更换</text>
        </view>
        <view v-else class="upload-empty" @tap="chooseImage('businessLicense')">
          <text class="upload-ico">📄</text>
          <text class="upload-text">点击上传营业执照</text>
        </view>
      </view>
      <view class="hint">本轮仅手动上传；OCR 自动识别留到下一批</view>
    </view>

    <view class="card">
      <view class="card-title">联系电话</view>
      <view class="row">
        <text class="label">手机号</text>
        <input class="input" v-model="form.contactPhone" placeholder="请保持畅通，供应商发货前会与您电话确认" disabled />
      </view>
      <view class="hint warn">请保持此号码畅通，供应商发货前会与您电话确认</view>
    </view>

    <view class="footer">
      <button class="save" :loading="saving" @tap="submit">提交认证</button>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { get, post, getToken, BASE_URL } from '@/utils/request.js';

const status = ref(null);
const saving = ref(false);
// 门店定位状态：'' 未识别 / 'ok' 已有经纬度（自动识别或选点） / 'failed' 自动换算失败（不阻断）
const geoState = ref('');

const form = reactive({
  shopAddress: '',
  shopLongitude: '',
  shopLatitude: '',
  storeFrontPhoto: '',
  businessLicense: '',
  contactPhone: ''
});

async function loadStatus() {
  try {
    const s = await get('/admin/certification/status', {}, { showError: false });
    if (s) status.value = s;
  } catch (e) {}
}

// 微信内置地图选点（uni.chooseLocation）—— 选填能力，失败不阻断
// 返回 GCJ-02 坐标系（与高德一致），可直接入库。
// 前置条件（否则必然 fail）：
//   1) manifest.json → mp-weixin.requiredPrivateInfos 必须声明 chooseLocation / getLocation（已声明）
//   2) 必须配置真实 mp-weixin.appid（测试号/空 appid 下该接口不可用）
//   3) 微信开发者工具的模拟器没有真实 GPS，真机才能稳定使用
// 因此：选点失败一律不报错，引导商家只填详细地址，由后端自动地理编码识别位置。
function chooseLocation() {
  // #ifdef MP-WEIXIN
  uni.chooseLocation({
    success: (res) => {
      if (!res || res.latitude == null || res.longitude == null) return;
      form.shopLongitude = String(Number(res.longitude).toFixed(6));
      form.shopLatitude = String(Number(res.latitude).toFixed(6));
      // 地址回填：仅当原地址为空才覆盖，避免误清空商家手填的门牌号
      if (!form.shopAddress.trim() && res.address) form.shopAddress = res.address;
      geoState.value = 'ok';
      uni.showToast({ title: '已标注位置', icon: 'success' });
    },
    fail: (err) => {
      // 用户主动取消不提示
      if (err && err.errMsg && /cancel/.test(err.errMsg)) return;
      // 选点是选填能力：失败只做引导，不阻断
      uni.showToast({
        title: '地图选点暂不可用，填写详细地址后会自动识别位置',
        icon: 'none',
        duration: 2600
      });
    }
  });
  // #endif
  // #ifndef MP-WEIXIN
  // 非微信端（H5 / APP）暂不支持内置选点；提示并保留手动输入作为兜底
  uni.showToast({ title: '请使用微信小程序打开，或直接填详细地址自动识别', icon: 'none' });
  // #endif
}

async function loadSettings() {
  try {
    const s = await get('/settings', {}, { showError: false });
    if (!s) return;
    form.shopAddress = s.shopAddress || '';
    form.shopLongitude = (s.shopLongitude != null ? String(s.shopLongitude) : '');
    form.shopLatitude = (s.shopLatitude != null ? String(s.shopLatitude) : '');
    form.storeFrontPhoto = s.storeFrontPhoto || '';
    const cert = s.certification || {};
    form.businessLicense = cert.businessLicense || '';
    // 定位状态：已有经纬度视为已识别（自动识别 / 选点都算）；否则看后端记录是否换算失败
    const hasPos = s.shopLongitude != null && s.shopLatitude != null;
    geoState.value = hasPos ? 'ok' : (cert.geoStatus === 'failed' ? 'failed' : '');
  } catch (e) {}
}

// 图片上传：uni.chooseImage → 调 /admin/upload 拿 URL → 写回 form
function chooseImage(field) {
  uni.chooseImage({
    count: 1,
    sizeType: ['compressed'],
    sourceType: ['album', 'camera'],
    success: async (res) => {
      const tempPath = (res.tempFilePaths || [])[0];
      if (!tempPath) return;
      uni.showLoading({ title: '上传中…' });
      try {
        // #ifdef H5
        // H5 用 fetch + FormData
        const blob = await (await fetch(tempPath)).blob();
        const fd = new FormData();
        fd.append('file', blob, 'upload.jpg');
        const r = await fetch(BASE_URL + '/admin/upload', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + getToken(),
            'x-shop-id': uni.getStorageSync('shopId') || ''
          },
          body: fd
        }).then(x => x.json());
        uni.hideLoading();
        if (!r.success) { uni.showToast({ title: r.message || '上传失败', icon: 'none' }); return; }
        form[field] = r.data.url;
        // #endif
        // #ifndef H5
        const upRes = await uni.uploadFile({
          url: BASE_URL + '/admin/upload',
          filePath: tempPath,
          name: 'file',
          header: {
            'Authorization': 'Bearer ' + getToken(),
            'x-shop-id': uni.getStorageSync('shopId') || ''
          }
        });
        uni.hideLoading();
        try {
          const j = JSON.parse(upRes.data || '{}');
          if (!j.success) { uni.showToast({ title: j.message || '上传失败', icon: 'none' }); return; }
          form[field] = j.data.url;
        } catch (e) { uni.showToast({ title: '上传失败', icon: 'none' }); }
        // #endif
      } catch (e) {
        uni.hideLoading();
        uni.showToast({ title: '上传失败', icon: 'none' });
      }
    }
  });
}

async function submit() {
  // 必需项：详细地址（履约必需）+ 门头照 / 营业执照（合规）
  if (!form.shopAddress.trim()) { uni.showToast({ title: '请填写详细地址', icon: 'none' }); return; }
  if (!form.storeFrontPhoto) { uni.showToast({ title: '请上传门头照', icon: 'none' }); return; }
  if (!form.businessLicense) { uni.showToast({ title: '请上传营业执照', icon: 'none' }); return; }
  // 经纬度改为选填：只在商家确实填了（地图选点/手输）时才带上；否则由后端按地址自动换算
  const lng = Number(form.shopLongitude);
  const lat = Number(form.shopLatitude);
  const hasPos = isFinite(lng) && isFinite(lat) && form.shopLongitude !== '' && form.shopLatitude !== '';
  saving.value = true;
  try {
    const data = await post('/admin/certification/submit', Object.assign({
      shopAddress: form.shopAddress.trim(),
      storeFrontPhoto: form.storeFrontPhoto,
      businessLicense: form.businessLicense
    }, hasPos ? { shopLongitude: lng, shopLatitude: lat } : {}), { showError: false });

    // 后端返回的地理编码结果 → 正反馈
    const geoResult = (data && data.geoResult) || null;
    if (geoResult && geoResult.ok && geoResult.source === 'geocode') {
      geoState.value = 'ok';
      if (geoResult.longitude != null && geoResult.latitude != null) {
        form.shopLongitude = String(Number(geoResult.longitude).toFixed(6));
        form.shopLatitude = String(Number(geoResult.latitude).toFixed(6));
      }
      uni.showToast({ title: '认证通过 · 位置已自动识别', icon: 'success', duration: 1600 });
    } else if (geoResult && !geoResult.ok) {
      geoState.value = 'failed';
      uni.showToast({ title: '认证通过（位置未识别，不影响下单）', icon: 'success', duration: 1600 });
    } else {
      geoState.value = 'ok';
      uni.showToast({ title: '认证通过', icon: 'success' });
    }
    setTimeout(() => uni.navigateBack(), 900);
  } catch (e) {
    uni.showToast({ title: (e && e.message) || '提交失败', icon: 'none' });
  } finally {
    saving.value = false;
  }
}

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  loadStatus();
  loadSettings();
});
</script>

<style lang="scss" scoped>
.page { min-height: 100vh; background: $ink-50; padding-bottom: 220rpx; }
.hero { background: $brand-grad; color: #fff; padding: 50rpx 32rpx 60rpx; }
.hero-name { font-size: $fs-2xl; font-weight: $fw-bold; }
.hero-sub { font-size: $fs-sm; opacity: .9; margin-top: 10rpx; }

.card { background: $surface; margin: 20rpx; border-radius: $radius-lg; padding: 8rpx 24rpx; box-shadow: $shadow-sm; }
.card-title { font-size: $fs-base; color: $brand; font-weight: $fw-semibold; padding: 20rpx 0 8rpx; border-bottom: 1rpx solid $ink-100; display: flex; align-items: center; gap: 12rpx; }
.tag { font-size: 22rpx; padding: 4rpx 14rpx; border-radius: 999rpx; font-weight: $fw-medium; }
.tag-block { background: #fee2e2; color: #b91c1c; }
.tag-skip  { background: #fef3c7; color: #b45309; }
.tag-opt   { background: #e0f2fe; color: #0369a1; }

.status-row { display: flex; align-items: center; justify-content: space-between; padding: 18rpx 0; border-bottom: 1rpx solid $ink-50; gap: 20rpx; }
.status-row:last-child { border-bottom: 0; }
.status-label { font-size: $fs-md; color: $ink-700; }
.status-value { font-size: $fs-md; }
.status-value.ok { color: #16a34a; font-weight: $fw-semibold; }
.status-value.warn { color: #dc2626; }
.status-value.muted { color: #b45309; font-size: $fs-sm; }

.row { display: flex; align-items: center; justify-content: space-between; padding: 22rpx 0; border-bottom: 1rpx solid $ink-50; gap: 20rpx; }
.row:last-child { border-bottom: 0; }
.label { font-size: $fs-md; color: $ink-900; min-width: 130rpx; }
.input { flex: 1; text-align: right; font-size: $fs-md; color: $ink-900; max-width: 460rpx; }

.hint { font-size: $fs-sm; color: $ink-400; padding: 8rpx 0 16rpx; }
.hint.warn { color: #d97706; }

/* 门店定位自动识别状态（正反馈 / 待补全提示）*/
.geo-state { display: flex; align-items: center; gap: 10rpx; font-size: $fs-sm; padding: 10rpx 0 2rpx; }
.geo-state.ok { color: #16a34a; font-weight: $fw-semibold; }
.geo-state.warn { color: #b45309; }
.geo-ico { font-weight: $fw-bold; }

/* 选点按钮（uni.chooseLocation）*/
.locate-row { padding: 12rpx 0 4rpx; }
.locate-btn {
  display: flex; align-items: center; gap: 16rpx;
  padding: 24rpx 28rpx; border-radius: $radius-md;
  background: $brand-50; border: 2rpx solid $brand; color: $brand;
  font-size: $fs-md; font-weight: $fw-semibold;
}
.locate-btn:active { opacity: .8; }
.locate-ico { font-size: 36rpx; }
.locate-text { flex: 1; }
.locate-pos { display: flex; flex-direction: column; gap: 6rpx; margin-top: 16rpx; padding: 16rpx 20rpx; background: $ink-50; border-radius: $radius-sm; }
.locate-pos-label { font-size: $fs-sm; color: $ink-400; }
.locate-pos-value { font-size: $fs-md; color: $ink-900; font-family: ui-monospace, monospace; }

.upload-row { padding: 24rpx 0; }
.upload-empty { width: 100%; height: 280rpx; border: 2rpx dashed $ink-200; border-radius: $radius-md; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12rpx; }
.upload-ico { font-size: 60rpx; }
.upload-text { font-size: $fs-md; color: $ink-400; }
.upload-preview { display: flex; flex-direction: column; align-items: center; gap: 12rpx; }
.upload-img { width: 360rpx; height: 240rpx; border-radius: $radius-md; object-fit: cover; border: 1rpx solid $ink-100; }
.upload-tip { font-size: $fs-sm; color: $brand; }

.footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 20rpx 32rpx calc(20rpx + env(safe-area-inset-bottom)); background: $surface; box-shadow: $shadow; }
.save { background: $brand-grad; color: #fff; border-radius: $radius-full; font-size: $fs-lg; font-weight: $fw-semibold; height: 80rpx; line-height: 80rpx; box-shadow: $shadow-brand; }
button::after { border: none; }

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .card { background: #1e1e1e; box-shadow: none; }
  .row, .status-row { border-color: #2a2a2a; }
  .card-title { border-color: #2a2a2a; }
  .label { color: #e6e6e6; }
  .input { color: #e6e6e6; }
  .upload-empty { border-color: #2a2a2a; }
  .footer { background: #1e1e1e; }
}
</style>