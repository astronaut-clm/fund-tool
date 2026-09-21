/**
 * 估值：归一化到前十大持仓
 *   coverage = Σ w_i
 *   estPct   = Σ(w_i · r_i) / S        r_i 为重仓股实时涨跌幅(%)
 *   estNav   = prevNav · (1 + estPct/100)
 */
const em = require('./em');
const cache = require('./cache');

const TTL = {
  info: 24 * 60 * 60 * 1000,
  holdings: 6 * 60 * 60 * 1000,
  quote: 10 * 1000,
  official: 30 * 1000,
  daychg: 2 * 60 * 60 * 1000,
  trend: 60 * 1000
};

/** 前十大持仓合计占比比低于此值（%）时，认为不足以代表基金，降级到官方估值 */
const MIN_COVERAGE = 30;

/** 分时只取该时间窗内的分钟点（A股交易时段 9:30-15:00） */
const TREND_WINDOW = { start: '09:30', end: '15:00' };

function round(n, p) {
  const f = Math.pow(10, p === undefined ? 4 : p);
  return Math.round(Number(n) * f) / f;
}

/** 核心计算 */
function calcByStocks(prevNav, stocks, quotes) {
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
      contrib: weight * pct
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
    estNav: round(prevNav * (1 + estPct / 100), 4),
    stocks: list
  };
}

async function fetchInfo(code) {
  return cache.wrap('info:' + code, TTL.info, function () {
    return em.getFundInfo(code);
  });
}

async function fetchHoldings(code) {
  return cache.wrap('hold:' + code, TTL.holdings, function () {
    return em.getHoldings(code);
  });
}

async function fetchTrend(secid) {
  return cache.wrap('trend:' + secid, TTL.trend, function () {
    return em.getTrend(secid);
  });
}

async function fetchOfficial(code) {
  return cache.wrap('official:' + code, TTL.official, function () {
    return em.getOfficialEstimate(code);
  });
}

async function fetchLastDayChange(code) {
  return cache.wrap('daychg:' + code, TTL.daychg, function () {
    return em.getLastDayChange(code);
  });
}

/** 单只基金估算：优先前十大持仓自建，失败降级官方 gsz */
async function estimateOne(code, info, quotes, withStocks) {
  const base = {
    code: code,
    name: info ? info.name : code,
    source: 'none',
    navDate: info ? info.navDate : '',
    prevNav: info && info.prevNav ? info.prevNav : 0,
    ftype: info ? info.ftype : '',
    size: info ? info.size : 0,
    coverage: null,
    estPct: null,
    estNav: null,
    holdingsPeriod: '',
    lastDayPct: null,
    lastDayDate: '',
    msg: ''
  };

  // 并发拉取官方估值、持仓、上一交易日涨跌（列表页不取涨跌，省一次请求）
  const [official, holdings, last] = await Promise.all([
    fetchOfficial(code),
    fetchHoldings(code),
    withStocks ? fetchLastDayChange(code) : Promise.resolve(null)
  ]);

  if (official && !base.prevNav) {
    base.prevNav = official.prevNav;
    base.navDate = official.time ? official.time.slice(0, 10) : base.navDate;
  }

  if (last) {
    base.lastDayPct = last.pct;
    base.lastDayDate = last.date;
  }

  const nav = base.prevNav;

  // 指数型 / ETF / 联接基金：官方估值（gsz）直接跟踪指数，比前十大持仓自建更准
  const isIndex = /指数|ETF|被动|联接|LOF/.test(String(base.ftype || ''));
  if (isIndex && official && official.estNav) {
    base.source = 'official';
    base.estPct = official.estPct;
    base.estNav = official.estNav;
    if (holdings) base.holdingsPeriod = holdings.period;
    if (withStocks && holdings && holdings.stocks) base.stocks = holdings.stocks;
    return base;
  }

  // 主动型：前十大持仓 + 实时股价推算
  if (holdings && holdings.stocks && holdings.stocks.length) {
    base.holdingsPeriod = holdings.period;
    // 至少一只重仓股行情有效才自建，否则降级，避免用全 0 行情算出假 0.00%
    const hasQuote = holdings.stocks.some(function (s) {
      const q = quotes && (quotes[s.secid] || quotes[s.code]);
      return !!q && Number.isFinite(Number(q.pct));
    });
    if (nav > 0 && hasQuote) {
      const r = calcByStocks(nav, holdings.stocks, quotes);
      if (r && r.coverage >= MIN_COVERAGE) {
        base.source = 'self';
        base.coverage = r.coverage;
        base.estPct = r.estPct;
        base.estNav = r.estNav;
        if (withStocks) base.stocks = r.stocks;
        return base;
      }
      base.msg = r ? '可用持仓不足，暂无法估算' : '持仓权重解析失败';
    } else {
      base.msg = nav > 0 ? '暂未取到重仓股行情' : '净值基准缺失';
    }
  } else {
    base.msg = '未取到季报持仓（新基金或尚未披露）';
  }

  // 自建失败：官方估值兜底
  if (official && official.estNav) {
    base.source = 'official';
    base.estPct = official.estPct;
    base.estNav = official.estNav;
    return base;
  }

  // 最后兜底：挂上上一净值，避免页面只剩"--"
  if (nav > 0) {
    base.estNav = nav;
    if (!base.msg) base.msg = '暂无今日估值';
    return base;
  }

  base.msg = base.msg || '暂无估值数据';
  return base;
}

/**
 * 批量估算
 * @param {string[]} codes
 * @param {boolean} withStocks 是否携带前十大持仓明细
 */
async function estimateFunds(codes, withStocks) {
  const list = (codes || []).filter(Boolean).slice(0, 20);
  if (!list.length) return [];

  // 1. 基本信息（并发）
  const infos = {};
  await Promise.all(
    list.map(async function (code) {
      const info = await fetchInfo(code);
      if (info) infos[code] = info;
    })
  );

  // 2. 取季报持仓（并发，缓存 6h）
  const holdingsMap = {};
  await Promise.all(
    list.map(async function (code) {
      const h = await fetchHoldings(code);
      if (h) holdingsMap[code] = h;
    })
  );

  // 3. 重仓股去重合并，一次拉全部行情（缓存 10s）
  const secidSet = {};
  Object.keys(holdingsMap).forEach(function (code) {
    holdingsMap[code].stocks.forEach(function (s) {
      if (s.secid) secidSet[s.secid] = true;
    });
  });
  const secids = Object.keys(secidSet);
  let quotes = {};
  if (secids.length) {
    quotes = await cache.wrap('quotes:' + secids.sort().join(','), TTL.quote, function () {
      return em.getQuotes(secids);
    });
    if (!quotes) quotes = {};
  }

  // 4. 逐只计算
  return Promise.all(
    list.map(function (code) {
      return estimateOne(code, infos[code], quotes, withStocks).catch(function (e) {
        console.error('estimateOne failed', code, (e && e.stack) || e);
        return {
          code: code,
          name: (infos[code] && infos[code].name) || code,
          source: 'none',
          estPct: null,
          estNav: null,
          msg: '估值失败'
        };
      });
    })
  );
}

/**
 * 当日估算净值走势（分钟级）：重仓股分时涨跌按权重加权合成
 * @returns {{prevNav:number, points:[{t:'HH:mm', pct:number, nav:number}]}|null}
 */
async function estimateTrend(code) {
  const info = await fetchInfo(code);
  const holdings = await fetchHoldings(code);
  if (!holdings || !holdings.stocks || !holdings.stocks.length) return null;

  // 净值基准：基金信息接口偶发失败时，用官方估值接口里的上一净值兜底
  let prevNav = (info && info.prevNav) || 0;
  if (!prevNav) {
    const off = await fetchOfficial(code);
    if (off) prevNav = off.prevNav || 0;
  }
  if (!prevNav) return null;

  // 并发取各重仓股分时（缓存 60s）
  const trends = {};
  await Promise.all(
    holdings.stocks.map(async function (s) {
      const t = await fetchTrend(s.secid);
      if (t) trends[s.secid] = t;
    })
  );

  const valid = holdings.stocks.filter(function (s) {
    return !!trends[s.secid];
  });
  const coverage = valid.reduce(function (a, s) {
    return a + s.weight;
  }, 0);
  if (coverage * 100 < MIN_COVERAGE) return null;

  // 按分钟聚合：缺失市场（如港股/A股时段不同）只按该时点有效的股票重新归一化
  const acc = {};
  valid.forEach(function (s) {
    trends[s.secid].points.forEach(function (p) {
      const a = acc[p.t] || (acc[p.t] = [0, 0]);
      a[0] += s.weight * p.pct;
      a[1] += s.weight;
    });
  });

  // 关键点：不同市场交易时段不同（A股 11:30-13:00 休市、港股 16:00 收盘）。
  // 若某分钟有效覆盖度骤降，归一化会把剩余市场的波动放大，导致曲线尾部失真。
  // 策略：该时点有效覆盖度 ≥ 整体覆盖度×70% 才算可信；中间不可信点以前值平延，尾部不可信则截断。
  const timeline = Object.keys(acc)
    .sort()
    .filter(function (t) {
      // 只保留 A股交易时段，并去掉午休（11:30-13:00）
      if (t < TREND_WINDOW.start || t > TREND_WINDOW.end) return false;
      return t <= '11:30' || t >= '13:00';
    })
    .map(function (t) {
      const a = acc[t];
      return { t: t, cov: a[1], pct: a[1] > 0 ? a[0] / a[1] : 0 };
    });

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
    if (carry === null) continue; // 开头尚未出现可信点
    points.push({ t: p.t, pct: round(carry, 3), nav: round(prevNav * (1 + carry / 100), 4) });
  }
  if (points.length < 2) return null;

  return { prevNav: prevNav, points: points };
}

module.exports = { estimateFunds: estimateFunds, estimateTrend: estimateTrend, calcByStocks: calcByStocks };
