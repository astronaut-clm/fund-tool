const CODES_KEY = 'FUND_CODES';
const HISTORY_KEY = 'FUND_SEARCH_HISTORY';
const HISTORY_MAX = 10;

function getCodes() {
  try {
    const v = wx.getStorageSync(CODES_KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function setCodes(codes) {
  try {
    const seen = {};
    const list = (Array.isArray(codes) ? codes : []).filter(function (c) {
      const k = String(c);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
    wx.setStorageSync(CODES_KEY, list);
    return list;
  } catch (e) {
    return [];
  }
}

function addCode(code) {
  const list = getCodes();
  const c = String(code || '');
  if (c && list.indexOf(c) === -1) {
    list.push(c);
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

/** 搜索历史：最多 HISTORY_MAX 条，新的置顶，去重 */
function getHistory() {
  try {
    const v = wx.getStorageSync(HISTORY_KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function addHistory(code, name) {
  try {
    const list = getHistory().filter(function (it) {
      return it.code !== code;
    });
    list.unshift({ code: String(code), name: String(name || code) });
    wx.setStorageSync(HISTORY_KEY, list.slice(0, HISTORY_MAX));
    return list;
  } catch (e) {
    return [];
  }
}

function clearHistory() {
  try {
    wx.removeStorageSync(HISTORY_KEY);
  } catch (e) {
    /* ignore */
  }
}

/** 涨跌幅格式化：+1.23% */
function fmtPct(n) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '--';
  const v = Number(n);
  if (Math.abs(v) < 0.005) return '0.00%';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

function fmtNav(n) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '--';
  return Number(n).toFixed(4);
}

/** 日期格式化：YYYY-MM-DD → MM-DD */
function fmtDate(s) {
  const t = String(s || '');
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[2] + '-' + m[3] : '';
}

/** 涨跌方向样式 class */
function clsOf(n) {
  const v = Number(n);
  if (n === null || n === undefined || isNaN(v) || Math.abs(v) < 0.005) return 'flat';
  return v > 0 ? 'up' : 'down';
}

function pad2(n) {
  const v = Number(n);
  return (v < 10 ? '0' : '') + v;
}

/** 今天 YYYYMMDD（与服务端日期比对） */
function todayStr(d) {
  const now = d || new Date();
  return '' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate());
}

/** 把服务端返回的行情日期（YYYY-MM-DD 或 YYYYMMDD）规范为 MM-DD */
function fmtDataDate(s) {
  const t = String(s || '').replace(/\D/g, '');
  if (t.length < 8) return '';
  return t.slice(4, 6) + '-' + t.slice(6, 8);
}

/** A股交易时段：9:30-11:30 / 13:00-15:00 */
function isTrading(d) {
  const now = d || new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60);
}

function nowText(d) {
  const now = d || new Date();
  return pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
}

module.exports = {
  getCodes: getCodes,
  setCodes: setCodes,
  addCode: addCode,
  removeCode: removeCode,
  getHistory: getHistory,
  addHistory: addHistory,
  clearHistory: clearHistory,
  fmtPct: fmtPct,
  fmtNav: fmtNav,
  fmtDate: fmtDate,
  clsOf: clsOf,
  pad2: pad2,
  todayStr: todayStr,
  fmtDataDate: fmtDataDate,
  isTrading: isTrading,
  nowText: nowText
};
