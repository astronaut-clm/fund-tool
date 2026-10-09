/** 数据源：天天基金（基金数据）+ 腾讯/新浪（行情），公开免费接口 */
const https = require('https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 20,
  maxFreeSockets: 8
});

const RE_FUND_CODE = /^\d{6}$/;
function isValidFundCode(code) {
  return RE_FUND_CODE.test(String(code || ''));
}

const BATCH = 50;
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** GET 请求，自动跟随一次重定向 */
function req(url, referer, ms) {
  return new Promise(function (resolve, reject) {
    const doReq = function (u, redirected) {
      try {
        https
          .get(
            u,
            {
              agent: agent,
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
                if (redirected) return reject(new Error('too many redirects'));
                let next = res.headers.location;
                if (next.indexOf('http') !== 0) next = 'https:' + next;
                return doReq(next, true);
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
    } catch (err) {}
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

/** 过滤联想接口混入的股票/指数/板块等非基金结果 */
const FUND_TYPE_RE = /型|QDII|FOF|ETF|LOF|REITs|理财/i;

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
    .filter(function (it) {
      return it && FUND_TYPE_RE.test(it.type);
    });

  // 6 位数字（基金代码）时精确查并置顶（联想接口对代码片段匹配不准）
  if (/^\d{6}$/.test(k)) {
    try {
      const info = await getFundInfo(k);
      if (info) {
        const exist = items.findIndex(function (it) { return it.code === k; });
        if (exist >= 0) items.splice(exist, 1);
        items.unshift({ code: info.code, name: info.name, type: info.ftype });
      }
    } catch (e) {}
  }

  // 代码匹配优先，名称匹配其次
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

/** 基金基本信息（名称、类型、规模） */
async function getFundInfo(fcode) {
  if (!isValidFundCode(fcode)) return null;
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
    size: Number(d.ENDNAV) || 0
  };
}

/** 上一交易日涨跌幅 + 当日单位净值（最新已披露一期及近几期） */
async function getLastDayChange(fcode) {
  if (!isValidFundCode(fcode)) return null;
  const url =
    'https://api.fund.eastmoney.com/f10/lsjz?fundCode=' +
    fcode +
    '&pageIndex=1&pageSize=5&_=' +
    Date.now();
  const json = JSON.parse(await req(url, 'https://fundf10.eastmoney.com/', 4000));
  const list = (json && json.Data && json.Data.LSJZList) || [];
  const days = [];
  for (let i = 0; i < list.length; i++) {
    const pct = parseFloat(list[i].JZZZL);
    const nav = parseFloat(list[i].DWJZ);
    if (!Number.isFinite(pct)) continue;
    days.push({
      date: String(list[i].FSRQ || ''),
      pct: pct,
      nav: Number.isFinite(nav) ? nav : null
    });
  }
  if (!days.length) return null;
  return { date: days[0].date, pct: days[0].pct, nav: days[0].nav, days: days };
}

/** 解析 jjcc 持仓表格（可能含多个报告期），按报告期倒序 */
function parseJjcc(html) {
  const segs = String(html).split(/<h4[^>]*>/i).slice(1);
  const out = [];
  const seenPeriod = {};
  segs.forEach(function (seg) {
    const parts = seg.split('</h4>');
    const head = parts[0] || '';
    const tableHtml = parts.slice(1).join('</h4>') || seg;
    const pm = head.match(/(20\d{2}-\d{2}-\d{2})/) || tableHtml.match(/(20\d{2}-\d{2}-\d{2})/);
    const period = pm ? pm[1] : '';
    if (!period || seenPeriod[period]) return;

    const stocks = [];
    const rows = tableHtml.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    for (let i = 0; i < rows.length; i++) {
      const tds = [];
      const re = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let mm;
      while ((mm = re.exec(rows[i])) !== null) {
        tds.push(mm[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      }
      if (tds.length < 3) continue;

      // 定位代码列与占比列（各表列序不固定）
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

      stocks.push({
        code: tds[codeIdx],
        secid: toSecid(tds[codeIdx]),
        name: tds[codeIdx + 1] || tds[codeIdx],
        weight: parseFloat(tds[ratioIdx]) / 100
      });
      if (stocks.length >= 10) break;
    }

    if (stocks.length) {
      stocks.sort(function (a, b) {
        return b.weight - a.weight;
      });
      seenPeriod[period] = true;
      out.push({ period: period, stocks: stocks.slice(0, 10) });
    }
  });
  out.sort(function (a, b) {
    return b.period.localeCompare(a.period);
  });
  return out;
}

/** 按年份拉取持仓明细（year 为空 = 最新一期） */
async function getHoldingsByYear(code, year) {
  const url =
    'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=' +
    code +
    '&topline=10&year=' +
    (year || '') +
    '&month=&rt=' +
    Date.now();
  const html = await req(url, 'https://fundf10.eastmoney.com/', 6000);
  if (!html || html.indexOf('<h4') < 0) return [];
  return parseJjcc(html);
}

/** 前十大持仓（季报快照）+ 较上期持仓变动（weightDelta 百分点 / isNew） */
async function getHoldings(code) {
  if (!isValidFundCode(code)) return null;
  const periods = await getHoldingsByYear(code, '');
  if (!periods.length) return null;
  const cur = periods[0];

  let list = periods;
  if (periods.length < 2) {
    try {
      const sameYear = await getHoldingsByYear(code, cur.period.slice(0, 4));
      if (sameYear.length > list.length) list = sameYear;
    } catch (e) {}
  }

  let prev = null;
  const idx = list.findIndex(function (p) { return p.period === cur.period; });
  if (idx >= 0 && idx + 1 < list.length) prev = list[idx + 1];
  if (!prev) {

    try {
      // 最新一期是 Q1 时，上一期为上一年年报
      const older = await getHoldingsByYear(code, String(Number(cur.period.slice(0, 4)) - 1));
      if (older.length) prev = older[0];
    } catch (e) {}
  }

  const prevMap = {};
  if (prev) {
    prev.stocks.forEach(function (s) {
      prevMap[s.code] = s.weight;
    });
  }
  cur.stocks.forEach(function (s) {
    if (prevMap[s.code] !== undefined) {
      s.weightDelta = Math.round((s.weight - prevMap[s.code]) * 10000) / 100;
    } else {
      s.isNew = true;
    }
  });

  return { period: cur.period, prevPeriod: prev ? prev.period : '', stocks: cur.stocks };
}

/** 个股所属行业（push2 批量，对云 IP 偶发限流，失败返回空 map） */
async function getIndustries(codes) {
  if (!codes || !codes.length) return {};
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fields=f12,f14,f100&secids=' +
    codes.map(toSecid).join(',');
  try {
    const j = JSON.parse(await req(url, 'https://quote.eastmoney.com/', 4000));
    let diff = (j && j.data && j.data.diff) || [];
    if (!Array.isArray(diff)) {
      diff = Object.keys(diff).map(function (k) { return diff[k]; });
    }
    const map = {};
    diff.forEach(function (it) {
      if (it && it.f12 && it.f100) map[String(it.f12)] = String(it.f100);
    });
    return map;
  } catch (e) {
    return {};
  }
}

/** 东财 secid → 腾讯/新浪代码（"1.600519"→sh600519） */
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

/** 解析腾讯行情（~ 分隔） */
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
    map[m[1]] = {
      price: price,
      prevClose: prevClose,
      pct: Number(f[32]) || 0,
      date: String(f[30] || '').slice(0, 8)
    };
  });
  return map;
}

/** 解析新浪行情（逗号分隔） */
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
      pct: Number(((price / prevClose - 1) * 100).toFixed(3)),
      date: String(f[30] || '').replace(/\D/g, '').slice(0, 8)
    };
  });
  return map;
}

async function fetchBySource(source, codes) {
  if (source === 'tencent') {
    const t = await req('https://qt.gtimg.cn/q=' + codes.join(','), 'https://gu.qq.com/', 4000);
    return parseTencent(t);
  }
  const t = await req('https://hq.sinajs.cn/list=' + codes.join(','), 'https://finance.sina.com.cn/', 4000);
  return parseSina(t);
}

/** 批量行情：腾讯主、新浪兜底，按 secid + 纯 code 双索引返回 */
async function getQuotes(secids) {
  if (!secids || !secids.length) return {};

  const secidToTx = {};
  secids.forEach(function (secid) {
    const tx = toTxCode(secid);
    if (tx) secidToTx[secid] = tx;
  });
  const codes = Object.keys(secidToTx).map(function (secid) { return secidToTx[secid]; });
  if (!codes.length) return {};

  const result = {};
  await Promise.all(
    chunk(codes, BATCH).map(async function (batch) {
      try {
        const parsed = await fetchBySource('tencent', batch);
        batch.forEach(function (c) {
          if (parsed[c]) result[c] = parsed[c];
        });
      } catch (e) {}
    })
  );

  // 新浪只补腾讯缺失的
  const missing = codes.filter(function (c) { return !result[c]; });
  if (missing.length) {
    await Promise.all(
      chunk(missing, BATCH).map(async function (batch) {
        try {
          const parsed = await fetchBySource('sina', batch);
          batch.forEach(function (c) {
            if (parsed[c]) result[c] = parsed[c];
          });
        } catch (e) {}
      })
    );
  }

  const map = {};
  Object.keys(secidToTx).forEach(function (secid) {
    const v = result[secidToTx[secid]];
    if (v) {
      map[secid] = v;
      map[secid.slice(secid.indexOf('.') + 1)] = v;
    }
  });
  return map;
}

/** 分时（腾讯）：入参 secid（"1.600519"）或腾讯代码（sh000300/hkHSTECH） */
async function getTrend(secidOrTx) {
  const s = String(secidOrTx || '');
  const tx = s.indexOf('.') > 0 ? toTxCode(s) : s;
  if (!tx) return null;
  return fetchTrendByTx(tx);
}

async function fetchTrendByTx(tx) {
  try {
    const t = await req('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + tx, 'https://gu.qq.com/', 5000);
    const node = (JSON.parse(t).data || {})[tx];
    if (!node || !node.data || !node.data.data) return null;

    const qtArr = (node.qt || {})[tx];
    const preClose = qtArr && Number(qtArr[4]);
    if (!Number.isFinite(preClose) || preClose <= 0) return null;

    const points = [];
    node.data.data.forEach(function (line) {
      const p = String(line).split(' ');
      const raw = p[0];
      const price = Number(p[1]);
      if (p.length < 2 || !Number.isFinite(price) || price <= 0) return;
      if (raw > '1700') return; // 过滤盘后孤立点，保留 16:00-17:00 收盘竞价快照
      points.push({
        t: raw.slice(0, 2) + ':' + raw.slice(2),
        price: price,
        pct: (price / preClose - 1) * 100
      });
    });
    if (points.length < 2) return null;

    // introduce：A 股指数有介绍，港股/美股指数无
    return { date: String(node.data.date || ''), preClose: preClose, points: points, introduce: String(node.introduce || '') };
  } catch (e) {
    return null;
  }
}

/** 境外指数代码 → 腾讯代码 */
const US_TX_MAP = {
  SP500: 'usINX',
  NDX: 'usNDX',
  DJI: 'usDJI',
  IXIC: 'usIXIC',
  GDAXI: 'usDAX'
};

function indexSymbolToTx(symbol) {
  const s = String(symbol || '').trim();
  if (!s) return '';
  const m = s.match(/^(SH|SZ)(\d{6})$/);
  if (m) return m[1].toLowerCase() + m[2];
  if (/^HK/.test(s)) return 'hk' + s.slice(2);
  return US_TX_MAP[s] || ''; // CSI* 等腾讯无行情
}

/** 指数名 → 指数代码 */
const INDEX_ALIAS = {
  沪深300: 'SH000300',
  中证100: 'SH000903',
  中证500: 'SH000905',
  中证800: 'SH000906',
  中证1000: 'SH000852',
  上证50: 'SH000016',
  上证180: 'SH000010',
  上证红利: 'SH000015',
  深证成指: 'SZ399001',
  深证100: 'SZ399330',
  创业板: 'SZ399006',
  创业板指: 'SZ399006',
  科创50: 'SH000688',
  科创100: 'SH000698',
  中证白酒: 'SZ399997',
  中证红利: 'SH000922',
  中证医疗: 'SZ399989',
  中证军工: 'SZ399967',
  中证银行: 'SZ399986',
  中证煤炭: 'SZ399998',
  中证传媒: 'SZ399971',
  中证环保: 'SH000827',
  证券公司: 'SZ399975',
  中证全指证券公司: 'SZ399975',
  中证新能源汽车: 'SZ399976',
  中证新能源: 'SZ399808',
  国证新能源车电池: 'SZ980032',
  创业板50: 'SZ399673',
  中证酒: 'SZ399987',
  沪深300医药卫生: 'SH000913',
  全指医药: 'SH000991',
  中证全指通信设备: 'SH515880',
  中证消费: 'SH000932',
  上证科创板50成份: 'SH000688',
  上证科创板芯片: 'SH000685',
  科创芯片: 'SH000685',
  中证海外中国互联网50: 'CSIH30533',
  中概互联50: 'CSIH30533',
  中国互联: 'CSIH11136',
  恒生指数: 'HKHSI',
  恒生科技: 'HKHSTECH',
  国企指数: 'HKHSCEI',
  恒生中国企业: 'HKHSCEI',
  标普500: 'SP500',
  标准普尔500: 'SP500',
  纳斯达克100: 'NDX',
  纳指100: 'NDX',
  纳斯达克: 'IXIC',
  道琼斯: 'DJI',
  德国DAX: 'GDAXI'
};

/** 指数名候选：去括号、去"指数"后缀、逐个剥离"人民币/全收益"等尾缀 */
function indexNameCandidates(name) {
  const s = String(name || '').replace(/\s/g, '').replace(/[（(][^）)]*[）)]/g, '');
  const SUFFIX = /(?:指数|收益率|全收益|总收益|净收益|价格|人民币计价|美元计价|人民币|美元|RMB|USD)+$/i;
  const out = [];
  const push = function (x) {
    const v = String(x || '').replace(/^的/, '');
    if (v && out.indexOf(v) < 0) out.push(v);
  };

  push(s);
  let cur = s.replace(/指数$/, '');
  push(cur);
  for (let i = 0; i < 3; i++) {
    const next = cur.replace(SUFFIX, '');
    if (next === cur) break;
    cur = next;
    push(cur);
  }
  return out;
}

/** 腾讯代码 → 大写指数代码（sh000300 → SH000300，hkHSTECH → HKHSTECH） */
function txToIndexSymbol(tx) {
  const m = String(tx || '').match(/^(sh|sz|hk|us)(.+)$/);
  if (!m) return String(tx || '').toUpperCase();
  if (m[1] === 'hk') return 'HK' + m[2];
  if (m[1] === 'us') return m[2].toUpperCase();
  return m[1].toUpperCase() + m[2];
}

/** 腾讯指数联想：按指数名搜，取第一条类型为 ZS 的结果，直接给出可用的 txCode */
async function searchIndexTx(name) {
  const cands = indexNameCandidates(name).slice(0, 2);
  for (let i = 0; i < cands.length; i++) {
    const url = 'https://smartbox.gtimg.cn/s3/?q=' + encodeURIComponent(cands[i]) + '&t=gp';
    const txt = await req(url, 'https://gu.qq.com/', 4000).catch(function () { return ''; });
    const m = txt.match(/v_hint="([^"]*)"/);
    if (!m || m[1] === 'N') continue;
    const hit = m[1]
      .split('^')
      .map(function (s) { return s.split('~'); })
      .filter(function (f) { return f.length >= 5 && f[4] === 'ZS' && /^(sh|sz|hk|us)/.test(f[0]); })[0];
    if (hit) {
      const tx = hit[0] + hit[1];
      return { symbol: txToIndexSymbol(tx), txCode: tx };
    }
  }
  return null;
}

/** 指数名 → {symbol, txCode}：本地别名表 → 腾讯联想 */
async function resolveIndexByName(name) {
  const cands = indexNameCandidates(name);
  for (let i = 0; i < cands.length; i++) {
    const symbol = INDEX_ALIAS[cands[i]];
    if (symbol) return { symbol: symbol, txCode: indexSymbolToTx(symbol) };
  }
  return await searchIndexTx(name);
}

/** F10 页面有限流：串行化并保证最小请求间隔 */
const F10_GAP = 250;
let _f10Chain = Promise.resolve();
let _f10Last = 0;

function f10Fetch(fcode) {
  const url = 'https://fundf10.eastmoney.com/jbgk_' + fcode + '.html';
  const p = _f10Chain.then(function () {
    const wait = F10_GAP - (Date.now() - _f10Last);
    const delay = wait > 0 ? new Promise(function (r) { setTimeout(r, wait); }) : Promise.resolve();
    return delay.then(function () {
      _f10Last = Date.now();
      return req(url, 'https://fundf10.eastmoney.com/', 8000);
    });
  });
  _f10Chain = p.then(
    function () {},
    function () {}
  );
  return p;
}

/** 取基本概况表格字段（"跟踪标的"/"基金类型"/"业绩比较基准"） */
function pickTableField(html, label) {
  const m = html.match(new RegExp(label + '\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>'));
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 取正文段落（"投资目标"） */
function pickSection(html, label, endLabel) {
  const i = html.indexOf(label);
  if (i < 0) return '';
  let seg = html.slice(i + label.length);
  const j = endLabel ? seg.indexOf(endLabel) : -1;
  seg = j >= 0 ? seg.slice(0, j) : seg.slice(0, 2000);
  const p = seg.match(/<p>([\s\S]*?)<\/p>/);
  return (p ? p[1] : seg).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** 天天基金 F10 基本概况 {ftype, target, bench, aim}；target 为空 = 非指数型或未取到 */
async function getFundProfile(fcode) {
  if (!isValidFundCode(fcode)) return null;
  try {
    const html = await f10Fetch(fcode);
    if (!html || html.indexOf('基本概况') < 0) return null;
    const target = pickTableField(html, '跟踪标的');
    return {
      ftype: pickTableField(html, '基金类型'),
      target: target && !/无跟踪标的/.test(target) ? target : '',
      bench: pickTableField(html, '业绩比较基准'),
      aim: pickSection(html, '投资目标', '投资理念')
    };
  } catch (e) {
    console.warn('[getFundProfile] failed', fcode, (e && e.message) || e);
    return null;
  }
}

/** F10「跟踪标的」→ 归一化指数名 → 别名表/腾讯联想 → {symbol, name, txCode, desc, source} */
async function getBenchmarkIndex(fcode) {
  if (!isValidFundCode(fcode)) return null;

  try {
    const prof = await getFundProfile(fcode);
    if (!prof || !prof.target) return null;

    const hit = await resolveIndexByName(prof.target);
    if (!hit) return null;
    return {
      symbol: hit.symbol,
      name: prof.target,
      txCode: hit.txCode,
      desc: prof.aim || '',
      source: 'f10'
    };
  } catch (e) {
    console.warn('[getBenchmarkIndex] failed', fcode, (e && e.message) || e);
    return null;
  }
}

/** 批量指数行情（入参直接是腾讯代码，无 secid） */
async function getIndexQuotes(txCodes) {
  if (!txCodes || !txCodes.length) return {};
  const result = {};
  await Promise.all(
    chunk(txCodes, BATCH).map(async function (batch) {
      try {
        const parsed = parseTencent(await req('https://qt.gtimg.cn/q=' + batch.join(','), 'https://gu.qq.com/', 4000));
        batch.forEach(function (c) {
          if (parsed[c]) result[c] = parsed[c];
        });
      } catch (e) {}
    })
  );
  return result;
}

module.exports = {
  isValidFundCode: isValidFundCode,
  getTrend: getTrend,
  searchFund: searchFund,
  getFundInfo: getFundInfo,
  getBenchmarkIndex: getBenchmarkIndex,
  getIndexQuotes: getIndexQuotes,
  getLastDayChange: getLastDayChange,
  getHoldings: getHoldings,
  getIndustries: getIndustries,
  getQuotes: getQuotes
};
