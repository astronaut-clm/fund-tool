/**
 * 估值：归一化到前十大持仓
 *   coverage = Σ w_i
 *   estPct   = Σ(w_i · r_i) / S        r_i 为重仓股实时涨跌幅(%)
 */
const em = require('./em');
const cache = require('./cache');

const TTL = {
  info: 24 * 60 * 60 * 1000,
  holdings: 6 * 60 * 60 * 1000,
  quote: 10 * 1000,
  // daychg 改为自适应：见 daychgTTL()，TTL.daychg 仅作"已命中今日"时的余热兜底
  daychg: 30 * 60 * 1000,
  daychgTrade: 2 * 60 * 60 * 1000,   // 交易时段 09:30–15:00：当日净值未公布，2h
  daychgWait: 3 * 60 * 1000,        // 15:00–19:00：等待净值公布，3min
  daychgHot: 5 * 60 * 1000,         // 19:00–24:00：余热期，5min
  daychgNight: 30 * 60 * 1000,      // 00:00–09:30：隔夜稳定，30min
  trend: 60 * 1000,
  industry: 24 * 60 * 60 * 1000,
  bench: 24 * 60 * 60 * 1000       // 跟踪标的几乎不变，与 info 同档 24h
};

/** 北京时间 Date（云函数运行在 UTC，需偏移 +8 小时再取小时/日期） */
function bjDate() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

/** 今日 YYYY-MM-DD（北京时间） */
function todayStr() {
  const d = bjDate();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return d.getUTCFullYear() + '-' + m + '-' + day;
}

/** 日涨幅/净值缓存 TTL：按北京时间交易时段自适应，净值公布窗口最频繁 */
function daychgTTL() {
  const h = bjDate().getUTCHours();
  if (h >= 15 && h < 19) return TTL.daychgWait;    // 等待净值公布
  if (h >= 19 && h < 24) return TTL.daychgHot;     // 余热期
  if (h >= 0 && h < 9) return TTL.daychgNight;     // 隔夜
  return TTL.daychgTrade;                          // 交易时段 / 其他
}

/** 前十大持仓合计占比比低于此值（%）时，认为不足以代表基金，降级到官方估值 */
const MIN_COVERAGE = 30;

/** 分时只取该时间窗内的分钟点（A股交易时段 9:30-15:00） */
const TREND_WINDOW = { start: '09:30', end: '15:00' };

function round(n, p) {
  const f = Math.pow(10, p === undefined ? 4 : p);
  return Math.round(Number(n) * f) / f;
}

/** 核心计算 */
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

/** 跟踪指数：仅指数型基金调用，缓存 24h */
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
    // secid 形如 "1.600519"（含点），走个股分时；
    // txCode 形如 "sh000300"/"hkHSTECH"（不含点），走指数分时
    if (String(secidOrTx).indexOf('.') > 0) {
      return em.getTrend(secidOrTx);
    }
    return em.getIndexTrend(secidOrTx);
  });
}

/** 上一交易日涨跌 + 当日单位净值（lsjz 接口）
 *  TTL 自适应：交易时段 2h / 等待净值公布 3min / 余热 5min / 隔夜 30min
 *  已命中当日净值则放宽到 30min，避免余热期无效刷
 */
async function fetchLastDayChange(code) {
  const key = 'daychg:' + code;
  const today = todayStr();
  const existing = cache.get(key, TTL.daychg);
  if (existing && String(existing.date || '').slice(0, 10) === today) {
    return existing; // 当日净值已到手，余热期不再频繁刷
  }
  return cache.wrap(key, daychgTTL(), function () {
    return em.getLastDayChange(code);
  });
}

/** 单只基金估算：前十大持仓自建（所有基金类型同一路径，不再使用第三方估值）
 *  指数型基金若拿到跟踪指数行情，优先采用指数涨跌幅（覆盖度 100%）
 */
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

  // 上一交易日涨跌 + 当日单位净值：DWJZ 更新更及时，用于绕开 info 的 24h 缓存
  // 列表页/详情页都需要，因为 prevNav 兜底现在只靠它（不再读 fundgz）
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

  // 债券型基金：持仓以债券为主，本工具基于股票持仓估算无意义，直接返回提示
  const isBond = /债|纯债|信用|利率/.test(String(base.ftype || ''));
  if (isBond) {
    base.msg = '债券型基金不支持实时估算';
    return base;
  }

  const ftypeStr = String(base.ftype || '');
  const isIndexFund = /指数|ETF|被动|联接|LOF|增强/.test(ftypeStr);

  // 指数型基金：优先用跟踪指数涨跌幅（基准仓位约 95%，幅度可偏大约 5%）
  // bench.txCode 为空代表是 QDII 跟踪标的或中证主题指数（CSI*），腾讯无行情，跳过走持仓加权
  if (isIndexFund && bench && bench.txCode) {
    const q = quotes && quotes[bench.txCode];
    if (q && Number.isFinite(q.pct)) {
      base.source = 'index';
      base.coverage = 100; // 跟踪指数天然 100% 覆盖
      base.estPct = round(q.pct, 3);
      base.dataDate = q.date || '';
      base.bench = { name: bench.name, symbol: bench.symbol };
      return base;
    }
    // 降级到下面持仓加权分支
  }
  // 数据所属日期：取重仓股实时行情日期（腾讯/新浪，最准确），用于前端判断是否为当天数据
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
  // 指数/ETF/联接基金：前十覆盖度天然偏低，放宽阈值，不卡 30%
  const looseCoverage = /指数|ETF|被动|联接|LOF|增强/.test(String(base.ftype || ''));

  // 前十大持仓 + 实时股价推算（所有基金类型同一路径）
  if (holdings && holdings.stocks && holdings.stocks.length) {
    base.holdingsPeriod = holdings.period;
    // 至少一只重仓股行情有效才自建，否则降级，避免用全 0 行情算出假 0.00%
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
        // 指数基金前十覆盖度过低（宽基指数常见），估算值偏差可能较大
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

  // 2.5 跟踪指数：仅对指数型基金拉取（蛋卷 API，缓存 24h）
  const benchMap = {};
  await Promise.all(
    list.map(async function (code) {
      const info = infos[code];
      if (!info) return;
      if (!/指数|ETF|被动|联接|LOF|增强/.test(String(info.ftype || ''))) return;
      const b = await fetchBenchmarkIndex(code);
      if (b) benchMap[code] = b;
    })
  );

  // 3. 重仓股去重合并，按 secid 粒度二级缓存行情（避免组合 key 碎片化）
  //    指数代码（如 sh000300）也一并并入批量行情请求（走 em.getIndexQuotes）
  const secidSet = {};
  Object.keys(holdingsMap).forEach(function (code) {
    holdingsMap[code].stocks.forEach(function (s) {
      if (s.secid) secidSet[s.secid] = true;
    });
  });
  const secids = Object.keys(secidSet);
  // 收集指数代码（腾讯代码，无 secid），用于走 getIndexQuotes
  const txOnlyCodes = [];
  Object.keys(benchMap).forEach(function (code) {
    const tx = benchMap[code].txCode;
    if (tx && txOnlyCodes.indexOf(tx) < 0) txOnlyCodes.push(tx);
  });
  let quotes = {};

  // 3a. 重仓股行情（按 secid）
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
          // 只对纯 secid 形态的 key 写回单条缓存（跳过纯 code 形态避免重复）
          if (k.indexOf('.') > 0) cache.set('q:' + k, fresh[k]);
        });
      }
      quotes = Object.assign({}, cached, fresh || {});
    } else {
      quotes = cached;
    }
  }

  // 3b. 指数行情（按 txCode，缓存 key 形如 q:sh000300）
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

  // 4. 逐只计算
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

/** 给持仓明细附加所属行业（push2 批量拉取，按 code 缓存 24h；失败则留空） */
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
 * 当日估算净值走势（分钟级）：
 *  - 指数型基金有跟踪指数：直接用指数分时（一条线，无需加权）
 *  - 其他：重仓股分时涨跌按权重加权合成
 * @returns {{prevNav:number, points:[{t:'HH:mm', pct:number, nav:number}]}|null}
 */
async function estimateTrend(code) {
  const info = await fetchInfo(code);
  // 债券型基金：持仓以债券为主，分时合成无意义，直接返回 null
  if (info && /债|纯债|信用|利率/.test(String(info.ftype || ''))) return null;

  // 净值基准：统一从 lsjz 取当日单位净值（不再依赖 info 的 24h 缓存）
  const last = await fetchLastDayChange(code);
  const prevNav = (last && last.nav) || 0;
  if (!prevNav) return null;

  const ftype = String((info && info.ftype) || '');
  const isIndex = /指数|ETF|被动|联接|LOF|增强/.test(ftype);

  // 指数型基金：直接用跟踪指数分时（比重仓股合成更准）
  if (isIndex) {
    const bench = await fetchBenchmarkIndex(code);
    if (bench && bench.txCode) {
      const t = await fetchTrend(bench.txCode); // 走 em.getIndexTrend，缓存 60s
      if (t && t.points && t.points.length > 1) {
        // 港股交易时段与 A 股不同（9:30-12:00/13:00-16:00），保留全量点位
        // 但基金净值估算只关心涨跌幅，无需截断时段
        const points = t.points.map(function (p) {
          return { t: p.t, pct: round(p.pct, 3), nav: round(prevNav * (1 + p.pct / 100), 4) };
        });
        return { prevNav: prevNav, points: points, date: t.date };
      }
    }
    // 跟踪指数行情缺失，降级走重仓股合成
  }

  const holdings = await fetchHoldings(code);
  if (!holdings || !holdings.stocks || !holdings.stocks.length) return null;

  const looseCoverage = isIndex;

  // 并发取各重仓股分时（缓存 60s）
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

  return { prevNav: prevNav, points: points, date: trendDate };
}

module.exports = { estimateFunds: estimateFunds, estimateTrend: estimateTrend, calcByStocks: calcByStocks };
