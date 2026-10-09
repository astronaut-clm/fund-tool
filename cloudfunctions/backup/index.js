const cloud = require('wx-server-sdk');
cloud.init({ env: 'cloud1-d8gg1i5ut09faeb83' });

/** 云备份：backups 集合按 _openid 隔离，每用户一条 */
const COLLECTION = 'backups';
const MAX_ITEMS = 200;

function ok(data) {
  return { ok: true, data: data };
}

function fail(msg) {
  return { ok: false, msg: msg };
}

function normalizeCodes(input) {
  if (!Array.isArray(input)) return [];
  const seen = {};
  const out = [];
  for (let i = 0; i < input.length && out.length < MAX_ITEMS; i++) {
    const c = String(input[i] || '').trim();
    if (c && !seen[c]) {
      seen[c] = true;
      out.push(c);
    }
  }
  return out;
}

function normalizeHoldings(input) {
  if (!Array.isArray(input)) return [];
  const seen = {};
  const out = [];
  for (let i = 0; i < input.length && out.length < MAX_ITEMS; i++) {
    const it = input[i] || {};
    const code = String(it.code || '').trim();
    const amount = Number(it.amount);
    if (!code || seen[code] || !Number.isFinite(amount) || amount <= 0) continue;
    const profit = Number(it.profit);
    seen[code] = true;
    out.push({
      code: code,
      name: String(it.name || code),
      amount: amount,
      profit: Number.isFinite(profit) ? profit : 0
    });
  }
  return out;
}

function parseTs(r) {
  return r ? +new Date(r.updatedAt || r.createdAt || 0) : 0;
}

exports.main = async (event) => {
  const action = event.action || '';
  const wxCtx = cloud.getWXContext();
  if (!wxCtx || !wxCtx.OPENID) return fail('未获取到用户身份');
  const openid = wxCtx.OPENID;

  const db = cloud.database();
  try {
    await db.createCollection(COLLECTION);
  } catch (e) {}

  const col = db.collection(COLLECTION);

  try {
    if (action === 'upload') {
      const codes = normalizeCodes(event.codes);
      const holdings = normalizeHoldings(event.holdings);
      const now = db.serverDate();
      const extra = { updatedAt: now, codeCount: codes.length, holdingCount: holdings.length };

      const found = await col.where({ _openid: openid }).limit(1).get();
      if (found.data && found.data.length) {
        await col.doc(found.data[0]._id).update({ data: Object.assign({ codes, holdings }, extra) });
      } else {
        await col.add({ data: Object.assign({ codes, holdings, _openid: openid, createdAt: now }, extra) });
      }
      return ok({ codeCount: codes.length, holdingCount: holdings.length, updatedAt: Date.now() });
    }

    if (action === 'pull' || action === 'info') {
      const found = await col.where({ _openid: openid }).limit(1).get();
      if (!found.data || !found.data.length) return ok(null);
      const r = found.data[0];
      const meta = { updatedAt: parseTs(r), codeCount: r.codeCount, holdingCount: r.holdingCount };
      if (action === 'pull') {
        return ok(Object.assign(meta, { codes: r.codes || [], holdings: r.holdings || [] }));
      }
      return ok(meta);
    }

    return fail('未知 action: ' + action);
  } catch (e) {
    return fail((e && e.message) || '备份服务异常');
  }
};
