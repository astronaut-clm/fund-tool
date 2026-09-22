/** 估值：coverage=Σw_i，estPct=Σ(w_i·r_i)/S，r_i 为重仓股实时涨跌幅(%) */
const em = require('./em');
const cache = require('./cache');

const TTL = {
  info: 24 * 60 * 60 * 1000,
  holdings: 6 * 60 * 60 * 1000,
  quote: 10 * 1000,
  daychg: 30 * 60 * 1000,
  daychgTrade: 2 * 60 * 60 * 1000,   // 交易时段 09:30–15:00
  daychgWait: 3 * 60 * 1000,         // 15:00–19:00 等待净值公布
  daychgHot: 5 * 60 * 1000,          // 19:00–24:00 余热期
  daychgNight: 30 * 60 * 1000,       // 00:00–09:30 隔夜
  trend: 60 * 1000,
  industry: 24 * 60 * 60 * 1000,
  bench: 24 * 60 * 60 * 1000
};

/** 北京时间 Date（云函数运行在 UTC，需偏移 +8 小时） */
function bjDate() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

function todayStr() {
  const d = bjDate();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return d.getUTCFullYear() + '-' + m + '-' + day;
}

/** 日涨幅缓存 TTL：按北京时间交易时段自适应，净值公布窗口最频繁 */
function daychgTTL() {
  const h = bjDate().getUTCHours();
  if (h >= 15 && h < 19) return TTL.daychgWait;
  if (h >= 19 && h < 24) return TTL.daychgHot;
  if (h >= 0 && h < 9) return TTL.daychgNight;
  return TTL.daychgTrade;
}

const MIN_COVERAGE = 30;
const TREND_WINDOW = { start: '09:30', end: '15:00' };

const INDEX_FUND_RE = /指数|ETF|被动|联接|LOF|增强/;
const BOND_FUND_RE = /债|纯债|信用|利率/;

function isIndexFund(ftype) {
  return INDEX_FUND_RE.test(String(ftype || ''));
}
function isBondFund(ftype) {
  return BOND_FUND_RE.test(String(ftype || ''));
}

function round(n, p) {
  const f = Math.pow(10, p === undefined ? 4 : p);
  return Math.round(Number(n) * f) / f;
}

/** 前十大持仓加权估算 */
function calcByStocks(stocks, quotes) {
  const list = stocks.map(function (s) {
    const q = quotes[s.secid] || quotes[s.code] || {};
    const pct = Number.isFinite(q.pct) ? q.pct : 0;
    const weight = Number(s.weight) || 0;
    return {
      code: s.code,
      secid: s.secid,
      name: s.name,
      weight: weight,
      pct: pct,
      contrib: weight * pct,
      price: Number.isFinite(q.price) ? q.price : null,
      weightDelta: s.weightDelta === undefined ? null : s.weightDelta,
      isNew: !!s.isNew
    };
  });

  let sumWR = 0;
  let coverage = 0;
  for (let i = 0; i < list.length; i++) {
    sumWR += list[i].contrib;
    coverage += list[i].weight;
  }
  if (coverage <= 0) return null;

  const estPct = sumWR / coverage;
  return {
    coverage: round(coverage * 100, 2),
    estPct: round(estPct, 3),
    stocks: list
  };
}

async function fetchInfo(code) {
  return cache.wrap('info:' + code, TTL.info, function () {
    return em.getFundInfo(code);
  });
}

async function fetchBenchmarkIndex(code) {
  return cache.wrap('bench:' + code, TTL.bench, function () {
    return em.getBenchmarkIndex(code);
  });
}

async function fetchHoldings(code) {
  return cache.wrap('hold:' + code, TTL.holdings, function () {
    return em.getHoldings(code);
  });
}

async function fetchTrend(secidOrTx) {
  return cache.wrap('trend:' + secidOrTx, TTL.trend, function () {
    // secid 含点（"1.600519"）走个股分时；txCode 不含点（sh000300）走指数分时
    if (String(secidOrTx).indexOf('.') > 0) {
      return em.getTrend(secidOrTx);
    }
    return em.getIndexTrend(secidOrTx);
  });
}

/** 上一交易日涨跌 + 当日单位净值；已命中当日净值则放宽缓存避免余热期无效刷 */
async function fetchLastDayChange(code) {
  const key = 'daychg:' + code;
  const today = todayStr();
  const existing = cache.get(key, TTL.daychg);
  if (existing && String(existing.date || '').slice(0, 10) === today) {
    return existing;
  }
  return cache.wrap(key, daychgTTL(), function () {
    return em.getLastDayChange(code);
  });
}

/** 单只基金估算：指数型优先用跟踪指数涨跌幅（coverage=100），否则前十大持仓加权 */
async function estimateOne(code, info, quotes, withStocks, holdings, bench) {
  const base = {
    code: code,
    name: info ? info.name : code,
    source: 'none',
    navDate: '',
    prevNav: 0,
    ftype: info ? info.ftype : '',
    size: info ? info.size : 0,
    coverage: null,
    estPct: null,
    holdingsPeriod: '',
    lastDayPct: null,
    lastDayDate: '',
    lastNav: null,
    dataDate: '',
    msg: ''
  };

  const last = await fetchLastDayChange(code);
  if (last) {
    base.lastDayPct = last.pct;
    base.lastDayDate = last.date;
    base.lastNav = last.nav;
    if (last.nav) {
      base.prevNav = last.nav;
      base.navDate = last.date || base.navDate;
    }
  }

  if (isBondFund(base.ftype)) {
    base.msg = '债券型基金不支持实时估算';
    return base;
  }

  const isIndex = isIndexFund(base.ftype);

  // 指数型：优先用跟踪指数涨跌幅（基准仓位约 95%，幅度可偏大约 5%）
  // txCode 为空代表是 CSI* 中证主题指数等腾讯无行情的标的，降级走持仓加权
  if (isIndex && bench && bench.txCode) {
    const q = quotes && quotes[bench.txCode];
    if (q && Number.isFinite(q.pct)) {
      base.source = 'index';
      base.coverage = 100;
      base.estPct = round(q.pct, 3);
      base.dataDate = q.date || '';
      base.bench = { name: bench.name, symbol: bench.symbol, desc: bench.desc || '' };
      return base;
    }
  }

  if (!holdings) holdings = await fetchHoldings(code);
  if (holdings && holdings.stocks) {
    let quoteDate = '';
    holdings.stocks.forEach(function (s) {
      const q = quotes && (quotes[s.secid] || quotes[s.code]);
      if (q && q.date && q.date > quoteDate) quoteDate = q.date;
    });
    if (quoteDate) base.dataDate = quoteDate;
  }

  const nav = base.prevNav;
  // 指数/ETF/联接基金前十覆盖度天然偏低，放宽阈值不卡 30%
  const looseCoverage = isIndex;

  if (holdings && holdings.stocks && holdings.stocks.length) {
    base.holdingsPeriod = holdings.period;
    // 至少一只重仓股行情有效才自建，避免用全 0 行情算出假 0.00%
    const hasQuote = holdings.stocks.some(function (s) {
      const q = quotes && (quotes[s.secid] || quotes[s.code]);
      return !!q && Number.isFinite(Number(q.pct));
    });
    if (nav > 0 && hasQuote) {
      const r = calcByStocks(holdings.stocks, quotes);
      if (r && (looseCoverage || r.coverage >= MIN_COVERAGE)) {
        base.source = 'self';
        base.coverage = r.coverage;
        base.estPct = r.estPct;
        if (withStocks) base.stocks = r.stocks;
        if (looseCoverage && r.coverage < MIN_COVERAGE) {
          base.msg = '指数基金估算仅供参考';
        }
        return base;
      }
      base.msg = looseCoverage ? '' : (r ? '可用持仓不足，暂无法估算' : '持仓权重解析失败');
    } else {
      base.msg = nav > 0 ? '暂未取到重仓股行情' : '净值基准缺失';
    }
  } else {
    base.msg = '未取到季报持仓（新基金或尚未披露）';
  }

  base.msg = base.msg || '暂无估值数据';
  return base;
}

/** 批量估算（限 20 只） */
async function estimateFunds(codes, withStocks) {
  const list = (codes || []).filter(Boolean).slice(0, 20);
  if (!list.length) return [];

  // 1. 基本信息（并发，缓存 24h）
  const infos = {};
  await Promise.all(
    list.map(async function (code) {
      const info = await fetchInfo(code);
      if (info) infos[code] = info;
    })
  );

  // 2. 季报持仓（并发，缓存 6h）
  const holdingsMap = {};
  await Promise.all(
    list.map(async function (code) {
      const h = await fetchHoldings(code);
      if (h) holdingsMap[code] = h;
    })
  );

  // 3. 跟踪指数：仅指数型基金（蛋卷 API，缓存 24h）
  const benchMap = {};
  await Promise.all(
    list.map(async function (code) {
      const info = infos[code];
      if (!info || !isIndexFund(info.ftype)) return;
      const b = await fetchBenchmarkIndex(code);
      if (b) benchMap[code] = b;
    })
  );

  // 4. 行情：重仓股（按 secid）+ 指数（按 txCode），二级缓存避免组合 key 碎片化
  const secidSet = {};
  Object.keys(holdingsMap).forEach(function (code) {
    holdingsMap[code].stocks.forEach(function (s) {
      if (s.secid) secidSet[s.secid] = true;
    });
  });
  const secids = Object.keys(secidSet);
  const txOnlyCodes = [];
  Object.keys(benchMap).forEach(function (code) {
    const tx = benchMap[code].txCode;
    if (tx && txOnlyCodes.indexOf(tx) < 0) txOnlyCodes.push(tx);
  });
  let quotes = {};

  if (secids.length) {
    const cached = {};
    const miss = [];
    secids.forEach(function (secid) {
      const v = cache.get('q:' + secid, TTL.quote);
      if (v !== undefined) cached[secid] = v;
      else miss.push(secid);
    });
    if (miss.length) {
      const fresh = await em.getQuotes(miss);
      if (fresh) {
        Object.keys(fresh).forEach(function (k) {
          if (k.indexOf('.') > 0) cache.set('q:' + k, fresh[k]);
        });
      }
      quotes = Object.assign({}, cached, fresh || {});
    } else {
      quotes = cached;
    }
  }

  if (txOnlyCodes.length) {
    const txCached = {};
    const txMiss = [];
    txOnlyCodes.forEach(function (tx) {
      const v = cache.get('q:' + tx, TTL.quote);
      if (v !== undefined) txCached[tx] = v;
      else txMiss.push(tx);
    });
    if (txMiss.length) {
      const txFresh = await em.getIndexQuotes(txMiss);
      Object.keys(txFresh).forEach(function (k) {
        cache.set('q:' + k, txFresh[k]);
      });
      Object.assign(quotes, txCached, txFresh);
    } else {
      Object.assign(quotes, txCached);
    }
  }

  // 5. 逐只计算
  const results = await Promise.all(
    list.map(function (code) {
      return estimateOne(code, infos[code], quotes, withStocks, holdingsMap[code], benchMap[code]).catch(function (e) {
        console.error('estimateOne failed', code, (e && e.stack) || e);
        return {
          code: code,
          name: (infos[code] && infos[code].name) || code,
          source: 'none',
          estPct: null,
          msg: '估值失败'
        };
      });
    })
  );

  if (withStocks) await attachIndustries(results);
  return results;
}

/** 给持仓明细附加行业（push2 批量，按 code 缓存 24h；失败留空） */
async function attachIndustries(results) {
  const map = {};
  const need = [];
  results.forEach(function (r) {
    (r.stocks || []).forEach(function (s) {
      if (map[s.code] !== undefined) return;
      const v = cache.get('ind:' + s.code, TTL.industry);
      if (v !== undefined) {
        map[s.code] = v;
        return;
      }
      if (need.indexOf(s.code) < 0) need.push(s.code);
    });
  });
  if (need.length) {
    const fresh = await em.getIndustries(need);
    Object.keys(fresh).forEach(function (c) {
      map[c] = fresh[c];
      if (fresh[c]) cache.set('ind:' + c, fresh[c]);
    });
  }
  results.forEach(function (r) {
    (r.stocks || []).forEach(function (s) {
      s.industry = map[s.code] || '';
    });
  });
}

/**
 * 当日估算净值走势（分钟级）
 * 指数型有跟踪指数：直接用指数分时；否则重仓股分时加权合成
 */
async function estimateTrend(code) {
  const info = await fetchInfo(code);
  if (isBondFund(info && info.ftype)) return null;

  const last = await fetchLastDayChange(code);
  const prevNav = (last && last.nav) || 0;
  if (!prevNav) return null;

  const isIndex = isIndexFund(info && info.ftype);

  // 指数型：直接用跟踪指数分时
  if (isIndex) {
    const bench = await fetchBenchmarkIndex(code);
    if (bench && bench.txCode) {
      const t = await fetchTrend(bench.txCode);
      if (t && t.points && t.points.length > 1) {
        const points = t.points.map(function (p) {
          return { t: p.t, pct: round(p.pct, 3), nav: round(prevNav * (1 + p.pct / 100), 4) };
        });
        // 优先用指数介绍（腾讯 introduce），无则用基金投资目标（蛋卷 invest_orientation）
        const benchDesc = t.introduce || bench.desc || '';
        return { prevNav: prevNav, points: points, date: t.date, benchDesc: benchDesc };
      }
    }
  }

  const holdings = await fetchHoldings(code);
  if (!holdings || !holdings.stocks || !holdings.stocks.length) return null;

  const looseCoverage = isIndex;

  const trends = {};
  let trendDate = '';
  await Promise.all(
    holdings.stocks.map(async function (s) {
      const t = await fetchTrend(s.secid);
      if (t) {
        trends[s.secid] = t;
        if (t.date > trendDate) trendDate = t.date;
      }
    })
  );

  const valid = holdings.stocks.filter(function (s) {
    return !!trends[s.secid];
  });
  const coverage = valid.reduce(function (a, s) {
    return a + s.weight;
  }, 0);
  if (!looseCoverage && coverage * 100 < MIN_COVERAGE) return null;

  // 按分钟聚合：不同市场时段不同，该时点有效覆盖度骤降时归一化会放大波动
  const acc = {};
  valid.forEach(function (s) {
    trends[s.secid].points.forEach(function (p) {
      const a = acc[p.t] || (acc[p.t] = [0, 0]);
      a[0] += s.weight * p.pct;
      a[1] += s.weight;
    });
  });

  // 只保留 A 股交易时段，去掉午休（11:30-13:00）
  const timeline = Object.keys(acc)
    .sort()
    .filter(function (t) {
      if (t < TREND_WINDOW.start || t > TREND_WINDOW.end) return false;
      return t <= '11:30' || t >= '13:00';
    })
    .map(function (t) {
      const a = acc[t];
      return { t: t, cov: a[1], pct: a[1] > 0 ? a[0] / a[1] : 0 };
    });

  // 覆盖度 < 整体 70% 的时点不可信：中间以前值平延，尾部截断
  const minCov = coverage * 0.7;
  let lastReliable = -1;
  timeline.forEach(function (p, i) {
    if (p.cov >= minCov) lastReliable = i;
  });
  if (lastReliable < 1) return null;

  const points = [];
  let carry = null;
  for (let i = 0; i <= lastReliable; i++) {
    const p = timeline[i];
    if (p.cov >= minCov) carry = p.pct;
    if (carry === null) continue;
    points.push({ t: p.t, pct: round(carry, 3), nav: round(prevNav * (1 + carry / 100), 4) });
  }
  if (points.length < 2) return null;

  return { prevNav: prevNav, points: points, date: trendDate };
}

module.exports = { estimateFunds: estimateFunds, estimateTrend: estimateTrend };
