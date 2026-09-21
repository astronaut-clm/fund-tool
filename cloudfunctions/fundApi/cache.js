/**
 * 进程内极简缓存（云函数实例存活期间有效）
 * 分层 TTL：
 *   持仓 holdings 6h    —— 季报快照，不可能实时，没必要频繁抓
 *   基金信息 info 24h   —— 名称/类型几乎不变
 *   行情 quote 10s      —— 唯一真正实时的数据
 *   官方估值 official 30s
 */
const store = new Map();

function get(key, ttl) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.t > ttl) {
    store.delete(key);
    return undefined;
  }
  return hit.v;
}

function set(key, v) {
  store.set(key, { v: v, t: Date.now() });
  // 上限保护，避免长时间运行实例内存膨胀
  if (store.size > 1000) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }
  return v;
}

/** 带缓存地执行 */
async function wrap(key, ttl, producer) {
  const cached = get(key, ttl);
  if (cached !== undefined) return cached;
  try {
    const v = await producer();
    if (v !== null && v !== undefined) set(key, v);
    return v;
  } catch (e) {
    return undefined;
  }
}

module.exports = { get: get, set: set, wrap: wrap };
