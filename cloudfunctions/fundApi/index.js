const em = require('./em');
const estimate = require('./estimate');


function ok(data) {
  return { ok: true, data: data };
}

function fail(msg) {
  return { ok: false, msg: msg };
}

exports.main = async (event) => {
  const action = event.action || '';
  try {
    if (action === 'search') {
      const key = String(event.key || '').trim();
      if (!key) return ok([]);
      const list = await em.searchFund(key);
      return ok(list);
    }

    if (action === 'estimate') {
      const codes = Array.isArray(event.codes) ? event.codes : [];
      if (!codes.length) return ok([]);
      const list = await estimate.estimateFunds(codes, event.withStocks);
      return ok(list);
    }

    if (action === 'trend') {
      const code = String(event.code || '').trim();
      if (!code) return ok(null);
      const t = await estimate.estimateTrend(code);
      return ok(t);
    }

    return fail('未知 action: ' + action);
  } catch (e) {
    return fail((e && e.message) || '服务端异常');
  }
};
