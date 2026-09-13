const NotificationLog = require('../models/NotificationLog');

// 统一通知服务：把原先的 console.log 占位替换为真实 HTTP 调用，并落库发送日志。
// 渠道地址/密钥未配置时记 skipped，不影响主流程。

// POST JSON（带超时），返回 { ok, error, response }
async function postJson(url, body, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${String(text).slice(0, 200)}` };
    return { ok: true, response: String(text).slice(0, 500) };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? '请求超时' : (e && e.message) || '请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

// 写日志（失败不影响主流程）
async function writeLog(entry) {
  try {
    await NotificationLog.create(entry);
  } catch (e) {
    console.error('通知日志写入失败', e.message);
  }
}

// 通用 Webhook 推送（如供应商 webhookUrl）：返回是否成功
async function pushWebhook(url, event, payload, meta = {}) {
  if (!url) return false;
  const body = Object.assign({ event, time: new Date().toISOString() }, payload || {});
  const r = await postJson(url, body);
  await writeLog({
    shopId: meta.shopId || '',
    channel: 'webhook',
    event,
    target: url,
    title: meta.title || 'Webhook 通知',
    content: meta.content || '',
    status: r.ok ? 'success' : 'failed',
    error: r.error || '',
    payload: body
  });
  return r.ok;
}

// 新订单通知：按店铺设置分发到已配置的渠道，返回已触发的渠道清单（兼容旧 notifyTriggered）
async function notifyOrderCreated({ shopId, setting, order }) {
  const triggered = [];
  const content = `桌号 ${order.tableNumber} · 金额 ¥${Number(order.totalPrice).toFixed(2)} · ${(order.items || []).length} 项`;
  const payload = {
    event: 'order_created',
    shopId,
    orderId: String(order._id),
    tableNumber: order.tableNumber,
    totalPrice: order.totalPrice,
    items: order.items,
    createdAt: order.createdAt
  };

  // 本地渠道（后厨语音 / 大屏）由各端自行监听，无需外部调用
  if (setting.enableVoice) triggered.push('voice');
  if (setting.enableBigscreen) triggered.push('bigscreen');

  // 云打印：需启用 + 配置服务地址
  if (setting.enablePrinter) {
    triggered.push('printer');
    if (!setting.printerApiUrl) {
      await writeLog({ shopId, channel: 'printer', event: 'order_created', title: '打印小票', content, status: 'skipped', error: '未配置云打印服务地址' });
    } else {
      const r = await postJson(setting.printerApiUrl, Object.assign({ sn: setting.printerSN, key: setting.printerKey }, payload));
      await writeLog({ shopId, channel: 'printer', event: 'order_created', target: setting.printerApiUrl, title: '打印小票', content, status: r.ok ? 'success' : 'failed', error: r.error || '', payload });
    }
  }

  // 通用 Webhook（配置即启用）
  if (setting.notifyWebhookUrl) {
    triggered.push('webhook');
    await pushWebhook(setting.notifyWebhookUrl, 'order_created', payload, { shopId, title: '新订单通知', content });
  }

  // 短信
  if (setting.notifyPhone && setting.smsApiUrl) {
    triggered.push('sms');
    const r = await postJson(setting.smsApiUrl, { apiKey: setting.smsApiKey, phone: setting.notifyPhone, content });
    await writeLog({ shopId, channel: 'sms', event: 'order_created', target: setting.notifyPhone, title: '短信通知', content, status: r.ok ? 'success' : 'failed', error: r.error || '' });
  }

  // 语音电话
  if (setting.notifyPhone && setting.voiceApiUrl) {
    triggered.push('voice_call');
    const r = await postJson(setting.voiceApiUrl, { apiKey: setting.voiceApiKey, phone: setting.notifyPhone, content });
    await writeLog({ shopId, channel: 'voice', event: 'order_created', target: setting.notifyPhone, title: '语音电话通知', content, status: r.ok ? 'success' : 'failed', error: r.error || '' });
  }

  // 微信通知：需启用 + 配置微信通知服务地址；POST 公众号模板消息 / 企业微信机器人 JSON
  if (setting.enableWechat) {
    triggered.push('wechat');
    if (!setting.wechatApiUrl) {
      await writeLog({
        shopId, channel: 'wechat', event: 'order_created', title: '微信通知', content,
        status: 'skipped', error: '未配置微信通知服务地址'
      });
    } else {
      const wechatPayload = {
        apiKey: setting.wechatApiKey || '',
        touser: setting.wechatToUser || '',
        template_id: setting.wechatTemplateId || '',
        event: 'order_created',
        shopId,
        orderId: payload.orderId,
        tableNumber: order.tableNumber,
        totalPrice: order.totalPrice,
        items: order.items,
        createdAt: order.createdAt,
        content
      };
      const r = await postJson(setting.wechatApiUrl, wechatPayload);
      await writeLog({
        shopId, channel: 'wechat', event: 'order_created', target: setting.wechatApiUrl,
        title: '微信通知', content, status: r.ok ? 'success' : 'failed', error: r.error || '', payload: wechatPayload
      });
    }
  }

  return triggered;
}

module.exports = { postJson, writeLog, pushWebhook, notifyOrderCreated };
