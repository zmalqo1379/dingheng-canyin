<template>
  <view class="page">
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
      <view class="add" @tap="openAdd">+ 新增</view>
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
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import { get, post, put, del, getToken } from '@/utils/request.js';

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

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .topbar { background: #1e1e1e; border-color: #2a2a2a; }
  .ftab { background: #2a2a2a; color: #aaa; }
  .dish { background: #1e1e1e; box-shadow: none; }
  .name { color: #e6e6e6; }
  .sheet { background: #1e1e1e; }
  .fl { color: #e6e6e6; }
  .field { border-color: #2a2a2a; }
  .cbtn.cancel { background: #2a2a2a; color: #ccc; }
}
</style>
