/**
 * 进程内极简缓存（云函数实例存活期间有效）
 * 分层 TTL：
 *   持仓 holdings 6h    —— 季报快照，不可能实时，没必要频繁抓
 *   基金信息 info 24h   —— 名称/类型几乎不变
 *   行情 quote 10s      —— 唯一真正实时的数据
 *   上一日涨跌 daychg    —— 自适应（见 estimate.js daychgTTL）：
 *                          交易时段 2h / 等待公布 3min / 余热 5min / 隔夜 30min
 *                          当日净值已到手则放宽到 30min，避免余热期无效刷
 */
const store = new Map();
// in-flight：同 key 并发请求共享同一个 Promise，避免缓存 miss 时打爆上游
const pending = new Map();

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

/**
 * 带缓存地执行 + 单飞去重
 * - 命中缓存直接返回（命中计 1 次）
 * - 未命中且无 in-flight → 执行 producer，期间同 key 的并发请求共享同一 Promise
 * - 已有 in-flight → 直接等待同一 Promise（不重复打上游）
 */
async function wrap(key, ttl, producer) {
  const cached = get(key, ttl);
  if (cached !== undefined) return cached;

  const inflight = pending.get(key);
  if (inflight) {
    return inflight;
  }

  const p = Promise.resolve()
    .then(producer)
    .then(function (v) {
      if (v !== null && v !== undefined) set(key, v);
      return v;
    })
    .catch(function (e) {
      // 异常不缓存，但要打日志便于排查（cache.wrap 原本静默吞异常）
      console.error('[cache.wrap] producer failed', key, (e && e.message) || e);
      return undefined;
    })
    .then(function (v) {
      pending.delete(key);
      return v;
    });

  pending.set(key, p);
  return p;
}

module.exports = { get: get, set: set, wrap: wrap };
