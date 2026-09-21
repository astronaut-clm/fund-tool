const CODES_KEY = 'FUND_CODES';

function getCodes() {
  try {
    const v = wx.getStorageSync(CODES_KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function setCodes(codes) {
  wx.setStorageSync(CODES_KEY, codes);
}

function addCode(code) {
  const list = getCodes();
  if (list.indexOf(code) === -1) {
    list.push(code);
    setCodes(list);
  }
  return list;
}

function removeCode(code) {
  const list = getCodes().filter(function (c) {
    return c !== code;
  });
  setCodes(list);
  return list;
}

/** 涨跌幅格式化：+1.23% */
function fmtPct(n) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '--';
  const v = Number(n);
  if (Math.abs(v) < 0.005) return '0.00%';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

/** 净值格式化 */
function fmtNav(n) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '--';
  return Number(n).toFixed(4);
}

/** 日期格式化：YYYY-MM-DD → MM-DD，非法/空返回 '' */
function fmtDate(s) {
  const t = String(s || '');
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[2] + '-' + m[3] : '';
}

/** 方向样式 class */
function clsOf(n) {
  const v = Number(n);
  if (n === null || n === undefined || isNaN(v) || Math.abs(v) < 0.005) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/** A股交易时段：9:30-11:30 / 13:00-15:00（集合竞价 9:15-9:25 不参与估值） */
function isTrading(d) {
  const now = d || new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60);
}

function nowText(d) {
  const now = d || new Date();
  const p = function (n) {
    return n < 10 ? '0' + n : '' + n;
  };
  return p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
}

module.exports = {
  getCodes: getCodes,
  setCodes: setCodes,
  addCode: addCode,
  removeCode: removeCode,
  fmtPct: fmtPct,
  fmtNav: fmtNav,
  fmtDate: fmtDate,
  clsOf: clsOf,
  isTrading: isTrading,
  nowText: nowText
};
