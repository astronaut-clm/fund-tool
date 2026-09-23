// 云备份：backups 集合按 _openid 隔离，每用户一条记录
// action: upload / pull / info

const cloud = require('wx-server-sdk');
cloud.init({ env: 'cloud1-d8gg1i5ut09faeb83' });

const COLLECTION = 'backups';

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
  for (let i = 0; i < input.length; i++) {
    const c = String(input[i] || '').trim();
    if (!c || seen[c]) continue;
    seen[c] = true;
    if (out.length < 200) out.push(c);
  }
  return out;
}

function normalizeHoldings(input) {
  if (!Array.isArray(input)) return [];
  const seen = {};
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const it = input[i] || {};
    const code = String(it.code || '').trim();
    if (!code || seen[code]) continue;
    const amount = Number(it.amount);
    const profit = Number(it.profit);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    seen[code] = true;
    out.push({
      code: code,
      name: String(it.name || code),
      amount: amount,
      profit: Number.isFinite(profit) ? profit : 0
    });
    if (out.length >= 200) break;
  }
  return out;
}

function parseTs(r) {
  if (!r) return 0;
  if (r.updatedAt) return +new Date(r.updatedAt);
  if (r.createdAt) return +new Date(r.createdAt);
  return 0;
}

exports.main = async (event, context) => {
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
      const payload = { codes: codes, holdings: holdings };

      const found = await col.where({ _openid: openid }).limit(1).get();
      if (found.data && found.data.length) {
        await col.doc(found.data[0]._id).update({
          data: Object.assign({}, payload, {
            updatedAt: now,
            codeCount: codes.length,
            holdingCount: holdings.length
          })
        });
      } else {
        await col.add({
          data: Object.assign({}, payload, {
            _openid: openid,
            createdAt: now,
            updatedAt: now,
            codeCount: codes.length,
            holdingCount: holdings.length
          })
        });
      }
      return ok({
        codeCount: codes.length,
        holdingCount: holdings.length,
        updatedAt: Date.now()
      });
    }

    if (action === 'pull' || action === 'info') {
      const found = await col.where({ _openid: openid }).limit(1).get();
      if (!found.data || !found.data.length) return ok(null);
      const r = found.data[0];
      const meta = {
        updatedAt: parseTs(r),
        codeCount: r.codeCount,
        holdingCount: r.holdingCount
      };
      if (action === 'pull') {
        return ok(Object.assign(meta, {
          codes: r.codes || [],
          holdings: r.holdings || []
        }));
      }
      return ok(meta);
    }

    return fail('未知 action: ' + action);
  } catch (e) {
    return fail((e && e.message) || '备份服务异常');
  }
};
