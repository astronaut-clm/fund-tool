const config = require('./config.js');

const CODES_KEY = 'FUND_CODES';
const HISTORY_KEY = 'FUND_SEARCH_HISTORY';
const HOLDINGS_KEY = 'FUND_HOLDINGS';
const BACKUP_TS_KEY = 'FUND_BACKUP_TS';
const DIRTY_TS_KEY = 'FUND_LOCAL_DIRTY_TS';

/* ---------- storage 基础 ---------- */
function readList(key) {
  try {
    const v = wx.getStorageSync(key);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function readTs(key) {
  try {
    return Number(wx.getStorageSync(key)) || 0;
  } catch (e) {
    return 0;
  }
}

function writeTs(key, ts) {
  try {
    wx.setStorageSync(key, Number(ts) || Date.now());
  } catch (e) {}
}

/* ---------- 自选 ---------- */
function getCodes() {
  return readList(CODES_KEY);
}

/** 去重规范化自选数组；非数组返回 null */
function normalizeCodes(codes) {
  if (!Array.isArray(codes)) return null;
  const seen = {};
  const list = [];
  codes.forEach(function (c) {
    const k = String(c);
    if (!seen[k]) {
      seen[k] = true;
      list.push(k);
    }
  });
  return list;
}

function writeCodes(codes, silent) {
  const list = normalizeCodes(codes);
  if (list === null) return [];
  try {
    wx.setStorageSync(CODES_KEY, list);
    if (!silent) touchLocalDirty();
    return list;
  } catch (e) {
    return [];
  }
}

function setCodes(codes) {
  return writeCodes(codes, false);
}

/** 静默写入（不触发脏标记），用于云端恢复 */
function setCodesSilent(codes) {
  return writeCodes(codes, true);
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
  return setCodes(getCodes().filter(function (c) { return c !== code; }));
}

/* ---------- 搜索历史 ---------- */
function getHistory() {
  return readList(HISTORY_KEY);
}

/** 新纪录置顶去重，最多 maxHistory 条 */
function addHistory(code, name) {
  try {
    const list = getHistory().filter(function (it) { return it.code !== code; });
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
  } catch (e) {}
}

/* ---------- 格式化 ---------- */
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

function fmtDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[2] + '-' + m[3] : '';
}

function clsOf(n) {
  const v = Number(n);
  if (n === null || n === undefined || isNaN(v) || Math.abs(v) < 0.005) return 'flat';
  return v > 0 ? 'up' : 'down';
}

function pad2(n) {
  const v = Number(n);
  return (v < 10 ? '0' : '') + v;
}

function todayStr(d) {
  const now = d || new Date();
  return '' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate());
}

/** 行情日期（YYYY-MM-DD / YYYYMMDD）→ MM-DD */
function fmtDataDate(s) {
  const t = String(s || '').replace(/\D/g, '');
  return t.length >= 8 ? t.slice(4, 6) + '-' + t.slice(6, 8) : '';
}

/** A股交易时段 9:30-11:30 / 13:00-15:00 */
function isTrading(d) {
  const now = d || new Date();
  if (now.getDay() === 0 || now.getDay() === 6) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60);
}

/** 9:30 开盘前：当日行情尚未开始 */
function beforeOpen(d) {
  const now = d || new Date();
  return now.getHours() * 60 + now.getMinutes() < 9 * 60 + 30;
}

/** 千分位 + 2 位小数 */
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '--';
  const neg = v < 0;
  const parts = Math.abs(v).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + parts.join('.');
}

/* ---------- 持仓 ---------- */
function getHoldings() {
  return readList(HOLDINGS_KEY);
}

/** 按 code 去重规范化持仓数组；非数组返回 null */
function normalizeHoldings(list) {
  if (!Array.isArray(list)) return null;
  const seen = {};
  const arr = [];
  list.forEach(function (it) {
    const k = it && String(it.code);
    if (!k || seen[k]) return;
    seen[k] = true;
    arr.push(it);
  });
  return arr;
}

function writeHoldings(list, silent) {
  const arr = normalizeHoldings(list);
  if (arr === null) return [];
  try {
    wx.setStorageSync(HOLDINGS_KEY, arr);
    if (!silent) touchLocalDirty();
    return arr;
  } catch (e) {
    return [];
  }
}

function setHoldings(list) {
  return writeHoldings(list, false);
}

/** 静默写入（不触发脏标记），用于云端恢复 */
function setHoldingsSilent(list) {
  return writeHoldings(list, true);
}

function removeHolding(code) {
  return setHoldings(getHoldings().filter(function (h) { return h.code !== String(code); }));
}

/* ---------- 同步时间戳 ---------- */
function getBackupTs() {
  return readTs(BACKUP_TS_KEY);
}

function setBackupTs(ts) {
  writeTs(BACKUP_TS_KEY, ts);
}

/** 本地数据最后修改时间 */
function getLocalDirtyTs() {
  return readTs(DIRTY_TS_KEY);
}

function touchLocalDirty(ts) {
  writeTs(DIRTY_TS_KEY, ts);
}

module.exports = {
  getCodes,
  setCodes,
  setCodesSilent,
  addCode,
  removeCode,
  getHistory,
  addHistory,
  clearHistory,
  fmtPct,
  fmtNav,
  fmtDate,
  clsOf,
  todayStr,
  fmtDataDate,
  isTrading,
  beforeOpen,
  fmtMoney,
  getHoldings,
  setHoldings,
  setHoldingsSilent,
  removeHolding,
  getBackupTs,
  setBackupTs,
  getLocalDirtyTs,
  touchLocalDirty
};
