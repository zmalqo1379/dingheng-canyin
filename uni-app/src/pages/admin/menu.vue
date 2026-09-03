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
import { get, post, put, del } from '@/utils/request.js';

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

onLoad(() => load());
onPullDownRefresh(() => load().finally(() => uni.stopPullDownRefresh()));
</script>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #f5f5f5; display: flex; flex-direction: column; }

.topbar {
  display: flex; align-items: center; justify-content: space-between;
  background: #fff; padding: 16rpx 20rpx; border-bottom: 1rpx solid #eee;
  position: sticky; top: 0; z-index: 5;
}
.filter { display: flex; flex: 1; overflow-x: auto; white-space: nowrap; }
.ftab {
  padding: 10rpx 24rpx; font-size: 26rpx; color: #666; border-radius: 30rpx; margin-right: 12rpx;
  background: #f5f5f5; flex-shrink: 0;
}
.ftab.on { background: #ff6b35; color: #fff; }
.add { background: #ff6b35; color: #fff; font-size: 26rpx; padding: 12rpx 24rpx; border-radius: 30rpx; flex-shrink: 0; }

.list { flex: 1; padding: 20rpx; }
.dish {
  display: flex; background: #fff; border-radius: 16rpx; padding: 20rpx; margin-bottom: 18rpx;
  box-shadow: 0 2rpx 12rpx rgba(0,0,0,.04); align-items: center;
}
.img { width: 120rpx; height: 120rpx; border-radius: 12rpx; flex-shrink: 0; background: #f0f0f0; }
.img.placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#ffd2bf,#ffb59a); color: #fff; font-size: 40rpx; font-weight: 700; }
.info { flex: 1; margin-left: 20rpx; }
.row1 { display: flex; align-items: center; gap: 12rpx; }
.name { font-size: 30rpx; font-weight: 600; color: #222; }
.cat { font-size: 20rpx; color: #ff6b35; background: rgba(255,107,53,.12); padding: 2rpx 12rpx; border-radius: 20rpx; }
.desc { font-size: 24rpx; color: #999; margin: 8rpx 0; }
.row2 { display: flex; align-items: center; justify-content: space-between; }
.price { color: #ff6b35; font-size: 32rpx; font-weight: 700; }
.avail { font-size: 22rpx; color: #4caf50; }
.avail.off { color: #bbb; }
.ops { display: flex; flex-direction: column; gap: 16rpx; align-items: flex-end; }
.op { font-size: 24rpx; padding: 6rpx 16rpx; border-radius: 8rpx; }
.op.edit { color: #ff6b35; background: rgba(255,107,53,.1); }
.op.del { color: #f44336; background: rgba(244,67,54,.1); }
.empty { text-align: center; color: #bbb; padding: 80rpx 0; }

.mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 10; }
.sheet {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 11; background: #fff;
  border-radius: 24rpx 24rpx 0 0; padding: 24rpx 32rpx calc(24rpx + env(safe-area-inset-bottom));
  max-height: 80vh;
}
.sheet-title { font-size: 32rpx; font-weight: 700; text-align: center; margin-bottom: 20rpx; }
.field { display: flex; align-items: center; padding: 18rpx 0; border-bottom: 1rpx solid #f5f5f5; }
.field.switch { justify-content: space-between; }
.fl { width: 160rpx; font-size: 28rpx; color: #333; flex-shrink: 0; }
.fi { flex: 1; font-size: 28rpx; text-align: right; }
.sheet-btns { display: flex; gap: 20rpx; margin-top: 30rpx; }
.cbtn { flex: 1; height: 80rpx; line-height: 80rpx; border-radius: 40rpx; font-size: 30rpx; }
.cbtn.cancel { background: #f5f5f5; color: #666; }
.cbtn.ok { background: #ff6b35; color: #fff; }
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
