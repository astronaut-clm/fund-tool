/**
 * 数据源封装：天天基金（基金类数据）+ 腾讯/新浪（股票行情）
 * 均为公开免费接口，仅供个人学习研究使用
 */
const https = require('https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** GET 请求，自动跟随一次重定向；ms 可覆盖单请求超时（云函数整体 20s，务必留余量） */
function req(url, referer, redirect, ms) {
  return new Promise(function (resolve, reject) {
    const doReq = function (u) {
      try {
        https
          .get(
            u,
            {
              timeout: ms || 8000,
              headers: {
                'User-Agent': UA,
                Referer: referer || 'https://fund.eastmoney.com/',
                Accept: '*/*'
              }
            },
            function (res) {
              if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirect) return reject(new Error('too many redirects'));
                let next = res.headers.location;
                if (next.indexOf('http') !== 0) next = 'https:' + next;
                return doReq(next);
              }
              const chunks = [];
              res.on('data', function (c) {
                chunks.push(c);
              });
              res.on('end', function () {
                resolve(Buffer.concat(chunks).toString('utf8'));
              });
            }
          )
          .on('error', reject)
          .on('timeout', function () {
            this.destroy(new Error('request timeout'));
          });
      } catch (e) {
        reject(e);
      }
    };
    doReq(url);
  });
}

/** 剥离 JSONP 外壳 */
function stripJsonp(text) {
  const t = String(text || '').trim();
  const s = t.indexOf('(');
  const e = t.lastIndexOf(')');
  if (s > 0 && e > s) {
    try {
      return JSON.parse(t.slice(s + 1, e));
    } catch (err) {
      /* fallthrough */
    }
  }
  return JSON.parse(t);
}

/** 股票代码 → 东财 secid */
function toSecid(code) {
  const c = String(code || '').trim();
  if (!c) return '';
  if (/^[A-Za-z]/.test(c)) return '105.' + c; // 美股
  if (c.length === 5) return '116.' + c; // 港股
  if (/^(6|9)/.test(c)) return '1.' + c; // 沪市
  return '0.' + c; // 深市 / 北交所
}

/** 基金搜索联想 */
async function searchFund(key) {
  const k = String(key || '').trim();
  const url =
    'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' +
    encodeURIComponent(k) +
    '&_=' +
    Date.now();
  const text = await req(url, 'https://fund.eastmoney.com/');
  const json = stripJsonp(text);
  const list = (json && json.Datas) || [];

  const items = list
    .map(function (it) {
      const code = it.CODE || it.FCODE || it.code;
      const name = it.NAME || it.SHORTNAME || it.name;
      if (!code || !name) return null;
      return {
        code: String(code),
        name: String(name),
        type: it.CATEGORYDESC || it.FTYPE || it.type || ''
      };
    })
    .filter(Boolean);

  // 输入是 6 位纯数字（基金代码）时，精确查该基金并置顶
  // 联想接口对代码片段匹配不准（如搜"900"返回一堆 00/01 开头），这里兜底
  if (/^\d{6}$/.test(k)) {
    try {
      const info = await getFundInfo(k);
      if (info) {
        const exist = items.findIndex(function (it) { return it.code === k; });
        const exact = { code: info.code, name: info.name, type: info.ftype };
        if (exist >= 0) items.splice(exist, 1);
        items.unshift(exact);
      }
    } catch (e) {
      /* 忽略，按联想结果返回 */
    }
  }

  // 本地重排序：代码匹配优先，名称匹配其次
  const score = function (it) {
    if (it.code === k) return 0;
    if (it.code.indexOf(k) === 0) return 1;
    if (it.code.indexOf(k) >= 0) return 2;
    if (it.name.indexOf(k) === 0) return 3;
    if (it.name.indexOf(k) >= 0) return 4;
    return 5;
  };
  items.sort(function (a, b) {
    return score(a) - score(b);
  });

  return items.slice(0, 20);
}

/**
 * 基金基本信息（名称、类型、上一单位净值）
 * 注：ENDNAV 是基金资产规模，不是单位净值，不能用
 */
async function getFundInfo(fcode) {
  const url =
    'https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx?FCODE=' +
    fcode +
    '&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0';
  const data = JSON.parse(await req(url, 'https://fundmobapi.eastmoney.com/'));
  const d = (data && data.Datas) || null;
  if (!d || !d.FCODE) return null;
  return {
    code: String(d.FCODE),
    name: String(d.SHORTNAME || d.FNAME || fcode),
    ftype: String(d.FTYPE || ''),
    size: Number(d.ENDNAV) || 0,
    prevNav: Number(d.DWJZ) || 0,
    navDate: String(d.FSRQ || d.PDATE || '')
  };
}

/**
 * 上一交易日涨跌幅：取最新已披露一期的日增长率
 * @returns {{date:string, pct:number}|null}
 */
async function getLastDayChange(fcode) {
  const url =
    'https://api.fund.eastmoney.com/f10/lsjz?fundCode=' +
    fcode +
    '&pageIndex=1&pageSize=5&_=' +
    Date.now();
  const json = JSON.parse(await req(url, 'https://fundf10.eastmoney.com/', false, 4000));
  const list = (json && json.Data && json.Data.LSJZList) || [];
  for (let i = 0; i < list.length; i++) {
    const pct = parseFloat(list[i].JZZZL);
    if (Number.isFinite(pct)) return { date: String(list[i].FSRQ || ''), pct: pct };
  }
  return null;
}

/** 官方估值（fundgz），所有类型兜底 */
async function getOfficialEstimate(code) {
  const url = 'https://fundgz.1234567.com.cn/js/' + code + '.js?rt=' + Date.now();
  const text = await req(url, 'https://fund.eastmoney.com/', false, 4000);
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]);
  return {
    prevNav: Number(j.dwjz) || 0,
    estNav: Number(j.gsz) || 0,
    estPct: Number(j.gszzl) || 0,
    time: String(j.gztime || '')
  };
}

/**
 * 前十大持仓（季报快照，非实时！）
 * 注意：必须带 Referer，否则返回空
 */
async function getHoldings(code) {
  const url =
    'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=' +
    code +
    '&topline=10&year=&month=&rt=' +
    Date.now();
  const html = await req(url, 'https://fundf10.eastmoney.com/', false, 6000);
  if (!html || html.indexOf('<h4') < 0) return null;

  const block = html.split('<h4 class="t">')[1] || html.split('<h4')[1] || html;
  const period = ((block.match(/(20\d{2}-\d{2}-\d{2})/) || [])[1] || '') ||
    ((html.match(/(20\d{2}-\d{2}-\d{2})/) || [])[1] || '');

  const stocks = [];
  const rows = block.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  for (let i = 0; i < rows.length; i++) {
    const tds = [];
    const re = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let mm;
    while ((mm = re.exec(rows[i])) !== null) {
      tds.push(mm[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    }
    if (tds.length < 3) continue;

    let codeIdx = -1;
    for (let k = 0; k < tds.length; k++) {
      if (/^\d{6}$/.test(tds[k]) || /^[A-Za-z]{1,5}$/.test(tds[k]) || /^\d{5}$/.test(tds[k])) {
        codeIdx = k;
        break;
      }
    }
    let ratioIdx = -1;
    for (let k = 0; k < tds.length; k++) {
      if (/^\d+(\.\d+)?%$/.test(tds[k])) {
        ratioIdx = k;
        break;
      }
    }
    if (codeIdx < 0 || ratioIdx < 0) continue;

    const stockCode = tds[codeIdx];
    stocks.push({
      code: stockCode,
      secid: toSecid(stockCode),
      name: tds[codeIdx + 1] || stockCode,
      weight: parseFloat(tds[ratioIdx]) / 100
    });
    if (stocks.length >= 10) break;
  }

  if (!stocks.length) return null;
  stocks.sort(function (a, b) {
    return b.weight - a.weight;
  });
  return { period: period, stocks: stocks.slice(0, 10) };
}

/**
 * 行情：腾讯 qt.gtimg.cn（主）+ 新浪 hq.sinajs.cn（兜底）
 * 天天基金 push2 行情接口对云 IP 限流（ECONNRESET），故改用这两个免费接口
 */

/** 东财 secid → 腾讯/新浪代码（"1.600519"→sh600519，"0.000858"→sz000858，"116.00700"→hk00700） */
function toTxCode(secid) {
  const s = String(secid || '');
  const dot = s.indexOf('.');
  if (dot <= 0) return null;
  const mkt = s.slice(0, dot);
  const code = s.slice(dot + 1);
  if (mkt === '1') return 'sh' + code;
  if (mkt === '0') return 'sz' + code;
  if (mkt === '116') return 'hk' + code;
  return null;
}

/** 解析腾讯返回（`~` 分隔），key=腾讯代码 */
function parseTencent(text) {
  const map = {};
  String(text || '').split(';').forEach(function (line) {
    const m = line.match(/v_(\w+)="([^"]*)"/);
    if (!m) return;
    const f = m[2].split('~');
    if (f.length < 33) return;
    const price = Number(f[3]);
    const prevClose = Number(f[4]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(prevClose)) return;
    map[m[1]] = { price: price, prevClose: prevClose, pct: Number(f[32]) || 0 };
  });
  return map;
}

/** 解析新浪返回（逗号分隔），key=新浪代码 */
function parseSina(text) {
  const map = {};
  String(text || '').split(';').forEach(function (line) {
    const m = line.match(/hq_str_(\w+)="([^"]*)"/);
    if (!m) return;
    const f = m[2].split(',');
    const price = Number(f[3]);
    const prevClose = Number(f[2]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(prevClose) || prevClose <= 0) return;
    map[m[1]] = {
      price: price,
      prevClose: prevClose,
      pct: Number(((price / prevClose - 1) * 100).toFixed(3))
    };
  });
  return map;
}

/** 按数据源拉取行情（批量），返回 key=腾讯/新浪代码 的 map */
async function fetchBySource(source, codes) {
  if (source === 'tencent') {
    const t = await req('https://qt.gtimg.cn/q=' + codes.join(','), 'https://gu.qq.com/', false, 4000);
    return parseTencent(t);
  }
  const t = await req('https://hq.sinajs.cn/list=' + codes.join(','), 'https://finance.sina.com.cn/', false, 4000);
  return parseSina(t);
}

/** 批量行情：腾讯主、新浪兜底，最终按 secid + 纯 code 双索引返回 */
async function getQuotes(secids) {
  if (!secids || !secids.length) return {};

  const codes = secids.map(toTxCode).filter(Boolean);
  if (!codes.length) return {};

  const result = {};
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = await fetchBySource(i === 0 ? 'tencent' : 'sina', codes);
      codes.forEach(function (c) {
        if (parsed[c]) result[c] = parsed[c];
      });
      if (codes.every(function (c) { return result[c]; })) break;
    } catch (e) {
      /* 换下一个源 */
    }
  }

  const map = {};
  secids.forEach(function (secid) {
    const v = result[toTxCode(secid)];
    if (v) {
      map[secid] = v;
      map[secid.slice(secid.indexOf('.') + 1)] = v;
    }
  });
  return map;
}

/** 个股当日分时（分钟级，腾讯） */
async function getTrend(secid) {
  const tx = toTxCode(secid);
  if (!tx) return null;

  try {
    const t = await req('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + tx, 'https://gu.qq.com/', false, 5000);
    const node = (JSON.parse(t).data || {})[tx];
    if (!node || !node.data || !node.data.data) return null;

    const qtArr = (node.qt || {})[tx];
    const preClose = qtArr && Number(qtArr[4]);
    if (!Number.isFinite(preClose) || preClose <= 0) return null;

    const points = [];
    node.data.data.forEach(function (line) {
      const p = String(line).split(' ');
      const raw = p[0]; // "0930" / "1500"
      const price = Number(p[1]);
      if (p.length < 2 || !Number.isFinite(price) || price <= 0) return;
      // 过滤掉 15:00 之后的尾盘集合竞价点，避免曲线尾部出现孤立断点
      if (raw > '1500') return;
      points.push({
        t: raw.slice(0, 2) + ':' + raw.slice(2),
        price: price,
        pct: (price / preClose - 1) * 100
      });
    });
    if (points.length < 2) return null;
    return { preClose: preClose, points: points };
  } catch (e) {
    return null;
  }
}

module.exports = {
  req: req,
  toSecid: toSecid,
  getTrend: getTrend,
  searchFund: searchFund,
  getFundInfo: getFundInfo,
  getLastDayChange: getLastDayChange,
  getOfficialEstimate: getOfficialEstimate,
  getHoldings: getHoldings,
  getQuotes: getQuotes
};
