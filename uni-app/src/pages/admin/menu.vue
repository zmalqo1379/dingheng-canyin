<template>
  <view class="page" :class="themeClass">
    <view class="topbar">
      <view class="filter">
        <view
          v-for="c in cateTabs"
          :key="c"
          class="ftab"
          :class="{ on: c === activeCate }"
          @tap="activeCate = c"
        >{{ c }}</view>
      </view>
      <view class="tbtns">
        <view class="add ghost" @tap="openAIImport">📷 拍照上传</view>
        <view class="add" @tap="openAdd">+ 新增</view>
      </view>
    </view>

    <scroll-view scroll-y class="list">
      <view v-for="d in filtered" :key="d._id" class="dish">
        <image v-if="d.image" class="img" :src="d.image" mode="aspectFill" lazy-load />
        <view v-else class="img placeholder">{{ (d.name || '菜').slice(0,1) }}</view>
        <view class="info">
          <view class="row1">
            <text class="name">{{ d.name }}</text>
            <text class="cat">{{ d.category }}</text>
          </view>
          <view class="desc">{{ d.description || '—' }}</view>
          <view class="row2">
            <text class="price">¥{{ d.price }}</text>
            <text class="avail" :class="{ off: d.isAvailable === false }">
              {{ d.isAvailable === false ? '已下架' : '在售' }}
            </text>
          </view>
        </view>
        <view class="ops">
          <text class="op edit" @tap="openEdit(d)">编辑</text>
          <text class="op del" @tap="remove(d)">删除</text>
        </view>
      </view>
      <view v-if="!filtered.length" class="empty">暂无菜品，点击右上角新增</view>
      <view style="height: 40rpx"></view>
    </scroll-view>

    <!-- 新增/编辑弹层 -->
    <view class="mask" v-if="formShow" @tap="formShow = false"></view>
    <view class="sheet" v-if="formShow">
      <view class="sheet-title">{{ editing ? '编辑菜品' : '新增菜品' }}</view>
      <view class="field">
        <text class="fl">名称</text>
        <input class="fi" v-model="form.name" placeholder="菜品名称" />
      </view>
      <view class="field">
        <text class="fl">价格</text>
        <input class="fi" type="digit" v-model="form.price" placeholder="价格(元)" />
      </view>
      <view class="field">
        <text class="fl">分类</text>
        <input class="fi" v-model="form.category" placeholder="如：热菜" />
      </view>
      <view class="field">
        <text class="fl">图片URL</text>
        <input class="fi" v-model="form.image" placeholder="可留空" />
      </view>
      <view class="field">
        <text class="fl">描述</text>
        <input class="fi" v-model="form.description" placeholder="菜品描述" />
      </view>
      <view class="field switch">
        <text class="fl">在售</text>
        <switch :checked="form.isAvailable" color="#FF6B35" @change="e => form.isAvailable = e.detail.value" />
      </view>
      <view class="sheet-btns">
        <button class="cbtn cancel" @tap="formShow = false">取消</button>
        <button class="cbtn ok" :loading="submitting" @tap="submit">保存</button>
      </view>
    </view>

    <!-- 拍照上传菜单：纸质菜单拍一张（或把菜单文字粘进来）→ 识别成清单 → 改改删删 → 一键整批新增 -->
    <view class="mask" v-if="aiShow" @tap="aiShow = false"></view>
    <view class="sheet ai-sheet" v-if="aiShow">
      <view class="sheet-title">📷 拍照上传菜单</view>

      <scroll-view scroll-y class="ai-body">
        <!-- 第一步：给素材（拍照 / 相册 / 粘贴文字） -->
        <view v-if="aiStep === 'input'">
          <view class="ai-drop" @tap="aiPick">
            <view class="ai-big">📷</view>
            <view class="ai-t1">点这里拍照，或选一张菜单的照片</view>
            <view class="ai-t2">纸质的、手写的、电子菜单截图都认得<br />镜头正对着拍、别太远，认得更准</view>
          </view>
          <image v-if="aiPreview" class="ai-prev" :src="aiPreview" mode="widthFix" />
          <view class="ai-or">或者</view>
          <view class="ai-label">把菜单的文字直接粘进来（微信里收到的最省事）</view>
          <textarea class="ai-ta" v-model="aiText" placeholder="例如：&#10;宫保鸡丁 38元&#10;鱼香肉丝 32元" />
        </view>

        <!-- 识别中 -->
        <view v-if="aiStep === 'loading'" class="ai-loading">
          <view class="ai-spin"></view>
          <view class="ai-loading-t">正在识别，请稍等几秒…</view>
        </view>

        <!-- 第二步：核对清单（每一行都能改） -->
        <view v-if="aiStep === 'list'">
          <view class="ai-sum">
            认出 <text class="b">{{ aiItems.length }}</text> 道菜<text v-if="aiLowCount">，其中 <text class="b warn">{{ aiLowCount }}</text> 道没太大把握（黄底那几行），麻烦核一眼</text>。不要的把勾去掉或点 ✕，<text class="b">价格缺的补上</text>就能一键新增。
          </view>

          <view v-for="(it, i) in aiItems" :key="i" class="ai-row" :class="{ low: it.confidence === 'low' }">
            <view class="ai-row-hd">
              <view class="ai-chk" :class="{ on: aiOn[i] !== false }" @tap="aiToggle(i)">{{ aiOn[i] !== false ? '✓' : '' }}</view>
              <input class="ai-in" v-model="it.name" placeholder="菜名" />
              <text v-if="it.confidence === 'low'" class="ai-tag">请核对</text>
              <text class="ai-x" @tap="aiDel(i)">✕</text>
            </view>
            <view class="ai-row-ft">
              <picker :range="aiCatList" :value="aiCatIndex(it.category)" @change="aiPickCate(i, $event)">
                <view class="ai-pick">{{ it.category || '选分类' }} ▾</view>
              </picker>
              <input class="ai-in price" type="digit" v-model="it.price" placeholder="价格（必填）" />
            </view>
          </view>
          <view v-if="!aiItems.length" class="ai-empty">没认出来菜品 —— 点「重新识别」再来一次，或者点下面「再加一行」自己填</view>

          <view class="ai-add" @tap="aiAddRow">＋ 再加一行</view>
          <view v-if="aiResult" class="ai-result" :class="{ warn: aiHasFailed }">{{ aiResult }}</view>
        </view>
      </scroll-view>

      <view class="sheet-btns">
        <button v-if="aiStep === 'list'" class="cbtn cancel" @tap="aiStep = 'input'">重新识别</button>
        <button class="cbtn cancel" @tap="aiShow = false">取消</button>
        <button class="cbtn ok" :loading="aiBusy" @tap="aiGo">{{ aiGoText }}</button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import { get, post, put, del, getToken } from '@/utils/request.js';
// 界面主题：根 view 上挂 class（整套 CSS 变量在 src/styles/theme-vars.css）
import { useThemeClass } from '@/utils/theme.js';

const themeClass = useThemeClass();


const dishes = ref([]);
const categories = ref([]);
const activeCate = ref('全部');
const cateTabs = computed(() => ['全部', ...categories.value]);

const filtered = computed(() =>
  activeCate.value === '全部' ? dishes.value : dishes.value.filter((d) => d.category === activeCate.value)
);

const formShow = ref(false);
const editing = ref(false);
const submitting = ref(false);
const form = ref({
  _id: '',
  name: '',
  price: '',
  category: '',
  image: '',
  description: '',
  isAvailable: true
});

async function load() {
  try {
    const [list, cats] = await Promise.all([get('/dishes'), get('/categories')]);
    dishes.value = Array.isArray(list) ? list : [];
    categories.value = (Array.isArray(cats) ? cats : []).map((c) => c.name).filter(Boolean);
  } catch (e) {}
}

function openAdd() {
  editing.value = false;
  form.value = { _id: '', name: '', price: '', category: categories.value[0] || '', image: '', description: '', isAvailable: true };
  formShow.value = true;
}
function openEdit(d) {
  editing.value = true;
  form.value = { _id: d._id, name: d.name, price: String(d.price), category: d.category, image: d.image || '', description: d.description || '', isAvailable: d.isAvailable !== false };
  formShow.value = true;
}

async function submit() {
  if (!form.value.name || form.value.price === '') {
    uni.showToast({ title: '请填写名称和价格', icon: 'none' });
    return;
  }
  submitting.value = true;
  const body = {
    name: form.value.name,
    price: Number(form.value.price),
    category: form.value.category,
    image: form.value.image,
    description: form.value.description,
    isAvailable: form.value.isAvailable
  };
  try {
    if (editing.value) {
      await put('/admin/dishes/' + form.value._id, body);
    } else {
      await post('/admin/dishes', body);
    }
    uni.showToast({ title: '保存成功', icon: 'success' });
    formShow.value = false;
    await load();
  } catch (e) {} finally {
    submitting.value = false;
  }
}

function remove(d) {
  uni.showModal({
    title: '删除确认',
    content: `确定删除「${d.name}」吗？`,
    confirmColor: '#FF6B35',
    success: async (r) => {
      if (!r.confirm) return;
      try {
        await del('/admin/dishes/' + d._id);
        uni.showToast({ title: '已删除', icon: 'success' });
        await load();
      } catch (e) {}
    }
  });
}

/* ---------- 拍照上传菜单 ----------
   一份纸质菜单几十道菜，一道一道手填太慢。拍照（或把菜单文字粘进来）→ 识别成清单 →
   这儿改、那儿删、还能手动加 → 一键整批新增。
   立场：识别出来的每一行都能改，绝不做"认出来是什么就是什么"的黑盒。 */
const AI_DEFAULT_CATS = ['热菜', '凉菜', '主食', '汤羹', '饮品', '小吃', '其他'];
const aiShow = ref(false);
const aiStep = ref('input');   // input / loading / list
const aiImage = ref('');       // 交给后端的 base64 dataUrl（选完图自动生成）
const aiPreview = ref('');     // 页面上显示的本地临时路径
const aiText = ref('');
const aiItems = ref([]);
const aiOn = ref({});
const aiResult = ref('');
const aiHasFailed = ref(false);
const aiRecognizing = ref(false);
const aiSubmitting = ref(false);

const aiCatList = computed(() => {
  const base = categories.value.length ? categories.value.slice() : AI_DEFAULT_CATS.slice();
  const extra = aiItems.value.map((it) => it.category).filter((c) => c && base.indexOf(c) === -1);
  return base.concat(extra);
});
const aiLowCount = computed(() => aiItems.value.filter((x) => x.confidence === 'low').length);
const aiCheckedCount = computed(
  () => aiItems.value.filter((it, i) => aiOn.value[i] !== false && String(it.name || '').trim()).length
);
const aiBusy = computed(() => aiRecognizing.value || aiSubmitting.value);
const aiGoText = computed(() => {
  if (aiStep.value === 'loading') return '识别中…';
  if (aiStep.value === 'list') return aiCheckedCount.value ? `一键新增这 ${aiCheckedCount.value} 道` : '一键新增';
  return '开始识别';
});

function aiCatIndex(cat) {
  const i = aiCatList.value.indexOf(cat);
  return i >= 0 ? i : 0;
}
function aiPickCate(i, e) {
  aiItems.value[i].category = aiCatList.value[Number(e.detail.value)] || aiItems.value[i].category;
}
function aiToggle(i) {
  aiOn.value = Object.assign({}, aiOn.value, { [i]: aiOn.value[i] === false });
}
function aiDel(i) {
  aiItems.value.splice(i, 1);
  aiOn.value = {};
}
function aiAddRow() {
  aiItems.value.push({ name: '', price: '', category: categories.value[0] || AI_DEFAULT_CATS[0], confidence: 'low' });
  aiOn.value = {};
}

async function openAIImport() {
  aiShow.value = true;
  aiStep.value = 'input';
  aiImage.value = ''; aiPreview.value = ''; aiText.value = '';
  aiItems.value = []; aiOn.value = {}; aiResult.value = ''; aiHasFailed.value = false;
  try {
    const st = await get('/ai/status');
    if (st && st.enabled === false) {
      aiShow.value = false;
      uni.showToast({ title: '拍照识别还没开通，请联系平台开通', icon: 'none' });
    }
  } catch (e) { /* 状态拉不到也先进去，识别时会给明确提示 */ }
}

// 照片转 base64：小程序用文件系统直读；读不出来就明确失败，绝不静默传一张空图
function fileToBase64(filePath) {
  return new Promise((resolve) => {
    try {
      const fs = typeof uni.getFileSystemManager === 'function' ? uni.getFileSystemManager() : null;
      if (!fs) { resolve(''); return; }
      fs.readFile({ filePath, encoding: 'base64', success: (r) => resolve(r.data || ''), fail: () => resolve('') });
    } catch (e) {
      resolve('');
    }
  });
}

function aiPick() {
  const onFile = (p) => {
    aiPreview.value = p;
    fileToBase64(p).then((b64) => {
      if (!b64) { uni.showToast({ title: '这张图读不出来，换一张试试', icon: 'none' }); return; }
      aiImage.value = 'data:image/jpeg;base64,' + b64;
      aiRecognize();   // 选完就自动识别，省一次点击
    });
  };
  if (typeof uni.chooseMedia === 'function') {
    uni.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'],
      success: (r) => { const f = r.tempFiles && r.tempFiles[0]; if (f) onFile(f.tempFilePath); }
    });
  } else {
    uni.chooseImage({
      count: 1, sizeType: ['compressed'], sourceType: ['camera', 'album'],
      success: (r) => { const p = r.tempFilePaths && r.tempFilePaths[0]; if (p) onFile(p); }
    });
  }
}

async function aiRecognize() {
  const txt = String(aiText.value || '').trim();
  if (!aiImage.value && !txt) { uni.showToast({ title: '先拍张照，或者把菜单文字粘进来', icon: 'none' }); return; }
  aiRecognizing.value = true;
  aiStep.value = 'loading';
  try {
    // 识别要等大模型，超时放宽到 90 秒（普通接口是 15 秒）
    const res = await post('/ai/parse-dishes', { image: aiImage.value || null, text: txt || null }, { timeout: 90000 });
    const items = (res && res.items) || [];
    aiItems.value = items;
    aiOn.value = {};
    aiResult.value = ''; aiHasFailed.value = false;
    aiStep.value = 'list';
    if (!items.length) uni.showToast({ title: '没认出菜品来，镜头拉近拍清楚点再试', icon: 'none' });
  } catch (e) {
    aiStep.value = 'input';
  } finally {
    aiRecognizing.value = false;
  }
}

async function aiSubmit() {
  const items = [];
  aiItems.value.forEach((it, i) => {
    if (aiOn.value[i] === false) return;
    const name = String(it.name || '').trim();
    if (!name) return;
    items.push({
      name,
      category: it.category || '其他',
      price: (it.price === '' || it.price == null) ? null : Number(it.price),
      description: it.description || ''
    });
  });
  if (!items.length) { uni.showToast({ title: '还没勾选要新增的菜品', icon: 'none' }); return; }
  aiSubmitting.value = true;
  try {
    const d = await post('/admin/dishes/batch', { items }, { timeout: 60000 }) || {};
    // 成功的移出清单，没成的留在上面继续改 —— 不让他重拍一次
    const okNames = (d.created || []).map((x) => String(x.name || '').replace(/\s/g, '').toLowerCase());
    aiItems.value = aiItems.value.filter((it, i) => {
      if (aiOn.value[i] === false) return true;
      return okNames.indexOf(String(it.name || '').replace(/\s/g, '').toLowerCase()) === -1;
    });
    aiOn.value = {};
    const failed = d.failed || [], skipped = d.skipped || [];
    aiHasFailed.value = failed.length > 0;
    let t = `已新增 ${d.count || 0} 道菜`;
    if (skipped.length) t += `，${skipped.length} 道重名的已跳过`;
    if (failed.length) t += `；还有 ${failed.length} 道没加上（多半没填价格），已留在上面，补上价再点一次就行`;
    aiResult.value = t;
    await load();   // 列表立刻刷新，新菜直接看得见
    if (!aiItems.value.length) aiResult.value += ' —— 全部完成';
  } catch (e) {
  } finally {
    aiSubmitting.value = false;
  }
}

function aiGo() {
  if (aiStep.value === 'list') aiSubmit();
  else if (aiStep.value !== 'loading') aiRecognize();
}

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  load();
});
onPullDownRefresh(() => load().finally(() => uni.stopPullDownRefresh()));
</script>

<style lang="scss" scoped>
.page { min-height: 100vh; background: $ink-50; display: flex; flex-direction: column; }

.topbar {
  display: flex; align-items: center; justify-content: space-between;
  background: $surface; padding: 16rpx 20rpx; border-bottom: 1rpx solid $ink-100;
  position: sticky; top: 0; z-index: 5;
}
.filter { display: flex; flex: 1; overflow-x: auto; white-space: nowrap; }
.ftab {
  padding: 10rpx 24rpx; font-size: $fs-base; color: $ink-500; border-radius: $radius-full; margin-right: 12rpx;
  background: $ink-50; flex-shrink: 0;
}
.ftab.on { background: $brand-grad; color: #fff; }
.add { background: $brand-grad; color: #fff; font-size: $fs-base; padding: 12rpx 24rpx; border-radius: $radius-full; flex-shrink: 0; box-shadow: $shadow-brand; }

.list { flex: 1; padding: 20rpx; }
.dish {
  display: flex; background: $surface; border-radius: $radius-lg; padding: 20rpx; margin-bottom: 18rpx;
  box-shadow: $shadow-sm; align-items: center;
}
.img { width: 120rpx; height: 120rpx; border-radius: $radius; flex-shrink: 0; background: $ink-100; }
.img.placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #ffd2bf, #ffb59a); color: #fff; font-size: 40rpx; font-weight: $fw-bold; }
.info { flex: 1; margin-left: 20rpx; }
.row1 { display: flex; align-items: center; gap: 12rpx; }
.name { font-size: $fs-lg; font-weight: $fw-semibold; color: $ink-900; }
.cat { font-size: $fs-xs; color: $brand; background: $brand-100; padding: 2rpx 12rpx; border-radius: $radius-full; }
.desc { font-size: $fs-sm; color: $ink-400; margin: 8rpx 0; }
.row2 { display: flex; align-items: center; justify-content: space-between; }
.price { color: $brand; font-size: $fs-xl; font-weight: $fw-bold; }
.avail { font-size: $fs-sm; color: $success; }
.avail.off { color: $ink-300; }
.ops { display: flex; flex-direction: column; gap: 16rpx; align-items: flex-end; }
.op { font-size: $fs-sm; padding: 6rpx 16rpx; border-radius: $radius-sm; }
.op.edit { color: $brand; background: $brand-100; }
.op.del { color: $danger; background: $danger-bg; }
.empty { text-align: center; color: $ink-300; padding: 80rpx 0; }

.mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 10; }
.sheet {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 11; background: $surface;
  border-radius: $radius-lg $radius-lg 0 0; padding: 24rpx 32rpx calc(24rpx + env(safe-area-inset-bottom));
  max-height: 80vh;
}
.sheet-title { font-size: $fs-xl; font-weight: $fw-bold; text-align: center; margin-bottom: 20rpx; color: $ink-900; }
.field { display: flex; align-items: center; padding: 18rpx 0; border-bottom: 1rpx solid $ink-50; }
.field.switch { justify-content: space-between; }
.fl { width: 160rpx; font-size: $fs-md; color: $ink-700; flex-shrink: 0; }
.fi { flex: 1; font-size: $fs-md; text-align: right; color: $ink-900; }
.sheet-btns { display: flex; gap: 20rpx; margin-top: 30rpx; }
.cbtn { flex: 1; height: 80rpx; line-height: 80rpx; border-radius: $radius-full; font-size: $fs-lg; }
.cbtn.cancel { background: $ink-50; color: $ink-500; }
.cbtn.ok { background: $brand-grad; color: #fff; box-shadow: $shadow-brand; }
button::after { border: none; }

/* 拍照上传菜单 */
.tbtns { display: flex; gap: 12rpx; flex-shrink: 0; }
.add.ghost { background: $surface; color: $brand; border: 2rpx solid $brand; box-shadow: none; }
.ai-sheet { max-height: 88vh; display: flex; flex-direction: column; }
.ai-body { max-height: 60vh; }
.ai-drop { border: 2rpx dashed $ink-200; border-radius: $radius-lg; background: $ink-50; padding: 32rpx 24rpx; text-align: center; }
.ai-big { font-size: 64rpx; line-height: 1; }
.ai-t1 { margin-top: 12rpx; font-size: $fs-md; font-weight: $fw-semibold; color: $ink-900; }
.ai-t2 { margin-top: 8rpx; font-size: $fs-xs; color: $ink-400; line-height: 1.6; }
.ai-prev { width: 100%; margin-top: 16rpx; border-radius: $radius; }
.ai-or { text-align: center; font-size: $fs-xs; color: $ink-300; margin: 24rpx 0 12rpx; }
.ai-label { font-size: $fs-sm; color: $ink-500; margin-bottom: 12rpx; }
.ai-ta { width: 100%; box-sizing: border-box; min-height: 160rpx; padding: 16rpx; font-size: $fs-md; color: $ink-900; background: $ink-50; border-radius: $radius; }
.ai-loading { padding: 60rpx 0; text-align: center; }
.ai-spin { display: inline-block; width: 48rpx; height: 48rpx; border-radius: 50%; border: 6rpx solid $ink-100; border-top-color: $brand; animation: ai-spin .8s linear infinite; }
@keyframes ai-spin { to { transform: rotate(360deg); } }
.ai-loading-t { margin-top: 16rpx; font-size: $fs-sm; color: $ink-500; }
.ai-sum { padding: 16rpx; font-size: $fs-sm; line-height: 1.7; color: $ink-500; background: $ink-50; border-radius: $radius; }
.ai-sum .b { color: $ink-900; font-weight: $fw-semibold; }
.ai-sum .b.warn { color: #92400e; }
.ai-row { margin-top: 16rpx; padding: 16rpx; border-radius: $radius; background: $ink-50; }
.ai-row.low { background: #fffbeb; }
.ai-row-hd { display: flex; align-items: center; gap: 12rpx; }
.ai-chk { flex-shrink: 0; width: 40rpx; height: 40rpx; line-height: 36rpx; text-align: center; font-size: $fs-xs; color: #fff; background: $surface; border: 2rpx solid $ink-200; border-radius: 8rpx; }
.ai-chk.on { background: $brand-grad; border-color: $brand; }
.ai-in { flex: 1; font-size: $fs-md; color: $ink-900; }
.ai-in.price { flex: none; width: 220rpx; text-align: right; }
.ai-tag { flex-shrink: 0; padding: 2rpx 10rpx; font-size: $fs-xs; color: #92400e; background: #fef3c7; border-radius: $radius-sm; }
.ai-x { flex-shrink: 0; padding: 0 8rpx; font-size: $fs-lg; color: $ink-300; }
.ai-row-ft { display: flex; align-items: center; gap: 16rpx; margin-top: 12rpx; }
.ai-pick { padding: 8rpx 20rpx; font-size: $fs-sm; color: $brand; background: $brand-100; border-radius: $radius-full; }
.ai-empty { padding: 30rpx 0; text-align: center; font-size: $fs-sm; color: $ink-300; }
.ai-add { margin-top: 20rpx; padding: 16rpx; text-align: center; font-size: $fs-sm; color: $brand; background: $brand-100; border-radius: $radius; }
.ai-result { margin-top: 20rpx; padding: 16rpx; font-size: $fs-sm; line-height: 1.7; color: $success; background: $success-bg; border-radius: $radius; }
.ai-result.warn { color: #92400e; background: #fffbeb; }

/* ★ 手写深色块已删（职责交给 .theme-dark），见 src/utils/theme.js */
</style>
