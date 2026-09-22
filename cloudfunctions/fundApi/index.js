const em = require('./em');
const estimate = require('./estimate');

// 基金代码白名单：6 位纯数字
const RE_FUND_CODE = /^\d{6}$/;

function ok(data) {
  return { ok: true, data: data };
}

function fail(msg) {
  return { ok: false, msg: msg };
}

/** 规范化 codes：过滤非法、去重、限 20 */
function normalizeCodes(input) {
  if (!Array.isArray(input)) return [];
  const seen = {};
  const out = [];
  for (let i = 0; i < input.length && out.length < 20; i++) {
    const c = String(input[i] || '').trim();
    if (RE_FUND_CODE.test(c) && !seen[c]) {
      seen[c] = true;
      out.push(c);
    }
  }
  return out;
}

exports.main = async (event) => {
  const action = event.action || '';
  const start = Date.now();
  try {
    if (action === 'search') {
      const key = String(event.key || '').trim();
      if (!key) return ok([]);
      const list = await em.searchFund(key);
      console.log('[fundApi] search', JSON.stringify(key), 'cost', Date.now() - start, 'ms');
      return ok(list);
    }

    if (action === 'estimate') {
      const codes = normalizeCodes(event.codes);
      if (!codes.length) return ok([]);
      const withStocks = !!event.withStocks;
      const list = await estimate.estimateFunds(codes, withStocks);
      console.log('[fundApi] estimate', codes.length, 'withStocks=' + withStocks, 'cost', Date.now() - start, 'ms');
      return ok(list);
    }

    if (action === 'trend') {
      const code = String(event.code || '').trim();
      if (!RE_FUND_CODE.test(code)) return ok(null);
      const t = await estimate.estimateTrend(code);
      console.log('[fundApi] trend', code, 'cost', Date.now() - start, 'ms');
      return ok(t);
    }

    return fail('未知 action: ' + action);
  } catch (e) {
    console.error('[fundApi] error', action, (e && e.stack) || e, 'cost', Date.now() - start, 'ms');
    return fail((e && e.message) || '服务端异常');
  }
};
