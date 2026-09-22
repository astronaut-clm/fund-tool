/** 进程内极简缓存（云函数实例存活期间有效） */
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
  if (store.size > 1000) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }
  return v;
}

/** 带缓存执行 + 单飞去重：未命中执行 producer，期间同 key 并发共享同一 Promise */
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
