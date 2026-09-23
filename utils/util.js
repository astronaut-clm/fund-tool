const config = require('./config.js');

const CODES_KEY = 'FUND_CODES';
const HISTORY_KEY = 'FUND_SEARCH_HISTORY';
const HOLDINGS_KEY = 'FUND_HOLDINGS';

function getCodes() {
  try {
    const v = wx.getStorageSync(CODES_KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function setCodes(codes) {
  const list = _normalizeCodes(codes);
  if (list === null) return [];
  try {
    wx.setStorageSync(CODES_KEY, list);
    touchLocalDirty();
    return list;
  } catch (e) {
    return [];
  }
}

/** 仅规范化自选数组，不写入 storage。返回 null 表示非数组 */
function _normalizeCodes(codes) {
  if (!Array.isArray(codes)) return null;
  const seen = {};
  const list = [];
  for (let i = 0; i < codes.length; i++) {
    const k = String(codes[i]);
    if (!seen[k]) {
      seen[k] = true;
      list.push(k);
    }
  }
  return list;
}

/** 静默写入（不触发脏标记），用于云端恢复 */
function setCodesSilent(codes) {
  const list = _normalizeCodes(codes);
  if (list === null) return [];
  try {
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

/** 搜索历史：最多 maxHistory 条，新的置顶，去重 */
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
    wx.setStorageSync(HISTORY_KEY, list.slice(0, config.maxHistory));
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

/* ============ 持仓存储 ============ */

function getHoldings() {
  try {
    const v = wx.getStorageSync(HOLDINGS_KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function setHoldings(list) {
  const arr = _normalizeHoldings(list);
  if (arr === null) return [];
  try {
    wx.setStorageSync(HOLDINGS_KEY, arr);
    touchLocalDirty();
    return arr;
  } catch (e) {
    return [];
  }
}

/** 仅规范化持仓数组，不写入 storage。返回 null 表示非数组 */
function _normalizeHoldings(list) {
  if (!Array.isArray(list)) return null;
  const seen = {};
  const arr = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || !it.code) continue;
    const k = String(it.code);
    if (seen[k]) continue;
    seen[k] = true;
    arr.push(it);
  }
  return arr;
}

/** 静默写入（不触发脏标记），用于云端恢复 */
function setHoldingsSilent(list) {
  const arr = _normalizeHoldings(list);
  if (arr === null) return [];
  try {
    wx.setStorageSync(HOLDINGS_KEY, arr);
    return arr;
  } catch (e) {
    return [];
  }
}

/** 写入/更新一条持仓。amount<=0 视为删除 */
function setHolding(code, name, amount, profit) {
  const list = getHoldings().filter(function (h) { return h.code !== String(code); });
  const a = Number(amount);
  const p = Number(profit);
  if (a > 0) {
    list.push({
      code: String(code),
      name: name || code,
      amount: a,
      profit: Number.isFinite(p) ? p : 0
    });
  }
  return setHoldings(list);
}

function removeHolding(code) {
  const list = getHoldings().filter(function (h) { return h.code !== String(code); });
  return setHoldings(list);
}

/** 金额格式化：千分位 + 2 位小数，负数带 - */
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '--';
  const neg = v < 0;
  const abs = Math.abs(v).toFixed(2);
  const parts = abs.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + parts.join('.');
}

/** 时间戳 → YYYY-MM-DD HH:mm */
function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  return (
    d.getFullYear() +
    '-' + pad2(d.getMonth() + 1) +
    '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) +
    ':' + pad2(d.getMinutes())
  );
}

/** 上次同步时间 */
const BACKUP_TS_KEY = 'FUND_BACKUP_TS';
/** 本地数据最后修改时间 */
const LOCAL_DIRTY_TS_KEY = 'FUND_LOCAL_DIRTY_TS';

function getBackupTs() {
  try {
    return Number(wx.getStorageSync(BACKUP_TS_KEY)) || 0;
  } catch (e) {
    return 0;
  }
}

function setBackupTs(ts) {
  try {
    wx.setStorageSync(BACKUP_TS_KEY, Number(ts) || Date.now());
  } catch (e) {
    /* ignore */
  }
}

function getLocalDirtyTs() {
  try {
    return Number(wx.getStorageSync(LOCAL_DIRTY_TS_KEY)) || 0;
  } catch (e) {
    return 0;
  }
}

function touchLocalDirty(ts) {
  try {
    wx.setStorageSync(LOCAL_DIRTY_TS_KEY, Number(ts) || Date.now());
  } catch (e) {
    /* ignore */
  }
}

module.exports = {
  getCodes: getCodes,
  setCodes: setCodes,
  setCodesSilent: setCodesSilent,
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
  nowText: nowText,
  getHoldings: getHoldings,
  setHoldings: setHoldings,
  setHoldingsSilent: setHoldingsSilent,
  setHolding: setHolding,
  removeHolding: removeHolding,
  fmtMoney: fmtMoney,
  fmtDateTime: fmtDateTime,
  getBackupTs: getBackupTs,
  setBackupTs: setBackupTs,
  getLocalDirtyTs: getLocalDirtyTs,
  touchLocalDirty: touchLocalDirty
};
